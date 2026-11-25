'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  createUnlockInstaller,
  normalizeSource,
  sourceVersion,
  defaultPowerShell,
  EXIT_NOT_ELEVATED,
} = require('../unlockinstall');

const DIR = 'C:\\app\\resources\\unlock-service';
const INSTALLED = 'C:\\Program Files\\RemoteClaude';
const BUNDLED = path.join(DIR, 'UnlockService.cs');
const INSTALLED_SRC = path.win32.join(INSTALLED, 'UnlockService.cs');
const SOURCE = Buffer.from('class A {\r\n  // 解锁\r\n}\r\n', 'utf8');

function enoent() {
  return Object.assign(new Error('no such file'), { code: 'ENOENT' });
}

/** files：路径 -> Buffer；没有的路径报 ENOENT */
function fakeFs(files) {
  return (file) => (files[file] ? Promise.resolve(files[file]) : Promise.reject(enoent()));
}

/** replies：依次给 STATUS 的回应，用完了就一直是最后一个 */
function fakeAsk(replies) {
  const calls = [];
  const ask = (line, timeoutMs) => {
    calls.push({ line, timeoutMs });
    return Promise.resolve(replies[Math.min(calls.length - 1, replies.length - 1)]);
  };
  return { ask, calls };
}

function make({ files = { [BUNDLED]: SOURCE }, exitCode = 0, runError = null, replies = [{ line: 'OK locked=0' }] } = {}) {
  const runs = [];
  const logs = [];
  const sleeps = [];
  const { ask, calls } = fakeAsk(replies);
  const inst = createUnlockInstaller({
    dir: DIR,
    installedDir: INSTALLED,
    powershell: 'PS.EXE',
    ask,
    readFile: fakeFs(files),
    run: (file, args) => {
      runs.push({ file, args });
      return runError ? Promise.reject(runError) : Promise.resolve(exitCode);
    },
    log: (m) => logs.push(m),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { inst, runs, logs, sleeps, calls };
}

test('normalizeSource 不管 BOM 和行尾', () => {
  assert.equal(normalizeSource(Buffer.from('\uFEFFa\r\nb\r\n', 'utf8')), 'a\nb\n');
  assert.equal(normalizeSource(Buffer.from('a\nb\n', 'utf8')), 'a\nb\n');
});

test('defaultPowerShell 用 64 位的 Windows PowerShell 5.1', () => {
  assert.equal(defaultPowerShell({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(defaultPowerShell({}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('sourceState：没装过是 missing', async () => {
  const { inst } = make();
  assert.equal(await inst.sourceState(), 'missing');
});

/** 带版本号那一行的源码 */
function versioned(version, body = 'class A {}') {
  return Buffer.from(`// 说明\r\n// UNLOCK_SERVICE_VERSION ${version}\r\n${body}\r\n`, 'utf8');
}

test('sourceVersion：读 "// UNLOCK_SERVICE_VERSION <数字>" 那一行，没有是 0', () => {
  assert.equal(sourceVersion(normalizeSource(versioned(12))), 12);
  assert.equal(sourceVersion('class A {}\n'), 0);
  assert.equal(sourceVersion('var s = "UNLOCK_SERVICE_VERSION 3";\n'), 0);
});

test('sourceState：内容一样、只差行尾是 current', async () => {
  const lf = Buffer.from(versioned(2).toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  const { inst } = make({ files: { [BUNDLED]: versioned(2), [INSTALLED_SRC]: lf } });
  assert.equal(await inst.sourceState(), 'current');
});

test('sourceState：自带的版本号大是 outdated', async () => {
  const { inst } = make({ files: { [BUNDLED]: versioned(3, 'class New {}'), [INSTALLED_SRC]: versioned(2) } });
  assert.equal(await inst.sourceState(), 'outdated');
});

test('sourceState：装的比自带的还新（比如从别的分支装的）是 current，不提示换旧', async () => {
  const { inst } = make({ files: { [BUNDLED]: versioned(2), [INSTALLED_SRC]: versioned(3, 'class New {}') } });
  assert.equal(await inst.sourceState(), 'current');
});

test('sourceState：版本号一样、内容不一样（开发时改了没加版本号）是 current', async () => {
  const { inst } = make({ files: { [BUNDLED]: versioned(2, 'class B {}'), [INSTALLED_SRC]: versioned(2) } });
  assert.equal(await inst.sourceState(), 'current');
});

test('sourceState：加版本号之前装的，除了版本号那一行一样就是 current', async () => {
  const old = Buffer.from('// 说明\r\nclass A {}\r\n', 'utf8');
  const { inst } = make({ files: { [BUNDLED]: versioned(1), [INSTALLED_SRC]: old } });
  assert.equal(await inst.sourceState(), 'current');
});

test('sourceState：加版本号之前装的，内容也不一样就是旧版', async () => {
  const old = Buffer.from('// 说明\r\nclass Old {}\r\n', 'utf8');
  const { inst } = make({ files: { [BUNDLED]: versioned(1), [INSTALLED_SRC]: old } });
  assert.equal(await inst.sourceState(), 'outdated');
});

/**
 * 每个版本号登记一次源码的哈希（normalizeSource 之后的 SHA256）。改了 UnlockService.cs 而没加版本号，
 * 已经装了这个版本号的电脑就不会提示更新，所以这里拦一下
 */
const RELEASED_SOURCES = {
  1: 'd299c0bfffc0fe90dc8fd03753a09f6cdd9ef16139224f9bad3f1d69c02a0488',
  // 2：合进远程桌面接回（ATTACH 命令、接回前核对密码）
  2: '4d74d4f13f0a277f75240acc5cbf4abd12f1b5e67ad78e7269b085ee0be86b7d',
  // 3：虚拟屏（DISPLAY ON/OFF、PING、--install-display）、隐私屏（SHADE ON/OFF/END、--shade），docs/11
  3: 'dc941151d6c6b4092386ede1a50f4d12c8547a2c0e3bc18e27898ece3e70f05f',
};

test('改了 UnlockService.cs 就要加版本号，并在 RELEASED_SOURCES 里登记', () => {
  const text = normalizeSource(fs.readFileSync(path.join(__dirname, '..', 'unlock-service', 'UnlockService.cs')));
  const version = sourceVersion(text);
  assert.ok(version >= 1, 'UnlockService.cs 里要有一行 "// UNLOCK_SERVICE_VERSION <数字>"');
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  assert.equal(
    RELEASED_SOURCES[version],
    hash,
    RELEASED_SOURCES[version]
      ? `UnlockService.cs 改过了，但版本号还是 ${version}：把它加 1，再把 ${version + 1}: '<新哈希>' 登记进 RELEASED_SOURCES`
      : `版本 ${version} 还没登记：在 RELEASED_SOURCES 里加上 ${version}: '${hash}'`,
  );
});

test('sourceState：被控端里没有自带的源码是 no-bundle', async () => {
  const { inst } = make({ files: { [INSTALLED_SRC]: SOURCE } });
  assert.equal(await inst.sourceState(), 'no-bundle');
});

test('state：读文件出了 ENOENT 以外的错，报 unknown 并记日志', async () => {
  const logs = [];
  const inst = createUnlockInstaller({
    dir: DIR,
    installedDir: INSTALLED,
    ask: () => Promise.resolve({}),
    readFile: () => Promise.reject(Object.assign(new Error('拒绝访问'), { code: 'EACCES' })),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(await inst.state(), { source: 'unknown', installing: false });
  assert.match(logs[0], /拒绝访问/);
});

test('install：隐藏窗口里运行自带的脚本，带上 -FromHost 和自带源码的哈希', async () => {
  const { inst, runs } = make();
  const r = await inst.install();
  assert.equal(r.result, 'ok');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].file, 'PS.EXE');
  const hash = crypto.createHash('sha256').update(SOURCE).digest('hex').toUpperCase();
  assert.deepEqual(runs[0].args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(DIR, 'install.ps1'),
    '-FromHost',
    '-ExpectSha256',
    hash,
  ]);
});

test('install：脚本退出码 0 以后问 STATUS，服务还没起来时隔一秒再问', async () => {
  const { inst, calls, sleeps } = make({ replies: [{ error: 'no-service' }, { error: 'no-service' }, { line: 'OK locked=0' }] });
  const r = await inst.install();
  assert.deepEqual(r, { result: 'ok', exitCode: 0 });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.line === 'STATUS'));
  assert.deepEqual(sleeps, [1000, 1000]);
});

test('install：一直没回应，问 10 次后报 no-response', async () => {
  const { inst, calls } = make({ replies: [{ error: 'no-service' }] });
  const r = await inst.install();
  assert.equal(r.result, 'no-response');
  assert.equal(calls.length, 10);
});

test('install：装完核实不过报 untrusted，不再接着问', async () => {
  const { inst, calls } = make({ replies: [{ error: 'untrusted' }] });
  const r = await inst.install();
  assert.equal(r.result, 'untrusted');
  assert.equal(calls.length, 1);
});

test('install：退出码 2 是没能以管理员身份运行，不去问服务', async () => {
  const { inst, calls } = make({ exitCode: EXIT_NOT_ELEVATED });
  const r = await inst.install();
  assert.deepEqual(r, { result: 'canceled', exitCode: 2 });
  assert.equal(calls.length, 0);
});

test('install：其它退出码是失败，带上退出码', async () => {
  for (const code of [1, -196608, null]) {
    const { inst, calls } = make({ exitCode: code });
    const r = await inst.install();
    assert.deepEqual(r, { result: 'failed', exitCode: code });
    assert.equal(calls.length, 0);
  }
});

test('install：启动不了 PowerShell 是失败', async () => {
  const { inst, logs } = make({ runError: new Error('spawn ENOENT') });
  const r = await inst.install();
  assert.deepEqual(r, { result: 'failed' });
  assert.ok(logs.some((m) => m.includes('spawn ENOENT')));
});

test('install：被控端里缺自带的源码时不运行脚本', async () => {
  const { inst, runs } = make({ files: {} });
  assert.deepEqual(await inst.install(), { result: 'no-bundle' });
  assert.equal(runs.length, 0);
});

test('install：正在装时再点报 busy，装完以后可以再装', async () => {
  let finish;
  const inst = createUnlockInstaller({
    dir: DIR,
    installedDir: INSTALLED,
    ask: () => Promise.resolve({ line: 'OK locked=0' }),
    readFile: fakeFs({ [BUNDLED]: SOURCE }),
    run: () => new Promise((r) => (finish = r)),
    sleep: () => Promise.resolve(),
  });
  const first = inst.install();
  // 等第一次走到 run（读文件是异步的）
  while (!finish) await new Promise((r) => setImmediate(r));
  assert.equal((await inst.state()).installing, true);
  assert.deepEqual(await inst.install(), { result: 'busy' });
  finish(0);
  assert.equal((await first).result, 'ok');
  assert.equal((await inst.state()).installing, false);
  finish = null;
  const again = inst.install();
  while (!finish) await new Promise((r) => setImmediate(r));
  finish(1);
  assert.equal((await again).result, 'failed');
});
