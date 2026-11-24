'use strict';
/** 测试辅助：起一个用内存数据库、内存发件箱的服务器实例，以及 HTTP / WebSocket 小工具 */
const WebSocket = require('ws');
const { normalizeConfig } = require('../lib/config');
const { createApp } = require('../lib/app');

/**
 * @param {object} [overrides] 配置项
 * @param {{ log?: Function, now?: () => number, fetch?: typeof fetch }} [appOpts] 交给 createApp
 */
async function startServer(overrides = {}, appOpts = {}) {
  const { limits, ...rest } = overrides;
  const cfg = normalizeConfig(
    {
      port: 0,
      bind: '127.0.0.1',
      trustProxy: true, // 用 X-Forwarded-For 模拟不同来源 IP
      dataDir: ':memory:',
      mail: { mode: 'memory' },
      limits: { codePerIpPerHour: 1000, ...limits },
      ...rest,
    },
    __dirname
  );
  const app = createApp(cfg, { log: () => {}, ...appOpts });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  async function post(path, body, { ip = '203.0.113.1', token } = {}) {
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  function lastCode(email) {
    const m = [...app.mailer.outbox].reverse().find((x) => x.to === email);
    return m ? /(\d{6})/.exec(m.text)[1] : null;
  }

  /** 发验证码并注册，返回控制端令牌 */
  async function register(email, password = 'password-123', device = {}) {
    const sent = await post('/api/auth/send-code', { email, purpose: 'register' });
    if (sent.status !== 200) throw new Error(`发验证码失败: ${JSON.stringify(sent.body)}`);
    const res = await post('/api/auth/register', {
      email,
      code: lastCode(email),
      password,
      clientType: 'viewer',
      deviceId: device.deviceId || 'phone-1',
      deviceName: device.deviceName || '测试手机',
    });
    if (res.status !== 200) throw new Error(`注册失败: ${JSON.stringify(res.body)}`);
    return res.body.token;
  }

  async function login(email, password, clientType, deviceId, deviceName) {
    return post('/api/auth/login', { email, password, clientType, deviceId, deviceName });
  }

  return { app, base, wsUrl: `ws://127.0.0.1:${port}/ws`, post, lastCode, register, login, close: () => app.close() };
}

/**
 * 连上信令并发送鉴权消息。返回的 ws 带两个工具：
 *   ws.next(条件, 超时)  等下一条满足条件的消息（条件可以是消息类型字符串）
 *   ws.closed           连接关闭时 resolve 关闭码
 */
function connect(wsUrl, authMsg) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const inbox = [];
    const waiters = [];
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
      else inbox.push(m);
    });
    ws.next = (cond, ms = 2000) => {
      const pred = typeof cond === 'string' ? (m) => m.type === cond : cond;
      const i = inbox.findIndex(pred);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((res, rej) => {
        const w = { pred, resolve: res };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) {
            waiters.splice(k, 1);
            rej(new Error(`等待消息超时: ${cond}`));
          }
        }, ms);
      });
    };
    /** 断言一段时间内没有收到满足条件的消息 */
    ws.none = async (cond, ms = 300) => {
      try {
        const m = await ws.next(cond, ms);
        throw new Error(`不应收到消息: ${JSON.stringify(m)}`);
      } catch (err) {
        if (!String(err.message).startsWith('等待消息超时')) throw err;
      }
    };
    ws.closed = new Promise((res) => ws.on('close', (code) => res(code)));
    ws.on('open', () => {
      ws.send(JSON.stringify(authMsg));
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

const auth = (role, token, extra = {}) => ({ type: 'auth', role, token, proto: 2, client: 'test', ...extra });

module.exports = { startServer, connect, auth };
