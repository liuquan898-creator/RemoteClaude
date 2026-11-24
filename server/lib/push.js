'use strict';
/**
 * 厂商推送：手机上的 App 没在运行时，有新的审批或提问也能收到系统通知（docs/09 第 10 节，协议 2.10）。
 * 现在只接了华为推送（HarmonyOS NEXT 的 App，platform 为 harmony）。
 *
 *   - 控制端连上信令后发 push-register 登记推送令牌，存进数据库（store.js 的 push_tokens）。
 *   - 被控端推 approvals 时，hub 把列表交给 onApprovals：没推送过的审批，每条给账号下所有令牌发一条通知。
 *     推送过哪些记在 push_notified 表里，所以电脑重连、重发列表、服务器重启都不会再推一遍。
 *   - 对方服务器出错、流控、网络不通时，服务器自己隔一阵再推（retryLater）。
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
/**
 * 每个账号最多留几条推送记录，多了删最旧的，只为不让恶意账号把库写大。一条记录就是一次要人审批或回答的事，
 * 正常人在记录保留的 8 天里远到不了 5000 条；被删的是最旧的，那些审批早处理掉了，删了也不会引出重推。
 */
const MAX_NOTIFIED_PER_USER = 5000;
/**
 * 每个账号每分钟最多处理几份审批列表。电脑对每个控制端各发一份同样的列表，这些副本先去重、不算数（见 onApprovals），
 * 算数的只有变了的列表，而列表只在有审批出现或消失时才变，60 份对人来说绰绰有余。
 */
const MAX_LISTS_PER_MIN = 60;
/** 暂时性失败后隔多久重推，最多重推这么多次 */
const RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
/** 电脑最近一份列表留多久不动就忘掉：重推时要看审批还在不在列表里，重推最多拖十几分钟 */
const LIST_KEEP_MS = 3600 * 1000;
/** "可能是配置不对"的警告（80300007）多久最多记一条 */
const CONFIG_WARN_EVERY_MS = 3600 * 1000;
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

/** 通知的标题和正文（showDetail 为 true 时用） */
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

/** 不显示细节时的标题和正文：只按种类说有一条审批，不带工具名、会话名（窗口标题里可能有项目名）、命令和问题原文 */
function plainText(item) {
  let title = 'Claude 要你审批';
  if (item.kind === 'ask') title = 'Claude 有问题要问你';
  else if (PLAN_TOOLS.has(item.tool)) title = 'Claude 要你审批计划';
  return { title, body: '打开 App 查看' };
}

/** 列表里能用的审批：编号是不太长的字符串；同一编号只留第一条，最多 100 条 */
function validItems(list) {
  const seen = new Set();
  const out = [];
  for (const item of list.slice(0, MAX_ITEMS_PER_LIST)) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.id.length > MAX_ID_LEN) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** 两份列表里的审批编号一样（items 已经按编号去过重） */
function sameIds(ids, items) {
  return ids.size === items.length && items.every((x) => ids.has(x.id));
}

const hostKey = (userId, hostId) => JSON.stringify([userId, hostId]);
const retryKey = (userId, hostId, approvalId) => JSON.stringify([userId, hostId, approvalId]);

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
 * 推送要用的最少字段：标题、正文按 showDetail 算好并截短。推送中和等着重推时只留这个，
 * 不留整条审批——审批的文本字段没有长度上限（一帧信令最大 4MB），重推最多要等十几分钟。
 * @returns {{ id: string, kind: 'ask'|'permission', title: string, body: string }}
 */
function slimItem(item, showDetail) {
  const { title, body } = showDetail ? approvalText(item) : plainText(item);
  return { id: item.id, kind: item.kind === 'ask' ? 'ask' : 'permission', title, body };
}

/** 用 slimItem 的结果拼 payload.notification */
function notificationOf(slim, hostId, category) {
  return {
    category,
    title: slim.title,
    body: slim.body,
    clickAction: { actionType: 0, data: { approvalId: slim.id, hostId, kind: slim.kind } },
    notifyId: notifyIdOf(slim.id),
  };
}

/**
 * 华为推送的 payload.notification。点通知打开 App 首页，clickAction.data 带上审批编号和电脑编号，
 * App 在 want.parameters 里取（冷启动 onCreate、热启动 onNewWant）。
 * showDetail 默认 false：通知只说有一条审批，审批内容不经过华为服务器，也不出现在锁屏上。这是服务器级的开关，
 * 用户自己关不了，所以默认不带。
 */
function huaweiNotification(item, hostId, category, showDetail = false) {
  return notificationOf(slimItem(item, showDetail), hostId, category);
}

class PushService {
  /**
   * @param {object} opts
   * @param {import('./store').Store} opts.store
   * @param {ReturnType<import('./huawei-push').createHuaweiPushClient>|null} opts.huawei 没配置时为 null
   * @param {{ category?: string, testMessage?: boolean, ttl?: number, maxPerHour?: number, showDetail?: boolean }} [opts.options]
   * @param {(...a:any[]) => void} [opts.log]
   * @param {() => number} [opts.now]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [opts.timers] 重推用的定时器，测试里换成手动触发的
   */
  constructor({ store, huawei, options = {}, log, now = Date.now, timers = { setTimeout, clearTimeout } }) {
    this.store = store;
    this.huawei = huawei || null;
    this.category = options.category || 'MARKETING';
    this.testMessage = options.testMessage !== false;
    this.ttl = Number(options.ttl) || 86400;
    this.log = log || (() => {});
    this.now = now;
    this.timers = timers;
    this.showDetail = options.showDetail === true;
    this.perHour = new WindowCounter(Number(options.maxPerHour) || 60, 3600 * 1000, now);
    this.registerRate = new WindowCounter(30, 60 * 1000, now); // 每个账号每分钟登记次数
    this.listRate = new WindowCounter(MAX_LISTS_PER_MIN, 60 * 1000, now); // 每个账号每分钟处理的列表份数
    this.closed = false;
    /** 令牌被删以后告诉 hub（它要决定还给不给电脑报"推送"这个虚拟控制端） */
    this.onTokensChanged = () => {};
    /** 正在发的推送，测试和关闭时用 */
    this.inflight = new Set();
    /**
     * 每台电脑最近一份列表：hostKey -> { ids, done, cappedUntil, at }。ids 是里面的审批编号（重推前看审批还在不在）；
     * done 表示这份已经处理完，同样的副本可以直接跳过；cappedUntil 不为 0 时，这份里有因为每小时上限没推的，
     * 到这个时间（上限的窗口过了）以后同样的副本要再处理一遍。
     * @type {Map<string, { ids: Set<string>, done: boolean, cappedUntil: number, at: number }>}
     */
    this.lists = new Map();
    /**
     * 等着重推的审批：retryKey -> { timer, userId, hostId, item }，item 是 slimItem 的结果。
     * @type {Map<string, { timer: any, userId: number, hostId: string, item: ReturnType<typeof slimItem> }>}
     */
    this.retries = new Map();
    /** 账号到了每小时上限时，日志记到什么时候为止不再记：userId -> 毫秒 */
    this.cappedLogged = new Map();
    /** 上次记"可能是配置不对"警告的时间 */
    this.configWarnedAt = null;
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
   * 电脑对每个控制端（含虚拟的 push）各发一份同样的列表：和这台电脑上一份处理完的列表一样时直接跳过，
   * 不碰数据库，也不算进每分钟的份数。账号到了每小时推送上限时，列表只记下编号、不碰数据库，等窗口过了再处理。
   * @returns {Promise<void>} 这一批推送都结束时 resolve（测试用；hub 不等）
   */
  onApprovals(userId, hostId, list) {
    if (!this.enabled || this.closed || !Array.isArray(list)) return Promise.resolve();
    const items = validItems(list);
    const key = hostKey(userId, hostId);
    const last = this.lists.get(key);
    const now = this.now();
    if (last && last.done && !(last.cappedUntil && last.cappedUntil <= now) && sameIds(last.ids, items)) return Promise.resolve();
    // 超限、出错没处理的也记下最新的编号：重推前看审批还在不在，要用最新的列表
    const entry = { ids: new Set(items.map((x) => x.id)), done: false, cappedUntil: 0, at: now };
    this.lists.set(key, entry);
    const uk = String(userId);
    if (this.listRate.hit(uk)) {
      // 同一个窗口里只在刚超限那次记一条，免得刷屏
      if (this.listRate.count(uk) === MAX_LISTS_PER_MIN + 1) {
        this.log(`[push] 账号 ${userId} 一分钟内发来的审批列表超过 ${MAX_LISTS_PER_MIN} 份，这一分钟里余下的不处理`);
      }
      return Promise.resolve();
    }
    if (this.perHour.blockedFor(uk)) {
      // 这一小时推满了：新审批反正推不了，不记也不撤，窗口过了以后的副本会再处理
      entry.cappedUntil = this.noteCapped(userId);
      entry.done = true;
      return Promise.resolve();
    }
    const fresh = this.markFresh(userId, hostId, items);
    if (!fresh) return Promise.resolve();
    entry.done = true;
    return this.pushAll(userId, hostId, fresh);
  }

  /** 把没推过的审批记下来，返回要推的；数据库出错时返回 null */
  markFresh(userId, hostId, items) {
    // 等着重推的归 retryLater 管：这里不记也不推，免得同一条推两遍
    const candidates = items.filter((x) => !this.retries.has(retryKey(userId, hostId, x.id)));
    if (!candidates.length) return [];
    try {
      const ids = this.store.markNotifiedBatch(userId, hostId, candidates.map((x) => x.id), this.now(), MAX_NOTIFIED_PER_USER);
      const fresh = new Set(ids);
      return candidates.filter((x) => fresh.has(x.id));
    } catch (err) {
      this.log(`[push] 处理审批列表失败: ${err.message}`);
      return null;
    }
  }

  /** 给账号下所有令牌推这几条 */
  pushAll(userId, hostId, items) {
    if (!items.length) return Promise.resolve();
    let tokens;
    try {
      tokens = this.store.pushTokens(userId, 'harmony');
    } catch (err) {
      // 刚记下的撤掉、列表算没处理完：不然这几条永远不会推了
      this.log(`[push] 读推送令牌失败: ${err.message}`);
      for (const item of items) this.unmark(userId, hostId, item.id);
      this.reopen(userId, hostId);
      return Promise.resolve();
    }
    // 没有令牌时上面也记下了：之后登记的手机不会收到一串旧审批的通知
    if (!tokens.length) return Promise.resolve();
    const jobs = [];
    for (const item of items) {
      if (this.overHourly(userId, hostId, item.id)) continue;
      jobs.push(this.deliver(userId, hostId, tokens, slimItem(item, this.showDetail), 0));
    }
    return Promise.all(jobs).then(() => {});
  }

  /**
   * 账号这一小时推满了没有。推满了：这条撤掉记录、先不推；这台电脑的列表记下到什么时候为止推满，
   * 那之前同样的副本照旧跳过，之后的副本再处理（就会推它）。
   */
  overHourly(userId, hostId, approvalId) {
    if (!this.perHour.hit(String(userId))) return false;
    const until = this.noteCapped(userId);
    this.unmark(userId, hostId, approvalId);
    const last = this.lists.get(hostKey(userId, hostId));
    if (last) last.cappedUntil = until;
    return true;
  }

  /** 账号推满了，返回这个每小时窗口到什么时候结束；日志每个窗口只记一条 */
  noteCapped(userId) {
    const uk = String(userId);
    const now = this.now();
    const until = now + this.perHour.blockedFor(uk) * 1000;
    if (!(this.cappedLogged.get(uk) > now)) {
      this.cappedLogged.set(uk, until);
      this.log(`[push] 账号 ${userId} 一小时内推送超过 ${this.perHour.limit} 条，这一小时里余下的审批先不推，之后电脑再发列表时再推`);
    }
    return until;
  }

  /** 这台电脑最近的列表算没处理完：下一份同样的列表不跳过 */
  reopen(userId, hostId) {
    const last = this.lists.get(hostKey(userId, hostId));
    if (last) last.done = false;
  }

  /** 撤掉推送记录，返回撤掉了没有（出错、已经关闭时为 false） */
  unmark(userId, hostId, approvalId) {
    if (this.closed) return false;
    try {
      this.store.unmarkNotified(userId, hostId, approvalId);
      return true;
    } catch (err) {
      this.log(`[push] 撤销审批 ${approvalId} 的推送记录失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 推一条。attempt 是第几次重推，头一回推为 0。
   * @param {ReturnType<typeof slimItem>} item
   */
  deliver(userId, hostId, tokens, item, attempt) {
    const ctx = { userId, hostId, item, attempt, targets: tokens.slice(0, MAX_TOKENS_PER_USER), sentAt: this.now() };
    const job = Promise.resolve()
      .then(() => {
        const notification = notificationOf(item, hostId, this.category);
        return this.huawei.send(ctx.targets, notification, { testMessage: this.testMessage, ttl: this.ttl });
      })
      .then(
        (r) => this.onResult(ctx, r),
        (err) => {
          this.log(`[push] 审批 ${item.id} 推送出错: ${err && err.name === 'TimeoutError' ? '超时' : err && err.message}`);
          this.retryLater(userId, hostId, item, attempt); // 网络错误、超时
        }
      )
      .catch((err) => this.log(`[push] 处理审批 ${item.id} 的推送结果出错: ${err && err.message}`))
      .finally(() => this.inflight.delete(job));
    this.inflight.add(job);
    return job;
  }

  /** 华为的回复：暂时性失败定时重推，无效令牌删掉 */
  onResult({ userId, hostId, item, attempt, targets, sentAt }, r) {
    const msg = redact(r.msg, targets);
    if (!r.ok) {
      this.log(`[push] 审批 ${item.id} 推送失败: HTTP ${r.status} ${r.code} ${msg} requestId=${r.requestId}`);
      if (r.configSuspect) this.warnConfig();
      if (transient(r)) this.retryLater(userId, hostId, item, attempt);
    } else if (r.code !== '80000000') {
      this.log(`[push] 审批 ${item.id} 部分令牌没推到: ${msg}`);
    }
    if (r.deadTokens.length && !this.closed) {
      const n = this.store.deletePushTokens(r.deadTokens, userId, sentAt);
      this.log(`[push] 华为说令牌无效（${r.code}），删除账号 ${userId} 的 ${n} 个推送令牌: ${r.deadTokens.map(tokenTag).join(', ')}`);
      this.onTokensChanged(userId);
    }
  }

  /** 80300007 但不确定是令牌失效：提示查配置，每小时最多一条 */
  warnConfig() {
    const now = this.now();
    if (this.configWarnedAt !== null && now - this.configWarnedAt < CONFIG_WARN_EVERY_MS) return;
    this.configWarnedAt = now;
    this.log(
      '[push] 警告: 华为说这些令牌全都无效（80300007），可这台服务器 24 小时内没推成功过，多半是配置不对，令牌先不删。' +
        '请核对 push.huawei.projectId、服务账号密钥文件和 App 包名是不是同一个 AppGallery Connect 项目下的同一个应用（这条警告每小时最多记一次）'
    );
  }

  /**
   * 暂时性失败（对方 5xx、流控、网络不通、超时）后隔一阵再推同一条，最多重推 RETRY_DELAYS_MS.length 次。
   * 被控端只在审批有变化时才重发列表，不能指望"下一份列表"来补推。
   *
   * 不重复、不漏推的做法：失败时立刻撤掉推送记录，等着重推的审批由这里管——onApprovals 跳过它们（不记也不推），
   * 下一份列表就不会把它当新的再推一遍；到点时记上（或者记录本来就在：上回撤销失败了）就推。
   * 等的这段时间数据库里没有它的记录，服务器要是重启了（定时器没了），电脑重连后发来的列表照样会推它。
   * 撤销失败时照样排重推：记录还在只影响"重启后补推"，等着的时候没有别人会推它，到点直接推，不会静默丢掉。
   * 重推都没成就放弃，等电脑下次发列表。
   * @param {ReturnType<typeof slimItem>} item
   */
  retryLater(userId, hostId, item, attempt) {
    if (this.closed) return;
    const unmarked = this.unmark(userId, hostId, item.id);
    const key = retryKey(userId, hostId, item.id);
    if (this.retries.has(key)) return;
    if (attempt >= RETRY_DELAYS_MS.length) {
      this.log(
        unmarked
          ? `[push] 审批 ${item.id} 重推 ${attempt} 次都没成，等电脑下次发列表时再推`
          : `[push] 审批 ${item.id} 重推 ${attempt} 次都没成，推送记录也撤不掉，这条不会再推了`
      );
      this.reopen(userId, hostId);
      return;
    }
    const timer = this.timers.setTimeout(() => {
      this.retries.delete(key);
      return this.retry(userId, hostId, item, attempt + 1);
    }, RETRY_DELAYS_MS[attempt]);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this.retries.set(key, { timer, userId, hostId, item });
  }

  /** 到点重推。审批已经不在这台电脑最近的列表里（处理掉了，或者电脑下线了）就不推了 */
  retry(userId, hostId, item, attempt) {
    if (this.closed) return Promise.resolve();
    const last = this.lists.get(hostKey(userId, hostId));
    if (!last || !last.ids.has(item.id)) {
      this.log(`[push] 审批 ${item.id} 已经不在电脑的列表里了，不再重推`);
      return Promise.resolve();
    }
    let tokens;
    try {
      // 等着重推时 onApprovals 不记它，这里记不上只能是记录本来就在（上回撤销失败），也归这次重推
      this.store.markNotifiedBatch(userId, hostId, [item.id], this.now(), MAX_NOTIFIED_PER_USER);
      tokens = this.store.pushTokens(userId, 'harmony');
    } catch (err) {
      this.log(`[push] 重推审批 ${item.id} 失败: ${err.message}`);
      this.unmark(userId, hostId, item.id);
      last.done = false; // 让下一份列表再试
      return Promise.resolve();
    }
    if (!tokens.length) return Promise.resolve(); // 令牌都没了：和没令牌时一样，记下、不推
    if (this.overHourly(userId, hostId, item.id)) return Promise.resolve();
    return this.deliver(userId, hostId, tokens, item, attempt);
  }

  /**
   * 电脑下线了（hub 确认这台电脑没有别的连接以后才调）：忘掉它最近的列表，取消它等着的重推。
   * 不然到点会照着下线前的列表推一条可能早就失效的通知。等着重推的记录已经撤掉（这里再撤一次，以防上回撤销失败），
   * 电脑重连后发来的列表里还有这条的话会重新推。
   */
  hostGone(userId, hostId) {
    this.lists.delete(hostKey(userId, hostId));
    for (const [key, r] of this.retries) {
      if (r.userId !== userId || r.hostId !== hostId) continue;
      this.timers.clearTimeout(r.timer);
      this.retries.delete(key);
      this.unmark(userId, hostId, r.item.id);
    }
  }

  cleanup() {
    if (this.closed) return;
    try {
      this.store.purgeNotified(this.now() - NOTIFIED_KEEP_MS);
    } catch (err) {
      this.log(`[push] 清理推送记录失败: ${err.message}`);
    }
    const now = this.now();
    for (const [key, last] of this.lists) if (last.at <= now - LIST_KEEP_MS) this.lists.delete(key);
    for (const [uk, until] of this.cappedLogged) if (until <= now) this.cappedLogged.delete(uk);
    this.perHour.cleanup();
    this.registerRate.cleanup();
    this.listRate.cleanup();
  }

  /** 停止推送，等着的重推都取消（它们的推送记录已经撤掉，服务器下次启动后电脑发来列表时照样推） */
  close() {
    this.closed = true;
    for (const r of this.retries.values()) this.timers.clearTimeout(r.timer);
    this.retries.clear();
  }
}

module.exports = {
  PushService,
  huaweiNotification,
  approvalText,
  notifyIdOf,
  MAX_TOKENS_PER_USER,
  MAX_NOTIFIED_PER_USER,
  MAX_LISTS_PER_MIN,
  RETRY_DELAYS_MS,
};
