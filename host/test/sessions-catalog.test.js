'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildGroups, loadRecords, findDataDir, folderKey } = require('../sessions/catalog');

const env = (id, name, folder, lastUsedAt = 0) => ({ id, name, folder, kind: 'local', lastUsedAt });
const sess = (id, title, folder, at, extra = {}) => ({ id, title, folder, env: '', archived: false, at, ...extra });

test('会话按所属环境分组，没记环境的按目录归到同目录的环境', () => {
  const groups = buildGroups({
    presets: [env('e1', 'RemoteClaude', 'F:\\SVNProjects\\RemoteClaude'), env('e2', 'G3', 'F:\\SVNProjects\\G3')],
    sessions: [
      sess('local_a', '远程控制', 'F:\\SVNProjects\\RemoteClaude', 300, { env: 'e1' }),
      sess('local_b', '推杆', 'f:\\svnprojects\\g3\\', 200), // 没记环境，目录大小写和结尾斜杠不同
      sess('local_c', '后端', 'E:\\SVNProjects\\GitProjects', 100),
    ],
    popouts: [{ sessionId: 'local_a', title: '远程控制' }],
  });
  assert.deepEqual(
    groups.map((g) => [g.key, g.name, g.env, g.sessions.map((s) => s.id)]),
    [
      ['env:e1', 'RemoteClaude', 'e1', ['local_a']],
      ['env:e2', 'G3', 'e2', ['local_b']],
      ['dir:e:\\svnprojects\\gitprojects', 'GitProjects', null, ['local_c']],
    ]
  );
  assert.equal(groups[0].sessions[0].open, true, '开成单独窗口的会话标出来');
  assert.equal(groups[1].sessions[0].open, false);
});

test('归档的不列；临时目录归到无文件夹；没有会话的环境排在最后', () => {
  const groups = buildGroups({
    presets: [env('e1', '空环境A', 'C:\\a', 5), env('e2', '空环境B', 'C:\\b', 9), env('e3', '有会话', 'C:\\c', 1)],
    sessions: [
      sess('local_x', '旧的', 'C:\\c', 50, { env: 'e3' }),
      sess('local_y', '归档了', 'C:\\c', 999, { env: 'e3', archived: true }),
      sess('local_z', '随便问问', 'C:\\Users\\u\\AppData\\Local\\Claude-Data\\x\\scratch-workspaces\\a\\b\\scratch-1', 80),
      sess('local_w', '没有目录', '', 10),
    ],
  });
  assert.deepEqual(
    groups.map((g) => [g.name, g.sessions.map((s) => s.id)]),
    [
      ['无文件夹', ['local_z', 'local_w']],
      ['有会话', ['local_x']],
      ['空环境B', []],
      ['空环境A', []],
    ]
  );
  assert.equal(groups[0].env, null, '无文件夹组不能新建');
});

test('记着的环境已删除时，按目录找；同一目录几个环境时归到最近用过的', () => {
  const groups = buildGroups({
    presets: [env('old', '旧名字', 'E:\\Golf', 1), env('new', '新名字', 'E:\\Golf', 2)],
    sessions: [sess('local_a', 't', 'E:\\Golf', 1, { env: 'deleted-env' })],
  });
  assert.equal(groups.find((g) => g.sessions.length).env, 'new');
});

test('folderKey 统一斜杠、大小写和结尾分隔符', () => {
  assert.equal(folderKey('E:/SVNProjects/Golf/'), 'e:\\svnprojects\\golf');
  assert.equal(folderKey('E:\\SVNProjects\\Golf'), 'e:\\svnprojects\\golf');
});

test('从数据目录读出环境、会话和已开的窗口；坏文件跳过', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-cat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'Claude-Data', 'claude_test');
  const acct = 'acct-1';
  const org = path.join(data, 'claude-code-sessions', acct, 'org-1');
  fs.mkdirSync(org, { recursive: true });
  fs.writeFileSync(
    path.join(data, 'ccd-session-presets.json'),
    JSON.stringify({ byAccount: { [acct]: { presets: [{ id: 'e1', name: 'Env', target: { kind: 'local', cwd: 'C:\\p' }, lastUsedAt: 3 }] } } })
  );
  fs.writeFileSync(path.join(data, 'session-popouts.json'), JSON.stringify({ version: 1, accountUuid: acct, popouts: [{ sessionId: 'local_1', title: 'One' }] }));
  fs.writeFileSync(
    path.join(org, 'local_1.json'),
    JSON.stringify({ sessionId: 'local_1', title: 'One', cwd: 'C:\\p\\wt', originCwd: 'C:\\p', startedFromEnvironmentId: 'e1', lastActivityAt: 10, isArchived: false })
  );
  fs.writeFileSync(path.join(org, 'local_2.json'), '{ 坏文件');
  fs.writeFileSync(path.join(org, 'local_3.json'), JSON.stringify({ sessionId: 'local_other', title: '文件名和内容对不上' }));
  fs.writeFileSync(path.join(org, 'deleted_x'), 'x');

  assert.equal(findDataDir({ LOCALAPPDATA: root }), data);
  assert.equal(findDataDir({ LOCALAPPDATA: path.join(root, 'nope') }), null);
  const r = loadRecords(data);
  assert.equal(r.account, acct);
  assert.deepEqual(r.presets, [{ id: 'e1', name: 'Env', folder: 'C:\\p', kind: 'local', lastUsedAt: 3 }]);
  assert.deepEqual(r.sessions, [{ id: 'local_1', cli: '', title: 'One', folder: 'C:\\p', env: 'e1', archived: false, at: 10 }]);
  assert.deepEqual(r.popouts, [{ sessionId: 'local_1', title: 'One' }]);
  assert.deepEqual(loadRecords(null).sessions, []);
});
