'use strict';
/**
 * 不连画面的命令和电脑状态（协议文档 2.9）：控制端停在会话列表、没看任何窗口时，
 * 也能重排窗口、把会话提到最前、暂停或恢复平铺、锁定和解锁电脑，并且知道电脑是不是锁着。
 * 这些消息走信令通道（服务器转发），不依赖画面连接里的数据通道。
 *
 * 被控端页面用 <script> 直接加载（挂到 window.RcHostCmd），测试里用 require。
 */
(function (root) {
  /** 平铺操作，和数据通道上的 tile 消息（协议文档 4.7）是同一套 */
  const TILE_OPS = { arrange: '重排窗口', raise: '把所有会话提到最前', pause: '暂停自动平铺', resume: '恢复自动平铺' };

  /**
   * 推给控制端的电脑状态。key 是解锁密码用的公钥，还没生成好时不带。
   * lock.untrusted 只在是 true 时带：电脑上有解锁服务，但被控端核实不过（多半是旧版，要重新安装）
   */
  function stateMessage(to, lock, tile, key) {
    const msg = {
      type: 'host-state',
      to,
      lock: { locked: !!(lock && lock.locked), unlock: !!(lock && lock.unlock) },
      tile: { available: !!(tile && tile.available), paused: !!(tile && tile.paused) },
    };
    if (lock && lock.untrusted && !lock.unlock) msg.lock.untrusted = true;
    if (key) msg.key = key;
    return msg;
  }

  /**
   * 执行控制端发来的一条 host-cmd。
   * @param {object} msg 服务器转发来的消息（带 from）
   * @param {{ tile: Function, lockNow: Function, unlockEnc: Function }} bridge 主进程的接口
   * @param {(text: string) => void} log
   * @returns {Promise<object|null>} 要回给控制端的 host-cmd-result；命令没带 req 时不回，返回 null
   */
  async function run(msg, bridge, log) {
    const op = typeof msg.op === 'string' ? msg.op.slice(0, 20) : '';
    const req = typeof msg.req === 'string' ? msg.req.slice(0, 40) : '';
    const result = (ok, code) => {
      if (!req) return null;
      const r = { type: 'host-cmd-result', to: msg.from, req, op, ok: !!ok };
      if (!ok) r.code = code || 'failed';
      return r;
    };
    if (Object.prototype.hasOwnProperty.call(TILE_OPS, op)) {
      log(`控制端 ${msg.from} 要求${TILE_OPS[op]}`);
      // 平铺没在运行时主进程回 false
      return result(await bridge.tile(op), 'unavailable');
    }
    if (op === 'lock') {
      log(`控制端 ${msg.from} 锁定了电脑`);
      return result(await bridge.lockNow(), 'failed');
    }
    if (op === 'unlock') {
      log(`控制端 ${msg.from} 请求解锁`);
      // 密文原样交给主进程，这里看不到密码
      const code = await bridge.unlockEnc(typeof msg.enc === 'string' ? msg.enc : '');
      log(code ? `解锁没有成功: ${code}` : '已从控制端解锁');
      return result(!code, code);
    }
    return result(false, 'bad-op');
  }

  const api = { TILE_OPS, stateMessage, run };
  root.RcHostCmd = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
