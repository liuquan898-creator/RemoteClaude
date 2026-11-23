'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createApprovals, checkAnswer } = require('../approvals');

const HOOK = path.join(__dirname, '..', '..', 'claude-plugin', 'remoteclaude', 'scripts', 'approval.js');
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-hostappr-'));
const quiet = () => {};

function writePending(dir, req, ageMs = 0) {
  const p = path.join(dir, `${req.id}.pending.json`);
  fs.writeFileSync(p, JSON.stringify(req));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
}

const perm = { id: 'aaaaaaaaaaaaaaaa', kind: 'permission', sessionId: 'cli-1', cwd: 'F:\\proj', title: '记录里的标题', tool: 'Bash', description: '删构建目录', params: [{ key: 'command', value: 'rm -rf build' }], complete: true, createdAt: 2 };
const ask = {
  id: 'bbbbbbbbbbbbbbbb',
  kind: 'ask',
  sessionId: 'cli-2',
  cwd: 'E:\\x',
  createdAt: 1,
  questions: [
    { question: '选哪个？', header: '方案', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
    { question: '要哪些？', header: '功能', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }] },
  ],
};

test('列出活着的审批：按时间排，桌面端标题优先，过期的和有结果的不列；写心跳', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writePending(dir, perm);
  writePending(dir, ask);
  writePending(dir, { ...perm, id: 'cccccccccccccccc' }, 60000); // 心跳停了
  writePending(dir, { ...perm, id: 'dddddddddddddddd' });
  fs.writeFileSync(path.join(dir, 'dddddddddddddddd.done.json'), '{}'); // 已经有结果
  const a = createApprovals({ log: quiet, dir, titleFor: (sid) => (sid === 'cli-1' ? '桌面端标题' : '') });
  let changed = null;
  a.onChange((list) => (changed = list));
  a.start();
  t.after(() => a.stop());
  assert.deepEqual(a.list.map((x) => x.id), [ask.id, perm.id]);
  assert.equal(a.list[1].title, '桌面端标题');
  assert.equal(a.list[0].title, 'x', '没有标题时用目录名');
  assert.equal(changed.length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'host.json')));
  a.stop();
  assert.ok(!fs.existsSync(path.join(dir, 'host.json')), '退出时删掉心跳');
});

test('作答：写 done，只有第一个生效；答案格式不对拒收', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writePending(dir, perm);
  writePending(dir, ask);
  const a = createApprovals({ log: quiet, dir });
  a.start();
  t.after(() => a.stop());
  assert.deepEqual(a.answer(perm.id, { choice: 'maybe' }), { ok: false, code: 'bad' });
  assert.deepEqual(a.answer(perm.id, { choice: 'deny', text: '不行' }), { ok: true });
  const done = JSON.parse(fs.readFileSync(path.join(dir, `${perm.id}.done.json`), 'utf8'));
  assert.equal(done.choice, 'deny');
  assert.equal(done.text, '不行');
  assert.deepEqual(a.answer(perm.id, { choice: 'allow' }), { ok: false, code: 'gone' }, '已经答过了');
  assert.deepEqual(a.list.map((x) => x.id), [ask.id]);

  assert.deepEqual(a.answer(ask.id, { choice: 'allow', answers: { '选哪个？': 'A' } }), { ok: false, code: 'bad' }, '少答一个问题');
  assert.deepEqual(a.answer(ask.id, { choice: 'allow', answers: { '选哪个？': ['A'], '要哪些？': ['甲'] } }), { ok: false, code: 'bad' }, '单选不能给数组');
  assert.deepEqual(a.answer(ask.id, { choice: 'allow', answers: { '选哪个？': '自己写的', '要哪些？': ['甲', '乙'], 别的: 'x' } }), { ok: true });
  const d2 = JSON.parse(fs.readFileSync(path.join(dir, `${ask.id}.done.json`), 'utf8'));
  assert.deepEqual(d2.answers, { '选哪个？': '自己写的', '要哪些？': ['甲', '乙'] }, '多余的键不写进去');
  assert.deepEqual(a.answer('../../etc', { choice: 'allow' }), { ok: false, code: 'gone' });
});

test('checkAnswer：审批不收 answers，拒绝提问也行', () => {
  assert.deepEqual(checkAnswer({ kind: 'permission' }, { choice: 'allow', answers: { x: 1 } }), { kind: 'answer', choice: 'allow', text: '', via: 'app' });
  assert.equal(checkAnswer({ kind: 'ask', questions: [] }, { choice: 'deny' }).choice, 'deny');
});

test('和真的审批钩子走一遍：钩子写 pending，被控端列出来，手机允许后钩子输出 allow', async (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = createApprovals({ log: quiet, dir });
  a.start();
  t.after(() => a.stop());
  const child = spawn(process.execPath, [HOOK], { env: { ...process.env, RC_APPROVALS_DIR: dir, RC_APPROVAL_GRACE_MS: '100' } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const closed = new Promise((r) => child.on('close', r));
  child.stdin.end(JSON.stringify({ session_id: 's', cwd: 'F:\\p', tool_name: 'Write', tool_input: { file_path: 'a.txt', content: '你好' } }));
  const deadline = Date.now() + 8000;
  while (!a.list.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(a.list.length, 1);
  assert.deepEqual(a.list[0].params, [
    { key: 'file_path', value: 'a.txt' },
    { key: 'content', value: '你好' },
  ]);
  assert.deepEqual(a.answer(a.list[0].id, { choice: 'allow' }), { ok: true });
  await closed;
  assert.equal(JSON.parse(out).hookSpecificOutput.decision.behavior, 'allow');
});
