'use strict';
/**
 * RemoteClaude 插件的公共部分（说明见仓库 docs/09-approvals.md）：
 *   - 审批目录和文件交接：pending 由钩子写、done 由先作答的一方写（硬链接发布，只有第一个生效）
 *   - 被控端心跳：被控端没在运行时钩子什么都不做
 *   - 读钩子输入、读会话记录（会话标题、某次工具调用有没有结果、"下一步"框之后会话走到哪了、从头逐行读）
 * 钩子绝不能因为这里出错而挡住 Claude Code，调用方都要兜住异常。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR =
  process.env.RC_APPROVALS_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'RemoteClaude', 'approvals');
/** 被控端每 5 秒写一次 host.json，超过这么久没更新就当它没在运行 */
const HOST_ALIVE_MS = 20000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TAIL_BYTES = 2 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asObj = (v) => (isObj(v) ? v : {});

/** 审批目录存在 = 被控端在这台电脑上跑过、这个功能装好了 */
function installed() {
  try {
    return fs.statSync(DIR).isDirectory();
  } catch {
    return false;
  }
}

function hostAlive(now = Date.now()) {
  try {
    return now - fs.statSync(path.join(DIR, 'host.json')).mtimeMs < HOST_ALIVE_MS;
  } catch {
    return false;
  }
}

/** 只在功能装好时记日志，不在用户电脑上凭空建目录 */
function log(msg) {
  if (!installed()) return;
  try {
    fs.appendFileSync(path.join(DIR, 'hooks.log'), `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {}
}

function readPayload() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    const data = raw ? JSON.parse(raw) : {};
    return isObj(data) ? data : {};
  } catch {
    return {};
  }
}

/** 往 stdout 写一行 JSON；非 ASCII 字符转义，免得控制台编码出问题 */
function writeJson(obj) {
  const text = JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  process.stdout.write(text);
}

const newId = () => crypto.randomBytes(8).toString('hex');
const safeId = (id) => typeof id === 'string' && SAFE_ID.test(id);
const file = (name) => path.join(DIR, name);

function readJson(p) {
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return isObj(data) ? data : null;
  } catch {
    return null;
  }
}

/** 先写临时文件再改名；Windows 上别的进程正读着时改名会失败，重试一会儿 */
function writeJsonAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(tmp, p);
      return;
    } catch (err) {
      if (i >= 20 || (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'EBUSY')) {
        try {
          fs.unlinkSync(tmp);
        } catch {}
        throw err;
      }
      const until = Date.now() + 10 * i;
      while (Date.now() < until) {} // 同步等一小会儿
    }
  }
}

/**
 * 发布结果，已有结果就不覆盖；返回这次是否生效。
 * 用硬链接：目标已存在时一定失败，所以只有第一个写的生效，而且一出现就是完整的。
 */
function finish(id, outcome) {
  if (!safeId(id)) throw new Error('bad id');
  const final = file(`${id}.done.json`);
  const tmp = `${final}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ ...outcome, at: Date.now() }));
  try {
    fs.linkSync(tmp, final);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// ---------------------------------------------------------------- 会话记录

/** 文件末尾一段里的完整记录行 */
function readTail(p, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // 第一行可能被截断
    const out = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (isObj(e)) out.push(e);
      } catch {}
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** 从头逐行读一个文件，不整个读进内存（会话记录能有几十 MB，单行能上 MB）；读不了就抛异常 */
function eachLine(p, fn) {
  const fd = fs.openSync(p, 'r');
  try {
    const chunk = Buffer.alloc(1 << 20);
    let parts = []; // 跨块的那一行已经读到的部分
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) break;
      const view = chunk.subarray(0, n);
      let start = 0;
      for (let nl = view.indexOf(10); nl >= 0; nl = view.indexOf(10, start)) {
        const piece = view.subarray(start, nl);
        fn(parts.length ? Buffer.concat([...parts, piece]).toString('utf8') : piece.toString('utf8'));
        parts = [];
        start = nl + 1;
      }
      if (start < n) parts.push(Buffer.from(view.subarray(start)));
    }
    if (parts.length) fn(Buffer.concat(parts).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/** 会话标题：自定义标题、子代理名、最后一句提问，都没有就空串（被控端会再用桌面端的标题） */
function sessionTitle(transcriptPath) {
  if (!transcriptPath) return '';
  const side = path.join(transcriptPath.replace(/\.jsonl$/i, ''), 'custom-title.json');
  const custom = readJson(side);
  if (custom && custom.customTitle) return String(custom.customTitle);
  const entries = readTail(transcriptPath, 512 * 1024);
  for (const [type, field] of [
    ['custom-title', 'customTitle'],
    ['agent-name', 'agentName'],
    ['last-prompt', 'lastPrompt'],
  ]) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === type && entries[i][field]) return String(entries[i][field]);
    }
  }
  return '';
}

/** 增量读一个会话记录文件：第一次从末尾一段读起，之后只读新增的完整行；读不了就抛异常，由调用方兜住 */
class TailReader {
  constructor(p) {
    this.path = p;
    this.offset = -1;
    this.rest = '';
  }

  read() {
    const size = fs.statSync(this.path).size;
    const start = this.offset < 0 ? Math.max(0, size - TAIL_BYTES) : this.offset;
    if (size < start) return []; // 文件被截短了，不管
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(this.path, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const lines = (this.rest + buf.toString('utf8')).split('\n');
    this.offset = size;
    this.rest = lines.pop();
    const out = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (isObj(e)) out.push(e);
      } catch {}
    }
    return out;
  }
}

/** 参数比较用的形式：路径只比文件名（Claude Code 会把相对路径改成绝对、/ 改成 \），提问只比问题原文 */
const PATH_KEYS = new Set(['file_path', 'path', 'notebook_path']);
function normalized(input) {
  const out = {};
  for (const [k, v] of Object.entries(asObj(input))) {
    if (PATH_KEYS.has(k) && typeof v === 'string') out[k] = v.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop().toLowerCase();
    else if (k === 'questions' && Array.isArray(v)) out[k] = JSON.stringify(v.map((q) => asObj(q).question));
    else out[k] = stableJson(v);
  }
  return out;
}

function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * 看出这次审批的工具调用是不是已经在别处答了（照搬飞书插件的做法）。
 * 钩子输入里没有调用编号，所以看会话记录（含子代理的记录）里所有同名、参数一致的调用：
 * 开始后 FREEZE_MS 内看到的、还没有结果的是候选（这次的调用在钩子启动前约 0.1 秒写入），之后冻结；
 * 候选都有了结果，就说明用户在电脑上点了（或被打断了）。
 */
class ToolUseWatch {
  constructor(transcriptPath, toolName, toolInput, startedAt, freezeMs = 2000) {
    this.transcriptPath = transcriptPath || '';
    this.toolName = toolName;
    this.input = normalized(toolInput);
    this.startedAt = startedAt;
    this.freezeMs = freezeMs;
    this.files = new Map(); // 路径 -> TailReader
    this.candidates = new Set();
    this.ignored = new Set();
    this.results = new Set();
  }

  paths() {
    if (!this.transcriptPath) return [];
    const out = [this.transcriptPath];
    const sub = path.join(this.transcriptPath.replace(/\.jsonl$/i, ''), 'subagents');
    const walk = (d) => {
      let names = [];
      try {
        names = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const n of names) {
        const p = path.join(d, n.name);
        if (n.isDirectory()) walk(p);
        else if (n.name.endsWith('.jsonl')) out.push(p);
      }
    };
    walk(sub);
    return out;
  }

  sameCall(input) {
    if (!isObj(input)) return false;
    const theirs = normalized(input);
    return Object.keys(theirs).every((k) => k in this.input && this.input[k] === theirs[k]);
  }

  newEntries(p) {
    let reader = this.files.get(p);
    if (!reader) this.files.set(p, (reader = new TailReader(p)));
    return reader.read();
  }

  frozen(now) {
    return now - this.startedAt >= this.freezeMs;
  }

  ingest(entries, now) {
    const calls = [];
    for (const e of entries) {
      const content = asObj(e.message).content;
      for (const b of Array.isArray(content) ? content : []) {
        const block = asObj(b);
        if (block.type === 'tool_use' && block.name === this.toolName && block.id && this.sameCall(block.input)) calls.push(String(block.id));
        else if (block.type === 'tool_result') this.results.add(String(block.tool_use_id));
      }
    }
    if (this.frozen(now)) return;
    for (const id of calls) {
      if (this.ignored.has(id) || this.candidates.has(id)) continue;
      if (this.results.has(id)) this.ignored.add(id);
      else this.candidates.add(id);
    }
  }

  /** 这次的工具调用已经有了结果 */
  resolved(now = Date.now()) {
    try {
      for (const p of this.paths()) {
        if (fs.existsSync(p)) this.ingest(this.newEntries(p), now);
      }
    } catch (err) {
      log(`读会话记录失败，稍后再试: ${err.message}`);
      return false;
    }
    if (!this.frozen(now) || !this.candidates.size) return false;
    for (const id of this.candidates) if (!this.results.has(id)) return false;
    return true;
  }
}

/**
 * 一次工具调用之后，会话走到哪了（nextstep.js 用来盯"下一步"框）。顺着会话记录往后读：
 *   - 先认出这次的调用（isMine 说了算；同样的调用再出现就以后一次为准）
 *   - 之后出现 stop_reason 不是 tool_use 的助手消息，或 Stop 钩子的摘要：这一轮结束了（ended）
 *   - 之后出现用户输入（不是工具结果、不是附带信息）、又一次同名调用，或结束后又有新的助手消息：
 *     会话已经接着往下走了（superseded）
 * 助手的一条消息在记录里按内容块拆成几行，message.id 相同。
 * 钩子叫醒会话的消息在记录里也是一条用户输入（内容是字符串），所以 turnInput 能看出这一轮是不是被叫醒的。
 */
class TurnWatch {
  /** @param {(block: object, entry: object) => boolean} isMine */
  constructor(transcriptPath, toolName, isMine) {
    this.reader = transcriptPath ? new TailReader(transcriptPath) : null;
    this.toolName = toolName;
    this.isMine = isMine;
    this.found = false;
    this.status = 'waiting';
    this.endId = '';
    this.warned = false;
    this.lastInput = '';
    /** 这次调用所在的这一轮是由什么输入开始的（用户的话，或叫醒会话的钩子消息） */
    this.turnInput = '';
  }

  ingest(e) {
    if (e.isSidechain === true) return;
    const message = asObj(e.message);
    const blocks = Array.isArray(message.content) ? message.content.map(asObj) : [];
    if (e.type === 'assistant') {
      const calls = blocks.filter((b) => b.type === 'tool_use' && b.name === this.toolName);
      if (calls.some((b) => this.isMine(b, e))) {
        this.found = true;
        this.status = 'waiting';
        this.endId = '';
        this.turnInput = this.lastInput;
      } else if (!this.found) {
        return;
      } else if (calls.length) {
        this.status = 'superseded';
      } else if (this.status === 'ended') {
        if (!this.endId || String(message.id || '') !== this.endId) this.status = 'superseded';
      } else if (this.status === 'waiting' && message.stop_reason && message.stop_reason !== 'tool_use' && message.stop_reason !== 'pause_turn') {
        this.status = 'ended';
        this.endId = String(message.id || '');
      }
    } else if (e.type === 'user') {
      if (e.isMeta === true) return; // 附带信息，不是输入
      const typed = typeof message.content === 'string' && message.content.trim() !== '';
      const blocksIn = blocks.length > 0 && !blocks.some((b) => b.type === 'tool_result');
      if (!typed && !blocksIn) return;
      this.lastInput = typed ? message.content : blocks.map((b) => (b.type === 'text' ? String(b.text || '') : '')).join('\n');
      if (this.found) this.status = 'superseded';
    } else if (this.found && e.type === 'system' && e.subtype === 'stop_hook_summary' && this.status === 'waiting') {
      this.status = 'ended';
    }
  }

  /** 'waiting'（这一轮还没完，或还没认出这次调用）、'ended'、'superseded' */
  state() {
    if (!this.reader) return this.status;
    try {
      for (const e of this.reader.read()) this.ingest(e);
    } catch (err) {
      if (!this.warned) log(`读会话记录失败，稍后再试: ${err.message}`);
      this.warned = true;
    }
    return this.status;
  }
}

module.exports = {
  DIR,
  installed,
  hostAlive,
  log,
  readPayload,
  writeJson,
  newId,
  safeId,
  file,
  readJson,
  writeJsonAtomic,
  finish,
  processAlive,
  sleep,
  asObj,
  isObj,
  readTail,
  eachLine,
  sessionTitle,
  ToolUseWatch,
  TurnWatch,
};
