'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLockState,
  isDetached,
  parseStatus,
  replyCode,
  unlockCommand,
  WTS_DISCONNECTED,
  SERVICE_CHECK_MS,
  ATTACH_TIMEOUT_MS,
  UNLOCK_TIMEOUT_MS,
} = require('../lockstate');
const { createUnlockPipe, SYSTEM_SID } = require('../unlockpipe');
const RcHostCmd = require('../hostcmd');

const ACTIVE = 0;
const onConsole = { sessionId: 1, consoleId: 1, connectState: ACTIVE, protocol: 0 };
const rdpDisconnected = { sessionId: 2, consoleId: 1, connectState: WTS_DISCONNECTED, protocol: 2 };
const rdpActive = { sessionId: 2, consoleId: 1, connectState: ACTIVE, protocol: 2 };

/** 可控的假环境：screen 锁没锁、session 会话信息、replies 服务依次回什么（函数则按命令回） */
function setup({ screen = false, session = onConsole, replies = [], reply } = {}) {
  const env = { screen, session, asked: [], changes: [], logs: [], t: 1000 };
  const queue = [...replies];
  const lock = createLockState({
    screenLocked: () => env.screen,
    sessionInfo: () => {
      if (env.session instanceof Error) throw env.session;
      return env.session;
    },
    ask: async (line, timeoutMs) => {
      env.asked.push({ line, timeoutMs });
      // 和 unlockpipe.js 的 request 一样回 { line } 或 { error }；用例里写字符串、null 更省事，这里换算
      const v = reply ? reply(line) : queue.length ? queue.shift() : null;
      if (v === null || v === undefined) return { error: 'not-found' };
      return typeof v === 'string' ? { line: v } : v;
    },
    onChange: (s) => env.changes.push(s),
    log: (m) => env.logs.push(m),
    now: () => env.t,
  });
  return { env, lock };
}

// ---------------------------------------------------------------- 纯函数

test('isDetached: 只有"断开且不在控制台"才算', () => {
  assert.equal(isDetached(rdpDisconnected), true);
  assert.equal(isDetached(onConsole), false);
  assert.equal(isDetached(rdpActive), false, '正连着的远程桌面不算（用户正坐在那里用）');
  // 断开但就是控制台会话（切换中等），不算
  assert.equal(isDetached({ sessionId: 1, consoleId: 1, connectState: WTS_DISCONNECTED }), false);
  // 控制台正在切换（0xFFFFFFFF）时，断开的会话仍算
  assert.equal(isDetached({ sessionId: 2, consoleId: 0xffffffff, connectState: WTS_DISCONNECTED }), true);
  assert.equal(isDetached(null), false);
  assert.equal(isDetached({ sessionId: null, consoleId: 1, connectState: WTS_DISCONNECTED }), false);
  assert.equal(isDetached({ sessionId: 2, consoleId: 1, connectState: null }), false);
});

test('parseStatus: 旧版、新版回应都能解析，认不出的字段忽略', () => {
  assert.deepEqual(parseStatus('OK locked=0'), { locked: false, attach: false });
  assert.deepEqual(parseStatus('OK locked=1'), { locked: true, attach: false });
  assert.deepEqual(parseStatus('OK locked=1 attach=1'), { locked: true, attach: true });
  assert.deepEqual(parseStatus('OK locked=0 attach=0'), { locked: false, attach: false });
  assert.deepEqual(parseStatus('OK locked=1 attach=1 future=xyz'), { locked: true, attach: true });
  assert.deepEqual(parseStatus('OK'), { locked: false, attach: false });
  assert.deepEqual(parseStatus('  OK   attach=1  '), { locked: false, attach: true });
  assert.equal(parseStatus(null), null);
  assert.equal(parseStatus(undefined), null);
  assert.equal(parseStatus('ERR failed'), null);
  assert.equal(parseStatus(''), null);
  assert.equal(parseStatus('OKAY attach=1'), null);
  assert.deepEqual(parseStatus('OK attach'), { locked: false, attach: false }, '没有等号的字段忽略');
});

test('解锁服务支不支持隐私屏：版本 3 的 STATUS 有 shade=，旧版没有；断开的远程会话问到的不算数', async () => {
  const { statusHasShade } = require('../lockstate');
  assert.equal(statusHasShade('OK locked=0 attach=0 display=0 shade=0'), true);
  assert.equal(statusHasShade('OK locked=0 attach=0 display=-1 shade=1'), true);
  assert.equal(statusHasShade('OK locked=0 attach=0'), false, '版本 2');
  assert.equal(statusHasShade('OK locked=1'), false, '版本 1');
  assert.equal(statusHasShade(null), false);
  assert.equal(statusHasShade('ERR failed'), false);

  const { env, lock } = setup({ reply: () => 'OK locked=0 attach=0 display=0 shade=0' });
  assert.equal(lock.shadeSupported(), false, '还没问过');
  await lock.poll();
  assert.equal(lock.shadeSupported(), true);
  // 远程桌面断开以后，服务对不在控制台的会话只回 locked、attach：不能因此当成不支持
  env.session = rdpDisconnected;
  await lock.poll();
  assert.equal(lock.shadeSupported(), true);

  const old = setup({ reply: () => 'OK locked=0 attach=0' });
  await old.lock.poll();
  assert.equal(old.lock.shadeSupported(), false, '旧版服务');
});

test('parseStatus: 字段表不带原型，Object.prototype 被污染也读不出 locked/attach；__proto__ 之类的字段名只是普通字段', () => {
  Object.prototype.locked = '1';
  Object.prototype.attach = '1';
  try {
    assert.deepEqual(parseStatus('OK'), { locked: false, attach: false });
    assert.deepEqual(parseStatus('OK locked=1'), { locked: true, attach: false });
  } finally {
    delete Object.prototype.locked;
    delete Object.prototype.attach;
  }
  assert.deepEqual(parseStatus('OK __proto__=x constructor=1 locked=1'), { locked: true, attach: false });
  assert.deepEqual(parseStatus('OK hasOwnProperty=1 attach=1'), { locked: false, attach: true });
});

test('ATTACH 的超时盖得住服务最坏的耗时（核对密码 15 秒 + 接回 5+10 秒 + 等登录界面 5 秒 + 输入密码 30 秒）', () => {
  // 被控端先超时的话会把还在干活的服务当成没装（no-service），所以要比服务最坏的情况再多留一点
  const serviceWorstMs = 15000 + 5000 + 10000 + 5000 + 30000;
  assert.ok(ATTACH_TIMEOUT_MS >= serviceWorstMs + 5000, `ATTACH_TIMEOUT_MS=${ATTACH_TIMEOUT_MS}`);
  assert.ok(ATTACH_TIMEOUT_MS > UNLOCK_TIMEOUT_MS);
});

test('replyCode: 和原来的映射一致', () => {
  assert.equal(replyCode(null), 'no-service');
  assert.equal(replyCode(undefined), 'no-service');
  assert.equal(replyCode('OK'), null);
  assert.equal(replyCode('ERR still-locked'), 'still-locked');
  assert.equal(replyCode('ERR rate-limited'), 'rate-limited');
  assert.equal(replyCode('ERR busy'), 'busy');
  assert.equal(replyCode('ERR '), 'failed');
  assert.equal(replyCode('what'), 'failed');
  assert.equal(replyCode('OK locked=1'), 'failed', '解锁的回应只认单独的 OK');
});

test('unlockCommand: 断开时发 ATTACH，否则 UNLOCK，密码 UTF-8 后 Base64', () => {
  assert.equal(unlockCommand('pässwörd 1', false), 'UNLOCK ' + Buffer.from('pässwörd 1', 'utf8').toString('base64'));
  assert.equal(unlockCommand('1234', true), 'ATTACH ' + Buffer.from('1234', 'utf8').toString('base64'));
});

// ---------------------------------------------------------------- 定时查询

test('poll: 在控制台、锁屏、服务在：locked + unlock，和原来一样', async () => {
  const { env, lock } = setup({ screen: true, replies: ['OK locked=1'] });
  const s = await lock.poll();
  assert.deepEqual(s, { locked: true, unlock: true, untrusted: false, detached: false });
  assert.deepEqual(env.asked, [{ line: 'STATUS', timeoutMs: 1500 }]);
  assert.equal(env.changes.length, 1);
});

test('poll: 远程桌面断开、新版服务说能接回：报锁屏且可以解锁', async () => {
  const { env, lock } = setup({ session: rdpDisconnected, replies: ['OK locked=1 attach=1'] });
  const s = await lock.poll();
  assert.deepEqual(s, { locked: true, unlock: true, untrusted: false, detached: true });
  assert.ok(env.logs.some((m) => m.includes('远程桌面已断开')));
});

test('poll: 远程桌面断开、旧版服务（不理不在控制台的程序）：报锁屏、不能解锁', async () => {
  const { lock } = setup({ session: rdpDisconnected, replies: [null] });
  assert.deepEqual(await lock.poll(), { locked: true, unlock: false, untrusted: false, detached: true });
});

test('poll: 远程桌面断开，但服务回的是控制台的样子（attach=0 或旧格式）：不能解锁', async () => {
  for (const r of ['OK locked=0 attach=0', 'OK locked=1']) {
    const { lock } = setup({ session: rdpDisconnected, replies: [r] });
    assert.equal((await lock.poll()).unlock, false, r);
  }
});

test('poll: 正连着的远程桌面会话：和原来一样只看屏幕锁没锁', async () => {
  const { lock } = setup({ session: rdpActive, screen: false, replies: [null] });
  assert.deepEqual(await lock.poll(), { locked: false, unlock: false, untrusted: false, detached: false });
});

test('poll: 接回控制台后立刻重新问服务，状态回到未锁定', async () => {
  const { env, lock } = setup({ session: rdpDisconnected, replies: ['OK locked=1 attach=1', 'OK locked=0 attach=0'] });
  await lock.poll();
  env.session = onConsole;
  const s = await lock.poll();
  assert.deepEqual(s, { locked: false, unlock: true, untrusted: false, detached: false });
  assert.equal(env.asked.length, 2);
  assert.equal(env.changes.length, 2);
  assert.ok(env.logs.some((m) => m.includes('已回到电脑的显示器上')));
});

test('poll: 没变化时 30 秒才再问一次服务，不重复通知', async () => {
  const { env, lock } = setup({ reply: () => 'OK locked=0' });
  await lock.poll();
  await lock.poll();
  assert.equal(env.asked.length, 1);
  assert.equal(env.changes.length, 1);
  env.t += SERVICE_CHECK_MS + 1;
  await lock.poll();
  assert.equal(env.asked.length, 2);
  assert.equal(env.changes.length, 1, '结果一样就不通知');
});

test('recheck: 不等 30 秒马上重新问服务，结果变了就通知（被控端窗口里装好服务后用）', async () => {
  let installed = false;
  const { env, lock } = setup({ reply: () => (installed ? 'OK locked=0' : null) });
  assert.equal((await lock.poll()).unlock, false);
  installed = true;
  await lock.poll();
  assert.equal(env.asked.length, 1, '30 秒内普通的 poll 不再问');
  assert.deepEqual(await lock.recheck(), { locked: false, unlock: true, untrusted: false, detached: false });
  assert.equal(env.asked.length, 2);
  // 第一次问到"没装"和初始状态一样，不通知；只有 recheck 问到"装好了"这一次通知
  assert.deepEqual(env.changes, [{ locked: false, unlock: true, untrusted: false, detached: false }]);
  await lock.poll();
  assert.equal(env.asked.length, 2, '重新问过以后照常隔 30 秒');
});

test('poll: 查不到会话信息时按没断开处理，同一个错误只记一次', async () => {
  const { env, lock } = setup({ session: new Error('koffi 加载失败'), screen: true, reply: () => 'OK locked=1' });
  assert.deepEqual(await lock.poll(), { locked: true, unlock: true, untrusted: false, detached: false });
  env.t += SERVICE_CHECK_MS + 1;
  await lock.poll();
  assert.equal(env.logs.filter((m) => m.includes('koffi 加载失败')).length, 1);
});

test('poll: 上一次还没问完就跳过，旧结果不会盖掉新的', async () => {
  let release;
  const env = { asked: 0 };
  const lock = createLockState({
    screenLocked: () => true,
    sessionInfo: () => onConsole,
    ask: () => {
      env.asked += 1;
      return new Promise((r) => {
        release = (line) => r({ line });
      });
    },
  });
  const first = lock.poll();
  await lock.poll();
  assert.equal(env.asked, 1);
  release('OK locked=1');
  assert.deepEqual(await first, { locked: true, unlock: true, untrusted: false, detached: false });
});

// ---------------------------------------------------------------- 解锁

test('unlock: 远程桌面断开时发 ATTACH、给更长的超时，不要求屏幕锁着', async () => {
  const { env, lock } = setup({ session: rdpDisconnected, screen: false, replies: ['OK'] });
  assert.equal(await lock.unlock('correct horse'), null);
  assert.equal(env.asked.length, 1);
  assert.equal(env.asked[0].line, 'ATTACH ' + Buffer.from('correct horse').toString('base64'));
  assert.equal(env.asked[0].timeoutMs, ATTACH_TIMEOUT_MS);
});

test('unlock: 在控制台照旧发 UNLOCK；没锁屏直接 not-locked，不打扰服务', async () => {
  const locked = setup({ screen: true, replies: ['ERR still-locked'] });
  assert.equal(await locked.lock.unlock('pw'), 'still-locked');
  assert.equal(locked.env.asked[0].line, 'UNLOCK ' + Buffer.from('pw').toString('base64'));
  assert.equal(locked.env.asked[0].timeoutMs, UNLOCK_TIMEOUT_MS);

  const unlocked = setup({ screen: false });
  assert.equal(await unlocked.lock.unlock('pw'), 'not-locked');
  assert.equal(unlocked.env.asked.length, 0);
});

test('unlock: 正连着的远程桌面会话不发 ATTACH', async () => {
  const { env, lock } = setup({ session: rdpActive, screen: true, replies: [null] });
  assert.equal(await lock.unlock('pw'), 'no-service');
  assert.ok(env.asked[0].line.startsWith('UNLOCK '));
});

test('unlock: 服务的各种回应原样转成控制端认得的码', async () => {
  const cases = [
    [null, 'no-service'],
    ['OK', null],
    ['ERR rate-limited', 'rate-limited'],
    ['ERR still-locked', 'still-locked'],
    ['ERR failed', 'failed'],
    ['ERR busy', 'busy'],
    ['ERR no-service', 'no-service'],
  ];
  for (const [r, code] of cases) {
    const { lock } = setup({ session: rdpDisconnected, replies: [r] });
    assert.equal(await lock.unlock('pw'), code, String(r));
  }
});

test('unlock: 密码不合格直接 failed；同时只做一次', async () => {
  const { env, lock } = setup({ session: rdpDisconnected });
  assert.equal(await lock.unlock(''), 'failed');
  assert.equal(await lock.unlock(123), 'failed');
  assert.equal(await lock.unlock('x'.repeat(257)), 'failed');
  assert.equal(env.asked.length, 0);

  let release;
  const slow = createLockState({
    screenLocked: () => true,
    sessionInfo: () => rdpDisconnected,
    ask: () =>
      new Promise((r) => {
        release = (line) => r({ line });
      }),
  });
  const first = slow.unlock('pw');
  assert.equal(await slow.unlock('pw'), 'busy');
  release('OK');
  assert.equal(await first, null);
  // 做完以后又能再做
  const third = slow.unlock('pw');
  release('OK');
  assert.equal(await third, null);
});

test('lockedNow: 屏幕锁着或远程桌面断开都算', () => {
  const { env, lock } = setup({ screen: false });
  assert.equal(lock.lockedNow(), false);
  env.screen = true;
  assert.equal(lock.lockedNow(), true);
  env.screen = false;
  env.session = rdpDisconnected;
  assert.equal(lock.lockedNow(), true);
});

test('发给控制端的 host-state 不带 detached，协议不变', async () => {
  const { lock } = setup({ session: rdpDisconnected, replies: ['OK locked=1 attach=1'] });
  const s = await lock.poll();
  const msg = RcHostCmd.stateMessage('v1', s, null, null);
  assert.deepEqual(msg.lock, { locked: true, unlock: true });
});

// ---------------------------------------------------------------- 打包

test('main.js 用到的本地模块都在安装包的文件清单里（漏了的话装好的被控端一启动就崩）', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const required = [...new Set([...src.matchAll(/require\('\.\/([^']+)'\)/g)].map((m) => m[1]))];
  assert.ok(required.includes('lockstate') && required.includes('sessioninfo'));
  const listed = require('../electron-builder.config.js').files;
  for (const mod of required) {
    const covered = listed.some((f) => f === mod + '.js' || f === mod + '/**');
    assert.ok(covered, `${mod} 不在 electron-builder.config.js 的 files 里`);
  }
});

// ---------------------------------------------------------------- 经过真正的管道客户端（Win32 层是假的）

test('经过 unlockpipe：断开时核实服务后写出的是 ATTACH 命令', async () => {
  const EXE = 'C:\\Program Files\\RemoteClaude\\RemoteClaudeUnlock.exe';
  const written = [];
  let pending = null;
  const native = {
    open: () => ({ handle: 7 }),
    serverPid: () => 4242,
    processImage: () => EXE,
    pipeOwner: () => SYSTEM_SID,
    write(h, data) {
      const line = data.toString('utf8');
      written.push(line);
      pending = Buffer.from(line.startsWith('STATUS') ? 'OK locked=1 attach=1\n' : 'OK\n');
      return true;
    },
    available: () => (pending ? pending.length : 0),
    read: () => {
      const b = pending;
      pending = null;
      return b;
    },
    close() {},
  };
  const pipe = createUnlockPipe({ native, expectedExe: EXE, sleep: async () => {} });
  const lock = createLockState({
    screenLocked: () => false,
    sessionInfo: () => rdpDisconnected,
    ask: pipe.request,
  });
  assert.deepEqual(await lock.poll(), { locked: true, unlock: true, untrusted: false, detached: true });
  assert.equal(await lock.unlock('pw'), null);
  assert.deepEqual(written, ['STATUS\n', 'ATTACH ' + Buffer.from('pw').toString('base64') + '\n']);
});

test('解锁服务核实不过（untrusted）：状态里带 untrusted，解锁回 bad-service，核实通过后清掉', async () => {
  const { env, lock } = setup({ screen: true, replies: [{ error: 'untrusted' }] });
  assert.deepEqual(await lock.poll(), { locked: true, unlock: false, untrusted: true, detached: false });
  assert.equal(env.changes.length, 1);

  const bad = setup({ screen: true, reply: () => ({ error: 'untrusted' }) });
  assert.equal(await bad.lock.unlock('pw'), 'bad-service');
  const none = setup({ screen: true, reply: () => null });
  assert.equal(await none.lock.unlock('pw'), 'no-service');

  // 换上新版服务以后：下一次问到 OK，untrusted 清掉
  env.t += 31000;
  const again = setup({ screen: true, replies: [{ error: 'untrusted' }, 'OK locked=1'] });
  await again.lock.poll();
  again.env.t += 31000;
  assert.deepEqual(await again.lock.poll(), { locked: true, unlock: true, untrusted: false, detached: false });
});
