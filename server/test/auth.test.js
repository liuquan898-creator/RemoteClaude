'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connect, auth } = require('./helpers');

test('注册、登录、退出登录', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const sent = await s.post('/api/auth/send-code', { email: 'Alice@Example.com ', purpose: 'register' });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body, { ok: true, cooldown: 60 });
  assert.equal(s.app.mailer.outbox.length, 1);
  assert.equal(s.app.mailer.outbox[0].to, 'alice@example.com', '邮箱应去空白并转小写');

  const base = { email: 'alice@example.com', password: 'password-123', clientType: 'viewer', deviceId: 'phone-1', deviceName: '手机' };
  const wrong = await s.post('/api/auth/register', { ...base, code: '000000' === s.lastCode('alice@example.com') ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'bad-code');

  const ok = await s.post('/api/auth/register', { ...base, code: s.lastCode('alice@example.com') });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, 'alice@example.com');
  assert.ok(ok.body.token.length >= 40);

  const again = await s.post('/api/auth/send-code', { email: 'alice@example.com', purpose: 'register' }, { ip: '203.0.113.9' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'email-taken');

  const bad = await s.login('alice@example.com', 'nope-nope', 'host', 'pc-1', 'PC');
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'bad-credentials');

  const good = await s.login('ALICE@example.com', 'password-123', 'host', 'pc-1', 'PC');
  assert.equal(good.status, 200, '登录时邮箱不区分大小写');

  assert.deepEqual((await s.post('/api/auth/logout', {}, { token: good.body.token })).body, { ok: true });
  assert.deepEqual((await s.post('/api/auth/logout', {}, { token: good.body.token })).body, { ok: true }, '重复退出也算成功');
  const ws = await connect(s.wsUrl, auth('host', good.body.token));
  assert.equal((await ws.next('auth-fail')).reason, 'bad-token', '退出后令牌不能再用');
});

test('输入校验', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  assert.equal((await s.post('/api/auth/send-code', { email: 'not-an-email', purpose: 'register' })).body.error, 'bad-email');
  assert.equal((await s.post('/api/auth/send-code', { email: 'a@b.com', purpose: 'other' })).body.error, 'bad-request');
  await s.post('/api/auth/send-code', { email: 'a@b.com', purpose: 'register' });
  const weak = await s.post('/api/auth/register', {
    email: 'a@b.com', code: s.lastCode('a@b.com'), password: 'short', clientType: 'viewer', deviceId: 'x', deviceName: 'y',
  });
  assert.equal(weak.body.error, 'weak-password');
  const badDevice = await s.post('/api/auth/register', {
    email: 'a@b.com', code: s.lastCode('a@b.com'), password: 'long-enough', clientType: 'viewer', deviceId: 'bad id!', deviceName: 'y',
  });
  assert.equal(badDevice.body.error, 'bad-request');

  const res = await fetch(`${s.base}/api/auth/login`, { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
  assert.equal((await fetch(`${s.base}/api/auth/login`)).status, 405);
  assert.equal((await fetch(`${s.base}/api/nope`, { method: 'POST' })).status, 404);
});

test('验证码：发送冷却、错满 5 次作废', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  await s.post('/api/auth/send-code', { email: 'b@example.com', purpose: 'register' });
  const second = await s.post('/api/auth/send-code', { email: 'b@example.com', purpose: 'register' });
  assert.equal(second.status, 429);
  assert.equal(second.body.error, 'too-many');
  assert.ok(second.body.retryAfter > 0 && second.body.retryAfter <= 60);

  const code = s.lastCode('b@example.com');
  const body = { email: 'b@example.com', password: 'password-123', clientType: 'viewer', deviceId: 'p', deviceName: 'p' };
  const wrong = code === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) assert.equal((await s.post('/api/auth/register', { ...body, code: wrong })).body.error, 'bad-code');
  const late = await s.post('/api/auth/register', { ...body, code });
  assert.equal(late.status, 400, '错满 5 次后正确的验证码也不能用');
});

test('找回密码：不暴露邮箱是否注册，重置后旧登录全部下线', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  const unknown = await s.post('/api/auth/send-code', { email: 'ghost@example.com', purpose: 'reset' });
  assert.equal(unknown.status, 200, '没注册的邮箱也返回成功');
  assert.equal(s.lastCode('ghost@example.com'), null, '但不发信');

  const viewerToken = await s.register('carol@example.com', 'old-password');
  const viewer = await connect(s.wsUrl, auth('viewer', viewerToken));
  await viewer.next('auth-ok');

  await s.post('/api/auth/send-code', { email: 'carol@example.com', purpose: 'reset' }, { ip: '203.0.113.2' });
  const code = s.lastCode('carol@example.com');
  const reset = await s.post('/api/auth/reset-password', { email: 'carol@example.com', code, password: 'new-password' });
  assert.equal(reset.status, 200);

  assert.equal((await viewer.next('auth-fail')).reason, 'revoked');
  assert.equal(await viewer.closed, 4003);
  assert.equal((await s.login('carol@example.com', 'old-password', 'viewer', 'p', 'p')).status, 401);
  assert.equal((await s.login('carol@example.com', 'new-password', 'viewer', 'p', 'p')).status, 200);
});

test('登录失败太多会被暂时锁定', async (t) => {
  const s = await startServer({ limits: { loginFailPerIp: 3, loginFailPerEmail: 100 } });
  t.after(() => s.close());
  await s.register('dave@example.com', 'right-password');

  const attempt = (pw, ip) => s.post('/api/auth/login', {
    email: 'dave@example.com', password: pw, clientType: 'viewer', deviceId: 'p', deviceName: 'p',
  }, { ip });
  for (let i = 0; i < 3; i++) assert.equal((await attempt('wrong-password', '198.51.100.7')).status, 401);
  const locked = await attempt('right-password', '198.51.100.7');
  assert.equal(locked.status, 429, '同一 IP 错满后，正确密码也要等');
  assert.ok(locked.body.retryAfter > 0);
  assert.equal((await attempt('right-password', '198.51.100.8')).status, 200, '别的 IP 不受影响');
});

test('关闭注册', async (t) => {
  const s = await startServer({ registration: { open: false } });
  t.after(() => s.close());
  const res = await s.post('/api/auth/send-code', { email: 'e@example.com', purpose: 'register' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'registration-closed');
});
