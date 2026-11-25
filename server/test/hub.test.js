'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connect, auth } = require('./helpers');

/** 注册一个账号，再让一台电脑登录，返回两个令牌 */
async function account(s, email, hostId = 'pc-1', hostName = '办公室电脑') {
  const viewerToken = await s.register(email, 'password-123', { deviceId: `phone-${hostId}` });
  const host = await s.login(email, 'password-123', 'host', hostId, hostName);
  assert.equal(host.status, 200);
  return { viewerToken, hostToken: host.body.token };
}

test('同一账号的电脑和控制端配对并互相转发', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { viewerToken, hostToken } = await account(s, 'a@example.com');

  const host = await connect(s.wsUrl, auth('host', hostToken));
  const hostOk = await host.next('auth-ok');
  assert.equal(hostOk.hostId, 'pc-1');
  assert.equal(hostOk.email, 'a@example.com');

  const viewer = await connect(s.wsUrl, auth('viewer', viewerToken));
  const ok = await viewer.next('auth-ok');
  assert.deepEqual(ok.hosts, [{ id: 'pc-1', name: '办公室电脑', online: true }]);
  assert.equal((await host.next('viewer-join')).id, ok.id);

  viewer.send(JSON.stringify({ type: 'list', host: 'pc-1' }));
  assert.deepEqual(await host.next('list'), { type: 'list', host: 'pc-1', from: ok.id });

  host.send(JSON.stringify({ type: 'windows', to: ok.id, list: [{ hwnd: 1, title: 'x' }] }));
  assert.deepEqual(await viewer.next('windows'), { type: 'windows', list: [{ hwnd: 1, title: 'x' }], host: 'pc-1' });

  // 缩略图后补（协议文档 2.4）靠 list、windows 上多出的 thumbs 字段，服务器不认识它也要原样转发
  viewer.send(JSON.stringify({ type: 'list', host: 'pc-1', thumbs: 'later' }));
  assert.deepEqual(await host.next('list'), { type: 'list', host: 'pc-1', thumbs: 'later', from: ok.id });
  host.send(JSON.stringify({ type: 'windows', to: ok.id, thumbs: 'pending', list: [{ hwnd: 1, title: 'x', thumb: null }] }));
  assert.deepEqual(await viewer.next('windows'), { type: 'windows', thumbs: 'pending', list: [{ hwnd: 1, title: 'x', thumb: null }], host: 'pc-1' });

  viewer.send(JSON.stringify({ type: 'list', host: 'pc-9' }));
  assert.deepEqual(await viewer.next('error'), { type: 'error', code: 'host-offline', host: 'pc-9' });

  viewer.send(JSON.stringify({ type: 'evil', host: 'pc-1' }));
  await host.none('evil');

  host.close();
  assert.deepEqual((await viewer.next('hosts')).hosts, [{ id: 'pc-1', name: '办公室电脑', online: false }], '电脑下线后仍在列表里，标为离线');

  const host2 = await connect(s.wsUrl, auth('host', hostToken));
  await host2.next('auth-ok');
  assert.equal((await viewer.next('hosts')).hosts[0].online, true);
  viewer.close();
  assert.equal((await host2.next('viewer-leave')).id, ok.id);
  host2.close();
});

test('不同账号互相隔离', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const a = await account(s, 'a@example.com', 'pc-a');
  const b = await account(s, 'b@example.com', 'pc-b');

  const hostA = await connect(s.wsUrl, auth('host', a.hostToken));
  await hostA.next('auth-ok');
  const viewerB = await connect(s.wsUrl, auth('viewer', b.viewerToken));
  const okB = await viewerB.next('auth-ok');
  assert.deepEqual(okB.hosts, [{ id: 'pc-b', name: '办公室电脑', online: false }], '只看得到自己账号的电脑');
  await hostA.none('viewer-join');

  viewerB.send(JSON.stringify({ type: 'list', host: 'pc-a' }));
  assert.equal((await viewerB.next('error')).code, 'host-offline');
  await hostA.none('list');

  hostA.send(JSON.stringify({ type: 'windows', to: okB.id, list: [] }));
  await viewerB.none('windows');
  hostA.close();
  viewerB.close();
});

test('角色不符、协议版本不对、令牌无效都被拒绝', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { viewerToken, hostToken } = await account(s, 'a@example.com');

  const asHost = await connect(s.wsUrl, auth('host', viewerToken));
  assert.equal((await asHost.next('auth-fail')).reason, 'bad-token');
  assert.equal(await asHost.closed, 4003);

  const oldProto = await connect(s.wsUrl, auth('host', hostToken, { proto: 1 }));
  assert.equal((await oldProto.next('auth-fail')).reason, 'bad-proto');

  const garbage = await connect(s.wsUrl, auth('viewer', 'not-a-token'));
  assert.equal((await garbage.next('auth-fail')).reason, 'bad-token');
});

test('同一台电脑再次连上时顶替旧连接', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { hostToken } = await account(s, 'a@example.com');

  const first = await connect(s.wsUrl, auth('host', hostToken));
  await first.next('auth-ok');
  const second = await connect(s.wsUrl, auth('host', hostToken));
  await second.next('auth-ok');
  await first.next('replaced');
  assert.equal(await first.closed, 4002);
  second.close();
});

test('电脑退出登录后从列表消失，连接被断开', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { viewerToken, hostToken } = await account(s, 'a@example.com');

  const host = await connect(s.wsUrl, auth('host', hostToken));
  await host.next('auth-ok');
  const viewer = await connect(s.wsUrl, auth('viewer', viewerToken));
  assert.equal((await viewer.next('auth-ok')).hosts.length, 1);

  await s.post('/api/auth/logout', {}, { token: hostToken });
  assert.equal((await host.next('auth-fail')).reason, 'revoked');
  assert.equal(await host.closed, 4003);
  assert.deepEqual((await viewer.next('hosts')).hosts, []);
  viewer.close();
});

test('电脑记下的解锁密码（密文）：只有它自己能存、取、删，别的电脑、控制端碰不到；格式不对拒收', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { viewerToken, hostToken } = await account(s, 'a@example.com');
  const other = await s.login('a@example.com', 'password-123', 'host', 'pc-2', '家里电脑');
  const host = await connect(s.wsUrl, auth('host', hostToken));
  await host.next('auth-ok');
  const host2 = await connect(s.wsUrl, auth('host', other.body.token));
  await host2.next('auth-ok');
  const ask = async (ws, msg) => {
    ws.send(JSON.stringify({ type: 'unlock-secret', ...msg }));
    return ws.next('unlock-secret');
  };

  assert.deepEqual(await ask(host, { op: 'get' }), { type: 'unlock-secret', op: 'get', ok: true, blob: null });
  assert.deepEqual(await ask(host, { op: 'put', blob: 'djEwAAEC+/8=' }), { type: 'unlock-secret', op: 'put', ok: true });
  assert.equal((await ask(host, { op: 'get' })).blob, 'djEwAAEC+/8=');
  // 编号来自登录令牌：消息里写别的电脑也没用
  assert.equal((await ask(host2, { op: 'get', host: 'pc-1' })).blob, null, '别的电脑读不到');
  assert.equal((await ask(host, { op: 'put', blob: 'not base64!' })).error, 'bad-blob');
  assert.equal((await ask(host, { op: 'put', blob: 'A'.repeat(4097) })).error, 'bad-blob');
  assert.equal((await ask(host, { op: 'put' })).error, 'bad-blob');
  assert.equal((await ask(host, { op: 'steal' })).error, 'bad-op');
  assert.equal((await ask(host, { op: 'get' })).blob, 'djEwAAEC+/8=', '拒收的没把原来的盖掉');

  // 控制端发这个类型不处理、也不转发给电脑
  const viewer = await connect(s.wsUrl, auth('viewer', viewerToken));
  await viewer.next('auth-ok');
  viewer.send(JSON.stringify({ type: 'unlock-secret', op: 'get', host: 'pc-1' }));
  await viewer.none('unlock-secret');
  await host.none('unlock-secret');

  assert.deepEqual(await ask(host, { op: 'delete' }), { type: 'unlock-secret', op: 'delete', ok: true });
  assert.equal((await ask(host, { op: 'get' })).blob, null);
  // 等服务器处理完控制端断开，再关服务器（不然断开时刷新电脑列表会碰到已经关掉的数据库）
  viewer.close();
  await host.next('viewer-leave');
});

test('电脑退出登录、账号重置密码时，记下的解锁密码一起删掉', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { hostToken } = await account(s, 'a@example.com');
  const store = s.app.store;
  const userId = store.findUserByEmail('a@example.com').id;
  store.putUnlockSecret(userId, 'pc-1', 'QUJD', 1);
  store.putUnlockSecret(userId, 'pc-2', 'REVG', 1);
  // 定时清理：没有登录令牌的电脑（过期了、没再登录）记下的删掉，登录着的留着
  const other = await s.login('a@example.com', 'password-123', 'host', 'pc-2', '家里电脑');
  store.putUnlockSecret(userId, 'pc-gone', 'R0hJ', 1);
  store.purgeExpired(Date.now());
  assert.equal(store.getUnlockSecret(userId, 'pc-gone'), null);
  assert.equal(store.getUnlockSecret(userId, 'pc-2'), 'REVG');
  assert.equal(other.status, 200);
  await s.post('/api/auth/logout', {}, { token: hostToken });
  assert.equal(store.getUnlockSecret(userId, 'pc-1'), null, '退出登录的那台删掉');
  assert.equal(store.getUnlockSecret(userId, 'pc-2'), 'REVG', '别的电脑的不动');

  await s.post('/api/auth/send-code', { email: 'a@example.com', purpose: 'reset' });
  const r = await s.post('/api/auth/reset-password', { email: 'a@example.com', password: 'password-456', code: s.lastCode('a@example.com') });
  assert.equal(r.status, 200);
  assert.equal(store.getUnlockSecret(userId, 'pc-2'), null, '重置密码后都删掉');
});

test('电脑先断开、再退出登录，控制端的列表也会刷新', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { viewerToken, hostToken } = await account(s, 'a@example.com');

  const host = await connect(s.wsUrl, auth('host', hostToken));
  await host.next('auth-ok');
  const viewer = await connect(s.wsUrl, auth('viewer', viewerToken));
  assert.equal((await viewer.next('auth-ok')).hosts.length, 1);

  host.close();
  assert.equal((await viewer.next('hosts')).hosts[0].online, false);
  await s.post('/api/auth/logout', {}, { token: hostToken });
  assert.deepEqual((await viewer.next('hosts')).hosts, []);
  viewer.close();
});

test('一个账号多台电脑：按 host 字段分别转发', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { viewerToken, hostToken: officeToken } = await account(s, 'a@example.com', 'office', '办公室');
  const home = await s.login('a@example.com', 'password-123', 'host', 'home', '家里');

  const office = await connect(s.wsUrl, auth('host', officeToken));
  await office.next('auth-ok');
  const homeWs = await connect(s.wsUrl, auth('host', home.body.token));
  await homeWs.next('auth-ok');

  const viewer = await connect(s.wsUrl, auth('viewer', viewerToken));
  const ok = await viewer.next('auth-ok');
  assert.deepEqual(ok.hosts.map((h) => h.id).sort(), ['home', 'office']);
  assert.ok(ok.hosts.every((h) => h.online));

  viewer.send(JSON.stringify({ type: 'select', host: 'home', hwnd: 5 }));
  assert.equal((await homeWs.next('select')).hwnd, 5);
  await office.none('select');

  office.send(JSON.stringify({ type: 'selected', to: ok.id, hwnd: 7, title: 't' }));
  assert.equal((await viewer.next('selected')).host, 'office');
  for (const w of [office, homeWs, viewer]) w.close();
});

test('浏览、打开、新建、关闭会话的消息双向转发', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { viewerToken, hostToken } = await account(s, 'a@example.com');
  const host = await connect(s.wsUrl, auth('host', hostToken));
  await host.next('auth-ok');
  const viewer = await connect(s.wsUrl, auth('viewer', viewerToken));
  const ok = await viewer.next('auth-ok');

  viewer.send(JSON.stringify({ type: 'list-sessions', host: 'pc-1' }));
  assert.equal((await host.next('list-sessions')).from, ok.id);
  viewer.send(JSON.stringify({ type: 'open-session', host: 'pc-1', session: 'local_1', req: 'r1' }));
  assert.equal((await host.next('open-session')).session, 'local_1');
  viewer.send(JSON.stringify({ type: 'new-session', host: 'pc-1', env: 'e1', req: 'r2' }));
  assert.equal((await host.next('new-session')).env, 'e1');

  host.send(JSON.stringify({ type: 'sessions', to: ok.id, available: true, groups: [] }));
  assert.deepEqual(await viewer.next('sessions'), { type: 'sessions', available: true, groups: [], host: 'pc-1' });
  host.send(JSON.stringify({ type: 'session-opened', to: ok.id, req: 'r1', hwnd: 9, title: 't' }));
  assert.equal((await viewer.next('session-opened')).hwnd, 9);
  host.send(JSON.stringify({ type: 'session-failed', to: ok.id, req: 'r2', code: 'locked' }));
  assert.equal((await viewer.next('session-failed')).code, 'locked');

  viewer.send(JSON.stringify({ type: 'close-window', host: 'pc-1', hwnd: 9, title: 't', req: 'c1' }));
  const close = await host.next('close-window');
  assert.deepEqual([close.hwnd, close.title, close.req, close.from], [9, 't', 'c1', ok.id]);
  host.send(JSON.stringify({ type: 'close-window-result', to: ok.id, req: 'c1', hwnd: 9, ok: true }));
  assert.deepEqual(await viewer.next('close-window-result'), { type: 'close-window-result', req: 'c1', hwnd: 9, ok: true, host: 'pc-1' });

  viewer.send(JSON.stringify({ type: 'host-update', host: 'pc-1', op: 'install' }));
  assert.equal((await host.next('host-update')).op, 'install');
  host.send(JSON.stringify({ type: 'host-update-state', to: ok.id, version: '0.7.0', status: 'ready', newVersion: '0.7.1', percent: 100 }));
  assert.equal((await viewer.next('host-update-state')).newVersion, '0.7.1');

  host.send(JSON.stringify({ type: 'approvals', to: ok.id, list: [{ id: 'a1', kind: 'permission' }] }));
  assert.equal((await viewer.next('approvals')).list[0].id, 'a1');
  viewer.send(JSON.stringify({ type: 'approval-answer', host: 'pc-1', id: 'a1', req: 'q1', choice: 'allow' }));
  assert.equal((await host.next('approval-answer')).choice, 'allow');
  host.send(JSON.stringify({ type: 'approval-result', to: ok.id, id: 'a1', req: 'q1', ok: true }));
  assert.equal((await viewer.next('approval-result')).ok, true);

  // 电脑状态和不连画面的命令（协议文档 2.9）
  host.send(JSON.stringify({ type: 'host-state', to: ok.id, lock: { locked: true, unlock: true }, tile: { available: true, paused: false }, key: 'AAAA' }));
  assert.deepEqual(await viewer.next('host-state'), {
    type: 'host-state',
    lock: { locked: true, unlock: true },
    tile: { available: true, paused: false },
    key: 'AAAA',
    host: 'pc-1',
  });
  viewer.send(JSON.stringify({ type: 'host-cmd', host: 'pc-1', op: 'unlock', req: 'u1', enc: 'BBBB' }));
  const cmd = await host.next('host-cmd');
  assert.deepEqual([cmd.op, cmd.req, cmd.enc, cmd.from], ['unlock', 'u1', 'BBBB', ok.id]);
  host.send(JSON.stringify({ type: 'host-cmd-result', to: ok.id, req: 'u1', op: 'unlock', ok: false, code: 'still-locked' }));
  assert.equal((await viewer.next('host-cmd-result')).code, 'still-locked');
  host.close();
  viewer.close();
});

test('同一设备重新登录后，旧令牌失效', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const { hostToken } = await account(s, 'a@example.com');
  const host = await connect(s.wsUrl, auth('host', hostToken));
  await host.next('auth-ok');

  const relogin = await s.login('a@example.com', 'password-123', 'host', 'pc-1', '办公室电脑');
  assert.equal(relogin.status, 200);
  assert.equal((await host.next('auth-fail')).reason, 'revoked');

  const stale = await connect(s.wsUrl, auth('host', hostToken));
  assert.equal((await stale.next('auth-fail')).reason, 'bad-token');
});
