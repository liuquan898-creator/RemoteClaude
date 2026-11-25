'use strict';
/**
 * 账号数据：用户、登录令牌、邮箱验证码。用 Node 自带的 SQLite（node:sqlite），不需要编译原生模块。
 * 时间一律是毫秒时间戳。令牌和验证码只存散列值。
 * 表结构的升级靠 CREATE ... IF NOT EXISTS：新加的表在已有数据库上第一次启动时自动建好，不改旧表。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('viewer', 'host')),
  device_id    TEXT NOT NULL,
  device_name  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_by_user ON tokens(user_id, kind);

CREATE TABLE IF NOT EXISTS email_codes (
  email      TEXT NOT NULL,
  purpose    TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (email, purpose)
);

-- 手机的厂商推送令牌（docs/09 第 10 节）。一个推送令牌只属于一个账号（谁最后登记归谁），
-- 并挂在登记它的那个控制端登录令牌上：退出登录、重置密码、令牌过期时随之删除，不会再往这台手机推。
CREATE TABLE IF NOT EXISTS push_tokens (
  token         TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_token_id INTEGER NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_tokens_by_user ON push_tokens(user_id, platform);
CREATE INDEX IF NOT EXISTS push_tokens_by_auth ON push_tokens(auth_token_id);

-- 已经推送过的审批，免得电脑重连、重发列表、服务器重启后再推一遍。审批编号随机不重复，
-- 审批最长等 7 天，所以记录留 8 天后清掉，不随审批从列表里消失而删。每个账号最多留的条数见 push.js。
CREATE TABLE IF NOT EXISTS push_notified (
  user_id     INTEGER NOT NULL,
  host_id     TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (user_id, host_id, approval_id)
);
CREATE INDEX IF NOT EXISTS push_notified_by_at ON push_notified(at);

-- 从手机解锁电脑时记下的 Windows 密码（docs/06"记住解锁密码"）。电脑用只有它自己解得开的钥匙（Windows DPAPI）加密，
-- 这里只有密文，服务器解不开；只有那台电脑自己的连接能读写。每台电脑一条，电脑退出登录、账号重置密码时删掉。
CREATE TABLE IF NOT EXISTS unlock_secrets (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id    TEXT NOT NULL,
  blob       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, host_id)
);
`;

class Store {
  /** @param {string} file 数据库文件路径，或 ':memory:' */
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);

    const p = (sql) => this.db.prepare(sql);
    this.q = {
      userByEmail: p('SELECT id, email, password_hash FROM users WHERE email = ?'),
      insertUser: p('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)'),
      setPassword: p('UPDATE users SET password_hash = ? WHERE id = ?'),

      putCode: p(`INSERT INTO email_codes (email, purpose, code_hash, expires_at, attempts) VALUES (?, ?, ?, ?, 0)
                  ON CONFLICT (email, purpose) DO UPDATE SET code_hash = excluded.code_hash,
                  expires_at = excluded.expires_at, attempts = 0`),
      getCode: p('SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ? AND purpose = ?'),
      bumpCode: p('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?'),
      deleteCode: p('DELETE FROM email_codes WHERE email = ? AND purpose = ?'),

      insertToken: p(`INSERT INTO tokens (token_hash, user_id, kind, device_id, device_name, created_at, last_used_at, expires_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      tokensForDevice: p('SELECT id FROM tokens WHERE user_id = ? AND kind = ? AND device_id = ?'),
      deleteTokensForDevice: p('DELETE FROM tokens WHERE user_id = ? AND kind = ? AND device_id = ?'),
      tokenByHash: p(`SELECT t.id, t.user_id, t.kind, t.device_id, t.device_name, t.expires_at, u.email
                      FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`),
      touchToken: p('UPDATE tokens SET last_used_at = ?, expires_at = ? WHERE id = ?'),
      deleteTokenById: p('DELETE FROM tokens WHERE id = ?'),
      tokensOfUser: p('SELECT id FROM tokens WHERE user_id = ?'),
      deleteTokensOfUser: p('DELETE FROM tokens WHERE user_id = ?'),
      hostDevices: p(`SELECT device_id, device_name FROM tokens
                      WHERE user_id = ? AND kind = 'host' AND expires_at > ? ORDER BY last_used_at DESC`),

      pushTokenOwner: p('SELECT user_id FROM push_tokens WHERE token = ?'),
      upsertPushToken: p(`INSERT INTO push_tokens (token, platform, user_id, auth_token_id, created_at, updated_at)
                          VALUES (?, ?, ?, ?, ?, ?)
                          ON CONFLICT (token) DO UPDATE SET platform = excluded.platform, user_id = excluded.user_id,
                          auth_token_id = excluded.auth_token_id, updated_at = excluded.updated_at`),
      trimPushTokens: p(`DELETE FROM push_tokens WHERE user_id = ? AND token NOT IN
                         (SELECT token FROM push_tokens WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?)`),
      deletePushTokenOfUser: p('DELETE FROM push_tokens WHERE token = ? AND user_id = ?'),
      deletePushTokenIfOwner: p('DELETE FROM push_tokens WHERE token = ? AND user_id = ? AND updated_at <= ?'),
      pushTokensOfUser: p('SELECT token FROM push_tokens WHERE user_id = ? AND platform = ? ORDER BY updated_at DESC'),

      getUnlockSecret: p('SELECT blob FROM unlock_secrets WHERE user_id = ? AND host_id = ?'),
      putUnlockSecret: p(`INSERT INTO unlock_secrets (user_id, host_id, blob, updated_at) VALUES (?, ?, ?, ?)
                          ON CONFLICT (user_id, host_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`),
      deleteUnlockSecret: p('DELETE FROM unlock_secrets WHERE user_id = ? AND host_id = ?'),
      deleteUnlockSecretsOfUser: p('DELETE FROM unlock_secrets WHERE user_id = ?'),
      markNotified: p('INSERT OR IGNORE INTO push_notified (user_id, host_id, approval_id, at) VALUES (?, ?, ?, ?)'),
      countNotified: p('SELECT COUNT(*) AS n FROM push_notified WHERE user_id = ?'),
      trimNotified: p(`DELETE FROM push_notified WHERE rowid IN
                       (SELECT rowid FROM push_notified WHERE user_id = ? ORDER BY at, rowid LIMIT ?)`),
      unmarkNotified: p('DELETE FROM push_notified WHERE user_id = ? AND host_id = ? AND approval_id = ?'),
      purgeNotified: p('DELETE FROM push_notified WHERE at <= ?'),

      purgeTokens: p('DELETE FROM tokens WHERE expires_at <= ?'),
      // 电脑的登录令牌都没了（过期、被顶掉以后又没再登录）：它记下的解锁密码也删掉
      purgeOrphanSecrets: p(`DELETE FROM unlock_secrets WHERE NOT EXISTS (SELECT 1 FROM tokens t
                             WHERE t.user_id = unlock_secrets.user_id AND t.kind = 'host' AND t.device_id = unlock_secrets.host_id)`),
      purgeCodes: p('DELETE FROM email_codes WHERE expires_at <= ?'),
    };
  }

  findUserByEmail(email) {
    return this.q.userByEmail.get(email) || null;
  }

  /** 新建用户，返回 id；邮箱已存在时返回 null */
  createUser(email, passwordHash, now) {
    try {
      return Number(this.q.insertUser.run(email, passwordHash, now).lastInsertRowid);
    } catch (err) {
      if (err && err.errcode === 2067) return null; // SQLITE_CONSTRAINT_UNIQUE
      throw err;
    }
  }

  setPassword(userId, passwordHash) {
    this.q.setPassword.run(passwordHash, userId);
  }

  putCode(email, purpose, codeHash, expiresAt) {
    this.q.putCode.run(email, purpose, codeHash, expiresAt);
  }

  getCode(email, purpose) {
    return this.q.getCode.get(email, purpose) || null;
  }

  bumpCodeAttempts(email, purpose) {
    this.q.bumpCode.run(email, purpose);
  }

  deleteCode(email, purpose) {
    this.q.deleteCode.run(email, purpose);
  }

  /**
   * 给一台设备发新令牌：同一账号、同一角色、同一设备的旧令牌一并作废。
   * @returns {{ id: number, revokedIds: number[] }}
   */
  issueToken({ tokenHash, userId, kind, deviceId, deviceName, now, expiresAt }) {
    this.db.exec('BEGIN');
    try {
      const revokedIds = this.q.tokensForDevice.all(userId, kind, deviceId).map((r) => Number(r.id));
      this.q.deleteTokensForDevice.run(userId, kind, deviceId);
      const id = Number(this.q.insertToken.run(tokenHash, userId, kind, deviceId, deviceName, now, now, expiresAt).lastInsertRowid);
      this.db.exec('COMMIT');
      return { id, revokedIds };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  findToken(tokenHash) {
    return this.q.tokenByHash.get(tokenHash) || null;
  }

  touchToken(id, now, expiresAt) {
    this.q.touchToken.run(now, expiresAt, id);
  }

  deleteToken(id) {
    this.q.deleteTokenById.run(id);
  }

  /** 删除一个用户的全部令牌，返回被删的令牌 id */
  deleteTokensOfUser(userId) {
    const ids = this.q.tokensOfUser.all(userId).map((r) => Number(r.id));
    this.q.deleteTokensOfUser.run(userId);
    return ids;
  }

  /** 这台电脑记下的解锁密码的密文，没有时为 null */
  getUnlockSecret(userId, hostId) {
    const row = this.q.getUnlockSecret.get(userId, hostId);
    return row ? String(row.blob) : null;
  }

  putUnlockSecret(userId, hostId, blob, now) {
    this.q.putUnlockSecret.run(userId, hostId, blob, now);
  }

  deleteUnlockSecret(userId, hostId) {
    this.q.deleteUnlockSecret.run(userId, hostId);
  }

  deleteUnlockSecretsOfUser(userId) {
    this.q.deleteUnlockSecretsOfUser.run(userId);
  }

  /** 账号下登录着的电脑（未过期的被控端令牌） */
  hostDevices(userId, now) {
    return this.q.hostDevices.all(userId, now).map((r) => ({ id: r.device_id, name: r.device_name }));
  }

  /**
   * 登记（或转移）一个推送令牌，账号下最多留 maxPerUser 个，多出的删最久没登记过的。
   * @returns {{ previousUserId: number|null }} 令牌原来属于哪个账号（新令牌为 null）
   */
  putPushToken({ token, platform, userId, authTokenId, now, maxPerUser }) {
    this.db.exec('BEGIN');
    try {
      const prev = this.q.pushTokenOwner.get(token);
      this.q.upsertPushToken.run(token, platform, userId, authTokenId, now, now);
      this.q.trimPushTokens.run(userId, userId, maxPerUser);
      this.db.exec('COMMIT');
      return { previousUserId: prev ? Number(prev.user_id) : null };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 删掉本账号的一个推送令牌；不是本账号的不动。返回是否删了 */
  deletePushTokenOfUser(token, userId) {
    return Number(this.q.deletePushTokenOfUser.run(token, userId).changes) > 0;
  }

  /**
   * 删推送服务说无效的令牌。只删发送时还属于这个账号、之后没重新登记过的
   * （发送要一会儿，这期间手机可能换了账号重新登记，那是新的登记，不该删）。
   */
  deletePushTokens(tokens, userId, sentAt) {
    let n = 0;
    for (const t of tokens) n += Number(this.q.deletePushTokenIfOwner.run(t, userId, sentAt).changes);
    return n;
  }

  pushTokens(userId, platform) {
    return this.q.pushTokensOfUser.all(userId, platform).map((r) => r.token);
  }

  /**
   * 记下这一批审批推送过了，返回第一次记下的编号。整批一个事务：一份列表最多 100 条，逐条提交太慢，
   * 中途出错也不会只记了一半。账号的记录超过 maxPerUser 条时删最旧的，表的大小有上限。
   * @returns {string[]}
   */
  markNotifiedBatch(userId, hostId, approvalIds, now, maxPerUser) {
    this.db.exec('BEGIN');
    try {
      const fresh = approvalIds.filter((id) => Number(this.q.markNotified.run(userId, hostId, id, now).changes) > 0);
      if (fresh.length) {
        const over = Number(this.q.countNotified.get(userId).n) - maxPerUser;
        if (over > 0) this.q.trimNotified.run(userId, over);
      }
      this.db.exec('COMMIT');
      return fresh;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 推送没发出去（网络、对方服务器出错、超过每小时上限）：撤掉记录，之后重推或等电脑下次发列表 */
  unmarkNotified(userId, hostId, approvalId) {
    this.q.unmarkNotified.run(userId, hostId, approvalId);
  }

  purgeNotified(before) {
    this.q.purgeNotified.run(before);
  }

  purgeExpired(now) {
    this.q.purgeTokens.run(now);
    this.q.purgeCodes.run(now);
    this.q.purgeOrphanSecrets.run();
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store };
