'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./helpers');

function makeReleases() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-rel-'));
  fs.mkdirSync(path.join(dir, 'android'));
  fs.mkdirSync(path.join(dir, 'host'));
  fs.writeFileSync(path.join(dir, 'android', 'RemoteClaude-0.7.0.apk'), Buffer.from('fake-apk'));
  fs.writeFileSync(
    path.join(dir, 'android', 'latest.json'),
    JSON.stringify({ package: 'com.remoteclaude.android', versionCode: 8, versionName: '0.7.0', file: 'RemoteClaude-0.7.0.apk', size: 8, sha256: 'abc', notes: '修了些问题' })
  );
  fs.writeFileSync(path.join(dir, 'host', 'latest.yml'), 'version: 0.7.0\n');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope');
  return dir;
}

test('安装包：要登录才能查版本和下载，文件名不能越出发布目录', async (t) => {
  const dir = makeReleases();
  const s = await startServer({ releasesDir: dir });
  t.after(() => {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const viewer = await s.register('a@example.com');
  const host = (await s.login('a@example.com', 'password-123', 'host', 'pc-1', '电脑')).body.token;
  const get = (p, token, method = 'GET') =>
    fetch(s.base + p, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });

  assert.equal((await get('/api/update/android')).status, 401);
  assert.equal((await get('/download/android/RemoteClaude-0.7.0.apk')).status, 401);
  assert.equal((await get('/download/host/latest.yml', 'not-a-token')).status, 401);

  const res = await get('/api/update/android', viewer);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    package: 'com.remoteclaude.android',
    versionCode: 8,
    versionName: '0.7.0',
    notes: '修了些问题',
    size: 8,
    sha256: 'abc',
    releasedAt: '',
    url: '/download/android/RemoteClaude-0.7.0.apk',
  });

  const apk = await get('/download/android/RemoteClaude-0.7.0.apk', viewer);
  assert.equal(apk.status, 200);
  assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(Buffer.from(await apk.arrayBuffer()).toString(), 'fake-apk');

  // 电脑用自己的令牌拿更新说明
  const yml = await get('/download/host/latest.yml', host);
  assert.equal(yml.status, 200);
  assert.equal(await yml.text(), 'version: 0.7.0\n');
  assert.equal((await get('/download/host/latest.yml', host, 'HEAD')).headers.get('content-length'), '15');

  for (const bad of ['/download/android/../secret.txt', '/download/android/%2e%2e%2fsecret.txt', '/download/other/x', '/download/host/', '/download/android/a/b']) {
    assert.equal((await get(bad, viewer)).status, 404, bad);
  }
  assert.equal((await get('/download/android/nope.apk', viewer)).status, 404);
  assert.equal((await get('/api/update/host', viewer)).status, 404);
});

test('安装包：支持 Range，断线后能从断点接着下', async (t) => {
  const dir = makeReleases();
  const s = await startServer({ releasesDir: dir });
  t.after(() => {
    s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const viewer = await s.register('r@example.com');
  const get = (range, method = 'GET') =>
    fetch(s.base + '/download/android/RemoteClaude-0.7.0.apk', {
      method,
      headers: { authorization: `Bearer ${viewer}`, ...(range ? { range } : {}) },
    });
  const body = async (res) => Buffer.from(await res.arrayBuffer()).toString();

  // 文件内容是 'fake-apk'（8 字节）
  const full = await get();
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');

  let r = await get('bytes=5-');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 5-7/8');
  assert.equal(r.headers.get('content-length'), '3');
  assert.equal(await body(r), 'apk');

  r = await get('bytes=0-3');
  assert.equal(r.status, 206);
  assert.equal(await body(r), 'fake');

  r = await get('bytes=2-100'); // 结尾超出文件就截到文件末尾
  assert.equal(r.headers.get('content-range'), 'bytes 2-7/8');
  assert.equal(await body(r), 'ke-apk');

  r = await get('bytes=-3'); // 最后 3 字节
  assert.equal(r.status, 206);
  assert.equal(await body(r), 'apk');

  r = await get('bytes=8-');
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), 'bytes */8');

  // 看不懂的、多段的、倒过来的都照常回整个文件
  for (const bad of ['bytes=0-1,4-5', 'items=0-1', 'bytes=-', 'bytes=5-2']) {
    r = await get(bad);
    assert.equal(r.status, 200, bad);
    assert.equal(await body(r), 'fake-apk', bad);
  }

  r = await get('bytes=4-', 'HEAD');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-length'), '4');
});

test('安装包：还没发布时回 no-release', async (t) => {
  const s = await startServer({ releasesDir: path.join(os.tmpdir(), 'rc-rel-none-' + Date.now()) });
  t.after(() => s.close());
  const viewer = await s.register('b@example.com');
  const res = await fetch(s.base + '/api/update/android', { headers: { authorization: `Bearer ${viewer}` } });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'no-release');
});
