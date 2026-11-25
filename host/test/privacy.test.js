'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPrivacy, unlockWithPrivacy } = require('../privacy');

/** 假的解锁服务：记下收到的命令，replies[命令] 换成别的回应（null 表示连不上，Error 表示抛异常）；PING 回 shade=0/1 */
function fake(replies = {}) {
  const t = { sent: [], logs: [], changes: [], shade: false, replies, timers: [] };
  t.p = createPrivacy({
    ask: async (line) => {
      t.sent.push(line);
      if (Object.prototype.hasOwnProperty.call(t.replies, line)) {
        const r = t.replies[line];
        if (r instanceof Error) throw r;
        return r === null ? { error: 'no-service' } : { line: r };
      }
      if (line === 'PING shade') return { line: `OK display=0 shade=${t.shade ? 1 : 0}` };
      t.shade = line === 'SHADE ON';
      return { line: 'OK' };
    },
    log: (m) => t.logs.push(m),
    onChange: (on) => t.changes.push(on),
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      t.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      t.timers = t.timers.filter((x) => x !== timer);
    },
  });
  t.tickPing = async () => {
    t.timers[0].fn();
    await new Promise((r) => setImmediate(r));
  };
  return t;
}

test('盖上：发 SHADE ON，开着期间每 2 秒报平安；控制结束发 SHADE END（先锁屏再撤），不再报平安', async () => {
  const t = fake();
  assert.equal(await t.p.on('从手机解锁'), true);
  assert.equal(t.p.isOn(), true);
  assert.deepEqual(t.changes, [true]);
  assert.equal(t.timers.length, 1);
  assert.equal(t.timers[0].ms, 2000);
  await t.tickPing();
  assert.equal(t.sent.at(-1), 'PING shade');
  assert.equal(t.p.isOn(), true);
  assert.equal(await t.p.end(), true);
  assert.equal(t.sent.at(-1), 'SHADE END');
  assert.equal(t.p.isOn(), false);
  assert.equal(t.timers.length, 0);
  assert.deepEqual(t.changes, [true, false]);
  assert.ok(t.logs[0].includes('从手机解锁') && t.logs.at(-1).includes('锁了屏'), t.logs.join(' | '));
});

test('手机上关掉：只发 SHADE OFF，不锁屏', async () => {
  const t = fake();
  await t.p.on('手机上打开');
  await t.p.off();
  assert.deepEqual(t.sent.filter((l) => l !== 'PING shade'), ['SHADE ON', 'SHADE OFF']);
  assert.equal(t.p.isOn(), false);
});

test('没开着时关、结束：什么都不发', async () => {
  const t = fake();
  assert.equal(await t.p.off(), true);
  assert.equal(await t.p.end(), true);
  assert.deepEqual(t.sent, []);
  assert.deepEqual(t.changes, []);
});

test('已经开着再开：服务那边不重复盖（这里照发，服务已开着时直接回 OK），状态不变', async () => {
  const t = fake();
  await t.p.on('a');
  await t.p.on('b');
  assert.deepEqual(t.changes, [true]);
  assert.equal(t.logs.filter((m) => m.includes('盖上了')).length, 1);
});

test('盖没成功：记下原因，不算开着，不报平安', async () => {
  const t = fake({ 'SHADE ON': 'ERR failed' });
  assert.equal(await t.p.on('从手机解锁'), false);
  assert.equal(t.p.isOn(), false);
  assert.equal(t.timers.length, 0);
  assert.ok(t.logs.some((m) => m.includes('盖隐私屏没成功')), t.logs.join(' | '));
});

test('撤没成功：不再报平安，交给服务的看门狗锁屏、撤掉', async () => {
  const t = fake({ 'SHADE END': 'ERR busy' });
  await t.p.on('x');
  assert.equal(await t.p.end(), false);
  assert.equal(t.timers.length, 0, '不能靠 PING 让黑幕一直留着');
  assert.equal(t.p.isOn(), false);
  assert.ok(t.logs.some((m) => m.includes('15 秒后会自己锁屏')), t.logs.join(' | '));
});

test('和服务说话时抛了异常：记下来，之后照常排队', async () => {
  const t = fake({ 'SHADE ON': new Error('管道坏了') });
  assert.equal(await t.p.on('x'), false);
  assert.ok(t.logs.some((m) => m.includes('管道坏了')));
  delete t.replies['SHADE ON'];
  assert.equal(await t.p.on('y'), true);
  assert.equal(t.p.isOn(), true);
});

test('电脑前有人按了 Ctrl+Alt+Del（服务那边锁了屏、撤了黑幕）：报平安时发现，记成关了', async () => {
  const t = fake();
  await t.p.on('x');
  t.shade = false;
  await t.tickPing();
  assert.equal(t.p.isOn(), false);
  assert.deepEqual(t.changes, [true, false]);
  assert.equal(t.timers.length, 0);
  assert.ok(t.logs.some((m) => m.includes('Ctrl+Alt+Del')), t.logs.join(' | '));
});

test('盖还没做完时控制就结束了：结束排在后面，轮到时看到已经盖上，照样锁屏撤掉', async () => {
  const t = fake();
  const covering = t.p.on('从手机解锁');
  const ending = t.p.end();
  assert.equal(await covering, true);
  assert.equal(await ending, true);
  assert.deepEqual(t.sent, ['SHADE ON', 'SHADE END']);
  assert.equal(t.p.isOn(), false);
});

test('正在撤的时候报平安回 shade=0：是自己撤的，不当成有人按了 Ctrl+Alt+Del', async () => {
  const logs = [];
  let finish;
  const offDone = new Promise((r) => (finish = r));
  let tick = null;
  const p = createPrivacy({
    ask: async (line) => {
      if (line === 'SHADE OFF') {
        await offDone; // 撤要先锁屏，慢
        return { line: 'OK' };
      }
      if (line === 'PING shade') return { line: 'OK display=0 shade=0' };
      return { line: 'OK' };
    },
    log: (m) => logs.push(m),
    setTimer: (fn) => ((tick = fn), {}),
    clearTimer: () => {},
  });
  await p.on('x');
  const off = p.off();
  tick();
  await new Promise((r) => setImmediate(r));
  assert.ok(!logs.some((m) => m.includes('Ctrl+Alt+Del')), logs.join(' | '));
  finish();
  await off;
  assert.equal(p.isOn(), false);
});

/** unlockWithPrivacy 用的假隐私屏和假解锁 */
function unlockFake({ covers = true, code = null, activeAfter = true } = {}) {
  const t = { calls: [] };
  t.shade = {
    on: async (reason) => (t.calls.push(['on', reason]), covers),
    end: async () => (t.calls.push(['end']), true),
  };
  t.unlock = async () => (t.calls.push(['unlock']), code);
  t.active = () => activeAfter;
  return t;
}

test('解锁：手机要隐私屏（或者没说、配置默认要）就先盖再解；手机说不要就不盖', async () => {
  let t = unlockFake();
  assert.equal(await unlockWithPrivacy({ privacy: true, defaultOn: false, detached: false, ...t }), null);
  assert.deepEqual(t.calls, [['on', '从手机解锁'], ['unlock']]);
  t = unlockFake();
  await unlockWithPrivacy({ privacy: undefined, defaultOn: true, detached: false, ...t });
  assert.deepEqual(t.calls, [['on', '从手机解锁'], ['unlock']]);
  t = unlockFake();
  await unlockWithPrivacy({ privacy: false, defaultOn: true, detached: false, ...t });
  assert.deepEqual(t.calls, [['unlock']]);
});

test('解锁：手机明确要隐私屏却没盖上，不解锁，回 privacy-failed；按配置默认盖的没盖上照常解锁（旧版服务不认 SHADE）', async () => {
  let t = unlockFake({ covers: false });
  assert.equal(await unlockWithPrivacy({ privacy: true, defaultOn: true, detached: false, ...t }), 'privacy-failed');
  assert.deepEqual(t.calls, [['on', '从手机解锁']]);
  t = unlockFake({ covers: false });
  assert.equal(await unlockWithPrivacy({ privacy: undefined, defaultOn: true, detached: false, ...t }), null);
  assert.deepEqual(t.calls, [['on', '从手机解锁'], ['unlock']]);
});

test('解锁：远程桌面断开、要先接回的，解开以后才盖；没解开不盖', async () => {
  let t = unlockFake();
  await unlockWithPrivacy({ privacy: true, defaultOn: true, detached: true, ...t });
  assert.deepEqual(t.calls, [['unlock'], ['on', '从手机接回、解锁']]);
  t = unlockFake({ code: 'still-locked' });
  await unlockWithPrivacy({ privacy: true, defaultOn: true, detached: true, ...t });
  assert.deepEqual(t.calls, [['unlock']]);
});

test('解锁做完时控制已经结束了：盖着的先锁屏再撤（end），接回的也不补盖', async () => {
  let t = unlockFake({ activeAfter: false });
  await unlockWithPrivacy({ privacy: true, defaultOn: true, detached: false, ...t });
  assert.deepEqual(t.calls, [['on', '从手机解锁'], ['unlock'], ['end']]);
  t = unlockFake({ activeAfter: false });
  await unlockWithPrivacy({ privacy: true, defaultOn: true, detached: true, ...t });
  assert.deepEqual(t.calls, [['unlock'], ['end']]);
});
