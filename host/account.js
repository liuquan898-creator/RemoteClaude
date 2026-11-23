'use strict';
/**
 * 被控端的账号：登录、退出、保存登录状态。只在主进程使用（app ready 之后）。
 *
 *   device.json   本机设备编号（第一次运行时随机生成，不是机密），也就是这台电脑在账号里的 hostId
 *   account.json  登录的邮箱和令牌；令牌用 Windows 的 DPAPI（Electron safeStorage）加密，
 *                 只有当前 Windows 用户能解开，拷到别的电脑或别的用户下无效
 *
 * 接口约定见 docs/03-protocol.md 第 1 节。
 */
const { app, safeStorage, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** wss://rc.example.com/ws -> https://rc.example.com */
function httpBaseOf(wsUrl) {
  const u = new URL(wsUrl);
  const protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${u.host}${u.pathname.replace(/\/ws\/?$/, '')}`;
}

class Account {
  constructor(serverWsUrl) {
    this.httpBase = httpBaseOf(serverWsUrl);
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    this.deviceFile = path.join(dir, 'device.json');
    this.authFile = path.join(dir, 'account.json');
    this.deviceId = this.loadDeviceId();
    // RC_HOST_DEVICE_NAME 仅供测试：在同一台电脑上模拟多台电脑时区分名字
    this.deviceName = (process.env.RC_HOST_DEVICE_NAME || os.hostname()).slice(0, 64) || '电脑';
    this.state = this.loadAuth(); // { email, token } | null
  }

  loadDeviceId() {
    try {
      const { deviceId } = JSON.parse(fs.readFileSync(this.deviceFile, 'utf8'));
      if (/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return deviceId;
    } catch {
      /* 第一次运行 */
    }
    const deviceId = crypto.randomBytes(12).toString('base64url');
    fs.writeFileSync(this.deviceFile, JSON.stringify({ deviceId }) + '\n');
    return deviceId;
  }

  loadAuth() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
      // 换了服务器地址，旧令牌就没用了
      if (saved.server !== this.httpBase) return null;
      return { email: saved.email, token: safeStorage.decryptString(Buffer.from(saved.token, 'base64')) };
    } catch {
      return null;
    }
  }

  saveAuth(email, token) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统不支持加密保存登录状态');
    const encrypted = safeStorage.encryptString(token).toString('base64');
    fs.writeFileSync(this.authFile, JSON.stringify({ server: this.httpBase, email, token: encrypted }) + '\n');
    this.state = { email, token };
  }

  /** 只清本地登录状态（令牌已被服务器作废时用） */
  clear() {
    try {
      fs.unlinkSync(this.authFile);
    } catch {
      /* 本来就没有 */
    }
    this.state = null;
  }

  async login(email, password) {
    let res;
    try {
      res = await net.fetch(`${this.httpBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          clientType: 'host',
          deviceId: this.deviceId,
          deviceName: this.deviceName,
        }),
      });
    } catch (err) {
      return { error: `连不上服务器：${err.message}` };
    }
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* 非 JSON 响应 */
    }
    if (!res.ok || !body.token) return { error: body.message || `登录失败（HTTP ${res.status}）` };
    try {
      this.saveAuth(body.email, body.token);
    } catch (err) {
      return { error: err.message };
    }
    return { email: body.email };
  }

  /** 退出登录：先清本地，再通知服务器作废令牌（连不上服务器也不影响本地退出） */
  async logout() {
    const s = this.state;
    this.clear();
    if (!s) return;
    try {
      await net.fetch(`${this.httpBase}/api/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.token}` },
      });
    } catch {
      /* 令牌会在服务器上自然过期 */
    }
  }
}

module.exports = { Account, httpBaseOf };
