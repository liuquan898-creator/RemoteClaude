'use strict';
/**
 * 华为推送（docs/09 第 10 节，协议 2.10）。华为的接口换成本机一个假服务，不碰真的接口。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { startServer, connect, auth } = require('./helpers');
const { normalizeConfig } = require('../lib/config');
const { Store } = require('../lib/store');
const { PushService, approvalText, notifyIdOf, huaweiNotification, MAX_LISTS_PER_MIN, MAX_NOTIFIED_PER_USER } = require('../lib/push');
const { JWT_AUD } = require('../lib/huawei-push');

const PROJECT = 'proj-test-1';
const TOK_A = 'IQAAAACy0AAAAAAAAAAAAAAAAAAAAAtokenA_0123456789abcdefghijklmnopqrstuvwxyz';
const TOK_A2 = 'IQAAAACy0AAAAAAAAAAAAAAAAAAAAAtokenA2_0123456789abcdefghijklmnopqrstuvwxyz';
const TOK_B = 'IQAAAACy0AAAAAAAAAAAAAAAAAAAAAtokenB_0123456789abcdefghijklmnopqrstuvwxyz';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

/** 写一份假的服务账号密钥文件（和 AppGallery Connect 下载的格式一样，private_key 里换行写成 \n） */
function keyFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-push-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agc-key.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      project_id: PROJECT,
      key_id: 'key-id-1',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      sub_account: 'sub-account-1',
      auth_uri: 'https://oauth-login.cloud.huawei.com/oauth2/v3/authorize',
      token_uri: 'https://oauth-login.cloud.huawei.com/oauth2/v3/token',
    })
  );
  return { dir, file };
}

/** 假的华为推送接口：记下每个请求，回复可以按请求改 */
async function fakeHuawei(t) {
  const requests = [];
  let reply = () => ({ status: 200, body: { code: '80000000', msg: 'Success', requestId: 'r1' } });
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const r = { method: req.method, url: req.url, headers: req.headers, body: JSON.parse(data) };
      requests.push(r);
      const out = reply(r, requests.length);
      res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(
    () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections(); // 推送客户端的 fetch 用长连接，不断开 close 会一直等
      })
  );
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    setReply(fn) {
      reply = fn;
    },
    /** 等到一共收到 n 个请求 */
    async waitFor(n, ms = 2000) {
      const end = Date.now() + ms;
      while (requests.length < n) {
        if (Date.now() > end) throw new Error(`假华为接口只收到 ${requests.length} 个请求，等的是 ${n} 个`);
        await new Promise((r) => setTimeout(r, 10));
      }
      return requests[n - 1];
    },
    /** 一段时间内请求数不变 */
    async settle(ms = 250) {
      const before = requests.length;
      await new Promise((r) => setTimeout(r, ms));
      assert.equal(requests.length, before, '不应再有推送请求');
    },
  };
}

/** 起一个配好华为推送的服务器 */
async function pushServer(t, { clock, timers, extra = {}, dataDir, autoClose = true } = {}) {
  const fake = await fakeHuawei(t);
  const { file } = keyFile(t);
  const logs = [];
  const s = await startServer(
    // 原有的用例都按"一出现就推"写的；推迟提醒的用例自己给 alertDelaySec
    { ...(dataDir ? { dataDir } : {}), push: { huawei: { projectId: PROJECT, serviceAccountFile: file, apiBase: fake.base, alertDelaySec: 0, ...extra } } },
    { log: (...a) => logs.push(a.join(' ')), ...(clock ? { now: () => clock.t } : {}), ...(timers ? { timers } : {}) }
  );
  if (autoClose) t.after(() => s.close());
  return { s, fake, logs };
}

/** 手动触发的定时器：记下每次 setTimeout，fire() 时执行最早登记、还没清掉的那个 */
function manualTimers() {
  const all = [];
  return {
    all,
    setTimeout(fn, ms) {
      const timer = {
        fn,
        ms,
        cleared: false,
        fired: false,
        unrefed: false,
        unref() {
          timer.unrefed = true;
          return timer;
        },
      };
      all.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    get pending() {
      return all.filter((x) => !x.cleared && !x.fired);
    },
    /** 触发下一个，等它的回调（重推）做完 */
    async fire() {
      const timer = all.find((x) => !x.cleared && !x.fired);
      assert.ok(timer, '没有在等的定时器');
      timer.fired = true;
      await timer.fn();
    },
  };
}

/** 等到条件成立 */
async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('等太久了');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 推送记录里这台电脑的审批编号 */
function marked(store, userId, hostId) {
  return store.db
    .prepare('SELECT approval_id FROM push_notified WHERE user_id = ? AND host_id = ? ORDER BY approval_id')
    .all(userId, hostId)
    .map((r) => r.approval_id);
}

const huaweiOk = () => ({ ok: true, status: 200, code: '80000000', msg: 'Success', requestId: 'r', deadTokens: [], configSuspect: false });
const huaweiDown = () => ({ ok: false, status: 500, code: '81000001', msg: 'Internal error', requestId: 'r', deadTokens: [], configSuspect: false });

/**
 * 直接测 PushService：内存数据库（一个账号、一个推送令牌）、假的华为客户端（回复按次改，返回 Error 就当网络出错）、
 * 手动定时器、可拨的时钟
 */
function pushUnit(t, { options: extra = {} } = {}) {
  const options = { alertDelaySec: 0, ...extra };
  const clock = { t: Date.UTC(2026, 10, 24, 8, 0, 0) };
  const store = new Store(':memory:');
  const userId = store.createUser('a@example.com', 'x', clock.t);
  const { id: authTokenId } = store.issueToken({ tokenHash: 'h', userId, kind: 'viewer', deviceId: 'phone', deviceName: '手机', now: clock.t, expiresAt: clock.t + 86400000 });
  store.putPushToken({ token: TOK_A, platform: 'harmony', userId, authTokenId, now: clock.t, maxPerUser: 10 });
  const sent = [];
  let reply = huaweiOk;
  const huawei = {
    send(tokens, notification) {
      sent.push({ tokens, notification });
      const r = reply(sent.length);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
  };
  const timers = manualTimers();
  const logs = [];
  const push = new PushService({ store, huawei, options, log: (...a) => logs.push(a.join(' ')), now: () => clock.t, timers });
  t.after(() => {
    push.close();
    store.close();
  });
  return {
    store,
    push,
    timers,
    logs,
    clock,
    userId,
    sent,
    /** 推过哪些审批（按推的顺序） */
    sentIds: () => sent.map((x) => x.notification.clickAction.data.approvalId),
    setReply(fn) {
      reply = fn;
    },
  };
}

async function account(s, email, hostId) {
  const viewerToken = await s.register(email, 'password-123', { deviceId: `phone-${hostId}` });
  const host = await s.login(email, 'password-123', 'host', hostId, '电脑');
  return { viewerToken, hostToken: host.body.token };
}

/** 控制端连上并登记推送令牌，返回连接 */
async function registerPush(s, viewerToken, token) {
  const v = await connect(s.wsUrl, auth('viewer', viewerToken));
  await v.next('auth-ok');
  v.send(JSON.stringify({ type: 'push-register', platform: 'harmony', token }));
  assert.deepEqual(await v.next('push-register-result'), { type: 'push-register-result', ok: true });
  return v;
}

const permission = (id, extra = {}) => ({
  id,
  kind: 'permission',
  title: '修登录页',
  cwd: 'F:\\proj',
  agent: '',
  tool: 'Bash',
  description: '构建并清理旧产物',
  params: [{ key: 'command', value: 'npm run build' }],
  complete: true,
  createdAt: 1795064248366,
  ...extra,
});

/** 解开 JWT，用公钥验 PS256 签名 */
function verifyJwt(bearer) {
  const jwt = bearer.replace(/^Bearer /, '');
  const [h, p, sig] = jwt.split('.');
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(sig, 'base64url'));
  return { ok, header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')), jwt };
}

test('没配置推送时：push-register 回 push-not-configured，电脑看不到虚拟控制端', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  assert.equal(s.app.push.enabled, false);
  const { viewerToken, hostToken } = await account(s, 'a@example.com', 'pc-1');
  const v = await connect(s.wsUrl, auth('viewer', viewerToken));
  await v.next('auth-ok');
  v.send(JSON.stringify({ type: 'push-register', platform: 'harmony', token: TOK_A }));
  assert.deepEqual(await v.next('push-register-result'), { type: 'push-register-result', ok: false, error: 'push-not-configured' });
  v.send(JSON.stringify({ type: 'push-unregister', token: TOK_A }));
  await v.none('push-unregister-result');

  const host = await connect(s.wsUrl, auth('host', hostToken));
  assert.deepEqual((await host.next('auth-ok')).viewers.length, 1, '只有真的控制端');
  await host.none('viewer-join');
  host.close();
  v.close();
});

test('登记、注销推送令牌；电脑跟着看到虚拟控制端上线、下线', async (t) => {
  const { s } = await pushServer(t);
  const { viewerToken, hostToken } = await account(s, 'a@example.com', 'pc-1');
  const host = await connect(s.wsUrl, auth('host', hostToken));
  assert.deepEqual((await host.next('auth-ok')).viewers, []);

  const v = await connect(s.wsUrl, auth('viewer', viewerToken));
  const ok = await v.next('auth-ok');
  assert.equal((await host.next('viewer-join')).id, ok.id);

  for (const [msg, error] of [
    [{ platform: 'android', token: TOK_A }, 'bad-platform'],
    [{ platform: 'harmony', token: '' }, 'bad-token'],
    [{ platform: 'harmony', token: 'x'.repeat(600) }, 'bad-token'],
    [{ platform: 'harmony', token: 'has space' }, 'bad-token'],
    [{ platform: 'harmony' }, 'bad-token'],
  ]) {
    v.send(JSON.stringify({ type: 'push-register', ...msg }));
    assert.deepEqual(await v.next('push-register-result'), { type: 'push-register-result', ok: false, error });
  }
  await host.none((m) => m.type === 'viewer-join' && m.id === 'push');

  v.send(JSON.stringify({ type: 'push-register', platform: 'harmony', token: TOK_A }));
  assert.equal((await v.next('push-register-result')).ok, true);
  assert.deepEqual(await host.next('viewer-join'), { type: 'viewer-join', id: 'push' });
  // 重复登记：不再报一次
  v.send(JSON.stringify({ type: 'push-register', platform: 'harmony', token: TOK_A }));
  assert.equal((await v.next('push-register-result')).ok, true);
  await host.none('viewer-join');
  assert.deepEqual(s.app.store.pushTokens(1, 'harmony'), [TOK_A]);

  // 不是 push-register 的消息不会因为没带 host 被回 host-offline
  await v.none('error');

  // 电脑重连时，auth-ok 的 viewers 里就有虚拟控制端
  const host2 = await connect(s.wsUrl, auth('host', hostToken));
  assert.deepEqual((await host2.next('auth-ok')).viewers.sort(), [ok.id, 'push'].sort());

  // 注销别人的（不存在的）令牌不起作用
  v.send(JSON.stringify({ type: 'push-unregister', token: TOK_B }));
  await host2.none('viewer-leave');
  v.send(JSON.stringify({ type: 'push-unregister', token: TOK_A }));
  assert.deepEqual(await host2.next('viewer-leave'), { type: 'viewer-leave', id: 'push' });
  assert.deepEqual(s.app.store.pushTokens(1, 'harmony'), []);
  host2.close();
  v.close();
});

test('新审批给本账号的令牌推一次；重发、重连不重推；别的账号收不到', async (t) => {
  const { s, fake, logs } = await pushServer(t, { extra: { showDetail: true } });
  const a = await account(s, 'a@example.com', 'pc-a');
  const b = await account(s, 'b@example.com', 'pc-b');
  const va = await registerPush(s, a.viewerToken, TOK_A);
  const vb = await registerPush(s, b.viewerToken, TOK_B);
  va.close();
  vb.close(); // 手机 App 关了

  const hostA = await connect(s.wsUrl, auth('host', a.hostToken));
  assert.deepEqual((await hostA.next('auth-ok')).viewers, ['push']);
  const hostB = await connect(s.wsUrl, auth('host', b.hostToken));
  await hostB.next('auth-ok');

  hostA.send(JSON.stringify({ type: 'approvals', to: 'push', list: [] }));
  hostA.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('a1')] }));
  const r = await fake.waitFor(1);
  await fake.settle();

  assert.equal(r.method, 'POST');
  assert.equal(r.url, `/v3/${PROJECT}/messages:send`);
  assert.equal(r.headers['push-type'], '0');
  assert.match(r.headers['content-type'], /^application\/json/);
  const jwt = verifyJwt(r.headers.authorization);
  assert.ok(jwt.ok, 'PS256 签名能用公钥验过');
  assert.deepEqual(jwt.header, { kid: 'key-id-1', typ: 'JWT', alg: 'PS256' });
  assert.equal(jwt.payload.iss, 'sub-account-1');
  assert.equal(jwt.payload.aud, JWT_AUD);
  assert.equal(jwt.payload.exp - jwt.payload.iat, 3600);
  assert.deepEqual(r.body, {
    payload: {
      notification: {
        category: 'MARKETING',
        title: 'Claude 要你审批：Bash',
        body: '修登录页：构建并清理旧产物',
        clickAction: { actionType: 0, data: { approvalId: 'a1', hostId: 'pc-a', kind: 'permission' } },
        notifyId: notifyIdOf('a1'),
      },
    },
    target: { token: [TOK_A] },
    pushOptions: { testMessage: true, ttl: 86400 },
  });

  // 同一份列表再发（电脑对每个控制端各发一份、重连后重发）不重推
  hostA.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('a1')] }));
  hostA.send(JSON.stringify({ type: 'approvals', to: 'abcdef123456', list: [permission('a1')] }));
  hostA.close();
  const hostA2 = await connect(s.wsUrl, auth('host', a.hostToken));
  await hostA2.next('auth-ok');
  hostA2.send(JSON.stringify({ type: 'approvals', to: 'push', list: [] })); // 电脑刚启动时还没扫到文件
  hostA2.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('a1')] }));
  await fake.settle();
  assert.equal(fake.requests.length, 1);

  // 多了一条才推，只推新的那条
  hostA2.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('a1'), { id: 'a2', kind: 'ask', title: '修登录页', tool: 'AskUserQuestion', questions: [{ question: '用哪种数据库？' }] }] }));
  const r2 = await fake.waitFor(2);
  assert.equal(r2.body.payload.notification.title, 'Claude 有问题要问你');
  assert.equal(r2.body.payload.notification.body, '修登录页：用哪种数据库？');
  assert.deepEqual(r2.body.payload.notification.clickAction.data, { approvalId: 'a2', hostId: 'pc-a', kind: 'ask' });
  assert.deepEqual(r2.body.target.token, [TOK_A]);

  // 账号 B 的审批只推给 B
  hostB.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('b1')] }));
  const r3 = await fake.waitFor(3);
  assert.deepEqual(r3.body.target.token, [TOK_B]);
  await fake.settle();
  assert.equal(fake.requests.length, 3);

  assert.ok(!logs.some((l) => l.includes(TOK_A) || l.includes(TOK_B)), '日志里没有完整的推送令牌');
  assert.ok(!logs.some((l) => l.includes(jwt.jwt)), '日志里没有 JWT');
  hostA2.close();
  hostB.close();
});

test('默认（showDetail 为 false）通知不带细节：没有工具名、会话名、命令和问题原文', async (t) => {
  const { s, fake } = await pushServer(t);
  const a = await account(s, 'a@example.com', 'pc-a');
  (await registerPush(s, a.viewerToken, TOK_A)).close();
  const host = await connect(s.wsUrl, auth('host', a.hostToken));
  await host.next('auth-ok');
  const ask = { id: 'd2', kind: 'ask', title: '修登录页', tool: 'AskUserQuestion', questions: [{ question: '用哪种数据库？' }] };
  const plan = permission('d3', { tool: 'ExitPlanMode', description: '重写登录页的计划' });
  host.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('d1'), ask, plan] }));
  await fake.waitFor(3);
  const byId = Object.fromEntries(fake.requests.map((r) => [r.body.payload.notification.clickAction.data.approvalId, r.body.payload.notification]));
  assert.deepEqual([byId.d1.title, byId.d1.body], ['Claude 要你审批', '打开 App 查看']);
  assert.deepEqual([byId.d2.title, byId.d2.body], ['Claude 有问题要问你', '打开 App 查看']);
  assert.deepEqual([byId.d3.title, byId.d3.body], ['Claude 要你审批计划', '打开 App 查看']);
  assert.deepEqual(byId.d2.clickAction.data, { approvalId: 'd2', hostId: 'pc-a', kind: 'ask' }, '点通知照样能打开这条审批');
  const raw = JSON.stringify(fake.requests.map((r) => r.body));
  for (const secret of ['修登录页', 'Bash', 'npm run build', '构建并清理旧产物', '用哪种数据库', '重写登录页', 'ExitPlanMode', 'AskUserQuestion']) {
    assert.ok(!raw.includes(secret), `发给华为的内容里不该有"${secret}"`);
  }
  host.close();
});

test('没有令牌时看到的审批也记下，之后登记的手机不会收到一串旧通知', async (t) => {
  const { s, fake } = await pushServer(t);
  const a = await account(s, 'a@example.com', 'pc-a');
  const host = await connect(s.wsUrl, auth('host', a.hostToken));
  await host.next('auth-ok');
  const v = await connect(s.wsUrl, auth('viewer', a.viewerToken));
  const ok = await v.next('auth-ok');
  await host.next('viewer-join');
  host.send(JSON.stringify({ type: 'approvals', to: ok.id, list: [permission('old1'), permission('old2')] }));
  await v.next('approvals');

  v.send(JSON.stringify({ type: 'push-register', platform: 'harmony', token: TOK_A }));
  await v.next('push-register-result');
  await host.next((m) => m.type === 'viewer-join' && m.id === 'push');
  host.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('old1'), permission('old2')] }));
  await fake.settle();
  assert.equal(fake.requests.length, 0);
  host.close();
  v.close();
});

test('服务器重启后不重推（推送记录存在数据库里）', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-push-db-'));
  const first = await pushServer(t, { dataDir, autoClose: false });
  const a = await account(first.s, 'a@example.com', 'pc-a');
  (await registerPush(first.s, a.viewerToken, TOK_A)).close();
  const h1 = await connect(first.s.wsUrl, auth('host', a.hostToken));
  await h1.next('auth-ok');
  h1.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('p1')] }));
  await first.fake.waitFor(1);
  await first.s.close();

  const second = await pushServer(t, { dataDir, autoClose: false });
  t.after(async () => {
    await second.s.close(); // 数据库文件关了才删得掉（Windows）
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const h2 = await connect(second.s.wsUrl, auth('host', a.hostToken));
  assert.deepEqual((await h2.next('auth-ok')).viewers, ['push'], '令牌也还在');
  h2.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('p1')] }));
  await second.fake.settle();
  assert.equal(second.fake.requests.length, 0);
  h2.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('p1'), permission('p2')] }));
  assert.equal((await second.fake.waitFor(1)).body.payload.notification.clickAction.data.approvalId, 'p2');
  h2.close();
});

test('华为说令牌全都无效（80300007）：24 小时内推成功过才删令牌（电脑看到虚拟控制端下线），否则只提示查配置', async (t) => {
  const clock = { t: Date.UTC(2026, 10, 24, 8, 0, 0) };
  const { s, fake, logs } = await pushServer(t, { clock });
  const a = await account(s, 'a@example.com', 'pc-a');
  (await registerPush(s, a.viewerToken, TOK_A)).close();
  const host = await connect(s.wsUrl, auth('host', a.hostToken));
  await host.next('auth-ok');
  const ids = [];
  const approve = (id) => {
    ids.push(id);
    host.send(JSON.stringify({ type: 'approvals', to: 'push', list: ids.map((x) => permission(x)) }));
  };
  const allInvalid = () => ({ status: 200, body: { code: '80300007', msg: 'All the tokens are invalid', requestId: 'r' } });
  const success = () => ({ status: 200, body: { code: '80000000', msg: 'Success', requestId: 'r' } });
  const warnings = () => logs.filter((l) => l.includes('多半是配置不对')).length;

  // 服务器还没推成功过：项目 ID、密钥文件和应用对不上时也回 80300007，不能删光令牌
  fake.setReply(allInvalid);
  approve('x1');
  await fake.waitFor(1);
  await until(() => warnings() === 1);
  assert.ok(logs.some((l) => l.includes('projectId') && l.includes('包名')), '提示查哪几项配置');
  assert.deepEqual(s.app.store.pushTokens(1, 'harmony'), [TOK_A]);

  // 推成功过，但已经过了 24 小时：同样不删
  fake.setReply(success);
  approve('x2');
  await fake.waitFor(2);
  clock.t += 25 * 3600 * 1000;
  fake.setReply(allInvalid);
  approve('x3');
  await fake.waitFor(3);
  await until(() => warnings() === 2);
  assert.deepEqual(s.app.store.pushTokens(1, 'harmony'), [TOK_A]);
  await host.none('viewer-leave');

  // 24 小时内推成功过，说明配置是对的：这回是令牌真失效了，删掉
  fake.setReply(success);
  approve('x4');
  await fake.waitFor(4);
  clock.t += 3600 * 1000;
  fake.setReply(allInvalid);
  approve('x5');
  await fake.waitFor(5);
  assert.deepEqual(await host.next('viewer-leave'), { type: 'viewer-leave', id: 'push' });
  assert.deepEqual(s.app.store.pushTokens(1, 'harmony'), []);
  assert.equal(warnings(), 2);
  host.close();
});

test('部分成功（80100000）时只删 illegalTokens 里格式错误、无权的令牌', async (t) => {
  const { s, fake, logs } = await pushServer(t);
  const a = await account(s, 'a@example.com', 'pc-a');
  const v = await registerPush(s, a.viewerToken, TOK_A);
  v.send(JSON.stringify({ type: 'push-register', platform: 'harmony', token: TOK_A2 }));
  await v.next('push-register-result');
  v.close();
  const host = await connect(s.wsUrl, auth('host', a.hostToken));
  await host.next('auth-ok');

  fake.setReply(() => ({
    status: 200,
    body: { code: '80100000', msg: JSON.stringify({ illegalTokens: { tokenFormatError: [TOK_A2] }, success: 1, failure: 1 }), requestId: 'r' },
  }));
  host.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('x1')] }));
  const r = await fake.waitFor(1);
  assert.deepEqual(r.body.target.token.sort(), [TOK_A, TOK_A2].sort());
  const end = Date.now() + 2000;
  while (s.app.store.pushTokens(1, 'harmony').length !== 1 && Date.now() < end) await new Promise((res) => setTimeout(res, 10));
  assert.deepEqual(s.app.store.pushTokens(1, 'harmony'), [TOK_A]);
  await host.none('viewer-leave');
  assert.ok(logs.some((l) => l.includes('部分令牌没推到')));
  assert.ok(!logs.some((l) => l.includes(TOK_A2) || l.includes(TOK_A)), '华为响应里的令牌在日志里也只留前几位');
  host.close();
});

test('推送接口出错不影响信令；暂时性错误服务器自己定时重推，推成了就不再推；参数错误不重推', async (t) => {
  const timers = manualTimers();
  const { s, fake, logs } = await pushServer(t, { timers });
  const a = await account(s, 'a@example.com', 'pc-a');
  const v = await registerPush(s, a.viewerToken, TOK_A);
  const host = await connect(s.wsUrl, auth('host', a.hostToken));
  const ok = (await host.next('auth-ok')).viewers.find((id) => id !== 'push');

  fake.setReply(() => ({ status: 500, body: { code: '81000001', msg: 'Internal error', requestId: 'r' } }));
  host.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('e1')] }));
  await fake.waitFor(1);
  await until(() => timers.pending.length === 1);
  assert.equal(timers.pending[0].ms, 30 * 1000, '30 秒后重推');
  // 电脑只在审批有变化时才重发列表；这时发给真的控制端的同一份照常转发，不会引出重复推送
  host.send(JSON.stringify({ type: 'approvals', to: ok, list: [permission('e1')] }));
  assert.equal((await v.next('approvals')).list[0].id, 'e1', '转发照常');
  await fake.settle(100);

  fake.setReply(() => ({ status: 200, body: { code: '80000000', msg: 'Success', requestId: 'r' } }));
  await timers.fire();
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[1].body.payload.notification.clickAction.data.approvalId, 'e1', '到点重推');
  assert.equal(timers.pending.length, 0, '推成了就不再排重推');
  host.send(JSON.stringify({ type: 'approvals', to: ok, list: [permission('e1')] }));
  await v.next('approvals');
  await fake.settle();
  assert.equal(fake.requests.length, 2);
  assert.ok(logs.some((l) => l.includes('81000001')));
  assert.deepEqual(s.app.store.pushTokens(1, 'harmony'), [TOK_A], '服务端错误不删令牌');

  // 参数错误之类不是暂时性的：不重推
  fake.setReply(() => ({ status: 400, body: { code: '80100003', msg: 'Illegal payload', requestId: 'r' } }));
  host.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('e1'), permission('e2')] }));
  await fake.waitFor(3);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(timers.pending.length, 0);
  host.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('e1'), permission('e2')] }));
  await fake.settle();
  assert.equal(fake.requests.length, 3);
  host.close();
  v.close();
});

test('网络不通、超时：信令照常，服务器定时重推', async (t) => {
  const timers = manualTimers();
  const { s, logs } = await pushServer(t, { timers, extra: { timeoutMs: 200, apiBase: 'http://127.0.0.1:9' } });
  const a = await account(s, 'a@example.com', 'pc-a');
  const v = await registerPush(s, a.viewerToken, TOK_A);
  const host = await connect(s.wsUrl, auth('host', a.hostToken));
  const ok = (await host.next('auth-ok')).viewers.find((id) => id !== 'push');
  await s.app.push.onApprovals(1, 'pc-a', [permission('n1')]);
  assert.deepEqual(marked(s.app.store, 1, 'pc-a'), [], '没推成的撤掉了记录');
  assert.deepEqual(timers.pending.map((x) => x.ms), [30 * 1000]);
  assert.ok(logs.some((l) => l.includes('审批 n1 推送出错')));
  host.send(JSON.stringify({ type: 'approvals', to: ok, list: [permission('n1')] }));
  assert.equal((await v.next('approvals')).list[0].id, 'n1');
  host.close();
  v.close();
});

test('推迟提醒：审批出现满 60 秒还没处理才推；这期间在电脑上处理掉了就不推（docs/09 第 10 节）', async (t) => {
  const u = pushUnit(t, { options: { alertDelaySec: 60 } });
  await u.push.onApprovals(u.userId, 'pc', [permission('d1')]);
  assert.deepEqual(u.sentIds(), [], '刚出现不推');
  assert.deepEqual(marked(u.store, u.userId, 'pc'), [], '也不记：到点前服务器重启了，电脑重连发来的列表照样会推它');
  assert.deepEqual(u.timers.pending.map((x) => x.ms), [60 * 1000]);
  assert.ok(u.timers.pending[0].unrefed, '定时器不拦着进程退出');

  // 30 秒后又来一条 d2：定时器按最早到点的 d1 定，还剩 30 秒
  u.clock.t += 30 * 1000;
  await u.push.onApprovals(u.userId, 'pc', [permission('d1'), permission('d2')]);
  assert.deepEqual(u.timers.pending.map((x) => x.ms), [30 * 1000]);
  await u.push.onApprovals(u.userId, 'pc', [permission('d1'), permission('d2')]);
  assert.equal(u.timers.pending.length, 1, '同一份列表的副本不动定时器');

  // 到点：d1 推了，d2 还差 30 秒
  u.clock.t += 30 * 1000;
  await u.timers.fire();
  assert.deepEqual(u.sentIds(), ['d1']);
  assert.deepEqual(marked(u.store, u.userId, 'pc'), ['d1']);
  assert.deepEqual(u.timers.pending.map((x) => x.ms), [30 * 1000]);

  // d2 在电脑上处理掉了（新列表里没有它）：不用再等，也不推
  u.clock.t += 10 * 1000;
  await u.push.onApprovals(u.userId, 'pc', [permission('d1')]);
  assert.equal(u.timers.pending.length, 0);
  u.clock.t += 60 * 1000;
  await u.push.onApprovals(u.userId, 'pc', [permission('d1')]);
  assert.deepEqual(u.sentIds(), ['d1'], 'd1 推过了不再推，d2 没推');
});

test('推迟提醒：等着的时候电脑下线了就不推，重连后重新等满；close() 取消', async (t) => {
  const u = pushUnit(t, { options: { alertDelaySec: 60 } });
  await u.push.onApprovals(u.userId, 'pc', [permission('g1')]);
  u.clock.t += 50 * 1000;
  u.push.hostGone(u.userId, 'pc');
  assert.equal(u.timers.pending.length, 0, '下线时取消');
  await u.push.onApprovals(u.userId, 'pc', [permission('g1')]);
  assert.deepEqual(u.sentIds(), []);
  assert.deepEqual(u.timers.pending.map((x) => x.ms), [60 * 1000], '重连后从头算');
  u.clock.t += 60 * 1000;
  await u.timers.fire();
  assert.deepEqual(u.sentIds(), ['g1']);

  await u.push.onApprovals(u.userId, 'pc', [permission('g1'), permission('g2')]);
  assert.equal(u.timers.pending.length, 1);
  u.push.close();
  assert.equal(u.timers.pending.length, 0, 'close() 取消等着的');
});

test('推迟提醒：配置 alertDelaySec，不填是 60 秒，0 是一出现就推', () => {
  const hw = (extra) => normalizeConfig({ push: { huawei: { serviceAccountFile: 'k.json', ...extra } } }, __dirname).push.huawei;
  assert.equal(hw({}).alertDelaySec, 60);
  assert.equal(hw({ alertDelaySec: 0 }).alertDelaySec, 0);
  assert.throws(() => hw({ alertDelaySec: -1 }), /alertDelaySec/);
  assert.throws(() => hw({ alertDelaySec: 1.5 }), /alertDelaySec/);
  assert.throws(() => hw({ alertDelaySec: 601 }), /alertDelaySec/);
});

test('重推按 30 秒、2 分钟、10 分钟最多 3 次；等着重推时新列表只推新的；都没成就等电脑下次发列表', async (t) => {
  const u = pushUnit(t);
  u.setReply(huaweiDown);
  await u.push.onApprovals(u.userId, 'pc', [permission('r1')]);
  assert.deepEqual(u.sentIds(), ['r1']);
  assert.deepEqual(marked(u.store, u.userId, 'pc'), [], '记录撤掉了：等的时候服务器重启，电脑重连发来的列表照样会推它');
  assert.deepEqual(u.timers.pending.map((x) => x.ms), [30 * 1000]);
  assert.ok(u.timers.pending[0].unrefed, '定时器不拦着进程退出');

  // 等着重推时电脑发来新列表：只推新的 r2，r1 既不推也不记（归重推管）
  u.setReply(huaweiOk);
  await u.push.onApprovals(u.userId, 'pc', [permission('r1'), permission('r2')]);
  assert.deepEqual(u.sentIds(), ['r1', 'r2']);
  assert.deepEqual(marked(u.store, u.userId, 'pc'), ['r2']);
  await u.push.onApprovals(u.userId, 'pc', [permission('r1'), permission('r2')]);
  assert.deepEqual(u.sentIds(), ['r1', 'r2'], '同一份列表的副本不重复推');

  u.setReply(huaweiDown);
  await u.timers.fire();
  assert.deepEqual(u.timers.pending.map((x) => x.ms), [2 * 60 * 1000]);
  await u.timers.fire();
  assert.deepEqual(u.timers.pending.map((x) => x.ms), [10 * 60 * 1000]);
  await u.timers.fire();
  assert.deepEqual(u.sentIds(), ['r1', 'r2', 'r1', 'r1', 'r1'], '头一回加重推 3 次');
  assert.equal(u.timers.pending.length, 0, '不再重推');
  assert.ok(u.logs.some((l) => l.includes('重推 3 次都没成')));
  assert.deepEqual(marked(u.store, u.userId, 'pc'), ['r2'], 'r1 没记，电脑下次发列表时再推');

  // 下次发列表（哪怕和上一份一样）时再推
  u.setReply(huaweiOk);
  await u.push.onApprovals(u.userId, 'pc', [permission('r1'), permission('r2')]);
  assert.deepEqual(u.sentIds(), ['r1', 'r2', 'r1', 'r1', 'r1', 'r1']);
  assert.deepEqual(marked(u.store, u.userId, 'pc'), ['r1', 'r2']);
});

test('重推：推成了就记下；审批处理掉了就不推；网络出错、超时也重推；每小时上限照样算；close() 取消', async (t) => {
  // 重推成功
  const u = pushUnit(t, { options: { maxPerHour: 4 } });
  u.setReply(() => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
  await u.push.onApprovals(u.userId, 'pc', [permission('s1'), permission('s2')]);
  assert.ok(u.logs.some((l) => l.includes('审批 s1 推送出错: 超时')));
  assert.equal(u.timers.pending.length, 2, '每条各排一个重推');
  u.setReply(huaweiOk);
  await u.timers.fire();
  assert.deepEqual(marked(u.store, u.userId, 'pc'), ['s1']);
  assert.equal(u.timers.pending.length, 1);

  // s2 在等重推时被处理掉了（电脑发来的列表里没有它）：到点不推
  await u.push.onApprovals(u.userId, 'pc', [permission('s1')]);
  await u.timers.fire();
  assert.deepEqual(u.sentIds(), ['s1', 's2', 's1']);
  assert.ok(u.logs.some((l) => l.includes('审批 s2 已经不在电脑的列表里')));
  assert.deepEqual(marked(u.store, u.userId, 'pc'), ['s1']);

  // 每小时上限：已经推了 3 次，s3 失败用掉第 4 次，重推时超限，撤掉记录、不再重推
  u.setReply(huaweiDown);
  await u.push.onApprovals(u.userId, 'pc', [permission('s1'), permission('s3')]);
  assert.equal(u.timers.pending.length, 1);
  await u.timers.fire();
  assert.deepEqual(u.sentIds(), ['s1', 's2', 's1', 's3'], '超过每小时上限不重推');
  assert.ok(u.logs.some((l) => l.includes('一小时内推送超过 4 条')));
  assert.deepEqual(marked(u.store, u.userId, 'pc'), ['s1']);
  assert.equal(u.timers.pending.length, 0);

  // close() 取消等着的重推
  u.clock.t += 3600 * 1000;
  await u.push.onApprovals(u.userId, 'pc', [permission('s1'), permission('s3'), permission('s4')]);
  assert.equal(u.timers.pending.length, 2);
  const waiting = u.timers.pending;
  u.push.close();
  assert.ok(waiting.every((x) => x.cleared));
  assert.equal(u.push.retries.size, 0);
});

test('同一台电脑的同一份列表只处理一次，副本不算数；每个账号每分钟最多处理 60 份，超了不碰数据库、日志只记一条', async (t) => {
  const u = pushUnit(t, { options: { maxPerHour: 1000 } });
  const uk = String(u.userId);
  // 电脑对每个控制端各发一份：同一份列表来 200 次只算一份
  for (let i = 0; i < 200; i++) await u.push.onApprovals(u.userId, 'pc', [permission('c1')]);
  assert.deepEqual(u.sentIds(), ['c1']);
  assert.equal(u.push.listRate.count(uk), 1);

  // 变了的列表才算数；同一账号下几台电脑合起来算
  for (let i = 2; i <= MAX_LISTS_PER_MIN; i++) await u.push.onApprovals(u.userId, i % 2 ? 'pc' : 'pc2', [permission(`c${i}`)]);
  assert.equal(u.sentIds().length, MAX_LISTS_PER_MIN);
  for (const id of ['c61', 'c62', 'c63']) await u.push.onApprovals(u.userId, 'pc', [permission(id)]);
  assert.equal(u.sentIds().length, MAX_LISTS_PER_MIN, '超了的不推');
  assert.ok(!marked(u.store, u.userId, 'pc').includes('c61'), '也不记');
  assert.equal(u.logs.filter((l) => l.includes('一分钟内发来的审批列表超过')).length, 1, '同一个窗口只记一条日志');

  // 下一分钟恢复；超限时没处理的列表，同样的副本再来也会处理
  u.clock.t += 60 * 1000;
  await u.push.onApprovals(u.userId, 'pc', [permission('c63')]);
  assert.equal(u.sentIds().at(-1), 'c63');
  u.clock.t += 3600 * 1000;
  u.push.cleanup();
  assert.equal(u.push.listRate.map.size, 0, 'cleanup 清掉过期的计数');
  assert.equal(u.push.lists.size, 0, '一小时没动静的电脑，最近一份列表也忘掉');
});

test('等着重推时只留通知要用的几个字段，不留整条审批；重推发的就是这几个字段拼的通知', async (t) => {
  const huge = 'x'.repeat(1024 * 1024);
  for (const showDetail of [false, true]) {
    const u = pushUnit(t, { options: { showDetail } });
    u.setReply(huaweiDown);
    const item = permission('m1', { title: `修登录页${huge}`, description: `构建${huge}`, params: [{ key: 'command', value: huge }], extra: huge });
    await u.push.onApprovals(u.userId, 'pc', [item]);
    const [waiting] = u.push.retries.values();
    assert.deepEqual(Object.keys(waiting.item).sort(), ['body', 'id', 'kind', 'title']);
    assert.ok(JSON.stringify(waiting.item).length < 500, `不留大段文本（showDetail ${showDetail}）`);
    const expected = huaweiNotification(item, 'pc', 'MARKETING', showDetail);
    u.setReply(huaweiOk);
    await u.timers.fire();
    assert.equal(u.sent.length, 2);
    assert.deepEqual(u.sent[1].notification, expected, '重推发的通知和直接用整条审批拼的一样');
    assert.deepEqual(u.sent[0].notification, expected);
  }
});

test('撤销推送记录失败时照样排重推：等着时新列表不推它，到点直接推，不重复', async (t) => {
  const u = pushUnit(t);
  u.store.unmarkNotified = () => {
    throw new Error('disk I/O error');
  };
  u.setReply(huaweiDown);
  await u.push.onApprovals(u.userId, 'pc', [permission('u1')]);
  assert.ok(u.logs.some((l) => l.includes('撤销审批 u1 的推送记录失败')));
  assert.deepEqual(marked(u.store, u.userId, 'pc'), ['u1'], '记录还在');
  assert.equal(u.timers.pending.length, 1, '照样排了重推');
  delete u.store.unmarkNotified;

  u.setReply(huaweiOk);
  await u.push.onApprovals(u.userId, 'pc', [permission('u1'), permission('u2')]);
  assert.deepEqual(u.sentIds(), ['u1', 'u2'], '等着重推的 u1 不推');
  await u.timers.fire();
  assert.deepEqual(u.sentIds(), ['u1', 'u2', 'u1'], '记录本来就在也照推');
  assert.deepEqual(marked(u.store, u.userId, 'pc'), ['u1', 'u2']);
  assert.equal(u.timers.pending.length, 0);
});

test('电脑下线：取消它等着的重推、忘掉它的列表，重连后发来的列表重新推；下线时正在推的之后失败了也不照旧列表重推', async (t) => {
  const u = pushUnit(t);
  u.setReply(huaweiDown);
  await u.push.onApprovals(u.userId, 'pc', [permission('g1')]);
  await u.push.onApprovals(u.userId, 'pc2', [permission('k1')]);
  const [g1Timer, k1Timer] = u.timers.pending;
  u.push.hostGone(u.userId, 'pc');
  assert.ok(g1Timer.cleared);
  assert.ok(!k1Timer.cleared, '别的电脑的不动');
  assert.equal(u.push.lists.size, 1);
  assert.deepEqual(marked(u.store, u.userId, 'pc'), []);

  u.setReply(huaweiOk);
  await u.push.onApprovals(u.userId, 'pc', [permission('g1')]);
  assert.deepEqual(u.sentIds(), ['g1', 'k1', 'g1'], '重连后发来的列表把它推了');
  await u.timers.fire();
  assert.deepEqual(u.sentIds(), ['g1', 'k1', 'g1', 'k1']);

  // 下线时 g2 正在推，下线后才失败：排了重推，但到点找不到这台电脑的列表，不推
  let fail = null;
  u.setReply(() => new Promise((resolve) => (fail = () => resolve(huaweiDown()))));
  const pushing = u.push.onApprovals(u.userId, 'pc', [permission('g1'), permission('g2')]);
  await until(() => fail);
  u.push.hostGone(u.userId, 'pc');
  fail();
  await pushing;
  assert.equal(u.timers.pending.length, 1);
  u.setReply(huaweiOk);
  await u.timers.fire();
  assert.deepEqual(u.sentIds(), ['g1', 'k1', 'g1', 'k1', 'g2']);
  assert.ok(u.logs.some((l) => l.includes('审批 g2 已经不在电脑的列表里')));
  assert.deepEqual(marked(u.store, u.userId, 'pc'), ['g1'], 'g2 的记录撤掉了，重连后照样推');
});

test('电脑真下线才取消重推；同一台电脑换了新连接、旧连接后关不算下线', async (t) => {
  const timers = manualTimers();
  const { s, fake } = await pushServer(t, { timers });
  const a = await account(s, 'a@example.com', 'pc-a');
  (await registerPush(s, a.viewerToken, TOK_A)).close();
  fake.setReply(() => ({ status: 500, body: { code: '81000001', msg: 'Internal error', requestId: 'r' } }));
  const h1 = await connect(s.wsUrl, auth('host', a.hostToken));
  await h1.next('auth-ok');
  h1.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('q1')] }));
  await fake.waitFor(1);
  await until(() => timers.pending.length === 1);

  // 重连竞态：新连接先连上，旧连接被顶掉后才关
  const h2 = await connect(s.wsUrl, auth('host', a.hostToken));
  await h2.next('auth-ok');
  assert.equal(await h1.closed, 4002);
  await new Promise((r) => setTimeout(r, 200)); // 等服务器处理完旧连接的关闭
  assert.equal(timers.pending.length, 1, '旧连接关了不算下线');
  assert.equal(s.app.push.lists.size, 1);

  h2.close();
  await until(() => timers.pending.length === 0);
  assert.equal(s.app.push.lists.size, 0);
  assert.deepEqual(marked(s.app.store, 1, 'pc-a'), []);

  // 电脑重连后发来的列表把它推了
  fake.setReply(() => ({ status: 200, body: { code: '80000000', msg: 'Success', requestId: 'r' } }));
  const h3 = await connect(s.wsUrl, auth('host', a.hostToken));
  await h3.next('auth-ok');
  h3.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('q1')] }));
  assert.equal((await fake.waitFor(2)).body.payload.notification.clickAction.data.approvalId, 'q1');
  h3.close();
});

test('到了每小时上限：同一份列表的副本照样跳过、不算份数、不碰库，日志每个窗口只记一条；窗口过了再推', async (t) => {
  const u = pushUnit(t, { options: { maxPerHour: 2 } });
  const uk = String(u.userId);
  let batches = 0;
  const markNotifiedBatch = u.store.markNotifiedBatch.bind(u.store);
  u.store.markNotifiedBatch = (...a) => {
    batches += 1;
    return markNotifiedBatch(...a);
  };
  const list = (...ids) => ids.map((id) => permission(id));
  const capLogs = () => u.logs.filter((l) => l.includes('一小时内推送超过 2 条')).length;

  await u.push.onApprovals(u.userId, 'pc', list('h1', 'h2', 'h3'));
  assert.deepEqual(u.sentIds(), ['h1', 'h2']);
  assert.deepEqual(marked(u.store, u.userId, 'pc'), ['h1', 'h2'], 'h3 没推，记录撤掉了');
  assert.equal(capLogs(), 1);
  assert.equal(batches, 1);

  for (let i = 0; i < 50; i++) await u.push.onApprovals(u.userId, 'pc', list('h1', 'h2', 'h3'));
  assert.equal(u.push.listRate.count(uk), 1, '副本不算份数');
  assert.equal(batches, 1, '副本不碰库');

  // 变了的列表算一份，但这一小时推满了，不碰库
  await u.push.onApprovals(u.userId, 'pc', list('h1', 'h2', 'h3', 'h4'));
  await u.push.onApprovals(u.userId, 'pc2', list('p1'));
  for (let i = 0; i < 20; i++) await u.push.onApprovals(u.userId, 'pc', list('h1', 'h2', 'h3', 'h4'));
  assert.equal(u.push.listRate.count(uk), 3);
  assert.equal(batches, 1);
  assert.equal(capLogs(), 1, '每个窗口只记一条');
  assert.deepEqual(u.sentIds(), ['h1', 'h2']);

  // 窗口过了：同样的副本再处理，把没推的推出去
  u.clock.t += 3600 * 1000;
  await u.push.onApprovals(u.userId, 'pc', list('h1', 'h2', 'h3', 'h4'));
  assert.deepEqual(u.sentIds(), ['h1', 'h2', 'h3', 'h4']);
  u.push.cleanup();
  assert.equal(u.push.cappedLogged.size, 0, 'cleanup 清掉过期的日志标记');
});

test('读推送令牌出错：刚记下的撤掉，下一份同样的列表再推', async (t) => {
  const u = pushUnit(t);
  u.store.pushTokens = () => {
    throw new Error('disk I/O error');
  };
  await u.push.onApprovals(u.userId, 'pc', [permission('k1')]);
  assert.deepEqual(u.sentIds(), []);
  assert.ok(u.logs.some((l) => l.includes('读推送令牌失败')));
  assert.deepEqual(marked(u.store, u.userId, 'pc'), [], '记录撤掉了');
  delete u.store.pushTokens;
  await u.push.onApprovals(u.userId, 'pc', [permission('k1')]);
  assert.deepEqual(u.sentIds(), ['k1']);
});

test('80300007 被当成配置可疑时的警告每小时最多记一条', async (t) => {
  const u = pushUnit(t);
  u.setReply(() => ({ ok: false, status: 200, code: '80300007', msg: 'All the tokens are invalid', requestId: 'r', deadTokens: [], configSuspect: true }));
  const warnings = () => u.logs.filter((l) => l.includes('多半是配置不对')).length;
  await u.push.onApprovals(u.userId, 'pc', [permission('w1')]);
  await u.push.onApprovals(u.userId, 'pc', [permission('w1'), permission('w2')]);
  assert.equal(u.sent.length, 2);
  assert.equal(warnings(), 1);
  u.clock.t += 3600 * 1000;
  await u.push.onApprovals(u.userId, 'pc', [permission('w1'), permission('w2'), permission('w3')]);
  assert.equal(warnings(), 2);
});

test('推送记录：整批一个事务，中途出错整批不记；每个账号最多留的条数有上限，多了删最旧的', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  assert.throws(() => store.markNotifiedBatch(1, 'pc', ['a', 'b', {}], 1000, 100));
  assert.deepEqual(store.markNotifiedBatch(1, 'pc', ['a', 'b'], 1000, 100), ['a', 'b'], '上一批回滚了，a、b 都没记上');
  assert.deepEqual(store.markNotifiedBatch(1, 'pc', ['b', 'c'], 1000, 100), ['c'], '只返回第一次记下的');

  store.markNotifiedBatch(2, 'other', ['x'], 1, 3);
  store.markNotifiedBatch(1, 'pc2', ['d'], 2000, 3);
  assert.deepEqual(store.markNotifiedBatch(1, 'pc', ['e', 'f'], 3000, 3), ['e', 'f']);
  const rows = (userId) => store.db.prepare('SELECT approval_id FROM push_notified WHERE user_id = ? ORDER BY at, approval_id').all(userId).map((r) => r.approval_id);
  assert.deepEqual(rows(1), ['d', 'e', 'f'], '账号 1 只留最新的 3 条');
  assert.deepEqual(rows(2), ['x'], '别的账号不受影响');
});

test(`PushService 记推送记录时每个账号最多留 ${MAX_NOTIFIED_PER_USER} 条`, async (t) => {
  const u = pushUnit(t);
  const old = Array.from({ length: MAX_NOTIFIED_PER_USER }, (_, i) => `old-${i}`);
  u.store.markNotifiedBatch(u.userId, 'pc0', old, u.clock.t - 1000, MAX_NOTIFIED_PER_USER);
  await u.push.onApprovals(u.userId, 'pc', [permission('new1'), permission('new2')]);
  assert.deepEqual(u.sentIds(), ['new1', 'new2']);
  const n = u.store.db.prepare('SELECT COUNT(*) AS n FROM push_notified WHERE user_id = ?').get(u.userId).n;
  assert.equal(Number(n), MAX_NOTIFIED_PER_USER);
  assert.deepEqual(marked(u.store, u.userId, 'pc'), ['new1', 'new2']);
  assert.ok(!marked(u.store, u.userId, 'pc0').includes('old-0'), '删的是最旧的');
});

test('JWT 缓存到快过期才换；华为说 JWT 过期（80200005）时换一个重试一次', async (t) => {
  const clock = { t: Date.UTC(2026, 10, 23, 8, 0, 0) };
  const { s, fake } = await pushServer(t, { clock });
  const a = await account(s, 'a@example.com', 'pc-a');
  (await registerPush(s, a.viewerToken, TOK_A)).close();
  const host = await connect(s.wsUrl, auth('host', a.hostToken));
  await host.next('auth-ok');
  const approve = (id) => host.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission(id)] }));

  approve('j1');
  const first = verifyJwt((await fake.waitFor(1)).headers.authorization);
  assert.equal(first.payload.iat, clock.t / 1000);
  clock.t += 3000 * 1000; // 50 分钟后还在用同一个
  approve('j2');
  assert.equal((await fake.waitFor(2)).headers.authorization, `Bearer ${first.jwt}`);
  clock.t += 400 * 1000; // 离过期不到 5 分钟，换新的
  approve('j3');
  const third = verifyJwt((await fake.waitFor(3)).headers.authorization);
  assert.notEqual(third.jwt, first.jwt);
  assert.equal(third.payload.iat, clock.t / 1000);

  clock.t += 1000;
  fake.setReply((r, n) => (n === 4 ? { status: 401, body: { code: '80200005', msg: 'JWT expired', requestId: 'r' } } : { status: 200, body: { code: '80000000', msg: 'Success', requestId: 'r' } }));
  approve('j4');
  const retry = await fake.waitFor(5);
  assert.notEqual(retry.headers.authorization, `Bearer ${third.jwt}`, '重试用的是新签的 JWT');
  assert.equal(retry.body.payload.notification.clickAction.data.approvalId, 'j4');
  await fake.settle();
  assert.equal(fake.requests.length, 5, '只重试一次');
  host.close();
});

test('令牌归最后登记它的账号；控制端退出登录后令牌跟着删', async (t) => {
  const { s } = await pushServer(t);
  const a = await account(s, 'a@example.com', 'pc-a');
  const b = await account(s, 'b@example.com', 'pc-b');
  const hostA = await connect(s.wsUrl, auth('host', a.hostToken));
  await hostA.next('auth-ok');

  const va = await registerPush(s, a.viewerToken, TOK_A);
  await hostA.next((m) => m.type === 'viewer-join' && m.id === 'push');
  const vb = await registerPush(s, b.viewerToken, TOK_A); // 同一台手机换了账号登录
  assert.deepEqual(await hostA.next('viewer-leave'), { type: 'viewer-leave', id: 'push' });
  assert.deepEqual(s.app.store.pushTokens(1, 'harmony'), []);
  assert.deepEqual(s.app.store.pushTokens(2, 'harmony'), [TOK_A]);

  // A 不能注销已经归 B 的令牌
  va.send(JSON.stringify({ type: 'push-unregister', token: TOK_A }));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(s.app.store.pushTokens(2, 'harmony'), [TOK_A]);

  await s.post('/api/auth/logout', {}, { token: b.viewerToken });
  await vb.closed;
  assert.deepEqual(s.app.store.pushTokens(2, 'harmony'), [], '退出登录后不再往这台手机推');
  hostA.close();
  va.close();
});

test('重置密码、同一设备重新登录时，挂在旧登录上的推送令牌跟着删', async (t) => {
  const { s } = await pushServer(t);
  const a = await account(s, 'a@example.com', 'pc-a');
  const hostA = await connect(s.wsUrl, auth('host', a.hostToken));
  await hostA.next('auth-ok');

  // 同一台手机重新登录：旧登录令牌作废，推送令牌要等 App 用新登录重新登记
  const v1 = await registerPush(s, a.viewerToken, TOK_A);
  await hostA.next((m) => m.type === 'viewer-join' && m.id === 'push');
  const relogin = await s.login('a@example.com', 'password-123', 'viewer', 'phone-pc-a', '测试手机');
  assert.equal(relogin.status, 200);
  assert.equal((await v1.next('auth-fail')).reason, 'revoked');
  assert.deepEqual(await hostA.next('viewer-leave'), { type: 'viewer-leave', id: 'push' });
  assert.deepEqual(s.app.store.pushTokens(1, 'harmony'), []);

  // 重置密码：账号下所有登录作废，推送令牌全删（电脑也被踢下线）
  const v2 = await registerPush(s, relogin.body.token, TOK_A);
  await hostA.next((m) => m.type === 'viewer-join' && m.id === 'push');
  await s.post('/api/auth/send-code', { email: 'a@example.com', purpose: 'reset' });
  const reset = await s.post('/api/auth/reset-password', { email: 'a@example.com', code: s.lastCode('a@example.com'), password: 'new-password-1' });
  assert.equal(reset.status, 200);
  assert.equal((await v2.next('auth-fail')).reason, 'revoked');
  assert.deepEqual(s.app.store.pushTokens(1, 'harmony'), []);
});

test('一个账号最多留 10 个令牌，多出的删最久没登记的', async (t) => {
  const { s } = await pushServer(t);
  const a = await account(s, 'a@example.com', 'pc-a');
  const v = await connect(s.wsUrl, auth('viewer', a.viewerToken));
  await v.next('auth-ok');
  for (let i = 0; i < 12; i++) {
    // 每分钟最多登记 30 次，这里 12 次不受影响
    v.send(JSON.stringify({ type: 'push-register', platform: 'harmony', token: `tok-${i}` }));
    assert.equal((await v.next('push-register-result')).ok, true);
  }
  const left = s.app.store.pushTokens(1, 'harmony');
  assert.equal(left.length, 10);
  assert.ok(!left.includes('tok-0') && !left.includes('tok-1'));
  v.close();
});

test('通知文字：默认只说有一条审批；showDetail 时标题按类型、正文是会话名加说明，截到 100 字', () => {
  assert.deepEqual(approvalText(permission('1')), { title: 'Claude 要你审批：Bash', body: '修登录页：构建并清理旧产物' });
  assert.equal(approvalText(permission('1', { tool: 'ExitPlanMode' })).title, 'Claude 要你审批计划');
  assert.equal(approvalText(permission('1', { tool: '计划' })).title, 'Claude 要你审批计划');
  assert.equal(approvalText(permission('1', { description: '' })).body, '修登录页：npm run build', '没有说明时用第一个参数');
  assert.equal(approvalText(permission('1', { title: '', description: '', params: [] })).body, '打开 App 查看');
  const long = approvalText({ id: '2', kind: 'ask', title: '会话', questions: [{ question: '很长的问题\n'.repeat(40) }] });
  assert.equal(long.title, 'Claude 有问题要问你');
  assert.equal([...long.body].length, 100);
  assert.ok(long.body.endsWith('…'));
  assert.ok(!long.body.includes('\n'));

  for (const id of ['1f0c9a2b3c4d5e6f', 'x', 'ffffffffffffffff']) {
    const n = notifyIdOf(id);
    assert.ok(Number.isInteger(n) && n >= 0 && n <= 2147483647);
    assert.equal(n, notifyIdOf(id), '同一条审批的编号不变');
  }
  const n = huaweiNotification(permission('1'), 'pc', 'WORK');
  assert.equal(n.category, 'WORK');
  assert.deepEqual([n.title, n.body], ['Claude 要你审批', '打开 App 查看'], '默认不带工具名、会话名、命令');
  assert.ok(!/修登录页|Bash|npm run build|构建/.test(JSON.stringify(n)));
  assert.equal(huaweiNotification(permission('1', { tool: 'ExitPlanMode' }), 'pc', 'WORK').title, 'Claude 要你审批计划');
  const ask = huaweiNotification({ id: '2', kind: 'ask', title: '会话', questions: [{ question: '用哪种数据库？' }] }, 'pc', 'WORK');
  assert.deepEqual([ask.title, ask.body], ['Claude 有问题要问你', '打开 App 查看']);
  const detailed = huaweiNotification(permission('1'), 'pc', 'WORK', true);
  assert.deepEqual({ title: detailed.title, body: detailed.body }, approvalText(permission('1')), 'showDetail 为 true 时带细节');
  assert.ok(Buffer.byteLength(JSON.stringify({ payload: { notification: huaweiNotification({ id: 'a'.repeat(64), kind: 'ask', title: '字'.repeat(300), questions: [{ question: '字'.repeat(3000) }] }, 'h'.repeat(64), 'MARKETING', true) } })) < 4096, '消息体不超过 4096 字节');
});

test('推送配置：可选、可关、缺密钥文件报错、环境变量优先', (t) => {
  assert.equal(normalizeConfig({}, __dirname).push.huawei, null, '不配置就不推送');
  assert.equal(normalizeConfig({ push: { huawei: { enabled: false, serviceAccountFile: 'x.json' } } }, __dirname).push.huawei, null);
  assert.throws(() => normalizeConfig({ push: { huawei: { projectId: 'p' } } }, __dirname), /serviceAccountFile/);
  assert.throws(() => normalizeConfig({ push: { huawei: { serviceAccountFile: 'k.json', ttl: 0 } } }, __dirname), /ttl/);

  const hw = normalizeConfig({ push: { huawei: { projectId: 'p1', serviceAccountFile: 'keys/k.json', category: 'work' } } }, __dirname).push.huawei;
  assert.equal(hw.serviceAccountFile, path.join(__dirname, 'keys', 'k.json'), '相对配置文件所在目录');
  assert.equal(hw.category, 'WORK');
  assert.equal(hw.testMessage, true, '默认发测试消息');
  assert.equal(hw.showDetail, false, '默认通知不带审批内容');
  assert.equal(hw.apiBase, 'https://push-api.cloud.huawei.com');
  assert.equal(normalizeConfig({ push: { huawei: { serviceAccountFile: 'k.json', showDetail: true } } }, __dirname).push.huawei.showDetail, true);
  assert.equal(normalizeConfig({ push: { huawei: { serviceAccountFile: 'k.json', showDetail: 'yes' } } }, __dirname).push.huawei.showDetail, false, '只有 true 才带');

  const saved = { ...process.env };
  t.after(() => {
    process.env.RC_PUSH_HUAWEI_KEY_FILE = saved.RC_PUSH_HUAWEI_KEY_FILE;
    process.env.RC_PUSH_HUAWEI_PROJECT_ID = saved.RC_PUSH_HUAWEI_PROJECT_ID;
    if (saved.RC_PUSH_HUAWEI_KEY_FILE === undefined) delete process.env.RC_PUSH_HUAWEI_KEY_FILE;
    if (saved.RC_PUSH_HUAWEI_PROJECT_ID === undefined) delete process.env.RC_PUSH_HUAWEI_PROJECT_ID;
  });
  process.env.RC_PUSH_HUAWEI_KEY_FILE = path.join(os.tmpdir(), 'env-key.json');
  process.env.RC_PUSH_HUAWEI_PROJECT_ID = 'env-proj';
  const env = normalizeConfig({ push: { huawei: { projectId: 'p1', serviceAccountFile: 'k.json' } } }, __dirname).push.huawei;
  assert.equal(env.serviceAccountFile, path.join(os.tmpdir(), 'env-key.json'));
  assert.equal(env.projectId, 'env-proj');
  assert.equal(normalizeConfig({}, __dirname).push.huawei.serviceAccountFile, path.join(os.tmpdir(), 'env-key.json'), '只设环境变量也启用');
});

test('密钥文件读不出来（不存在、不是 JSON、缺字段、私钥坏了）时服务器起不来，报错里有文件名和怎么改', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-push-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, text) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
  };
  const cases = [
    [path.join(dir, 'no-such-key-file.json'), /no-such-key-file\.json/],
    [write('bad-json.json', '{ not json'), /bad-json\.json/],
    [write('no-fields.json', JSON.stringify({ project_id: 'p' })), /缺少 key_id、private_key、sub_account: .*no-fields\.json/],
    [write('bad-key.json', JSON.stringify({ project_id: 'p', key_id: 'k', sub_account: 's', private_key: 'not a pem' })), /bad-key\.json.*private_key/],
  ];
  for (const [file, re] of cases) {
    await assert.rejects(startServer({ push: { huawei: { projectId: 'p', serviceAccountFile: file } } }), (err) => {
      assert.match(err.message, re);
      assert.match(err.message, /serviceAccountFile/, '说怎么改');
      assert.match(err.message, /enabled/, '说怎么先关掉推送');
      return true;
    });
  }
  // 关掉推送时不读密钥文件
  const s = await startServer({ push: { huawei: { enabled: false, serviceAccountFile: cases[0][0] } } });
  t.after(() => s.close());
  assert.equal(s.app.push.enabled, false);
});
