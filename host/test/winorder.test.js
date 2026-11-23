'use strict';
/**
 * 给控制端的窗口列表排先后（winorder.js）：按屏幕位置排，和系统枚举出来的前后顺序无关。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sortByPosition } = require('../winorder');
const { orderMonitors, columnRects } = require('../tiler/layout');

// 两块屏：屏 2 在物理上的左边，屏 1（主屏）在右边；枚举顺序故意是屏 2 在前
function rawMonitors() {
  return [
    { handle: 22, device: '\\\\.\\DISPLAY2', rect: [0, 0, 2560, 1440], work: [0, 0, 2560, 1392], primary: false, dpi: 96 },
    { handle: 11, device: '\\\\.\\DISPLAY1', rect: [2560, 0, 5120, 1440], work: [2560, 0, 5120, 1392], primary: true, dpi: 96 },
  ];
}
const byNumber = () => orderMonitors(rawMonitors(), 'number'); // 屏 1、屏 2
const [S1A, S1B, S1C] = columnRects([2560, 0, 5120, 1392], 3, 0); // 屏 1 的三格
const [S2A, S2B] = columnRects([0, 0, 2560, 1392], 3, 0); // 屏 2 的前两格

const W = (hwnd, rect, extra = {}) => ({ hwnd, title: `W${hwnd}`, rect, ...extra });
const ids = (list) => list.map((w) => w.hwnd);

/** 平铺摆好的五个窗口：屏 1 三个、屏 2 两个。句柄大小和位置故意对不上 */
const tiled = () => [W(50, S1A), W(10, S1B), W(40, S1C), W(30, S2A), W(20, S2B)];

test('按平铺位置排：屏 1 从左到右，再屏 2 从左到右', () => {
  // 传进来的是系统的前后顺序（最近操作过的在最前），和位置无关
  const zOrder = [W(20, S2B), W(40, S1C), W(50, S1A), W(30, S2A), W(10, S1B)];
  assert.deepEqual(ids(sortByPosition(zOrder, byNumber())), [50, 10, 40, 30, 20]);
});

test('操作某个窗口只改变前后顺序，位置没变，排出来的结果不变', () => {
  const expected = [50, 10, 40, 30, 20];
  const list = tiled();
  // 依次把每个窗口提到最前（挪到枚举结果的第一个），就像在手机上挨个点进去操作
  for (let i = 0; i < list.length; i++) {
    const touched = [list[i], ...list.filter((_, j) => j !== i)];
    assert.deepEqual(ids(sortByPosition(touched, byNumber())), expected);
  }
  assert.deepEqual(ids(sortByPosition([...list].reverse(), byNumber())), expected);
});

test('电脑上重排后跟着变：两个窗口换了格子，列表里也换过来', () => {
  const swapped = [W(50, S1B), W(10, S1A), W(40, S1C), W(30, S2A), W(20, S2B)];
  assert.deepEqual(ids(sortByPosition(swapped, byNumber())), [10, 50, 40, 30, 20]);
});

test('屏的先后跟平铺配置的 monitor_order 走，不是物理上的左右', () => {
  const list = tiled();
  assert.deepEqual(ids(sortByPosition(list, orderMonitors(rawMonitors(), 'left-to-right'))), [30, 20, 50, 10, 40]);
  assert.deepEqual(ids(sortByPosition(list, orderMonitors(rawMonitors(), [2, 1]))), [30, 20, 50, 10, 40]);
  assert.deepEqual(ids(sortByPosition(list, orderMonitors(rawMonitors(), 'primary'))), [50, 10, 40, 30, 20]);
});

test('没参与平铺的窗口按它现在的位置排（主窗口摆在屏 1 中间偏右）', () => {
  const main = W(5, [3700, 200, 4700, 1100], { title: 'Claude' }); // 中心 x = 4200，在第二格（3840）和第三格（4693）之间
  assert.deepEqual(ids(sortByPosition([main, ...tiled()], byNumber())), [50, 10, 5, 40, 30, 20]);
});

test('同一个屏里左右位置一样时从上到下', () => {
  const top = W(9, [2560, 0, 3413, 696]);
  const bottom = W(3, [2560, 696, 3413, 1392]);
  assert.deepEqual(ids(sortByPosition([bottom, top, W(40, S1C)], byNumber())), [9, 3, 40]);
});

test('叠在同一格的窗口按句柄排，不看谁在上面', () => {
  const a = [W(77, S1A), W(12, S1A), W(40, S1C), W(33, S1A)];
  assert.deepEqual(ids(sortByPosition(a, byNumber())), [12, 33, 77, 40]);
  assert.deepEqual(ids(sortByPosition([...a].reverse(), byNumber())), [12, 33, 77, 40]);
});

test('最小化的窗口用还原后的位置：留在原来的先后，不跑到最前或最后', () => {
  // 调用方（win32.enumTargetWindows）给最小化的窗口填的是还原后会回到的位置，带着几像素看不见的边框
  const minimized = W(10, [S1B[0] - 7, S1B[1], S1B[2] + 7, S1B[3] + 7], { minimized: true });
  const list = [W(50, S1A), minimized, W(40, S1C), W(30, S2A), W(20, S2B)];
  assert.deepEqual(ids(sortByPosition(list, byNumber())), [50, 10, 40, 30, 20]);
});

test('取不到位置的排在最后，按句柄', () => {
  const list = [W(8, null), W(40, S1C), W(2, undefined), W(6, [0, 0, NaN, 10]), W(50, S1A)];
  assert.deepEqual(ids(sortByPosition(list, byNumber())), [50, 40, 2, 6, 8]);
});

test('中心点不在任何屏上的窗口算最近的那个屏', () => {
  // 被拖到屏 2 左边界外面一大半，中心 x 是负的：算屏 2，排在屏 2 最前
  const off = W(60, [-700, 100, 153, 1000]);
  assert.deepEqual(ids(sortByPosition([...tiled(), off], byNumber())), [50, 10, 40, 60, 30, 20]);
});

test('拿不到显示器时只按从左到右、从上到下排', () => {
  assert.deepEqual(ids(sortByPosition(tiled(), [])), [30, 20, 50, 10, 40]);
  assert.deepEqual(ids(sortByPosition(tiled())), [30, 20, 50, 10, 40]);
});

test('不改动传进来的数组，窗口对象原样返回', () => {
  const list = tiled();
  const before = ids(list);
  const sorted = sortByPosition(list, byNumber());
  assert.deepEqual(ids(list), before);
  assert.notEqual(sorted, list);
  assert.equal(sorted[0], list[0]); // W50 还是同一个对象，标题等字段都在
  assert.deepEqual(sortByPosition([], byNumber()), []);
});
