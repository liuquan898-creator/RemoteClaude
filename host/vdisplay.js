'use strict';
/**
 * 虚拟屏（docs/11 第 4.3 节）：手机在控制这台电脑、电脑上又没有亮着的真显示器时，让解锁服务启用虚拟屏；
 * 控制结束、或者插上了真显示器时停用。开着期间每 PING_MS 向服务报一次平安，
 * 服务 15 秒收不到就自己停用，被控端崩了、被结束了也不会让虚拟屏一直开着。
 *
 * 显示器只是关了电源但还连着（HDMI 常见）时，系统认为屏还在，不开虚拟屏（只防息屏，main.js 管）。
 * 管道和显示器列表由调用方传入，测试里换成假的。
 */

const PING_MS = 2000;
const REQUEST_TIMEOUT_MS = 5000;
/** 虚拟屏驱动的显示器设备 ID 里有这一段（VirtualDrivers/Virtual-Display-Driver 的 EDID：厂商 MTT、产品 1337） */
const VIRTUAL_MONITOR = /\\MTT1337\\/i;

function isVirtualMonitor(monitorId) {
  return VIRTUAL_MONITOR.test(monitorId || '');
}

/** 有没有亮着的真显示器：接在桌面上的输出里，有一个不是我们的虚拟屏就算 */
function hasPhysicalDisplay(displays) {
  return displays.some((d) => !isVirtualMonitor(d.monitor));
}

/**
 * @param {object} opts
 * @param {(line: string, timeoutMs: number) => Promise<{ line?: string, error?: string } | null>} opts.ask 问解锁服务（unlockpipe.request）
 * @param {() => { monitor: string }[]} opts.displays 接在桌面上的显示输出（win32.activeDisplays）
 * @param {(text: string) => void} opts.log
 * @param {() => void} [opts.onReady] 开了以后虚拟屏第一次出现在桌面上时调用（改分辨率、摆窗口）。
 *   服务回 OK 时它还没出来（实测要 2 秒多），要等显示器变化
 */
function createVirtualDisplay({ ask, displays, log, onReady = () => {}, setTimer = setInterval, clearTimer = clearInterval, pingMs = PING_MS }) {
  let want = false; // 手机在控制这台电脑
  let on = false; // 我们要服务开着、服务也答应了的
  let ready = false; // 这次开了以后，虚拟屏已经出现过、onReady 调过了
  let state = 'off'; // 'off' | 'on' | 'none'（没装驱动）| 'error'
  let pingTimer = null;
  let pinging = false;
  let lastNote = '';
  let queue = Promise.resolve();

  /** 同一句话只在变了时记一次：没装驱动时每次控制开始都会再试 */
  function note(text) {
    if (text === lastNote) return;
    lastNote = text;
    log(text);
  }

  async function request(line) {
    const r = (await ask(line, REQUEST_TIMEOUT_MS)) || {};
    if (typeof r.line === 'string') return r.line;
    return 'ERR ' + (r.error || 'no-service');
  }

  /** 报一次平安。上一次还没回来就不再发；回应说虚拟屏没开着（看门狗关了它）就重新看一遍 */
  async function ping() {
    if (pinging) return;
    pinging = true;
    try {
      // 只续虚拟屏的租约：和隐私屏的分开记，一边关不掉时另一边的 PING 不会替它续着
      const reply = await request('PING display');
      if (!reply.startsWith('OK')) note(`向解锁服务报平安没成功：${reply}`);
      else if (on && !/\bdisplay=1\b/.test(reply)) schedule();
    } finally {
      pinging = false;
    }
  }

  function updatePing() {
    if (on && !pingTimer) {
      pingTimer = setTimer(() => {
        ping().catch(() => {});
      }, pingMs);
    } else if (!on && pingTimer) {
      clearTimer(pingTimer);
      pingTimer = null;
    }
  }

  function showing(list) {
    return list.some((d) => isVirtualMonitor(d.monitor));
  }

  async function reconcile() {
    const list = displays();
    const target = want && !hasPhysicalDisplay(list);
    if (target && on && showing(list)) {
      if (!ready) {
        ready = true;
        onReady();
      }
      return;
    }
    if (!target && !on) return;
    // 要开、以为开着、却看不到它（服务的看门狗关了它，比如被控端卡了 15 秒以上）：再要一次，服务那边开着的话什么都不动；
    // 重新出现时再改一次分辨率、摆一次窗口
    if (target && on) ready = false;
    const reply = await request(target ? 'DISPLAY ON' : 'DISPLAY OFF');
    if (!target) {
      // 关没关成都不再报平安：关失败了就让服务的看门狗 15 秒后去关，不能靠 PING 替它续着
      on = false;
      ready = false;
      updatePing();
    }
    if (reply === 'OK') {
      if (target && !on) note('电脑上没有亮着的显示器，已开虚拟屏');
      if (!target) note(want ? '接上了真显示器，已关虚拟屏' : '控制结束，已关虚拟屏');
      on = target;
      state = on ? 'on' : 'off';
      updatePing();
      if (on && !ready && showing(displays())) {
        ready = true;
        onReady();
      }
      return;
    }
    if (reply === 'ERR no-display') {
      state = 'none';
      note('电脑上没有亮着的显示器，但没装虚拟屏驱动（在被控端窗口里重新安装解锁服务会一起装上），画面可能出不来');
      return;
    }
    state = 'error';
    note(`${target ? '开' : '关'}虚拟屏没成功：${reply}`);
  }

  /** 一次只跑一个：开关要和服务说话，前一个没完时后来的排队 */
  function schedule() {
    queue = queue.then(reconcile).catch((err) => note(`虚拟屏出错：${err.message}`));
    return queue;
  }

  return {
    /** 控制开始、结束（controlsession.js） */
    setActive(active) {
      want = !!active;
      return schedule();
    },
    /** 显示器插拔、开关以后调用 */
    displaysChanged() {
      return schedule();
    },
    /** 'off' | 'on' | 'none'（没装驱动）| 'error' */
    state() {
      return state;
    },
  };
}

/**
 * 虚拟屏开出来以后，把它切到驱动支持的最大一档分辨率（设置里只有 1920x1080）。
 * Windows 记着这块屏上次用的分辨率，可能不是驱动现在支持的（实测拿到过 800x600，docs/11 第 3.2 节）。
 * 改了就记进系统设置，下次开出来直接是对的。返回改了几块
 * @param {{ displays: () => {adapter: string, monitor: string}[], modes: (adapter: string) => ({current: object, best: object}|null),
 *   setMode: (adapter: string, mode: object) => number, log: (text: string) => void }} io
 */
function fitVirtualMode({ displays, modes, setMode, log }) {
  let changed = 0;
  for (const d of displays()) {
    if (!isVirtualMonitor(d.monitor)) continue;
    const m = modes(d.adapter);
    if (!m) continue;
    const { current, best } = m;
    if (current.width === best.width && current.height === best.height && current.frequency === best.frequency) continue;
    const code = setMode(d.adapter, best);
    const from = `${current.width}x${current.height}`;
    const to = `${best.width}x${best.height}@${best.frequency}`;
    if (code === 0) changed++;
    log(code === 0 ? `虚拟屏的分辨率从 ${from} 改成了 ${to}` : `虚拟屏的分辨率改不成 ${to}（还是 ${from}，错误 ${code}）`);
  }
  return changed;
}

module.exports = { createVirtualDisplay, fitVirtualMode, hasPhysicalDisplay, isVirtualMonitor, PING_MS };
