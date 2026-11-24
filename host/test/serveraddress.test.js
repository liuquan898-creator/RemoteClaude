'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  wsUrlOf,
  displayOf,
  httpBaseOf,
  wsUrlOfHttpBase,
  readConfig,
  saveServer,
  readAccountServer,
  resolveServer,
} = require('../serveraddress');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-server-address-'));
}

test('服务器地址的整理规则和安卓端的 ServerAddress 一样', () => {
  assert.equal(wsUrlOf('rc.example.com'), 'wss://rc.example.com/ws');
  assert.equal(wsUrlOf(' https://rc.example.com/ '), 'wss://rc.example.com/ws');
  assert.equal(wsUrlOf('https://rc.example.com'), 'wss://rc.example.com/ws');
  assert.equal(wsUrlOf('wss://rc.example.com/ws'), 'wss://rc.example.com/ws');
  assert.equal(wsUrlOf('wss://rc.example.com/rc/ws'), 'wss://rc.example.com/rc/ws');
  assert.equal(wsUrlOf('ws://127.0.0.1:8787/ws'), 'ws://127.0.0.1:8787/ws');
  assert.equal(wsUrlOf('ws://10.0.2.2:8787'), 'ws://10.0.2.2:8787/ws');
  assert.equal(wsUrlOf('http://192.168.1.5:8787'), 'ws://192.168.1.5:8787/ws');
  assert.equal(wsUrlOf('WSS://RC.Example.com/ws'), 'wss://rc.example.com/ws');
  assert.equal(wsUrlOf('rc.example.com:8443'), 'wss://rc.example.com:8443/ws');
  // 查询参数、锚点丢掉
  assert.equal(wsUrlOf('https://rc.example.com/?a=1#x'), 'wss://rc.example.com/ws');
  assert.equal(wsUrlOf(''), '');
  assert.equal(wsUrlOf('   '), '');
  assert.equal(wsUrlOf(undefined), '');
  assert.equal(wsUrlOf(null), '');
});

test('填错的服务器地址报给用户看的原因', () => {
  assert.throws(() => wsUrlOf('ftp://rc.example.com'), /不支持/);
  assert.throws(() => wsUrlOf('file:///C:/x'), /不支持/);
  assert.throws(() => wsUrlOf('javascript://alert(1)'), /不支持/);
  assert.throws(() => wsUrlOf('wss://'), /格式不正确/);
  assert.throws(() => wsUrlOf('rc example.com'), /空格/);
  assert.throws(() => wsUrlOf('wss://user:pass@rc.example.com/ws'), /用户名和密码/);
  assert.throws(() => wsUrlOf('a'.repeat(600)), /太长/);
});

test('信令地址和账号接口地址互相换算', () => {
  assert.equal(httpBaseOf('wss://rc.example.com/ws'), 'https://rc.example.com');
  assert.equal(httpBaseOf('wss://rc.example.com/rc/ws'), 'https://rc.example.com/rc');
  assert.equal(httpBaseOf('ws://127.0.0.1:8787/ws'), 'http://127.0.0.1:8787');
  assert.equal(httpBaseOf(''), '');

  assert.equal(wsUrlOfHttpBase('https://rc.example.com'), 'wss://rc.example.com/ws');
  assert.equal(wsUrlOfHttpBase('https://rc.example.com/rc'), 'wss://rc.example.com/rc/ws');
  assert.equal(wsUrlOfHttpBase('http://127.0.0.1:8787'), 'ws://127.0.0.1:8787/ws');
  for (const ws of ['wss://rc.example.com/ws', 'wss://rc.example.com/rc/ws', 'ws://127.0.0.1:8787/ws']) {
    assert.equal(wsUrlOfHttpBase(httpBaseOf(ws)), ws);
  }
  assert.equal(wsUrlOfHttpBase(''), '');
  assert.equal(wsUrlOfHttpBase(undefined), '');
  assert.equal(wsUrlOfHttpBase(42), '');
  assert.equal(wsUrlOfHttpBase('not a url'), '');
  assert.equal(wsUrlOfHttpBase('ftp://rc.example.com'), '');
});

test('读配置：没有文件当作空配置，写坏了报错，开头的 BOM 不影响', () => {
  const dir = tmpDir();
  assert.deepEqual(readConfig(path.join(dir, 'none.json')), {});
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ "server": ');
  assert.throws(() => readConfig(bad), /读不出来/);
  fs.writeFileSync(bad, '[1]');
  assert.throws(() => readConfig(bad), /JSON 对象/);
  const bom = path.join(dir, 'bom.json');
  fs.writeFileSync(bom, '\uFEFF{ "maxFps": 20 }');
  assert.deepEqual(readConfig(bom), { maxFps: 20 });
});

test('保存服务器地址：只改 server，别的设置原样保留', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  const before = { targets: ['claude.exe'], maxBitrateKbps: 4000, maxFps: 30, claudeSelfCheck: false };
  fs.writeFileSync(file, JSON.stringify(before));
  saveServer(file, 'wss://rc.example.com/ws');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...before, server: 'rc.example.com' });

  saveServer(file, 'ws://127.0.0.1:8787/ws');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...before, server: 'http://127.0.0.1:8787' });
  // 没有留下临时文件
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('保存服务器地址：没有配置文件（和它的目录）就新建', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sub', 'config.json');
  saveServer(file, 'wss://rc.example.com/ws');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { server: 'rc.example.com' });
});

test('保存服务器地址：配置文件写坏了不覆盖，地址不是 ws/wss 不写', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ "targets": [');
  assert.throws(() => saveServer(file, 'wss://rc.example.com/ws'), /读不出来/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "targets": [');

  fs.writeFileSync(file, '{}');
  for (const bad of ['https://rc.example.com', 'rc.example.com', '', 'wss://a b']) {
    assert.throws(() => saveServer(file, bad), /ws:\/\/ 或 wss:\/\//);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
});

test('从登录状态读上次登录的服务器', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'account.json');
  assert.equal(readAccountServer(file), '');
  fs.writeFileSync(file, JSON.stringify({ server: 'https://rc.example.com', email: 'a@example.com', token: 'xx' }) + '\n');
  assert.equal(readAccountServer(file), 'https://rc.example.com');
  fs.writeFileSync(file, '{ broken');
  assert.equal(readAccountServer(file), '');
  fs.writeFileSync(file, JSON.stringify({ email: 'a@example.com' }));
  assert.equal(readAccountServer(file), '');
});

test('启动时选服务器：配置里写了就用配置里的', () => {
  assert.deepEqual(resolveServer({ configured: 'wss://rc.example.com/ws', accountServer: 'https://other.example.com' }), {
    server: 'wss://rc.example.com/ws',
    source: 'config',
    input: 'wss://rc.example.com/ws',
    error: '',
  });
  // 只写了域名也行
  assert.equal(resolveServer({ configured: 'rc.example.com' }).server, 'wss://rc.example.com/ws');
});

test('启动时选服务器：配置里写错了不连，也不拿登录状态里的顶上，让用户改', () => {
  const r = resolveServer({ configured: 'ftp://rc.example.com', accountServer: 'https://rc.example.com' });
  assert.equal(r.server, '');
  assert.equal(r.source, 'none');
  assert.equal(r.input, 'ftp://rc.example.com');
  assert.match(r.error, /配置文件里的服务器地址不对/);

  const r2 = resolveServer({ configured: 123, accountServer: 'https://rc.example.com' });
  assert.equal(r2.server, '');
  assert.match(r2.error, /字符串/);
});

test('启动时选服务器：旧版升级上来，配置里没有 server，按登录状态里的服务器找回', () => {
  // 0.9.25 及以前的安装包带着默认服务器 wss://rc.example.com/ws，登录后 account.json 记的是 https://rc.example.com
  for (const configured of [undefined, null, '', '   ']) {
    assert.deepEqual(resolveServer({ configured, accountServer: 'https://rc.example.com' }), {
      server: 'wss://rc.example.com/ws',
      source: 'account',
      input: 'rc.example.com',
      error: '',
    });
  }
});

test('启动时选服务器：什么都没有就空着，登录页让用户填', () => {
  assert.deepEqual(resolveServer({ configured: undefined, accountServer: '' }), { server: '', source: 'none', input: '', error: '' });
  assert.deepEqual(resolveServer({}), { server: '', source: 'none', input: '', error: '' });
  assert.equal(resolveServer({ accountServer: 'garbage' }).source, 'none');
});

test('升级迁移整个流程：配置文件补上 server，别的设置不动，第二次启动直接用配置里的', () => {
  const dir = tmpDir();
  const configFile = path.join(dir, 'config.json');
  const accountFile = path.join(dir, 'account.json');
  const before = { targets: ['claude.exe'], maxBitrateKbps: 4000, maxFps: 30, claudeSelfCheck: false };
  fs.writeFileSync(configFile, JSON.stringify(before, null, 2));
  fs.writeFileSync(accountFile, JSON.stringify({ server: 'https://rc.example.com', email: 'a@example.com', token: 'enc' }));

  const first = resolveServer({ configured: readConfig(configFile).server, accountServer: readAccountServer(accountFile) });
  assert.equal(first.source, 'account');
  saveServer(configFile, first.server);
  assert.deepEqual(readConfig(configFile), { ...before, server: 'rc.example.com' });

  // 之后哪怕退出登录（account.json 没了），也还记得服务器
  fs.unlinkSync(accountFile);
  const second = resolveServer({ configured: readConfig(configFile).server, accountServer: readAccountServer(accountFile) });
  assert.equal(second.source, 'config');
  assert.equal(second.server, 'wss://rc.example.com/ws');
});

test('简写：界面显示和配置文件存的写法和手机 App 一样，并且能原样换算回信令地址', () => {
  const cases = [
    ['wss://rc.example.com/ws', 'rc.example.com'],
    ['wss://rc.example.com:8443/ws', 'rc.example.com:8443'],
    ['wss://rc.example.com/rc/ws', 'rc.example.com/rc/ws'],
    ['ws://127.0.0.1:8787/ws', 'http://127.0.0.1:8787'],
    ['ws://10.0.2.2:8787/signal', 'http://10.0.2.2:8787/signal'],
  ];
  for (const [ws, short] of cases) {
    assert.equal(displayOf(ws), short);
    assert.equal(wsUrlOf(short), ws);
  }
  assert.equal(displayOf(''), '');
  assert.equal(displayOf('not a url'), 'not a url');
});
