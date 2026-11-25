'use strict';
/**
 * 被控端窗口里的"安装解锁服务"（docs/06 的"安装与卸载"）。
 *
 * 解锁服务的源码和安装脚本跟着被控端安装包走（electron-builder 的 extraResources，在 resources\unlock-service 里，
 * 开发时就是 host\unlock-service），不用再手动拷文件、开命令行。点按钮后：
 *   1. 算出自带的 UnlockService.cs 的 SHA256，在隐藏的窗口里运行 install.ps1 -FromHost -ExpectSha256 <哈希>；
 *   2. 脚本在新窗口里以管理员身份重新打开自己（弹管理员确认），把源码复制进 Program Files、核对哈希、编译、装服务，
 *      等它结束，用它的退出码退出：0 装好了，1 失败（窗口留着给人看原因），2 没能以管理员身份打开；
 *   3. 退出码是 0 时，再从管道问几次 STATUS，核实新服务真的起来了、通过了 unlockpipe.js 的核实，才算装好。
 *
 * 还会看已经装上的是不是旧版：读 Program Files\RemoteClaude\UnlockService.cs（安装脚本放的，普通用户能读）
 * 和自带的源码里的版本号（一行 "// UNLOCK_SERVICE_VERSION <数字>"），自带的大才算"有新版本"。
 * 只看内容是否一样不行：电脑上装的可能比被控端带的还新（比如从别的分支装的），那时不能提示"更新"把它换旧。
 * 加版本号之前装的没有这一行：除了这一行以外和自带的一样（不管行尾）就算装的是新版，不一样算版本 0。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { expectedServiceExe } = require('./unlockpipe');

const SOURCE_NAME = 'UnlockService.cs';
const SCRIPT_NAME = 'install.ps1';
/** 安装脚本的退出码 */
const EXIT_OK = 0;
const EXIT_NOT_ELEVATED = 2;
/** 装好以后服务要过一会儿才建好管道：每隔这么久问一次，最多问这么多次 */
const VERIFY_INTERVAL_MS = 1000;
const VERIFY_ATTEMPTS = 10;

/** 只比内容：去掉开头的 BOM，行尾统一成 \n（git 检出时可能换成 CRLF） */
function normalizeSource(buf) {
  return buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

// 版本号那一行，数字后面可以跟说明。整行只有这一行，去掉它就和加版本号之前的源码一样
const VERSION_LINE = /^[ \t]*\/\/[ \t]*UNLOCK_SERVICE_VERSION[ \t]+(\d+)\b[^\n]*\n/m;

/** 源码里的版本号（normalizeSource 之后的文字），没有这一行是 0 */
function sourceVersion(text) {
  const m = VERSION_LINE.exec(text);
  return m ? Number(m[1]) : 0;
}

/** 去掉版本号那一行以后的内容 */
function withoutVersion(text) {
  return text.replace(VERSION_LINE, '');
}

function readOrNull(readFile, file) {
  return readFile(file).catch((err) => {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  });
}

/** Windows PowerShell 5.1（安装脚本只在它里面干活，不在的话它会自己换） */
function defaultPowerShell(env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** 在隐藏的窗口里运行，返回退出码；启动不了时报错 */
function defaultRun(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

/**
 * @param {object} opts
 * @param {string} opts.dir  自带的 install.ps1 和 UnlockService.cs 所在的目录
 * @param {(line: string, timeoutMs: number) => Promise<{line?: string, error?: string}>} opts.ask  给解锁服务发命令（unlockpipe.js）
 * @param {string} [opts.installedDir]  安装脚本把服务装到哪（默认 %ProgramW6432%\RemoteClaude，和 unlockpipe.js 核实的一致）
 * @param {string} [opts.powershell]
 * @param {(file: string, args: string[]) => Promise<number|null>} [opts.run]
 * @param {(file: string) => Promise<Buffer>} [opts.readFile]
 * @param {(msg: string) => void} [opts.log]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 */
function createUnlockInstaller(opts) {
  const dir = opts.dir;
  const ask = opts.ask;
  const installedDir = opts.installedDir !== undefined ? opts.installedDir : path.win32.dirname(expectedServiceExe());
  const powershell = opts.powershell || defaultPowerShell();
  const run = opts.run || defaultRun;
  const readFile = opts.readFile || ((file) => fs.promises.readFile(file));
  const log = opts.log || (() => {});
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const bundledSource = path.join(dir, SOURCE_NAME);
  const script = path.join(dir, SCRIPT_NAME);
  let installing = false;

  /**
   * 已装的和自带的比：'no-bundle' 被控端里没有自带的源码，'missing' 没装过（或装的目录里没有源码），
   * 'outdated' 装的是旧版（自带的版本号大），'current' 装的不比自带的旧
   */
  async function sourceState() {
    const bundledBuf = await readOrNull(readFile, bundledSource);
    if (!bundledBuf) return 'no-bundle';
    const installedBuf = installedDir ? await readOrNull(readFile, path.win32.join(installedDir, SOURCE_NAME)) : null;
    if (!installedBuf) return 'missing';
    const bundled = normalizeSource(bundledBuf);
    const installed = normalizeSource(installedBuf);
    if (withoutVersion(installed) === withoutVersion(bundled)) return 'current';
    return sourceVersion(bundled) > sourceVersion(installed) ? 'outdated' : 'current';
  }

  /** 给页面看的：{ source, installing } */
  async function state() {
    let source;
    try {
      source = await sourceState();
    } catch (err) {
      log(`读不了解锁服务的源码，没法比对版本：${err.message}`);
      source = 'unknown';
    }
    return { source, installing };
  }

  /** 装好以后问几次 STATUS：'ok' 核实通过并回了 OK，'untrusted' 管道那头核实不过，'no-response' 一直没回应 */
  async function verifyInstalled() {
    for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
      if (i > 0) await sleep(VERIFY_INTERVAL_MS);
      const r = await ask('STATUS', 1500);
      if (r.line !== undefined && r.line.startsWith('OK')) return 'ok';
      if (r.error === 'untrusted') return 'untrusted';
    }
    return 'no-response';
  }

  /**
   * 安装或重新安装。返回 { result, exitCode? }，result：
   *   'ok' 装好了并核实通过；'canceled' 没能以管理员身份运行（多半是确认框点了"否"）；
   *   'failed' 安装脚本报错或启动不了（exitCode 是脚本的退出码）；'untrusted' / 'no-response' 脚本说装好了，
   *   但管道那头核实不过 / 一直没回应；'busy' 已经在装了；'no-bundle' 被控端里缺自带的文件
   */
  async function install() {
    if (installing) return { result: 'busy' };
    installing = true;
    try {
      const bundled = await readOrNull(readFile, bundledSource);
      if (!bundled) {
        log(`被控端里没有解锁服务的源码：${bundledSource}`);
        return { result: 'no-bundle' };
      }
      const hash = crypto.createHash('sha256').update(bundled).digest('hex').toUpperCase();
      log(`开始安装解锁服务，源码 SHA256 ${hash}，等管理员确认`);
      let exitCode;
      try {
        exitCode = await run(powershell, [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-FromHost',
          '-ExpectSha256',
          hash,
        ]);
      } catch (err) {
        log(`启动不了安装脚本：${err.message}`);
        return { result: 'failed' };
      }
      if (exitCode === EXIT_NOT_ELEVATED) {
        log('没有安装解锁服务：没能以管理员身份运行安装脚本');
        return { result: 'canceled', exitCode };
      }
      if (exitCode !== EXIT_OK) {
        log(`安装脚本出错退出（退出码 ${exitCode}）`);
        return { result: 'failed', exitCode };
      }
      const verdict = await verifyInstalled();
      log(
        verdict === 'ok'
          ? '解锁服务装好了，核实通过'
          : verdict === 'untrusted'
            ? '安装脚本说装好了，但管道那头的服务核实不过'
            : '安装脚本说装好了，但解锁服务一直没有回应',
      );
      return { result: verdict, exitCode };
    } finally {
      installing = false;
    }
  }

  return { state, sourceState, install };
}

module.exports = { createUnlockInstaller, normalizeSource, sourceVersion, defaultPowerShell, EXIT_NOT_ELEVATED };
