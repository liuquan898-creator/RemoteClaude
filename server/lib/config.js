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
    push: { huawei: normalizeHuaweiPush(raw.push, baseDir) },
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

/**
 * 华为推送（docs/09 第 10 节）。可选：没有 push.huawei、或 enabled 为 false 时不推送。
 * 环境变量 RC_PUSH_HUAWEI_KEY_FILE、RC_PUSH_HUAWEI_PROJECT_ID 优先于配置文件（容器里把密钥文件挂进去用）。
 * 密钥文件在启动时（app.js）读，读不出来服务器起不来。
 * @returns {null | { projectId: string, serviceAccountFile: string, category: string, testMessage: boolean,
 *                    showDetail: boolean, ttl: number, maxPerHour: number, alertDelaySec: number, apiBase: string, timeoutMs: number }}
 */
function normalizeHuaweiPush(push, baseDir) {
  const hw = push && typeof push === 'object' && push.huawei && typeof push.huawei === 'object' ? push.huawei : null;
  const envFile = process.env.RC_PUSH_HUAWEI_KEY_FILE || '';
  const envProject = process.env.RC_PUSH_HUAWEI_PROJECT_ID || '';
  if (hw && hw.enabled === false) return null;
  if (!hw && !envFile) return null;
  const src = hw || {};
  const serviceAccountFile = envFile
    ? path.resolve(envFile)
    : src.serviceAccountFile
      ? path.resolve(baseDir, String(src.serviceAccountFile))
      : '';
  if (!serviceAccountFile) throw new Error('push.huawei 要填 serviceAccountFile（AppGallery Connect 下载的服务账号密钥文件路径），或设环境变量 RC_PUSH_HUAWEI_KEY_FILE');
  const category = String(src.category || 'MARKETING').toUpperCase();
  if (!/^[A-Z_]+$/.test(category)) throw new Error(`push.huawei.category 不对: ${category}`);
  const ttl = Number(src.ttl ?? 86400);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 1296000) throw new Error('push.huawei.ttl 是 1～1296000 的整数（秒）');
  // 审批出现多久还没在电脑上处理才推送（docs/09 第 10 节），0 是一出现就推
  const alertDelaySec = Number(src.alertDelaySec ?? 60);
  // 上限 10 分钟：比"电脑最近的列表"留在内存里的时间（push.js 的 LIST_KEEP_MS，1 小时）短得多，到点时列表一定还在
  if (!Number.isInteger(alertDelaySec) || alertDelaySec < 0 || alertDelaySec > 600) throw new Error('push.huawei.alertDelaySec 是 0～600 的整数（秒）');
  return {
    // 不填时用密钥文件里的 project_id
    projectId: envProject || (src.projectId ? String(src.projectId) : ''),
    serviceAccountFile,
    category,
    testMessage: src.testMessage !== false,
    // 默认 false：通知只说有一条审批。true 时带工具名、会话名和命令、问题原文，会经过华为服务器、显示在锁屏上
    showDetail: src.showDetail === true,
    ttl,
    maxPerHour: Number(src.maxPerHour) > 0 ? Number(src.maxPerHour) : 60,
    alertDelaySec,
    apiBase: src.apiBase ? String(src.apiBase) : 'https://push-api.cloud.huawei.com',
    timeoutMs: Number(src.timeoutMs) > 0 ? Number(src.timeoutMs) : 10000,
  };
}

module.exports = { loadConfig, normalizeConfig, DEFAULT_LIMITS };
