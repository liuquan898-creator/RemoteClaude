'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, stateMessage, TILE_OPS } = require('../hostcmd');

/** 假的主进程接口：记下收到的调用，按给定的值回答 */
function fakeBridge({ tile = true, lock = true, unlock = null } = {}) {
  const calls = [];
  return {
    calls,
    tile: async (op) => (calls.push(['tile', op]), tile),
    lockNow: async () => (calls.push(['lock']), lock),
    unlockEnc: async (enc) => (calls.push(['unlock', enc]), unlock),
  };
}

const quiet = () => {};

test('电脑状态消息：锁屏、平铺，公钥还没好时不带 key', () => {
  assert.deepEqual(stateMessage('v1', { locked: true, unlock: true }, { available: true, paused: false }, 'KEY'), {
    type: 'host-state',
    to: 'v1',
    lock: { locked: true, unlock: true },
    tile: { available: true, paused: false },
    key: 'KEY',
  });
  assert.deepEqual(stateMessage('v1', null, undefined, null), {
    type: 'host-state',
    to: 'v1',
    lock: { locked: false, unlock: false },
    tile: { available: false, paused: false },
  });
});

test('平铺的四个操作交给主进程；没带 req 就不回执', async () => {
  for (const op of Object.keys(TILE_OPS)) {
    const b = fakeBridge();
    assert.equal(await run({ type: 'host-cmd', from: 'v1', op }, b, quiet), null);
    assert.deepEqual(b.calls, [['tile', op]]);
  }
  assert.deepEqual(Object.keys(TILE_OPS), ['arrange', 'raise', 'pause', 'resume']);
});

test('带了 req 就回执；平铺没在运行时回 unavailable', async () => {
  assert.deepEqual(await run({ from: 'v1', op: 'arrange', req: 'r1' }, fakeBridge(), quiet), {
    type: 'host-cmd-result',
    to: 'v1',
    req: 'r1',
    op: 'arrange',
    ok: true,
  });
  assert.deepEqual(await run({ from: 'v1', op: 'pause', req: 'r2' }, fakeBridge({ tile: false }), quiet), {
    type: 'host-cmd-result',
    to: 'v1',
    req: 'r2',
    op: 'pause',
    ok: false,
    code: 'unavailable',
  });
});

test('锁定', async () => {
  const b = fakeBridge();
  assert.equal(await run({ from: 'v1', op: 'lock' }, b, quiet), null);
  assert.deepEqual(b.calls, [['lock']]);
  const r = await run({ from: 'v1', op: 'lock', req: 'r' }, fakeBridge({ lock: false }), quiet);
  assert.deepEqual([r.ok, r.code], [false, 'failed']);
});

test('解锁：密文原样交给主进程，回执带主进程给的错误码', async () => {
  const ok = fakeBridge({ unlock: null });
  assert.deepEqual(await run({ from: 'v1', op: 'unlock', req: 'u1', enc: 'QUJD' }, ok, quiet), {
    type: 'host-cmd-result',
    to: 'v1',
    req: 'u1',
    op: 'unlock',
    ok: true,
  });
  assert.deepEqual(ok.calls, [['unlock', 'QUJD']]);

  const bad = await run({ from: 'v1', op: 'unlock', req: 'u2', enc: 'QUJD' }, fakeBridge({ unlock: 'still-locked' }), quiet);
  assert.deepEqual([bad.ok, bad.code], [false, 'still-locked']);

  // 没带密文或者不是字符串：交给主进程的是空串，由它拒绝
  const none = fakeBridge({ unlock: 'bad-key' });
  await run({ from: 'v1', op: 'unlock', req: 'u3', enc: { evil: 1 } }, none, quiet);
  assert.deepEqual(none.calls, [['unlock', '']]);
});

test('日志里不出现密文', async () => {
  const lines = [];
  await run({ from: 'v1', op: 'unlock', req: 'u1', enc: 'SECRET-CIPHERTEXT' }, fakeBridge(), (l) => lines.push(l));
  assert.ok(lines.length > 0);
  assert.ok(!lines.join('\n').includes('SECRET-CIPHERTEXT'));
});

test('不认识的操作什么都不做，带了 req 回 bad-op；req、op 太长会截短', async () => {
  const b = fakeBridge();
  assert.equal(await run({ from: 'v1', op: 'format-c' }, b, quiet), null);
  assert.equal(await run({ from: 'v1', op: 123 }, b, quiet), null);
  assert.equal(await run({ from: 'v1' }, b, quiet), null);
  assert.deepEqual(b.calls, []);
  const r = await run({ from: 'v1', op: 'x'.repeat(50), req: 'r'.repeat(100) }, b, quiet);
  assert.deepEqual([r.ok, r.code, r.op.length, r.req.length], [false, 'bad-op', 20, 40]);
  // 原型上的名字不能当成操作
  assert.equal((await run({ from: 'v1', op: 'constructor', req: 'r' }, b, quiet)).code, 'bad-op');
  assert.deepEqual(b.calls, []);
});
