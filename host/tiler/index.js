'use strict';
/**
 * Claude 桌面端窗口自动平铺（从 Python 版 claude_tiler.py 移植，跑在 RemoteClaude 被控端的 Electron 主进程里）
 *
 * 监听 Claude 会话窗口的显示 / 隐藏 / 销毁、最小化 / 还原、前台切换，把所有会话窗口左右并排铺到显示器上：
 * 每屏最多 N 个（默认 3），每个固定占 1/N 宽，先铺满一个屏再放下一个屏。
 *
 *   const { createTiler } = require('./tiler');
 *   const tiler = createTiler({ log: (m) => console.log('[平铺] ' + m) });
 *   tiler.start();
 *
 * 线程：WinEvent 钩子用 WINEVENT_OUTOFCONTEXT，回调由调用 SetWinEventHook 的线程在取消息时收到。
 * Electron 主线程本身就在跑 Win32 消息循环，所以回调直接在主线程上进来，不需要另开线程。
 * 回调里只记状态、定计时器，真正的重排放到计时器里做（和 Python 版一样）。
 * Python 版用 SetTimer 做的延时重排 / 提到最前 / 复查，这里都换成 setTimeout；
 * Python 版摆窗口时 time.sleep 等窗口反应，这里换成 await，不卡主线程。
 *
 * 托盘图标、单实例、命令行、快捷键注册都由被控端负责，这里不管。
 */
const fs = require('fs');
const path = require('path');
const win = require('./win');
const { Config, ensureConfig, defaultConfigPath, defaultLogPath, writeConfigValue } = require('./config');
const {
  checkMonitorOrder,
  monitorOrderText,
  monitorOrderChoices,
  orderMonitors,
  planLayout,
  describePlan,
  monitorLabel,
  shortTitle,
  skipReason,
  formatRect,
  hotkeyToAccelerator,
  Tracker,
} = require('./layout');

const { C } = win;
const TRAY_HOST_CLASS = 'Electron_NotifyIconHostWindow'; // Electron 托盘图标的宿主窗口
const LOG_MAX_BYTES = 512 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 日志

function pad2(n) {
  return String(n).padStart(2, '0');
}

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 追加一行到日志文件，超过 512KB 就把旧的改名成 .1（和 Python 版 RotatingFileHandler 一样只留一份旧的） */
function appendLogLine(file, level, msg) {
  try {
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) {
        fs.rmSync(file + '.1', { force: true });
        fs.renameSync(file, file + '.1');
      }
    } catch {
      // 文件还不存在，或者被别的进程占着改不了名，下次再说
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${timestamp()} ${level} ${msg}\n`, 'utf8');
  } catch {
    // 写日志失败不能影响平铺
  }
}

function makeLogger(log, file) {
  const write = (level, msg) => {
    if (log) {
      const prefix = level === 'INFO' ? '' : level === 'WARNING' ? '警告：' : '错误：';
      try {
        log(prefix + msg);
      } catch {
        // 调用方的日志函数出错不影响平铺
      }
    }
    if (file) appendLogLine(file, level, msg);
  };
  return {
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARNING', msg),
    error: (msg, err) => write('ERROR', err ? `${msg}：${(err && err.stack) || err}` : msg),
  };
}

// ---------------------------------------------------------------- Claude 托盘设置

/**
 * Claude 设置里明确关掉了托盘图标（menuBarEnabled=false）时返回 true。
 * Claude 主窗口的关闭逻辑：托盘图标开着时只是藏到托盘；关掉了托盘图标时，关闭主窗口会让 Claude 整个退出。
 */
function claudeTrayDisabled() {
  const local = process.env.LOCALAPPDATA || '';
  const dirs = [path.join(process.env.APPDATA || '', 'Claude')];
  const bases = [
    [path.join(local, 'Claude-Data'), ''],
    [path.join(local, 'Packages'), path.join('LocalCache', 'Roaming', 'Claude')],
  ];
  for (const [base, sub] of bases) {
    try {
      for (const d of fs.readdirSync(base)) {
        if (d.toLowerCase().startsWith('claude')) dirs.push(sub ? path.join(base, d, sub) : path.join(base, d));
      }
    } catch {
      // 目录不存在
    }
  }
  for (const d of dirs) {
    for (const name of ['claude_desktop_config.json', 'config.json']) {
      try {
        if (/"menuBarEnabled"\s*:\s*false/.test(fs.readFileSync(path.join(d, name), 'utf8'))) return true;
      } catch {
        // 文件不存在
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------- 引擎

/**
 * 创建平铺引擎。
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log] 日志函数；警告和错误会带上“警告：”“错误：”前缀
 * @param {boolean} [opts.dryRun=false] 演练模式：照常算排列计划、写日志，但绝不移动、缩放、显示、隐藏、关闭任何窗口，也不改窗口的前后顺序
 * @param {boolean|string} [opts.logFile=true] 另外写一份日志文件：true 写到配置目录下的 tiler.log，字符串是自定义路径，false 不写
 * @param {string} [opts.configPath] 配置文件路径，默认 %USERPROFILE%\.claude-window-tiler\config.toml
 */
function createTiler(opts = {}) {
  const dryRun = !!opts.dryRun;
  const logPath = opts.logFile === false ? '' : typeof opts.logFile === 'string' ? opts.logFile : defaultLogPath();
  const L = makeLogger(opts.log === undefined ? (m) => console.log(`[平铺] ${m}`) : opts.log, logPath);

  const usingDefaultConfig = !opts.configPath;
  const configPath = opts.configPath || defaultConfigPath();
  if (usingDefaultConfig && ensureConfig(configPath)) L.info(`已从模板生成配置文件：${configPath}`);
  win.ensureDpiAware();
  const cfg = new Config(configPath, L);

  const tracker = new Tracker({ isWindow: win.isWindow, getTitle: win.getTitle, windowRect: win.windowRect });

  let paused = !cfg.data.auto_arrange;
  const newWindows = new Map(); // hwnd -> 出现时间（Map 保持出现顺序）
  let lastPlan = [];
  let placed = new Set();
  let verifyTargets = [];
  let retryCount = 0;
  let pendingReason = '';
  let raiseReason = '';
  let hooks = [];
  let winEventCb = null;
  let unregisterTimer = null;
  const timers = { arrange: null, verify: null, raise: null };
  let ignoreUntil = 0;
  let busy = false; // 正在摆窗口（中间会 await），这期间到点的重排等它摆完再做
  let rerun = false;
  let epoch = 0; // 每次 stop() 加一：stop 之前开始、stop 之后才摆完的重排，不再接着提到最前、收主窗口、定复查
  const waiters = []; // arrange() 返回的 Promise 等着的
  const listeners = new Set();
  const hk = { raw: undefined, acc: '' };
  const stats = { events: 0, claudeEvents: 0, arranges: 0, raises: 0, startedAt: 0 };

  // ---- 会改动窗口的操作：演练模式下一律不做 ----
  const act = {
    setWindowPos: (...a) => (dryRun ? false : win.setWindowPos(...a)),
    showWindow: (...a) => (dryRun ? false : win.showWindow(...a)),
    showWindowAsync: (...a) => (dryRun ? false : win.showWindowAsync(...a)),
    postMessage: (...a) => (dryRun ? false : win.postMessage(...a)),
  };
  const tag = dryRun ? '（演练）' : '';

  function emit(evt) {
    for (const cb of listeners) {
      try {
        cb(evt);
      } catch (err) {
        L.error('onChange 回调出错', err);
      }
    }
  }

  // ---- 窗口 / 显示器信息 ----

  function getMonitors(order) {
    return orderMonitors(win.enumMonitors(), order);
  }

  /** 窗口中心点所在的显示器（monitors 里的下标） */
  function monitorOf(frame, monitors) {
    const h = win.monitorFromPoint(Math.floor((frame[0] + frame[2]) / 2), Math.floor((frame[1] + frame[3]) / 2));
    const i = monitors.findIndex((m) => m.handle === h);
    return i < 0 ? null : i;
  }

  const hasCaption = (style) => !(style & C.WS_CHILD) && (style & C.WS_CAPTION) === C.WS_CAPTION;

  /** Claude 进程里所有带标题栏的顶层窗口 [{ hwnd, pid, tid }] */
  function captionWindows(c, onlyPid = null) {
    const classes = new Set(c.window_classes);
    const names = new Set(c.process_names);
    const out = [];
    for (const hwnd of win.enumTopWindows()) {
      if (!classes.has(win.getClass(hwnd))) continue;
      const { pid, tid } = win.getPidTid(hwnd);
      if (onlyPid != null && pid !== onlyPid) continue;
      if (!names.has(win.processName(pid))) continue;
      if (!hasCaption(win.getStyle(hwnd))) continue; // 菜单、提示框、托盘等无标题栏的窗口直接忽略
      out.push({ hwnd, pid, tid });
    }
    return out;
  }

  const candidatesOf = (c, pid) => captionWindows(c, pid).map((x) => [x.hwnd, win.getTitle(x.hwnd)]);

  /** 这个 Claude 进程有没有托盘图标 */
  function hasTrayHost(pid) {
    return win.enumTopWindows().some((h) => win.getClass(h) === TRAY_HOST_CLASS && win.getPidTid(h).pid === pid);
  }

  /** 列出所有 Claude 顶层窗口，并标出哪些参与平铺 */
  function collectWindows(c) {
    const byPid = new Map();
    for (const { hwnd, pid, tid } of captionWindows(c)) {
      if (!byPid.has(pid)) byPid.set(pid, []);
      byPid.get(pid).push({ hwnd, pid, tid, title: win.getTitle(hwnd), frame: win.frameRect(hwnd), skip: null });
    }
    const result = [];
    for (const [pid, list] of byPid) {
      const main = tracker.mainOf(pid, list.map((w) => [w.hwnd, w.title]));
      for (const w of list) {
        w.skip = skipReason(c, w, {
          visible: () => win.isWindowVisible(w.hwnd),
          cloaked: () => win.isCloaked(w.hwnd),
          toolWindow: () => (win.getExStyle(w.hwnd) & C.WS_EX_TOOLWINDOW) !== 0,
          owned: () => win.getOwner(w.hwnd) !== 0,
          isMain: w.hwnd === main,
          iconic: () => win.isIconic(w.hwnd),
          zoomed: () => win.isZoomed(w.hwnd),
          hung: () => win.isHungAppWindow(w.hwnd),
        });
        result.push(w);
      }
    }
    return result;
  }

  // ---- 摆放 ----

  const offBy = (hwnd, target, tol = 3) => win.frameRect(hwnd).some((v, i) => Math.abs(v - target[i]) > tol);

  /** 把窗口可见部分放到 target，补偿透明边框 */
  function place(hwnd, target) {
    const wr = win.windowRect(hwnd);
    const fr = win.frameRect(hwnd);
    const ml = fr[0] - wr[0];
    const mt = fr[1] - wr[1];
    const mr = wr[2] - fr[2];
    const mb = wr[3] - fr[3];
    const [L0, T0, R0, B0] = target;
    act.setWindowPos(
      hwnd,
      0,
      L0 - ml,
      T0 - mt,
      R0 - L0 + ml + mr,
      B0 - T0 + mt + mb,
      C.SWP_NOZORDER | C.SWP_NOACTIVATE | C.SWP_NOOWNERZORDER
    );
  }

  async function applyPlan(plan) {
    let todo = [];
    for (const { win: w, rect } of plan) {
      if (!win.isWindow(w.hwnd)) continue;
      if (win.isZoomed(w.hwnd)) {
        // 最大化的窗口先还原（不抢焦点），再按格子摆
        if (dryRun) L.info(`${tag}会先还原最大化的窗口「${shortTitle(w.title)}」`);
        else {
          act.showWindow(w.hwnd, C.SW_SHOWNOACTIVATE);
          await sleep(50);
        }
      }
      if (offBy(w.hwnd, rect, 1)) todo.push([w, rect]);
    }
    if (dryRun) {
      for (const [w, rect] of todo) {
        L.info(`${tag}会把「${shortTitle(w.title)}」从 ${formatRect(win.frameRect(w.hwnd))} 挪到 ${formatRect(rect)}`);
      }
      return;
    }
    // 跨不同缩放的屏移动时，Claude 会按新 DPI 自己改一次尺寸，所以多校正两轮
    for (let round = 0; round < 3 && todo.length; round++) {
      for (const [w, rect] of todo) place(w.hwnd, rect);
      await sleep(120);
      todo = todo.filter(([w, rect]) => win.isWindow(w.hwnd) && offBy(w.hwnd, rect, 1));
    }
    for (const [w, rect] of todo) {
      L.warn(
        `窗口「${shortTitle(w.title)}」没能精确放到目标位置：目标 ${formatRect(rect)} 实际 ${formatRect(win.frameRect(w.hwnd))}（可能是窗口最小宽度限制）`
      );
    }
  }

  /**
   * 把所有 Claude 会话窗口提到最前面（不含主窗口），不抢焦点、不改位置。
   * 当前在前台的如果是 Claude 会话窗口，它保持在最上面，其余的紧跟在它后面；
   * raise_restores_minimized=true 时，最小化的会话窗口也还原出来。返回处理的窗口数。
   */
  function raiseAllWindows(c) {
    const windows = collectWindows(c);
    const mains = tracker.mains();
    const ok = new Set([null, '最大化', '太小']);
    if (c.raise_restores_minimized) ok.add('最小化');
    const targets = windows.filter((w) => ok.has(w.skip) && !mains.has(w.hwnd)).map((w) => w.hwnd);
    if (dryRun) return targets.length;
    for (const h of targets) {
      if (win.isIconic(h)) act.showWindowAsync(h, C.SW_SHOWNOACTIVATE); // 异步：对方卡住也不会把这里拖住
    }
    const flags = C.SWP_NOMOVE | C.SWP_NOSIZE | C.SWP_NOACTIVATE | C.SWP_NOOWNERZORDER | C.SWP_ASYNCWINDOWPOS;
    const fg = win.foregroundWindow();
    if (targets.includes(fg)) {
      let after = fg;
      for (const h of targets) {
        if (h === fg) continue;
        act.setWindowPos(h, after, 0, 0, 0, 0, flags);
        after = h;
      }
    } else {
      for (const h of [...targets].reverse()) act.setWindowPos(h, C.HWND_TOP, 0, 0, 0, 0, flags);
    }
    return targets.length;
  }

  /** 鼠标键正按在这个窗口上——说明是直接点窗口切过来的，不是从任务栏 / Alt+Tab */
  function mouseDownInside(hwnd) {
    if (!win.anyMouseButtonDown()) return false;
    const pt = win.cursorPos();
    if (!pt) return false;
    const [L0, T0, R0, B0] = win.windowRect(hwnd);
    return L0 <= pt[0] && pt[0] < R0 && T0 <= pt[1] && pt[1] < B0;
  }

  // ---- 配置 / 暂停 ----

  function reloadConfig(force = false) {
    const oldAuto = cfg.data.auto_arrange;
    const oldHotkey = cfg.data.hotkey;
    const oldOrder = JSON.stringify(cfg.data.monitor_order);
    if (!cfg.reload(force)) return;
    L.info('配置已重新读取');
    if (cfg.data.auto_arrange !== oldAuto) setPaused(!cfg.data.auto_arrange);
    if (cfg.data.hotkey !== oldHotkey) emit({ what: 'hotkey', hotkey: getHotkey(), paused });
    if (JSON.stringify(cfg.data.monitor_order) !== oldOrder) emit({ what: 'order', hotkey: getHotkey(), paused });
  }

  /**
   * 改屏幕顺序（先往哪个屏放）：写进配置文件的 monitor_order，然后马上按新顺序重排一次（暂停了自动平铺也排，
   * 和手动“立即重排”一样）。order 是 MONITOR_ORDERS 里的一种写法，或者 [2, 3, 1] 这样的屏幕序号数组。
   * 返回是否改成了；配置文件里有写错的地方、或者写不进去时返回 false 并记日志，配置文件保持原样。
   */
  function setMonitorOrder(order) {
    const wanted = checkMonitorOrder(order);
    if (wanted == null) return false;
    const key = JSON.stringify(wanted);
    reloadConfig();
    if (JSON.stringify(cfg.data.monitor_order) === key) return true;
    try {
      writeConfigValue(cfg.path, 'monitor_order', Array.isArray(wanted) ? `[${wanted.join(', ')}]` : key);
    } catch (err) {
      L.error(`屏幕顺序没改成，配置文件改不了：${err.message}`);
      return false;
    }
    reloadConfig(true);
    if (JSON.stringify(cfg.data.monitor_order) !== key) return false; // 写进去了却没读回来（配置里别的地方数值不对），日志里已有原因
    L.info(`屏幕顺序改成：${monitorOrderText(wanted)}`);
    schedule('改了屏幕顺序', 50);
    return true;
  }

  /** 托盘菜单“屏幕顺序”要列的选项和现在选中的那一项（见 layout.js 的 monitorOrderChoices），按现在接着的屏算 */
  function orderChoices() {
    return monitorOrderChoices(cfg.data.monitor_order, win.enumMonitors());
  }

  function setPaused(value) {
    const p = !!value;
    const changed = p !== paused;
    paused = p;
    if (p) {
      newWindows.clear();
      // 还有 arrange() 在等结果时不取消（手动重排暂停时照样能用）
      if (!waiters.length) clearTimer('arrange');
    }
    L.info(`自动平铺${p ? '已暂停' : '已恢复'}`);
    if (changed) emit({ what: 'paused', paused, hotkey: getHotkey() });
  }

  function getHotkey() {
    const raw = cfg.data.hotkey;
    if (raw !== hk.raw) {
      hk.raw = raw;
      try {
        hk.acc = hotkeyToAccelerator(raw);
      } catch (err) {
        hk.acc = '';
        L.error(`快捷键配置有误：${err.message}`);
      }
    }
    return hk.acc;
  }

  // ---- 计时器 ----

  function clearTimer(name) {
    if (timers[name]) clearTimeout(timers[name]);
    timers[name] = null;
  }

  function armArrange(ms) {
    clearTimer('arrange');
    timers.arrange = setTimeout(() => {
      timers.arrange = null;
      doArrange().catch((err) => L.error('重排出错', err));
    }, ms);
  }

  /** 过 delay 毫秒重排；期间又有事件就重新计时（防抖） */
  function schedule(reason, delay) {
    pendingReason = reason;
    retryCount = 0;
    armArrange(Math.max(0, Number(delay) || 0));
  }

  function scheduleRaise(reason, delay) {
    raiseReason = reason;
    clearTimer('raise');
    timers.raise = setTimeout(() => {
      timers.raise = null;
      try {
        reloadConfig();
        doRaise();
      } catch (err) {
        L.error('提到最前出错', err);
      }
    }, delay);
  }

  function finishBusy() {
    busy = false;
    if (rerun) {
      rerun = false;
      armArrange(50);
    }
  }

  // ---- 重排 / 提到最前 / 复查 ----

  async function doArrange() {
    if (busy) {
      rerun = true;
      return;
    }
    reloadConfig();
    const c = cfg.data;
    const monitors = getMonitors(c.monitor_order);
    const windows = collectWindows(c);
    const elig = windows.filter((w) => w.skip == null);
    // 用户正在拖某个 Claude 窗口时先别动，等松手
    if (retryCount < 40 && [...new Set(elig.map((w) => w.tid))].some((t) => win.inMoveSize(t))) {
      retryCount += 1;
      armArrange(300);
      return;
    }
    busy = true;
    const done = waiters.splice(0);
    const reason = pendingReason;
    const myEpoch = epoch;
    let summary = null;
    try {
      const newOrder = [...newWindows.keys()];
      newWindows.clear();
      const plan = planLayout(c, monitors, windows, newOrder, monitorOf);
      lastPlan = plan;
      placed = new Set(plan.map((p) => p.win.hwnd));
      await applyPlan(plan);
      stats.arranges += 1;
      summary = describePlan(plan, monitors);
      L.info(`${tag}重排（${reason}）：${summary}`);
      if (myEpoch !== epoch) return; // 摆的过程中被 stop() 了
      // 新窗口刚显示时 Claude 可能还会自己挪一次位置，过一会儿复查一遍
      const newSet = new Set(newOrder);
      verifyTargets = plan.filter((p) => newSet.has(p.win.hwnd)).map((p) => [p.win, p.rect]);
      if (verifyTargets.length && !dryRun) {
        clearTimer('verify');
        timers.verify = setTimeout(() => {
          timers.verify = null;
          doVerify().catch((err) => L.error('复查出错', err));
        }, 1200);
      }
      if (c.raise_all) {
        raiseReason = reason;
        doRaise();
      }
      if (c.hide_main_window && newOrder.length) hideMainWindows(windows, newOrder);
    } finally {
      for (const resolve of done) resolve(summary);
      finishBusy();
    }
  }

  function doRaise() {
    const n = raiseAllWindows(cfg.data);
    stats.raises += 1;
    L.info(`${tag}把 ${n} 个 Claude 窗口提到最前（${raiseReason}）`);
    return n;
  }

  /** 新会话窗口出来后，把 Claude 主窗口收到托盘（和点主窗口右上角的关闭一样） */
  function hideMainWindows(windows, newOrder) {
    const newSet = new Set(newOrder);
    const pids = new Set(windows.filter((w) => newSet.has(w.hwnd) && w.skip == null).map((w) => w.pid));
    for (const pid of pids) {
      const main = tracker.mainByPid.get(pid);
      if (!main || newSet.has(main) || !win.isWindow(main) || !win.isWindowVisible(main)) continue;
      if (!hasTrayHost(pid)) {
        L.warn('没找到 Claude 的托盘图标，关闭主窗口可能会让 Claude 退出，这次不收起主窗口');
        continue;
      }
      if (claudeTrayDisabled()) {
        L.warn('Claude 设置里关掉了托盘图标，关闭主窗口会让 Claude 整个退出，所以不收起主窗口');
        continue;
      }
      act.postMessage(main, C.WM_CLOSE, 0, 0);
      L.info(dryRun ? `${tag}会把 Claude 主窗口收到托盘` : '已把 Claude 主窗口收到托盘');
    }
  }

  async function doVerify() {
    if (busy) return; // 正在重排，排完会自己再定复查
    const fix = verifyTargets.filter(
      ([w, rect]) =>
        win.isWindow(w.hwnd) &&
        win.isWindowVisible(w.hwnd) &&
        !win.isIconic(w.hwnd) &&
        !win.isZoomed(w.hwnd) &&
        !win.inMoveSize(w.tid) &&
        offBy(w.hwnd, rect)
    );
    verifyTargets = [];
    if (!fix.length) return;
    L.info(`复查：${fix.length} 个新窗口被挪动过，重新放回`);
    busy = true;
    try {
      await applyPlan(fix.map(([w, rect]) => ({ win: w, rect, monitor: null })));
    } finally {
      finishBusy();
    }
  }

  // ---- 窗口事件 ----

  /** 是 Claude 的顶层、带标题栏的窗口就返回进程号，否则 null */
  function isCandidate(hwnd) {
    const c = cfg.data;
    if (!c.window_classes.includes(win.getClass(hwnd))) return null;
    if (win.getRoot(hwnd) !== hwnd) return null;
    const { pid } = win.getPidTid(hwnd);
    if (!c.process_names.includes(win.processName(pid))) return null;
    if (!hasCaption(win.getStyle(hwnd))) return null;
    return pid;
  }

  function onWinEvent(hook, event, hwndRaw, idObject, idChild) {
    if (idObject !== 0 || idChild !== 0 || !hwndRaw) return;
    const hwnd = win.num(hwndRaw);
    stats.events += 1;
    try {
      if (event === C.EVENT_OBJECT_DESTROY || event === C.EVENT_OBJECT_HIDE) {
        const wasNew = newWindows.delete(hwnd);
        if (event === C.EVENT_OBJECT_DESTROY) tracker.forget(hwnd);
        if (placed.has(hwnd) && !wasNew) {
          placed.delete(hwnd);
          stats.claudeEvents += 1;
          if (!paused) {
            if (cfg.data.rearrange_on_close) {
              // 重排完会顺带把所有窗口提到最前
              L.info(`窗口关闭/隐藏：${hwnd}`);
              schedule('窗口关闭', cfg.data.delay_ms);
            } else if (cfg.data.raise_all) {
              scheduleRaise('窗口关闭', 150);
            }
          }
        }
        return;
      }
      const pid = isCandidate(hwnd);
      if (pid == null) return;
      stats.claudeEvents += 1;
      if (event === C.EVENT_OBJECT_CREATE) {
        tracker.noteCreated(hwnd);
        return;
      }
      if (event === C.EVENT_SYSTEM_FOREGROUND) {
        reloadConfig();
        if (paused || !cfg.data.raise_all) return;
        if (Date.now() < ignoreUntil) return; // 被控端自己为远程输入切的前台，不算用户切换
        if (hwnd === tracker.mainOf(pid, candidatesOf(cfg.data, pid))) return; // 主窗口不算
        if (mouseDownInside(hwnd)) return; // 直接点窗口切过来的，不动别的窗口
        scheduleRaise('切换到 Claude 窗口', 60);
        return;
      }
      if (event === C.EVENT_SYSTEM_MINIMIZESTART || event === C.EVENT_SYSTEM_MINIMIZEEND) {
        reloadConfig();
        if (paused) return;
        if (hwnd === tracker.mainOf(pid, candidatesOf(cfg.data, pid)) && !cfg.data.include_main_window) return;
        // 最小化时不动别的窗口；还原时重排一次，按它原来的位置插回去
        if (event === C.EVENT_SYSTEM_MINIMIZEEND) {
          L.info(`窗口还原：${hwnd}「${win.getTitle(hwnd)}」`);
          schedule('窗口还原', cfg.data.delay_ms);
        }
        return;
      }
      if (event !== C.EVENT_OBJECT_SHOW) return;
      // 显示：Claude 会复用隐藏的旧窗口来开新会话，所以以“显示”为准，不只看“创建”
      reloadConfig();
      if (paused) return;
      const main = tracker.mainOf(pid, candidatesOf(cfg.data, pid));
      if (hwnd === main && !cfg.data.include_main_window) return;
      newWindows.set(hwnd, Date.now());
      L.info(`发现新窗口：${hwnd}「${win.getTitle(hwnd)}」`);
      schedule('新窗口', cfg.data.delay_ms);
    } catch (err) {
      L.error('处理窗口事件出错', err);
    }
  }

  // ---- 对外接口 ----

  function start() {
    if (hooks.length) return true;
    reloadConfig();
    if (unregisterTimer) {
      clearTimeout(unregisterTimer);
      unregisterTimer = null;
    }
    if (!winEventCb) winEventCb = win.registerWinEventProc(onWinEvent);
    const flags = C.WINEVENT_OUTOFCONTEXT | C.WINEVENT_SKIPOWNPROCESS;
    const ranges = [
      [C.EVENT_OBJECT_CREATE, C.EVENT_OBJECT_HIDE, '窗口创建/销毁/显示/隐藏'],
      // 最小化 / 还原事件：还原出来的窗口要重新排进去，免得和别的窗口叠在一起
      [C.EVENT_SYSTEM_MINIMIZESTART, C.EVENT_SYSTEM_MINIMIZEEND, '最小化/还原'],
      // 前台切换事件：从任务栏 / Alt+Tab 切到某个 Claude 窗口时，把所有 Claude 窗口提到最前
      [C.EVENT_SYSTEM_FOREGROUND, C.EVENT_SYSTEM_FOREGROUND, '前台切换'],
    ];
    for (const [min, max, name] of ranges) {
      const h = win.setWinEventHook(min, max, winEventCb, flags);
      if (h) hooks.push(h);
      else L.error(`安装窗口事件钩子失败（${name}）`);
    }
    if (!hooks.length) return false;
    stats.startedAt = Date.now();
    L.info(
      `平铺已启动（配置 ${cfg.path}，自动平铺${paused ? '已暂停' : '开启'}${dryRun ? '，演练模式：只算不动窗口' : ''}）`
    );
    if (cfg.data.arrange_on_start && !paused) schedule('启动', cfg.data.delay_ms);
    return true;
  }

  function stop() {
    const wasRunning = hooks.length > 0;
    for (const h of hooks) win.unhookWinEvent(h);
    hooks = [];
    for (const name of Object.keys(timers)) clearTimer(name);
    epoch += 1;
    rerun = false;
    newWindows.clear();
    verifyTargets = [];
    for (const resolve of waiters.splice(0)) resolve(null);
    // 取消钩子之后，系统队列里可能还有已经发出的事件，回调过一会儿再注销
    if (winEventCb && !unregisterTimer) {
      unregisterTimer = setTimeout(() => {
        unregisterTimer = null;
        if (!hooks.length && winEventCb) {
          win.unregisterCallback(winEventCb);
          winEventCb = null;
        }
      }, 2000);
    }
    if (wasRunning) L.info('平铺已停止');
  }

  /** 马上重排一次（和 Python 版 /tile 一样过 50 毫秒执行）。返回的 Promise 在排完后给出排列结果的描述，被取消时给 null */
  function arrange(reason = '手动') {
    return new Promise((resolve) => {
      waiters.push(resolve);
      schedule(reason, 50);
    });
  }

  /** 把所有 Claude 会话窗口提到最前，返回处理的窗口数 */
  function raiseAll(reason = '手动') {
    reloadConfig();
    raiseReason = reason;
    return doRaise();
  }

  /** 识别结果和排列计划（和 Python 版 --list 的输出一样），不移动任何窗口 */
  function status() {
    reloadConfig();
    const c = cfg.data;
    const lines = ['显示器（按排列顺序）：'];
    const monitors = getMonitors(c.monitor_order);
    monitors.forEach((m, i) => {
      const [L0, T0, R0, B0] = m.work;
      lines.push(
        `  第${i + 1}个排：屏幕序号 ${m.number}${m.primary ? '（主屏）' : ''}，从左数第${m.ltrIndex}个  ` +
          `工作区 ${R0 - L0}x${B0 - T0} @ (${L0},${T0})  缩放 ${Math.round((m.dpi * 100) / 96)}%`
      );
    });
    const windows = collectWindows(c);
    lines.push('', 'Claude 窗口：');
    if (!windows.length) lines.push('  （没找到）');
    for (const w of windows) {
      lines.push(`  ${String(w.hwnd).padEnd(10)} ${(w.skip || '参与平铺').padEnd(8)} ${w.title || '(无标题)'}`);
    }
    const plan = planLayout(c, monitors, windows, [], monitorOf);
    lines.push('', '排列计划（只是预览，不会移动窗口）：');
    for (const p of plan) lines.push(`  ${monitorLabel(p.monitor)}  ${shortTitle(p.win.title)}  -> ${formatRect(p.rect)}`);
    return lines.join('\n');
  }

  return {
    start,
    stop,
    arrange,
    raiseAll,
    status,
    setPaused,
    setMonitorOrder,
    monitorOrderChoices: orderChoices,
    get paused() {
      return paused;
    },
    /** 配置里现在的屏幕顺序（monitor_order）："left-to-right" 这样的写法，或者 [2, 1, 3] 这样自己指定的数组 */
    get monitorOrder() {
      const order = cfg.data.monitor_order;
      return Array.isArray(order) ? [...order] : order;
    },
    /** 配置的快捷键换成 Electron 加速键写法，如 "Control+Alt+Shift+T"；没有或写错了是 '' */
    get hotkey() {
      return getHotkey();
    },
    /** 被控端为远程输入把 Claude 窗口切到前台之前调用：这段时间里的前台切换不触发“全部提到最前” */
    ignoreActivation(ms = 1500) {
      ignoreUntil = Math.max(ignoreUntil, Date.now() + Math.max(0, Number(ms) || 0));
    },
    /** 订阅状态变化：cb({ what: 'paused' | 'hotkey' | 'order', paused, hotkey })。返回取消订阅的函数 */
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    get configPath() {
      return cfg.path;
    },
    get logPath() {
      return logPath;
    },
    get running() {
      return hooks.length > 0;
    },
    get dryRun() {
      return dryRun;
    },
    /** 调试用的计数：收到的事件数、其中 Claude 窗口的事件数、重排次数、提到最前次数 */
    get stats() {
      return { ...stats, lastPlanSize: lastPlan.length };
    },
  };
}

// ---------------------------------------------------------------- 显示器顺序

let orderCfg = null;

/**
 * 按平铺配置的 monitor_order 排好的显示器，和平铺往屏上放窗口的先后一致。
 * 被控端给控制端的窗口列表排先后用（../winorder.js）。不依赖平铺引擎在不在跑：
 * 暂停了、被旧的 Python 版顶掉了、开发时设了 RC_HOST_NO_TILER，列表照样按同一份配置的屏幕顺序排。
 * 配置文件改过会重新读（只比较修改时间）；读失败沿用上一次的。
 */
function orderedMonitors(configPath = defaultConfigPath()) {
  if (!orderCfg || orderCfg.path !== configPath) orderCfg = new Config(configPath);
  else orderCfg.reload();
  win.ensureDpiAware();
  return orderMonitors(win.enumMonitors(), orderCfg.data.monitor_order);
}

module.exports = { createTiler, orderedMonitors };
