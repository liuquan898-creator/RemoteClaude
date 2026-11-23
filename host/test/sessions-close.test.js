'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSessions, isClosable } = require('../sessions');

/**
 * 假的 win32：windows 是屏幕上的窗口；postClose 记下发了 WM_CLOSE 的窗口，
 * hideAfter 毫秒后把它从屏幕上拿掉（Claude 的会话窗口是藏起来，不是销毁），为 null 时一直不消失。
 */
function fakeWin32(windows, { hideAfter = 30, postOk = true } = {}) {
  const shown = new Map(windows.map((w) => [w.hwnd, w]));
  const closed = [];
  return {
    closed,
    enumTargetWindows: () => [...shown.values()],
    isTargetWindow: (hwnd) => shown.has(hwnd),
    isLocked: () => false,
    postClose(hwnd) {
      closed.push(hwnd);
      if (postOk && hideAfter !== null) setTimeout(() => shown.delete(hwnd), hideAfter);
      return postOk;
    },
  };
}

const win = (hwnd, title, className = 'Chrome_WidgetWin_1') => ({ hwnd, title, className, minimized: false });
const make = (w32) => createSessions({ log: () => {}, win32: w32, targets: ['claude.exe'], openUrl: async () => {}, findDataDir: () => null });

test('Claude 主窗口不能关，会话窗口和别的白名单窗口能关', () => {
  assert.equal(isClosable(win(1, 'Claude')), false);
  assert.equal(isClosable(win(2, '推杆系统网口版调试')), true);
  assert.equal(isClosable(win(3, '新会话')), true);
  assert.equal(isClosable(win(4, 'Claude', 'WindowsForms10.Window.8.app.0.1')), true, '别的程序里标题碰巧叫 Claude 的窗口');
});

test('关会话窗口：发 WM_CLOSE，等窗口从屏幕上消失后回成功', async () => {
  const w32 = fakeWin32([win(1, 'Claude'), win(2, '通知声音提醒功能')]);
  const r = await make(w32).closeWindow(2, '通知声音提醒功能');
  assert.deepEqual(r, { ok: true, title: '通知声音提醒功能' });
  assert.deepEqual(w32.closed, [2]);
  assert.deepEqual(w32.enumTargetWindows().map((w) => w.hwnd), [1]);
});

test('不给标题也能关；句柄是字符串也认', async () => {
  const w32 = fakeWin32([win(7, '会话')]);
  assert.equal((await make(w32).closeWindow('7')).ok, true);
});

test('主窗口不关，什么都不发', async () => {
  const w32 = fakeWin32([win(1, 'Claude')]);
  assert.deepEqual(await make(w32).closeWindow(1, 'Claude'), { ok: false, code: 'not-closable' });
  assert.deepEqual(w32.closed, []);
});

test('窗口已经不在了回 gone；句柄不像样也回 gone', async () => {
  const w32 = fakeWin32([win(2, '会话')]);
  const s = make(w32);
  assert.deepEqual(await s.closeWindow(3, '会话'), { ok: false, code: 'gone' });
  for (const bad of [0, -1, 1.5, 'abc', null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
    assert.deepEqual(await s.closeWindow(bad), { ok: false, code: 'gone' }, String(bad));
  }
  assert.deepEqual(w32.closed, []);
});

test('句柄已经换成了别的会话（Claude 复用了藏起来的窗口）时不关，回 changed', async () => {
  const w32 = fakeWin32([win(2, '另一个会话')]);
  assert.deepEqual(await make(w32).closeWindow(2, '手机上看到的旧标题'), { ok: false, code: 'changed' });
  assert.deepEqual(w32.closed, []);
});

test('发了关闭窗口一直不消失回 still-open；消息发不出去回 failed', async () => {
  const stay = fakeWin32([win(2, '会话')], { hideAfter: null });
  const t0 = Date.now();
  assert.deepEqual(await make(stay).closeWindow(2, '会话'), { ok: false, code: 'still-open' });
  assert.ok(Date.now() - t0 >= 2900, '等满了 3 秒');

  const fail = fakeWin32([win(2, '会话')], { postOk: false });
  assert.deepEqual(await make(fail).closeWindow(2, '会话'), { ok: false, code: 'failed' });
});
