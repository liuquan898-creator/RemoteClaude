'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run, stateMessage, TILE_OPS } = require('../hostcmd');

/** 假的主进程接口：记下收到的调用，按给定的值回答 */
function fakeBridge({ tile = true, lock = true, unlock = null, privacyOk = true } = {}) {
  const calls = [];
  return {
    calls,
    tile: async (op) => (calls.push(['tile', op]), tile),
    lockNow: async () => (calls.push(['lock']), lock),
    unlockEnc: async (enc, privacy, save) => {
      const call = ['unlock', enc];
      if (privacy !== undefined || save !== undefined) call.push(privacy);
      if (save !== undefined) call.push(save);
      calls.push(call);
      return unlock;
    },
    unlockSaved: async (privacy) => (calls.push(['unlock-saved', privacy]), unlock),
    forgetPassword: async () => (calls.push(['forget']), true),
    setPrivacy: async (on) => (calls.push(['privacy', on]), privacyOk),
    controlRelease: (viewerId) => calls.push(['release', viewerId]),
  };
}

const quiet = () => {};

test('电脑状态消息：锁屏、平铺，公钥还没好时不带 key', () => {
  assert.deepEqual(stateMessage('v1', { locked: true, unlock: true }, { available: true, paused: false }, 'KEY'), {
    type: 'host-state',
    to: 'v1',
    lock: { locked: true, unlock: true },
    tile: { available: true, paused: false },
    privacy: false,
    key: 'KEY',
  });
  assert.deepEqual(stateMessage('v1', null, undefined, null), {
    type: 'host-state',
    to: 'v1',
    lock: { locked: false, unlock: false },
    tile: { available: false, paused: false },
    privacy: false,
  });
  // 隐私屏开着（docs/11 第 4.4 节）
  assert.equal(stateMessage('v1', null, null, null, true).privacy, true);
});

test('电脑状态消息：解锁服务核实不过（要重新安装）时 lock 带 untrusted，其余时候不带', () => {
  const tile = { available: false, paused: false };
  assert.deepEqual(stateMessage('v1', { locked: true, unlock: false, untrusted: true }, tile).lock, { locked: true, unlock: false, untrusted: true });
  assert.deepEqual(stateMessage('v1', { locked: true, unlock: false, untrusted: false }, tile).lock, { locked: true, unlock: false });
  // 能解锁时 untrusted 没有意义，不带
  assert.deepEqual(stateMessage('v1', { locked: false, unlock: true, untrusted: true }, tile).lock, { locked: false, unlock: true });
});

test('电脑状态消息：有记下的解锁密码、解锁服务能用时 lock 带 saved（docs/06"记住解锁密码"）', () => {
  const tile = { available: false, paused: false };
  assert.deepEqual(stateMessage('v1', { locked: true, unlock: true, saved: true }, tile).lock, { locked: true, unlock: true, saved: true });
  assert.deepEqual(stateMessage('v1', { locked: true, unlock: false, saved: true }, tile).lock, { locked: true, unlock: false }, '解锁服务用不了时不带');
  assert.deepEqual(stateMessage('v1', { locked: true, unlock: true, saved: false }, tile).lock, { locked: true, unlock: true });
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

test('解锁时带上 privacy（要不要先盖隐私屏），原样交给主进程，由它只认 true、false', async () => {
  const b = fakeBridge();
  await run({ from: 'v1', op: 'unlock', enc: 'QUJD', privacy: false }, b, quiet);
  await run({ from: 'v1', op: 'unlock', enc: 'QUJD', privacy: true }, b, quiet);
  assert.deepEqual(b.calls, [['unlock', 'QUJD', false], ['unlock', 'QUJD', true]]);
});

test('解锁带 save（解开后记不记住）原样交给主进程；saved 为 true 时用记下的密码，不看密文；忘掉记下的密码', async () => {
  const b = fakeBridge();
  await run({ from: 'v1', op: 'unlock', enc: 'QUJD', privacy: true, save: true }, b, quiet);
  await run({ from: 'v1', op: 'unlock', enc: 'QUJD', save: false }, b, quiet);
  await run({ from: 'v1', op: 'unlock', enc: 'QUJD', saved: true, privacy: false }, b, quiet);
  await run({ from: 'v1', op: 'unlock', enc: 'QUJD', saved: 'yes' }, b, quiet);
  assert.deepEqual(b.calls, [
    ['unlock', 'QUJD', true, true],
    ['unlock', 'QUJD', undefined, false],
    ['unlock-saved', false],
    ['unlock', 'QUJD'],
  ]);
  const wrong = await run({ from: 'v1', op: 'unlock', req: 'u9', saved: true }, fakeBridge({ unlock: 'saved-wrong' }), quiet);
  assert.deepEqual([wrong.ok, wrong.code], [false, 'saved-wrong']);

  const f = fakeBridge();
  assert.equal((await run({ from: 'v1', op: 'forget-password', req: 'f1' }, f, quiet)).ok, true);
  assert.deepEqual(f.calls, [['forget']]);
});

test('开、关隐私屏：交给主进程；on 不是布尔值回 bad-request，什么都不做', async () => {
  const b = fakeBridge();
  assert.equal((await run({ from: 'v1', op: 'privacy', req: 'p1', on: true }, b, quiet)).ok, true);
  assert.equal((await run({ from: 'v1', op: 'privacy', req: 'p2', on: false }, b, quiet)).ok, true);
  assert.deepEqual(b.calls, [['privacy', true], ['privacy', false]]);
  const bad = await run({ from: 'v1', op: 'privacy', req: 'p3', on: 'yes' }, b, quiet);
  assert.deepEqual([bad.ok, bad.code], [false, 'bad-request']);
  assert.equal(b.calls.length, 2);
  const failed = await run({ from: 'v1', op: 'privacy', req: 'p4', on: true }, fakeBridge({ privacyOk: false }), quiet);
  assert.deepEqual([failed.ok, failed.code], [false, 'failed']);
});

test('日志里不出现密文', async () => {
  const lines = [];
  await run({ from: 'v1', op: 'unlock', req: 'u1', enc: 'SECRET-CIPHERTEXT' }, fakeBridge(), (l) => lines.push(l));
  assert.ok(lines.length > 0);
  assert.ok(!lines.join('\n').includes('SECRET-CIPHERTEXT'));
});

test('结束控制：交给主进程，带了 req 就回执成功', async () => {
  const b = fakeBridge();
  const logs = [];
  assert.deepEqual(await run({ from: 'v1', op: 'release', req: 'r1' }, b, (m) => logs.push(m)), {
    type: 'host-cmd-result',
    to: 'v1',
    req: 'r1',
    op: 'release',
    ok: true,
  });
  assert.deepEqual(b.calls, [['release', 'v1']]);
  assert.ok(logs.some((m) => m.includes('结束控制')), logs.join(' | '));
  assert.equal(await run({ from: 'v2', op: 'release' }, b, quiet), null);
  assert.deepEqual(b.calls.at(-1), ['release', 'v2']);
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
