'use strict';
/**
 * 发信。四种模式：
 *   tencent-ses  腾讯云邮件推送的 API，用审核过的模板发（生产环境；模板只有一个变量 code）
 *   smtp         任意邮箱的 SMTP
 *   log          只把邮件内容打印到日志（本机开发用，验证码从终端里看）
 *   memory       放进内存里的发件箱（自动化测试用）
 *
 * send() 收到 { to, subject, text, code }：模板模式只用 subject 和 code，其余模式用 subject 和 text。
 */

function createMailer(mail, log) {
  if (mail.mode === 'tencent-ses') {
    const tencentcloud = require('tencentcloud-sdk-nodejs-ses');
    const client = new tencentcloud.ses.v20201002.Client({
      credential: { secretId: mail.secretId, secretKey: mail.secretKey },
      region: mail.region,
      profile: { httpProfile: { endpoint: 'ses.tencentcloudapi.com', reqTimeout: 20 } },
    });
    return {
      mode: 'tencent-ses',
      async send({ to, subject, code }) {
        await client.SendEmail({
          FromEmailAddress: mail.from,
          Destination: [to],
          Subject: subject,
          Template: { TemplateID: Number(mail.templateId), TemplateData: JSON.stringify({ code }) },
          TriggerType: 1, // 触发类邮件（验证码），即时发送
          Unsubscribe: '0',
        });
      },
      /** 启动时检查密钥和模板：模板状态 0 表示审核通过 */
      async verify() {
        const t = await client.GetEmailTemplate({ TemplateID: Number(mail.templateId) });
        if (t.TemplateStatus !== 0) throw new Error(`模板 ${mail.templateId} 还没审核通过（状态 ${t.TemplateStatus}）`);
      },
    };
  }

  if (mail.mode === 'smtp') {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: { user: mail.user, pass: mail.pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
    return {
      mode: 'smtp',
      async send({ to, subject, text }) {
        await transport.sendMail({ from: mail.from, to, subject, text });
      },
      verify: () => transport.verify(),
    };
  }

  if (mail.mode === 'memory') {
    const outbox = [];
    return {
      mode: 'memory',
      outbox,
      async send(message) {
        outbox.push(message);
      },
    };
  }

  return {
    mode: 'log',
    async send({ to, subject, text }) {
      log(`[邮件·只打印不发送] 收件人 ${to}，主题「${subject}」\n${text}`);
    },
  };
}

function codeEmail(purpose, code) {
  if (purpose === 'reset') {
    return {
      subject: 'RemoteClaude 重置密码验证码',
      text:
        `你的验证码是 ${code}，10 分钟内有效。\n\n` +
        '你正在重置 RemoteClaude 账号的密码。如果不是你本人操作，请忽略本邮件，你的密码不会被修改。',
    };
  }
  return {
    subject: 'RemoteClaude 注册验证码',
    text: `你的验证码是 ${code}，10 分钟内有效。\n\n你正在用这个邮箱注册 RemoteClaude。如果不是你本人操作，请忽略本邮件。`,
  };
}

module.exports = { createMailer, codeEmail };
