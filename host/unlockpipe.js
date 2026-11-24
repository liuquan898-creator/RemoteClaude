'use strict';
/**
 * 跟解锁服务（docs/06）说话的客户端：连命名管道、发一行命令、收一行回应。
 *
 * 发任何东西之前先确认管道对面是真的解锁服务，防止普通进程抢注同名管道骗走密码：
 *   1. GetNamedPipeServerProcessId 拿到对面进程号，它的可执行文件必须正好是
 *      %ProgramFiles%\RemoteClaude\RemoteClaudeUnlock.exe（只有管理员能往那里放东西）；
 *   2. 管道对象的所有者必须是 SYSTEM（S-1-5-18）。服务建管道时明确设了，普通用户建不出这样的管道。
 *      光看路径不够：普通用户也能自己以 --console 方式跑那个程序。
 * 核实不过就不发 UNLOCK，也不发 STATUS；request() 报 error: 'untrusted'，被控端据此告诉控制端
 * "服务要重新安装"，和"没装"分开（旧版服务开不出查询权限，也会核实不过）。
 *
 * 真正调 Win32 的部分在 unlockpipe-native.js，这里只有逻辑，测试时换成假的。
 */
const path = require('path');

const PIPE_NAME = '\\\\.\\pipe\\RemoteClaudeUnlock';
const SYSTEM_SID = 'S-1-5-18';
const MAX_REPLY_BYTES = 512;
const ATTEMPTS = 3;
const RETRY_MS = 400;
const POLL_MS = 25;

/** 解锁服务程序应该在的位置。64 位 Windows 上 ProgramW6432 总是 64 位的 Program Files */
function expectedServiceExe(env = process.env) {
  const base = env.ProgramW6432 || env.ProgramFiles;
  return base ? path.win32.join(base, 'RemoteClaude', 'RemoteClaudeUnlock.exe') : '';
}

function normalizePath(p) {
  let s = String(p || '');
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  return path.win32.normalize(s).toLowerCase();
}

/**
 * 核实管道对面。info: { pid, image, owner }（image 是进程的完整路径，owner 是管道所有者的 SID 字符串）
 * 返回 { ok: true } 或 { ok: false, reason }
 */
function verifyServer(info, { expectedExe, requireSystemOwner = true } = {}) {
  if (!info || !info.pid) return { ok: false, reason: '拿不到管道对面的进程号' };
  if (!expectedExe) return { ok: false, reason: '不知道服务程序应该在哪（没有 ProgramFiles 环境变量）' };
  if (!info.image) return { ok: false, reason: `查不到进程 ${info.pid} 的路径（旧版服务或不是解锁服务）` };
  if (normalizePath(info.image) !== normalizePath(expectedExe)) {
    return { ok: false, reason: `管道对面是 ${info.image}，不是 ${expectedExe}` };
  }
  if (requireSystemOwner && info.owner !== SYSTEM_SID) {
    return { ok: false, reason: `管道所有者是 ${info.owner || '未知'}，不是 SYSTEM` };
  }
  return { ok: true };
}

/** 从收到的字节里取第一行；还没收全返回 null */
function firstLine(buf) {
  const i = buf.indexOf(0x0a);
  if (i < 0) return null;
  return buf.subarray(0, i).toString('utf8').replace(/\r$/, '').trim();
}

/**
 * @param {object} opts
 * @param {object} [opts.native]  见 unlockpipe-native.js；不给就加载真的
 * @param {string} [opts.pipeName]
 * @param {string} [opts.expectedExe]
 * @param {boolean} [opts.requireSystemOwner]
 * @param {(msg: string) => void} [opts.log]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 */
function createUnlockPipe(opts = {}) {
  const native = opts.native || require('./unlockpipe-native');
  const pipeName = opts.pipeName || PIPE_NAME;
  const expectedExe = opts.expectedExe !== undefined ? opts.expectedExe : expectedServiceExe();
  const requireSystemOwner = opts.requireSystemOwner !== false;
  const log = opts.log || (() => {});
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now || Date.now;
  let lastDistrust = null; // 同一个原因只记一次，免得每 30 秒的 STATUS 刷日志

  function noteTrust(verdict) {
    if (verdict.ok) {
      if (lastDistrust) log('解锁服务核实通过');
      lastDistrust = null;
      return;
    }
    if (verdict.reason !== lastDistrust) log(`管道对面不是可信的解锁服务（旧版服务也会这样，要重新安装），不发命令：${verdict.reason}`);
    lastDistrust = verdict.reason;
  }

  function inspect(handle) {
    const pid = native.serverPid(handle);
    return { pid, image: pid ? native.processImage(pid) : '', owner: native.pipeOwner(handle) };
  }

  /** 一次连接：{ line } 或 { error: 'not-found' | 'busy' | 'open-failed' | 'untrusted' | 'write-failed' | 'closed' | 'timeout' } */
  async function once(line, timeoutMs) {
    const opened = native.open(pipeName);
    if (opened.error) return { error: opened.error };
    const h = opened.handle;
    try {
      const verdict = verifyServer(inspect(h), { expectedExe, requireSystemOwner });
      noteTrust(verdict);
      if (!verdict.ok) return { error: 'untrusted' };

      const payload = Buffer.from(line + '\n', 'utf8');
      const wrote = native.write(h, payload);
      payload.fill(0); // 里面可能是密码，写完就清掉（JS 字符串清不了，这是能做到的部分）
      if (!wrote) return { error: 'write-failed' };

      const deadline = now() + timeoutMs;
      let buf = Buffer.alloc(0);
      for (;;) {
        const avail = native.available(h);
        if (avail < 0) {
          const rest = buf.toString('utf8').trim();
          return rest ? { line: rest } : { error: 'closed' };
        }
        if (avail > 0) {
          const chunk = native.read(h, Math.min(avail, MAX_REPLY_BYTES - buf.length));
          if (!chunk) return { error: 'closed' };
          buf = Buffer.concat([buf, chunk]);
          const got = firstLine(buf);
          if (got !== null) return { line: got };
          if (buf.length >= MAX_REPLY_BYTES) return { error: 'closed' };
          continue;
        }
        if (now() >= deadline) return { error: 'timeout' };
        await sleep(POLL_MS);
      }
    } finally {
      native.close(h);
    }
  }

  /**
   * 发一条命令，返回 { line } 或 { error }（error 同 once，最后一次尝试的那个）。
   * 打不开管道（服务没起来、实例都忙，或别的错误）时稍等重试：已经连上之后的失败不重试，
   * 不依赖错误码，取 GetLastError 万一不准也只是多试两次
   */
  async function request(line, timeoutMs) {
    let r = { error: 'not-found' };
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      r = await once(line, timeoutMs);
      if (r.line !== undefined) return r;
      if (r.error !== 'not-found' && r.error !== 'busy' && r.error !== 'open-failed') return r;
      if (attempt < ATTEMPTS - 1) await sleep(RETRY_MS);
    }
    return r;
  }

  /** 同 request，只要回应的那一行；没装服务、核实不过、连不上、超时都返回 null */
  async function ask(line, timeoutMs) {
    const r = await request(line, timeoutMs);
    return r.line !== undefined ? r.line : null;
  }

  return { ask, request, once };
}

module.exports = { createUnlockPipe, verifyServer, expectedServiceExe, firstLine, PIPE_NAME, SYSTEM_SID };
