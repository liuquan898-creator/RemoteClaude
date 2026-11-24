'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createUnlockPipe, verifyServer, expectedServiceExe, firstLine, SYSTEM_SID } = require('../unlockpipe');

const EXE = 'C:\\Program Files\\RemoteClaude\\RemoteClaudeUnlock.exe';

/**
 * 假的 Win32 层。server 描述管道对面：pid、路径、管道所有者，以及收到一行后怎么回。
 * reply 可以是字符串（一次给全）、字符串数组（分几次给）、null（一直不回）。
 */
function fakeNative(server = {}) {
  const s = {
    openResults: [], // 依次返回的 open 结果，用完后按 server 正常打开
    pid: 4242,
    image: EXE,
    owner: SYSTEM_SID,
    reply: 'OK locked=0\n',
    closeAfterReply: false,
    ...server,
  };
  const n = {
    written: [],
    opens: 0,
    closed: 0,
    pending: [],
    open() {
      n.opens += 1;
      if (s.openResults.length) return s.openResults.shift();
      return { handle: 7 };
    },
    serverPid: () => s.pid,
    processImage: (pid) => (pid === s.pid ? s.image : ''),
    pipeOwner: () => s.owner,
    write(h, data) {
      n.written.push(data.toString('utf8'));
      if (s.reply === null) n.pending = [];
      else n.pending = (Array.isArray(s.reply) ? s.reply : [s.reply]).map((x) => Buffer.from(x, 'utf8'));
      return true;
    },
    available() {
      if (n.pending.length) return n.pending[0].length;
      return s.closeAfterReply && n.written.length ? -1 : 0;
    },
    read(h, len) {
      const head = n.pending.shift();
      if (!head) return null;
      if (head.length > len) {
        n.pending.unshift(head.subarray(len));
        return head.subarray(0, len);
      }
      return head;
    },
    close() {
      n.closed += 1;
    },
  };
  return n;
}

/** 假时钟：sleep 只把钟往前拨 */
function fakeClock() {
  const c = { t: 0, slept: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => {
    c.slept.push(ms);
    c.t += ms;
  };
  return c;
}

function make(native, extra = {}) {
  const clock = fakeClock();
  const logs = [];
  const pipe = createUnlockPipe({ native, expectedExe: EXE, log: (m) => logs.push(m), sleep: clock.sleep, now: clock.now, ...extra });
  return { pipe, clock, logs };
}

// ---------------------------------------------------------------- verifyServer

test('核实：路径正好是 Program Files 里的服务程序、管道所有者是 SYSTEM 才算数', () => {
  assert.deepEqual(verifyServer({ pid: 1, image: EXE, owner: SYSTEM_SID }, { expectedExe: EXE }), { ok: true });
  // 大小写、\\?\ 前缀不影响
  assert.equal(verifyServer({ pid: 1, image: '\\\\?\\c:\\program files\\remoteclaude\\REMOTECLAUDEUNLOCK.EXE', owner: SYSTEM_SID }, { expectedExe: EXE }).ok, true);
});

test('核实：路径不对、查不到路径、拿不到进程号都不算数', () => {
  const opts = { expectedExe: EXE };
  assert.equal(verifyServer({ pid: 1, image: 'C:\\Users\\me\\AppData\\Local\\Temp\\RemoteClaudeUnlock.exe', owner: SYSTEM_SID }, opts).ok, false);
  assert.equal(verifyServer({ pid: 1, image: 'C:\\Program Files\\RemoteClaude\\RemoteClaudeUnlock.exe.evil', owner: SYSTEM_SID }, opts).ok, false);
  assert.equal(verifyServer({ pid: 1, image: 'C:\\Program Files\\RemoteClaude\\sub\\RemoteClaudeUnlock.exe', owner: SYSTEM_SID }, opts).ok, false);
  assert.equal(verifyServer({ pid: 1, image: '', owner: SYSTEM_SID }, opts).ok, false);
  assert.equal(verifyServer({ pid: 0, image: EXE, owner: SYSTEM_SID }, opts).ok, false);
  assert.equal(verifyServer(null, opts).ok, false);
  assert.equal(verifyServer({ pid: 1, image: EXE, owner: SYSTEM_SID }, { expectedExe: '' }).ok, false, '不知道该在哪就不信');
});

test('核实：程序对但管道不是 SYSTEM 的（普通用户自己以 --console 跑了这个程序）不算数', () => {
  const v = verifyServer({ pid: 1, image: EXE, owner: 'S-1-5-21-1-2-3-1001' }, { expectedExe: EXE });
  assert.equal(v.ok, false);
  assert.match(v.reason, /SYSTEM/);
  assert.equal(verifyServer({ pid: 1, image: EXE, owner: '' }, { expectedExe: EXE }).ok, false);
  assert.equal(verifyServer({ pid: 1, image: EXE, owner: 'S-1-5-32-544' }, { expectedExe: EXE }).ok, false, '管理员组也不行，服务明确设成了 SYSTEM');
});

test('服务程序的位置取 ProgramW6432，没有再取 ProgramFiles', () => {
  assert.equal(expectedServiceExe({ ProgramW6432: 'C:\\Program Files', ProgramFiles: 'C:\\Program Files (x86)' }), EXE);
  assert.equal(expectedServiceExe({ ProgramFiles: 'D:\\Apps' }), 'D:\\Apps\\RemoteClaude\\RemoteClaudeUnlock.exe');
  assert.equal(expectedServiceExe({}), '');
});

test('firstLine：只取第一行，去掉回车，没收全返回 null', () => {
  assert.equal(firstLine(Buffer.from('OK locked=1\r\nrest')), 'OK locked=1');
  assert.equal(firstLine(Buffer.from('OK')), null);
  assert.equal(firstLine(Buffer.from('解锁 ✓\n')), '解锁 ✓');
});

// ---------------------------------------------------------------- ask

test('正常：核实通过后发一行命令，返回回应的那一行，句柄关掉', async () => {
  const native = fakeNative({ reply: 'OK locked=1\n' });
  const { pipe } = make(native);
  assert.equal(await pipe.ask('STATUS', 1500), 'OK locked=1');
  assert.deepEqual(native.written, ['STATUS\n']);
  assert.equal(native.closed, 1);
});

test('回应分几次到、跨了多次读也能拼出来', async () => {
  const native = fakeNative({ reply: ['ER', 'R still-', 'locked\n'] });
  const { pipe } = make(native);
  assert.equal(await pipe.ask('UNLOCK cGFzcw==', 40000), 'ERR still-locked');
});

test('冒充的管道：一个字节都不发（尤其不发 UNLOCK 和密码），返回 null，记一条日志', async () => {
  const native = fakeNative({ image: 'C:\\Users\\me\\evil.exe' });
  const { pipe, logs } = make(native);
  assert.equal(await pipe.ask('UNLOCK c2VjcmV0', 40000), null);
  assert.deepEqual(native.written, [], '什么都没写');
  assert.equal(native.opens, 1, '核实不过不重试');
  assert.equal(native.closed, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /不是可信的解锁服务/);
  assert.doesNotMatch(logs[0], /c2VjcmV0|secret/);
});

test('冒充的管道：所有者不是 SYSTEM 时同样不发', async () => {
  const native = fakeNative({ owner: 'S-1-5-21-9-9-9-1001' });
  const { pipe } = make(native);
  assert.equal(await pipe.ask('UNLOCK c2VjcmV0', 40000), null);
  assert.deepEqual(native.written, []);
});

test('查不到对面进程路径（比如旧版服务没开放查询权限）当作没装服务', async () => {
  const native = fakeNative({ image: '' });
  const { pipe } = make(native);
  assert.equal(await pipe.ask('STATUS', 1500), null);
  assert.deepEqual(native.written, []);
});

test('同一个不可信原因只记一次；核实通过后记一条恢复', async () => {
  const native = fakeNative({ image: 'C:\\evil.exe' });
  const { pipe, logs } = make(native);
  await pipe.ask('STATUS', 1500);
  await pipe.ask('STATUS', 1500);
  assert.equal(logs.length, 1);
  native.processImage = () => EXE;
  assert.equal(await pipe.ask('STATUS', 1500), 'OK locked=0');
  assert.equal(logs.length, 2);
  assert.match(logs[1], /核实通过/);
});

test('服务不在或实例都忙：稍等重试，最多 3 次', async () => {
  const native = fakeNative({ openResults: [{ error: 'not-found' }, { error: 'busy' }] });
  const { pipe, clock } = make(native);
  assert.equal(await pipe.ask('STATUS', 1500), 'OK locked=0');
  assert.equal(native.opens, 3);
  assert.deepEqual(clock.slept.filter((ms) => ms === 400), [400, 400]);

  const never = fakeNative({ openResults: [{ error: 'not-found' }, { error: 'not-found' }, { error: 'not-found' }, { error: 'not-found' }] });
  const m = make(never);
  assert.equal(await m.pipe.ask('STATUS', 1500), null);
  assert.equal(never.opens, 3);
});

test('其它打开错误也稍等重试（不依赖错误码是否准确），最多 3 次', async () => {
  const native = fakeNative({ openResults: [{ error: 'open-failed', code: 5 }, { error: 'open-failed', code: 5 }, { error: 'open-failed', code: 5 }] });
  const { pipe } = make(native);
  assert.equal(await pipe.ask('STATUS', 1500), null);
  assert.equal(native.opens, 3);
  assert.deepEqual(native.written, []);
});

test('连上并核实之后的失败不重试，不会把同一条命令发两遍', async () => {
  const native = fakeNative();
  native.write = (h, data) => {
    native.written.push(data.toString('utf8'));
    return false;
  };
  const { pipe } = make(native);
  assert.equal(await pipe.ask('UNLOCK cGFzcw==', 40000), null);
  assert.equal(native.written.length, 1);
});

test('对面一直不回：到时间返回 null，不重试，句柄关掉', async () => {
  const native = fakeNative({ reply: null });
  const { pipe, clock } = make(native);
  assert.equal(await pipe.ask('UNLOCK cGFzcw==', 40000), null);
  assert.ok(clock.t >= 40000 && clock.t < 40100, `等了 ${clock.t} ms`);
  assert.equal(native.opens, 1);
  assert.equal(native.closed, 1);
});

test('对面回了半行就关了：有内容就当回应，没有返回 null', async () => {
  const half = fakeNative({ reply: 'ERR failed', closeAfterReply: true });
  assert.equal(await make(half).pipe.ask('STATUS', 1500), 'ERR failed');
  const empty = fakeNative({ reply: [], closeAfterReply: true });
  assert.equal(await make(empty).pipe.ask('STATUS', 1500), null);
});

test('回应过长（超过 512 字节还没换行）不再读下去', async () => {
  const native = fakeNative({ reply: 'x'.repeat(2000) });
  assert.equal(await make(native).pipe.ask('STATUS', 1500), null);
});

test('写失败返回 null', async () => {
  const native = fakeNative();
  native.write = () => false;
  assert.equal(await make(native).pipe.ask('STATUS', 1500), null);
  assert.equal(native.closed, 1);
});

test('打包配置带上了这两个新文件，否则装好的被控端 require 不到', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.config.js'), 'utf8');
  assert.match(text, /'unlockpipe\.js'/);
  assert.match(text, /'unlockpipe-native\.js'/);
});
