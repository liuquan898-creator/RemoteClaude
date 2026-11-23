'use strict';
/**
 * Claude 桌面端自己弹的确认框，提醒到手机（说明见 docs/09-approvals.md 第 4 节）。
 *
 * 有些确认框不是 Claude Code 的工具审批，是桌面端自己画的，典型的是自带浏览器的
 * "允许 Claude 在 xxx 上执行 JavaScript？"。插件的审批钩子收不到它，手机上没有通知，Claude 就一直等着。
 * 桌面端每弹一个框，都在自己的日志（%LOCALAPPDATA%\Claude\logs\main.log）里记一行：
 *     Emitted tool permission request <编号> for <工具> in session local_<会话>
 * 用户点了、框被撤回，也各有一行：
 *     Received permission response for <编号>: once (tool: <工具>)
 *     Permission request <编号> for <工具> aborted
 * 这里每秒读日志新增的部分：框出现几秒后还在，插件也没有把它当审批推到手机，就给手机发一条提醒
 * （走审批那条路，手机上有通知）。框有了结果、会话进程不在了：收回提醒。
 *
 * 浏览器的框可以在手机上直接答（被控端 0.9.13 起）：提醒带"允许一次""拒绝"两个选项，选了就由被控端
 * 用界面自动化去按电脑上那个框的按钮（sessions.answerDialog），按完看日志里这个框有没有结果：
 * 两秒没有就再按一次（第一次按常常只是把焦点移到按钮上），还没有就再提醒一次并说明没按成。
 * 别的框只提醒，要点开这个会话的画面去点。
 *
 * 普通的工具审批和提问（PowerShell、AskUserQuestion……）桌面端也会记这一行，那些由插件推到手机，
 * 这里看到同一个会话有插件的审批挂着就不重复提醒；插件没管的（会话没加载插件等），等久一点也提醒。
 * 插件推到过手机的框，手机上那条没了以后不再提醒：提醒里说的是"手机上没有收到对应的审批"，对它不成立。
 *
 * 定时任务的框没人答，桌面端等大约 49 分钟就自己按拒绝处理，日志里只有按会话记的一行，没有上面那两种：
 *     [CCD] Session local_<会话>: denied 1 permission prompt(s) unanswered for 2922s on a scheduled-task run
 * 看到它，这个会话的框都算结束了。
 *
 * 这靠的是桌面端日志的写法，Claude 升级后可能变。自己验证的办法：插件每推一条审批，日志里都应该有对应的一行，
 * 连着几条都对不上，就说明日志的写法或位置变了，记日志并提醒手机一次。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const TICK_MS = 1000;
/** 浏览器的确认框：出现这么久还在就提醒（插件管不到这种框，不用等它） */
const GRACE_MS = 3000;
/** 其它工具的确认框：插件的审批钩子比桌面端的框晚两三秒才把审批推出来，等久一点再判断它是不是没管 */
const GRACE_OTHER_MS = 10000;
const SNOOZE_MS = 5 * 60 * 1000;
/** 一个框最多盯这么久 */
const MAX_AGE_MS = 24 * 3600 * 1000;
/** 启动时往回读这么多日志，找出已经在等的框 */
const TAIL_BYTES = 2 * 1024 * 1024;
/** 日志的时间只到秒，和进程启动时间比较时留的余量 */
const SLACK_MS = 2000;
/** 插件的审批连着这么多条在日志里对不上，就认为日志的写法变了 */
const CANARY_MISSES = 5;
/** 审批出现这么久之后再去日志里对（桌面端的那一行比钩子早，留余量只是保险） */
const CANARY_SETTLE_MS = 5000;
/** 审批和日志里那一行的时间最多差这么多 */
const CANARY_WINDOW_MS = 60000;
/** 插件的审批是不是这个框的：审批比框早不超过、晚不超过这么多（钩子比桌面端的框晚几秒，日志的时间只到秒） */
const COVER_BEFORE_MS = 3000;
const COVER_AFTER_MS = 60000;

const OK_LABEL = '知道了';
const SNOOZE_LABEL = '过 5 分钟再提醒';
const ALLOW_LABEL = '允许一次';
const DENY_LABEL = '拒绝';
const ALWAYS_LABEL = '始终允许';
/** 替用户按了按钮以后，等桌面端的日志里出现这个框的结果：这么久还没有就再按一次（最多按 PRESS_TRIES 次） */
const PRESS_RETRY_MS = 2000;
const PRESS_TRIES = 2;
/** 最后一次按下去以后，等这么久日志里还没有结果就算没按成 */
const PRESS_CONFIRM_MS = 6000;
/** 去按按钮（可能要先把会话窗口开出来）最多等这么久 */
const PRESS_TIMEOUT_MS = 90000;
/** 提醒之前去窗口里读框上的网址，最多等这么久 */
const INSPECT_TIMEOUT_MS = 6000;

// ---------------------------------------------------------------- 读日志

/**
 * 增量读一个会被轮换的日志文件：第一次从末尾一段读起，之后只读新增的完整行。
 * 日志满了桌面端会把 main.log 改名成 main1.log 再新建一个：这时把旧文件剩下的读完，再从头读新的。
 */
class LogTail {
  constructor(file, tailBytes = TAIL_BYTES) {
    this.file = file;
    this.tailBytes = tailBytes;
    this.offset = -1;
    this.rest = '';
    this.decoder = new StringDecoder('utf8');
  }

  static readRange(file, start, end) {
    if (end <= start) return Buffer.alloc(0);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(end - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  }

  rotatedFile() {
    const ext = path.extname(this.file);
    return this.file.slice(0, this.file.length - ext.length) + '1' + ext;
  }

  /** @returns {{ lines: string[], first: boolean }} first：这是启动时往回读的那一段 */
  read() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return { lines: [], first: false };
    }
    const first = this.offset < 0;
    let text = '';
    try {
      if (first) {
        const start = Math.max(0, size - this.tailBytes);
        text = this.decoder.write(LogTail.readRange(this.file, start, size));
        if (start > 0) text = text.slice(text.indexOf('\n') + 1); // 第一行可能被截断
      } else {
        if (size < this.offset) {
          try {
            const old = this.rotatedFile();
            const oldSize = fs.statSync(old).size;
            if (oldSize >= this.offset) text += this.decoder.write(LogTail.readRange(old, this.offset, oldSize));
          } catch {}
          this.offset = 0;
        }
        text += this.decoder.write(LogTail.readRange(this.file, this.offset, size));
      }
    } catch {
      return { lines: [], first: false }; // 正在轮换等，下一轮再读
    }
    this.offset = size;
    const lines = (this.rest + text).split('\n');
    this.rest = lines.pop();
    return { lines: lines.map((l) => l.replace(/\r$/, '')), first };
  }
}

const RE_HEAD = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) \[\w+\] (.*)$/;
const RE_ASK = /^Emitted tool permission request ([0-9a-f-]{8,}) for (\S+) in session (local_[0-9A-Za-z-]+)/;
const RE_ANSWERED = /^Received permission response for ([0-9a-f-]{8,}): (\w+)/;
const RE_RESPOND = /^LocalSessions\.respondToToolPermission: requestId=([0-9a-f-]{8,}), decision=(\w+)/;
const RE_ABORTED = /^Permission request ([0-9a-f-]{8,}) for \S+ aborted/;
const RE_UNANSWERED = /^\[CCD\] Session (local_[0-9A-Za-z-]+): denied \d+ permission prompt/;
const RE_PREVIEW = /^\[Preview\] .*approval requested \{$/;
const RE_ORIGIN = /^\s+origin: '([^']*)'/;
const RE_START = /^Starting app\b/;

/**
 * 把日志行变成事件。一行一行喂进来（浏览器的框前面有一段多行的说明，网址在里面，所以要记状态）：
 *   { type: 'ask', id, tool, session, origin, at }  弹了一个框
 *   { type: 'done', id, how }                        框有结果了（how：once、always、deny……或 'aborted'）
 *   { type: 'unanswered', session }                  这个会话的框没人答，桌面端自己按拒绝处理了（定时任务）
 *   { type: 'restart' }                              桌面端重新启动了，之前的框都不在了
 */
class LogParser {
  constructor() {
    this.inPreview = false;
    this.origin = '';
    this.originAt = 0;
  }

  feed(line) {
    const m = RE_HEAD.exec(line);
    if (!m) {
      if (this.inPreview) {
        const o = RE_ORIGIN.exec(line);
        if (o) this.origin = o[1];
      }
      return null;
    }
    const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    const msg = m[7];
    this.inPreview = RE_PREVIEW.test(msg);
    if (this.inPreview) {
      this.origin = '';
      this.originAt = at;
      return null;
    }
    let x;
    if ((x = RE_ASK.exec(msg))) {
      // 网址写在紧挨着的前一段里；隔得久的不是同一个框
      const origin = x[2].startsWith('browser:') && at - this.originAt <= 3000 ? this.origin : '';
      this.origin = '';
      return { type: 'ask', id: x[1], tool: x[2], session: x[3], origin, at };
    }
    if ((x = RE_ANSWERED.exec(msg)) || (x = RE_RESPOND.exec(msg))) return { type: 'done', id: x[1], how: x[2] };
    if ((x = RE_ABORTED.exec(msg))) return { type: 'done', id: x[1], how: 'aborted' };
    if ((x = RE_UNANSWERED.exec(msg))) return { type: 'unanswered', session: x[1] };
    if (RE_START.test(msg)) return { type: 'restart' };
    return null;
  }
}

// ---------------------------------------------------------------- 找日志、找会话

/** 桌面端日志可能在的位置，取最近写过的那个；都没有返回空串 */
function findLogFile(env = process.env) {
  const dirs = [];
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Claude', 'logs'));
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'Claude', 'logs'));
  let best = '';
  let bestAt = 0;
  for (const d of dirs) {
    const f = path.join(d, 'main.log');
    try {
      const at = fs.statSync(f).mtimeMs;
      if (at > bestAt) [best, bestAt] = [f, at];
    } catch {}
  }
  return best;
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Claude Code 给每个正在运行的会话进程记的登记文件（~/.claude/sessions/<进程号>.json）：
 * 桌面端的会话编号（hostSessionId）、Claude Code 自己的会话编号（sessionId）、标题、进程启动时间。
 * @returns {(localId: string) => { cli: string, title: string, alive: boolean | null, startedAt: number }}
 *          alive 是 null 表示登记里没有这个会话，不知道在不在
 */
function createSessionRegistry({ dir = path.join(os.homedir(), '.claude', 'sessions'), alive = defaultProcessAlive, now = Date.now } = {}) {
  let cache = [];
  let readAt = 0;

  function entries() {
    const t = now();
    if (t - readAt < 1500 && readAt) return cache;
    readAt = t;
    const out = [];
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {}
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
        if (!j || typeof j !== 'object' || !Number.isInteger(j.pid)) continue;
        out.push({
          pid: j.pid,
          local: typeof j.hostSessionId === 'string' ? j.hostSessionId : '',
          cli: typeof j.sessionId === 'string' ? j.sessionId : '',
          title: typeof j.name === 'string' ? j.name : '',
          startedAt: Number(j.startedAt) || 0,
          desktop: j.entrypoint === 'claude-desktop',
        });
      } catch {} // 正在写，下一轮再读
    }
    cache = out;
    return out;
  }

  function pick(list) {
    if (!list.length) return { cli: '', title: '', alive: null, startedAt: 0, local: '', desktop: false };
    // 同一个会话有几条登记（旧进程没清掉）：取还活着的、最新的
    const scored = list.map((e) => ({ e, up: alive(e.pid) })).sort((a, b) => Number(b.up) - Number(a.up) || b.e.startedAt - a.e.startedAt);
    const { e, up } = scored[0];
    return { cli: e.cli, title: e.title, alive: up, startedAt: e.startedAt, local: e.local, desktop: e.desktop };
  }

  return {
    byLocal: (localId) => pick(entries().filter((e) => e.local === localId)),
    byCli: (cliId) => pick(entries().filter((e) => e.cli === cliId)),
  };
}

// ---------------------------------------------------------------- 提醒里的话

const BROWSER_VERBS = {
  javascript_tool: '执行 JavaScript',
  get_page_text: '读取页面内容',
  read_page: '读取页面内容',
  find: '读取页面内容',
  screenshot: '截图',
  zoom: '截图',
  computer: '操作页面',
  form_input: '填写表单',
  navigate: '打开网页',
};

function hostOf(origin) {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

/** 这个框问的是什么（一句话，尽量和电脑上那个框的标题一样） */
function questionOf(tool, origin) {
  if (tool.startsWith('browser:')) {
    const name = tool.slice(8);
    if (name === 'open_site') return origin ? `允许 Claude 操作 ${origin}？` : '允许 Claude 操作一个新网站？';
    const verb = BROWSER_VERBS[name] || '操作页面';
    return origin ? `允许 Claude 在 ${hostOf(origin)} 上${verb}？` : `允许 Claude 在网页上${verb}？`;
  }
  if (tool === 'AskUserQuestion') return 'Claude 有问题要问你';
  if (tool === 'ExitPlanMode') return 'Claude 做好了方案，等你批准';
  return `Claude 申请使用 ${tool}`;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.pressable] 手机上可以直接选"允许一次""拒绝"
 * @param {boolean} [opts.always] 还可以选"始终允许"（第一次打开某个网站的框，而且读出了是哪个网站）
 * @param {string} [opts.note] 放在最前面的一句（比如上一次没按成的原因）
 */
function noticeText(tool, origin, waitedMs, { pressable = false, always = false, note = '' } = {}) {
  const secs = Math.max(1, Math.round(waitedMs / 1000));
  const waited = secs >= 120 ? `${Math.round(secs / 60)} 分钟` : `${secs} 秒`;
  if (!tool.startsWith('browser:')) {
    return `${note}电脑上有确认框在等你：${questionOf(tool, origin)}（已经等了 ${waited}）。手机上没有收到对应的审批，多半是这个会话没有加载 RemoteClaude 插件。请回到会话列表，点开这个会话的画面去答。`;
  }
  const openSite = tool === 'browser:open_site';
  // 第一次打开某个网站的框，桌面端的日志里没有网址；没能从窗口里读出来时照实说
  const unknownSite = openSite && !origin ? '是哪个网站，这里看不到，要点开这个会话的画面才知道。' : '';
  let how = '这种框手机上答不了：请回到会话列表，点开这个会话的画面，在画面里点按钮。';
  if (pressable && always) {
    how = '可以直接在这里选"允许一次""始终允许"或"拒绝"，被控端替你按电脑上的按钮。"始终允许"是长期授权：以后 Claude 操作这个网站不再问，可以在 Claude 的设置里撤销。';
  } else if (pressable && openSite) {
    how = '可以直接在这里选"允许一次"或"拒绝"，被控端替你按电脑上的按钮。';
  } else if (pressable) {
    how = '可以直接在这里选"允许一次"或"拒绝"，被控端替你按电脑上的按钮。这里只看得到网站和操作的种类；想先看 Claude 要发送的具体内容，就点开这个会话的画面。';
  }
  return `${note}电脑上弹出了确认框：${questionOf(tool, origin)}已经等了 ${waited}。${unknownSite}${how}`;
}

/** 从确认框上的文字里找出网址（"允许 Claude 操作 https://item.taobao.com？……"），没有返回空串 */
function originIn(text) {
  const m = /https?:\/\/[A-Za-z0-9.\-_:[\]]+/.exec(String(text || ''));
  return m ? m[0].replace(/[.:]+$/, '') : '';
}

/** 没按成的原因，说给手机上的人听 */
function pressFailure(r) {
  const code = r && r.code;
  const step = r && r.step;
  if (code === 'locked') return '电脑锁着屏，没法把这个会话的窗口开出来';
  if (code === 'busy') return '被控端正在打开别的会话';
  if (code === 'mismatch') return '窗口里的确认框和要答的不是同一个';
  if (code === 'ui-missing' && (step === 'dialog-menu' || step === 'dialog-menu-press')) return '展开了"更多允许选项"，但没按到里面的"允许一次"';
  if (code === 'ui-missing' && step === 'dialog-always') return '这个框上没有"始终允许"这个按钮';
  if (code === 'ui-missing') return '没在这个会话的窗口里找到确认框的按钮';
  if (code === 'not-found' || code === 'no-title' || code === 'no-main' || code === 'no-window' || code === 'stuck') return '没能把这个会话的窗口开出来';
  return '界面自动化没有正常返回';
}

// ---------------------------------------------------------------- 主体

/**
 * @param {object} deps
 * @param {(msg: string) => void} deps.log
 * @param {() => string} [deps.logFile] 桌面端日志的路径，没有返回空串
 * @param {(localId: string) => { cli: string, title: string, alive: boolean | null, startedAt: number }} deps.sessionOf
 * @param {(cliId: string) => { local: string, desktop: boolean }} [deps.sessionOfCli] 自己验证时用：插件审批的会话是不是桌面端的
 * @param {() => { id: string, sessionId: string, createdAt: number }[]} deps.approvals 插件正挂在手机上的审批
 * @param {(key: string, n: object) => void} deps.notify
 * @param {(key: string) => void} deps.clearNotice
 * @param {(req: { session: string, choice: 'allow' | 'deny' | 'always', expect: string, tool: string }) => Promise<{ ok: boolean, code?: string }>} [deps.press]
 *        替用户按电脑上那个框的按钮；不给就只提醒
 * @param {(session: string) => Promise<{ ok: boolean, text?: string, always?: boolean }>} [deps.inspect]
 *        只看不按：会话窗口里那个框上写的文字、框上有没有"始终允许"按钮。日志里没有网址的框，提醒之前用它找出是哪个网站
 * @param {() => number} [deps.now]
 */
function createDialogWatch({ log, logFile = findLogFile, sessionOf, sessionOfCli = () => ({ local: '', desktop: false }), approvals, notify, clearNotice, press, inspect, now = Date.now, tailBytes = TAIL_BYTES }) {
  /** 编号 -> 还在等的框 */
  const pending = new Map();
  /** 桌面端会话编号 -> 最近一次弹框的时间（自己验证用） */
  const lastAsk = new Map();
  /** 已经对过的插件审批 */
  const judged = new Set();
  let misses = 0;
  let warned = false;
  let tail = null;
  let parser = new LogParser();
  let fileCheckedAt = 0;
  let noFileLogged = false;

  function useFile() {
    const t = now();
    if (tail && t - fileCheckedAt < 60000) return;
    fileCheckedAt = t;
    const f = logFile();
    if (!f) {
      if (!noFileLogged) log('没找到 Claude 桌面端的日志，电脑上弹确认框时没法提醒手机');
      noFileLogged = true;
      return;
    }
    if (tail && tail.file === f) return;
    if (tail || noFileLogged) log('Claude 桌面端的日志在 ' + f);
    noFileLogged = false;
    tail = new LogTail(f, tailBytes);
    parser = new LogParser();
  }

  function drop(p, why) {
    pending.delete(p.id);
    if (!p.key) return;
    clearNotice(p.key);
    p.key = '';
    log(`收回「${p.title}」的提醒：${why}`);
  }

  /** 插件的这条审批是不是为这个框发的：同一个会话的另一个框也可能挂着审批，按时间认 */
  const isFor = (a, p) => {
    const created = Number(a.createdAt) || 0;
    return created >= p.at - COVER_BEFORE_MS && created <= p.at + COVER_AFTER_MS;
  };

  /** 这个框手机上能不能直接答：浏览器的框，而且被控端有办法去按 */
  const pressable = (p) => typeof press === 'function' && p.tool.startsWith('browser:');

  function raise(p, s, t) {
    p.title = s.title || 'Claude';
    p.key = 'dialog:' + p.id;
    const can = pressable(p);
    // "始终允许"是长期授权：只在框上确实有这个按钮、而且读出了是哪个网站时才给
    const always = can && p.always && !!p.origin;
    const choices = { [ALLOW_LABEL]: 'allow', [DENY_LABEL]: 'deny' };
    if (always) choices[ALWAYS_LABEL] = 'always';
    notify(p.key, {
      title: p.title,
      tool: '电脑上有确认框在等你',
      header: can ? '确认框' : '要到画面里点',
      text: noticeText(p.tool, p.origin, t - p.at, { pressable: can, always, note: p.note }),
      options: can
        ? [
            { label: ALLOW_LABEL, description: '替你按电脑上那个框的"允许一次"' },
            ...(always ? [{ label: ALWAYS_LABEL, description: `以后 Claude 操作 ${hostOf(p.origin)} 不再问。可以在 Claude 的设置里撤销` }] : []),
            { label: DENY_LABEL, description: '替你按电脑上那个框的"拒绝"' },
            { label: OK_LABEL, description: '收起这条提醒，我自己到画面里去点' },
          ]
        : [
            { label: OK_LABEL, description: '收起这条提醒。电脑上的确认框还在，要到画面里去点' },
            { label: SNOOZE_LABEL, description: '到时候确认框还在，就再提醒一次' },
          ],
      onAnswer: (label) => {
        p.key = '';
        if (can && Object.prototype.hasOwnProperty.call(choices, label)) {
          startPress(p, choices[label]);
        } else if (label === SNOOZE_LABEL) {
          p.since = now();
          p.wait = SNOOZE_MS;
        } else {
          p.dismissed = true;
        }
      },
    });
    log(`提醒手机：「${p.title}」${questionOf(p.tool, p.origin)}（${p.tool}，等了 ${Math.round((t - p.at) / 1000)} 秒）`);
  }

  /** 手机上选了"允许一次""始终允许"或"拒绝"：去按电脑上的按钮。按完由日志里这个框的结果来确认（evaluate） */
  function startPress(p, choice) {
    const label = choice === 'allow' ? ALLOW_LABEL : choice === 'always' ? ALWAYS_LABEL : DENY_LABEL;
    const job = { choice, label, at: now(), pressedAt: 0, tries: 0 };
    p.pressing = job;
    p.note = '';
    log(`手机上选了"${label}"，去按「${p.title}」的确认框`);
    pressOnce(p, job);
  }

  /** 按一次；按下去以后记下时间，等日志里的结果 */
  function pressOnce(p, job) {
    job.tries++;
    job.at = now();
    job.pressedAt = 0;
    const failed = (why) => {
      if (p.pressing === job) pressFailed(p, why);
    };
    Promise.resolve()
      .then(() => press({ session: p.session, choice: job.choice, expect: p.origin ? hostOf(p.origin) : '', tool: p.tool }))
      .then((r) => {
        if (p.pressing !== job) return; // 这期间框已经有结果了，或者已经算没按成
        if (r && r.ok) job.pressedAt = now();
        else failed(pressFailure(r));
      })
      .catch((err) => {
        log('按确认框出错: ' + (err && err.stack ? err.stack : err));
        failed('被控端出错');
      });
  }

  /** 没按成：马上再提醒一次，开头说明原因，手机上可以再选一次或者到画面里去点 */
  function pressFailed(p, why) {
    const label = p.pressing ? p.pressing.label : '';
    p.pressing = null;
    if (!pending.has(p.id)) return;
    p.note = `刚才选的"${label}"没按成：${why}。`;
    p.since = now() - p.wait;
    log(`没按成「${p.title}」的确认框：${why}`);
  }

  function ingest(lines, first, t) {
    for (const line of lines) {
      const ev = parser.feed(line);
      if (!ev) continue;
      if (ev.type === 'restart') {
        for (const p of [...pending.values()]) drop(p, 'Claude 重新启动了');
        lastAsk.clear();
      } else if (ev.type === 'ask') {
        const at = first ? ev.at : t;
        lastAsk.set(ev.session, at);
        pending.set(ev.id, {
          id: ev.id,
          tool: ev.tool,
          session: ev.session,
          origin: ev.origin,
          at,
          since: at,
          wait: ev.tool.startsWith('browser:') ? GRACE_MS : GRACE_OTHER_MS,
          backlog: first,
          key: '',
          title: '',
          dismissed: false,
          /** 手机上选了允许或拒绝、正在去按：{ choice, label, at, pressedAt, tries } */
          pressing: null,
          /** 下一条提醒开头要说的话（上一次没按成的原因） */
          note: '',
          /** 日志里没有网址时去窗口里读：什么时候开始读的、读完了没有 */
          looking: 0,
          looked: false,
          /** 读窗口时看到框上有"始终允许"按钮 */
          always: false,
          /** 插件把这个框当审批推到过手机 */
          covered: false,
          /** "手机上的审批没了、日志里没有结果"已经记过日志 */
          orphaned: false,
        });
      } else if (ev.type === 'unanswered') {
        // 定时任务的框等太久没人答，桌面端自己按拒绝处理：只有这一行，这个会话的框都结束了
        for (const p of [...pending.values()]) {
          if (p.session !== ev.session) continue;
          p.pressing = null;
          if (!first && !p.key) log(`「${sessionOf(p.session).title || 'Claude'}」的确认框（${p.tool}）等了 ${Math.round((t - p.at) / 60000)} 分钟没人答，Claude 自己按拒绝处理了`);
          drop(p, '没人答，Claude 自己按拒绝处理了');
        }
      } else if (ev.type === 'done') {
        const p = pending.get(ev.id);
        if (!p) continue;
        if (p.pressing && ev.how !== 'aborted') log(`「${p.title}」的确认框按好了：${p.pressing.label}（${ev.how}）`);
        p.pressing = null;
        drop(p, ev.how === 'aborted' ? '确认框撤回了' : `电脑上点了（${ev.how}）`);
      }
    }
  }

  function evaluate(t, live) {
    for (const p of [...pending.values()]) {
      const s = sessionOf(p.session);
      // 启动时往回读到的框：要能确认会话进程还在，而且是这个进程弹的（进程重启过，框就不在了）
      if (s.alive === false || (p.backlog && s.alive !== true) || (s.startedAt && s.startedAt > p.at + SLACK_MS)) {
        drop(p, '会话进程不在了');
        continue;
      }
      if (t - p.at > MAX_AGE_MS) {
        drop(p, '等太久，不盯了');
        continue;
      }
      if (p.pressing) {
        const job = p.pressing;
        if (job.pressedAt && job.tries < PRESS_TRIES && t - job.pressedAt >= PRESS_RETRY_MS) {
          // 按下去两秒，日志里还没有这个框的结果：再按一次。实测第一次按常常只是把焦点移到按钮上（2026-11-21
          // 用户连着答 3 个框，每个都是第二次才成）。走到这里时这一轮刚读过日志，框确实还在等，不会按到下一个框上
          log(`「${p.title}」的确认框按了 ${Math.round((t - job.pressedAt) / 1000)} 秒还没有结果，再按一次`);
          pressOnce(p, job);
        } else if (job.pressedAt && t - job.pressedAt > PRESS_CONFIRM_MS) {
          // 按够了次数，日志里还是没有结果：算没按成，下一轮再提醒
          pressFailed(p, '按了按钮，但 Claude 那边没有反应');
        } else if (!job.pressedAt && t - job.at > PRESS_TIMEOUT_MS) {
          pressFailed(p, '等了很久也没按成');
        }
        continue;
      }
      if (p.dismissed) continue;
      const browser = p.tool.startsWith('browser:');
      if (!browser && !s.cli) continue; // 不知道是哪个 Claude Code 会话，分不清插件管没管，不提醒
      if (s.cli && live.some((a) => a.sessionId === s.cli)) {
        // 插件已经把这个会话的审批推到手机了；批完再重新计时
        p.since = t;
        if (!browser && !p.covered) p.covered = live.some((a) => a.sessionId === s.cli && isFor(a, p));
        if (p.key) {
          clearNotice(p.key);
          p.key = '';
        }
        continue;
      }
      if (p.key || t - p.since < p.wait) continue;
      if (p.covered) {
        // 这个框插件推到过手机，手机上那条已经没了，日志里却没有这个框的结果：多半是桌面端用别的写法结束了它
        // （2026-11-21：定时任务的框超时被拒，日志里只有按会话记的一行，当时误报了两次）。
        // "手机上没有收到对应的审批"对它不成立，不提醒，记一行日志备查
        if (!p.orphaned) log(`「${s.title || 'Claude'}」的确认框（${p.tool}）：手机上的审批已经没了，Claude 的日志里却没有它的结果，当它已经结束，不提醒`);
        p.orphaned = true;
        continue;
      }
      // 日志里没有网址的框（第一次打开某个网站的那种）：提醒之前先从会话窗口里读一下框上写的是哪个网站
      if (browser && !p.origin && typeof inspect === 'function' && !p.looked) {
        if (!p.looking) startLook(p, t);
        else if (t - p.looking > INSPECT_TIMEOUT_MS) p.looked = true; // 读了很久没回来，不等了
        if (!p.looked) continue;
      }
      raise(p, s, t);
    }
  }

  /** 只看不按：读会话窗口里那个框上的文字，找出网址。读不到（会话没有开着的窗口等）就算了，照样提醒 */
  function startLook(p, t) {
    p.looking = t;
    Promise.resolve()
      .then(() => inspect(p.session))
      .then((r) => {
        if (!r || !r.ok) return;
        if (!p.origin) p.origin = originIn(r.text);
        p.always = r.always === true;
      })
      .catch((err) => log('读确认框上的文字出错: ' + (err && err.message ? err.message : err)))
      .then(() => {
        p.looked = true;
      });
  }

  /** 插件每推一条审批，日志里都该有对应的一行；连着对不上就说明这里读不懂日志了 */
  function canary(t, live) {
    const ids = new Set(live.map((a) => a.id));
    for (const id of judged) if (!ids.has(id)) judged.delete(id);
    for (const a of live) {
      if (judged.has(a.id)) continue;
      const created = Number(a.createdAt) || t;
      if (t - created < CANARY_SETTLE_MS) continue;
      judged.add(a.id);
      const s = sessionOfCli(a.sessionId);
      if (!s.desktop || !s.local) continue; // 不是桌面端的会话（比如终端里的 Claude Code），日志里本来就没有
      const seen = lastAsk.get(s.local);
      if (seen !== undefined && Math.abs(seen - created) <= CANARY_WINDOW_MS) {
        misses = 0;
        continue;
      }
      misses++;
      if (misses < CANARY_MISSES || warned) continue;
      warned = true;
      log(`连着 ${misses} 条审批在 Claude 桌面端的日志里对不上，日志的写法多半变了：电脑上弹确认框时可能提醒不到手机`);
      notify('dialog-watch-broken', {
        title: 'RemoteClaude',
        tool: '确认框提醒可能失效了',
        header: '提醒',
        text: 'Claude 桌面端的日志和以前不一样了（多半是 Claude 升级了），电脑上弹"允许 Claude 操作网站"这类确认框时，手机上可能收不到提醒。普通的审批和提问不受影响。请让 Claude 看一下 RemoteClaude 仓库 docs/09-approvals.md 第 4 节。',
      });
    }
  }

  function tick() {
    useFile();
    if (!tail) return;
    const t = now();
    const { lines, first } = tail.read();
    ingest(lines, first, t);
    const live = approvals();
    evaluate(t, live);
    canary(t, live);
  }

  return {
    tick,
    /** 测试、排查用：现在还在等的框 */
    get pending() {
      return [...pending.values()].map((p) => ({ id: p.id, tool: p.tool, session: p.session, origin: p.origin, at: p.at, noticed: !!p.key, dismissed: p.dismissed, pressing: !!p.pressing }));
    },
  };
}

module.exports = {
  createDialogWatch,
  createSessionRegistry,
  findLogFile,
  LogTail,
  LogParser,
  questionOf,
  noticeText,
  originIn,
  TICK_MS,
  GRACE_MS,
  GRACE_OTHER_MS,
  SNOOZE_MS,
  CANARY_MISSES,
  PRESS_CONFIRM_MS,
  PRESS_RETRY_MS,
  PRESS_TRIES,
  OK_LABEL,
  SNOOZE_LABEL,
  ALLOW_LABEL,
  DENY_LABEL,
  ALWAYS_LABEL,
};
