'use strict';
/**
 * 窗口平铺的纯计算部分：不调用任何 Win32 接口，输入输出都是普通对象，方便单元测试。
 *
 * 约定：
 *   - 矩形一律是 [left, top, right, bottom] 数组（物理像素）
 *   - 显示器：{ handle, device, rect, work, primary, dpi }，orderMonitors 之后再带上 number（屏幕序号）和 ltrIndex
 *   - 窗口：{ hwnd, pid, tid, title, frame, skip }，frame 是看得见的边框范围，skip 为 null 表示参与平铺，
 *     否则是不参与的原因（"最小化"、"主窗口" ……）
 *   - 配置用和 config.toml 一样的键名（max_per_monitor、gap ……）
 *
 * 这些逻辑和原来 Python 版 claude_tiler.py 的 column_rects / get_monitors / plan_layout 一一对应。
 */

const MAIN_WINDOW_TITLE = 'Claude'; // Claude 桌面端把主窗口标题固定为 "Claude"，页面标题不会覆盖它

// ---------------------------------------------------------------- 格子

/** 把工作区横向分成 k 列，列之间留 gap 像素；除不尽的像素从左边的列开始各多分 1 个 */
function columnRects(work, k, gap) {
  const [L, T, R, B] = work;
  const total = R - L - gap * (k - 1);
  const base = Math.floor(total / k);
  const extra = total - base * k;
  const rects = [];
  let x = L;
  for (let i = 0; i < k; i++) {
    const w = base + (i < extra ? 1 : 0);
    rects.push([x, T, x + w, B]);
    x += w + gap;
  }
  return rects;
}

// ---------------------------------------------------------------- 显示器

/** 屏幕序号：Windows 给每个屏的编号（\\.\DISPLAY1 -> 1），和“显示设置”里“标识”出来的数字一般一致；认不出时为 0 */
function monitorNumber(device) {
  const m = /DISPLAY(\d+)$/.exec(String(device || ''));
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * 屏幕顺序（配置里的 monitor_order）的几种固定写法。
 * 另外还能写成 [2, 3, 1]，按屏幕序号自己指定（托盘菜单“屏幕顺序”里，屏不多时把所有排法都列出来，见 monitorOrderChoices）。
 */
const MONITOR_ORDERS = Object.freeze([
  Object.freeze({ value: 'left-to-right', label: '从左到右' }),
  Object.freeze({ value: 'right-to-left', label: '从右到左' }),
  Object.freeze({ value: 'number', label: '按屏幕序号 1、2、3' }),
  Object.freeze({ value: 'primary', label: '主屏优先，其余从左到右' }),
]);

const DEFAULT_MONITOR_ORDER = 'left-to-right';

/** 屏不超过这么多个时，设置界面把按屏幕序号的所有排法都列出来（3 个屏 6 种；4 个屏就有 24 种，太长） */
const MAX_PERMUTED_MONITORS = 3;

/** 一组数的所有排法，按传进来的先后展开（传进来是从小到大的，出来就是字典序） */
function permutations(list) {
  if (list.length <= 1) return [list.slice()];
  const out = [];
  list.forEach((x, i) => {
    for (const rest of permutations([...list.slice(0, i), ...list.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/**
 * 检查一个要写进配置的屏幕顺序：MONITOR_ORDERS 里的一种写法，或者屏幕序号的数组（正整数、不重复）。
 * 合法时返回它（数组是副本），不合法返回 null。
 */
function checkMonitorOrder(order) {
  if (Array.isArray(order)) {
    const ok =
      order.length > 0 &&
      order.length <= 16 &&
      order.every((n) => Number.isInteger(n) && n > 0 && n < 1000) &&
      new Set(order).size === order.length;
    return ok ? [...order] : null;
  }
  return MONITOR_ORDERS.some((o) => o.value === order) ? order : null;
}

/** 屏幕顺序的叫法：固定写法用它的名字（“从左到右”），数组写成“屏 2 → 3 → 1” */
function monitorOrderText(order) {
  if (Array.isArray(order)) return `屏 ${order.join(' → ')}`;
  const named = MONITOR_ORDERS.find((o) => o.value === order);
  return named ? named.label : String(order);
}

/**
 * 给设置界面（托盘菜单“屏幕顺序”）用：列出能选的屏幕顺序，并标出现在用的是哪一个。
 *
 * 返回的每一项是 { value, label, checked }，value 就是选了以后要写进配置的 monitor_order；
 * 中间可能有一项 { separator: true }，把两组隔开。
 *   - 前面是按位置的排法：从左到右、从右到左、主屏优先。知道现在接着哪些屏时，名字后面带上它实际排出来的
 *     屏幕序号，如“从左到右（屏 3 → 1 → 2）”。
 *   - 屏有 2～3 个、序号都认得出来时，后面再列出按屏幕序号的所有排法（屏 1 → 2 → 3、屏 1 → 3 → 2 ……），
 *     选了写成 [1, 3, 2] 这样的数组；其中从小到大的那一种就是 "number"。
 *   - 屏更多、只有一个、或者序号认不出来时不列排法，只有“按屏幕序号 1、2、3”；这时配置里要是写着
 *     [2, 1, 3] 这样自己指定的顺序，多出一项 custom（选中的就是它，只能在配置文件里改）。
 * 配置里写了不认识的字符串时，实际按默认的从左到右排，所以选中“从左到右”。
 *
 * @param {string|Array} current 配置里的 monitor_order
 * @param {object[]} [monitors] 现在接着的显示器（EnumDisplayMonitors 的结果，或者带 number 的对象）
 */
function monitorOrderChoices(current, monitors = []) {
  const resolve = (order) => orderMonitors(monitors, order).map((m) => m.number);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const numbers = resolve('number');
  const numbered = numbers.every((n, i) => n > 0 && n !== numbers[i - 1]); // 序号都认得出来、没有重复
  const listPermutations = numbered && numbers.length >= 2 && numbers.length <= MAX_PERMUTED_MONITORS;
  const withOrder = (label, order) => (numbered && numbers.length >= 2 ? `${label}（${monitorOrderText(resolve(order))}）` : label);

  const custom = Array.isArray(current);
  const effective = custom ? null : MONITOR_ORDERS.some((o) => o.value === current) ? current : DEFAULT_MONITOR_ORDER;
  const named = (value) => {
    const o = MONITOR_ORDERS.find((x) => x.value === value);
    return { value, label: value === 'number' ? o.label : withOrder(o.label, value), checked: effective === value };
  };

  if (!listPermutations) {
    const list = MONITOR_ORDERS.map((o) => named(o.value));
    if (custom) list.push({ value: [...current], label: `自己指定：屏 ${current.join('、')}`, checked: true, custom: true });
    return list;
  }
  const target = custom ? resolve(current) : null; // 配置里自己指定的顺序，在现在这几个屏上实际排出来的样子
  const list = MONITOR_ORDERS.filter((o) => o.value !== 'number').map((o) => named(o.value));
  list.push({ separator: true });
  for (const p of permutations(numbers)) {
    const isNumber = same(p, numbers);
    list.push({
      value: isNumber ? 'number' : p,
      label: isNumber ? `${monitorOrderText(p)}（按屏幕序号）` : monitorOrderText(p),
      checked: custom ? same(p, target) : isNumber && effective === 'number',
    });
  }
  return list;
}

/**
 * 按配置的顺序排列显示器（先往哪个屏放）。返回新数组，每项是原显示器的副本，带上 number 和 ltrIndex。
 * @param {object[]} monitors 显示器列表（EnumDisplayMonitors 的顺序）
 * @param {string|Array} order "left-to-right"（默认）| "right-to-left" | "number" | "primary" | [2, 1, 3]
 */
function orderMonitors(monitors, order) {
  const mons = monitors.map((m) => ({
    ...m,
    number: m.device != null ? monitorNumber(m.device) : m.number || 0,
    ltrIndex: 0, // 从左数第几个（1 开始）
  }));
  const ltr = [...mons].sort((a, b) => a.rect[0] - b.rect[0] || a.rect[1] - b.rect[1]);
  ltr.forEach((m, i) => {
    m.ltrIndex = i + 1;
  });
  const byNumber = [...ltr].sort((a, b) => (a.number || 999) - (b.number || 999) || a.ltrIndex - b.ltrIndex);
  if (Array.isArray(order)) {
    // 按屏幕序号自己指定顺序，没写到的屏按序号排在后面
    const picked = [];
    for (const n of order) {
      for (const m of byNumber) {
        if (String(m.number) === String(n).trim() && !picked.includes(m)) picked.push(m);
      }
    }
    return picked.concat(byNumber.filter((m) => !picked.includes(m)));
  }
  if (order === 'number') return byNumber; // 按屏幕序号 1、2、3
  if (order === 'primary') return ltr.filter((m) => m.primary).concat(ltr.filter((m) => !m.primary)); // 主屏优先，其余从左到右
  if (order === 'right-to-left') return [...ltr].reverse(); // 从最右边的屏开始，依次往左（每个屏里面照样从左往右摆）
  return ltr; // 默认 "left-to-right"：从最左边的屏开始，依次往右
}

/**
 * 窗口中心点落在哪个显示器上（monitors 里的下标）。不在任何屏上时取最近的屏，和
 * MonitorFromPoint(MONITOR_DEFAULTTONEAREST) 一样。没有显示器时返回 null。
 * 引擎里用真正的 MonitorFromPoint，这里是给单元测试和没有 Win32 的场合用的等价实现。
 */
function monitorIndexOf(frame, monitors) {
  const cx = Math.floor((frame[0] + frame[2]) / 2);
  const cy = Math.floor((frame[1] + frame[3]) / 2);
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < monitors.length; i++) {
    const [L, T, R, B] = monitors[i].rect;
    if (L <= cx && cx < R && T <= cy && cy < B) return i;
    const dx = Math.max(L - cx, 0, cx - (R - 1));
    const dy = Math.max(T - cy, 0, cy - (B - 1));
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** 日志 / 状态里显示的显示器名字，如 "屏1(主屏 2560x1392 @150%)" */
function monitorLabel(m) {
  const [L, T, R, B] = m.work;
  return `屏${m.number}(${m.primary ? '主屏 ' : ''}${R - L}x${B - T} @${Math.round((m.dpi * 100) / 96)}%)`;
}

// ---------------------------------------------------------------- 窗口

/** 日志里显示的窗口短标题 */
function shortTitle(title) {
  const t = title || '(无标题)';
  const chars = Array.from(t);
  return chars.length <= 24 ? t : chars.slice(0, 23).join('') + '…';
}

/**
 * 窗口不参与平铺的原因；参与时返回 null。
 * flags 里每项可以是布尔值，也可以是返回布尔值的函数（引擎里传函数，按顺序用到时才去查，和 Python 版一样短路）：
 *   visible, cloaked（不在当前虚拟桌面）, toolWindow, owned（有所有者窗口）, isMain, iconic, zoomed, hung
 */
function skipReason(cfg, win, flags) {
  const get = (k) => (typeof flags[k] === 'function' ? !!flags[k]() : !!flags[k]);
  const [L, T, R, B] = win.frame;
  const title = win.title || '';
  if (!get('visible')) return '隐藏';
  if (get('cloaked')) return '不在当前桌面';
  if (get('toolWindow')) return '工具窗口';
  if (get('owned')) return '从属窗口';
  if (get('isMain') && !cfg.include_main_window) return '主窗口';
  if ((cfg.exclude_title_prefixes || []).some((p) => title.startsWith(p))) return '排除的标题';
  if (get('iconic')) return '最小化';
  if (cfg.skip_maximized && get('zoomed')) return '最大化';
  if (R - L < 200 || B - T < 150) return '太小';
  if (get('hung')) return '无响应';
  return null;
}

/**
 * 识别 Claude 主窗口。
 *
 * Claude 桌面端主窗口和会话弹出窗口的进程、类名、样式都一样，区别是主窗口标题被固定为
 * "Claude"。但新开的会话窗口在会话还没起标题时，标题也可能暂时是 "Claude"，所以再加一条：
 * 主窗口是 Claude 进程启动时最先创建的那个窗口，之后再出现的都是会话窗口。
 *
 * probe 提供三个查询函数：isWindow(hwnd)、getTitle(hwnd)、windowRect(hwnd)。
 */
class Tracker {
  constructor(probe) {
    this.probe = probe;
    this.mainByPid = new Map();
    this.createdSeq = new Map(); // 运行期间看到的窗口创建顺序
    this.seq = 0;
  }

  noteCreated(hwnd) {
    this.seq += 1;
    this.createdSeq.set(hwnd, this.seq);
    if (this.createdSeq.size > 5000) {
      let n = 0;
      for (const k of this.createdSeq.keys()) {
        if (n++ >= 2500) break;
        this.createdSeq.delete(k);
      }
    }
  }

  forget(hwnd) {
    this.createdSeq.delete(hwnd);
    for (const [pid, h] of this.mainByPid) {
      if (h === hwnd) this.mainByPid.delete(pid);
    }
  }

  /** candidates：这个进程里所有带标题栏的顶层窗口 [[hwnd, title], ...]。返回主窗口句柄或 null */
  mainOf(pid, candidates) {
    const h = this.mainByPid.get(pid);
    if (h && this.probe.isWindow(h) && this.probe.getTitle(h) === MAIN_WINDOW_TITLE) return h;
    let named = candidates.filter((c) => c[1] === MAIN_WINDOW_TITLE).map((c) => c[0]);
    if (!named.length) return null;
    if (named.length > 1) {
      // 先创建的是主窗口；运行前就有的窗口算最早（-1）。再分不出来就取面积大的
      const keyed = named.map((x) => {
        const [L, T, R, B] = this.probe.windowRect(x);
        return { x, seq: this.createdSeq.has(x) ? this.createdSeq.get(x) : -1, area: (R - L) * (B - T) };
      });
      keyed.sort((a, b) => a.seq - b.seq || b.area - a.area);
      named = keyed.map((k) => k.x);
    }
    this.mainByPid.set(pid, named[0]);
    return named[0];
  }

  /** 认出来过的所有主窗口 */
  mains() {
    return new Set(this.mainByPid.values());
  }
}

// ---------------------------------------------------------------- 排列计划

/**
 * 算出每个参与平铺的窗口该放到哪里。返回 [{ win, rect, monitor }]，rect 是目标可见范围。
 *
 * @param {object} cfg 配置（max_per_monitor、fill_screen、keep_monitor、gap）
 * @param {object[]} monitors 已经按 monitor_order 排好序的显示器
 * @param {object[]} windows 窗口列表（skip 不为 null 的不参与）
 * @param {Array} newOrder 本次新出现的窗口句柄（按出现先后），排在最后、放进第一个还有空位的屏
 * @param {Function} monitorOf (frame, monitors) => 下标或 null，默认用 monitorIndexOf
 */
function planLayout(cfg, monitors, windows, newOrder = [], monitorOf = monitorIndexOf) {
  const cap = cfg.max_per_monitor;
  const elig = windows.filter((w) => w.skip == null);
  const newRank = new Map();
  newOrder.forEach((h, i) => newRank.set(h, i));
  const fresh = elig.filter((w) => newRank.has(w.hwnd)).sort((a, b) => newRank.get(a.hwnd) - newRank.get(b.hwnd));
  const old = elig.filter((w) => !newRank.has(w.hwnd));

  const miCache = new Map();
  const mi = (w) => {
    if (!miCache.has(w)) {
      const i = monitorOf(w.frame, monitors);
      miCache.set(w, i == null ? null : i);
    }
    return miCache.get(w);
  };
  // 按位置排先后：先看在第几个屏，再从左到右、从上到下
  const posKey = (w) => {
    const i = mi(w);
    return [i == null ? monitors.length : i, (w.frame[0] + w.frame[2]) / 2, (w.frame[1] + w.frame[3]) / 2];
  };
  const byPos = (a, b) => {
    const ka = posKey(a);
    const kb = posKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  };

  const buckets = monitors.map(() => []);
  let pending = [];
  if (cfg.keep_monitor) {
    // 老窗口留在自己所在的屏，同屏按从左到右保持原来的先后
    for (const w of [...old].sort(byPos)) {
      const i = mi(w);
      if (i == null || i >= buckets.length || buckets[i].length >= cap) pending.push(w);
      else buckets[i].push(w);
    }
  } else {
    pending = [...old].sort(byPos);
  }
  pending = pending.concat(fresh);

  const overflow = [];
  for (const w of pending) {
    const b = buckets.find((x) => x.length < cap);
    if (b) b.push(w);
    else overflow.push(w);
  }

  const plan = [];
  const slots = [];
  monitors.forEach((m, i) => {
    const b = buckets[i];
    if (!b.length) return;
    const rects = cfg.fill_screen
      ? columnRects(m.work, b.length, cfg.gap) // 按本屏窗口数等分、铺满
      : columnRects(m.work, cap, cfg.gap).slice(0, b.length); // 默认：每个窗口固定占 1/N 宽，从左往右摆
    b.forEach((w, j) => {
      plan.push({ win: w, rect: rects[j], monitor: m });
      slots.push({ rect: rects[j], monitor: m });
    });
  });
  // 所有屏都满了：多出来的窗口按顺序叠到已有的格子上
  overflow.forEach((w, i) => {
    if (!slots.length) return;
    const s = slots[i % slots.length];
    plan.push({ win: w, rect: s.rect, monitor: s.monitor });
  });
  return plan;
}

/** 一行话描述排列计划，写日志用 */
function describePlan(plan, monitors) {
  const parts = [];
  for (const m of monitors) {
    const names = plan.filter((p) => p.monitor === m).map((p) => shortTitle(p.win.title));
    if (names.length) parts.push(`${monitorLabel(m)}: ${names.join(' | ')}`);
  }
  return parts.length ? parts.join('；') : '（没有需要排的窗口）';
}

/** 矩形写成 "(0, 0, 853, 1392)"，和 Python 版日志一样 */
function formatRect(r) {
  return `(${r.join(', ')})`;
}

// ---------------------------------------------------------------- 快捷键

const MOD_ORDER = ['Control', 'Alt', 'Shift', 'Super'];

/**
 * 把配置里的快捷键（如 "ctrl+alt+shift+t"）换成 Electron 的加速键写法（"Control+Alt+Shift+T"）。
 * 空串返回 ''；写错了抛异常（和 Python 版 parse_hotkey 认的写法一样：ctrl/control、alt、shift、win/super，
 * 加一个字母、数字或 F1~F24）。
 */
function hotkeyToAccelerator(s) {
  if (!s) return '';
  const mods = new Set();
  let key = null;
  for (const part of String(s).toLowerCase().replace(/ /g, '').split('+')) {
    if (part === 'ctrl' || part === 'control') mods.add('Control');
    else if (part === 'alt') mods.add('Alt');
    else if (part === 'shift') mods.add('Shift');
    else if (part === 'win' || part === 'super') mods.add('Super');
    else if (/^[a-z0-9]$/.test(part)) key = part.toUpperCase();
    else if (/^f\d+$/.test(part) && Number(part.slice(1)) >= 1 && Number(part.slice(1)) <= 24) key = `F${Number(part.slice(1))}`;
    else throw new Error(`不认识的按键：${part}`);
  }
  if (!key) throw new Error(`快捷键里没有主键：${s}`);
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

module.exports = {
  MAIN_WINDOW_TITLE,
  columnRects,
  monitorNumber,
  MONITOR_ORDERS,
  DEFAULT_MONITOR_ORDER,
  checkMonitorOrder,
  monitorOrderText,
  monitorOrderChoices,
  orderMonitors,
  monitorIndexOf,
  monitorLabel,
  shortTitle,
  skipReason,
  Tracker,
  planLayout,
  describePlan,
  formatRect,
  hotkeyToAccelerator,
};
