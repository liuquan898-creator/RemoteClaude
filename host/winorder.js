'use strict';
/**
 * 给控制端的窗口列表排先后（协议文档 2.4）：按窗口在电脑屏幕上的位置排，和平铺摆出来的样子一致。
 *
 * 系统枚举窗口是按前后顺序给的，最近操作过的在最前：在手机上点进哪个窗口，它就跑到列表第一个，
 * 别的跟着往后挪，每次回到列表都要重新找。按位置排以后，只有窗口在电脑上真的挪了地方，列表才跟着变。
 *
 * 规则（和平铺排窗口的先后是同一套，见 tiler/layout.js 的 planLayout）：
 *   1. 先看窗口中心点在哪个屏，屏的先后就是平铺往屏上放窗口的先后（平铺配置的 monitor_order，默认从最左边的屏依次往右）
 *   2. 同一个屏里从左到右，再从上到下
 *   3. 位置一样（屏都排满后叠在同一格的窗口）按句柄从小到大，保证每次结果相同
 *   4. 取不到位置的排在最后，也按句柄
 * 不看窗口参不参与平铺：暂停了自动平铺、主窗口、被用户拖到别处的窗口，都按它现在的位置排。
 * 最小化的窗口由调用方给出它还原后会回到的位置，所以最小化不改变它在列表里的先后。
 *
 * 纯计算，不调用 Win32，方便单元测试。
 */
const { monitorIndexOf } = require('./tiler/layout');

/**
 * @template {{ hwnd: number, rect?: number[] | null }} T
 * @param {T[]} windows rect 是 [left, top, right, bottom]（物理像素）
 * @param {object[]} monitors 已经按平铺的顺序排好的显示器（每项要有 rect）；传空数组时只按从左到右、从上到下排
 * @returns {T[]} 排好的新数组，不改动传进来的
 */
function sortByPosition(windows, monitors = []) {
  const keyed = windows.map((w) => {
    const r = Array.isArray(w.rect) && w.rect.length === 4 && w.rect.every(Number.isFinite) ? w.rect : null;
    if (!r) return { w, located: 1, mon: 0, x: 0, y: 0 };
    const i = monitorIndexOf(r, monitors);
    return { w, located: 0, mon: i == null ? monitors.length : i, x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2 };
  });
  keyed.sort((a, b) => a.located - b.located || a.mon - b.mon || a.x - b.x || a.y - b.y || a.w.hwnd - b.w.hwnd);
  return keyed.map((k) => k.w);
}

module.exports = { sortByPosition };
