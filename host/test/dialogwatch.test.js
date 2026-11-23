'use strict';
/**
 * 桌面端自己弹的确认框提醒手机（docs/09 第 4 节）：dialogwatch.js 读 Claude 桌面端的日志，
 * 框出现几秒还在、插件又没把它当审批推出去，就发提醒。日志用临时文件，时钟、会话、审批都是假的。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createDialogWatch,
  createSessionRegistry,
  LogTail,
  LogParser,
  questionOf,
  noticeText,
  originIn,
  GRACE_MS,
  GRACE_OTHER_MS,
  SNOOZE_MS,
  CANARY_MISSES,
  PRESS_CONFIRM_MS,
  PRESS_RETRY_MS,
  PRESS_TRIES,
  OK_LABEL,
  SNOOZE_LABEL,
  ALLOW_LABEL,
  DENY_LABEL,
  ALWAYS_LABEL,
} = require('../dialogwatch');
const { createApprovals } = require('../approvals');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-dialog-'));
const pad = (n) => String(n).padStart(2, '0');
/** 桌面端日志的时间写法（本地时间，到秒） */
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const T0 = new Date(2026, 10, 21, 2, 56, 0).getTime();
const SESS = 'local_b460b9ec-c549-43f0-9330-cff5530aa77d';
const CLI = '810a9a64-6898-4fa7-b61d-8a044f38292d';
const REQ = '9fd1bd10-866d-43df-9d8b-9ca61bb242fa';

const askLine = (at, id = REQ, tool = 'browser:javascript_tool', sess = SESS) =>
  `${stamp(at)} [info] Emitted tool permission request ${id} for ${tool} in session ${sess}`;
const previewLines = (at, origin = 'https://uland.taobao.com') => [
  `${stamp(at)} [info] [Preview] cat3 per-action approval requested {`,
  `  origin: '${origin}',`,
  `  toolName: 'javascript_tool',`,
  '  action: undefined',
  '}',
];
const answeredLine = (at, id = REQ, how = 'once') => `${stamp(at)} [info] Received permission response for ${id}: ${how} (tool: browser:javascript_tool)`;
const abortedLine = (at, id = REQ, tool = 'AskUserQuestion') => `${stamp(at)} [info] Permission request ${id} for ${tool} aborted`;
/** 定时任务的框没人答，桌面端自己按拒绝处理时写的那一行（2026-11-21 的真日志） */
const unansweredLine = (at, sess = SESS) =>
  `${stamp(at)} [warn] [CCD] Session ${sess}: denied 1 permission prompt(s) unanswered for 2922s on a scheduled-task run (process untouched)`;

/** 一套假环境：日志文件、时钟、会话登记、插件的审批、收到的提醒 */
function setup(over = {}) {
  const dir = tmp();
  const file = path.join(dir, 'main.log');
  if (over.backlog) fs.writeFileSync(file, over.backlog.join('\n') + '\n');
  else fs.writeFileSync(file, '');
  const env = {
    file,
    dir,
    now: T0,
    sessions: { [SESS]: { cli: CLI, title: '高尔夫多摄像头分析系统', alive: true, startedAt: T0 - 3600000 } },
    approvals: [],
    notices: new Map(),
    logs: [],
    /** 桌面端往日志里写了几行，被控端这一秒就读到 */
    write: (...lines) => {
      fs.appendFileSync(file, lines.flat().join('\n') + '\n');
      env.watch.tick();
    },
  };
  if (over.startedAt !== undefined) env.sessions[SESS].startedAt = over.startedAt;
  env.watch = createDialogWatch({
    log: (m) => env.logs.push(m),
    logFile: () => file,
    sessionOf: (id) => env.sessions[id] || { cli: '', title: '', alive: null, startedAt: 0 },
    sessionOfCli: (cli) => {
      const hit = Object.entries(env.sessions).find(([, s]) => s.cli === cli);
      return hit ? { local: hit[0], desktop: hit[1].desktop !== false } : { local: '', desktop: false };
    },
    approvals: () => env.approvals,
    notify: (key, n) => env.notices.set(key, n),
    clearNotice: (key) => env.notices.delete(key),
    press: over.press,
    inspect: over.inspect,
    now: () => env.now,
  });
  /** 时钟往前走 ms，每秒跑一轮 */
  env.advance = (ms) => {
    for (let left = ms; left > 0; left -= 1000) {
      env.now += Math.min(1000, left);
      env.watch.tick();
    }
  };
  env.watch.tick(); // 启动时读一遍
  return env;
}

test('日志行变成事件：弹框、点了、撤回、桌面端重启', () => {
  const p = new LogParser();
  const feed = (lines) => lines.map((l) => p.feed(l)).filter(Boolean);
  const evs = feed([
    ...previewLines(T0),
    askLine(T0),
    `${stamp(T0 + 1000)} [info] LocalSessions.respondToToolPermission: requestId=${REQ}, decision=once, hasUpdatedInput=true`,
    answeredLine(T0 + 1000),
    askLine(T0 + 2000, 'aaaaaaaa-0000-0000-0000-000000000001', 'AskUserQuestion'),
    abortedLine(T0 + 3000, 'aaaaaaaa-0000-0000-0000-000000000001'),
    `${stamp(T0 + 4000)} [info] Starting app {`,
    `${stamp(T0 + 5000)} [info] [git-worker] 无关的一行`,
  ]);
  assert.deepEqual(evs, [
    { type: 'ask', id: REQ, tool: 'browser:javascript_tool', session: SESS, origin: 'https://uland.taobao.com', at: T0 },
    { type: 'done', id: REQ, how: 'once' },
    { type: 'done', id: REQ, how: 'once' },
    { type: 'ask', id: 'aaaaaaaa-0000-0000-0000-000000000001', tool: 'AskUserQuestion', session: SESS, origin: '', at: T0 + 2000 },
    { type: 'done', id: 'aaaaaaaa-0000-0000-0000-000000000001', how: 'aborted' },
    { type: 'restart' },
  ]);
});

test('网址只认紧挨着的那一段：隔久了、不是浏览器的框都不带', () => {
  const p = new LogParser();
  for (const l of previewLines(T0)) p.feed(l);
  assert.equal(p.feed(askLine(T0 + 10000)).origin, '');
  for (const l of previewLines(T0 + 20000)) p.feed(l);
  assert.equal(p.feed(askLine(T0 + 20000, REQ, 'PowerShell')).origin, '');
  // 用过一次就清掉，下一个框不会沿用
  for (const l of previewLines(T0 + 30000)) p.feed(l);
  assert.equal(p.feed(askLine(T0 + 30000)).origin, 'https://uland.taobao.com');
  assert.equal(p.feed(askLine(T0 + 30000, 'bbbbbbbb-0000-0000-0000-000000000002')).origin, '');
});

test('增量读日志：只给完整的行，写了一半的留到下一次', () => {
  const dir = tmp();
  const file = path.join(dir, 'main.log');
  fs.writeFileSync(file, 'a\nb\n');
  const tail = new LogTail(file);
  assert.deepEqual(tail.read(), { lines: ['a', 'b'], first: true });
  fs.appendFileSync(file, 'c\r\n半');
  assert.deepEqual(tail.read(), { lines: ['c'], first: false });
  fs.appendFileSync(file, '行\n');
  assert.deepEqual(tail.read(), { lines: ['半行'], first: false });
  assert.deepEqual(tail.read(), { lines: [], first: false });
});

test('增量读日志：启动时只读末尾一段，第一行被截断就丢掉', () => {
  const dir = tmp();
  const file = path.join(dir, 'main.log');
  fs.writeFileSync(file, '0123456789\nabc\ndef\n');
  const tail = new LogTail(file, 10);
  assert.deepEqual(tail.read(), { lines: ['abc', 'def'], first: true });
});

test('增量读日志：日志满了换新文件，旧文件剩下的和新文件都读到', () => {
  const dir = tmp();
  const file = path.join(dir, 'main.log');
  fs.writeFileSync(file, '第一行\n第二行\n');
  const tail = new LogTail(file);
  tail.read();
  fs.appendFileSync(file, '轮换前最后一行\n');
  fs.renameSync(file, path.join(dir, 'main1.log'));
  fs.writeFileSync(file, '新文件第一行\n');
  assert.deepEqual(tail.read().lines, ['轮换前最后一行', '新文件第一行']);
  fs.appendFileSync(file, '新文件第二行\n');
  assert.deepEqual(tail.read().lines, ['新文件第二行']);
});

test('浏览器的确认框：出现几秒还在就提醒手机，电脑上点了就收回', () => {
  const env = setup();
  env.write(previewLines(env.now), askLine(env.now));
  env.advance(GRACE_MS - 1000);
  assert.equal(env.notices.size, 0);
  env.advance(1000);
  assert.equal(env.notices.size, 1);
  const n = env.notices.get('dialog:' + REQ);
  assert.equal(n.title, '高尔夫多摄像头分析系统');
  assert.equal(n.tool, '电脑上有确认框在等你');
  assert.match(n.text, /允许 Claude 在 uland\.taobao\.com 上执行 JavaScript？/);
  assert.match(n.text, /点开这个会话的画面/);
  assert.deepEqual(n.options.map((o) => o.label), [OK_LABEL, SNOOZE_LABEL]);
  assert.ok(env.logs.some((l) => l.includes('提醒手机') && l.includes('browser:javascript_tool')));

  env.write(answeredLine(env.now));
  env.advance(1000);
  assert.equal(env.notices.size, 0);
  assert.equal(env.watch.pending.length, 0);
  assert.ok(env.logs.some((l) => l.includes('电脑上点了（once）')));
});

test('很快就点了的框不提醒', () => {
  const env = setup();
  env.write(askLine(env.now));
  env.advance(1000);
  env.write(answeredLine(env.now));
  env.advance(GRACE_MS + 5000);
  assert.equal(env.notices.size, 0);
});

test('插件已经推到手机的审批不重复提醒；批完框还在才提醒', () => {
  const env = setup();
  const id = 'cccccccc-0000-0000-0000-000000000003';
  env.write(askLine(env.now, id, 'AskUserQuestion'));
  env.advance(3000);
  env.approvals = [{ id: 'a1', sessionId: CLI, createdAt: env.now }]; // 钩子比桌面端的框晚几秒
  env.advance(GRACE_OTHER_MS + 20000);
  assert.equal(env.notices.size, 0);
  // 手机上答了：插件的审批没了，桌面端随即撤回这个框
  env.approvals = [];
  env.advance(1000);
  env.write(abortedLine(env.now, id));
  env.advance(GRACE_OTHER_MS + 5000);
  assert.equal(env.notices.size, 0);
  assert.equal(env.watch.pending.length, 0);
});

test('插件没管的普通确认框：等久一点也提醒，说明多半是没加载插件', () => {
  const env = setup();
  const id = 'dddddddd-0000-0000-0000-000000000004';
  env.write(askLine(env.now, id, 'PowerShell'));
  env.advance(GRACE_OTHER_MS - 1000);
  assert.equal(env.notices.size, 0);
  env.advance(1000);
  const n = env.notices.get('dialog:' + id);
  assert.ok(n);
  assert.match(n.text, /Claude 申请使用 PowerShell/);
  assert.match(n.text, /没有加载 RemoteClaude 插件/);
});

test('日志行变成事件：定时任务的框没人答，桌面端自己按拒绝处理', () => {
  const p = new LogParser();
  assert.deepEqual(p.feed(unansweredLine(T0)), { type: 'unanswered', session: SESS });
  // 同一时刻别的几行不算
  assert.equal(p.feed(`${stamp(T0)} [info] [CCD CycleHealth] healthy cycle for ${SESS} (2933s, hadFirstResponse=true)`), null);
  assert.equal(p.feed(`${stamp(T0)} [info] [CCDScheduledTasks] A run failed; not retried`), null);
});

test('定时任务的框插件推到了手机、没人答，桌面端自己按拒绝处理：不提醒（2026-11-21 误报过两次）', () => {
  const env = setup();
  const id = 'dddddddd-0000-0000-0000-000000000014';
  env.write(askLine(env.now, id, 'PowerShell'));
  env.advance(3000);
  env.approvals = [{ id: 'a1', sessionId: CLI, createdAt: env.now }];
  env.advance(2922000);
  assert.equal(env.notices.size, 0);
  // 桌面端按拒绝处理：只有按会话记的一行，没有这个框的结果；十几秒后插件的审批也没了，会话进程还在
  env.write(unansweredLine(env.now));
  assert.equal(env.watch.pending.length, 0);
  env.advance(15000);
  env.approvals = [];
  env.advance(GRACE_OTHER_MS + 60000);
  assert.equal(env.notices.size, 0);
  assert.equal(env.logs.filter((m) => /没人答，Claude 自己按拒绝处理了/.test(m)).length, 1);
});

test('已经提醒过的框（会话没加载插件）被桌面端按拒绝处理：收回提醒，别的会话的框不动', () => {
  const env = setup();
  const other = 'local_00000000-0000-0000-0000-00000000eeee';
  env.sessions[other] = { cli: 'cli-other', title: '另一个会话', alive: true, startedAt: T0 - 3600000 };
  env.write(askLine(env.now, 'dddddddd-0000-0000-0000-000000000015', 'PowerShell'));
  env.write(askLine(env.now, 'dddddddd-0000-0000-0000-000000000016', 'PowerShell', other));
  env.advance(GRACE_OTHER_MS);
  assert.equal(env.notices.size, 2);
  env.write(unansweredLine(env.now));
  assert.deepEqual([...env.notices.keys()], ['dialog:dddddddd-0000-0000-0000-000000000016']);
  assert.deepEqual(env.watch.pending.map((p) => p.session), [other]);
});

test('插件推到过手机的框，手机上那条没了、日志里却没有结果：不提醒，只记一次日志', () => {
  const env = setup();
  env.write(askLine(env.now, 'dddddddd-0000-0000-0000-000000000017', 'PowerShell'));
  env.advance(4000);
  env.approvals = [{ id: 'a1', sessionId: CLI, createdAt: env.now }];
  env.advance(600000);
  env.approvals = [];
  env.advance(GRACE_OTHER_MS + 600000);
  assert.equal(env.notices.size, 0);
  assert.equal(env.logs.filter((m) => /手机上的审批已经没了/.test(m)).length, 1);
});

test('同一个会话里早就挂着的审批不是这个框的：它在的时候不提醒，它没了框还在就提醒', () => {
  const env = setup();
  const id = 'dddddddd-0000-0000-0000-000000000018';
  env.approvals = [{ id: 'old', sessionId: CLI, createdAt: env.now - 600000 }];
  env.write(askLine(env.now, id, 'computer:request_access'));
  env.advance(GRACE_OTHER_MS + 30000);
  assert.equal(env.notices.size, 0);
  env.approvals = [];
  env.advance(GRACE_OTHER_MS);
  assert.ok(env.notices.get('dialog:' + id));
});

test('不知道是哪个 Claude Code 会话时：浏览器的框照样提醒，别的不提醒（分不清插件管没管）', () => {
  const env = setup();
  const other = 'local_00000000-0000-0000-0000-00000000ffff';
  env.write(askLine(env.now, 'eeeeeeee-0000-0000-0000-000000000005', 'PowerShell', other));
  env.write(askLine(env.now, 'eeeeeeee-0000-0000-0000-000000000006', 'browser:open_site', other));
  env.advance(GRACE_OTHER_MS + 2000);
  assert.deepEqual([...env.notices.keys()], ['dialog:eeeeeeee-0000-0000-0000-000000000006']);
  const n = env.notices.get('dialog:eeeeeeee-0000-0000-0000-000000000006');
  assert.equal(n.title, 'Claude');
  assert.match(n.text, /允许 Claude 操作一个新网站？/);
});

test('手机上点"知道了"就不再提醒这个框；点"过 5 分钟再提醒"到时候还在就再发', () => {
  const env = setup();
  env.write(askLine(env.now));
  env.advance(GRACE_MS);
  let n = env.notices.get('dialog:' + REQ);
  env.notices.delete('dialog:' + REQ); // 手机答了，审批模块收起提醒
  n.onAnswer(SNOOZE_LABEL);
  env.advance(SNOOZE_MS - 1000);
  assert.equal(env.notices.size, 0);
  env.advance(1000);
  n = env.notices.get('dialog:' + REQ);
  assert.ok(n, '5 分钟后框还在，再提醒一次');
  assert.match(n.text, /已经等了 5 分钟/);

  env.notices.delete('dialog:' + REQ);
  n.onAnswer(OK_LABEL);
  env.advance(SNOOZE_MS * 3);
  assert.equal(env.notices.size, 0);
  assert.equal(env.watch.pending.length, 1, '框还在，只是不再提醒');
});

test('会话进程不在了、桌面端重启了：收回提醒', () => {
  const env = setup();
  env.write(askLine(env.now));
  env.advance(GRACE_MS);
  assert.equal(env.notices.size, 1);
  env.sessions[SESS].alive = false;
  env.advance(1000);
  assert.equal(env.notices.size, 0);
  assert.equal(env.watch.pending.length, 0);

  env.sessions[SESS].alive = true;
  env.write(askLine(env.now, 'ffffffff-0000-0000-0000-000000000007'));
  env.advance(GRACE_MS);
  assert.equal(env.notices.size, 1);
  env.write(`${stamp(env.now)} [info] Starting app {`);
  env.advance(1000);
  assert.equal(env.notices.size, 0);
});

test('被控端启动时已经在等的框：会话进程还在就马上提醒', () => {
  const env = setup({ backlog: [...previewLines(T0 - 7200000), askLine(T0 - 7200000)], startedAt: T0 - 3 * 3600000 });
  env.advance(1000);
  const n = env.notices.get('dialog:' + REQ);
  assert.ok(n);
  assert.match(n.text, /已经等了 120 分钟/);
});

test('被控端启动时往回读到的旧框：已经有结果的、进程重启过的、确认不了会话在不在的都不提醒', () => {
  // 已经有结果
  let env = setup({ backlog: [askLine(T0 - 60000), answeredLine(T0 - 50000)] });
  env.advance(2000);
  assert.equal(env.notices.size, 0);
  // 弹框之后会话进程重启过（进程启动时间比框晚）
  env = setup({ backlog: [askLine(T0 - 7200000)] });
  env.advance(2000);
  assert.equal(env.notices.size, 0);
  assert.equal(env.watch.pending.length, 0);
  // 登记里没有这个会话
  env = setup({ backlog: [askLine(T0 - 60000, REQ, 'browser:zoom', 'local_00000000-0000-0000-0000-00000000ffff')] });
  env.advance(2000);
  assert.equal(env.notices.size, 0);
  // 弹框之后桌面端重启过
  env = setup({ backlog: [askLine(T0 - 60000), `${stamp(T0 - 30000)} [info] Starting app {`] });
  env.advance(2000);
  assert.equal(env.notices.size, 0);
});

test('自己验证：插件的审批连着在日志里对不上，提醒一次"确认框提醒可能失效"', () => {
  const env = setup();
  for (let i = 0; i < CANARY_MISSES; i++) {
    env.approvals = [{ id: 'm' + i, sessionId: CLI, createdAt: env.now }];
    env.advance(8000);
    env.approvals = [];
    env.advance(120000);
  }
  const n = env.notices.get('dialog-watch-broken');
  assert.ok(n);
  assert.match(n.text, /可能收不到提醒/);
  assert.ok(env.logs.some((l) => l.includes('对不上')));
  // 只提醒一次
  env.notices.clear();
  env.approvals = [{ id: 'again', sessionId: CLI, createdAt: env.now }];
  env.advance(8000);
  assert.equal(env.notices.size, 0);
});

test('自己验证：对得上就清零；终端里的 Claude Code 会话不算', () => {
  const env = setup();
  for (let i = 0; i < CANARY_MISSES * 2; i++) {
    const id = `abcdef${pad(i)}-0000-0000-0000-000000000000`;
    // 偶数次日志里有对应的一行，奇数次没有：对不上的从来没有连着出现
    if (i % 2 === 0) env.write(askLine(env.now, id, 'AskUserQuestion'));
    env.advance(3000);
    env.approvals = [{ id: 'p' + i, sessionId: CLI, createdAt: env.now }];
    env.advance(8000);
    env.approvals = [];
    if (i % 2 === 0) env.write(abortedLine(env.now, id));
    env.advance(120000);
  }
  assert.equal(env.notices.has('dialog-watch-broken'), false);

  env.sessions[SESS].desktop = false;
  for (let i = 0; i < CANARY_MISSES + 2; i++) {
    env.approvals = [{ id: 't' + i, sessionId: CLI, createdAt: env.now }];
    env.advance(8000);
    env.approvals = [];
    env.advance(120000);
  }
  assert.equal(env.notices.has('dialog-watch-broken'), false);
});

test('没找到桌面端的日志：只记一次，不出错', () => {
  const logs = [];
  const watch = createDialogWatch({
    log: (m) => logs.push(m),
    logFile: () => '',
    sessionOf: () => ({ cli: '', title: '', alive: null, startedAt: 0 }),
    approvals: () => [],
    notify: () => assert.fail('不该提醒'),
    clearNotice: () => {},
    now: () => T0,
  });
  watch.tick();
  watch.tick();
  assert.equal(logs.filter((l) => l.includes('没找到')).length, 1);
});

test('提醒里的话', () => {
  assert.equal(questionOf('browser:javascript_tool', 'https://uland.taobao.com'), '允许 Claude 在 uland.taobao.com 上执行 JavaScript？');
  assert.equal(questionOf('browser:open_site', 'https://s.taobao.com'), '允许 Claude 操作 https://s.taobao.com？');
  assert.equal(questionOf('browser:screenshot', ''), '允许 Claude 在网页上截图？');
  assert.equal(questionOf('browser:whatever', 'https://a.example'), '允许 Claude 在 a.example 上操作页面？');
  assert.equal(questionOf('AskUserQuestion', ''), 'Claude 有问题要问你');
  assert.match(noticeText('browser:zoom', 'https://youtube.com', 4000), /已经等了 4 秒/);
  assert.match(noticeText('browser:zoom', 'https://youtube.com', 600000), /已经等了 10 分钟/);
});

test('会话登记：按桌面端会话编号找到 Claude Code 会话、标题、进程在不在', () => {
  const dir = tmp();
  const write = (pid, j) => fs.writeFileSync(path.join(dir, pid + '.json'), JSON.stringify({ pid, ...j }));
  write(100, { sessionId: CLI, hostSessionId: SESS, name: '旧进程', startedAt: 1000, entrypoint: 'claude-desktop' });
  write(200, { sessionId: CLI, hostSessionId: SESS, name: '高尔夫多摄像头分析系统', startedAt: 2000, entrypoint: 'claude-desktop' });
  write(300, { sessionId: 'cli-term', name: '终端里的', startedAt: 3000, entrypoint: 'cli' });
  fs.writeFileSync(path.join(dir, '200.abcdef.key'), 'x');
  fs.writeFileSync(path.join(dir, '400.json'), '{坏的');
  const reg = createSessionRegistry({ dir, alive: (pid) => pid !== 100, now: () => 5000 });
  assert.deepEqual(reg.byLocal(SESS), { cli: CLI, title: '高尔夫多摄像头分析系统', alive: true, startedAt: 2000, local: SESS, desktop: true });
  assert.deepEqual(reg.byCli('cli-term'), { cli: 'cli-term', title: '终端里的', alive: true, startedAt: 3000, local: '', desktop: false });
  assert.equal(reg.byLocal('local_nobody').alive, null);
  // 只剩死掉的进程：知道它不在了
  const dead = createSessionRegistry({ dir, alive: () => false, now: () => 5000 });
  assert.equal(dead.byLocal(SESS).alive, false);
});

test('审批模块：提醒可以带选项，手机选了哪个会告诉发提醒的一方；插件旧钩子的"卡住"提醒不再转给手机', () => {
  const dir = tmp();
  const approvals = createApprovals({ log: () => {}, dir });
  let picked = null;
  approvals.notify('dialog:x', {
    title: '会话',
    text: '电脑上弹出了确认框',
    tool: '电脑上有确认框在等你',
    options: [{ label: OK_LABEL, description: '' }, { label: SNOOZE_LABEL, description: '' }],
    onAnswer: (label) => (picked = label),
  });
  const item = approvals.list[0];
  assert.deepEqual(item.questions[0].options.map((o) => o.label), [OK_LABEL, SNOOZE_LABEL]);
  assert.deepEqual(approvals.answer(item.id, { choice: 'allow', answers: { [item.questions[0].question]: SNOOZE_LABEL } }), { ok: true });
  assert.equal(picked, SNOOZE_LABEL);
  assert.equal(approvals.list.length, 0);

  // 插件写的：一条普通审批、一条 1.0.9 的"卡住"提醒
  const req = (id, extra) => fs.writeFileSync(path.join(dir, id + '.pending.json'), JSON.stringify({ id, kind: 'permission', sessionId: CLI, tool: 'PowerShell', createdAt: 5, ...extra }));
  req('0123456789abcdef');
  req('fedcba9876543210', { kind: 'ask', notice: true, tool: '电脑上有确认框在等你' });
  approvals.notify('k', { title: 't', text: 'x' }); // 顺便触发一次扫描
  assert.deepEqual(approvals.list.map((x) => x.tool).sort(), ['PowerShell', '提醒']);
  assert.deepEqual(approvals.pending(), [{ id: '0123456789abcdef', sessionId: CLI, tool: 'PowerShell', createdAt: 5 }]);
});

// ---------------------------------------------------------------- 在手机上直接答（被控端替用户按电脑上的按钮）

/** 让"去按按钮"的那几步异步操作走完 */
const settle = () => new Promise((r) => setImmediate(r));
/** 时钟往前走 ms，每秒跑一轮，每轮之后让异步操作走完 */
async function advanceAsync(env, ms) {
  for (let left = ms; left > 0; left -= 1000) {
    env.now += Math.min(1000, left);
    env.watch.tick();
    await settle();
  }
}
/** 手机上答了这条提醒：审批模块先收起它，再把选的选项告诉发提醒的一方 */
function answer(env, key, label) {
  const n = env.notices.get(key);
  env.notices.delete(key);
  n.onAnswer(label);
}

test('被控端能替用户按时：浏览器的框带"允许一次""拒绝"，选了就去按，日志里有了结果就完事', async () => {
  const presses = [];
  const env = setup({ press: async (req) => (presses.push(req), { ok: true }) });
  env.write(previewLines(env.now), askLine(env.now));
  env.advance(GRACE_MS);
  const n = env.notices.get('dialog:' + REQ);
  assert.deepEqual(n.options.map((o) => o.label), [ALLOW_LABEL, DENY_LABEL, OK_LABEL]);
  assert.match(n.text, /可以直接在这里选"允许一次"或"拒绝"/);
  assert.match(n.text, /想先看 Claude 要发送的具体内容，就点开这个会话的画面/);

  answer(env, 'dialog:' + REQ, ALLOW_LABEL);
  await settle();
  assert.deepEqual(presses, [{ session: SESS, choice: 'allow', expect: 'uland.taobao.com', tool: 'browser:javascript_tool' }]);
  env.advance(1000);
  assert.equal(env.notices.size, 0, '正在等结果，不再提醒');
  assert.equal(env.watch.pending[0].pressing, true);

  env.write(answeredLine(env.now));
  env.advance(PRESS_CONFIRM_MS + 5000);
  assert.equal(env.notices.size, 0);
  assert.equal(env.watch.pending.length, 0);
  assert.ok(env.logs.some((l) => l.includes('按好了') && l.includes(ALLOW_LABEL) && l.includes('once')));
});

test('选"拒绝"按的是拒绝；不知道网站名（打开新网站的框）就不带要核对的网站名', async () => {
  const presses = [];
  const env = setup({ press: async (req) => (presses.push(req), { ok: true }) });
  env.write(askLine(env.now, REQ, 'browser:open_site'));
  env.advance(GRACE_MS);
  answer(env, 'dialog:' + REQ, DENY_LABEL);
  await settle();
  assert.deepEqual(presses, [{ session: SESS, choice: 'deny', expect: '', tool: 'browser:open_site' }]);
});

test('没按成：马上再提醒一次，开头说明原因，可以再选一次', async () => {
  const results = [{ ok: false, code: 'ui-missing', step: 'dialog-buttons' }, { ok: true }];
  const env = setup({ press: async () => results.shift() });
  env.write(previewLines(env.now), askLine(env.now));
  env.advance(GRACE_MS);
  answer(env, 'dialog:' + REQ, ALLOW_LABEL);
  await settle();
  env.advance(1000);
  let n = env.notices.get('dialog:' + REQ);
  assert.ok(n, '没按成，再提醒');
  assert.match(n.text, /^刚才选的"允许一次"没按成：没在这个会话的窗口里找到确认框的按钮。/);
  assert.deepEqual(n.options.map((o) => o.label), [ALLOW_LABEL, DENY_LABEL, OK_LABEL]);
  assert.ok(env.logs.some((l) => l.includes('没按成') && l.includes('没在这个会话的窗口里找到')));

  // 再选一次，这次按成了
  answer(env, 'dialog:' + REQ, ALLOW_LABEL);
  await settle();
  env.write(answeredLine(env.now));
  env.advance(3000);
  assert.equal(env.notices.size, 0);
  assert.equal(env.watch.pending.length, 0);
});

test('第一次按只是把焦点移到按钮上、第二次才成：两秒没结果自动再按一次，手机上只用选一次', async () => {
  let presses = 0;
  const env = setup({ press: async () => (presses++, { ok: true }) });
  env.write(previewLines(env.now), askLine(env.now));
  env.advance(GRACE_MS);
  answer(env, 'dialog:' + REQ, ALLOW_LABEL);
  await settle();
  assert.equal(presses, 1);
  await advanceAsync(env, PRESS_RETRY_MS - 1000);
  assert.equal(presses, 1, '还没到两秒');
  await advanceAsync(env, 1000);
  assert.equal(presses, 2, '两秒了日志里还没有结果，再按一次');
  assert.ok(env.logs.some((l) => l.includes('再按一次')));
  env.write(answeredLine(env.now)); // 第二次按下去，桌面端记了结果
  await advanceAsync(env, PRESS_CONFIRM_MS + 3000);
  assert.equal(presses, 2);
  assert.equal(env.notices.size, 0, '没有"没按成"的提醒');
  assert.equal(env.watch.pending.length, 0);
  assert.ok(env.logs.some((l) => l.includes('按好了')));
});

test('按了两次桌面端的日志里还是没有结果：过几秒当成没按成，再提醒', async () => {
  let presses = 0;
  const env = setup({ press: async () => (presses++, { ok: true }) });
  env.write(askLine(env.now));
  env.advance(GRACE_MS);
  answer(env, 'dialog:' + REQ, ALLOW_LABEL);
  await settle();
  await advanceAsync(env, PRESS_RETRY_MS);
  assert.equal(presses, PRESS_TRIES);
  await advanceAsync(env, PRESS_CONFIRM_MS);
  assert.equal(presses, PRESS_TRIES, '不会一直按下去');
  assert.equal(env.notices.size, 0, '还在等日志里的结果');
  await advanceAsync(env, 2000);
  const n = env.notices.get('dialog:' + REQ);
  assert.ok(n);
  assert.match(n.text, /没按成：按了按钮，但 Claude 那边没有反应。/);
});

test('第一次按完框就有了结果：不再按第二次（免得按到下一个框上）', async () => {
  let presses = 0;
  const env = setup({ press: async () => (presses++, { ok: true }) });
  env.write(askLine(env.now));
  env.advance(GRACE_MS);
  answer(env, 'dialog:' + REQ, ALLOW_LABEL);
  await settle();
  env.write(answeredLine(env.now));
  // 同一个会话紧接着又弹了一个框
  const next = 'eeeeeeee-0000-0000-0000-000000000009';
  env.write(askLine(env.now, next));
  await advanceAsync(env, PRESS_RETRY_MS + PRESS_CONFIRM_MS + 3000);
  assert.equal(presses, 1);
  assert.deepEqual([...env.notices.keys()], ['dialog:' + next], '新的框照常提醒，等用户自己选');
});

test('各种没按成的原因都说人话；去按的时候出了错也只是再提醒', async () => {
  for (const [code, words] of [
    ['locked', /电脑锁着屏/],
    ['busy', /正在打开别的会话/],
    ['mismatch', /不是同一个/],
    ['stuck', /没能把这个会话的窗口开出来/],
    ['timeout', /界面自动化没有正常返回/],
  ]) {
    const env = setup({ press: async () => ({ ok: false, code }) });
    env.write(askLine(env.now));
    env.advance(GRACE_MS);
    answer(env, 'dialog:' + REQ, DENY_LABEL);
    await settle();
    env.advance(1000);
    assert.match(env.notices.get('dialog:' + REQ).text, words, code);
    assert.match(env.notices.get('dialog:' + REQ).text, /^刚才选的"拒绝"没按成/);
  }
  const env = setup({
    press: async () => {
      throw new Error('炸了');
    },
  });
  env.write(askLine(env.now));
  env.advance(GRACE_MS);
  answer(env, 'dialog:' + REQ, ALLOW_LABEL);
  await settle();
  env.advance(1000);
  assert.match(env.notices.get('dialog:' + REQ).text, /没按成：被控端出错。/);
});

test('正在去按的时候，用户自己在电脑上点了：不算没按成，也不再提醒', async () => {
  let finish;
  const env = setup({ press: () => new Promise((r) => (finish = r)) });
  env.write(askLine(env.now));
  env.advance(GRACE_MS);
  answer(env, 'dialog:' + REQ, ALLOW_LABEL);
  await settle();
  env.write(answeredLine(env.now, REQ, 'once')); // 框已经有结果了
  finish({ ok: false, code: 'ui-missing' }); // 这时去按的那一步才回来说没找到按钮
  await settle();
  env.advance(PRESS_CONFIRM_MS + 5000);
  assert.equal(env.notices.size, 0);
  assert.equal(env.watch.pending.length, 0);
});

const OPEN_SITE_TEXT = '允许 Claude 操作 https://item.taobao.com？未经您的确认，Claude 不会进行购买、创建账户或绕过验证码。 “允许一次”仅对当前页面有效。可在“设置”中撤销“始终允许”。';

test('第一次打开某个网站的框（日志里没有网址）：提醒之前先从窗口里读出是哪个网站，按的时候也拿它核对', async () => {
  const presses = [];
  const looks = [];
  const env = setup({
    press: async (req) => (presses.push(req), { ok: true }),
    inspect: async (session) => (looks.push(session), { ok: true, text: OPEN_SITE_TEXT, menu: true }),
  });
  env.write(askLine(env.now, REQ, 'browser:open_site'));
  await advanceAsync(env, GRACE_MS + 1000);
  assert.deepEqual(looks, [SESS], '只读一次');
  const n = env.notices.get('dialog:' + REQ);
  assert.ok(n);
  assert.match(n.text, /允许 Claude 操作 https:\/\/item\.taobao\.com？/);
  assert.doesNotMatch(n.text, /看不到/);
  assert.ok(env.logs.some((l) => l.includes('提醒手机') && l.includes('https://item.taobao.com')));

  answer(env, 'dialog:' + REQ, ALLOW_LABEL);
  await settle();
  assert.deepEqual(presses, [{ session: SESS, choice: 'allow', expect: 'item.taobao.com', tool: 'browser:open_site' }]);
});

test('读不出是哪个网站（会话没有开着的窗口、读的时候出错、迟迟不回来）：照样提醒，写明这里看不到网站', async () => {
  for (const inspect of [
    async () => ({ ok: false, code: 'no-window' }),
    async () => {
      throw new Error('炸了');
    },
    () => new Promise(() => {}),
  ]) {
    const env = setup({ press: async () => ({ ok: true }), inspect });
    env.write(askLine(env.now, REQ, 'browser:open_site'));
    await advanceAsync(env, GRACE_MS + 10000);
    const n = env.notices.get('dialog:' + REQ);
    assert.ok(n, '读不到也要提醒');
    assert.match(n.text, /允许 Claude 操作一个新网站？/);
    assert.match(n.text, /是哪个网站，这里看不到，要点开这个会话的画面才知道。/);
    assert.deepEqual(n.options.map((o) => o.label), [ALLOW_LABEL, DENY_LABEL, OK_LABEL]);
  }
});

test('第一次打开某个网站的框上有"始终允许"：读出了网站名就多给这个选项，选了按的是"始终允许"', async () => {
  const presses = [];
  const env = setup({
    press: async (req) => (presses.push(req), { ok: true }),
    inspect: async () => ({ ok: true, text: OPEN_SITE_TEXT, menu: true, always: true }),
  });
  env.write(askLine(env.now, REQ, 'browser:open_site'));
  await advanceAsync(env, GRACE_MS + 1000);
  const n = env.notices.get('dialog:' + REQ);
  assert.deepEqual(n.options.map((o) => o.label), [ALLOW_LABEL, ALWAYS_LABEL, DENY_LABEL, OK_LABEL]);
  assert.match(n.options[1].description, /以后 Claude 操作 item\.taobao\.com 不再问/);
  assert.match(n.text, /可以直接在这里选"允许一次""始终允许"或"拒绝"/);
  assert.match(n.text, /"始终允许"是长期授权/);

  answer(env, 'dialog:' + REQ, ALWAYS_LABEL);
  await settle();
  assert.deepEqual(presses, [{ session: SESS, choice: 'always', expect: 'item.taobao.com', tool: 'browser:open_site' }]);
  assert.ok(env.logs.some((l) => l.includes('手机上选了"始终允许"')));
  env.write(answeredLine(env.now, REQ, 'always'));
  await advanceAsync(env, 3000);
  assert.equal(env.watch.pending.length, 0);
  assert.ok(env.logs.some((l) => l.includes('按好了') && l.includes(ALWAYS_LABEL) && l.includes('always')));
});

test('不给"始终允许"的几种情况：没读出是哪个网站、框上没有这个按钮、每次操作都问的那种框', async () => {
  const labels = (env, id = REQ) => env.notices.get('dialog:' + id).options.map((o) => o.label);
  // 没读出网站名（会话没有开着的窗口）：长期授权不能对着不知道的网站给
  let env = setup({ press: async () => ({ ok: true }), inspect: async () => ({ ok: false, code: 'no-window' }) });
  env.write(askLine(env.now, REQ, 'browser:open_site'));
  await advanceAsync(env, GRACE_MS + 1000);
  assert.deepEqual(labels(env), [ALLOW_LABEL, DENY_LABEL, OK_LABEL]);
  // 读出了文字，但框上没有"始终允许"按钮
  env = setup({ press: async () => ({ ok: true }), inspect: async () => ({ ok: true, text: OPEN_SITE_TEXT, always: false }) });
  env.write(askLine(env.now, REQ, 'browser:open_site'));
  await advanceAsync(env, GRACE_MS + 1000);
  assert.deepEqual(labels(env), [ALLOW_LABEL, DENY_LABEL, OK_LABEL]);
  assert.match(env.notices.get('dialog:' + REQ).text, /可以直接在这里选"允许一次"或"拒绝"，被控端替你按电脑上的按钮。$/);
  // 每次操作都问的框：桌面端自己就不给长期授权
  env = setup({ press: async () => ({ ok: true }), inspect: async () => ({ ok: true, text: OPEN_SITE_TEXT, always: true }) });
  env.write(previewLines(env.now), askLine(env.now));
  await advanceAsync(env, GRACE_MS + 1000);
  assert.deepEqual(labels(env), [ALLOW_LABEL, DENY_LABEL, OK_LABEL]);
});

test('选了"始终允许"但框上没有这个按钮：提醒里说清楚', async () => {
  const env = setup({ press: async () => ({ ok: false, code: 'ui-missing', step: 'dialog-always' }), inspect: async () => ({ ok: true, text: OPEN_SITE_TEXT, always: true }) });
  env.write(askLine(env.now, REQ, 'browser:open_site'));
  await advanceAsync(env, GRACE_MS + 1000);
  answer(env, 'dialog:' + REQ, ALWAYS_LABEL);
  await settle();
  await advanceAsync(env, 1000);
  assert.match(env.notices.get('dialog:' + REQ).text, /^刚才选的"始终允许"没按成：这个框上没有"始终允许"这个按钮。/);
});

test('日志里本来就有网址的框不去读窗口', async () => {
  let looks = 0;
  const env = setup({ press: async () => ({ ok: true }), inspect: async () => (looks++, { ok: true, text: OPEN_SITE_TEXT }) });
  env.write(previewLines(env.now), askLine(env.now));
  await advanceAsync(env, GRACE_MS + 2000);
  assert.equal(looks, 0);
  assert.match(env.notices.get('dialog:' + REQ).text, /uland\.taobao\.com/);
});

test('"允许一次"收在下拉里的框没按到：提醒里说清楚卡在哪', async () => {
  const env = setup({ press: async () => ({ ok: false, code: 'ui-missing', step: 'dialog-menu' }), inspect: async () => ({ ok: true, text: OPEN_SITE_TEXT }) });
  env.write(askLine(env.now, REQ, 'browser:open_site'));
  await advanceAsync(env, GRACE_MS + 1000);
  answer(env, 'dialog:' + REQ, ALLOW_LABEL);
  await settle();
  await advanceAsync(env, 1000);
  assert.match(env.notices.get('dialog:' + REQ).text, /^刚才选的"允许一次"没按成：展开了"更多允许选项"，但没按到里面的"允许一次"。/);
});

test('从框上的文字里找网址', () => {
  assert.equal(originIn(OPEN_SITE_TEXT), 'https://item.taobao.com');
  assert.equal(originIn('允许 Claude 操作 http://localhost:5173？'), 'http://localhost:5173');
  assert.equal(originIn('Allow Claude to act on https://a.example.com. Claude will not…'), 'https://a.example.com');
  assert.equal(originIn('允许 Claude 在 uland.taobao.com 上执行 JavaScript？'), '');
  assert.equal(originIn(''), '');
  assert.equal(originIn(undefined), '');
});

test('能替用户按的只有浏览器的框：别的框还是只有"知道了"和"过 5 分钟再提醒"；选"知道了"不去按', async () => {
  const presses = [];
  const env = setup({ press: async (req) => (presses.push(req), { ok: true }) });
  const id = 'dddddddd-0000-0000-0000-000000000004';
  env.write(askLine(env.now, id, 'PowerShell'));
  env.advance(GRACE_OTHER_MS);
  assert.deepEqual(env.notices.get('dialog:' + id).options.map((o) => o.label), [OK_LABEL, SNOOZE_LABEL]);

  env.write(askLine(env.now));
  env.advance(GRACE_MS);
  answer(env, 'dialog:' + REQ, OK_LABEL);
  await settle();
  env.advance(60000);
  assert.deepEqual(presses, []);
  assert.equal(env.notices.has('dialog:' + REQ), false, '知道了：这个框不再提醒');
});
