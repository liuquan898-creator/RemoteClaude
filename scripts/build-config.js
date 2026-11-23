'use strict';
/**
 * 本机的打包配置：自己的服务器地址、安装包传到哪里。这些因人而异，不入库。
 *
 * 读 deploy/prod/build.json（deploy/prod/ 整个目录不入库；环境变量 RC_BUILD_CONFIG 可以指到别的文件），
 * 样例见 deploy/build.example.json，各项说明见 docs/08-release-and-update.md 第 1 节：
 *
 *   server      自己的信令服务器，写域名（rc.example.com）或完整地址（wss://rc.example.com/ws）。
 *               打包时写进 App 和被控端，装好就连它；不写的话装好后要自己填服务器地址
 *   hostAppId   被控端安装程序的应用标识，不写用 com.remoteclaude.host。定了就别再改：
 *               改了以后新安装程序认不出旧版本，电脑上会装出两份
 *   releaseSsh  scripts/release.js 把安装包传到哪台服务器（ssh 能直接连上的名字，比如 ~/.ssh/config 里的别名）
 *   releaseDir  服务器上的发布目录，不写用 /opt/remote-claude/releases
 *   env         打包时额外设的环境变量，比如 Electron 的下载镜像
 *
 * 没有这个文件也能打包。安卓的构建脚本（android/app/build.gradle.kts）读的是同一个文件。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(ROOT, 'deploy', 'prod', 'build.json');
const DEFAULT_HOST_APP_ID = 'com.remoteclaude.host';
const DEFAULT_RELEASE_DIR = '/opt/remote-claude/releases';

/**
 * 把填的服务器地址整理成信令 WebSocket 地址，规则和安卓端的 ServerAddress.kt 一样：
 *   rc.example.com             -> wss://rc.example.com/ws
 *   https://rc.example.com     -> wss://rc.example.com/ws
 *   wss://rc.example.com/rc/ws -> wss://rc.example.com/rc/ws
 * 没填返回空字符串，填错了抛异常
 */
function wsUrlOf(server) {
  const raw = String(server || '').trim();
  if (!raw) return '';
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
  const scheme = m ? m[1].toLowerCase() : 'wss';
  const rest = m ? m[2] : raw;
  const wsScheme = { wss: 'wss', https: 'wss', ws: 'ws', http: 'ws' }[scheme];
  if (!wsScheme) throw new Error(`server 的地址格式不支持: ${scheme}://`);
  let u;
  try {
    u = new URL(`${wsScheme}://${rest}`);
  } catch {
    throw new Error(`server 的地址格式不正确: ${raw}`);
  }
  if (!u.hostname) throw new Error(`server 的地址格式不正确: ${raw}`);
  const pathname = !u.pathname || u.pathname === '/' ? '/ws' : u.pathname;
  return `${wsScheme}://${u.host}${pathname}`;
}

/** wss://rc.example.com/ws -> https://rc.example.com（和 host/account.js 的 httpBaseOf 一样） */
function httpBaseOf(wsUrl) {
  if (!wsUrl) return '';
  const u = new URL(wsUrl);
  const protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${u.host}${u.pathname.replace(/\/ws\/?$/, '')}`;
}

/**
 * @param {string} [file] 不传就用 RC_BUILD_CONFIG 或 deploy/prod/build.json
 * @returns {{ file: string, exists: boolean, server: string, serverWsUrl: string, serverHttpBase: string,
 *             hostAppId: string, releaseSsh: string, releaseDir: string, env: Record<string, string> }}
 */
function load(file = process.env.RC_BUILD_CONFIG || DEFAULT_FILE) {
  const full = path.resolve(file);
  let raw = {};
  let exists = false;
  try {
    raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    exists = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`读取打包配置失败: ${full}\n${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`打包配置要是一个 JSON 对象: ${full}`);

  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  let serverWsUrl;
  try {
    serverWsUrl = wsUrlOf(raw.server);
  } catch (err) {
    throw new Error(`${full}: ${err.message}`);
  }
  const env = {};
  if (raw.env && typeof raw.env === 'object') {
    for (const [k, v] of Object.entries(raw.env)) if (typeof v === 'string' && v) env[k] = v;
  }
  return {
    file: full,
    exists,
    server: str(raw.server),
    serverWsUrl,
    serverHttpBase: httpBaseOf(serverWsUrl),
    hostAppId: str(raw.hostAppId) || DEFAULT_HOST_APP_ID,
    releaseSsh: str(raw.releaseSsh),
    releaseDir: str(raw.releaseDir) || DEFAULT_RELEASE_DIR,
    env,
  };
}

module.exports = { load, wsUrlOf, httpBaseOf, DEFAULT_FILE, DEFAULT_HOST_APP_ID, DEFAULT_RELEASE_DIR };
