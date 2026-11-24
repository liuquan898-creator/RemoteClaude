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
const { approvalText, notifyIdOf, huaweiNotification } = require('../lib/push');
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
async function pushServer(t, { clock, extra = {}, dataDir, autoClose = true } = {}) {
  const fake = await fakeHuawei(t);
  const { file } = keyFile(t);
  const logs = [];
  const s = await startServer(
    { ...(dataDir ? { dataDir } : {}), push: { huawei: { projectId: PROJECT, serviceAccountFile: file, apiBase: fake.base, ...extra } } },
    { log: (...a) => logs.push(a.join(' ')), ...(clock ? { now: () => clock.t } : {}) }
  );
  if (autoClose) t.after(() => s.close());
  return { s, fake, logs };
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
  const { s, fake, logs } = await pushServer(t);
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

test('华为说令牌全都无效（80300007）时删掉令牌，电脑看到虚拟控制端下线', async (t) => {
  const { s, fake } = await pushServer(t);
  const a = await account(s, 'a@example.com', 'pc-a');
  (await registerPush(s, a.viewerToken, TOK_A)).close();
  const host = await connect(s.wsUrl, auth('host', a.hostToken));
  await host.next('auth-ok');

  fake.setReply(() => ({ status: 200, body: { code: '80300007', msg: 'All the tokens are invalid', requestId: 'r' } }));
  host.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('x1')] }));
  await fake.waitFor(1);
  assert.deepEqual(await host.next('viewer-leave'), { type: 'viewer-leave', id: 'push' });
  assert.deepEqual(s.app.store.pushTokens(1, 'harmony'), []);
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

test('推送接口出错不影响信令；暂时性错误下次发列表时重推，推成了就不再推', async (t) => {
  const { s, fake, logs } = await pushServer(t, { extra: { timeoutMs: 200 } });
  const a = await account(s, 'a@example.com', 'pc-a');
  const v = await registerPush(s, a.viewerToken, TOK_A);
  const host = await connect(s.wsUrl, auth('host', a.hostToken));
  const ok = (await host.next('auth-ok')).viewers.find((id) => id !== 'push');

  fake.setReply(() => ({ status: 500, body: { code: '81000001', msg: 'Internal error', requestId: 'r' } }));
  host.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('e1')] }));
  await fake.waitFor(1);
  await new Promise((r) => setTimeout(r, 50));
  fake.setReply(() => ({ status: 200, body: { code: '80000000', msg: 'Success', requestId: 'r' } }));
  host.send(JSON.stringify({ type: 'approvals', to: ok, list: [permission('e1')] }));
  assert.equal((await v.next('approvals')).list[0].id, 'e1', '转发照常');
  assert.equal((await fake.waitFor(2)).body.payload.notification.clickAction.data.approvalId, 'e1', '上次没推成，这次重推');
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
  host.send(JSON.stringify({ type: 'approvals', to: 'push', list: [permission('e1'), permission('e2')] }));
  await fake.settle();
  assert.equal(fake.requests.length, 3);
  host.close();
  v.close();
});

test('网络不通、超时：信令照常，下次发列表时重推', async (t) => {
  const { s } = await pushServer(t, { extra: { timeoutMs: 200, apiBase: 'http://127.0.0.1:9' } });
  const a = await account(s, 'a@example.com', 'pc-a');
  const v = await registerPush(s, a.viewerToken, TOK_A);
  const host = await connect(s.wsUrl, auth('host', a.hostToken));
  const ok = (await host.next('auth-ok')).viewers.find((id) => id !== 'push');
  await s.app.push.onApprovals(1, 'pc-a', [permission('n1')]);
  assert.equal(s.app.store.markNotified(1, 'pc-a', 'n1', Date.now()), true, '没推成的撤掉了记录');
  host.send(JSON.stringify({ type: 'approvals', to: ok, list: [permission('n1')] }));
  assert.equal((await v.next('approvals')).list[0].id, 'n1');
  host.close();
  v.close();
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

test('通知文字：标题按类型，正文是会话名加说明，截到 100 字', () => {
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
  assert.equal(huaweiNotification(permission('1'), 'pc', 'MARKETING', false).body, '修登录页', '不显示细节时只有会话名');
  assert.ok(Buffer.byteLength(JSON.stringify({ payload: { notification: huaweiNotification({ id: 'a'.repeat(64), kind: 'ask', title: '字'.repeat(300), questions: [{ question: '字'.repeat(3000) }] }, 'h'.repeat(64), 'MARKETING') } })) < 4096, '消息体不超过 4096 字节');
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
  assert.equal(hw.apiBase, 'https://push-api.cloud.huawei.com');

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

test('密钥文件读不出来时不推送，服务器照常启动', async (t) => {
  const logs = [];
  const s = await startServer({ push: { huawei: { projectId: 'p', serviceAccountFile: path.join(os.tmpdir(), 'no-such-key-file.json') } } }, { log: (...a) => logs.push(a.join(' ')) });
  t.after(() => s.close());
  assert.equal(s.app.push.enabled, false);
  assert.ok(logs.some((l) => l.includes('华为推送没启用')));
});
