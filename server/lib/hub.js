'use strict';
/**
 * 信令转发：按账号把电脑（被控端）和控制端配对，只在同一账号内转发消息。
 * 消息约定见 docs/03-protocol.md 第 2 节。视频和输入走 WebRTC，不经过这里。
 */
const crypto = require('crypto');
const { WindowCounter } = require('./ratelimit');

const PROTO = 2;
const AUTH_TIMEOUT_MS = 10 * 1000;
const VIEWER_MSG_LIMIT = 64 * 1024;
const VIEWER_TYPES = new Set(['list', 'select', 'answer', 'ice', 'stop', 'list-sessions', 'open-session', 'new-session', 'close-window', 'host-update', 'approval-answer', 'host-cmd']);
/** 控制端发给服务器自己的消息（不转发），协议 2.10 */
const PUSH_TYPES = new Set(['push-register', 'push-unregister']);
/**
 * 虚拟控制端的编号。账号登记了推送令牌时，服务器对电脑说有这么一个控制端连着（viewer-join），
 * 电脑就会像对真的控制端一样把 approvals 发给它，手机 App 没开着时服务器也能看到新审批、发推送。
 * 发给它的消息服务器收下、不转发。真的控制端编号是 12 位十六进制，不会和它撞。
 */
const PUSH_VIEWER_ID = 'push';
const HOST_TYPES = new Set(['windows', 'offer', 'ice', 'selected', 'error', 'window-closed', 'sessions', 'session-opened', 'session-failed', 'close-window-result', 'host-update-state', 'approvals', 'approval-result', 'host-state', 'host-cmd-result']);

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

class Hub {
  /**
   * @param {object} opts
   * @param {import('./auth').AuthService} opts.auth
   * @param {() => object[]} opts.iceServers 每次鉴权成功时调用，签发新的 TURN 临时凭据
   * @param {import('./push').PushService} [opts.push] 厂商推送；不给或没配置时不推送
   */
  constructor({ auth, iceServers, limits, log, push = null, now = Date.now }) {
    this.auth = auth;
    this.push = push && push.enabled ? push : null;
    this.iceServers = iceServers;
    this.log = log || (() => {});
    this.authFails = new WindowCounter(limits.wsAuthFailPerIp, 15 * 60 * 1000, now);
    /** userId -> { hosts: Map<hostId, ws>, viewers: Map<viewerId, ws>, pushViewer: boolean } */
    this.accounts = new Map();
  }

  account(userId) {
    let a = this.accounts.get(userId);
    if (!a) {
      a = { hosts: new Map(), viewers: new Map(), pushViewer: false };
      this.accounts.set(userId, a);
    }
    return a;
  }

  /** 接管一条新的 WebSocket 连接 */
  attach(ws, ip) {
    ws.ctx = null;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    const timer = setTimeout(() => {
      if (!ws.ctx) ws.close(4001, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      if (ws.ctx && ws.ctx.role === 'viewer' && data.length > VIEWER_MSG_LIMIT) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      if (!ws.ctx) this.handleAuth(ws, ip, msg);
      else if (ws.ctx.role === 'host') this.fromHost(ws, msg);
      else this.fromViewer(ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(timer);
      this.detach(ws);
    });
    ws.on('error', () => {});
  }

  fail(ws, ip, reason) {
    if (reason === 'bad-token') this.authFails.hit(ip);
    send(ws, { type: 'auth-fail', reason });
    ws.close(4003, 'auth failed');
  }

  handleAuth(ws, ip, msg) {
    if (msg.type !== 'auth') return;
    if (this.authFails.blockedFor(ip)) return this.fail(ws, ip, 'locked');
    if (msg.proto !== PROTO) return this.fail(ws, ip, 'bad-proto');
    const role = msg.role === 'host' ? 'host' : msg.role === 'viewer' ? 'viewer' : null;
    const session = role ? this.auth.verifyToken(msg.token, role) : null;
    if (!session) return this.fail(ws, ip, 'bad-token');

    const acc = this.account(session.userId);
    const client = typeof msg.client === 'string' ? msg.client.slice(0, 40) : '';

    if (role === 'host') {
      const hostId = session.deviceId;
      const old = acc.hosts.get(hostId);
      if (old && old !== ws) {
        send(old, { type: 'replaced' });
        old.ctx.replaced = true;
        old.close(4002, 'replaced');
      }
      ws.ctx = { role, userId: session.userId, tokenId: session.tokenId, hostId, email: session.email };
      // 先对已经在线的电脑同步虚拟控制端，再把这台加进去：这台从 auth-ok 的 viewers 里得知
      const pushViewer = this.syncPushViewer(session.userId);
      acc.hosts.set(hostId, ws);
      this.log(`[host] ${session.email} 的电脑「${session.deviceName}」已上线 ${ip} ${client}`);
      send(ws, {
        type: 'auth-ok',
        role: 'host',
        hostId,
        email: session.email,
        iceServers: this.iceServers(),
        viewers: [...acc.viewers.keys(), ...(pushViewer ? [PUSH_VIEWER_ID] : [])],
      });
      this.broadcastHosts(session.userId);
      return;
    }

    const id = crypto.randomBytes(6).toString('hex');
    ws.ctx = { role, userId: session.userId, tokenId: session.tokenId, id, email: session.email };
    acc.viewers.set(id, ws);
    this.log(`[viewer ${id}] ${session.email} 的「${session.deviceName}」已连接 ${ip} ${client}`);
    send(ws, {
      type: 'auth-ok',
      role: 'viewer',
      id,
      email: session.email,
      iceServers: this.iceServers(),
      hosts: this.hostList(session.userId),
    });
    for (const h of acc.hosts.values()) send(h, { type: 'viewer-join', id });
  }

  fromViewer(ws, msg) {
    if (PUSH_TYPES.has(msg.type)) return this.pushMessage(ws, msg);
    if (!VIEWER_TYPES.has(msg.type)) return;
    const acc = this.accounts.get(ws.ctx.userId);
    const hostId = typeof msg.host === 'string' ? msg.host : '';
    const host = acc && acc.hosts.get(hostId);
    if (!host) {
      send(ws, { type: 'error', code: 'host-offline', host: hostId });
      return;
    }
    send(host, { ...msg, from: ws.ctx.id });
  }

  /** push-register、push-unregister：服务器自己处理 */
  pushMessage(ws, msg) {
    const { userId, tokenId } = ws.ctx;
    if (msg.type === 'push-unregister') {
      if (this.push && this.push.unregister(userId, msg.token)) this.syncPushViewer(userId);
      return;
    }
    const platform = typeof msg.platform === 'string' ? msg.platform : '';
    const r = this.push ? this.push.register(userId, tokenId, platform, msg.token) : { ok: false, error: 'push-not-configured' };
    send(ws, r.ok ? { type: 'push-register-result', ok: true } : { type: 'push-register-result', ok: false, error: r.error });
    if (!r.ok) return;
    if (r.previousUserId && r.previousUserId !== userId) this.syncPushViewer(r.previousUserId);
    this.syncPushViewer(userId);
  }

  /**
   * 账号有没有推送令牌变了时，对在线的电脑报虚拟控制端上线或下线。返回现在该不该有它。
   * 电脑收到 viewer-join 会立即发一份 approvals 过来。登记令牌的那个控制端连上时电脑已经给它发过同一份，
   * 里面的审批那时就记为推送过了，所以这份一般不会引出旧审批的通知（例外是列表恰好在这之间变了，最多多一条）。
   */
  syncPushViewer(userId) {
    const want = !!this.push && this.push.hasTokens(userId);
    const acc = this.accounts.get(userId);
    if (!acc) return want;
    if (acc.pushViewer !== want) {
      acc.pushViewer = want;
      for (const h of acc.hosts.values()) send(h, { type: want ? 'viewer-join' : 'viewer-leave', id: PUSH_VIEWER_ID });
    }
    return want;
  }

  fromHost(ws, msg) {
    if (!HOST_TYPES.has(msg.type) || typeof msg.to !== 'string') return;
    // 电脑对每个控制端（含虚拟的）各发一份同样的列表；推过的不会再推，所以每份都交过去也没关系
    if (msg.type === 'approvals' && this.push) {
      try {
        this.push.onApprovals(ws.ctx.userId, ws.ctx.hostId, msg.list).catch(() => {});
      } catch (err) {
        this.log(`[push] 处理审批列表出错: ${err && err.message}`);
      }
    }
    const acc = this.accounts.get(ws.ctx.userId);
    const viewer = acc && acc.viewers.get(msg.to);
    if (!viewer) return;
    const { to, ...rest } = msg;
    send(viewer, { ...rest, host: ws.ctx.hostId });
  }

  detach(ws) {
    const ctx = ws.ctx;
    if (!ctx) return;
    const acc = this.accounts.get(ctx.userId);
    if (!acc) return;
    if (ctx.role === 'host') {
      if (acc.hosts.get(ctx.hostId) === ws) {
        acc.hosts.delete(ctx.hostId);
        this.log(`[host] ${ctx.email} 的电脑 ${ctx.hostId} 已下线`);
        this.broadcastHosts(ctx.userId);
      }
    } else if (acc.viewers.get(ctx.id) === ws) {
      acc.viewers.delete(ctx.id);
      this.log(`[viewer ${ctx.id}] 已断开`);
      for (const h of acc.hosts.values()) send(h, { type: 'viewer-leave', id: ctx.id });
    }
    if (!acc.hosts.size && !acc.viewers.size) this.accounts.delete(ctx.userId);
  }

  /** 账号下所有登录着的电脑，标出是否在线；在线的排在前面 */
  hostList(userId) {
    const acc = this.accounts.get(userId);
    const online = acc ? acc.hosts : new Map();
    const list = this.auth.listHosts(userId).map((h) => ({ id: h.id, name: h.name, online: online.has(h.id) }));
    list.sort((a, b) => Number(b.online) - Number(a.online));
    return list;
  }

  broadcastHosts(userId) {
    const acc = this.accounts.get(userId);
    if (!acc || !acc.viewers.size) return;
    const hosts = this.hostList(userId);
    for (const v of acc.viewers.values()) send(v, { type: 'hosts', hosts });
  }

  /**
   * 令牌被作废（退出登录、重置密码、同一设备重新登录）：断开用它连着的信令连接，
   * 并刷新这个账号的电脑列表。被控端退出时往往先断开连接、再通知服务器作废令牌，
   * 那时已经没有连接可断，但列表仍要刷新，否则控制端会一直看到一台"离线"的电脑。
   */
  revoke(tokenIds, userId) {
    const ids = new Set(tokenIds);
    const acc = this.accounts.get(userId);
    if (acc) {
      for (const ws of [...acc.hosts.values(), ...acc.viewers.values()]) {
        if (ids.has(ws.ctx.tokenId)) {
          send(ws, { type: 'auth-fail', reason: 'revoked' });
          ws.close(4003, 'revoked');
        }
      }
    }
    this.broadcastHosts(userId);
    // 推送令牌挂在登录令牌上，跟着删了
    this.syncPushViewer(userId);
  }

  /** 登录令牌过期被清理时，挂在上面的推送令牌也跟着删了：对在线的账号重新同步虚拟控制端 */
  syncAllPushViewers() {
    if (!this.push) return;
    for (const userId of [...this.accounts.keys()]) this.syncPushViewer(userId);
  }

  /** 心跳：清掉断网后没有正常关闭的连接 */
  heartbeat(clients) {
    for (const ws of clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    this.authFails.cleanup();
  }
}

module.exports = { Hub, PROTO, PUSH_VIEWER_ID };
