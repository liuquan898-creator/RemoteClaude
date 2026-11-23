'use strict';
/**
 * Claude 桌面端的环境和会话目录（协议文档 2.5，说明见 docs/07-claude-sessions.md）。
 *
 * 读的是 Claude 桌面端自己的本地记录，不是公开接口，Claude 升级后格式可能变：
 *   - 数据目录：%LOCALAPPDATA%\Claude-Data\claude_<包名>（商店版），或 %APPDATA%\Claude（安装包版）
 *   - ccd-session-presets.json：保存的环境（名字、工作目录）
 *   - claude-code-sessions\<账号>\<组织>\local_*.json：每个会话一个文件（标题、目录、所属环境、最后活动时间、是否归档）
 *   - session-popouts.json：哪些会话开成了单独窗口
 * 读不到或格式不对时当作没有，不抛错。
 */
const fs = require('fs');
const path = require('path');

/** 一次最多发给控制端的会话数，免得消息太大 */
const MAX_SESSIONS = 400;
const MAX_TITLE = 200;

/** 可能的数据目录，只留下里面有会话记录的 */
function candidateDataDirs(env = process.env) {
  const dirs = [];
  if (env.LOCALAPPDATA) {
    const base = path.join(env.LOCALAPPDATA, 'Claude-Data');
    let names = [];
    try {
      names = fs.readdirSync(base);
    } catch {}
    for (const n of names) if (n.startsWith('claude_')) dirs.push(path.join(base, n));
  }
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'Claude'));
  return dirs.filter((d) => isDir(path.join(d, 'claude-code-sessions')));
}

/** 找 Claude 桌面端的数据目录；有几个时取最近用过的那个，找不到返回 null */
function findDataDir(env = process.env) {
  let best = null;
  let bestAt = -1;
  for (const d of candidateDataDirs(env)) {
    const at = Math.max(mtime(path.join(d, 'session-popouts.json')), mtime(path.join(d, 'claude-code-sessions')));
    if (at > bestAt) {
      best = d;
      bestAt = at;
    }
  }
  return best;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}

/** 按修改时间缓存解析结果：会话文件有一百多个，每次都重新解析太慢 */
const jsonCache = new Map(); // file -> { mtimeMs, size, data }

function readJson(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    jsonCache.delete(file);
    return null;
  }
  const hit = jsonCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  jsonCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (Number.isFinite(v) ? v : 0);

/** 读出原始记录：{ account, presets, sessions, popouts }；数据目录不对时各项为空 */
function loadRecords(dataDir) {
  const out = { account: '', presets: [], sessions: [], popouts: [] };
  if (!dataDir) return out;
  const sessRoot = path.join(dataDir, 'claude-code-sessions');
  const pop = readJson(path.join(dataDir, 'session-popouts.json'));
  let accounts = [];
  try {
    accounts = fs.readdirSync(sessRoot).filter((n) => isDir(path.join(sessRoot, n)));
  } catch {}
  // 当前登录的账号：窗口记录里写着；没有时取最近有变动的那个
  let account = pop && accounts.includes(str(pop.accountUuid)) ? str(pop.accountUuid) : '';
  if (!account) {
    account = accounts.map((a) => [a, mtime(path.join(sessRoot, a))]).sort((x, y) => y[1] - x[1])[0]?.[0] || '';
  }
  if (!account) return out;
  out.account = account;

  if (pop && str(pop.accountUuid) === account && Array.isArray(pop.popouts)) {
    out.popouts = pop.popouts
      .filter((p) => p && str(p.sessionId))
      .map((p) => ({ sessionId: str(p.sessionId), title: str(p.title) }));
  }

  const presetsFile = readJson(path.join(dataDir, 'ccd-session-presets.json'));
  const mine = presetsFile && presetsFile.byAccount && presetsFile.byAccount[account];
  if (mine && Array.isArray(mine.presets)) {
    out.presets = mine.presets
      .filter((p) => p && str(p.id) && str(p.name))
      .map((p) => ({
        id: str(p.id),
        name: str(p.name),
        folder: str(p.target && p.target.cwd),
        kind: str(p.target && p.target.kind),
        lastUsedAt: num(p.lastUsedAt),
      }));
  }

  const acctDir = path.join(sessRoot, account);
  let orgs = [];
  try {
    orgs = fs.readdirSync(acctDir).filter((n) => isDir(path.join(acctDir, n)));
  } catch {}
  for (const org of orgs) {
    const dir = path.join(acctDir, org);
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {}
    for (const f of files) {
      if (!/^local_[A-Za-z0-9-]+\.json$/.test(f)) continue;
      const j = readJson(path.join(dir, f));
      if (!j || typeof j !== 'object' || str(j.sessionId) !== f.slice(0, -5)) continue;
      out.sessions.push({
        id: str(j.sessionId),
        // Claude Code 自己的会话编号（钩子收到的 session_id），审批要靠它找到桌面端的会话标题
        cli: str(j.cliSessionId),
        title: str(j.title).slice(0, MAX_TITLE),
        folder: str(j.originCwd) || str(j.cwd),
        env: str(j.startedFromEnvironmentId),
        archived: j.isArchived === true,
        at: num(j.lastActivityAt) || num(j.createdAt),
      });
    }
  }
  return out;
}

/** 比较目录用：去掉结尾的斜杠，不分大小写（Windows 的路径不分大小写） */
function folderKey(p) {
  return str(p).replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

function baseName(p) {
  const parts = str(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : str(p);
}

/** Claude 给"无文件夹"会话建的临时目录 */
const isScratch = (folder) => /[\\/]scratch-workspaces[\\/]/i.test(folder);

/**
 * 把会话按环境分组，给控制端显示。规则：
 *   1. 会话记着从哪个环境开的，就归到那个环境；
 *   2. 没记（或那个环境已删）的，工作目录和某个环境相同就归到它；
 *   3. 都不是的按工作目录分组（不能在这组里新建），Claude 的临时目录归到"无文件夹"。
 * 已归档的会话不列。组按最近活动排，没有会话的环境排在最后；组内按最近活动排。
 *
 * @returns {{ key: string, name: string, folder: string, env: string|null, sessions: {id,title,at,open}[] }[]}
 */
function buildGroups({ presets = [], sessions = [], popouts = [] }) {
  const open = new Set(popouts.map((p) => p.sessionId));
  const envById = new Map(presets.map((p) => [p.id, p]));
  // 同一个目录有几个环境时，归到最近用过的那个
  const envByFolder = new Map();
  for (const p of [...presets].sort((a, b) => b.lastUsedAt - a.lastUsedAt)) {
    const k = folderKey(p.folder);
    if (k && !envByFolder.has(k)) envByFolder.set(k, p);
  }

  const groups = new Map();
  for (const p of presets) {
    groups.set('env:' + p.id, { key: 'env:' + p.id, name: p.name, folder: p.folder, env: p.id, sessions: [], usedAt: p.lastUsedAt });
  }
  const live = sessions.filter((s) => !s.archived).sort((a, b) => b.at - a.at).slice(0, MAX_SESSIONS);
  for (const s of live) {
    let key = envById.has(s.env) ? 'env:' + s.env : '';
    if (!key && envByFolder.has(folderKey(s.folder))) key = 'env:' + envByFolder.get(folderKey(s.folder)).id;
    if (!key) {
      if (!s.folder || isScratch(s.folder)) {
        key = 'scratch';
        if (!groups.has(key)) groups.set(key, { key, name: '无文件夹', folder: '', env: null, sessions: [], usedAt: 0 });
      } else {
        key = 'dir:' + folderKey(s.folder);
        if (!groups.has(key)) groups.set(key, { key, name: baseName(s.folder), folder: s.folder, env: null, sessions: [], usedAt: 0 });
      }
    }
    groups.get(key).sessions.push({ id: s.id, title: s.title, at: s.at, open: open.has(s.id) });
  }

  const latest = (g) => (g.sessions.length ? g.sessions[0].at : 0);
  return [...groups.values()]
    .sort((a, b) => {
      const la = latest(a);
      const lb = latest(b);
      if (!la !== !lb) return la ? -1 : 1;
      return la || lb ? lb - la : b.usedAt - a.usedAt;
    })
    .map(({ usedAt, ...g }) => g);
}

module.exports = { findDataDir, loadRecords, buildGroups, folderKey, MAX_SESSIONS };
