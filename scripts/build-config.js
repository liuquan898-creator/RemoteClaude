'use strict';
/**
 * 本机的打包配置：安装包传到哪里、被控端的应用标识。这些因人而异，不入库。
 *
 * 读 deploy/prod/build.json（deploy/prod/ 整个目录不入库；环境变量 RC_BUILD_CONFIG 可以指到别的文件），
 * 样例见 deploy/build.example.json，各项说明见 docs/08-release-and-update.md 第 1 节：
 *
 *   hostAppId   被控端安装程序的应用标识，不写用 com.remoteclaude.host。定了就别再改：
 *               改了以后新安装程序认不出旧版本，电脑上会装出两份
 *   releaseSsh  scripts/release.js 把安装包传到哪台服务器（ssh 能直接连上的名字，比如 ~/.ssh/config 里的别名）
 *   releaseDir  服务器上的发布目录，不写用 /opt/remote-claude/releases
 *   env         打包时额外设的环境变量，比如 Electron 的下载镜像
 *
 * 服务器地址不再写进任何安装包（App 和被控端装好后都在登录页自己填）。以前的 server 项不再使用，
 * 读到了只记在 legacyServer 里，好让 release.js 提示可以删掉。
 *
 * 没有这个文件也能打包。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(ROOT, 'deploy', 'prod', 'build.json');
const DEFAULT_HOST_APP_ID = 'com.remoteclaude.host';
const DEFAULT_RELEASE_DIR = '/opt/remote-claude/releases';

/**
 * @param {string} [file] 不传就用 RC_BUILD_CONFIG 或 deploy/prod/build.json
 * @returns {{ file: string, exists: boolean, legacyServer: string,
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
  const env = {};
  if (raw.env && typeof raw.env === 'object') {
    for (const [k, v] of Object.entries(raw.env)) if (typeof v === 'string' && v) env[k] = v;
  }
  return {
    file: full,
    exists,
    legacyServer: str(raw.server),
    hostAppId: str(raw.hostAppId) || DEFAULT_HOST_APP_ID,
    releaseSsh: str(raw.releaseSsh),
    releaseDir: str(raw.releaseDir) || DEFAULT_RELEASE_DIR,
    env,
  };
}

module.exports = { load, DEFAULT_FILE, DEFAULT_HOST_APP_ID, DEFAULT_RELEASE_DIR };
