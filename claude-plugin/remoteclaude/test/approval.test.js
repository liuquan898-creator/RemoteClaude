'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rc-appr-'));
}

/** 跑一个钩子脚本，stdin 给 payload，返回 { code, stdout, stderr } */
function runHook(script, payload, dir, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, script)], {
      env: { ...process.env, RC_APPROVALS_DIR: dir, RC_APPROVAL_GRACE_MS: '200', ...extraEnv },
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function hostAlive(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'host.json'), JSON.stringify({ pid: 1, at: Date.now() }));
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const pendingFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.pending.json'));

/** 扮演被控端：等 pending 出现，按 answer 写 done */
async function answerFirst(dir, answer) {
  const name = await waitFor(() => pendingFiles(dir)[0]);
  const req = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  fs.writeFileSync(path.join(dir, `${req.id}.done.json`), JSON.stringify({ kind: 'answer', via: 'test', ...answer }));
  return req;
}

const bash = { session_id: 's1', cwd: 'F:\\proj', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: '删掉构建目录' } };

test('被控端没在运行时什么都不做', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = await runHook('approval.js', bash, dir);
  assert.equal(r.stdout, '');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('手机允许：输出 allow，pending 写了完整参数，结束后删掉', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const hook = runHook('approval.js', bash, dir);
  const req = await answerFirst(dir, { choice: 'allow' });
  assert.equal(req.kind, 'permission');
  assert.equal(req.tool, 'Bash');
  assert.equal(req.description, '删掉构建目录');
  assert.deepEqual(req.params, [{ key: 'command', value: 'rm -rf build' }]);
  assert.equal(req.complete, true);
  const r = await hook;
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(pendingFiles(dir), []);
});

test('手机拒绝并说明：deny 的消息带说明原话；中文转义成 ASCII', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const hook = runHook('approval.js', bash, dir);
  await answerFirst(dir, { choice: 'deny', text: '先别删，里面有日志' });
  const r = await hook;
  assert.match(r.stdout, /^[\x20-\x7e]+$/);
  const d = JSON.parse(r.stdout).hookSpecificOutput.decision;
  assert.equal(d.behavior, 'deny');
  assert.ok(d.message.startsWith('用户在 RemoteClaude App 上拒绝了这次操作。'));
  assert.ok(d.message.endsWith('用户的说明（原话，到结尾为止）：\n先别删，里面有日志'));
});

test('回答提问：allow 带原来的输入和 answers', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const questions = [
    { question: '用哪个框架？', header: '框架', multiSelect: false, options: [{ label: 'React', description: '组件库' }, { label: 'Vue', description: '' }] },
    { question: '要哪些功能？', header: '功能', multiSelect: true, options: [{ label: '登录' }, { label: '支付' }] },
  ];
  const hook = runHook('approval.js', { session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions } }, dir);
  const req = await answerFirst(dir, { choice: 'allow', answers: { '用哪个框架？': 'Vue', '要哪些功能？': ['登录', '支付'] } });
  assert.equal(req.kind, 'ask');
  assert.equal(req.questions[1].multiSelect, true);
  assert.equal(req.questions[0].options[0].description, '组件库');
  const d = JSON.parse((await hook).stdout).hookSpecificOutput.decision;
  assert.equal(d.behavior, 'allow');
  assert.deepEqual(d.updatedInput.questions, questions);
  assert.deepEqual(d.updatedInput.answers, { '用哪个框架？': 'Vue', '要哪些功能？': ['登录', '支付'] });
});

test('"下一步"框不管', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const r = await runHook('approval.js', { session_id: 's1', tool_name: 'mcp__ccd_turn__wrap_up', tool_input: {} }, dir);
  assert.equal(r.stdout, '');
  assert.deepEqual(pendingFiles(dir), []);
});

const plan = (text, extra = {}) => ({
  session_id: 's1',
  tool_name: 'ExitPlanMode',
  permission_mode: 'plan',
  tool_input: { plan: text, planFilePath: 'C:\\Users\\x\\.claude\\plans\\p.md' },
  ...extra,
});

test('计划审批：手机上显示成"计划"，批准时原样带上输入（ExitPlanMode 光给 allow 不够）', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const suggestions = [
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
    { type: 'setMode', mode: 'plan', destination: 'session' },
    { type: 'setMode', mode: 'auto', destination: 'session' },
    { type: 'setMode', mode: 'default', destination: 'session' },
  ];
  const p = plan('## 计划\n1. 读 README\n2. 改标题', { permission_suggestions: suggestions });
  const hook = runHook('approval.js', p, dir);
  const req = await answerFirst(dir, { choice: 'allow' });
  assert.equal(req.kind, 'permission');
  assert.equal(req.tool, '计划');
  assert.match(req.description, /拒绝并说明/);
  assert.deepEqual(req.params, [
    { key: '计划', value: '## 计划\n1. 读 README\n2. 改标题' },
    { key: '计划文件', value: 'C:\\Users\\x\\.claude\\plans\\p.md' },
  ]);
  const d = JSON.parse((await hook).stdout).hookSpecificOutput.decision;
  assert.equal(d.behavior, 'allow');
  assert.deepEqual(d.updatedInput, p.tool_input);
  assert.equal(d.updatedPermissions, undefined);
});

test('计划审批：拒绝时告诉 Claude 留在计划模式改，说明放最后', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  let hook = runHook('approval.js', plan('x'), dir);
  await answerFirst(dir, { choice: 'allow' });
  let d = JSON.parse((await hook).stdout).hookSpecificOutput.decision;
  assert.equal(d.behavior, 'allow');
  assert.deepEqual(d.updatedInput, plan('x').tool_input);
  hook = runHook('approval.js', plan('x'), dir);
  await answerFirst(dir, { choice: 'deny', text: '第二步先别做' });
  d = JSON.parse((await hook).stdout).hookSpecificOutput.decision;
  assert.equal(d.behavior, 'deny');
  assert.ok(d.message.startsWith('用户在 RemoteClaude App 上拒绝了这次操作。这是计划审批'));
  assert.ok(d.message.endsWith('用户的说明（原话，到结尾为止）：\n第二步先别做'));
});

test('计划审批：长计划分段放进参数，太长的后面标为不完整', () => {
  const { buildRequest, PLAN_CHUNK } = require('../scripts/approval.js');
  const long = 'a'.repeat(PLAN_CHUNK * 2 + 10);
  const r1 = buildRequest('id1', plan(long));
  assert.deepEqual(r1.params.map((x) => x.key), ['计划（1/3）', '计划（2/3）', '计划（3/3）', '计划文件']);
  assert.equal(r1.params.slice(0, 3).map((x) => x.value).join(''), long);
  assert.equal(r1.complete, true);
  const huge = 'b'.repeat(PLAN_CHUNK * 4);
  const r2 = buildRequest('id2', plan(huge));
  assert.equal(r2.complete, false);
  assert.deepEqual(r2.params.map((x) => x.key), ['计划（1/4）', '计划（2/4）', '计划（3/4）', '…', '计划文件']);
  assert.ok(r2.params.every((x) => x.value.length <= 8000));
});

test('电脑上答了：会话记录里这次调用有了结果，钩子写 closed、不输出决定', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const transcript = path.join(dir, 'session.jsonl');
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: bash.tool_input }] } };
  fs.writeFileSync(transcript, JSON.stringify(call) + '\n');
  const hook = runHook('approval.js', { ...bash, transcript_path: transcript }, dir, { RC_APPROVAL_GRACE_MS: '2500' });
  const name = await waitFor(() => pendingFiles(dir)[0], 8000);
  const id = name.split('.')[0];
  fs.appendFileSync(transcript, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } }) + '\n');
  const r = await hook;
  assert.equal(r.stdout, '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${id}.done.json`), 'utf8')).reason, 'answered_on_computer');
});

test('子代理只等一会儿，超时写 subagent_timeout', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const r = await runHook('approval.js', { ...bash, agent_id: 'a1', agent_type: 'Explore' }, dir, { RC_SUBAGENT_WAIT_MS: '1500' });
  assert.equal(r.stdout, '');
  const done = fs.readdirSync(dir).find((f) => f.endsWith('.done.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, done), 'utf8')).reason, 'subagent_timeout');
});

test('主会话等满上限写 timeout；上限默认 7 天，比 hooks.json 里的 timeout 短', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const r = await runHook('approval.js', bash, dir, { RC_APPROVAL_MAX_WAIT_MS: '1500' });
  assert.equal(r.stdout, '');
  const done = fs.readdirSync(dir).find((f) => f.endsWith('.done.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, done), 'utf8')).reason, 'timeout');

  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'approval.js'), 'utf8');
  assert.match(src, /RC_APPROVAL_MAX_WAIT_MS \|\| 7 \* 24 \* 3600 \* 1000\)/);
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const timeout = hooks.PermissionRequest[0].hooks[0].timeout;
  assert.ok(timeout * 1000 > 7 * 24 * 3600 * 1000, '钩子的 timeout 要比等待上限长');
  assert.ok(timeout * 1000 < 2147483647, 'Claude Code 把钩子超时截到 2^31-1 毫秒');
});

test('结果只有第一个生效', () => {
  const dir = tempDir();
  process.env.RC_APPROVALS_DIR = dir;
  delete require.cache[require.resolve('../scripts/lib')];
  const lib = require('../scripts/lib');
  try {
    assert.equal(lib.finish('abc', { kind: 'answer', choice: 'allow' }), true);
    assert.equal(lib.finish('abc', { kind: 'closed', reason: 'timeout' }), false);
    assert.equal(lib.readJson(lib.file('abc.done.json')).choice, 'allow');
    assert.throws(() => lib.finish('../x', {}));
  } finally {
    delete process.env.RC_APPROVALS_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ToolUseWatch：冻结后出现的同样调用不算候选；路径只比文件名', () => {
  const dir = tempDir();
  const lib = require('../scripts/lib');
  try {
    const transcript = path.join(dir, 't.jsonl');
    const use = (id, input) => JSON.stringify({ message: { content: [{ type: 'tool_use', id, name: 'Edit', input }] } }) + '\n';
    const result = (id) => JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: id }] } }) + '\n';
    // 早先已经答过的同样调用，不是这次的
    fs.writeFileSync(transcript, use('old', { file_path: 'a/b.txt' }) + result('old') + use('cur', { file_path: 'a/b.txt' }));
    const t0 = 1000;
    const w = new lib.ToolUseWatch(transcript, 'Edit', { file_path: 'C:\\x\\a\\B.txt', replace_all: false }, t0, 2000);
    assert.equal(w.resolved(t0 + 100), false);
    assert.deepEqual([...w.candidates], ['cur']);
    assert.equal(w.resolved(t0 + 2100), false);
    fs.appendFileSync(transcript, use('later', { file_path: 'b.txt' })); // 冻结后才出现，不算
    fs.appendFileSync(transcript, result('cur'));
    assert.equal(w.resolved(t0 + 3000), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('"下一步"框改道：带提问的阻塞框被拒，同一个问题 2 分钟内再来就放行', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const tool_name = 'mcp__ccd_turn__wrap_up';
  const p = { session_id: 's1', tool_name, tool_input: { blocked: true, ask: '要不要提交？', recap: 'x' } };
  const first = await runHook('redirect.js', p, dir);
  assert.equal(JSON.parse(first.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await runHook('redirect.js', p, dir)).stdout, '');
  assert.equal((await runHook('redirect.js', { session_id: 's1', tool_name, tool_input: { recap: '只是进展' } }, dir)).stdout, '');
});

test('"新建会话"卡片改道：offer 被拒并带上标题，同一个标题 2 分钟内再来就放行，别的发起方式不管', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tool_name = 'mcp__ccd_session__start_session';
  const offer = { session_id: 's2', tool_name, tool_input: { initiation: 'offer', title: '手机向电脑发送文件' } };
  // 被控端没在运行：不管
  assert.equal((await runHook('redirect.js', offer, dir)).stdout, '');
  hostAlive(dir);
  const first = JSON.parse((await runHook('redirect.js', offer, dir)).stdout).hookSpecificOutput;
  assert.equal(first.permissionDecision, 'deny');
  assert.match(first.permissionDecisionReason, /「手机向电脑发送文件」/);
  assert.match(first.permissionDecisionReason, /AskUserQuestion/);
  assert.equal((await runHook('redirect.js', offer, dir)).stdout, '');
  for (const input of [
    { initiation: 'user_asked', title: 'x', prompt: 'y' },
    { initiation: 'own_initiative', title: 'x', prompt: 'y' },
    { proposal_id: 'task_1', prompt: 'y' },
    { initiation: 'offer', title: '' },
  ]) {
    assert.equal((await runHook('redirect.js', { session_id: 's3', tool_name, tool_input: input }, dir)).stdout, '');
  }
  // 别的工具不管
  assert.equal((await runHook('redirect.js', { session_id: 's3', tool_name: 'Bash', tool_input: { blocked: true, ask: 'x' } }, dir)).stdout, '');
});

// ---------------------------------------------------------------- "下一步"框里不阻塞的提问（nextstep.js）

const WRAP = 'mcp__ccd_turn__wrap_up';
const line = (o) => JSON.stringify(o) + '\n';
const wrapCall = (id, input, extra = {}) =>
  line({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: `msg_${id}`, stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: WRAP, input }] }, ...extra });
const toolResult = (id) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
/** 结尾的答复：思考和正文在记录里是同一条消息的两行 */
const closing = (id = 'msg_end') =>
  line({ type: 'assistant', message: { id, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '…' }] } }) +
  line({ type: 'assistant', message: { id, stop_reason: 'end_turn', content: [{ type: 'text', text: '这套系统能做。' }] } });
const stopSummary = () => line({ type: 'system', subtype: 'stop_hook_summary' });
const userSays = (text) => line({ type: 'user', message: { content: text } });

const followUp = {
  ask: '要我把它细化成一份技术方案文档吗？',
  recap: '你拿到了一份初步架构，还没写成文档。',
  actions: [{ label: '写方案文档' }, { label: '先做相机选型' }],
};
const wrapPayload = (transcript, input = followUp, extra = {}) => ({
  session_id: 's1',
  cwd: 'F:\\proj',
  transcript_path: transcript,
  tool_name: WRAP,
  tool_use_id: 'toolu_w',
  tool_input: input,
  ...extra,
});
const runNext = (payload, dir, env = {}) => runHook('nextstep.js', payload, dir, { RC_NEXTSTEP_GRACE_MS: '300', RC_NEXTSTEP_POLL_MS: '50', ...env });
/** Claude Code 把钩子的 stderr 包成这样，作为一条用户输入写进会话记录（2.1.326 实测） */
const wokenBy = (text) =>
  userSays(`<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nStop hook blocking error from command "PostToolUse:${WRAP}": ${text}\n</system-reminder>`);

test('"下一步"提问：这一轮结束后才叫醒会话（退出码 2），要求用 AskUserQuestion 再问一遍', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, wrapCall('toolu_w', followUp) + toolResult('toolu_w'));
  let finished = false;
  const hook = runNext(wrapPayload(transcript), dir).then((r) => {
    finished = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(finished, false); // 结尾的答复还没写完，不叫醒
  fs.appendFileSync(transcript, closing() + stopSummary());
  const r = await hook;
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.startsWith('RemoteClaude 插件提醒（用户安装的本地钩子发的，不是用户的回答）'));
  assert.match(r.stderr, /请现在用 AskUserQuestion 把同一个问题再问一遍：\n问题：要我把它细化成一份技术方案文档吗？\n选项：「写方案文档」、「先做相机选型」\n/);
  assert.deepEqual(pendingFiles(dir), []); // 钩子自己不往手机推，问是 AskUserQuestion 的事
});

test('"下一步"提问：没带提问、被控端没在运行、子代理的都不管', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, wrapCall('toolu_w', followUp) + toolResult('toolu_w') + closing());
  const quiet = async (payload) => {
    const r = await runNext(payload, dir);
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
  };
  await quiet(wrapPayload(transcript)); // 被控端没在运行
  hostAlive(dir);
  await quiet(wrapPayload(transcript, { recap: '只是进展' }));
  await quiet(wrapPayload(transcript, { ask: '  ', recap: 'x' }));
  await quiet(wrapPayload(transcript, followUp, { agent_id: 'a1' }));
  await quiet(wrapPayload(transcript, followUp, { tool_name: 'Bash' }));
});

test('"下一步"提问：用户在电脑上接着做了就不叫醒', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  // 这一轮结束后、还在等的那几秒里，用户点了框里的按钮
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, wrapCall('toolu_w', followUp) + toolResult('toolu_w') + closing());
  const hook = runNext(wrapPayload(transcript), dir, { RC_NEXTSTEP_GRACE_MS: '2000' });
  await new Promise((r) => setTimeout(r, 500));
  fs.appendFileSync(transcript, userSays('写方案文档'));
  const r = await hook;
  assert.deepEqual([r.code, r.stderr], [0, '']);

  // 结尾的答复还没写完用户就打断了
  const t2 = path.join(dir, 'session2.jsonl');
  fs.writeFileSync(t2, wrapCall('toolu_w', followUp) + toolResult('toolu_w') + userSays('[Request interrupted by user]'));
  const r2 = await runNext(wrapPayload(t2), dir);
  assert.deepEqual([r2.code, r2.stderr], [0, '']);
});

/** 一轮进行中切换模型：这三条等这一轮结束才写进会话记录，时间戳还是切换的那一刻（2.1.330 实测） */
const modelSwitch = () => {
  const timestamp = new Date(Date.now() - 1200000).toISOString();
  return (
    line({ type: 'user', isMeta: true, timestamp, message: { content: '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>' } }) +
    line({ type: 'user', timestamp, message: { content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>claude-opus-5-5</command-args>' } }) +
    line({ type: 'user', timestamp, message: { content: '<local-command-stdout>Set model to `claude-opus-5-5`</local-command-stdout>' } })
  );
};

test('"下一步"提问：这一轮中途切换过模型，切换的记录写在结尾之后，照常叫醒', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, wrapCall('toolu_w', followUp) + toolResult('toolu_w') + closing() + stopSummary() + modelSwitch());
  const r = await runNext(wrapPayload(transcript), dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\n问题：要我把它细化成一份技术方案文档吗？\n/);
});

test('"下一步"提问：这一轮是被钩子叫醒的、框里还是同一个问题就不再叫醒；换了问题照常叫醒', async (t) => {
  const { wakeMessage } = require('../scripts/nextstep.js');
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const asked =
    line({ type: 'assistant', message: { id: 'msg_q', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: {} }] } }) + toolResult('toolu_q');
  // 用户没回答，Claude 结束时又把同一个问题放进了框里
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, wokenBy(wakeMessage(followUp)) + asked + wrapCall('toolu_w', followUp) + toolResult('toolu_w') + closing());
  const r = await runNext(wrapPayload(transcript), dir);
  assert.deepEqual([r.code, r.stderr], [0, '']);

  // 用户选了"写方案文档"，做完后框里是新的问题
  const next = { ask: '要提交吗？', actions: [{ action: 'commit' }] };
  const t2 = path.join(dir, 'session2.jsonl');
  fs.writeFileSync(t2, wokenBy(wakeMessage(followUp)) + asked + wrapCall('toolu_w', next) + toolResult('toolu_w') + closing());
  const r2 = await runNext(wrapPayload(t2, next), dir);
  assert.equal(r2.code, 2);
  assert.match(r2.stderr, /\n问题：要提交吗？\n选项：「提交」、「先不用」\n/);

  // 用户自己起的一轮里问同样的问题，照常叫醒
  const t3 = path.join(dir, 'session3.jsonl');
  fs.writeFileSync(t3, userSays('再看看架构') + wrapCall('toolu_w', followUp) + toolResult('toolu_w') + closing());
  assert.equal((await runNext(wrapPayload(t3), dir)).code, 2);
});

test('"下一步"提问：框里的按钮变成选项，应用按钮写成文字，不够两个补"先不用"', () => {
  const { wakeMessage, optionsOf, MARK } = require('../scripts/nextstep.js');
  assert.deepEqual(optionsOf({ actions: [{ action: 'commit', label: '忽略' }, { label: '先不用' }, { action: 'commit' }, { label: ' ' }, { action: 'create_pr' }] }), ['提交', '先不用', '创建 PR']);
  assert.deepEqual(optionsOf({}), []);
  assert.ok(wakeMessage(followUp).startsWith(MARK));
  assert.match(wakeMessage({ ask: ' 要提交吗？ ', actions: [{ action: 'commit' }] }), /\n问题：要提交吗？\n选项：「提交」、「先不用」\n/);
  assert.match(wakeMessage({ ask: '接下来做什么？' }), /\n问题：接下来做什么？\n选项由你按问题来拟，其中一个是「先不用」\n/);
});

test('TurnWatch：认出这次调用、这一轮结束、会话接着往下走', () => {
  const dir = tempDir();
  const lib = require('../scripts/lib');
  try {
    const transcript = path.join(dir, 't.jsonl');
    const mine = (b) => b.id === 'toolu_w';
    // 上一轮同样的提问（已经答过）不算；这次的调用之后才开始看
    fs.writeFileSync(transcript, wrapCall('toolu_old', followUp) + toolResult('toolu_old') + closing('msg_old') + userSays('先不用'));
    const w = new lib.TurnWatch(transcript, WRAP, mine);
    assert.equal(w.state(), 'waiting');
    assert.equal(w.found, false);
    // 附带信息（isMeta）不是用户输入
    fs.appendFileSync(transcript, line({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: '附带信息' }] } }));
    fs.appendFileSync(transcript, wrapCall('toolu_w', followUp) + toolResult('toolu_w'));
    assert.equal(w.state(), 'waiting');
    assert.equal(w.found, true);
    assert.equal(w.turnInput, '先不用'); // 这一轮是由这句话开始的
    fs.appendFileSync(transcript, line({ type: 'user', isMeta: true, message: { content: '附带信息' } }));
    assert.equal(w.state(), 'waiting');
    // 结尾答复的思考和正文是同一条消息，不算"又开了一轮"
    fs.appendFileSync(transcript, closing());
    assert.equal(w.state(), 'ended');
    fs.appendFileSync(transcript, stopSummary() + line({ type: 'custom-title', customTitle: 'x' }));
    assert.equal(w.state(), 'ended');
    // 斜杠命令的记录（字符串或内容块）不是用户接着说话
    fs.appendFileSync(transcript, modelSwitch() + line({ type: 'user', message: { content: [{ type: 'text', text: '<command-name>/rename</command-name>' }] } }));
    assert.equal(w.state(), 'ended');
    assert.equal(lib.isCommandRecord('<local-command-stderr>x</local-command-stderr>'), true);
    assert.equal(lib.isCommandRecord('帮我看看 <command-name> 是什么'), false);
    fs.appendFileSync(transcript, line({ type: 'assistant', message: { id: 'msg_next', stop_reason: 'tool_use', content: [{ type: 'text', text: '被别的事叫醒了' }] } }));
    assert.equal(w.state(), 'superseded');

    // 没有 stop_reason 时靠 Stop 钩子的摘要；又一个"下一步"框也算往下走了
    const t2 = path.join(dir, 't2.jsonl');
    fs.writeFileSync(t2, wrapCall('toolu_w', followUp) + line({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: '答复' }] } }));
    const w2 = new lib.TurnWatch(t2, WRAP, mine);
    assert.equal(w2.state(), 'waiting');
    fs.appendFileSync(t2, stopSummary());
    assert.equal(w2.state(), 'ended');
    fs.appendFileSync(t2, wrapCall('toolu_w2', { ask: '别的问题' }));
    assert.equal(w2.state(), 'superseded');

    // 会话记录读不了：一直是 waiting
    assert.equal(new lib.TurnWatch(path.join(dir, 'nope.jsonl'), WRAP, mine).state(), 'waiting');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('"下一步"提问：钩子输入里没有调用编号时，按提问原文认最近的那次调用', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const transcript = path.join(dir, 'session.jsonl');
  const old = { timestamp: new Date(Date.now() - 600000).toISOString() };
  // 十分钟前同样的提问（后面跟着用户的回答）不是这次的
  fs.writeFileSync(transcript, wrapCall('toolu_old', followUp, old) + toolResult('toolu_old') + closing('msg_old') + userSays('先不用'));
  fs.appendFileSync(transcript, wrapCall('toolu_new', followUp) + toolResult('toolu_new') + closing());
  const r = await runNext(wrapPayload(transcript, followUp, { tool_use_id: undefined }), dir);
  assert.equal(r.code, 2);
  // 只有十分钟前那一次：这次的调用还没出现在会话记录里，等不到就不管
  const t2 = path.join(dir, 'session2.jsonl');
  fs.writeFileSync(t2, wrapCall('toolu_old', followUp, old) + toolResult('toolu_old') + closing('msg_old'));
  const r2 = await runNext(wrapPayload(t2, followUp, { tool_use_id: undefined }), dir, { RC_NEXTSTEP_END_WAIT_MS: '600' });
  assert.deepEqual([r2.code, r2.stderr], [0, '']);
});

// ---------------------------------------------------------------- 答过的提问还留在"下一步"框里（stalebox.js）

const askCall = (id) => line({ type: 'assistant', message: { id: `msg_${id}`, stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: {} }] } });
const answered = (id, content) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const CHOSE = 'Your questions have been answered: "要我把它细化成一份技术方案文档吗？"="写方案文档". You can now continue with these answers in mind.';
const taskDone = () => userSays('<task-notification>\n<summary>后台任务结束了</summary>\n</task-notification>');
const markerOf = (dir, session = 's1') => path.join(dir, `nextstep-${session}.json`);
const runStale = (transcript, dir, extra = {}) => runHook('stalebox.js', { session_id: 's1', transcript_path: transcript, hook_event_name: 'Stop', ...extra }, dir);

test('"下一步"提问：叫醒时记一笔，这个会话再有"下一步"框就删掉', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const transcript = path.join(dir, 'session.jsonl');
  fs.writeFileSync(transcript, wrapCall('toolu_w', followUp) + toolResult('toolu_w') + closing());
  assert.equal((await runNext(wrapPayload(transcript), dir)).code, 2);
  const mark = JSON.parse(fs.readFileSync(markerOf(dir), 'utf8'));
  assert.equal(mark.ask, followUp.ask);
  assert.ok(Date.now() - mark.at < 10000);
  // 子代理的框不算
  await runNext(wrapPayload(transcript, { recap: '子代理做完了' }, { agent_id: 'a1' }), dir);
  assert.equal(fs.existsSync(markerOf(dir)), true);
  // 只写进展的框也算：桌面端的框已经换了
  await runNext(wrapPayload(transcript, { recap: '做完了' }), dir);
  assert.equal(fs.existsSync(markerOf(dir)), false);
});

test('旧的"下一步"框：提问答了、Claude 没再调 wrap_up，这一轮结束时拦一次（退出码 2）', async (t) => {
  const { wakeMessage } = require('../scripts/nextstep.js');
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 'session.jsonl');
  const woken = wrapCall('toolu_w', followUp) + toolResult('toolu_w') + closing() + wokenBy(wakeMessage(followUp));
  const mark = (at = Date.now()) => fs.writeFileSync(markerOf(dir), JSON.stringify({ at, ask: followUp.ask }));

  // 没有叫醒的记录：什么都不做
  fs.writeFileSync(transcript, woken + askCall('toolu_q') + answered('toolu_q', CHOSE) + closing('msg_done'));
  let r = await runStale(transcript, dir);
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);

  // 答了、照做了、停下来等后台任务：提醒把旧框换掉
  mark();
  r = await runStale(transcript, dir);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.ok(r.stderr.startsWith('RemoteClaude 插件提醒（用户安装的本地钩子发的，不是用户的回答）'));
  assert.match(r.stderr, /\n问题：要我把它细化成一份技术方案文档吗？\n请现在调用一次 wrap_up 把它换掉/);
  assert.equal(fs.existsSync(markerOf(dir)), false);
  // 一条记录只提醒一次
  r = await runStale(transcript, dir);
  assert.deepEqual([r.code, r.stderr], [0, '']);

  // 后台任务结束把会话又叫起来、做完还是没调：照样提醒（那条通知不是用户说话）；结果是内容块的也认
  fs.writeFileSync(transcript, woken + askCall('toolu_q') + answered('toolu_q', [{ type: 'text', text: CHOSE }]) + closing('msg_wait') + taskDone() + closing('msg_done'));
  mark();
  assert.equal((await runStale(transcript, dir)).code, 2);

  // 同一个问题叫醒过两次（第一次用户发了条消息没选），以后一次为准
  const twice =
    woken + askCall('toolu_q1') + answered('toolu_q1', 'The user answered: "…"="[User did not answer this question — they sent a message instead]"') + closing('msg_a') +
    userSays('这个对性能影响大吗？') + wrapCall('toolu_w2', followUp) + toolResult('toolu_w2') + closing('msg_b') +
    wokenBy(wakeMessage(followUp)) + askCall('toolu_q2') + answered('toolu_q2', CHOSE) + closing('msg_done');
  fs.writeFileSync(transcript, twice);
  mark();
  assert.equal((await runStale(transcript, dir)).code, 2);

  // 答了以后切换过模型：斜杠命令的记录不是用户说话，照样提醒
  fs.writeFileSync(transcript, woken + askCall('toolu_q') + answered('toolu_q', CHOSE) + closing('msg_a') + modelSwitch() + closing('msg_done'));
  mark();
  assert.equal((await runStale(transcript, dir)).code, 2);
});

test('旧的"下一步"框：没回答、没问、用户自己又说了话、叫醒还没到，都不拦', async (t) => {
  const { wakeMessage } = require('../scripts/nextstep.js');
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 'session.jsonl');
  const before = wrapCall('toolu_w', followUp) + toolResult('toolu_w') + closing();
  const woken = before + wokenBy(wakeMessage(followUp));
  const quiet = async (body, { keep = false, at = Date.now(), payload = {} } = {}) => {
    fs.writeFileSync(transcript, body);
    fs.writeFileSync(markerOf(dir), JSON.stringify({ at, ask: followUp.ask }));
    const r = await runStale(transcript, dir, payload);
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
    assert.equal(fs.existsSync(markerOf(dir)), keep);
  };
  // 用户没有回答（手机上超时、发了条消息、电脑上按了 Esc）：框里的问题还算数
  await quiet(woken + askCall('toolu_q') + answered('toolu_q', '用户在 RemoteClaude App 上没有回答这个问题。') + closing('msg_done'));
  await quiet(woken + askCall('toolu_q') + answered('toolu_q', 'The user answered: "…"="[User did not answer this question — they sent a message instead]"') + closing('msg_done'));
  await quiet(woken + askCall('toolu_q') + answered('toolu_q', "The user doesn't want to proceed with this tool use. The tool use was rejected.") + closing('msg_done'));
  // Claude 被叫醒了但没问
  await quiet(woken + closing('msg_done'));
  // 答了以后用户自己又说了话：新的一轮，旧框不会再画出来
  await quiet(woken + askCall('toolu_q') + answered('toolu_q', CHOSE) + closing('msg_a') + userSays('再改一下') + closing('msg_done'));
  // 叫醒还没写进会话记录：先留着；十分钟还没有就删
  await quiet(before, { keep: true });
  await quiet(before, { at: Date.now() - 700000 });
  // 更早那次同样的叫醒（答过了）不是这一次的
  const old = line({ type: 'user', timestamp: new Date(Date.now() - 3600000).toISOString(), message: { content: `Stop hook blocking error: ${wakeMessage(followUp)}` } });
  await quiet(old + askCall('toolu_q') + answered('toolu_q', CHOSE) + closing('msg_done') + before, { keep: true });
  // 会话记录读不了：删掉记录，照常结束
  await quiet(woken, { payload: { transcript_path: path.join(dir, 'nope.jsonl') } });
});

test('旧的"下一步"框：提醒以后 Claude 又把同一个问题放进框里，不再叫醒', async (t) => {
  const { wakeMessage } = require('../scripts/nextstep.js');
  const { nudge } = require('../scripts/stalebox.js');
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hostAlive(dir);
  const transcript = path.join(dir, 'session.jsonl');
  // Stop 钩子的话在会话记录里要是一条用户输入，这一轮的开头就成了它：里面也带着叫醒消息的开头和同一个问题
  fs.writeFileSync(
    transcript,
    wokenBy(wakeMessage(followUp)) + askCall('toolu_q') + answered('toolu_q', CHOSE) + closing('msg_a') + userSays(`Stop hook feedback:\n${nudge(followUp.ask)}`) +
      wrapCall('toolu_w', followUp) + toolResult('toolu_w') + closing(),
  );
  const r = await runNext(wrapPayload(transcript), dir);
  assert.deepEqual([r.code, r.stderr], [0, '']);
});

test('eachLine：大文件逐行读，跨块的行和多字节字符不坏', () => {
  const lib = require('../scripts/lib');
  const dir = tempDir();
  try {
    const p = path.join(dir, 'big.txt');
    const long = '提问'.repeat(400000); // 2.4 MB，跨好几块
    fs.writeFileSync(p, `第一行\n${long}\n\n最后一行没有换行`);
    const got = [];
    lib.eachLine(p, (l) => got.push(l));
    assert.deepEqual(got.map((l) => l.length), [3, long.length, 0, 8]);
    assert.equal(got[1], long);
    assert.equal(got[3], '最后一行没有换行');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('会话开头：装好了才注入规则', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, 'nope');
  assert.equal((await runHook('session-start.js', {}, missing)).stdout, '');
  const r = await runHook('session-start.js', {}, dir);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /RemoteClaude 手机审批规则/);
});
