'use strict';
/**
 * 把 Claude Code 的审批和提问转给手机（说明见 docs/09-approvals.md）。
 *
 * RemoteClaude 插件的审批钩子把等待中的审批写成审批目录里的 <id>.pending.json（每 2 秒更新修改时间当心跳），
 * 这里每秒扫一遍，把还活着、还没结果的整理成列表交给页面推给手机；手机作答后写 <id>.done.json
 * （硬链接发布，已有结果就失败，所以电脑上、手机上谁先答算谁）。
 * 同时每 5 秒写一次 host.json，钩子据此判断被控端在不在运行，不在就不等手机。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SCAN_MS = 1000;
const HEARTBEAT_MS = 5000;
/** pending 超过这么久没更新心跳，就当钩子已经不在了 */
const STALE_MS = 15000;
/** 结果文件、残留文件保留几天 */
const KEEP_DAYS = 7;
const SAFE_ID = /^[a-f0-9]{16}$/;
const MAX_TEXT = 1000;
const MAX_ANSWER = 2000;

function defaultDir() {
  if (process.env.RC_APPROVALS_DIR) return process.env.RC_APPROVALS_DIR;
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'RemoteClaude', 'approvals');
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 100000) => (typeof v === 'string' ? v.slice(0, max) : '');

/** 发给手机的一条审批（只留手机要显示的字段） */
function toItem(req, title) {
  return {
    id: req.id,
    kind: req.kind === 'ask' ? 'ask' : 'permission',
    title: title || str(req.title, 200) || path.basename(str(req.cwd)) || 'Claude Code',
    cwd: str(req.cwd, 500),
    agent: str(req.agent, 60),
    tool: str(req.tool, 200),
    description: str(req.description, 2000),
    params: Array.isArray(req.params)
      ? req.params.filter(isObj).map((p) => ({ key: str(p.key, 100), value: str(p.value, 8000) }))
      : [],
    complete: req.complete !== false,
    questions: Array.isArray(req.questions)
      ? req.questions.filter(isObj).map((q) => ({
          question: str(q.question, 2000),
          header: str(q.header, 100),
          multiSelect: q.multiSelect === true,
          options: Array.isArray(q.options)
            ? q.options.filter(isObj).map((o) => ({ label: str(o.label, 500), description: str(o.description, 1000) }))
            : [],
        }))
      : [],
    createdAt: Number(req.createdAt) || 0,
  };
}

/**
 * 检查手机的答案；对的话返回要写进 done 的内容，不对返回 null。
 * 提问要每个问题都答：单选是一个选项、多选是选项数组，也可以是自己填的文字。
 */
function checkAnswer(item, ans) {
  if (!isObj(ans) || (ans.choice !== 'allow' && ans.choice !== 'deny')) return null;
  const text = typeof ans.text === 'string' ? ans.text.slice(0, MAX_TEXT) : '';
  if (ans.choice === 'deny' || item.kind === 'permission') return { kind: 'answer', choice: ans.choice, text, via: 'app' };
  if (!isObj(ans.answers)) return null;
  const answers = {};
  for (const q of item.questions) {
    const a = ans.answers[q.question];
    if (typeof a === 'string' && a.trim()) answers[q.question] = a.slice(0, MAX_ANSWER);
    else if (q.multiSelect && Array.isArray(a) && a.length && a.every((x) => typeof x === 'string' && x)) {
      answers[q.question] = a.slice(0, 50).map((x) => x.slice(0, MAX_ANSWER));
    } else return null;
  }
  return { kind: 'answer', choice: 'allow', text: '', answers, via: 'app' };
}

/**
 * @param {object} opts
 * @param {(msg: string) => void} opts.log
 * @param {string} [opts.dir] 审批目录
 * @param {(sessionId: string) => string} [opts.titleFor] Claude Code 会话编号 -> 桌面端的会话标题
 */
function createApprovals({ log, dir = defaultDir(), titleFor = () => '' }) {
  const listeners = new Set();
  const cache = new Map(); // id -> { req, title }
  /** 被控端自己发的提醒（比如 Claude 升级后自检没通过）：key -> 一条只有"知道了"的提问，手机上点了就收起 */
  const notices = new Map();
  /** 提醒被手机答了以后要做的事：提醒的 id -> (选了哪个选项) => void */
  const noticeAnswers = new Map();
  /** 插件正挂着的审批和提问（不含提醒）：{ id, sessionId, tool, createdAt } */
  let liveReqs = [];
  let items = [];
  let signature = '[]';
  let timers = [];

  function heartbeat() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'host.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch (err) {
      log('写审批心跳失败: ' + err.message);
    }
  }

  function readReq(id, file) {
    const hit = cache.get(id);
    if (hit) return hit;
    try {
      const req = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isObj(req) || req.id !== id) return null;
      let title = '';
      try {
        title = titleFor(str(req.sessionId));
      } catch {}
      const entry = { req, title };
      cache.set(id, entry);
      return entry;
    } catch {
      return null; // 可能正在写，下一轮再读
    }
  }

  function scan() {
    const now = Date.now();
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    const done = new Set(names.filter((n) => n.endsWith('.done.json')).map((n) => n.slice(0, -10)));
    const live = [];
    const reqs = [];
    for (const n of names) {
      if (!n.endsWith('.pending.json')) continue;
      const id = n.slice(0, -13);
      if (!SAFE_ID.test(id) || done.has(id)) continue;
      const file = path.join(dir, n);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime > STALE_MS) continue;
      const entry = readReq(id, file);
      if (!entry) continue;
      // 插件 1.0.9 的"调用卡住"提醒（stalled.js）：改由被控端自己看桌面端日志来提醒（dialogwatch.js），
      // 还开着的旧会话写出来的不再转给手机，免得重复
      if (entry.req.notice === true) continue;
      live.push(toItem(entry.req, entry.title));
      reqs.push({ id, sessionId: str(entry.req.sessionId, 200), tool: str(entry.req.tool, 200), createdAt: Number(entry.req.createdAt) || 0 });
    }
    liveReqs = reqs;
    for (const n of notices.values()) live.push(n);
    live.sort((a, b) => a.createdAt - b.createdAt);
    for (const id of cache.keys()) if (!live.some((x) => x.id === id)) cache.delete(id);
    const sig = JSON.stringify(live.map((x) => x.id));
    if (sig === signature) return;
    signature = sig;
    items = live;
    for (const cb of listeners) {
      try {
        cb(items);
      } catch {}
    }
  }

  function cleanup() {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === 'host.json' || n === 'hooks.log') continue;
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {}
    }
  }

  return {
    dir,
    start() {
      heartbeat();
      cleanup();
      scan();
      timers = [setInterval(heartbeat, HEARTBEAT_MS), setInterval(scan, SCAN_MS), setInterval(cleanup, 3600000)];
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
      // 退出时删掉心跳，钩子马上就知道不用再等手机
      try {
        fs.unlinkSync(path.join(dir, 'host.json'));
      } catch {}
    },
    get list() {
      return items;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /** 插件正挂在手机上的审批和提问（不含提醒）：{ id, sessionId, tool, createdAt } */
    pending() {
      return liveReqs;
    },
    /** 马上扫一遍审批目录（平时每秒自动扫；没调 start() 的排查脚本用它） */
    refresh() {
      scan();
    },
    /**
     * 给手机发一条提醒（和提问走同一条路，手机上有通知）。同一个 key 再发就换掉上一条。
     * @param {string} key
     * @param {object} n
     * @param {string} n.title
     * @param {string} n.text
     * @param {string} [n.header]
     * @param {string} [n.tool]
     * @param {{ label: string, description?: string }[]} [n.options] 不给就只有"知道了"
     * @param {(label: string) => void} [n.onAnswer] 手机上选了哪个选项（拒绝、没选是空串）；选什么提醒都会收起
     */
    notify(key, n) {
      const old = notices.get(String(key));
      if (old) noticeAnswers.delete(old.id);
      const id = crypto.randomBytes(8).toString('hex');
      const options = Array.isArray(n.options) && n.options.length
        ? n.options.filter(isObj).map((o) => ({ label: str(o.label, 500), description: str(o.description, 1000) }))
        : [{ label: '知道了', description: '收起这条提醒' }];
      if (typeof n.onAnswer === 'function') noticeAnswers.set(id, n.onAnswer);
      notices.set(String(key), {
        id,
        kind: 'ask',
        title: str(n.title, 200) || 'RemoteClaude',
        cwd: '',
        agent: '',
        tool: str(n.tool, 200) || '提醒',
        description: '',
        params: [],
        complete: true,
        questions: [
          {
            question: str(n.text, 2000),
            header: str(n.header, 100) || '提醒',
            multiSelect: false,
            options,
          },
        ],
        createdAt: Date.now(),
      });
      scan();
    },
    clearNotice(key) {
      const old = notices.get(String(key));
      if (!old) return;
      noticeAnswers.delete(old.id);
      notices.delete(String(key));
      scan();
    },
    /** 手机作答：{ ok } 或 { ok: false, code: 'gone' | 'bad' } */
    answer(id, ans) {
      scan();
      const item = items.find((x) => x.id === id);
      if (!item) return { ok: false, code: 'gone' };
      // 被控端自己的提醒：不管选了什么都收起；发提醒的一方想知道选了哪个，就告诉它
      for (const [key, n] of notices) {
        if (n.id !== id) continue;
        notices.delete(key);
        const picked = isObj(ans) && ans.choice === 'allow' && isObj(ans.answers) ? ans.answers[n.questions[0].question] : '';
        const label = typeof picked === 'string' ? picked : '';
        log(`手机收起了提醒「${n.title}」${label ? `（${label.slice(0, 40)}）` : ''}`);
        const cb = noticeAnswers.get(id);
        noticeAnswers.delete(id);
        if (cb) {
          try {
            cb(label);
          } catch (err) {
            log('处理提醒的回答出错: ' + err.message);
          }
        }
        scan();
        return { ok: true };
      }
      const outcome = checkAnswer(item, ans);
      if (!outcome) return { ok: false, code: 'bad' };
      const final = path.join(dir, `${id}.done.json`);
      const tmp = `${final}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ ...outcome, at: Date.now() }));
        fs.linkSync(tmp, final); // 已经有结果（电脑上答了、别的手机先答了）就失败
      } catch (err) {
        if (err.code === 'EEXIST') return { ok: false, code: 'gone' };
        log('写审批结果失败: ' + err.message);
        return { ok: false, code: 'failed' };
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {}
      }
      log(`手机${outcome.choice === 'allow' ? (item.kind === 'ask' ? '回答了' : '允许了') : '拒绝了'}「${item.title}」的${item.kind === 'ask' ? '提问' : item.tool}`);
      scan();
      return { ok: true };
    },
  };
}

module.exports = { createApprovals, checkAnswer, toItem, defaultDir };
