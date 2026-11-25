'use strict';
/**
 * 手机是不是正在控制这台电脑（docs/11 第 4.2 节）。虚拟屏、防息屏跟着它开关。
 *
 * 安卓 App 开着"后台接收审批"时一直连着服务器，服务器还会为推送报一个编号为 push 的控制端，
 * 所以"连着"不等于"在控制"，按操作算：
 *   - 开始：真的控制端（不是 push）发来看画面、列会话、打开或新建会话、操作电脑的命令；
 *   - 结束：它说结束控制（release，换了电脑、退出登录）；它断开了、GONE_MS 里也没有别的控制端来操作
 *     （鸿蒙 App 一退到后台就断开，回来时重新连上、编号也换了：不等一会儿的话，开着隐私屏时切出去回个消息电脑就锁了）；
 *     或者 IDLE_MS 里既没人看画面、也没有新的操作。
 *
 * 不依赖 Electron，时钟和定时器由调用方传入，测试里换成假的。
 */

/** 没人看画面时，最后一次操作之后这么久算控制结束 */
const IDLE_MS = 3 * 60 * 1000;
/** 控制端断开以后最多再算这么久（没过 IDLE_MS 的话），这期间重新连上、又有操作就接着算 */
const GONE_MS = 60 * 1000;
/** 服务器替推送报的那个控制端（协议文档 2.10），不是真的手机 */
const PUSH_VIEWER = 'push';

/**
 * @param {object} opts
 * @param {(active: boolean) => void} opts.onChange 开始、结束控制时调用
 * @param {number} [opts.idleMs]
 * @param {() => number} [opts.now]
 * @param {(fn: () => void, ms: number) => any} [opts.setTimer]
 * @param {(t: any) => void} [opts.clearTimer]
 */
function createControlSession({ onChange, idleMs = IDLE_MS, goneMs = GONE_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** 控制端编号 -> 它最后一次操作的时间 */
  const lastActivity = new Map();
  let watching = 0;
  let active = false;
  let timer = null;

  function update() {
    const t = now();
    for (const [id, at] of lastActivity) {
      if (t - at >= idleMs) lastActivity.delete(id);
    }
    const next = watching > 0 || lastActivity.size > 0;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    // 没人看画面时，等最早的那个控制端闲够了再看一次
    if (watching === 0 && lastActivity.size > 0) {
      const earliest = Math.min(...lastActivity.values());
      timer = setTimer(update, Math.max(0, earliest + idleMs - t));
    }
    if (next !== active) {
      active = next;
      onChange(active);
    }
  }

  return {
    /** 控制端发来一次操作（看画面、列会话、打开会话、host-cmd……） */
    activity(viewerId) {
      if (!viewerId || viewerId === PUSH_VIEWER) return;
      lastActivity.set(viewerId, now());
      update();
    },
    /** 控制端说结束控制（换了电脑、退出登录）：马上不算它了 */
    release(viewerId) {
      if (!lastActivity.delete(viewerId)) return;
      update();
    },
    /** 控制端断开了（自己走的、被控端和服务器断了）：再算 goneMs，比它本来闲够的时间早才改 */
    gone(viewerId) {
      const at = lastActivity.get(viewerId);
      if (at === undefined) return;
      lastActivity.set(viewerId, Math.min(at, now() - idleMs + goneMs));
      update();
    },
    /** 正在看画面的控制端数（有人看着就一直算在控制） */
    setWatching(count) {
      watching = Math.max(0, Number(count) || 0);
      update();
    },
    isActive() {
      return active;
    },
  };
}

module.exports = { createControlSession, IDLE_MS, GONE_MS, PUSH_VIEWER };
