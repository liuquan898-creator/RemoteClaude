'use strict';
/**
 * 生成服务器用的生产配置，写到 deploy/prod/（不入库）：
 *   server.config.json   信令服务配置：发信（SMTP）、注册开关、TURN 共享密钥
 *   turnserver.conf      coturn 配置，共享密钥与上面一致
 *   host.config.json     电脑上被控端用的配置（连生产服务器，用账号登录）
 *   build.json           本机的打包配置：安装包传到哪里（已有就不动，见 docs/08 第 1 节）。服务器地址不写进安装包
 *
 * 发信配置从 deploy/prod/mail.json 读取，内容就是服务器配置里的 mail 一节，
 * 例如 { "mode": "tencent-ses", "secretId": "...", "secretKey": "...", "region": "ap-guangzhou", "templateId": 12345, "from": "RemoteClaude <a@b.com>" }，
 * 字段说明见 README 的"配置"一节。
 *
 * 用法：
 *   node scripts/init-prod-config.js --domain rc.example.com --public-ip 203.0.113.10 --private-ip 10.0.0.5
 *
 * 已存在的文件不覆盖，要重新生成先手动删掉。密钥只写进文件，不打印。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const domain = arg('domain');
const publicIp = arg('public-ip');
const privateIp = arg('private-ip') || publicIp;
if (!domain || !publicIp) {
  console.error('用法: node scripts/init-prod-config.js --domain <域名> --public-ip <公网IP> [--private-ip <网卡上的内网IP>]');
  process.exit(1);
}

const outDir = path.resolve(__dirname, '..', 'deploy', 'prod');
fs.mkdirSync(outDir, { recursive: true });

const files = {
  server: path.join(outDir, 'server.config.json'),
  turn: path.join(outDir, 'turnserver.conf'),
  host: path.join(outDir, 'host.config.json'),
};
const existing = Object.values(files).filter((f) => fs.existsSync(f));
if (existing.length) {
  console.error(`已存在，未做任何改动：\n  ${existing.join('\n  ')}\n要重新生成请先删除这些文件（服务器上的配置也要一起换）。`);
  process.exit(1);
}

let mail = null;
try {
  mail = JSON.parse(fs.readFileSync(path.join(outDir, 'mail.json'), 'utf8'));
  if (!mail || !mail.mode) mail = null;
} catch {
  mail = null;
}
if (!mail) console.warn('提示: 没有 deploy/prod/mail.json，发信先设为 log 模式（验证码只打印在服务器日志里），之后要改成 tencent-ses 或 smtp。');

const turnSecret = crypto.randomBytes(32).toString('base64url');
const turnPort = 3478;

const serverConfig = {
  port: 8787,
  bind: '0.0.0.0', // 在容器里监听；宿主机不映射端口，只有反向代理能访问
  trustProxy: true,
  registration: { open: true },
  mail: mail || { mode: 'log' },
  iceServers: [{ urls: [`stun:${domain}:${turnPort}`] }],
  turn: {
    urls: [`turn:${domain}:${turnPort}?transport=udp`, `turn:${domain}:${turnPort}?transport=tcp`],
    secret: turnSecret,
    ttlSeconds: 86400,
  },
};

const turnConf = `# coturn 生产配置，由 scripts/init-prod-config.js 生成。含共享密钥，不要入库。
listening-port=${turnPort}
listening-ip=${privateIp}
relay-ip=${privateIp}
external-ip=${publicIp}/${privateIp}
min-port=49160
max-port=49200

# 临时凭据：由信令服务器用同一个密钥签发，24 小时过期
use-auth-secret
static-auth-secret=${turnSecret}
realm=${domain}
fingerprint

# 只做中继，不需要 TLS/DTLS 和管理接口
no-tls
no-dtls
no-cli
no-software-attribute

# 禁止把中继当跳板访问服务器所在内网、本机和 docker 网络
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255

# 限制并发分配数，防止被滥用
user-quota=12
total-quota=60
stale-nonce=600

log-file=stdout
simple-log
`;

const hostConfig = {
  server: domain,
  targets: ['claude.exe'],
  maxBitrateKbps: 4000,
  maxFps: 30,
};

fs.writeFileSync(files.server, JSON.stringify(serverConfig, null, 2) + '\n', { mode: 0o600 });
fs.writeFileSync(files.turn, turnConf, { mode: 0o600 });
fs.writeFileSync(files.host, JSON.stringify(hostConfig, null, 2) + '\n', { mode: 0o600 });

console.log(`已生成：\n  ${Object.values(files).join('\n  ')}`);

// 打包配置：打安装包时把这个服务器地址写进 App 和被控端。里面可能已经写了别的项（上传到哪台服务器等），已有就不动
const buildFile = path.join(outDir, 'build.json');
if (fs.existsSync(buildFile)) {
  console.log(`打包配置已存在，没有改动（里面的 server 已不再使用，可以删掉）：\n  ${buildFile}`);
} else {
  const buildConfig = { releaseSsh: '', releaseDir: '/opt/remote-claude/releases' };
  fs.writeFileSync(buildFile, JSON.stringify(buildConfig, null, 2) + '\n');
  console.log(`已生成打包配置（要用 scripts/release.js 上传安装包，再填上 releaseSsh）：\n  ${buildFile}`);
}
