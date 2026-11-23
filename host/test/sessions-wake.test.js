'use strict';
/**
 * 打开、新建会话前先叫醒显示器（docs/07 第 6 节）：显示器关着时 Claude 复用的会话窗口不刷新画面，
 * 被控端会把它当成卡住。打开前叫醒一次；窗口出来以后等页面的时候再动一下、隔一会儿再动一下。
 * 这里用假的 win32 和假的界面自动化，只看先后顺序和等不等。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessions } = require('../sessions');

const TITLE = '每日代码审查脚本';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const win = (hwnd, title) => ({ hwnd, title, className: 'Chrome_WidgetWin_1', minimized: false });

/** 一份最小的 Claude 本地记录：一个环境、一个会话，没有开着的会话窗口 */
function fakeDataDir(popouts = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-wake-'));
  const org = path.join(dir, 'claude-code-sessions', 'acct', 'org');
  fs.mkdirSync(org, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session-popouts.json'), JSON.stringify({ version: 1, accountUuid: 'acct', popouts }));
  fs.writeFileSync(
    path.join(dir, 'ccd-session-presets.json'),
    JSON.stringify({ byAccount: { acct: { presets: [{ id: 'e1', name: 'RemoteClaude', target: { cwd: 'F:\\x', kind: 'local' } }] } } })
  );
  fs.writeFileSync(path.join(org, 'local_a.json'), JSON.stringify({ sessionId: 'local_a', title: TITLE, cwd: 'F:\\x' }));
  return dir;
}

/**
 * 假的电脑：屏幕上先只有 Claude 主窗口（句柄 1）；界面自动化"点"了以后冒出会话窗口（句柄 9）。
 * events 按先后记下做过的事和时刻；checks 是每次检查页面依次返回什么，用完了就算通过；checkDelay 是检查页面要多久；
 * uiFail 是 { 动作: 失败时返回什么 }，那个动作不会让窗口冒出来。
 */
function setup({ locked = false, idle = 0, checks = [], withWake = true, checkDelay = 0, uiFail = null, uiResult = null, opened = false } = {}) {
  const windows = new Map([[1, win(1, 'Claude')]]);
  // opened：这个会话已经开成了单独的窗口（句柄 9）
  if (opened) windows.set(9, win(9, TITLE));
  const events = [];
  const logs = [];
  const mark = (name) => events.push({ name, at: Date.now() });
  const win32 = {
    enumTargetWindows: () => [...windows.values()],
    isTargetWindow: (hwnd) => windows.has(hwnd),
    isLocked: () => locked,
    postClose: () => true,
  };
  if (withWake) {
    win32.wakeDisplay = () => {
      mark('wake');
      return 2;
    };
  }
  const runUi = async (action, args) => {
    events.push({ name: action, at: Date.now(), args });
    if (uiFail && uiFail[action]) return uiFail[action];
    if (uiResult && uiResult[action]) return uiResult[action];
    if (action === 'popout') windows.set(9, win(9, TITLE));
    if (action === 'newwin') windows.set(9, win(9, '新会话'));
    if (action === 'close') windows.delete(Number(args.Hwnd));
    if (action === 'checkdoc' && checkDelay) await new Promise((r) => setTimeout(r, checkDelay));
    if (action === 'checkdoc' && checks.length) return checks.shift();
    return { ok: true, ms: 0 };
  };
  const dir = fakeDataDir(opened ? [{ sessionId: 'local_a', title: TITLE }] : []);
  const sessions = createSessions({
    log: (m) => logs.push(m),
    win32,
    targets: ['claude.exe'],
    openUrl: async () => mark('link'),
    idleSeconds: () => idle,
    findDataDir: () => dir,
    runUi,
  });
  return { sessions, events, logs, names: () => events.map((e) => e.name), gap: (a, b) => events[b].at - events[a].at };
}

test('打开会话：先叫醒显示器，再让 Claude 开窗口', async () => {
  const t = setup({ idle: 3 });
  const r = await t.sessions.open('local_a');
  assert.deepEqual(r, { ok: true, hwnd: 9, title: TITLE, created: true });
  assert.deepEqual(t.names(), ['wake', 'link', 'popout', 'wake', 'checkdoc'], '打开前叫醒一次，窗口出来后再动一下');
  assert.ok(t.gap(0, 1) < 500, '刚有人操作过，不用等');
  assert.ok(!t.logs.some((m) => m.includes('显示器')), '亮着的时候不记日志');
});

test('电脑很久没人操作（显示器多半关着）：记一行日志，等一会儿再动 Claude', async () => {
  const t = setup({ idle: 14567 });
  const r = await t.sessions.open('local_a');
  assert.equal(r.ok, true);
  assert.deepEqual(t.names(), ['wake', 'link', 'popout', 'wake', 'checkdoc']);
  assert.ok(t.gap(0, 1) >= 950, `叫醒后等了 ${t.gap(0, 1)} 毫秒`);
  assert.ok(t.logs.some((m) => m.includes('14567 秒没人操作') && m.includes('显示器可能关着')), t.logs.join('\n'));
});

test('新建会话也先叫醒显示器', async () => {
  const t = setup({ idle: 400 });
  const r = await t.sessions.create('e1');
  assert.deepEqual(r, { ok: true, hwnd: 9, title: '新会话', envOk: true, env: 'RemoteClaude' });
  assert.deepEqual(t.names(), ['wake', 'newwin', 'wake', 'pickenv']);
});

test('界面上的按钮没按成：回 ui-missing，日志里写明是哪一步', async () => {
  // 2026-11-21：Claude 升级后标题栏"菜单"按钮按不动，手机上只看到"没找到要点的菜单"，日志里也看不出卡在哪
  const t = setup({ uiFail: { newwin: { ok: false, code: 'ui-missing', step: 'menu' } } });
  assert.deepEqual(await t.sessions.create('e1'), { ok: false, code: 'ui-missing', step: 'menu' });
  assert.deepEqual(t.names(), ['wake', 'newwin', 'link', 'newwin'], '没找到"菜单"时发链接再试一次，还不行才报');
  assert.ok(t.logs.some((m) => m.includes('ui-missing: menu')), t.logs.join(' / '));

  // 别的步骤没按成不重试
  const t3 = setup({ uiFail: { newwin: { ok: false, code: 'ui-missing', step: 'file' } } });
  assert.deepEqual(await t3.sessions.create('e1'), { ok: false, code: 'ui-missing', step: 'file' });
  assert.deepEqual(t3.names(), ['wake', 'newwin']);

  const t2 = setup({ uiFail: { popout: { ok: false, code: 'ui-missing', step: 'open-in' } } });
  assert.deepEqual(await t2.sessions.open('local_a'), { ok: false, code: 'ui-missing', step: 'open-in' });
  assert.ok(t2.logs.some((m) => m.includes('ui-missing: open-in')), t2.logs.join(' / '));
});

test('新建会话：屏幕上那个"Claude"窗口里没有"菜单"，发链接后在真正的主窗口里再按一次', async () => {
  // 2026-11-22 04:57：连着两次新建都报 ui-missing: menu，Claude 的日志里那两次都没收到链接
  const windows = new Map([[5, win(5, 'Claude')]]);
  const calls = [];
  const logs = [];
  const dir = fakeDataDir();
  const sessions = createSessions({
    log: (m) => logs.push(m),
    win32: { enumTargetWindows: () => [...windows.values()], isTargetWindow: (h) => windows.has(h), isLocked: () => false, postClose: () => true },
    targets: ['claude.exe'],
    openUrl: async (url) => {
      calls.push(url);
      windows.set(1, win(1, 'Claude')); // 链接把真正的主窗口叫出来了
    },
    findDataDir: () => dir,
    runUi: async (action, args) => {
      calls.push(`${action}:${args.Hwnd}`);
      if (action === 'newwin' && args.Hwnd === 5) return { ok: false, code: 'ui-missing', step: 'menu' };
      if (action === 'newwin') windows.set(9, win(9, '新会话'));
      return { ok: true };
    },
  });
  const r = await sessions.create('e1');
  assert.deepEqual(r, { ok: true, hwnd: 9, title: '新会话', envOk: true, env: 'RemoteClaude' });
  assert.deepEqual(calls, ['newwin:5', 'claude://code/new', 'newwin:1', 'pickenv:9']);
  assert.ok(logs.some((m) => m.includes('没找到"菜单"按钮') && m.includes('5「Claude」')), logs.join(' / '));
});

test('锁屏时不注入，直接回 locked', async () => {
  const t = setup({ locked: true, idle: 9999 });
  assert.deepEqual(await t.sessions.open('local_a'), { ok: false, code: 'locked' });
  assert.deepEqual(await t.sessions.create('e1'), { ok: false, code: 'locked' });
  assert.deepEqual(t.names(), []);
});

test('窗口没显示这个会话：关掉重开，新窗口出来后照样先动一下', async () => {
  const stale = { ok: false, code: 'stuck', reason: 'other', ms: 6000, seen: b64('SVN 多会话文件冲突优化') };
  const t = setup({ checks: [stale] });
  const r = await t.sessions.open('local_a');
  assert.equal(r.ok, true);
  assert.deepEqual(t.names(), ['wake', 'link', 'popout', 'wake', 'checkdoc', 'close', 'link', 'popout', 'wake', 'checkdoc']);
  assert.ok(t.logs.some((m) => m.includes('页面停在别的会话上') && m.includes('SVN 多会话文件冲突优化')));
});

test('两次都没显示出来回 stuck', async () => {
  const stale = { ok: false, code: 'stuck', reason: 'other', ms: 6000, seen: b64('旧会话') };
  const t = setup({ checks: [stale, { ...stale }] });
  assert.deepEqual(await t.sessions.open('local_a'), { ok: false, code: 'stuck' });
  assert.deepEqual(t.names(), ['wake', 'link', 'popout', 'wake', 'checkdoc', 'close', 'link', 'popout', 'wake', 'checkdoc', 'close']);
  assert.ok(t.logs.some((m) => m.includes('和上次是同一个窗口')));
});

test('页面迟迟不显示时，等的这段时间里隔一会儿再动一下鼠标，等完就不动了', async () => {
  const t = setup({ checkDelay: 3300 });
  assert.equal((await t.sessions.open('local_a')).ok, true);
  const names = t.names();
  const at = names.indexOf('checkdoc');
  assert.deepEqual(names.slice(0, at + 1), ['wake', 'link', 'popout', 'wake', 'checkdoc']);
  assert.deepEqual(names.slice(at + 1), ['wake', 'wake'], '3.3 秒里又动了两下（1.5 秒一次）');
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(t.names().length, names.length, '检查完就停');
});

test('win32 没有 wakeDisplay（别的平台、旧的假对象）时照常打开', async () => {
  const t = setup({ withWake: false, idle: 9999 });
  assert.equal((await t.sessions.open('local_a')).ok, true);
  assert.deepEqual(t.names(), ['link', 'popout', 'checkdoc']);
});

test('替用户按确认框：会话没有单独的窗口就先开一个，再去按，带上要核对的网站名', async () => {
  const t = setup();
  const r = await t.sessions.answerDialog('local_a', 'allow', 'uland.taobao.com');
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(t.names(), ['wake', 'link', 'popout', 'wake', 'checkdoc', 'wake', 'dialog']);
  const call = t.events[t.events.length - 1];
  assert.equal(call.args.Hwnd, 9);
  assert.equal(call.args.Choice, 'allow');
  assert.equal(call.args.Expect, b64('uland.taobao.com'));
  assert.ok(call.args.TimeoutMs >= 10000, '窗口是刚开出来的，页面还在加载，多等一会儿');
  assert.ok(t.logs.some((m) => m.includes('确认框') && m.includes('允许一次')));
});

test('替用户按确认框：不知道网站名就不核对；拒绝按的是"拒绝"', async () => {
  const t = setup();
  assert.deepEqual(await t.sessions.answerDialog('local_a', 'deny'), { ok: true });
  const call = t.events[t.events.length - 1];
  assert.equal(call.name, 'dialog');
  assert.equal(call.args.Choice, 'deny');
  assert.equal('Expect' in call.args, false);
});

test('替用户按确认框：没找到按钮、框对不上，原样回原因；选项不对、会话不存在什么都不做', async () => {
  let t = setup({ uiFail: { dialog: { ok: false, code: 'mismatch', seen: b64('允许 Claude 在 evil.example 上执行 JavaScript？') } } });
  assert.deepEqual(await t.sessions.answerDialog('local_a', 'allow', 'uland.taobao.com'), { ok: false, code: 'mismatch' });
  assert.ok(t.logs.some((m) => m.includes('没按成') && m.includes('mismatch')));

  t = setup({ uiFail: { dialog: { ok: false, code: 'ui-missing', step: 'dialog-buttons' } } });
  assert.deepEqual(await t.sessions.answerDialog('local_a', 'allow'), { ok: false, code: 'ui-missing', step: 'dialog-buttons' });

  t = setup();
  assert.deepEqual(await t.sessions.answerDialog('local_a', 'forever'), { ok: false, code: 'bad-args' });
  assert.deepEqual(await t.sessions.answerDialog('local_nobody', 'allow'), { ok: false, code: 'not-found' });
  assert.deepEqual(t.names(), []);
});

test('替用户按确认框：电脑锁着屏、会话又没有窗口时不动，回 locked', async () => {
  const t = setup({ locked: true });
  assert.deepEqual(await t.sessions.answerDialog('local_a', 'allow', 'a.example'), { ok: false, code: 'locked' });
  assert.deepEqual(t.names(), []);
});

test('只看确认框上写的什么：会话有开着的窗口就读，不按；没有窗口不为它开', async () => {
  const text = '允许 Claude 操作 https://item.taobao.com？';
  let t = setup({ opened: true, uiResult: { dialog: { ok: true, probe: true, menu: true, always: true, seen: b64(text) } } });
  assert.deepEqual(await t.sessions.peekDialog('local_a'), { ok: true, text, menu: true, always: true });
  assert.deepEqual(t.names(), ['dialog']);
  const call = t.events[0];
  assert.equal(call.args.Hwnd, 9);
  assert.equal(call.args.Probe, 1, '只探测');

  t = setup();
  assert.deepEqual(await t.sessions.peekDialog('local_a'), { ok: false, code: 'no-window' });
  assert.deepEqual(t.names(), [], '没有窗口时什么都不做');

  t = setup({ opened: true, uiFail: { dialog: { ok: false, code: 'ui-missing', step: 'dialog-buttons' } } });
  assert.deepEqual(await t.sessions.peekDialog('local_a'), { ok: false, code: 'ui-missing' });
});

test('替用户按确认框：会话的窗口本来就开着就直接用；"允许一次"在下拉里的、没按到的，日志里写明', async () => {
  let t = setup({ opened: true, uiResult: { dialog: { ok: true, menu: true, focused: false } } });
  assert.deepEqual(await t.sessions.answerDialog('local_a', 'allow', 'item.taobao.com'), { ok: true });
  assert.deepEqual(t.names(), ['wake', 'dialog'], '不用开窗口');
  assert.ok(t.logs.some((m) => m.includes('展开"更多允许选项"按的')), t.logs.join(' / '));

  t = setup({ opened: true, uiFail: { dialog: { ok: false, code: 'ui-missing', step: 'dialog-menu', seen: b64('始终允许此网站 | 仅此一次') } } });
  assert.deepEqual(await t.sessions.answerDialog('local_a', 'allow'), { ok: false, code: 'ui-missing', step: 'dialog-menu' });
  assert.ok(t.logs.some((m) => m.includes('dialog-menu') && m.includes('仅此一次')), '下拉里实际有什么写进日志');
});

test('替用户按确认框的"始终允许"：传给脚本的是 always，日志里写的是"始终允许"；框上没有这个按钮时原样带回原因', async () => {
  let t = setup({ opened: true, uiResult: { dialog: { ok: true, menu: false, focused: false } } });
  assert.deepEqual(await t.sessions.answerDialog('local_a', 'always', 'item.taobao.com'), { ok: true });
  const call = t.events[t.events.length - 1];
  assert.equal(call.name, 'dialog');
  assert.equal(call.args.Choice, 'always');
  assert.equal(call.args.Expect, b64('item.taobao.com'));
  assert.ok(t.logs.some((m) => m.includes('确认框的"始终允许"')), t.logs.join(' / '));

  t = setup({ opened: true, uiFail: { dialog: { ok: false, code: 'ui-missing', step: 'dialog-always' } } });
  assert.deepEqual(await t.sessions.answerDialog('local_a', 'always'), { ok: false, code: 'ui-missing', step: 'dialog-always' });
});
