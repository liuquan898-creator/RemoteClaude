'use strict';
/**
 * HTTP 部分：账号接口（/api/...）、安装包的版本查询和下载、健康检查、网页控制端的静态文件。
 */
const fs = require('fs');
const path = require('path');
const { AuthError } = require('./auth');

const BODY_LIMIT = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const PAGE_HEADERS = {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; " +
    "style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new AuthError(413, 'bad-request', '请求太大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const obj = JSON.parse(text);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
        resolve(obj);
      } catch {
        reject(new AuthError(400, 'bad-request', '请求格式不对'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/**
 * @param {object} opts
 * @param {import('./auth').AuthService} opts.auth
 */
function createHandler({ auth, webDir, trustProxy, log, releases }) {
  const routes = {
    '/api/auth/send-code': (body, ip) => auth.sendCode(body, ip),
    '/api/auth/register': (body, ip) => auth.register(body, ip),
    '/api/auth/login': (body, ip) => auth.login(body, ip),
    '/api/auth/reset-password': (body, ip) => auth.resetPassword(body, ip),
    '/api/auth/logout': (body, ip, req) => auth.logout(bearer(req)),
  };

  async function handleApi(req, res, pathname) {
    const route = routes[pathname];
    if (!route) return sendJson(res, 404, { error: 'not-found', message: '接口不存在' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'bad-request', message: '只支持 POST' });
    try {
      const body = await readJson(req);
      const result = await route(body, clientIp(req, trustProxy), req);
      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof AuthError) {
        sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });
      } else {
        log(`[api] ${pathname} 出错: ${err && err.stack}`);
        sendJson(res, 500, { error: 'internal', message: '服务器内部错误' });
      }
    }
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    const file = path.resolve(webDir, '.' + pathname);
    // 防目录穿越：解析后的路径必须仍在网页目录内
    if (file !== webDir && !file.startsWith(webDir + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', ...PAGE_HEADERS });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  return (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (releases && pathname.startsWith('/api/update/')) {
      releases.handleUpdate(req, res, pathname.slice('/api/update/'.length));
      return;
    }
    if (releases && pathname.startsWith('/download/')) {
      releases.handleDownload(req, res, pathname.slice('/download/'.length));
      return;
    }
    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname);
      return;
    }
    serveStatic(req, res, pathname);
  };
}

module.exports = { createHandler, clientIp };
