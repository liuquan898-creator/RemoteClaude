'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, DEFAULT_HOST_APP_ID, DEFAULT_RELEASE_DIR } = require('../../scripts/build-config');

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-build-config-'));
  const file = path.join(dir, 'build.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('没有打包配置：全用默认值', () => {
  const c = load(tmpFile());
  assert.equal(c.exists, false);
  assert.equal(c.legacyServer, '');
  assert.equal(c.hostAppId, DEFAULT_HOST_APP_ID);
  assert.equal(c.releaseSsh, '');
  assert.equal(c.releaseDir, DEFAULT_RELEASE_DIR);
  assert.deepEqual(c.env, {});
});

test('写了打包配置：带上应用标识、上传目标、环境变量；以前的 server 只记下来，不再算地址', () => {
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
  assert.equal(c.legacyServer, 'rc.example.com');
  assert.equal(c.serverWsUrl, undefined);
  assert.equal(c.hostAppId, 'com.example.remoteclaude.host');
  assert.equal(c.releaseSsh, 'my-server');
  assert.equal(c.releaseDir, '/srv/rc/releases');
  assert.deepEqual(c.env, { ELECTRON_MIRROR: 'https://mirror.example/electron/' });
});

test('写坏了要报错，不能悄悄当成没配', () => {
  assert.throws(() => load(tmpFile('{ "server": ')), /读取打包配置失败/);
  assert.throws(() => load(tmpFile('[]')), /JSON 对象/);
  // server 不再使用，写成什么都不影响打包
  assert.equal(load(tmpFile({ server: 'ftp://x' })).legacyServer, 'ftp://x');
});

test('仓库里的样例能读，样例里不再有 server', () => {
  const c = load(path.join(__dirname, '..', '..', 'deploy', 'build.example.json'));
  assert.equal(c.exists, true);
  assert.equal(c.legacyServer, '');
  assert.equal(c.releaseSsh, 'my-server');
});

test('被控端的打包配置：任何时候都不带服务器地址，应用标识用打包配置里的', () => {
  const file = tmpFile();
  const saved = process.env.RC_BUILD_CONFIG;
  process.env.RC_BUILD_CONFIG = file;
  const mod = path.join(__dirname, '..', 'electron-builder.config.js');
  delete require.cache[require.resolve(mod)];
  try {
    const cfg = require(mod);
    assert.equal(cfg.appId, DEFAULT_HOST_APP_ID);
    assert.equal((cfg.extraMetadata || {}).defaultServer, undefined);
    assert.equal(cfg.publish[0].url, 'https://rc.example.com/download/host');
    // 装进安装程序的文件要包含主进程用到的每个模块
    for (const f of ['main.js', 'package.json', 'updater.js', 'account.js', 'serveraddress.js', 'sessions/**', 'tiler/**', 'approvals/**']) {
      assert.ok(cfg.files.includes(f), f);
    }

    // 打包配置里还留着以前的 server：也不能写进安装包
    fs.writeFileSync(file, JSON.stringify({ server: 'rc.my-own.example', hostAppId: 'com.example.host' }));
    delete require.cache[require.resolve(mod)];
    const cfg2 = require(mod);
    assert.equal(cfg2.appId, 'com.example.host');
    assert.equal((cfg2.extraMetadata || {}).defaultServer, undefined);
    assert.doesNotMatch(JSON.stringify(cfg2), /my-own/);
    assert.equal(cfg2.publish[0].url, 'https://rc.example.com/download/host');
  } finally {
    delete require.cache[require.resolve(mod)];
    if (saved === undefined) delete process.env.RC_BUILD_CONFIG;
    else process.env.RC_BUILD_CONFIG = saved;
  }
});
