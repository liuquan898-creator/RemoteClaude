'use strict';
/**
 * 把各部分组装成一个 HTTP + WebSocket 服务。server.js 和自动化测试都从这里创建。
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Store } = require('./store');
const { createMailer } = require('./mailer');
const { AuthService } = require('./auth');
const { Hub } = require('./hub');
const { createHandler, clientIp } = require('./http');
const { createReleases } = require('./releases');

/**
 * @param {ReturnType<import('./config').normalizeConfig>} cfg
 * @param {{ log?: (...args:any[]) => void }} [opts]
 */
function createApp(cfg, opts = {}) {
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const store = new Store(cfg.dataDir === ':memory:' ? ':memory:' : path.join(cfg.dataDir, 'remote-claude.db'));
  const mailer = createMailer(cfg.mail, log);

  /** TURN 临时凭据按 coturn 的 use-auth-secret 规则签发 */
  function iceServers() {
    const list = cfg.iceServers.slice();
    const t = cfg.turn;
    if (t && t.secret && Array.isArray(t.urls) && t.urls.length) {
      const username = String(Math.floor(Date.now() / 1000) + Number(t.ttlSeconds || 86400));
      const credential = crypto.createHmac('sha1', t.secret).update(username).digest('base64');
      list.push({ urls: t.urls, username, credential });
    }
    return list;
  }

  let hub = null;
  const auth = new AuthService({
    store,
    mailer,
    registrationOpen: cfg.registrationOpen,
    limits: cfg.limits,
    log,
    onRevoke: (ids, userId) => hub && hub.revoke(ids, userId),
  });
  hub = new Hub({ auth, iceServers, limits: cfg.limits, log });

  const releases = createReleases({ dir: cfg.releasesDir, auth, log });
  const server = http.createServer(createHandler({ auth, webDir: cfg.webDir, trustProxy: cfg.trustProxy, log, releases }));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://x').pathname;
    } catch {
      /* ignore */
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, clientIp(req, cfg.trustProxy)));
  });

  const heartbeat = setInterval(() => hub.heartbeat(wss.clients), 30 * 1000);
  const cleanup = setInterval(() => auth.cleanup(), 3600 * 1000);
  heartbeat.unref();
  cleanup.unref();

  return {
    server,
    auth,
    hub,
    store,
    mailer,
    listen(port, host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      clearInterval(heartbeat);
      clearInterval(cleanup);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => {
        server.close(() => {
          store.close();
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

module.exports = { createApp };
