'use strict';
/**
 * RemoteClaude 信令服务器
 *
 *   1. 账号：邮箱注册、登录、找回密码（/api/auth/...）
 *   2. 信令：按账号把电脑上的被控端和控制端配对，转发 WebRTC 协商和"列窗口 / 选窗口"消息（/ws）
 *   3. 托管网页控制端（../web）
 *
 * 视频画面和鼠标键盘事件走 WebRTC，不经过本进程；双方无法直连时由 coturn 中继，
 * 本进程只负责签发 TURN 临时凭据。协议见 docs/03-protocol.md。
 */
const path = require('path');
const { loadConfig } = require('./lib/config');
const { createApp } = require('./lib/app');

const log = (...a) => console.log(new Date().toISOString(), ...a);

let cfg;
try {
  cfg = loadConfig(process.env.RC_CONFIG || path.join(__dirname, 'config.json'));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const app = createApp(cfg, { log });

app.listen(cfg.port, cfg.bind).then(() => {
  log(`RemoteClaude 信令服务器已启动: http://${cfg.bind}:${cfg.port}  (网页目录 ${cfg.webDir}，数据目录 ${cfg.dataDir})`);
  if (cfg.mail.mode === 'log') log('提示: 发信模式是 log，验证码只打印在这里，不会真的发邮件。生产环境要配置 mail.mode = smtp。');
  if (cfg.mail.mode === 'smtp' || cfg.mail.mode === 'tencent-ses') {
    const target = cfg.mail.mode === 'smtp' ? `发信服务器 ${cfg.mail.host}:${cfg.mail.port}` : `腾讯云邮件推送（模板 ${cfg.mail.templateId}）`;
    app.mailer.verify().then(
      () => log(`${target} 检查通过，发件人 ${cfg.mail.from}`),
      (err) => log(`警告: ${target} 检查失败：${err.message}`)
    );
  }
  if (!cfg.registrationOpen) log('提示: 已关闭注册，只有现有账号能登录。');
  const hw = cfg.push.huawei;
  if (app.push.enabled) {
    log(`华为推送已启用：类别 ${hw.category}${hw.testMessage ? '，测试消息（每个项目每天最多 1000 条）' : ''}`);
  } else if (!hw) {
    log('提示: 未配置华为推送，鸿蒙 App 没开着时收不到审批通知。');
  }
  if (!cfg.turn || !cfg.turn.secret) log('提示: 未配置 TURN，只有双方能直连时才看得到画面（本机/局域网测试不受影响）。');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('正在停止…');
    app.close().then(() => process.exit(0));
  });
}
