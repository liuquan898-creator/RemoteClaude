'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createControlSession, IDLE_MS, GONE_MS, PUSH_VIEWER } = require('../controlsession');

/** 假的钟和定时器：tick(ms) 把钟往前拨，到点的定时器依次执行 */
function fake() {
  const t = { clock: 0, timers: [], changes: [] };
  t.session = createControlSession({
    onChange: (active) => t.changes.push(active),
    now: () => t.clock,
    setTimer: (fn, ms) => {
      const timer = { at: t.clock + ms, fn };
      t.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      t.timers = t.timers.filter((x) => x !== timer);
    },
  });
  t.tick = (ms) => {
    const end = t.clock + ms;
    for (;;) {
      const due = t.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t.timers = t.timers.filter((x) => x !== due);
      t.clock = due.at;
      due.fn();
    }
    t.clock = end;
  };
  return t;
}

test('一开始不算在控制', () => {
  const t = fake();
  assert.equal(t.session.isActive(), false);
  assert.deepEqual(t.changes, []);
});

test('控制端发来操作就开始，闲了 3 分钟结束', () => {
  const t = fake();
  t.session.activity('a1');
  assert.equal(t.session.isActive(), true);
  t.tick(IDLE_MS - 1);
  assert.equal(t.session.isActive(), true);
  t.tick(1);
  assert.equal(t.session.isActive(), false);
  assert.deepEqual(t.changes, [true, false]);
});

test('每次操作都重新计时', () => {
  const t = fake();
  t.session.activity('a1');
  t.tick(IDLE_MS - 1000);
  t.session.activity('a1');
  t.tick(IDLE_MS - 1000);
  assert.equal(t.session.isActive(), true);
  t.tick(1000);
  assert.equal(t.session.isActive(), false);
});

test('推送用的 push 不算控制端', () => {
  const t = fake();
  t.session.activity(PUSH_VIEWER);
  t.session.activity('');
  assert.equal(t.session.isActive(), false);
  assert.deepEqual(t.changes, []);
});

test('控制端说结束控制或断开了，马上结束；别的控制端还在就不结束', () => {
  const t = fake();
  t.session.activity('a1');
  t.session.activity('a2');
  t.session.release('a1');
  assert.equal(t.session.isActive(), true);
  t.session.release('a2');
  assert.equal(t.session.isActive(), false);
  assert.deepEqual(t.changes, [true, false]);
  t.session.release('a3'); // 没控制过的断开，不影响
  assert.deepEqual(t.changes, [true, false]);
});

test('控制端断开了：再算 1 分钟，这期间重新连上的有操作就接着算；1 分钟里没人来就结束', () => {
  const t = fake();
  t.session.activity('a1');
  t.session.gone('a1');
  assert.equal(t.session.isActive(), true, '鸿蒙 App 退到后台就断开：不马上结束（开着隐私屏时会锁屏）');
  t.tick(GONE_MS - 1);
  assert.equal(t.session.isActive(), true);
  t.session.activity('b2'); // 回到前台，重新连上（编号换了），又列了一次会话
  t.tick(GONE_MS);
  assert.equal(t.session.isActive(), true, '新连上的接着算');
  t.session.gone('b2');
  t.tick(GONE_MS);
  assert.equal(t.session.isActive(), false);
  assert.deepEqual(t.changes, [true, false]);

  // 本来就快闲够了：断开不会让它算得更久
  const u = fake();
  u.session.activity('a1');
  u.tick(IDLE_MS - 1000);
  u.session.gone('a1');
  u.tick(1000);
  assert.equal(u.session.isActive(), false);
  u.session.gone('zz'); // 没控制过的断开，不影响
  assert.deepEqual(u.changes, [true, false]);
});

test('有人看着画面就一直算在控制，不看了以后从最后一次操作起算 3 分钟', () => {
  const t = fake();
  t.session.setWatching(1);
  assert.equal(t.session.isActive(), true);
  t.tick(IDLE_MS * 5);
  assert.equal(t.session.isActive(), true, '看画面期间不会因为闲着结束');
  t.session.activity('a1');
  t.session.setWatching(0);
  assert.equal(t.session.isActive(), true);
  t.tick(IDLE_MS);
  assert.equal(t.session.isActive(), false);
  assert.deepEqual(t.changes, [true, false]);
});

test('只看画面、没有别的操作，不看了就结束', () => {
  const t = fake();
  t.session.setWatching(2);
  t.session.setWatching(0);
  assert.equal(t.session.isActive(), false);
  assert.deepEqual(t.changes, [true, false]);
});

test('结束以后没有留下定时器', () => {
  const t = fake();
  t.session.activity('a1');
  t.session.release('a1');
  assert.equal(t.timers.length, 0);
});

test('两个控制端：先操作的那个闲够了，后操作的还在，控制不结束；后一个也闲够了才结束', () => {
  const t = fake();
  t.session.activity('a1');
  t.tick(100000);
  t.session.activity('a2');
  t.tick(IDLE_MS - 100000);
  assert.equal(t.session.isActive(), true, 'a1 到期了，a2 还在');
  t.tick(100000 - 1);
  assert.equal(t.session.isActive(), true);
  t.tick(1);
  assert.equal(t.session.isActive(), false);
  assert.deepEqual(t.changes, [true, false]);
});

test('控制端说结束控制时还开着画面：看画面期间仍算在控制，画面关了马上结束（被控端收到 release 会关掉它的画面）', () => {
  const t = fake();
  t.session.activity('a1');
  t.session.setWatching(1);
  t.session.release('a1');
  assert.equal(t.session.isActive(), true);
  t.session.setWatching(0);
  assert.equal(t.session.isActive(), false);
});
