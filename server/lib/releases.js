'use strict';
/**
 * 安装包的发布与下载（说明见 docs/08-release-and-update.md）。
 *
 * 发布目录（生产是 /opt/remote-claude/releases，只读挂进容器）：
 *   android/latest.json            安卓 App 的最新版本说明，由 scripts/release.js 生成
 *   android/RemoteClaude-x.y.z.apk
 *   host/latest.yml                电脑被控端的最新版本说明（electron-builder 生成，electron-updater 读）
 *   host/RemoteClaude-Host-Setup-x.y.z.exe
 *
 * 接口（都要带登录令牌 Authorization: Bearer，手机和电脑的令牌都行，免得安装包被外人下载）：
 *   GET /api/update/android         安卓最新版本
 *   GET /download/<渠道>/<文件名>    下载发布目录里的文件；支持 Range（单段），断线后可以从断点接着下
 */
const fs = require('fs');
const path = require('path');

const CHANNELS = new Set(['android', 'host']);
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const TYPES = {
  '.apk': 'application/vnd.android.package-archive',
  '.exe': 'application/octet-stream',
  '.yml': 'text/yaml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.blockmap': 'application/octet-stream',
};

function bearer(req) {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/**
 * 解析 Range 请求头（只认单段的 bytes=a-b、bytes=a-、bytes=-n）。
 * 返回 null 表示没有或看不懂（照常回整个文件），'unsatisfiable' 表示超出文件（回 416），否则 { start, end }（含 end）。
 */
function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null;
  }
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  return { start, end };
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}

/**
 * @param {object} opts
 * @param {string} opts.dir 发布目录；不存在时接口回"还没有发布"
 * @param {{ verifyToken(token: string, role: string): object|null }} opts.auth
 */
function createReleases({ dir, auth, log = () => {} }) {
  function signedIn(req) {
    const t = bearer(req);
    return !!(t && (auth.verifyToken(t, 'viewer') || auth.verifyToken(t, 'host')));
  }

  function readManifest(channel) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, channel, 'latest.json'), 'utf8'));
      if (!m || !Number.isInteger(m.versionCode) || typeof m.file !== 'string' || !FILE_NAME.test(m.file)) return null;
      return m;
    } catch {
      return null;
    }
  }

  /** GET /api/update/android */
  function handleUpdate(req, res, channel) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'bad-request', message: '只支持 GET' });
    if (!signedIn(req)) return sendJson(res, 401, { error: 'bad-token', message: '请先登录' });
    if (channel !== 'android') return sendJson(res, 404, { error: 'not-found', message: '接口不存在' });
    const m = readManifest(channel);
    if (!m) return sendJson(res, 404, { error: 'no-release', message: '还没有发布过安装包' });
    sendJson(res, 200, {
      package: String(m.package || ''),
      versionCode: m.versionCode,
      versionName: String(m.versionName || ''),
      notes: String(m.notes || ''),
      size: Number(m.size) || 0,
      sha256: String(m.sha256 || ''),
      releasedAt: String(m.releasedAt || ''),
      url: `/download/${channel}/${m.file}`,
    });
  }

  /** GET/HEAD /download/<渠道>/<文件名> */
  function handleDownload(req, res, rest) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
    if (!signedIn(req)) return sendJson(res, 401, { error: 'bad-token', message: '请先登录' });
    const [channel, name, ...more] = rest.split('/');
    if (more.length || !CHANNELS.has(channel) || !FILE_NAME.test(name || '')) return res.writeHead(404).end();
    const file = path.join(dir, channel, name);
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return res.writeHead(404).end();
      const headers = {
        'Content-Type': TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      // 手机从内地连香港常掉线，大文件支持从断点接着下（docs/08）
      const range = parseRange(req.headers.range, st.size);
      if (range === 'unsatisfiable') {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      if (range) {
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`, 'Content-Length': range.end - range.start + 1 });
      } else {
        res.writeHead(200, { ...headers, 'Content-Length': st.size });
      }
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file, range || {});
      stream.on('error', (e) => {
        log(`[download] ${channel}/${name} 读取出错: ${e.message}`);
        res.destroy();
      });
      stream.pipe(res);
    });
  }

  return { handleUpdate, handleDownload };
}

module.exports = { createReleases, parseRange };
