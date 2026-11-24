'use strict';
/**
 * 锁屏状态和解锁请求（协议文档 4.6、2.9；解锁服务见 docs/06）。
 *
 * 除了普通的锁屏，还认"远程桌面断开了"：被控端所在的会话是断开状态的远程会话，没有画面，采集不了窗口。
 * 对控制端来说这和锁屏一样（locked: true），装了新版解锁服务时也显示可以解锁（unlock: true），
 * 控制端不用改：用户照常在手机上点"解锁电脑"、输入 Windows 密码，被控端改发 ATTACH，
 * 服务核对密码后把这个会话接回电脑的显示器（控制台），接回后还锁着就照常输入密码。
 *
 * Win32 和管道都由调用方注入，测试时换成假的。
 */

const WTS_DISCONNECTED = 4; // WTS_CONNECTSTATE_CLASS 里的 WTSDisconnected
const SERVICE_CHECK_MS = 30000;
const STATUS_TIMEOUT_MS = 1500;
const UNLOCK_TIMEOUT_MS = 40000;
// 接回：服务要核对密码（最多 15 秒）、接回并等会话到控制台（最多 5 + 10 秒）、等登录界面出现（5 秒），
// 接回后还锁着的话再输入密码（最多约 30 秒）。最坏约 65 秒，再留些余量；比服务先超时会把它当成没装
const ATTACH_TIMEOUT_MS = 75000;
const MAX_PASSWORD = 256;

/**
 * 会话信息（sessioninfo.js 的 current()）是否表示"远程桌面断开了、会话不在控制台"
 * @param {{ sessionId: number|null, consoleId: number|null, connectState: number|null } | null} info
 */
function isDetached(info) {
  return (
    !!info &&
    Number.isInteger(info.sessionId) &&
    info.connectState === WTS_DISCONNECTED &&
    info.sessionId !== info.consoleId
  );
}

/**
 * 解析服务对 STATUS 的回应。不是 OK 开头（包括 null）返回 null。
 * 旧版服务只回 `OK locked=0/1`；新版多一个 `attach=0/1`，表示发问的程序所在的会话可以接回控制台。
 * 认不出的字段忽略，以后再加字段旧被控端也不受影响
 * @param {string|null} reply
 * @returns {{ locked: boolean, attach: boolean } | null}
 */
function parseStatus(reply) {
  if (typeof reply !== 'string') return null;
  const parts = reply.trim().split(/\s+/);
  if (parts[0] !== 'OK') return null;
  // 不带原型：回应里的字段名（比如 __proto__）只是普通的键，Object.prototype 上的东西也不会被当成字段读出来
  const fields = Object.create(null);
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=');
    if (i > 0) fields[p.slice(0, i)] = p.slice(i + 1);
  }
  return { locked: fields.locked === '1', attach: fields.attach === '1' };
}

/** 服务对 UNLOCK、ATTACH 的回应 → 回给控制端的错误码（成功是 null），码同协议文档 4.6 */
function replyCode(reply) {
  if (reply === null || reply === undefined) return 'no-service';
  if (reply === 'OK') return null;
  return reply.startsWith('ERR ') ? reply.slice(4).trim() || 'failed' : 'failed';
}

/** 发给服务的解锁命令：断开的远程会话发 ATTACH（先接回控制台），否则照旧发 UNLOCK */
function unlockCommand(password, detached) {
  return (detached ? 'ATTACH ' : 'UNLOCK ') + Buffer.from(password, 'utf8').toString('base64');
}

/**
 * @param {object} opts
 * @param {() => boolean} opts.screenLocked       本会话的屏幕是否锁着（win32.isLocked）
 * @param {() => object} opts.sessionInfo         本会话的状况（sessioninfo.js 的 current）
 * @param {(line: string, timeoutMs: number) => Promise<{ line?: string, error?: string }>} opts.ask
 *   给解锁服务发一条命令（unlockpipe.js 的 request）：回应一行 { line }，或 { error }（'untrusted' 是管道那头核实不过）
 * @param {(state: { locked: boolean, unlock: boolean, untrusted: boolean, detached: boolean }) => void} [opts.onChange]
 * @param {(msg: string) => void} [opts.log]
 * @param {() => number} [opts.now]
 */
function createLockState(opts) {
  const { screenLocked, sessionInfo, ask } = opts;
  const onChange = opts.onChange || (() => {});
  const log = opts.log || (() => {});
  const now = opts.now || Date.now;
  // untrusted：管道那头有服务，但核实不过（多半是被控端自动升级了、解锁服务还是旧版），要在电脑上重新安装服务
  let state = { locked: false, unlock: false, untrusted: false, detached: false };
  let serviceCheckedAt = -Infinity;
  let polling = false;
  let unlocking = false;
  let sessionError = null;

  /** 本会话现在是不是断开的远程会话。查不到就当不是，退回原来只看锁屏的做法 */
  function detachedNow() {
    try {
      const d = isDetached(sessionInfo());
      sessionError = null;
      return d;
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (msg !== sessionError) log(`查不到本会话的远程桌面状态，按没断开处理: ${msg}`);
      sessionError = msg;
      return false;
    }
  }

  /** 此刻能不能操作窗口：屏幕锁着、或者远程桌面断开了都不能 */
  function lockedNow() {
    return detachedNow() || screenLocked();
  }

  /** 定时调用：看锁屏、远程桌面、解锁服务有没有变化，有就 onChange。上一次还没问完就跳过，免得旧结果盖掉新的 */
  async function poll() {
    if (polling) return state;
    polling = true;
    try {
      const detached = detachedNow();
      const locked = detached || screenLocked();
      let { unlock, untrusted } = state;
      if (locked !== state.locked || detached !== state.detached || now() - serviceCheckedAt > SERVICE_CHECK_MS) {
        serviceCheckedAt = now();
        const r = (await ask('STATUS', STATUS_TIMEOUT_MS)) || {};
        const status = parseStatus(r.line);
        // 断开时还要服务明确说这个会话能接回（旧版服务根本不理不在控制台的程序，回不了 OK）
        unlock = detached ? !!(status && status.attach) : !!status;
        untrusted = r.error === 'untrusted';
      }
      if (locked === state.locked && unlock === state.unlock && untrusted === state.untrusted && detached === state.detached) {
        return state;
      }
      if (detached !== state.detached) {
        log(detached ? '远程桌面已断开，没有画面' + (unlock ? '，可以从控制端接回电脑的显示器' : '') : '已回到电脑的显示器上');
      }
      state = { locked, unlock, untrusted, detached };
      onChange(state);
      return state;
    } finally {
      polling = false;
    }
  }

  /** 把控制端输入的 Windows 密码交给解锁服务。返回错误码，成功返回 null。密码不写日志、不保存 */
  async function unlock(password) {
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD) return 'failed';
    if (unlocking) return 'busy';
    const detached = detachedNow();
    if (!detached && !screenLocked()) return 'not-locked';
    unlocking = true;
    try {
      const r = (await ask(unlockCommand(password, detached), detached ? ATTACH_TIMEOUT_MS : UNLOCK_TIMEOUT_MS)) || {};
      if (r.line === undefined) return r.error === 'untrusted' ? 'bad-service' : 'no-service';
      return replyCode(r.line);
    } finally {
      unlocking = false;
    }
  }

  return { poll, unlock, lockedNow, current: () => state };
}

module.exports = {
  createLockState,
  isDetached,
  parseStatus,
  replyCode,
  unlockCommand,
  WTS_DISCONNECTED,
  SERVICE_CHECK_MS,
  ATTACH_TIMEOUT_MS,
  UNLOCK_TIMEOUT_MS,
};
