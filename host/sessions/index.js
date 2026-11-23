'use strict';
/**
 * 从控制端浏览、打开、新建 Claude 会话（协议文档 2.5，说明见 docs/07-claude-sessions.md）。
 *
 *   - 列表：读 Claude 桌面端的本地记录（catalog.js）。
 *   - 打开：会话已经开成单独窗口就直接用那个窗口；否则用 Claude 自己的链接
 *     claude://code/continue?session=<id> 让主窗口打开它，再替用户按"更多选项 > 打开方式 > 新建窗口"。
 *     动窗口以前先叫醒显示器（息屏时 Claude 复用的窗口不刷新画面）；Claude 给的窗口卡在别的页面上时关掉重开一次。
 *   - 新建：让主窗口出来，按"菜单 > 文件 > 在新窗口中新建会话"，再在新窗口里选环境。
 *   - 关闭：给会话窗口发 WM_CLOSE，和点窗口的 × 一样。Claude 只是把窗口藏起来留着复用，会话照常在后台跑。
 * 点菜单靠 claude-ui.ps1（Windows 界面自动化，不动鼠标键盘）。打开和新建同一时间只做一件。
 */
const { execFile } = require('child_process');
const path = require('path');
const catalog = require('./catalog');

const SCRIPT = path.join(__dirname, 'claude-ui.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/** Claude 主窗口的标题；会话窗口的标题是会话名 */
const MAIN_TITLE = 'Claude';
/** Claude 没在运行时，链接会先把它启动起来，要等久一点 */
const MAIN_WAIT_MS = 25000;
const NEW_WINDOW_WAIT_MS = 10000;
/** 让主窗口出来、停在新建会话页面上的链接 */
const NEW_LINK = 'claude://code/new';
/** 新建会话第一次没找到"菜单"、发了链接以后，等别的标题是"Claude"的窗口出现多久；没有就还用原来那个 */
const MAIN_RETRY_WAIT_MS = 3000;
/** 新开的会话窗口里页面显示着别的会话，过了这么久还没换过来就算卡住 */
const STUCK_SETTLE_MS = 6000;
/**
 * 页面一直没显示出内容（还在加载）最多等多久。2026-11-19 实测一个 6 MB 记录的会话在复用的窗口里 6 秒没显示出来，
 * 被当成卡住关掉了，几分钟后再开却 1.5 秒就好了，所以多等一会儿。两次都等满也在手机的 60 秒超时以内
 */
const STUCK_CHECK_MS = 20000;
const UI_TIMEOUT_MS = 30000;
/** 发了 WM_CLOSE 后等窗口消失多久；实测 Claude 的会话窗口 40 毫秒就藏起来了 */
const CLOSE_WAIT_MS = 3000;
/**
 * 电脑这么久没人操作，就当显示器可能已经关了（Windows 里关显示器的时间最短能设成 1 分钟）。
 * 显示器关着时，Claude 从窗口池里拿出来复用的会话窗口不刷新画面，页面一直停在它关掉以前的样子：
 * 2026-11-19、11-20 两次"打开会话卡住"一共 13 次失败，全在息屏的时段里（docs/07 第 6 节）
 */
const IDLE_MAYBE_DISPLAY_OFF_S = 60;
/** 叫醒显示器后等这么久再去动 Claude 的窗口，让 Claude 先知道屏幕亮了 */
const WAKE_SETTLE_MS = 1000;
/** 会话窗口出来以后，等它显示内容的这段时间里每隔这么久再动一下鼠标（实测停住的窗口动一下，半秒就显示对了） */
const NUDGE_EVERY_MS = 1500;
/** 在会话窗口里找确认框的按钮最多等多久：窗口本来就开着（实测 0.4 秒就找到）、刚为它开出来的（页面还在加载） */
const DIALOG_WAIT_MS = 5000;
const DIALOG_WAIT_NEW_MS = 15000;
/** 只看确认框上写的什么（peekDialog）时，找框最多等多久 */
const PEEK_WAIT_MS = 3000;
/** 能替用户按的确认框按钮：传给 claude-ui.ps1 的写法 -> 按钮上的字 */
const DIALOG_CHOICES = { allow: '允许一次', deny: '拒绝', always: '始终允许' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const fromB64 = (s) => (typeof s === 'string' && s ? Buffer.from(s, 'base64').toString('utf8') : '');
const secs = (ms) => (Number(ms) / 1000).toFixed(1);

/** 页面检查没通过时写进日志的说明：等了多久、页面上是什么 */
function describeCheck(check) {
  const what = check.reason === 'other' ? '页面停在别的会话上' : check.reason === 'loading' ? '页面一直没显示出内容' : `检查没完成（${check.code}）`;
  const seen = fromB64(check.seen);
  return `${what}${check.ms != null ? `，等了 ${secs(check.ms)} 秒` : ''}${check.seen != null ? `，页面标题：${seen || '（空）'}` : ''}`;
}

/**
 * 窗口能不能从控制端关。Claude 主窗口不行：Claude 设置里关了托盘图标时，关主窗口会退出整个 Claude，
 * 所有会话都停；开着托盘时关了也只是收进托盘，没有意义。
 * @param {{ title: string, className?: string }} w enumTargetWindows 列出的窗口
 */
function isClosable(w) {
  return !(w.className === 'Chrome_WidgetWin_1' && w.title === MAIN_TITLE);
}

class SessionError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    /** 界面自动化卡在哪一步（menu、file、more-options……），没有时是空串 */
    this.step = detail || '';
  }
}

/**
 * @param {object} opts
 * @param {(msg: string) => void} opts.log
 * @param {object} opts.win32 被控端的 win32.js
 * @param {string[]} opts.targets 白名单进程名
 * @param {(url: string) => Promise<void>} opts.openUrl 打开 claude:// 链接（Electron 的 shell.openExternal）
 * @param {() => number} [opts.idleSeconds] 电脑多少秒没人操作了（Electron 的 powerMonitor.getSystemIdleTime），用来猜显示器是不是关着
 * @param {() => string|null} [opts.findDataDir] 测试时可以换掉
 * @param {(action: string, args: object) => Promise<object>} [opts.runUi] 测试时可以换掉，默认跑 claude-ui.ps1
 */
function createSessions({ log, win32, targets, openUrl, idleSeconds = () => 0, findDataDir = catalog.findDataDir, runUi: runUiOverride }) {
  let busy = false;

  function records() {
    const dir = findDataDir();
    if (!dir) return null;
    return catalog.loadRecords(dir);
  }

  /** 给控制端的目录：{ available, groups } 或 { available: false, reason } */
  function list() {
    const r = records();
    if (!r || !r.account) return { available: false, reason: 'no-claude', groups: [] };
    return { available: true, groups: catalog.buildGroups(r) };
  }

  const claudeWindows = () => win32.enumTargetWindows(targets).filter((w) => w.className === 'Chrome_WidgetWin_1');
  const findMain = () => claudeWindows().find((w) => w.title === MAIN_TITLE && !w.minimized) || null;

  async function waitFor(fn, ms, step = 200) {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= deadline) return null;
      await sleep(step);
    }
  }

  const runUi = runUiOverride || runUiScript;

  function runUiScript(action, args) {
    const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Action', action];
    for (const [k, v] of Object.entries(args)) argv.push('-' + k, String(v));
    return new Promise((resolve) => {
      execFile(POWERSHELL, argv, { timeout: UI_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
        const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
        try {
          const r = JSON.parse(line);
          if (r && typeof r.ok === 'boolean') return resolve(r);
        } catch {}
        log(`界面自动化（${action}）没有正常返回: ${err ? err.message : ''} ${String(stderr || '').trim().slice(0, 300)}`);
        resolve({ ok: false, code: err && err.killed ? 'timeout' : 'failed' });
      });
    });
  }

  /** 让 Claude 主窗口出来（必要时用链接），返回它的句柄 */
  async function showMain(url) {
    if (url) await openUrl(url);
    const main = await waitFor(findMain, MAIN_WAIT_MS);
    if (!main) throw new SessionError('no-main');
    return main.hwnd;
  }

  /**
   * 动 Claude 的窗口以前先叫醒显示器（注入一次鼠标微动）。打开、新建会话全程靠界面自动化，不发鼠标键盘，
   * 显示器关着时不会自己亮；而显示器关着时 Claude 复用的窗口不刷新画面，会被当成卡住。
   * 每次都动一下（亮着时没有影响）；电脑很久没人操作、显示器多半关着时，记一行日志并等一会儿。
   */
  async function wakeDisplay() {
    if (typeof win32.wakeDisplay !== 'function') return;
    let idle = 0;
    try {
      idle = Number(idleSeconds()) || 0;
    } catch {}
    const sent = win32.wakeDisplay();
    if (idle < IDLE_MAYBE_DISPLAY_OFF_S) return;
    log(`电脑有 ${Math.round(idle)} 秒没人操作，显示器可能关着，先动一下鼠标叫醒${sent ? '' : '（没注入成功）'}`);
    await sleep(WAKE_SETTLE_MS);
  }

  /** 不记日志、不等，只动一下鼠标 */
  function nudge() {
    if (typeof win32.wakeDisplay === 'function') win32.wakeDisplay();
  }

  /**
   * 对刚出来的会话窗口跑一步界面自动化（检查页面、选环境）：先动一下鼠标，等的时候隔一会儿再动一下。
   * 打开前叫醒的那一下不一定够：窗口是在那之后才显示出来的，实测对已经停住的窗口再动一下才恢复
   */
  async function runUiAwake(action, args) {
    nudge();
    const timer = setInterval(nudge, NUDGE_EVERY_MS);
    try {
      return await runUi(action, args);
    } finally {
      clearInterval(timer);
    }
  }

  async function exclusive(fn) {
    if (busy) return { ok: false, code: 'busy' };
    if (win32.isLocked()) return { ok: false, code: 'locked' };
    busy = true;
    try {
      await wakeDisplay();
      return await fn();
    } catch (err) {
      if (err instanceof SessionError) {
        // 写明是哪一步没做成（比如 ui-missing: menu）。2026-11-21 Claude 升级后新建会话失败，日志里只有"在电脑上新建会话"
        // 一行，看不出卡在哪个按钮上
        log(`没做成: ${err.message}`);
        // step 给自检用（selfcheck.js）；控制端只看 code
        return err.step ? { ok: false, code: err.code, step: err.step } : { ok: false, code: err.code };
      }
      log('打开会话出错: ' + (err && err.stack ? err.stack : err));
      return { ok: false, code: 'failed' };
    } finally {
      busy = false;
    }
  }

  /** 打开一个已有会话：{ ok, hwnd, title, created } 或 { ok: false, code } */
  async function open(sessionId) {
    if (typeof sessionId !== 'string' || !/^local_[A-Za-z0-9-]{1,64}$/.test(sessionId)) return { ok: false, code: 'not-found' };
    const r = records();
    const s = r && r.sessions.find((x) => x.id === sessionId);
    if (!s) return { ok: false, code: 'not-found' };
    const title = s.title;

    // 已经开成了单独窗口：直接用
    const pop = r.popouts.find((p) => p.sessionId === sessionId);
    if (pop) {
      const names = new Set([pop.title, title].filter(Boolean));
      const w = claudeWindows().find((x) => names.has(x.title) && x.title !== MAIN_TITLE);
      if (w) return { ok: true, hwnd: w.hwnd, title: w.title, created: false };
    }
    if (!title) return { ok: false, code: 'no-title' };

    return exclusive(async () => {
      log(`在电脑上打开会话「${title}」`);
      const link = `claude://code/continue?session=${encodeURIComponent(sessionId)}`;
      // Claude 关掉的会话窗口不销毁，清空后藏进窗口池留着下次用。在池里藏了几分钟以上的窗口，显示器关着时拿出来
      // 不刷新画面：标题换成了新会话，页面（界面自动化读到的）还是它关掉以前的样子，动一下鼠标才恢复。
      // 所以 exclusive 里先叫醒显示器，等页面的时候也隔一会儿动一下（runUiAwake）。
      // 仍然发现窗口没显示这个会话，就关掉它重开；池里不止一个窗口时 Claude 会换一个，只有一个时还是拿回同一个。
      // 还不行就报 stuck（docs/07 第 6 节）
      let lastHwnd = null;
      for (let attempt = 1; ; attempt++) {
        const w = await popoutOnce(link, title);
        const check = await runUiAwake('checkdoc', { Hwnd: w.hwnd, Title: b64(title), TimeoutMs: STUCK_CHECK_MS, SettleMs: STUCK_SETTLE_MS });
        if (check.ok) {
          log(`会话「${title}」的窗口（${w.hwnd}）${check.ms != null ? ` ${secs(check.ms)} 秒` : ''}显示出来了`);
          return { ok: true, hwnd: w.hwnd, title: w.title, created: true };
        }
        const same = w.hwnd === lastHwnd ? '，和上次是同一个窗口' : '';
        log(`Claude 给会话「${title}」开的窗口（${w.hwnd}${same}）没显示这个会话（第 ${attempt} 次）：${describeCheck(check)}。关掉它`);
        lastHwnd = w.hwnd;
        await runUi('close', { Hwnd: w.hwnd });
        await sleep(500);
        if (attempt >= 2) throw new SessionError('stuck');
      }
    });
  }

  /** 用链接让主窗口切到这个会话，按"更多选项 > 打开方式 > 新建窗口"，返回出现的会话窗口 */
  async function popoutOnce(link, title) {
    const before = new Set(claudeWindows().map((w) => w.hwnd));
    const main = await showMain(link);
    const ui = await runUi('popout', { Hwnd: main, Title: b64(title) });
    if (!ui.ok) throw new SessionError(ui.code || 'failed', ui.step);
    const w = await waitFor(() => {
      const fresh = claudeWindows().filter((x) => !before.has(x.hwnd) && x.title !== MAIN_TITLE);
      return fresh.find((x) => x.title === title) || fresh[0] || null;
    }, NEW_WINDOW_WAIT_MS);
    if (!w) throw new SessionError('no-window');
    return w;
  }

  /**
   * 在某个环境下新建会话（开在新窗口里）：{ ok, hwnd, title, envOk } 或 { ok: false, code }。
   * 新窗口是 Claude 的"新会话"输入框，用户在远程画面里发出第一句话，会话才真正建立。
   * 不用 Claude 主窗口：主窗口平时被平铺收在托盘里，用链接叫出来后实测只显示加载中的占位画面，远程看不到内容。
   */
  async function create(envId) {
    const r = records();
    const env = r && typeof envId === 'string' && r.presets.find((p) => p.id === envId);
    if (!env) return { ok: false, code: 'not-found' };

    return exclusive(async () => {
      log(`在电脑上新建会话（环境「${env.name}」）`);
      const before = new Set(claudeWindows().map((w) => w.hwnd));
      // 主窗口平时被平铺收在托盘里，界面自动化看不到藏起来的窗口，先用链接让它出来
      const shown = findMain();
      let main = shown ? shown.hwnd : await showMain(NEW_LINK);
      let ui = await runUi('newwin', { Hwnd: main });
      if (!ui.ok && shown && ui.code === 'ui-missing' && ui.step === 'menu') {
        // 屏幕上本来就有一个标题是"Claude"的窗口，所以没发链接，可在它里面找不到"菜单"按钮：
        // 2026-11-22 04:57 连着两次新建都这样失败，Claude 的日志里那两次都没收到链接；一分钟后打开会话
        // （那条路每次都发链接）却是好的。那个窗口要么不是主窗口，要么是主窗口但画面停住了。
        // 发链接让真正的主窗口出来再试一次，并把当时有哪些窗口记下来
        const all = claudeWindows().map((w) => `${w.hwnd}「${w.title}」${w.minimized ? '最小化' : ''}${w.rect ? ' ' + w.rect.join(',') : ''}`);
        log(`在标题是"Claude"的窗口（${main}）里没找到"菜单"按钮，用链接把主窗口叫出来再试一次。当时的窗口：${all.join('；')}`);
        await openUrl(NEW_LINK);
        const failed = main;
        const other = await waitFor(() => claudeWindows().find((w) => w.title === MAIN_TITLE && !w.minimized && w.hwnd !== failed) || null, MAIN_RETRY_WAIT_MS);
        if (other) {
          main = other.hwnd;
          log(`这次用另一个标题是"Claude"的窗口（${main}）`);
        } else {
          main = await showMain();
        }
        ui = await runUi('newwin', { Hwnd: main });
      }
      if (!ui.ok) throw new SessionError(ui.code || 'failed', ui.step);
      const w = await waitFor(() => claudeWindows().find((x) => !before.has(x.hwnd) && x.hwnd !== main) || null, NEW_WINDOW_WAIT_MS);
      if (!w) throw new SessionError('no-window');
      const pick = await runUiAwake('pickenv', { Hwnd: w.hwnd, EnvName: b64(env.name) });
      if (!pick.ok) log(`没能自动选上环境「${env.name}」: ${pick.code} ${pick.step || ''}`);
      const r = { ok: true, hwnd: w.hwnd, title: w.title, envOk: !!pick.ok, env: env.name };
      // 没选上时把原因带出去，给自检用（selfcheck.js）
      if (!pick.ok) r.envFail = `${pick.code || 'failed'}${pick.step ? ': ' + pick.step : ''}`;
      return r;
    });
  }

  /**
   * 关掉一个窗口（协议文档 2.8）：{ ok: true, title } 或 { ok: false, code }。
   * 发 WM_CLOSE，效果和点窗口的 × 一样，等窗口从屏幕上消失。Claude 的会话窗口不会销毁，只是藏起来留着下次
   * "在新窗口打开"时用（句柄不变），所以控制端给了标题就核对：手机上的列表旧了、这个句柄已经换成别的会话时不关。
   * @param {number} hwnd
   * @param {string|null} [title] 控制端以为这个窗口是什么标题
   */
  async function closeWindow(hwnd, title = null) {
    hwnd = Number(hwnd);
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0) return { ok: false, code: 'gone' };
    const w = win32.enumTargetWindows(targets).find((x) => x.hwnd === hwnd);
    if (!w) return { ok: false, code: 'gone' };
    if (!isClosable(w)) return { ok: false, code: 'not-closable' };
    if (typeof title === 'string' && title && title !== w.title) return { ok: false, code: 'changed' };
    log(`关闭窗口「${w.title}」`);
    if (!win32.postClose(hwnd)) return { ok: false, code: 'failed' };
    const gone = await waitFor(() => !win32.isTargetWindow(hwnd, targets), CLOSE_WAIT_MS, 50);
    if (!gone) {
      log(`窗口「${w.title}」发了关闭后 ${CLOSE_WAIT_MS / 1000} 秒还在`);
      return { ok: false, code: 'still-open' };
    }
    return { ok: true, title: w.title };
  }

  /** Claude Code 的会话编号（钩子里的 session_id）对应的桌面端会话标题，没找到返回空串 */
  function titleForCli(cliSessionId) {
    if (!cliSessionId) return '';
    const r = records();
    const s = r && r.sessions.find((x) => x.cli === cliSessionId);
    return s ? s.title : '';
  }

  /**
   * 替用户按会话里桌面端自己弹的确认框（"允许 Claude 在 xxx 上执行 JavaScript？"）：{ ok } 或 { ok: false, code, step }。
   * 会话没有单独的窗口就先开一个（框只画在显示这个会话的窗口里）。expect 是框里应该出现的网站名，
   * 对不上不按（code 为 mismatch）。只表示按钮按下去了；框是不是真的有了结果，调用方看桌面端的日志（dialogwatch.js）。
   * @param {string} sessionId 桌面端的会话编号（local_…）
   * @param {'allow' | 'deny' | 'always'} choice 允许一次、拒绝、始终允许（只有第一次打开网站的那种框有，别的框回 ui-missing）
   * @param {string} [expect]
   */
  async function answerDialog(sessionId, choice, expect = '') {
    if (!DIALOG_CHOICES[choice]) return { ok: false, code: 'bad-args' };
    const opened = await open(sessionId);
    if (!opened.ok) return opened;
    if (busy) return { ok: false, code: 'busy' };
    busy = true;
    try {
      nudge();
      const args = { Hwnd: opened.hwnd, Choice: choice, TimeoutMs: opened.created ? DIALOG_WAIT_NEW_MS : DIALOG_WAIT_MS };
      if (expect) args.Expect = b64(expect);
      const r = await runUi('dialog', args);
      if (r.ok) {
        const how = `${r.menu ? '展开"更多允许选项"按的，' : ''}按之前焦点${r.focused ? '已经' : '不'}在按钮上`;
        log(`替手机按了「${opened.title}」里确认框的"${DIALOG_CHOICES[choice]}"（${how}）`);
      } else {
        // 失败时脚本会把看到的东西带回来（框里的文字，或者下拉里有哪几项），写进日志好查
        const seen = fromB64(r.seen).slice(0, 200);
        log(`没按成「${opened.title}」里的确认框：${r.code}${r.step ? ': ' + r.step : ''}${seen ? `（看到的是：${seen}）` : ''}`);
      }
      return r.ok ? { ok: true } : { ok: false, code: r.code || 'failed', ...(r.step ? { step: r.step } : {}) };
    } finally {
      busy = false;
    }
  }

  /** 这个会话已经开着的单独窗口（不开新的）：{ hwnd, title }，没有返回 null */
  function windowOf(sessionId) {
    const r = records();
    const s = r && r.sessions.find((x) => x.id === sessionId);
    const pop = r && r.popouts.find((p) => p.sessionId === sessionId);
    if (!s || !pop) return null;
    const names = new Set([pop.title, s.title].filter(Boolean));
    const w = claudeWindows().find((x) => names.has(x.title) && x.title !== MAIN_TITLE);
    return w ? { hwnd: w.hwnd, title: w.title } : null;
  }

  /**
   * 只看不按：会话已经开着的窗口里，那个确认框上写的是什么。{ ok, text, menu } 或 { ok: false, code }；
   * 不为它开新窗口，没有窗口回 no-window。第一次打开某个网站的框，桌面端日志里没有网址，提醒手机之前靠它读出来。
   * menu 为真表示"允许一次"收在"更多允许选项"的下拉里；always 为真表示框上有"始终允许"按钮。
   */
  async function peekDialog(sessionId) {
    const w = windowOf(sessionId);
    if (!w) return { ok: false, code: 'no-window' };
    const r = await runUi('dialog', { Hwnd: w.hwnd, Choice: 'allow', Probe: 1, TimeoutMs: PEEK_WAIT_MS });
    return r.ok
      ? { ok: true, text: fromB64(r.seen), menu: r.menu === true, always: r.always === true }
      : { ok: false, code: r.code || 'failed' };
  }

  /** 桌面端的会话编号（local_…）对应的 Claude Code 会话编号和标题，没找到两项都是空串 */
  function infoForLocal(localId) {
    if (!localId) return { cli: '', title: '' };
    const r = records();
    const s = r && r.sessions.find((x) => x.id === localId);
    return s ? { cli: s.cli, title: s.title } : { cli: '', title: '' };
  }

  return { list, open, create, closeWindow, titleForCli, infoForLocal, answerDialog, peekDialog, get busy() { return busy; } };
}

module.exports = { createSessions, isClosable, SessionError, describeCheck };
