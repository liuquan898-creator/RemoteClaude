'use strict';
/**
 * 接收控制端发来的文件（协议文档 4.8）：边收边写进存放目录下 .partial 里的临时文件，
 * 收齐后核对字节数和 SHA-256，再换成不和已有文件重名的正式文件名。
 *
 * 纯 Node，不依赖 Electron，方便测试。主进程按控制端（key）各管一个正在收的文件。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

/** 单个文件的上限。文件经中继服务器转发，进出都算流量，用户定的 50 MB（2026-11-19） */
const FILE_MAX = 50 * 1024 * 1024;
/** 收下这个文件以后磁盘上至少还要剩这么多 */
const MIN_FREE = 64 * 1024 * 1024;
const PARTIAL_DIR = '.partial';
/** 文件名最多保留这么多个字符（按码点算），扩展名不截 */
const NAME_MAX = 120;
const EXT_MAX = 20;
/** Windows 的保留设备名，带不带扩展名都不能用作文件名 */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * 把控制端给的文件名整理成 Windows 上能用、又不会跑出存放目录的名字：
 * 只取最后一段，去掉控制字符，`<>:"|?*` 换成下划线，去掉结尾的点和空格，避开保留设备名，过长时截短。
 */
function safeName(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.split(/[\\/]/).pop();
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[<>:"|?*]/g, '_');
  s = s.trim().replace(/[. ]+$/, '');
  if (!s) s = 'file';
  if (RESERVED.test(s)) s = '_' + s;
  const chars = Array.from(s);
  if (chars.length > NAME_MAX) {
    const ext = path.extname(s);
    const extChars = Array.from(ext);
    if (ext && extChars.length <= EXT_MAX) {
      const stem = Array.from(s.slice(0, s.length - ext.length))
        .slice(0, NAME_MAX - extChars.length)
        .join('')
        .replace(/[. ]+$/, '');
      s = (stem || 'file') + ext;
    } else {
      s = chars.slice(0, NAME_MAX).join('').replace(/[. ]+$/, '') || 'file';
    }
  }
  return s;
}

/** 同名时的第 n 个备选名：`报告.pdf` → `报告 (1).pdf`，和 Windows 资源管理器的习惯一样 */
function variantName(name, n) {
  if (!n) return name;
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  return `${stem} (${n})${ext}`;
}

/**
 * 在 [dir] 里占下一个还没人用的名字（先建一个空文件占位），返回完整路径。
 * 用"不存在才创建"的方式打开，两个文件同时收完也不会抢到同一个名字；Windows 上不分大小写，由文件系统判断。
 */
async function reserveUnique(dir, name) {
  for (let n = 0; n < 10000; n++) {
    const p = path.join(dir, variantName(name, n));
    try {
      const fh = await fsp.open(p, 'wx');
      await fh.close();
      return p;
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'EISDIR') continue;
      throw err;
    }
  }
  throw new Error('同名文件太多');
}

/** 磁盘剩余空间（字节），查不到时返回 null */
function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function codeOf(err) {
  return err && err.code === 'ENOSPC' ? 'disk-full' : 'file-failed';
}

/** 粘贴进输入框的文字：路径里有空白时加引号，末尾留一个空格，接着打字不会和路径连在一起 */
function pasteTextFor(filePath) {
  return (/\s/.test(filePath) ? `"${filePath}"` : filePath) + ' ';
}

class FileReceiver {
  /**
   * @param {{ dir: string, maxBytes?: number, minFree?: number, freeBytes?: (dir: string) => number | null }} opts
   */
  constructor(opts) {
    this.dir = path.resolve(opts.dir);
    this.partialDir = path.join(this.dir, PARTIAL_DIR);
    this.maxBytes = opts.maxBytes || FILE_MAX;
    this.minFree = opts.minFree == null ? MIN_FREE : opts.minFree;
    this.freeBytes = opts.freeBytes || freeBytes;
    /** key（控制端编号）-> 正在收的文件 */
    this.transfers = new Map();
    /** 丢掉的文件还在关闭、删除临时文件 */
    this.cleaning = new Set();
  }

  /**
   * 开始接收一个文件。这个控制端还有没收完的，先丢掉。成功返回 null，否则返回错误码。
   * 同步返回：主进程收到后面的数据块时，这个文件的状态已经建好了。
   */
  begin(key, id, name, size) {
    this.abort(key);
    if (typeof id !== 'string' || !id) return 'file-bad';
    if (!Number.isSafeInteger(size) || size < 0) return 'file-bad';
    if (size > this.maxBytes) return 'file-too-large';
    try {
      fs.mkdirSync(this.partialDir, { recursive: true });
    } catch {
      return 'file-failed';
    }
    const free = this.freeBytes(this.dir);
    if (free != null && free < size + this.minFree) return 'disk-full';
    const t = {
      id,
      name: safeName(name),
      size,
      received: 0,
      hash: crypto.createHash('sha256'),
      partPath: path.join(this.partialDir, `${Date.now()}-${id.replace(/[^A-Za-z0-9]/g, '')}.part`),
      fh: null,
      error: null,
      queue: null,
    };
    t.queue = fsp.open(t.partPath, 'wx').then(
      (fh) => {
        t.fh = fh;
      },
      (err) => {
        t.error = codeOf(err);
      }
    );
    this.transfers.set(key, t);
    return null;
  }

  /** 收到一段数据，按到达顺序排队写盘。超出声明的大小就记为 file-bad，不再写 */
  write(key, id, bytes) {
    const t = this.transfers.get(key);
    if (!t || t.id !== id || t.error) return;
    t.received += bytes.byteLength;
    if (t.received > t.size) {
      t.error = 'file-bad';
      return;
    }
    t.hash.update(bytes);
    t.queue = t.queue.then(async () => {
      if (t.error || !t.fh) return;
      try {
        let off = 0;
        while (off < bytes.byteLength) {
          const { bytesWritten } = await t.fh.write(bytes, off, bytes.byteLength - off);
          off += bytesWritten;
        }
      } catch (err) {
        t.error = codeOf(err);
      }
    });
  }

  /**
   * 收完了：等写盘结束，核对字节数和 SHA-256（[sha256] 为空时只核对字节数），换成正式文件名。
   * 返回 `{ path, name }`，失败返回 `{ code }`。
   */
  async end(key, id, sha256) {
    const t = this.transfers.get(key);
    if (!t || t.id !== id) return { code: 'file-bad' };
    this.transfers.delete(key);
    await t.queue;
    await this._close(t);
    let code = t.error;
    if (!code && t.received !== t.size) code = 'file-bad';
    if (!code && sha256 && t.hash.digest('hex') !== String(sha256).toLowerCase()) code = 'file-bad';
    if (code) {
      await fsp.rm(t.partPath, { force: true }).catch(() => {});
      return { code };
    }
    let finalPath = null;
    try {
      finalPath = await reserveUnique(this.dir, t.name);
      await renameWithRetry(t.partPath, finalPath);
      return { path: finalPath, name: path.basename(finalPath) };
    } catch (err) {
      await fsp.rm(t.partPath, { force: true }).catch(() => {});
      if (finalPath) await fsp.rm(finalPath, { force: true }).catch(() => {});
      return { code: codeOf(err) };
    }
  }

  /** 丢掉这个控制端正在收的文件（取消、超时、连接断开），删掉临时文件 */
  abort(key) {
    const t = this.transfers.get(key);
    if (!t) return;
    this.transfers.delete(key);
    t.error = t.error || 'aborted';
    const done = t.queue
      .then(() => this._close(t))
      .then(() => fsp.rm(t.partPath, { force: true }))
      .catch(() => {})
      .then(() => this.cleaning.delete(done));
    this.cleaning.add(done);
  }

  /** 等所有正在进行的写盘和清理结束（测试用） */
  async idle() {
    await Promise.all([...[...this.transfers.values()].map((t) => t.queue), ...this.cleaning]);
  }

  /** 删掉 .partial 里放了超过 [maxAgeMs] 的临时文件（上次没收完就退出了留下的） */
  cleanupStale(maxAgeMs = 60 * 60 * 1000) {
    let names;
    try {
      names = fs.readdirSync(this.partialDir);
    } catch {
      return 0;
    }
    let removed = 0;
    const now = Date.now();
    for (const n of names) {
      if (!n.endsWith('.part')) continue;
      const p = path.join(this.partialDir, n);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
          fs.rmSync(p, { force: true });
          removed++;
        }
      } catch {
        /* 别的程序占着就下次再删 */
      }
    }
    return removed;
  }

  async _close(t) {
    const fh = t.fh;
    t.fh = null;
    if (fh) await fh.close().catch(() => {});
  }
}

/** 杀毒软件刚扫完新文件时可能还占着它，改名偶尔会失败，稍等再试几次 */
async function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (i >= 4 || (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES')) throw err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}

module.exports = { FileReceiver, safeName, variantName, reserveUnique, pasteTextFor, FILE_MAX, MIN_FREE, PARTIAL_DIR };
