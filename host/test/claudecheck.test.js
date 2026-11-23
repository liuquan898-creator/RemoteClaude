'use strict';
/**
 * Claude 升级后自检（docs/07 第 8 节）：sessions/selfcheck.js 把新建、打开各走一遍；
 * claudecheck.js 决定什么时候跑、结果写到哪、要不要提醒手机。这里全用假的会话接口。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSelfCheck, describe, pickEnv, pickSession } = require('../sessions/selfcheck');
const { createClaudeCheck, claudeVersionOf, IDLE_S, RETRY_MS, NOTICE_KEY } = require('../claudecheck');
const { createApprovals } = require('../approvals');

const GROUPS = [
  { key: 'dir:x', name: 'scratch', env: null, sessions: [{ id: 'local_z', title: '没环境的', at: 900, open: false }] },
  {
    key: 'env:e1',
    name: 'RemoteClaude',
    env: 'e1',
    sessions: [
      { id: 'local_a', title: '开着的', at: 500, open: true },
      { id: 'local_b', title: '旧的', at: 100, open: false },
      { id: 'local_c', title: '最近没开着的', at: 400, open: false },
      { id: 'local_d', title: '', at: 999, open: false },
    ],
  },
  { key: 'env:e2', name: '周报', env: 'e2', sessions: [] },
];

/** 假的 host/sessions：记下做过的事；create、open 的返回值可以换 */
function fakeSessions(over = {}) {
  const calls = [];
  return {
    calls,
    busy: false,
    list: over.list || (() => ({ available: true, groups: GROUPS })),
    create: async (env) => (calls.push(['create', env]), over.create || { ok: true, hwnd: 9, title: '新会话', envOk: true, env: 'RemoteClaude' }),
    open: async (id) => (calls.push(['open', id]), over.open || { ok: true, hwnd: 10, title: '最近没开着的', created: true }),
    closeWindow: async (hwnd, title) => (calls.push(['close', hwnd, title]), over.close || { ok: true, title }),
  };
}

test('挑环境和会话：第一个有环境的分组；最近的、没开着的、有标题的会话', () => {
  assert.equal(pickEnv(GROUPS).env, 'e1');
  assert.equal(pickEnv([{ env: null }]), null);
  assert.equal(pickSession(GROUPS).id, 'local_z');
  assert.equal(pickSession([GROUPS[1]]).id, 'local_c');
  assert.equal(pickSession([{ sessions: [{ id: 'x', title: 't', open: true }] }]), null);
});

test('都走得通：新建一个再关掉，打开一个再关掉', async () => {
  const s = fakeSessions();
  const r = await runSelfCheck({ sessions: s, settleMs: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((x) => [x.name, x.ok]), [['catalog', true], ['new', true], ['open', true]]);
  assert.deepEqual(s.calls, [['create', 'e1'], ['close', 9, '新会话'], ['open', 'local_z'], ['close', 10, '最近没开着的']]);
  assert.equal(describe(r), '都通过了');
});

test('新建卡在菜单上：记下是哪一步，接着试打开', async () => {
  const s = fakeSessions({ create: { ok: false, code: 'ui-missing', step: 'menu' } });
  const r = await runSelfCheck({ sessions: s, settleMs: 0 });
  assert.equal(r.ok, false);
  const step = r.steps.find((x) => x.name === 'new');
  assert.equal(step.code, 'ui-missing');
  assert.equal(step.step, 'menu');
  assert.deepEqual(s.calls.map((c) => c[0]), ['create', 'open', 'close'], '新建没出窗口就不用关；打开照常试');
  assert.equal(describe(r), '新建会话没通过（ui-missing，卡在 menu）');
});

test('窗口建出来了但环境没选上：算没通过，窗口照样关掉', async () => {
  const s = fakeSessions({ create: { ok: true, hwnd: 9, title: '新会话', envOk: false, env: 'RemoteClaude', envFail: 'ui-missing: env-button' } });
  const r = await runSelfCheck({ sessions: s, settleMs: 0 });
  const step = r.steps.find((x) => x.name === 'new');
  assert.equal(step.ok, false);
  assert.equal(step.code, 'env-not-picked');
  assert.equal(step.step, 'ui-missing: env-button');
  assert.deepEqual(s.calls[1], ['close', 9, '新会话']);
});

test('打开的会话本来就开着：不关它；打开失败记下原因', async () => {
  const s = fakeSessions({ open: { ok: true, hwnd: 10, title: '最近没开着的', created: false } });
  await runSelfCheck({ sessions: s, settleMs: 0 });
  assert.ok(!s.calls.some((c) => c[0] === 'close' && c[1] === 10));

  const s2 = fakeSessions({ open: { ok: false, code: 'stuck' } });
  const r2 = await runSelfCheck({ sessions: s2, settleMs: 0 });
  assert.equal(r2.ok, false);
  assert.equal(describe(r2), '打开会话没通过（stuck）');
});

test('读不到 Claude 的会话记录：后面的不试', async () => {
  const s = fakeSessions({ list: () => ({ available: false, reason: 'no-claude', groups: [] }) });
  const r = await runSelfCheck({ sessions: s, settleMs: 0 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.steps, [{ name: 'catalog', ok: false, code: 'no-claude' }]);
  assert.deepEqual(s.calls, []);
});

test('没有环境、没有可开的会话：跳过，不算失败', async () => {
  const s = fakeSessions({ list: () => ({ available: true, groups: [{ key: 'scratch', name: '无文件夹', env: null, sessions: [] }] }) });
  const r = await runSelfCheck({ sessions: s, settleMs: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((x) => !!x.skipped), [false, true, true]);
});

test('从 claude.exe 的路径认版本', () => {
  assert.equal(claudeVersionOf('C:\\Program Files\\WindowsApps\\Claude_6.28899.2.0_x64__pzs8sxrjxfjjc\\app\\claude.exe'), '6.28899.2.0');
  assert.equal(claudeVersionOf('C:\\Users\\a\\AppData\\Local\\AnthropicClaude\\app-1.2.3\\claude.exe'), '1.2.3');
  assert.equal(claudeVersionOf('D:\\tools\\claude.exe', () => ({ mtimeMs: 1234.6 })), 'exe-1235');
  assert.equal(claudeVersionOf('D:\\tools\\claude.exe', () => { throw new Error('没有'); }), '');
  assert.equal(claudeVersionOf(''), '');
});

/** 假的电脑：Claude 版本、空不空闲都能改；自检结果按 results 依次给 */
function setup({ state = null, results = [{ ok: true, steps: [{ name: 'new', ok: true }] }] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-check-'));
  const stateFile = path.join(dir, 'RemoteClaude', 'selfcheck.json');
  if (state) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state));
  }
  const pc = { exe: 'C:\\WindowsApps\\Claude_6.2.0_x64__p\\app\\claude.exe', locked: false, viewers: 0, idle: 600, clock: 1000000, busy: false };
  const logs = [];
  const notices = new Map();
  let runs = 0;
  let before = 0;
  const check = createClaudeCheck({
    log: (m) => logs.push(m),
    stateFile,
    hostVersion: '0.9.11',
    claudeExe: () => pc.exe,
    sessions: {
      get busy() {
        return pc.busy;
      },
    },
    locked: () => pc.locked,
    viewers: () => pc.viewers,
    idleSeconds: () => pc.idle,
    before: () => (before += 1),
    notify: (k, n) => notices.set(k, n),
    clearNotice: (k) => notices.delete(k),
    now: () => pc.clock,
    selfCheck: async () => results[Math.min(runs++, results.length - 1)],
  });
  return { check, pc, logs, notices, stateFile, dir, runs: () => runs, before: () => before, saved: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
}

const BAD = { ok: false, steps: [{ name: 'new', ok: false, code: 'ui-missing', step: 'menu' }] };
const GOOD = { ok: true, steps: [{ name: 'new', ok: true }] };

test('第一次：空闲时自检一遍，结果写进状态文件；之后版本没变就不再跑', async (t) => {
  const s = setup();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const r = await s.check.tick();
  assert.equal(r.ok, true);
  assert.equal(s.before(), 1, '开始前打了招呼（让平铺别当成用户在切窗口）');
  assert.deepEqual(
    { claude: s.saved().claude, host: s.saved().host, ok: s.saved().ok, checkedAt: s.saved().checkedAt },
    { claude: '6.2.0', host: '0.9.11', ok: true, checkedAt: 1000000 }
  );
  assert.equal(await s.check.tick(), null);
  assert.equal(s.runs(), 1);
  assert.equal(s.notices.size, 0);
});

test('电脑不空闲就先不跑：锁屏、有人看画面、刚有人动过键鼠、正在打开会话', async (t) => {
  const s = setup();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  s.pc.locked = true;
  assert.equal(await s.check.tick(), null);
  s.pc.locked = false;
  s.pc.viewers = 1;
  assert.equal(await s.check.tick(), null);
  s.pc.viewers = 0;
  s.pc.idle = IDLE_S - 1;
  assert.equal(await s.check.tick(), null);
  s.pc.idle = IDLE_S;
  s.pc.busy = true;
  assert.equal(await s.check.tick(), null);
  assert.equal(s.runs(), 0);
  assert.equal(s.logs.filter((l) => l.includes('等电脑空闲')).length, 1, '"要自检"只说一遍');
  s.pc.busy = false;
  assert.ok(await s.check.tick());
});

test('Claude 没在运行（认不出版本）：不跑', async (t) => {
  const s = setup();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  s.pc.exe = '';
  assert.equal(await s.check.tick(), null);
  assert.equal(s.runs(), 0);
});

test('Claude 升级了：再自检；没通过就提醒手机，写明卡在哪', async (t) => {
  const s = setup({ state: { claude: '6.1.0', host: '0.9.11', ok: true, checkedAt: 1 }, results: [BAD] });
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const r = await s.check.tick();
  assert.equal(r.ok, false);
  assert.ok(s.logs.some((l) => l.includes('Claude 从 6.1.0 换成了 6.2.0')), s.logs.join(' / '));
  const saved = s.saved();
  assert.equal(saved.ok, false);
  assert.equal(saved.summary, '新建会话没通过（ui-missing，卡在 menu）');
  assert.deepEqual(saved.steps, BAD.steps);
  const n = s.notices.get(NOTICE_KEY);
  assert.ok(n && n.text.includes('6.2.0') && n.text.includes('卡在 menu'), JSON.stringify(n));
});

test('没通过以后：什么都没变就过 6 小时再试；被控端换了版本马上再试，通过了收回提醒', async (t) => {
  const s = setup({ state: { claude: '6.2.0', host: '0.9.11', ok: false, checkedAt: 1000000, summary: 'x', steps: [] }, results: [BAD, GOOD] });
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  assert.equal(await s.check.tick(), null, '刚失败过，不马上重试');
  s.pc.clock += RETRY_MS + 1;
  assert.equal((await s.check.tick()).ok, false);
  assert.ok(s.notices.has(NOTICE_KEY));
  assert.equal(await s.check.tick(), null);

  // 修好的被控端装上了（版本变了）：新的被控端读到旧结果，马上再试
  const fixed = createClaudeCheck({
    log: () => {},
    stateFile: s.stateFile,
    hostVersion: '0.9.12',
    claudeExe: () => s.pc.exe,
    sessions: { busy: false },
    locked: () => false,
    viewers: () => 0,
    idleSeconds: () => 600,
    notify: (k, n) => s.notices.set(k, n),
    clearNotice: (k) => s.notices.delete(k),
    now: () => s.pc.clock,
    selfCheck: async () => GOOD,
  });
  assert.equal((await fixed.tick()).ok, true);
  assert.equal(s.saved().host, '0.9.12');
  assert.equal(s.notices.size, 0, '通过了，提醒收回');
});

test('自检本身出错：算没通过，不让定时器崩掉', async (t) => {
  const s = setup();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const check = createClaudeCheck({
    log: () => {},
    stateFile: s.stateFile,
    hostVersion: '0.9.11',
    claudeExe: () => s.pc.exe,
    sessions: { busy: false },
    locked: () => false,
    viewers: () => 0,
    idleSeconds: () => 600,
    notify: (k, n) => s.notices.set(k, n),
    selfCheck: async () => {
      throw new Error('炸了');
    },
  });
  const r = await check.tick();
  assert.equal(r.ok, false);
  assert.equal(r.steps[0].detail, '炸了');
  assert.equal(check.running, false);
});

test('被控端自己发的提醒：和提问一起出现在列表里，手机上点了就收起，也能收回', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = [];
  const a = createApprovals({ log: (m) => logs.push(m), dir });
  const seen = [];
  a.onChange((list) => seen.push(list.map((x) => x.id)));

  a.notify('k1', { title: 'Claude 升级自检', tool: '自检没通过', header: '自检没通过', text: '新建会话没通过' });
  assert.equal(a.list.length, 1);
  const item = a.list[0];
  assert.match(item.id, /^[a-f0-9]{16}$/);
  assert.equal(item.kind, 'ask');
  assert.equal(item.title, 'Claude 升级自检');
  assert.equal(item.questions[0].question, '新建会话没通过');
  assert.deepEqual(item.questions[0].options.map((o) => o.label), ['知道了']);

  // 同一个 key 再发：换掉上一条
  a.notify('k1', { title: 'Claude 升级自检', text: '打开会话没通过' });
  assert.equal(a.list.length, 1);
  assert.notEqual(a.list[0].id, item.id);
  assert.deepEqual(a.answer(item.id, { choice: 'allow', answers: {} }), { ok: false, code: 'gone' });

  // 手机上点了：不管选了什么都收起
  assert.deepEqual(a.answer(a.list[0].id, { choice: 'allow', answers: { 打开会话没通过: '知道了' } }), { ok: true });
  assert.equal(a.list.length, 0);
  assert.ok(logs.some((l) => l.includes('收起了提醒')));

  a.notify('k2', { title: 't', text: 'x' });
  a.clearNotice('k2');
  a.clearNotice('没有这个');
  assert.equal(a.list.length, 0);
  assert.ok(seen.length >= 4);
});
