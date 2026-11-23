'use strict';

/**
 * 固定窗口计数器：每个键在 windowMs 内最多 limit 次。
 * 用于发验证码、登录失败、信令鉴权失败的限流。数据只在内存里，服务器重启后清零。
 */
class WindowCounter {
  constructor(limit, windowMs, now = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    /** @type {Map<string, {count:number, resetAt:number}>} */
    this.map = new Map();
  }

  entry(key) {
    const t = this.now();
    let e = this.map.get(key);
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + this.windowMs };
      this.map.set(key, e);
    }
    return e;
  }

  /** 已达上限时返回还要等的秒数，否则返回 0 */
  blockedFor(key) {
    const e = this.map.get(key);
    if (!e || e.resetAt <= this.now() || e.count < this.limit) return 0;
    return Math.max(1, Math.ceil((e.resetAt - this.now()) / 1000));
  }

  /** 记一次；超过上限返回还要等的秒数，否则返回 0 */
  hit(key) {
    const e = this.entry(key);
    e.count += 1;
    if (e.count <= this.limit) return 0;
    return Math.max(1, Math.ceil((e.resetAt - this.now()) / 1000));
  }

  reset(key) {
    this.map.delete(key);
  }

  cleanup() {
    const t = this.now();
    for (const [k, e] of this.map) if (e.resetAt <= t) this.map.delete(k);
  }
}

module.exports = { WindowCounter };
