'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVirtualDisplay, fitVirtualMode, hasPhysicalDisplay, isVirtualMonitor } = require('../vdisplay');

const AOC = { monitor: 'MONITOR\\AOC2790\\{4d36e96e-e325-11ce-bfc1-08002be10318}\\0006' };
const VDD = { monitor: 'MONITOR\\MTT1337\\{4d36e96e-e325-11ce-bfc1-08002be10318}\\0009' };

/**
 * 假的解锁服务和显示器：DISPLAY ON 成功后列表里多一块虚拟屏，DISPLAY OFF 后去掉。
 * replies[命令] 可以换成别的回应（没装驱动、出错、null 表示管道连不上、Error 表示抛异常）；PING 回 OK display=0/1
 */
function fake({ physical = [], replies = {} } = {}) {
  const t = { physical, virtual: false, sent: [], logs: [], ready: 0, replies, timers: [], hold: null };
  t.vd = createVirtualDisplay({
    ask: async (line) => {
      t.sent.push(line);
      if (t.hold && line === 'PING display') await t.hold;
      if (Object.prototype.hasOwnProperty.call(t.replies, line)) {
        const r = t.replies[line];
        if (r instanceof Error) throw r;
        return r === null ? { error: 'no-service' } : { line: r };
      }
      if (line === 'PING display') return { line: 'OK display=' + (t.virtual ? 1 : 0) };
      t.virtual = line === 'DISPLAY ON';
      return { line: 'OK' };
    },
    displays: () => [...t.physical, ...(t.virtual ? [VDD] : [])],
    log: (m) => t.logs.push(m),
    onReady: () => t.ready++,
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      t.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      t.timers = t.timers.filter((x) => x !== timer);
    },
  });
  /** 到点报一次平安，等它和它引起的检查都做完 */
  t.tickPing = async () => {
    t.timers[0].fn();
    await new Promise((r) => setImmediate(r));
    await t.vd.displaysChanged();
  };
  return t;
}

test('认得出虚拟屏驱动的显示器', () => {
  assert.equal(isVirtualMonitor(VDD.monitor), true);
  assert.equal(isVirtualMonitor(AOC.monitor), false);
  assert.equal(isVirtualMonitor(''), false);
  assert.equal(hasPhysicalDisplay([]), false);
  assert.equal(hasPhysicalDisplay([VDD]), false);
  assert.equal(hasPhysicalDisplay([VDD, AOC]), true);
  // 取不到显示器 ID 的输出也当真显示器：宁可不开虚拟屏，也不在有屏的电脑上多开一块
  assert.equal(hasPhysicalDisplay([{ monitor: '' }]), true);
});

test('开始控制、没有显示器：开虚拟屏，出现后调一次 onReady，开着期间每 2 秒报平安；结束控制关掉、不再报平安', async () => {
  const t = fake();
  await t.vd.setActive(true);
  assert.deepEqual(t.sent, ['DISPLAY ON']);
  assert.equal(t.vd.state(), 'on');
  assert.equal(t.ready, 1);
  assert.equal(t.timers.length, 1);
  assert.equal(t.timers[0].ms, 2000);
  await t.tickPing();
  assert.equal(t.sent.at(-1), 'PING display');
  assert.equal(t.sent.filter((l) => l === 'DISPLAY ON').length, 1, '报平安说开着，不再开');
  await t.vd.setActive(false);
  assert.equal(t.sent.at(-1), 'DISPLAY OFF');
  assert.equal(t.vd.state(), 'off');
  assert.equal(t.timers.length, 0);
  assert.ok(t.logs.some((m) => m.includes('已开虚拟屏')) && t.logs.some((m) => m.includes('控制结束')), t.logs.join(' | '));
});

test('服务答应了但虚拟屏还没出现：等显示器变化时再调 onReady，只调一次', async () => {
  const sent = [];
  const shown = [];
  let ready = 0;
  const vd = createVirtualDisplay({
    ask: async (line) => (sent.push(line), { line: line === 'PING display' ? 'OK display=1' : 'OK' }),
    displays: () => shown,
    log: () => {},
    onReady: () => ready++,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  await vd.setActive(true);
  assert.equal(ready, 0);
  shown.push(VDD);
  await vd.displaysChanged();
  await vd.displaysChanged();
  assert.equal(ready, 1);
  assert.deepEqual(sent, ['DISPLAY ON']);
});

test('有真显示器时不开虚拟屏', async () => {
  const t = fake({ physical: [AOC] });
  await t.vd.setActive(true);
  await t.vd.setActive(false);
  assert.deepEqual(t.sent, []);
  assert.equal(t.vd.state(), 'off');
});

test('开着虚拟屏时接上了真显示器：关掉；真显示器又断了：再开', async () => {
  const t = fake();
  await t.vd.setActive(true);
  t.physical = [AOC];
  await t.vd.displaysChanged();
  assert.equal(t.sent.at(-1), 'DISPLAY OFF');
  assert.equal(t.vd.state(), 'off');
  assert.ok(t.logs.some((m) => m.includes('接上了真显示器')), t.logs.join(' | '));
  t.physical = [];
  await t.vd.displaysChanged();
  assert.equal(t.sent.at(-1), 'DISPLAY ON');
  assert.equal(t.vd.state(), 'on');
  assert.equal(t.ready, 2, '重新开出来以后再摆一次');
});

test('自己的虚拟屏不算真显示器：开着时列表变化不会把它关掉', async () => {
  const t = fake();
  await t.vd.setActive(true);
  await t.vd.displaysChanged();
  assert.deepEqual(t.sent, ['DISPLAY ON']);
});

test('关虚拟屏失败：不再报平安（交给服务的看门狗去关），下次开始控制照常再开', async () => {
  const t = fake({ replies: { 'DISPLAY OFF': 'ERR busy' } });
  await t.vd.setActive(true);
  await t.vd.setActive(false);
  assert.equal(t.timers.length, 0, '不能靠 PING 替它续着');
  assert.equal(t.vd.state(), 'error');
  assert.ok(t.logs.some((m) => m.includes('关虚拟屏没成功') && m.includes('ERR busy')), t.logs.join(' | '));
  await t.vd.setActive(true);
  assert.equal(t.sent.at(-1), 'DISPLAY ON');
});

test('虚拟屏被服务的看门狗关了（被控端卡住过）：显示器变化时发现看不到它，再要一次', async () => {
  const t = fake();
  await t.vd.setActive(true);
  t.virtual = false; // 服务把设备停用了
  await t.vd.displaysChanged();
  assert.deepEqual(t.sent, ['DISPLAY ON', 'DISPLAY ON']);
  assert.equal(t.vd.state(), 'on');
  assert.equal(t.ready, 2);
});

test('报平安的回应说虚拟屏没开着：重新开；连不上服务时记一次', async () => {
  const t = fake();
  await t.vd.setActive(true);
  t.virtual = false;
  await t.tickPing();
  assert.equal(t.sent.filter((l) => l === 'DISPLAY ON').length, 2);
  t.replies['PING display'] = null;
  await t.tickPing();
  await t.tickPing();
  assert.equal(t.logs.filter((m) => m.includes('报平安没成功')).length, 1, t.logs.join(' | '));
});

test('上一次报平安还没回来，到点不再发', async () => {
  const t = fake();
  await t.vd.setActive(true);
  let release;
  t.hold = new Promise((r) => (release = r));
  t.timers[0].fn();
  t.timers[0].fn();
  t.timers[0].fn();
  assert.equal(t.sent.filter((l) => l === 'PING display').length, 1);
  release();
  t.hold = null;
  await new Promise((r) => setImmediate(r));
  t.timers[0].fn();
  assert.equal(t.sent.filter((l) => l === 'PING display').length, 2);
});

test('没装驱动：记一次说明，状态是 none；下次开始控制再试，不重复记', async () => {
  const t = fake({ replies: { 'DISPLAY ON': 'ERR no-display' } });
  await t.vd.setActive(true);
  assert.equal(t.vd.state(), 'none');
  await t.vd.setActive(false);
  await t.vd.setActive(true);
  assert.equal(t.sent.filter((l) => l === 'DISPLAY ON').length, 2);
  assert.equal(t.logs.filter((m) => m.includes('没装虚拟屏驱动')).length, 1);
  assert.equal(t.timers.length, 0, '没开成就不报平安');
});

test('解锁服务没装或不可信：状态是 error，不报平安', async () => {
  const t = fake({ replies: { 'DISPLAY ON': null } });
  await t.vd.setActive(true);
  assert.equal(t.vd.state(), 'error');
  assert.equal(t.timers.length, 0);
  assert.ok(t.logs.some((m) => m.includes('开虚拟屏没成功') && m.includes('no-service')), t.logs.join(' | '));
});

test('和服务说话时抛了异常：记下来，之后的开关照常排队', async () => {
  const t = fake({ replies: { 'DISPLAY ON': new Error('管道坏了') } });
  await t.vd.setActive(true);
  assert.ok(t.logs.some((m) => m.includes('管道坏了')), t.logs.join(' | '));
  delete t.replies['DISPLAY ON'];
  await t.vd.displaysChanged();
  assert.equal(t.vd.state(), 'on');
});

test('一下子开始、结束好几次：按最后的结果办，中间的不和服务说（虚拟屏不闪）', async () => {
  const t = fake();
  t.vd.setActive(true);
  t.vd.setActive(false);
  t.vd.setActive(true);
  await t.vd.setActive(false);
  assert.deepEqual(t.sent, []);
  assert.equal(t.vd.state(), 'off');
  t.vd.setActive(false);
  await t.vd.setActive(true);
  assert.deepEqual(t.sent, ['DISPLAY ON']);
});

test('虚拟屏用的不是驱动支持的那档分辨率：改过去；已经对了、真显示器都不动', () => {
  const logs = [];
  const set = [];
  const modes = {
    DISPLAY54: { current: { width: 800, height: 600, frequency: 60 }, best: { width: 1920, height: 1080, frequency: 60 } },
    DISPLAY19: { current: { width: 1280, height: 720, frequency: 60 }, best: { width: 3840, height: 2160, frequency: 60 } },
  };
  const io = {
    displays: () => [
      { adapter: 'DISPLAY19', monitor: AOC.monitor },
      { adapter: 'DISPLAY54', monitor: VDD.monitor },
    ],
    modes: (a) => modes[a],
    setMode: (a, m) => (set.push([a, `${m.width}x${m.height}`]), 0),
    log: (m) => logs.push(m),
  };
  assert.equal(fitVirtualMode(io), 1);
  assert.deepEqual(set, [['DISPLAY54', '1920x1080']], '只改虚拟屏，真显示器的分辨率不碰');
  assert.ok(logs[0].includes('800x600') && logs[0].includes('1920x1080@60'), logs.join(' | '));
  modes.DISPLAY54.current = { width: 1920, height: 1080, frequency: 60 };
  assert.equal(fitVirtualMode(io), 0);
  assert.equal(set.length, 1);
});

test('改分辨率失败：记下错误，不算改了', () => {
  const logs = [];
  const n = fitVirtualMode({
    displays: () => [{ adapter: 'V', monitor: VDD.monitor }],
    modes: () => ({ current: { width: 800, height: 600, frequency: 60 }, best: { width: 1920, height: 1080, frequency: 60 } }),
    setMode: () => -2,
    log: (m) => logs.push(m),
  });
  assert.equal(n, 0);
  assert.ok(logs[0].includes('改不成') && logs[0].includes('-2'), logs.join(' | '));
});
