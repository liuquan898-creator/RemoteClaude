'use strict';
/**
 * 生成本机测试用的配置（已存在则不覆盖）：
 *   server/config.json  信令服务器：端口、发信模式（log：验证码只打印在终端里，不真的发邮件）
 *   host/config.json    被控端：服务器地址、允许远控的进程
 *
 * 账号在网页控制端注册，被控端和控制端都用这个账号登录。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const serverCfg = path.join(root, 'server', 'config.json');
const hostCfg = path.join(root, 'host', 'config.json');

function writeIfMissing(file, obj) {
  if (fs.existsSync(file)) {
    console.log(`已存在，跳过: ${file}`);
    return;
  }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  console.log(`已生成: ${file}`);
}

writeIfMissing(serverCfg, {
  port: 8787,
  bind: '127.0.0.1',
  trustProxy: false,
  registration: { open: true },
  mail: { mode: 'log' },
  iceServers: [],
  turn: { urls: [], secret: '', ttlSeconds: 86400 },
});

writeIfMissing(hostCfg, {
  server: 'ws://127.0.0.1:8787/ws',
  targets: ['claude.exe'],
  maxBitrateKbps: 4000,
  maxFps: 30,
});

console.log('启动服务器后，打开 http://127.0.0.1:8787 注册账号；注册验证码会打印在服务器的终端里。');
