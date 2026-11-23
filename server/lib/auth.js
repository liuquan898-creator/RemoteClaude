'use strict';
/**
 * 账号服务：发验证码、注册、登录、重置密码、退出登录、校验令牌。
 * 接口约定见 docs/03-protocol.md 第 1 节。
 */
const crypto = require('crypto');
const { hashPassword, verifyPassword, DUMMY_HASH } = require('./passwords');
const { WindowCounter } = require('./ratelimit');
const { codeEmail } = require('./mailer');

const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const TOKEN_TTL_MS = { viewer: 30 * 86400 * 1000, host: 180 * 86400 * 1000 };
const PURPOSES = new Set(['register', 'reset']);
const CLIENT_TYPES = new Set(['viewer', 'host']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class AuthError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function normalizeEmail(v) {
  const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) throw new AuthError(400, 'bad-email', '邮箱格式不对');
  return email;
}

function checkPassword(v) {
  if (typeof v !== 'string' || v.length < 8 || v.length > 128) {
    throw new AuthError(400, 'weak-password', '密码要 8 到 128 个字符');
  }
  return v;
}

function deviceInfo(body) {
  const clientType = body.clientType;
  if (!CLIENT_TYPES.has(clientType)) throw new AuthError(400, 'bad-request', 'clientType 只能是 viewer 或 host');
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
  if (!DEVICE_ID_RE.test(deviceId)) throw new AuthError(400, 'bad-request', 'deviceId 格式不对');
  let deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim().replace(/[\u0000-\u001f]/g, '') : '';
  if (!deviceName) deviceName = clientType === 'host' ? '电脑' : '控制端';
  return { clientType, deviceId, deviceName: deviceName.slice(0, 64) };
}

const tooMany = (sec, message) => new AuthError(429, 'too-many', message || `操作太频繁，请 ${sec} 秒后再试`, { retryAfter: sec });

class AuthService {
  /**
   * @param {object} opts
   * @param {import('./store').Store} opts.store
   * @param {{send: Function}} opts.mailer
   * @param {boolean} opts.registrationOpen
   * @param {object} opts.limits 见 config.js 的 DEFAULT_LIMITS
   * @param {(tokenIds:number[], userId:number) => void} [opts.onRevoke] 令牌作废时通知信令层断开对应连接、刷新电脑列表
   */
  constructor({ store, mailer, registrationOpen, limits, onRevoke, log, now = Date.now }) {
    this.store = store;
    this.mailer = mailer;
    this.registrationOpen = registrationOpen;
    this.onRevoke = onRevoke || (() => {});
    this.log = log || (() => {});
    this.now = now;
    this.limits = limits;

    const hour = 3600 * 1000;
    const failWindow = limits.loginFailWindowMin * 60 * 1000;
    this.codeIp = new WindowCounter(limits.codePerIpPerHour, hour, now);
    this.codeEmailDay = new WindowCounter(limits.codePerEmailPerDay, 24 * hour, now);
    this.codeCooldown = new Map(); // email -> 上次发送时间
    this.loginFailIp = new WindowCounter(limits.loginFailPerIp, failWindow, now);
    this.loginFailEmail = new WindowCounter(limits.loginFailPerEmail, failWindow, now);
  }

  // ---------------------------------------------------------------- 验证码

  async sendCode(body, ip) {
    const email = normalizeEmail(body && body.email);
    const purpose = body && body.purpose;
    if (!PURPOSES.has(purpose)) throw new AuthError(400, 'bad-request', 'purpose 只能是 register 或 reset');

    const ipWait = this.codeIp.hit(ip);
    if (ipWait) throw tooMany(ipWait);

    // 注册时先告诉用户邮箱已注册，比"太频繁"更有用；找回密码不做这个区分（见下）
    const user = this.store.findUserByEmail(email);
    if (purpose === 'register') {
      if (!this.registrationOpen) throw new AuthError(403, 'registration-closed', '暂不开放注册');
      if (user) throw new AuthError(409, 'email-taken', '这个邮箱已经注册过了，请直接登录');
    }

    const cooldown = this.limits.codeCooldownSec;
    const last = this.codeCooldown.get(`${purpose}:${email}`) || 0;
    const wait = Math.ceil((last + cooldown * 1000 - this.now()) / 1000);
    if (wait > 0) throw tooMany(wait, `验证码已发送，请 ${wait} 秒后再试`);

    const dayWait = this.codeEmailDay.blockedFor(email);
    if (dayWait) throw tooMany(dayWait, '这个邮箱今天收到的验证码太多了，请明天再试');
    this.codeCooldown.set(`${purpose}:${email}`, this.now());

    // 找回密码时邮箱没注册：照常返回成功但不发信，免得被用来试探哪些邮箱注册过
    if (purpose === 'reset' && !user) return { ok: true, cooldown };

    this.codeEmailDay.hit(email);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.store.putCode(email, purpose, sha256(`${purpose}:${email}:${code}`), this.now() + CODE_TTL_MS);
    try {
      await this.mailer.send({ to: email, code, ...codeEmail(purpose, code) });
    } catch (err) {
      this.store.deleteCode(email, purpose);
      this.codeCooldown.delete(`${purpose}:${email}`);
      this.log(`[邮件] 发往 ${email} 失败: ${err && err.message}`);
      throw new AuthError(502, 'mail-failed', '验证码邮件发送失败，请稍后再试');
    }
    this.log(`[账号] 已向 ${email} 发送${purpose === 'register' ? '注册' : '重置密码'}验证码`);
    return { ok: true, cooldown };
  }

  /** 核对验证码；成功后作废，失败累计次数，错满 5 次作废 */
  consumeCode(email, purpose, code) {
    const row = this.store.getCode(email, purpose);
    if (!row || row.expires_at <= this.now() || row.attempts >= CODE_MAX_ATTEMPTS) {
      if (row) this.store.deleteCode(email, purpose);
      throw new AuthError(400, 'bad-code', '验证码已过期，请重新获取');
    }
    const given = typeof code === 'string' ? code.trim() : '';
    const ok =
      /^\d{6}$/.test(given) &&
      crypto.timingSafeEqual(Buffer.from(sha256(`${purpose}:${email}:${given}`)), Buffer.from(row.code_hash));
    if (!ok) {
      this.store.bumpCodeAttempts(email, purpose);
      throw new AuthError(400, 'bad-code', '验证码不对');
    }
    this.store.deleteCode(email, purpose);
  }

  // ---------------------------------------------------------------- 注册、登录、重置

  async register(body, ip) {
    if (!this.registrationOpen) throw new AuthError(403, 'registration-closed', '暂不开放注册');
    const email = normalizeEmail(body && body.email);
    const password = checkPassword(body.password);
    const device = deviceInfo(body);
    if (this.store.findUserByEmail(email)) throw new AuthError(409, 'email-taken', '这个邮箱已经注册过了，请直接登录');
    this.consumeCode(email, 'register', body.code);

    const userId = this.store.createUser(email, await hashPassword(password), this.now());
    if (userId === null) throw new AuthError(409, 'email-taken', '这个邮箱已经注册过了，请直接登录');
    this.log(`[账号] 新注册 ${email}（${ip}）`);
    return { token: this.issue(userId, device), email };
  }

  async login(body, ip) {
    const email = typeof (body && body.email) === 'string' ? body.email.trim().toLowerCase() : '';
    const password = body && typeof body.password === 'string' ? body.password : '';
    const device = deviceInfo(body);

    const locked = Math.max(this.loginFailIp.blockedFor(ip), email ? this.loginFailEmail.blockedFor(email) : 0);
    if (locked) throw tooMany(locked, `密码错误次数太多，请 ${Math.ceil(locked / 60)} 分钟后再试`);

    const user = email ? this.store.findUserByEmail(email) : null;
    const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      this.loginFailIp.hit(ip);
      if (email) this.loginFailEmail.hit(email);
      throw new AuthError(401, 'bad-credentials', '邮箱或密码不对');
    }
    this.loginFailEmail.reset(email);
    return { token: this.issue(user.id, device), email: user.email };
  }

  async resetPassword(body, ip) {
    const email = normalizeEmail(body && body.email);
    const password = checkPassword(body.password);
    this.consumeCode(email, 'reset', body.code);
    const user = this.store.findUserByEmail(email);
    if (!user) throw new AuthError(400, 'bad-code', '验证码已过期，请重新获取');

    this.store.setPassword(user.id, await hashPassword(password));
    const revoked = this.store.deleteTokensOfUser(user.id);
    this.loginFailEmail.reset(email);
    this.log(`[账号] ${email} 重置了密码（${ip}），${revoked.length} 个设备已下线`);
    this.onRevoke(revoked, user.id);
    return { ok: true };
  }

  /** 退出登录：作废这个令牌。令牌本来就无效时也算成功 */
  logout(token) {
    const row = typeof token === 'string' && token ? this.store.findToken(sha256(token)) : null;
    if (!row) return { ok: true };
    this.store.deleteToken(Number(row.id));
    this.onRevoke([Number(row.id)], Number(row.user_id));
    return { ok: true };
  }

  // ---------------------------------------------------------------- 令牌

  issue(userId, { clientType, deviceId, deviceName }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const { revokedIds } = this.store.issueToken({
      tokenHash: sha256(token),
      userId,
      kind: clientType,
      deviceId,
      deviceName,
      now,
      expiresAt: now + TOKEN_TTL_MS[clientType],
    });
    if (revokedIds.length) this.onRevoke(revokedIds, userId);
    return token;
  }

  /**
   * 校验信令连接用的令牌，成功时把有效期从现在起顺延。
   * @returns {{tokenId:number, userId:number, email:string, deviceId:string, deviceName:string} | null}
   */
  verifyToken(token, role) {
    if (typeof token !== 'string' || !token || !CLIENT_TYPES.has(role)) return null;
    const row = this.store.findToken(sha256(token));
    const now = this.now();
    if (!row || row.kind !== role || row.expires_at <= now) return null;
    this.store.touchToken(Number(row.id), now, now + TOKEN_TTL_MS[role]);
    return {
      tokenId: Number(row.id),
      userId: Number(row.user_id),
      email: row.email,
      deviceId: row.device_id,
      deviceName: row.device_name,
    };
  }

  /** 账号下登录着的电脑 */
  listHosts(userId) {
    return this.store.hostDevices(userId, this.now());
  }

  cleanup() {
    this.store.purgeExpired(this.now());
    for (const c of [this.codeIp, this.codeEmailDay, this.loginFailIp, this.loginFailEmail]) c.cleanup();
    const cutoff = this.now() - this.limits.codeCooldownSec * 1000;
    for (const [k, t] of this.codeCooldown) if (t < cutoff) this.codeCooldown.delete(k);
  }
}

module.exports = { AuthService, AuthError };
