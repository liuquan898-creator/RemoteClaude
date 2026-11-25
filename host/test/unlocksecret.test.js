'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUnlockSecret, afterManualUnlock, unlockWithSaved, MAX_BLOB } = require('../unlocksecret');

/** 假的加密（"enc:" + Base64）和服务器：记下发了什么，reply 由测试自己调 */
function fake({ available = true, sendOk = true } = {}) {
  const t = { sent: [], logs: [], changes: [] };
  t.s = createUnlockSecret({
    encrypt: (pw) => Buffer.from('enc:' + pw).toString('base64'),
    decrypt: (blob) => {
      const text = Buffer.from(blob, 'base64').toString();
      if (!text.startsWith('enc:')) throw new Error('不是这台电脑加密的');
      return text.slice(4);
    },
    available: () => available,
    send: (msg) => (t.sent.push(msg), sendOk),
    log: (m) => t.logs.push(m),
    onChange: (saved) => t.changes.push(saved),
  });
  t.blobOf = (pw) => Buffer.from('enc:' + pw).toString('base64');
  return t;
}

test('连上服务器时取回密文；有就算记着，解得开', () => {
  const t = fake();
  t.s.fetch();
  assert.deepEqual(t.sent, [{ op: 'get' }]);
  assert.equal(t.s.has(), false);
  t.s.reply({ op: 'get', ok: true, blob: t.blobOf('p@ss') });
  assert.equal(t.s.has(), true);
  assert.deepEqual(t.changes, [true]);
  assert.equal(t.s.take(), 'p@ss');
  t.s.reply({ op: 'get', ok: true, blob: null });
  assert.equal(t.s.has(), false, '服务器上没有了（别处删了）');
  assert.equal(t.s.take(), null);
});

test('这台电脑上没法加密：不取、不记', () => {
  const t = fake({ available: false });
  t.s.fetch();
  assert.equal(t.s.remember('x'), false);
  assert.deepEqual(t.sent, []);
  assert.ok(t.logs.some((m) => m.includes('没法加密')));
});

test('记住：发密文（不是明文），服务器回 OK 以后才算记着；没回 OK 不算', () => {
  const t = fake();
  assert.equal(t.s.remember('p@ss 中文'), true);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].op, 'put');
  assert.ok(!t.sent[0].blob.includes('p@ss'), '发出去的是密文');
  assert.equal(t.s.has(), false, '服务器还没回');
  t.s.reply({ op: 'put', ok: true });
  assert.equal(t.s.has(), true);
  assert.equal(t.s.take(), 'p@ss 中文');
  assert.ok(t.logs.every((m) => !m.includes('p@ss')), '日志里不写密码');

  const u = fake();
  u.s.remember('x');
  u.s.reply({ op: 'put', ok: false, error: 'rate-limited' });
  assert.equal(u.s.has(), false);
  assert.ok(u.logs.some((m) => m.includes('rate-limited')));
});

test('没连着服务器、加密出来太长：记不了', () => {
  const t = fake({ sendOk: false });
  assert.equal(t.s.remember('x'), false);
  t.s.reply({ op: 'put', ok: true });
  assert.equal(t.s.has(), false, '发不出去的不会因为一条迟到的回应算记着');
  const long = fake();
  assert.equal(long.s.remember('x'.repeat(MAX_BLOB)), false);
  assert.deepEqual(long.sent, []);
});

test('忘掉：发删除、不再算记着；解不开的顺手删掉', () => {
  const t = fake();
  t.s.reply({ op: 'get', ok: true, blob: t.blobOf('a') });
  t.s.forget('手机上要求忘掉');
  assert.deepEqual(t.sent, [{ op: 'delete' }]);
  assert.equal(t.s.has(), false);
  assert.deepEqual(t.changes, [true, false]);

  const u = fake();
  u.s.reply({ op: 'get', ok: true, blob: Buffer.from('别的电脑的').toString('base64') });
  assert.equal(u.s.take(), null);
  assert.deepEqual(u.sent, [{ op: 'delete' }]);
  assert.ok(u.logs.some((m) => m.includes('解不开')));
});

test('要删的没删成（没连着、服务器出错）：下次连上先删再取，取回来的旧密文不认', () => {
  const t = fake();
  t.s.reply({ op: 'get', ok: true, blob: t.blobOf('old') });
  t.s.forget('手机上要求忘掉');
  t.s.reply({ op: 'delete', ok: false, error: 'rate-limited' });
  t.sent.length = 0;
  t.s.fetch();
  assert.deepEqual(t.sent, [{ op: 'delete' }, { op: 'get' }], '先删再取');
  t.s.reply({ op: 'delete', ok: false, error: 'failed' });
  t.s.reply({ op: 'get', ok: true, blob: t.blobOf('old') });
  assert.equal(t.s.has(), false, '删掉的密码不会因为又取回来而复活');
  t.s.fetch();
  t.s.reply({ op: 'delete', ok: true });
  t.s.reply({ op: 'get', ok: true, blob: null });
  t.sent.length = 0;
  t.s.fetch();
  assert.deepEqual(t.sent, [{ op: 'get' }], '删成了就不再删');
});

test('回应对不上号：取的回应晚于本机新记的不认；连着两次记，以最后一次为准；忘掉以后迟到的 put 回应不算数', () => {
  const t = fake();
  t.s.fetch();
  t.s.remember('new');
  t.s.reply({ op: 'get', ok: true, blob: t.blobOf('older') });
  assert.equal(t.s.has(), false, '取回来的是记新密码之前的');
  t.s.reply({ op: 'put', ok: true });
  assert.equal(t.s.take(), 'new');

  const u = fake();
  u.s.remember('a');
  u.s.remember('b');
  u.s.reply({ op: 'put', ok: true });
  assert.equal(u.s.has(), false, '第一个的回应，后面还有更新的在等');
  u.s.reply({ op: 'put', ok: true });
  assert.equal(u.s.take(), 'b');

  const w = fake();
  w.s.remember('a');
  w.s.forget('手机上要求忘掉');
  w.s.reply({ op: 'put', ok: true });
  assert.equal(w.s.has(), false);
});

test('服务器回的密文格式不对、太长：当没有；错误码只认正常的样子', () => {
  const t = fake();
  t.s.reply({ op: 'get', ok: true, blob: 'A'.repeat(MAX_BLOB + 1) });
  assert.equal(t.s.has(), false);
  t.s.reply({ op: 'get', ok: true, blob: 'not base64!' });
  assert.equal(t.s.has(), false);
  t.s.reply({ op: 'get', ok: false, error: '\n伪造的日志行' });
  assert.ok(t.logs.at(-1).endsWith('failed'), t.logs.at(-1));
});

test('手动解锁以后：勾了记住就记；没勾就把原来的删掉；旧版手机不带 save 就不动；没解开什么都不做', () => {
  const t = fake();
  afterManualUnlock(t.s, null, 'pw1', true);
  assert.equal(t.sent.at(-1).op, 'put');
  t.s.reply({ op: 'put', ok: true });
  afterManualUnlock(t.s, null, 'pw2', undefined);
  afterManualUnlock(t.s, 'still-locked', 'pw3', true);
  assert.equal(t.sent.length, 1, '旧版手机、没解开都不动');
  afterManualUnlock(t.s, null, 'pw4', false);
  assert.deepEqual(t.sent.at(-1), { op: 'delete' });
  assert.equal(t.s.has(), false);
});

test('用记下的密码解锁：解开了留着；还是锁着就删掉、回 saved-wrong；没有记下的回 no-saved；别的错原样回', async () => {
  const t = fake();
  assert.equal(await unlockWithSaved(t.s, async () => null), 'no-saved');
  t.s.reply({ op: 'get', ok: true, blob: t.blobOf('right') });
  const tried = [];
  assert.equal(await unlockWithSaved(t.s, async (pw) => (tried.push(pw), null)), null);
  assert.deepEqual(tried, ['right']);
  assert.equal(t.s.has(), true);
  assert.equal(await unlockWithSaved(t.s, async () => 'rate-limited'), 'rate-limited');
  assert.equal(t.s.has(), true, '次数用完了不代表密码不对');
  assert.equal(await unlockWithSaved(t.s, async () => 'still-locked'), 'saved-wrong');
  assert.equal(t.s.has(), false);
  assert.deepEqual(t.sent.at(-1), { op: 'delete' });
});
