'use strict';
/**
 * 厂商推送：手机上的 App 没在运行时，有新的审批或提问也能收到系统通知（docs/09 第 10 节，协议 2.10）。
 * 现在只接了华为推送（HarmonyOS NEXT 的 App，platform 为 harmony）。
 *
 *   - 控制端连上信令后发 push-register 登记推送令牌，存进数据库（store.js 的 push_tokens）。
 *   - 被控端推 approvals 时，hub 把列表交给 onApprovals：没推送过的审批，每条给账号下所有令牌发一条通知。
 *     推送过哪些记在 push_notified 表里，所以电脑重连、重发列表、服务器重启都不会再推一遍。
 *   - 推送失败只记日志，不影响信令。
 */
const crypto = require('crypto');
const { WindowCounter } = require('./ratelimit');
const { tokenTag } = require('./huawei-push');

const PLATFORMS = new Set(['harmony']);
const MAX_TOKENS_PER_USER = 10; // 华为测试消息每次最多 10 个令牌
const MAX_TOKEN_LEN = 512;
const MAX_ITEMS_PER_LIST = 100;
const MAX_ID_LEN = 64;
const NOTIFIED_KEEP_MS = 8 * 24 * 3600 * 1000; // 审批最长等 7 天
const TITLE_MAX = 40;
const BODY_MAX = 100;
const PLAN_TOOLS = new Set(['ExitPlanMode', '计划']); // 插件把 ExitPlanMode 显示成"计划"

/** 合并空白、截到 max 个字符 */
function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : s;
}

/** 审批编号换成通知编号（0～2147483647）：同一条审批的通知互相覆盖 */
function notifyIdOf(approvalId) {
  return crypto.createHash('sha256').update(String(approvalId)).digest().readUInt32BE(0) & 0x7fffffff;
}

/** 通知的标题和正文 */
function approvalText(item) {
  const tool = typeof item.tool === 'string' ? item.tool : '';
  let title;
  let detail;
  if (item.kind === 'ask') {
    title = 'Claude 有问题要问你';
    const q = Array.isArray(item.questions) && item.questions[0];
    detail = q && typeof q.question === 'string' ? q.question : '';
  } else {
    title = PLAN_TOOLS.has(tool) ? 'Claude 要你审批计划' : clip(`Claude 要你审批：${tool || '工具调用'}`, TITLE_MAX);
    const p = Array.isArray(item.params) && item.params[0];
    detail = (typeof item.description === 'string' && item.description) || (p && typeof p.value === 'string' ? p.value : '');
  }
  const session = typeof item.title === 'string' ? clip(item.title, 40) : '';
  const body = clip(session && detail ? `${session}：${detail}` : session || detail || '打开 App 查看', BODY_MAX);
  return { title, body };
}

/** 日志里的华为响应：里面出现的令牌换成前几位 */
function redact(text, tokens) {
  let out = String(text || '');
  for (const t of tokens) out = out.split(t).join(tokenTag(t));
  // 别的令牌（不该出现，以防万一）：30 位以上不带空白的串都只留前 6 位
  return clip(out.replace(/[A-Za-z0-9_+/=.:-]{30,}/g, (m) => tokenTag(m)), 200);
}

/** 这种结果是暂时的，值得下次再推：对方 5xx、流控 */
function transient(r) {
  return r.status >= 500 || r.status === 429 || r.code === '81000001' || r.code === '80300029';
}

/**
 * 华为推送的 payload.notification。点通知打开 App 首页，clickAction.data 带上审批编号和电脑编号，
 * App 在 want.parameters 里取（冷启动 onCreate、热启动 onNewWant）。
 */
function huaweiNotification(item, hostId, category, showDetail = true) {
  const text = approvalText(item);
  const title = text.title;
  // 不显示细节时正文只有会话名：命令、路径不经过华为服务器，也不出现在锁屏上
  const body = showDetail ? text.body : clip(typeof item.title === 'string' && item.title ? item.title : '打开 App 查看', BODY_MAX);
  return {
    category,
    title,
    body,
    clickAction: { actionType: 0, data: { approvalId: item.id, hostId, kind: item.kind === 'ask' ? 'ask' : 'permission' } },
    notifyId: notifyIdOf(item.id),
  };
}

class PushService {
  /**
   * @param {object} opts
   * @param {import('./store').Store} opts.store
   * @param {ReturnType<import('./huawei-push').createHuaweiPushClient>|null} opts.huawei 没配置时为 null
   * @param {{ category: string, testMessage: boolean, ttl: number, maxPerHour: number }} [opts.options]
   * @param {(...a:any[]) => void} [opts.log]
   * @param {() => number} [opts.now]
   */
  constructor({ store, huawei, options = {}, log, now = Date.now }) {
    this.store = store;
    this.huawei = huawei || null;
    this.category = options.category || 'MARKETING';
    this.testMessage = options.testMessage !== false;
    this.ttl = Number(options.ttl) || 86400;
    this.log = log || (() => {});
    this.now = now;
    this.showDetail = options.showDetail !== false;
    this.perHour = new WindowCounter(Number(options.maxPerHour) || 60, 3600 * 1000, now);
    this.registerRate = new WindowCounter(30, 60 * 1000, now); // 每个账号每分钟登记次数
    this.closed = false;
    /** 令牌被删以后告诉 hub（它要决定还给不给电脑报"推送"这个虚拟控制端） */
    this.onTokensChanged = () => {};
    /** 正在发的推送，测试和关闭时用 */
    this.inflight = new Set();
  }

  get enabled() {
    return !!this.huawei;
  }

  /**
   * 登记推送令牌。
   * @returns {{ ok: true, previousUserId: number|null } | { ok: false, error: string }}
   */
  register(userId, authTokenId, platform, token) {
    if (!this.enabled) return { ok: false, error: 'push-not-configured' };
    if (!PLATFORMS.has(platform)) return { ok: false, error: 'bad-platform' };
    if (this.registerRate.hit(String(userId))) return { ok: false, error: 'rate-limited' };
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LEN || !/^[\x21-\x7e]+$/.test(token)) {
      return { ok: false, error: 'bad-token' };
    }
    try {
      const { previousUserId } = this.store.putPushToken({
        token,
        platform,
        userId,
        authTokenId,
        now: this.now(),
        maxPerUser: MAX_TOKENS_PER_USER,
      });
      this.log(`[push] 账号 ${userId} 登记了 ${platform} 推送令牌 ${tokenTag(token)}${previousUserId && previousUserId !== userId ? `（原属账号 ${previousUserId}）` : ''}`);
      return { ok: true, previousUserId };
    } catch (err) {
      this.log(`[push] 登记推送令牌失败: ${err.message}`);
      return { ok: false, error: 'failed' };
    }
  }

  /** 删掉本账号的一个令牌，返回是否删了 */
  unregister(userId, token) {
    if (typeof token !== 'string' || !token) return false;
    try {
      const removed = this.store.deletePushTokenOfUser(token, userId);
      if (removed) this.log(`[push] 账号 ${userId} 注销了推送令牌 ${tokenTag(token)}`);
      return removed;
    } catch (err) {
      this.log(`[push] 注销推送令牌失败: ${err.message}`);
      return false;
    }
  }

  /** 账号下有没有能推的令牌 */
  hasTokens(userId) {
    if (!this.enabled) return false;
    try {
      return this.store.pushTokens(userId, 'harmony').length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 被控端推来一份等待中的审批列表。找出没推送过的，每条推一次。不抛异常。
   * @returns {Promise<void>} 这一批推送都结束时 resolve（测试用；hub 不等）
   */
  onApprovals(userId, hostId, list) {
    if (!this.enabled || this.closed || !Array.isArray(list)) return Promise.resolve();
    let fresh = [];
    let tokens = [];
    try {
      const now = this.now();
      for (const item of list.slice(0, MAX_ITEMS_PER_LIST)) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.id.length > MAX_ID_LEN) continue;
        // 没有令牌时也记下来：之后登记的手机不会收到一串旧审批的通知
        if (this.store.markNotified(userId, hostId, item.id, now)) fresh.push(item);
      }
      if (!fresh.length) return Promise.resolve();
      tokens = this.store.pushTokens(userId, 'harmony');
    } catch (err) {
      this.log(`[push] 处理审批列表失败: ${err.message}`);
      return Promise.resolve();
    }
    if (!tokens.length) return Promise.resolve();
    const jobs = [];
    for (const item of fresh) {
      if (this.perHour.hit(String(userId))) {
        this.log(`[push] 账号 ${userId} 一小时内推送太多，审批 ${item.id} 先不推`);
        this.unmark(userId, hostId, item.id);
        continue;
      }
      jobs.push(this.deliver(userId, hostId, tokens, item));
    }
    return Promise.all(jobs).then(() => {});
  }

  unmark(userId, hostId, approvalId) {
    if (this.closed) return;
    try {
      this.store.unmarkNotified(userId, hostId, approvalId);
    } catch (err) {
      this.log(`[push] 撤销推送记录失败: ${err.message}`);
    }
  }

  deliver(userId, hostId, tokens, item) {
    const sentAt = this.now();
    const targets = tokens.slice(0, MAX_TOKENS_PER_USER);
    const job = Promise.resolve()
      .then(() => {
        const notification = huaweiNotification(item, hostId, this.category, this.showDetail);
        return this.huawei.send(targets, notification, { testMessage: this.testMessage, ttl: this.ttl });
      })
      .then((r) => {
        const msg = redact(r.msg, targets);
        if (!r.ok) {
          this.log(`[push] 审批 ${item.id} 推送失败: HTTP ${r.status} ${r.code} ${msg} requestId=${r.requestId}`);
          if (transient(r)) this.unmark(userId, hostId, item.id);
        } else if (r.code !== '80000000') {
          this.log(`[push] 审批 ${item.id} 部分令牌没推到: ${msg}`);
        }
        if (r.deadTokens.length && !this.closed) {
          const n = this.store.deletePushTokens(r.deadTokens, userId, sentAt);
          this.log(`[push] 华为说令牌无效（${r.code}），删除账号 ${userId} 的 ${n} 个推送令牌: ${r.deadTokens.map(tokenTag).join(', ')}`);
          this.onTokensChanged(userId);
        }
      })
      .catch((err) => {
        this.log(`[push] 审批 ${item.id} 推送出错: ${err && err.name === 'TimeoutError' ? '超时' : err && err.message}`);
        this.unmark(userId, hostId, item.id); // 网络错误、超时：下次再推
      })
      .finally(() => this.inflight.delete(job));
    this.inflight.add(job);
    return job;
  }

  cleanup() {
    if (this.closed) return;
    try {
      this.store.purgeNotified(this.now() - NOTIFIED_KEEP_MS);
    } catch (err) {
      this.log(`[push] 清理推送记录失败: ${err.message}`);
    }
    this.perHour.cleanup();
    this.registerRate.cleanup();
  }

  close() {
    this.closed = true;
  }
}

module.exports = { PushService, huaweiNotification, approvalText, notifyIdOf, MAX_TOKENS_PER_USER };
