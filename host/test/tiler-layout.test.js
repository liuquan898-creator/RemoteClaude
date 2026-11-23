'use strict';
/**
 * 窗口平铺纯计算部分的单元测试（不碰任何真实窗口）。
 * 场景部分移植自 Python 版 test_tiler.py：那边用替身窗口在真屏幕上跑，这里只验证排列计划本身。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  columnRects,
  monitorNumber,
  MONITOR_ORDERS,
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
} = require('../tiler/layout');

const BASE_CFG = Object.freeze({
  max_per_monitor: 3,
  fill_screen: false,
  keep_monitor: false,
  gap: 0,
  include_main_window: false,
  skip_maximized: false,
  exclude_title_prefixes: ['Claude · '],
});
const cfgWith = (over = {}) => ({ ...BASE_CFG, ...over });

// 三个屏：枚举顺序故意打乱；屏 2 在最左边，主屏是屏 1
function rawMonitors() {
  return [
    { handle: 11, device: '\\\\.\\DISPLAY1', rect: [2560, 0, 5120, 1440], work: [2560, 0, 5120, 1392], primary: true, dpi: 144 },
    { handle: 33, device: '\\\\.\\DISPLAY3', rect: [5120, 0, 7040, 1080], work: [5120, 0, 7040, 1040], primary: false, dpi: 96 },
    { handle: 22, device: '\\\\.\\DISPLAY2', rect: [0, 0, 2560, 1440], work: [0, 0, 2560, 1392], primary: false, dpi: 120 },
  ];
}

const W = (hwnd, frame, extra = {}) => ({ hwnd, pid: 1, tid: 1, title: `W${hwnd}`, frame, skip: null, ...extra });

/** 把计划整理成 { 显示器序号: [hwnd...] }，方便比较 */
function layoutOf(plan) {
  const out = {};
  for (const p of plan) (out[p.monitor.number] = out[p.monitor.number] || []).push(p.win.hwnd);
  return out;
}

// ---------------------------------------------------------------- 格子

test('columnRects：等分，除不尽的像素从左边的列开始多分', () => {
  assert.deepEqual(columnRects([0, 0, 1920, 1040], 3, 0), [
    [0, 0, 640, 1040],
    [640, 0, 1280, 1040],
    [1280, 0, 1920, 1040],
  ]);
  assert.deepEqual(
    columnRects([0, 0, 1000, 500], 3, 0).map((r) => r[2] - r[0]),
    [334, 333, 333]
  );
});

test('columnRects：带缝时最后一列正好贴到右边', () => {
  const rects = columnRects([100, 50, 1100, 550], 3, 10);
  assert.deepEqual(rects, [
    [100, 50, 427, 550],
    [437, 50, 764, 550],
    [774, 50, 1100, 550],
  ]);
});

test('columnRects：偏移的工作区（负坐标）', () => {
  assert.deepEqual(columnRects([2560, -234, 6400, 1854], 3, 0)[0], [2560, -234, 3840, 1854]);
});

// ---------------------------------------------------------------- 显示器

test('monitorNumber：从设备名取屏幕序号', () => {
  assert.equal(monitorNumber('\\\\.\\DISPLAY1'), 1);
  assert.equal(monitorNumber('\\\\.\\DISPLAY12'), 12);
  assert.equal(monitorNumber('weird'), 0);
});

test('orderMonitors："number" 按屏幕序号，并标出从左数第几个', () => {
  const mons = orderMonitors(rawMonitors(), 'number');
  assert.deepEqual(mons.map((m) => m.number), [1, 2, 3]);
  assert.deepEqual(mons.map((m) => m.ltrIndex), [2, 1, 3]);
});

test('orderMonitors：没写或不认识的顺序按默认的 "left-to-right" 处理', () => {
  assert.deepEqual(orderMonitors(rawMonitors(), 'whatever').map((m) => m.number), [2, 1, 3]);
  assert.deepEqual(orderMonitors(rawMonitors()).map((m) => m.number), [2, 1, 3]);
});

test('orderMonitors："left-to-right" 和 "primary"', () => {
  assert.deepEqual(orderMonitors(rawMonitors(), 'left-to-right').map((m) => m.number), [2, 1, 3]);
  assert.deepEqual(orderMonitors(rawMonitors(), 'primary').map((m) => m.number), [1, 2, 3]);
  const mons = rawMonitors();
  mons[0].primary = false;
  mons[1].primary = true; // 屏 3 是主屏
  assert.deepEqual(orderMonitors(mons, 'primary').map((m) => m.number), [3, 2, 1]);
});

test('orderMonitors："right-to-left" 从最右边的屏依次往左', () => {
  const mons = orderMonitors(rawMonitors(), 'right-to-left');
  assert.deepEqual(mons.map((m) => m.number), [3, 1, 2]);
  assert.deepEqual(mons.map((m) => m.ltrIndex), [3, 2, 1]); // “从左数第几个”不跟着倒过来
});

test('MONITOR_ORDERS：菜单里能选的几种写法 orderMonitors 都认，排出来各不相同', () => {
  assert.deepEqual(MONITOR_ORDERS.map((o) => o.value), ['left-to-right', 'right-to-left', 'number', 'primary']);
  const mons = rawMonitors();
  mons[0].primary = false;
  mons[1].primary = true; // 屏 3（最右边）是主屏，这样四种顺序互不相同
  const results = MONITOR_ORDERS.map((o) => orderMonitors(mons, o.value).map((m) => m.number).join(','));
  assert.deepEqual(results, ['2,1,3', '3,1,2', '1,2,3', '3,2,1']);
  for (const o of MONITOR_ORDERS) assert.ok(o.label, o.value);
});

test('checkMonitorOrder：固定写法和屏幕序号数组才合法', () => {
  for (const o of MONITOR_ORDERS) assert.equal(checkMonitorOrder(o.value), o.value);
  const order = [2, 3, 1];
  assert.deepEqual(checkMonitorOrder(order), [2, 3, 1]);
  assert.notEqual(checkMonitorOrder(order), order); // 给的是副本
  assert.deepEqual(checkMonitorOrder([2]), [2]);
  for (const bad of ['whatever', '', undefined, null, 3, {}, [], [1, 1], [0, 1], [-1], [1.5], ['2', 1], [1, 2000]]) {
    assert.equal(checkMonitorOrder(bad), null, JSON.stringify(bad));
  }
});

test('monitorOrderText：固定写法用名字，数组写成“屏 2 → 3 → 1”', () => {
  assert.equal(monitorOrderText('left-to-right'), '从左到右');
  assert.equal(monitorOrderText('number'), '按屏幕序号 1、2、3');
  assert.equal(monitorOrderText([2, 3, 1]), '屏 2 → 3 → 1');
});

/** 选项整理成 [勾没勾, 名字]，分隔线是 '---' */
const choiceRows = (list) => list.map((c) => (c.separator ? '---' : `${c.checked ? '[x]' : '[ ]'} ${c.label}`));
const checkedLabels = (list) => list.filter((c) => c.checked).map((c) => c.label);

test('monitorOrderChoices：三个屏时，按位置的三种后面列出按屏幕序号的 6 种排法', () => {
  const list = monitorOrderChoices('left-to-right', rawMonitors()); // 屏 2 在最左边，屏 1 是主屏、在中间，屏 3 在右边
  assert.deepEqual(choiceRows(list), [
    '[x] 从左到右（屏 2 → 1 → 3）',
    '[ ] 从右到左（屏 3 → 1 → 2）',
    '[ ] 主屏优先，其余从左到右（屏 1 → 2 → 3）',
    '---',
    '[ ] 屏 1 → 2 → 3（按屏幕序号）',
    '[ ] 屏 1 → 3 → 2',
    '[ ] 屏 2 → 1 → 3',
    '[ ] 屏 2 → 3 → 1',
    '[ ] 屏 3 → 1 → 2',
    '[ ] 屏 3 → 2 → 1',
  ]);
  assert.deepEqual(
    list.filter((c) => !c.separator).map((c) => c.value),
    ['left-to-right', 'right-to-left', 'primary', 'number', [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]]
  );
  assert.ok(list.every((c) => !c.custom));
});

test('monitorOrderChoices：每一项选了以后，排出来的就是名字里写的顺序', () => {
  for (const c of monitorOrderChoices('left-to-right', rawMonitors())) {
    if (c.separator) continue;
    assert.deepEqual(checkMonitorOrder(c.value), c.value, c.label); // 能原样写进配置
    const actual = `屏 ${orderMonitors(rawMonitors(), c.value).map((m) => m.number).join(' → ')}`;
    assert.ok(c.label.includes(actual), `${c.label} 实际是 ${actual}`);
    // 选了它以后再列一遍，勾的就是它
    assert.deepEqual(checkedLabels(monitorOrderChoices(c.value, rawMonitors())), [c.label]);
  }
});

test('monitorOrderChoices：配置里自己指定的顺序，勾在它实际排出来的那一种上', () => {
  const checked = (current) => checkedLabels(monitorOrderChoices(current, rawMonitors()));
  assert.deepEqual(checked([2, 3, 1]), ['屏 2 → 3 → 1']);
  assert.deepEqual(checked([2, 3]), ['屏 2 → 3 → 1']); // 没写到的屏排在后面
  assert.deepEqual(checked(['3', 9, 1]), ['屏 3 → 1 → 2']); // 字符串序号也认，没有的屏不管
  assert.deepEqual(checked([1, 2, 3]), ['屏 1 → 2 → 3（按屏幕序号）']);
  assert.deepEqual(checked('number'), ['屏 1 → 2 → 3（按屏幕序号）']);
  assert.deepEqual(checked('right-to-left'), ['从右到左（屏 3 → 1 → 2）']);
});

test('monitorOrderChoices：不认识的写法实际按从左到右排，所以选中“从左到右”', () => {
  for (const odd of ['whatever', '', undefined, null, 3]) {
    assert.deepEqual(checkedLabels(monitorOrderChoices(odd, rawMonitors())), ['从左到右（屏 2 → 1 → 3）']);
    assert.deepEqual(checkedLabels(monitorOrderChoices(odd)), ['从左到右']);
  }
});

test('monitorOrderChoices：两个屏列 2 种排法；只有一个屏时不列', () => {
  const two = rawMonitors().slice(0, 2); // 屏 1（左）、屏 3（右）
  assert.deepEqual(choiceRows(monitorOrderChoices([3, 1], two)), [
    '[ ] 从左到右（屏 1 → 3）',
    '[ ] 从右到左（屏 3 → 1）',
    '[ ] 主屏优先，其余从左到右（屏 1 → 3）',
    '---',
    '[ ] 屏 1 → 3（按屏幕序号）',
    '[x] 屏 3 → 1',
  ]);
  assert.deepEqual(choiceRows(monitorOrderChoices('primary', rawMonitors().slice(0, 1))), [
    '[ ] 从左到右',
    '[ ] 从右到左',
    '[ ] 按屏幕序号 1、2、3',
    '[x] 主屏优先，其余从左到右',
  ]);
});

test('monitorOrderChoices：屏太多、序号认不出来或不知道有哪些屏时不列排法，自己指定的顺序单列一项', () => {
  const four = [...rawMonitors(), { handle: 44, device: '\\\\.\\DISPLAY4', rect: [7040, 0, 8960, 1080], work: [7040, 0, 8960, 1040], primary: false, dpi: 96 }];
  assert.deepEqual(choiceRows(monitorOrderChoices('number', four)), [
    '[ ] 从左到右（屏 2 → 1 → 3 → 4）',
    '[ ] 从右到左（屏 4 → 3 → 1 → 2）',
    '[x] 按屏幕序号 1、2、3',
    '[ ] 主屏优先，其余从左到右（屏 1 → 2 → 3 → 4）',
  ]);
  const order = [4, 2, 1, 3];
  const list = monitorOrderChoices(order, four);
  const last = list[list.length - 1];
  assert.deepEqual(last, { value: [4, 2, 1, 3], label: '自己指定：屏 4、2、1、3', checked: true, custom: true });
  assert.notEqual(last.value, order); // 给的是副本
  assert.deepEqual(list.filter((c) => c.checked), [last]);

  const odd = rawMonitors();
  odd[0].device = 'odd'; // 有一个屏认不出序号
  assert.deepEqual(choiceRows(monitorOrderChoices('left-to-right', odd)), [
    '[x] 从左到右',
    '[ ] 从右到左',
    '[ ] 按屏幕序号 1、2、3',
    '[ ] 主屏优先，其余从左到右',
  ]);
  assert.deepEqual(choiceRows(monitorOrderChoices([2, 1, 3])), [
    '[ ] 从左到右',
    '[ ] 从右到左',
    '[ ] 按屏幕序号 1、2、3',
    '[ ] 主屏优先，其余从左到右',
    '[x] 自己指定：屏 2、1、3',
  ]);
});

test('orderMonitors：自己指定顺序，没写到的按序号排在后面；字符串序号也认', () => {
  assert.deepEqual(orderMonitors(rawMonitors(), [3, 1]).map((m) => m.number), [3, 1, 2]);
  assert.deepEqual(orderMonitors(rawMonitors(), ['2', ' 3 ']).map((m) => m.number), [2, 3, 1]);
  assert.deepEqual(orderMonitors(rawMonitors(), [9]).map((m) => m.number), [1, 2, 3]);
});

test('orderMonitors：认不出序号的屏排在最后', () => {
  const mons = rawMonitors();
  mons[0].device = 'odd';
  assert.deepEqual(orderMonitors(mons, 'number').map((m) => m.handle), [22, 33, 11]);
});

test('orderMonitors：不改动传进来的对象', () => {
  const mons = rawMonitors();
  orderMonitors(mons, 'number');
  assert.equal(mons[0].ltrIndex, undefined);
});

test('monitorIndexOf：中心点所在的屏；不在任何屏上时取最近的屏', () => {
  const mons = orderMonitors(rawMonitors(), 'number'); // 屏1 [2560..5120)、屏2 [0..2560)、屏3 [5120..7040)
  assert.equal(monitorIndexOf([100, 100, 500, 500], mons), 1);
  assert.equal(monitorIndexOf([3000, 100, 3400, 500], mons), 0);
  assert.equal(monitorIndexOf([6900, 2000, 7300, 2400], mons), 2); // 屏3 右下方外面
  assert.equal(monitorIndexOf([-900, 100, -500, 500], mons), 1); // 屏2 左边外面
  assert.equal(monitorIndexOf([0, 0, 10, 10], []), null);
});

test('monitorLabel：和 Python 版日志一样的写法', () => {
  const [m1, m2] = orderMonitors(rawMonitors(), 'number');
  assert.equal(monitorLabel(m1), '屏1(主屏 2560x1392 @150%)');
  assert.equal(monitorLabel(m2), '屏2(2560x1392 @125%)');
});

// ---------------------------------------------------------------- 场景：移植自 test_tiler.py

/**
 * 模拟器：记住每个窗口的可见范围，每次“重排”按计划把窗口挪到目标位置。
 * 新窗口像 test_tiler.py 的替身窗口一样开在屏1上 (OX+80+40n, OY+80+40n)，700x500。
 */
function makeDesk(cfg = cfgWith()) {
  const monitors = orderMonitors(rawMonitors(), 'number');
  const [OX, OY] = monitors[0].work;
  const wins = new Map(); // n -> 窗口
  const desk = {
    monitors,
    wins,
    open(n) {
      wins.set(n, W(n, [OX + 80 + 40 * n, OY + 80 + 40 * n, OX + 780 + 40 * n, OY + 580 + 40 * n]));
    },
    close(n) {
      wins.delete(n);
    },
    arrange(newOrder = []) {
      const plan = planLayout(cfg, monitors, [...wins.values()], newOrder);
      for (const p of plan) p.win.frame = [...p.rect];
      return plan;
    },
    expect(layout) {
      for (const [num, ns] of Object.entries(layout)) {
        const m = monitors.find((x) => x.number === Number(num));
        const cols = columnRects(m.work, 3, 0);
        ns.forEach((n, i) => assert.deepEqual(wins.get(n).frame, cols[i], `W${n} 应该在屏${num} 第${i + 1}格`));
      }
    },
  };
  return desk;
}

test('场景：依次开窗口、连着开、跨屏、最大化、关窗口补位、拖乱后重排、最小化还原、暂停时出现的窗口', () => {
  const d = makeDesk();
  // 1~3：屏1上从左往右摆，每个固定 1/3 宽，只有一个时不铺满
  d.open(1);
  assert.deepEqual(layoutOf(d.arrange([1])), { 1: [1] });
  d.expect({ 1: [1] });
  d.open(2);
  d.arrange([2]);
  d.expect({ 1: [1, 2] });
  d.open(3);
  d.arrange([3]);
  d.expect({ 1: [1, 2, 3] });
  // 4：屏1满了放屏2
  d.open(4);
  d.arrange([4]);
  d.expect({ 1: [1, 2, 3], 2: [4] });
  // 5、6 在防抖时间内连着开：按出现先后排（6 的位置更靠右下，但 5 先出现）
  d.open(6);
  d.open(5);
  d.arrange([5, 6]);
  d.expect({ 1: [1, 2, 3], 2: [4, 5, 6] });
  // 7：进屏3
  d.open(7);
  d.arrange([7]);
  d.expect({ 1: [1, 2, 3], 2: [4, 5, 6], 3: [7] });
  // 最大化 W5（可见范围变成屏2整个工作区），再开 W8：W5 按 1/3 排回原位
  d.wins.get(5).frame = [...d.monitors[1].work];
  d.open(8);
  d.arrange([8]);
  d.expect({ 1: [1, 2, 3], 2: [4, 5, 6], 3: [7, 8] });
  // 关掉 W2：后面的窗口依次往前补，必要时跨屏
  d.close(2);
  d.arrange();
  d.expect({ 1: [1, 3, 4], 2: [5, 6, 7], 3: [8] });
  d.close(6);
  d.arrange();
  d.expect({ 1: [1, 3, 4], 2: [5, 7, 8] });
  d.open(9);
  d.arrange([9]);
  d.expect({ 1: [1, 3, 4], 2: [5, 7, 8], 3: [9] });
  // 手动拖乱 W1，再手动重排：W1 还在 W3 左边，回到原位
  const [OX, OY] = d.monitors[0].work;
  d.wins.get(1).frame = [OX + 400, OY + 400, OX + 900, OY + 800];
  d.arrange();
  d.expect({ 1: [1, 3, 4], 2: [5, 7, 8], 3: [9] });
  // 最小化 W3：不占位置（这时若重排，后面的会往前补）
  d.wins.get(3).skip = '最小化';
  const whileMin = planLayout(cfgWith(), d.monitors, [...d.wins.values()]);
  assert.deepEqual(layoutOf(whileMin), { 1: [1, 4, 5], 2: [7, 8, 9] });
  // 实际上最小化不触发重排；还原 W3 时重排，它按原来的位置插回去
  d.wins.get(3).skip = null;
  d.arrange();
  d.expect({ 1: [1, 3, 4], 2: [5, 7, 8], 3: [9] });
  // 暂停时出现的 W10 不算新窗口，恢复后手动重排：按它当前的位置插进去，后面的依次后移
  d.open(10);
  d.arrange();
  d.expect({ 1: [1, 10, 3], 2: [4, 5, 7], 3: [8, 9] });
  // 所有窗口互不重叠
  const fr = [...d.wins.values()].map((w) => w.frame);
  for (let i = 0; i < fr.length; i++) {
    for (let j = i + 1; j < fr.length; j++) {
      const [a, b] = [fr[i], fr[j]];
      const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      assert.ok(!(ox > 0 && oy > 0), `窗口重叠：${formatRect(a)} 和 ${formatRect(b)}`);
    }
  }
});

// ---------------------------------------------------------------- planLayout 其它情况

test('planLayout：老窗口按位置排先后（先看屏，再从左到右、从上到下）', () => {
  const mons = orderMonitors(rawMonitors(), 'number');
  const wins = [
    W(1, [3500, 100, 3900, 500]), // 屏1 中间
    W(2, [100, 600, 500, 900]), // 屏2 下面
    W(3, [2600, 100, 3000, 500]), // 屏1 左边
    W(4, [100, 100, 500, 400]), // 屏2 上面（和 W2 中心 x 一样）
  ];
  const plan = planLayout(cfgWith({ max_per_monitor: 2 }), mons, wins);
  assert.deepEqual(layoutOf(plan), { 1: [3, 1], 2: [4, 2] });
});

test('planLayout：新窗口排在最后，按出现先后，不看位置', () => {
  const mons = orderMonitors(rawMonitors(), 'number');
  const wins = [W(1, [2600, 0, 3000, 400]), W(2, [2560, 0, 2900, 400]), W(3, [4000, 0, 4400, 400])];
  const plan = planLayout(cfgWith(), mons, wins, [3, 2]);
  assert.deepEqual(plan.map((p) => p.win.hwnd), [1, 3, 2]);
});

test('planLayout：skip 不为空的窗口不参与', () => {
  const mons = orderMonitors(rawMonitors(), 'number');
  const wins = [W(1, [2600, 0, 3000, 400], { skip: '主窗口' }), W(2, [2600, 0, 3000, 400]), W(3, [2600, 0, 3000, 400], { skip: '最小化' })];
  assert.deepEqual(planLayout(cfgWith(), mons, wins).map((p) => p.win.hwnd), [2]);
});

test('planLayout：fill_screen 按本屏窗口数等分铺满', () => {
  const mons = orderMonitors(rawMonitors(), 'number');
  const plan = planLayout(cfgWith({ fill_screen: true }), mons, [W(1, [2600, 0, 3000, 400]), W(2, [4000, 0, 4400, 400])]);
  assert.deepEqual(plan.map((p) => p.rect), [
    [2560, 0, 3840, 1392],
    [3840, 0, 5120, 1392],
  ]);
  const one = planLayout(cfgWith({ fill_screen: true }), mons, [W(1, [2600, 0, 3000, 400])]);
  assert.deepEqual(one[0].rect, [2560, 0, 5120, 1392]);
});

test('planLayout：默认只有一个窗口时占最左边 1/N，不铺满；max_per_monitor 决定宽度', () => {
  const mons = orderMonitors(rawMonitors(), 'number');
  assert.deepEqual(planLayout(cfgWith(), mons, [W(1, [3000, 0, 3500, 400])])[0].rect, [2560, 0, 3414, 1392]);
  assert.deepEqual(planLayout(cfgWith({ max_per_monitor: 2 }), mons, [W(1, [3000, 0, 3500, 400])])[0].rect, [2560, 0, 3840, 1392]);
});

test('planLayout：gap 在窗口之间留缝', () => {
  const mons = orderMonitors(rawMonitors(), 'number');
  const plan = planLayout(cfgWith({ gap: 8 }), mons, [W(1, [2600, 0, 3000, 400]), W(2, [4000, 0, 4400, 400])]);
  assert.equal(plan[1].rect[0] - plan[0].rect[2], 8);
  assert.deepEqual(plan[0].rect, columnRects(mons[0].work, 3, 8)[0]);
});

test('planLayout：keep_monitor 时老窗口留在自己的屏上、本屏内往左靠，新窗口进第一个有空位的屏', () => {
  const mons = orderMonitors(rawMonitors(), 'number');
  const wins = [
    W(1, [4500, 0, 5000, 400]), // 屏1 最右边
    W(2, [5500, 0, 6000, 400]), // 屏3
    W(3, [2600, 0, 3000, 400]), // 新窗口，开在屏1
  ];
  const keep = planLayout(cfgWith({ keep_monitor: true }), mons, wins, [3]);
  assert.deepEqual(layoutOf(keep), { 1: [1, 3], 3: [2] });
  assert.deepEqual(keep.find((p) => p.win.hwnd === 1).rect, columnRects(mons[0].work, 3, 0)[0]);
  // 不开 keep_monitor：W2 从屏3 挪到屏1
  const normal = planLayout(cfgWith(), mons, wins, [3]);
  assert.deepEqual(layoutOf(normal), { 1: [1, 2, 3] });
});

test('planLayout：keep_monitor 时本屏放不下的老窗口去第一个有空位的屏', () => {
  const mons = orderMonitors(rawMonitors(), 'number');
  const wins = [1, 2, 3, 4].map((n) => W(n, [2560 + n * 300, 0, 2860 + n * 300, 400])); // 4 个都在屏1
  wins.push(W(5, [100, 0, 400, 400])); // 屏2 上已经有一个
  const plan = planLayout(cfgWith({ keep_monitor: true }), mons, wins);
  assert.deepEqual(layoutOf(plan), { 1: [1, 2, 3], 2: [5, 4] });
});

test('planLayout：所有屏都满了，多出来的按顺序叠到已有的格子上', () => {
  const mons = orderMonitors(rawMonitors(), 'number').slice(0, 2);
  const wins = [1, 2, 3, 4, 5].map((n) => W(n, [2560 + n * 300, 0, 2860 + n * 300, 400]));
  const plan = planLayout(cfgWith({ max_per_monitor: 2 }), mons, wins);
  assert.equal(plan.length, 5);
  assert.deepEqual(plan[4].rect, plan[0].rect);
  assert.equal(plan[4].monitor, plan[0].monitor);
});

test('planLayout：没有显示器时计划为空', () => {
  assert.deepEqual(planLayout(cfgWith(), [], [W(1, [0, 0, 400, 400])]), []);
});

test('planLayout：找不到所在屏的窗口排在最后', () => {
  const mons = orderMonitors(rawMonitors(), 'number');
  const wins = [W(1, [100, 0, 400, 400]), W(2, [2600, 0, 3000, 400])];
  const monitorOf = (frame) => (frame[0] === 100 ? null : 0);
  assert.deepEqual(planLayout(cfgWith(), mons, wins, [], monitorOf).map((p) => p.win.hwnd), [2, 1]);
});

test('describePlan：按屏列出窗口', () => {
  const mons = orderMonitors(rawMonitors(), 'number');
  const plan = planLayout(cfgWith({ max_per_monitor: 1 }), mons, [W(1, [2600, 0, 3000, 400]), W(2, [4000, 0, 4400, 400])]);
  assert.equal(describePlan(plan, mons), '屏1(主屏 2560x1392 @150%): W1；屏2(2560x1392 @125%): W2');
  assert.equal(describePlan([], mons), '（没有需要排的窗口）');
});

test('shortTitle / formatRect', () => {
  assert.equal(shortTitle(''), '(无标题)');
  assert.equal(shortTitle('短标题'), '短标题');
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四五';
  assert.equal(shortTitle(long), long.slice(0, 23) + '…');
  assert.equal(shortTitle('x'.repeat(24)), 'x'.repeat(24));
  assert.equal(formatRect([0, -234, 853, 1392]), '(0, -234, 853, 1392)');
});

// ---------------------------------------------------------------- 不参与平铺的原因

test('skipReason：按顺序判断，前面的原因优先', () => {
  const w = { frame: [0, 0, 800, 600], title: 'Claude' };
  const all = { visible: true, cloaked: false, toolWindow: false, owned: false, isMain: false, iconic: false, zoomed: false, hung: false };
  assert.equal(skipReason(cfgWith(), w, all), null);
  assert.equal(skipReason(cfgWith(), w, { ...all, visible: false, iconic: true }), '隐藏');
  assert.equal(skipReason(cfgWith(), w, { ...all, cloaked: true }), '不在当前桌面');
  assert.equal(skipReason(cfgWith(), w, { ...all, toolWindow: true }), '工具窗口');
  assert.equal(skipReason(cfgWith(), w, { ...all, owned: true }), '从属窗口');
  assert.equal(skipReason(cfgWith(), w, { ...all, isMain: true }), '主窗口');
  assert.equal(skipReason(cfgWith({ include_main_window: true }), w, { ...all, isMain: true }), null);
  assert.equal(skipReason(cfgWith(), { ...w, title: 'Claude · Artifact' }, all), '排除的标题');
  assert.equal(skipReason(cfgWith(), w, { ...all, iconic: true }), '最小化');
  assert.equal(skipReason(cfgWith(), { ...w, frame: [0, 0, 199, 600] }, all), '太小');
  assert.equal(skipReason(cfgWith(), { ...w, frame: [0, 0, 800, 149] }, all), '太小');
  assert.equal(skipReason(cfgWith(), w, { ...all, hung: true }), '无响应');
});

test('skipReason：skip_maximized 决定最大化的窗口参不参与', () => {
  const w = { frame: [0, 0, 2560, 1392], title: 's' };
  const flags = { visible: true, zoomed: true };
  assert.equal(skipReason(cfgWith({ skip_maximized: false }), w, flags), null);
  assert.equal(skipReason(cfgWith({ skip_maximized: true }), w, flags), '最大化');
});

test('skipReason：传函数时按顺序用到才查（和 Python 版一样短路）', () => {
  const asked = [];
  const f = (name, v) => () => {
    asked.push(name);
    return v;
  };
  const r = skipReason(cfgWith(), { frame: [0, 0, 800, 600], title: '' }, {
    visible: f('visible', true),
    cloaked: f('cloaked', false),
    toolWindow: f('toolWindow', true),
    owned: f('owned', false),
    iconic: f('iconic', false),
    hung: f('hung', false),
  });
  assert.equal(r, '工具窗口');
  assert.deepEqual(asked, ['visible', 'cloaked', 'toolWindow']);
});

// ---------------------------------------------------------------- 主窗口识别

function fakeProbe(titles, rects = {}) {
  return {
    isWindow: (h) => titles.has(h),
    getTitle: (h) => titles.get(h) || '',
    windowRect: (h) => rects[h] || [0, 0, 100, 100],
  };
}

test('Tracker：只有一个叫 "Claude" 的窗口就是主窗口；没有就是 null', () => {
  const t = new Tracker(fakeProbe(new Map([[1, 'Claude'], [2, '会话']])));
  assert.equal(t.mainOf(9, [[1, 'Claude'], [2, '会话']]), 1);
  assert.equal(new Tracker(fakeProbe(new Map())).mainOf(9, [[2, '会话']]), null);
});

test('Tracker：好几个都叫 "Claude" 时取最先创建的；运行前就有的算最早', () => {
  const titles = new Map([[1, 'Claude'], [2, 'Claude'], [3, 'Claude']]);
  const t = new Tracker(fakeProbe(titles));
  t.noteCreated(2);
  t.noteCreated(1);
  assert.equal(t.mainOf(9, [[1, 'Claude'], [2, 'Claude']]), 2);
  const t2 = new Tracker(fakeProbe(titles));
  t2.noteCreated(1);
  assert.equal(t2.mainOf(9, [[1, 'Claude'], [3, 'Claude']]), 3); // 3 是运行前就有的
});

test('Tracker：分不出先后时取面积大的', () => {
  const titles = new Map([[1, 'Claude'], [2, 'Claude']]);
  const t = new Tracker(fakeProbe(titles, { 1: [0, 0, 100, 100], 2: [0, 0, 900, 700] }));
  assert.equal(t.mainOf(9, [[1, 'Claude'], [2, 'Claude']]), 2);
});

test('Tracker：记住的主窗口还在、标题还是 "Claude" 就沿用；窗口销毁后忘掉', () => {
  const titles = new Map([[1, 'Claude'], [2, 'Claude']]);
  const t = new Tracker(fakeProbe(titles));
  t.noteCreated(1);
  t.noteCreated(2);
  assert.equal(t.mainOf(9, [[1, 'Claude'], [2, 'Claude']]), 1);
  assert.equal(t.mainOf(9, [[2, 'Claude']]), 1); // 记住的还在
  assert.deepEqual([...t.mains()], [1]);
  t.forget(1);
  titles.delete(1);
  assert.equal(t.mainOf(9, [[2, 'Claude']]), 2);
});

// ---------------------------------------------------------------- 快捷键

test('hotkeyToAccelerator：换成 Electron 加速键写法', () => {
  assert.equal(hotkeyToAccelerator('ctrl+alt+shift+t'), 'Control+Alt+Shift+T');
  assert.equal(hotkeyToAccelerator('Shift + Control + 1'), 'Control+Shift+1');
  assert.equal(hotkeyToAccelerator('win+f5'), 'Super+F5');
  assert.equal(hotkeyToAccelerator('super+alt+F24'), 'Alt+Super+F24');
  assert.equal(hotkeyToAccelerator('f1'), 'F1');
  assert.equal(hotkeyToAccelerator(''), '');
  assert.equal(hotkeyToAccelerator(null), '');
});

test('hotkeyToAccelerator：写错了抛异常', () => {
  assert.throws(() => hotkeyToAccelerator('ctrl+alt'), /没有主键/);
  assert.throws(() => hotkeyToAccelerator('ctrl+f25'), /不认识的按键：f25/);
  assert.throws(() => hotkeyToAccelerator('ctrl+tab'), /不认识的按键：tab/);
  assert.throws(() => hotkeyToAccelerator('ctrl++t'), /不认识的按键/);
});
