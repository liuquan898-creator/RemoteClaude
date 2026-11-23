'use strict';
/**
 * 读取并校验信令服务器配置。字段说明见 README 的"配置"一节和 server/config.example.json。
 */
const fs = require('fs');
const path = require('path');

/** 限流参数的默认值，测试里可以覆盖 */
const DEFAULT_LIMITS = {
  codeCooldownSec: 60, // 同一邮箱两次发验证码的最短间隔
  codePerEmailPerDay: 10,
  codePerIpPerHour: 10,
  loginFailPerIp: 10, // 15 分钟窗口内
  loginFailPerEmail: 10,
  loginFailWindowMin: 15,
  wsAuthFailPerIp: 20, // 15 分钟窗口内信令鉴权失败次数
};

function loadConfig(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`读取配置失败: ${file}\n${err.message}\n先在项目根目录运行 "node scripts/init-config.js" 生成配置。`);
  }
  return normalizeConfig(raw, path.dirname(path.resolve(file)));
}

/**
 * @param {object} raw 配置文件内容
 * @param {string} baseDir 相对路径的基准目录（配置文件所在目录）
 */
function normalizeConfig(raw, baseDir) {
  if (raw.viewerPassword || raw.hostToken) {
    // 协议 1 的字段：现在改为账号登录，这两项不再使用
    console.warn('提示: 配置里的 viewerPassword、hostToken 已不再使用（改为账号登录），可以删掉。');
  }

  const mail = raw.mail && typeof raw.mail === 'object' ? raw.mail : { mode: 'log' };
  const dataDir =
    process.env.RC_DATA_DIR ||
    (raw.dataDir === ':memory:' ? ':memory:' : raw.dataDir ? path.resolve(baseDir, raw.dataDir) : path.join(baseDir, 'data'));

  const cfg = {
    port: Number(process.env.PORT ?? raw.port ?? 8787),
    bind: raw.bind || '127.0.0.1',
    trustProxy: !!raw.trustProxy,
    dataDir,
    webDir: raw.webDir ? path.resolve(baseDir, raw.webDir) : path.resolve(__dirname, '..', '..', 'web'),
    // 安装包发布目录（docs/08）；容器里由环境变量指到只读挂载的目录
    releasesDir:
      process.env.RC_RELEASES_DIR || (raw.releasesDir ? path.resolve(baseDir, raw.releasesDir) : path.join(baseDir, 'releases')),
    registrationOpen: !(raw.registration && raw.registration.open === false),
    mail: {
      mode: String(mail.mode || 'log'),
      from: mail.from ? String(mail.from) : '',
      // smtp
      host: mail.host ? String(mail.host) : '',
      port: Number(mail.port || 465),
      secure: mail.secure !== false,
      user: mail.user ? String(mail.user) : '',
      pass: mail.pass ? String(mail.pass) : '',
      // tencent-ses
      secretId: mail.secretId ? String(mail.secretId) : '',
      secretKey: mail.secretKey ? String(mail.secretKey) : '',
      region: mail.region ? String(mail.region) : 'ap-guangzhou',
      templateId: mail.templateId ? Number(mail.templateId) : 0,
    },
    iceServers: Array.isArray(raw.iceServers) ? raw.iceServers : [],
    turn: raw.turn && typeof raw.turn === 'object' ? raw.turn : null,
    limits: { ...DEFAULT_LIMITS, ...(raw.limits && typeof raw.limits === 'object' ? raw.limits : {}) },
  };

  const REQUIRED = {
    'tencent-ses': ['secretId', 'secretKey', 'from', 'templateId'],
    smtp: ['host', 'user', 'pass', 'from'],
    log: [],
    memory: [],
  };
  if (!REQUIRED[cfg.mail.mode]) {
    throw new Error(`mail.mode 只能是 tencent-ses、smtp、log 或 memory，当前是 ${cfg.mail.mode}`);
  }
  const missing = REQUIRED[cfg.mail.mode].filter((k) => !cfg.mail[k]);
  if (missing.length) throw new Error(`mail.mode 为 ${cfg.mail.mode} 时要填 ${missing.join('、')}`);
  return cfg;
}

module.exports = { loadConfig, normalizeConfig, DEFAULT_LIMITS };
