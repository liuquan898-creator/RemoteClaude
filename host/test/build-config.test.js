'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, wsUrlOf, httpBaseOf, DEFAULT_HOST_APP_ID, DEFAULT_RELEASE_DIR } = require('../../scripts/build-config');

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-build-config-'));
  const file = path.join(dir, 'build.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('服务器地址的整理规则和安卓端的 ServerAddress 一样', () => {
  assert.equal(wsUrlOf('rc.example.com'), 'wss://rc.example.com/ws');
  assert.equal(wsUrlOf(' https://rc.example.com/ '), 'wss://rc.example.com/ws');
  assert.equal(wsUrlOf('wss://rc.example.com/rc/ws'), 'wss://rc.example.com/rc/ws');
  assert.equal(wsUrlOf('ws://10.0.2.2:8787'), 'ws://10.0.2.2:8787/ws');
  assert.equal(wsUrlOf('http://192.168.1.5:8787'), 'ws://192.168.1.5:8787/ws');
  assert.equal(wsUrlOf(''), '');
  assert.equal(wsUrlOf(undefined), '');
  assert.throws(() => wsUrlOf('ftp://rc.example.com'), /不支持/);
  assert.throws(() => wsUrlOf('wss://'), /格式不正确/);

  assert.equal(httpBaseOf('wss://rc.example.com/ws'), 'https://rc.example.com');
  assert.equal(httpBaseOf('wss://rc.example.com/rc/ws'), 'https://rc.example.com/rc');
  assert.equal(httpBaseOf('ws://127.0.0.1:8787/ws'), 'http://127.0.0.1:8787');
  assert.equal(httpBaseOf(''), '');
});

test('没有打包配置：不带服务器地址，其余用默认值', () => {
  const c = load(tmpFile());
  assert.equal(c.exists, false);
  assert.equal(c.server, '');
  assert.equal(c.serverWsUrl, '');
  assert.equal(c.serverHttpBase, '');
  assert.equal(c.hostAppId, DEFAULT_HOST_APP_ID);
  assert.equal(c.releaseSsh, '');
  assert.equal(c.releaseDir, DEFAULT_RELEASE_DIR);
  assert.deepEqual(c.env, {});
});

test('写了打包配置：算出信令地址和下载地址，带上应用标识、上传目标、环境变量', () => {
  const c = load(
    tmpFile({
      server: ' rc.example.com ',
      hostAppId: 'com.example.remoteclaude.host',
      releaseSsh: 'my-server',
      releaseDir: '/srv/rc/releases',
      env: { ELECTRON_MIRROR: 'https://mirror.example/electron/', EMPTY: '', NOT_STRING: 1 },
    })
  );
  assert.equal(c.exists, true);
  assert.equal(c.server, 'rc.example.com');
  assert.equal(c.serverWsUrl, 'wss://rc.example.com/ws');
  assert.equal(c.serverHttpBase, 'https://rc.example.com');
  assert.equal(c.hostAppId, 'com.example.remoteclaude.host');
  assert.equal(c.releaseSsh, 'my-server');
  assert.equal(c.releaseDir, '/srv/rc/releases');
  assert.deepEqual(c.env, { ELECTRON_MIRROR: 'https://mirror.example/electron/' });
});

test('写坏了要报错，不能悄悄当成没配', () => {
  assert.throws(() => load(tmpFile('{ "server": ')), /读取打包配置失败/);
  assert.throws(() => load(tmpFile('[]')), /JSON 对象/);
  assert.throws(() => load(tmpFile({ server: 'ftp://x' })), /不支持/);
});

test('仓库里的样例能读', () => {
  const c = load(path.join(__dirname, '..', '..', 'deploy', 'build.example.json'));
  assert.equal(c.exists, true);
  assert.equal(c.serverWsUrl, 'wss://rc.example.com/ws');
});

test('被控端的打包配置：没配服务器时不带默认服务器，应用标识用默认的', () => {
  const file = tmpFile();
  const saved = process.env.RC_BUILD_CONFIG;
  process.env.RC_BUILD_CONFIG = file;
  const mod = path.join(__dirname, '..', 'electron-builder.config.js');
  delete require.cache[require.resolve(mod)];
  try {
    const cfg = require(mod);
    assert.equal(cfg.appId, DEFAULT_HOST_APP_ID);
    assert.equal(cfg.extraMetadata.defaultServer, '');
    assert.match(cfg.publish[0].url, /^https:\/\/.+\/download\/host$/);
    // 装进安装程序的文件要包含主进程用到的每个模块
    for (const f of ['main.js', 'package.json', 'updater.js', 'sessions/**', 'tiler/**', 'approvals/**']) assert.ok(cfg.files.includes(f), f);

    fs.writeFileSync(file, JSON.stringify({ server: 'rc.example.com', hostAppId: 'com.example.host' }));
    delete require.cache[require.resolve(mod)];
    const cfg2 = require(mod);
    assert.equal(cfg2.appId, 'com.example.host');
    assert.equal(cfg2.extraMetadata.defaultServer, 'wss://rc.example.com/ws');
    assert.equal(cfg2.publish[0].url, 'https://rc.example.com/download/host');
  } finally {
    delete require.cache[require.resolve(mod)];
    if (saved === undefined) delete process.env.RC_BUILD_CONFIG;
    else process.env.RC_BUILD_CONFIG = saved;
  }
});
