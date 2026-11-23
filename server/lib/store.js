'use strict';
/**
 * 账号数据：用户、登录令牌、邮箱验证码。用 Node 自带的 SQLite（node:sqlite），不需要编译原生模块。
 * 时间一律是毫秒时间戳。令牌和验证码只存散列值。
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

      purgeTokens: p('DELETE FROM tokens WHERE expires_at <= ?'),
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

  /** 账号下登录着的电脑（未过期的被控端令牌） */
  hostDevices(userId, now) {
    return this.q.hostDevices.all(userId, now).map((r) => ({ id: r.device_id, name: r.device_name }));
  }

  purgeExpired(now) {
    this.q.purgeTokens.run(now);
    this.q.purgeCodes.run(now);
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store };
