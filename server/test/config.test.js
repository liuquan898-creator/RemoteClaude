'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig } = require('../lib/config');
const { createMailer } = require('../lib/mailer');
const { startServer } = require('./helpers');

test('发信配置：各模式缺少必填项时报错', () => {
  assert.throws(() => normalizeConfig({ mail: { mode: 'tencent-ses', secretId: 'x', secretKey: 'y', from: 'a@b.com' } }, __dirname), /templateId/);
  assert.throws(() => normalizeConfig({ mail: { mode: 'smtp', host: 'h', user: 'u', from: 'f' } }, __dirname), /pass/);
  assert.throws(() => normalizeConfig({ mail: { mode: 'carrier-pigeon' } }, __dirname), /mail\.mode/);

  const ok = normalizeConfig(
    { mail: { mode: 'tencent-ses', secretId: 'x', secretKey: 'y', from: 'RemoteClaude <a@b.com>', templateId: '12345' } },
    __dirname
  );
  assert.equal(ok.mail.templateId, 12345);
  assert.equal(ok.mail.region, 'ap-guangzhou', '地域默认广州');
  assert.equal(normalizeConfig({}, __dirname).mail.mode, 'log', '不配置时只打印');
});

test('腾讯云邮件推送：能按 CommonJS 加载接口包并创建客户端（不发信）', () => {
  const mailer = createMailer(
    { mode: 'tencent-ses', secretId: 'x', secretKey: 'y', region: 'ap-guangzhou', from: 'a@b.com', templateId: 1 },
    () => {}
  );
  assert.equal(mailer.mode, 'tencent-ses');
  assert.equal(typeof mailer.send, 'function');
  assert.equal(typeof mailer.verify, 'function');
});

test('发验证码时把验证码单独交给发信模块（模板模式要用）', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  await s.post('/api/auth/send-code', { email: 'x@example.com', purpose: 'register' });
  const m = s.app.mailer.outbox[0];
  assert.match(m.code, /^\d{6}$/);
  assert.ok(m.text.includes(m.code));
  assert.equal(m.subject, 'RemoteClaude 注册验证码');
});
