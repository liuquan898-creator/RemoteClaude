'use strict';
/**
 * 窗口平铺用到的 Win32 接口（koffi 绑定）。
 *
 * 和 ../win32.js 分开：那边管远程控制（枚举、切前台、注入输入），这里只管平铺。
 * 两边各自 load 一次 user32 没关系。koffi 的类型名是全局的，这里的结构体和回调类型统一加 Tiler 前缀，
 * 免得和 win32.js 里的 RECT / POINT / EnumWindowsProc 重名。
 *
 * 句柄一律用 uintptr_t，进 JS 之后用 num() 转成普通数字（和 win32.js 一样）。
 * 矩形一律返回 [left, top, right, bottom] 数组。
 *
 * 这一层只是薄薄的包装，"演练模式不许动窗口"的限制在 index.js 里统一把关。
 */
const path = require('path');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const shcore = koffi.load('shcore.dll');

// ---------------------------------------------------------------- 类型

const RECT = koffi.struct('TilerRECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('TilerPOINT', { x: 'long', y: 'long' });
const MONITORINFOEXW = koffi.struct('TilerMONITORINFOEXW', {
  cbSize: 'uint32_t',
  rcMonitor: RECT,
  rcWork: RECT,
  dwFlags: 'uint32_t',
  szDevice: koffi.array('char16_t', 32), // 自动转成字符串，如 "\\.\DISPLAY1"
});
const GUITHREADINFO = koffi.struct('TilerGUITHREADINFO', {
  cbSize: 'uint32_t',
  flags: 'uint32_t',
  hwndActive: 'uintptr_t',
  hwndFocus: 'uintptr_t',
  hwndCapture: 'uintptr_t',
  hwndMenuOwner: 'uintptr_t',
  hwndMoveSize: 'uintptr_t',
  hwndCaret: 'uintptr_t',
  rcCaret: RECT,
});

koffi.proto('int __stdcall TilerWndEnumProc(uintptr_t hwnd, intptr_t lParam)');
koffi.proto('int __stdcall TilerMonitorEnumProc(uintptr_t hmon, uintptr_t hdc, void *rect, intptr_t lParam)');
const WINEVENTPROC = koffi.proto(
  'void __stdcall TilerWinEventProc(uintptr_t hook, uint32_t event, uintptr_t hwnd, int32_t idObject, int32_t idChild, uint32_t idEventThread, uint32_t dwmsEventTime)'
);

// ---------------------------------------------------------------- 函数
// Win32 的 BOOL 是 4 字节，这里按 int 声明（koffi 的 bool 只有 1 字节）

const SetProcessDpiAwarenessContext = user32.func('int __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
const GetThreadDpiAwarenessContext = user32.func('intptr_t __stdcall GetThreadDpiAwarenessContext()');
const GetAwarenessFromDpiAwarenessContext = user32.func('int __stdcall GetAwarenessFromDpiAwarenessContext(intptr_t value)');

const EnumWindows = user32.func('int __stdcall EnumWindows(TilerWndEnumProc *cb, intptr_t lParam)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr_t hwnd, _Out_ uint16_t *buf, int max)');
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(uintptr_t hwnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hwnd, _Out_ uint16_t *buf, int max)');
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(uintptr_t hwnd, int index)');
const IsWindow = user32.func('int __stdcall IsWindow(uintptr_t hwnd)');
const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(uintptr_t hwnd)');
const IsIconic = user32.func('int __stdcall IsIconic(uintptr_t hwnd)');
const IsZoomed = user32.func('int __stdcall IsZoomed(uintptr_t hwnd)');
const IsHungAppWindow = user32.func('int __stdcall IsHungAppWindow(uintptr_t hwnd)');
const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hwnd, uint32_t cmd)');
const GetAncestor = user32.func('uintptr_t __stdcall GetAncestor(uintptr_t hwnd, uint32_t flags)');
const GetWindowRect = user32.func('int __stdcall GetWindowRect(uintptr_t hwnd, _Out_ TilerRECT *rect)');
const SetWindowPos = user32.func(
  'int __stdcall SetWindowPos(uintptr_t hwnd, uintptr_t insertAfter, int x, int y, int cx, int cy, uint32_t flags)'
);
const ShowWindow = user32.func('int __stdcall ShowWindow(uintptr_t hwnd, int cmd)');
const ShowWindowAsync = user32.func('int __stdcall ShowWindowAsync(uintptr_t hwnd, int cmd)');
const PostMessageW = user32.func('int __stdcall PostMessageW(uintptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)');
const EnumDisplayMonitors = user32.func(
  'int __stdcall EnumDisplayMonitors(uintptr_t hdc, void *clip, TilerMonitorEnumProc *cb, intptr_t lParam)'
);
const GetMonitorInfoW = user32.func('int __stdcall GetMonitorInfoW(uintptr_t hmon, _Inout_ TilerMONITORINFOEXW *info)');
const MonitorFromPoint = user32.func('uintptr_t __stdcall MonitorFromPoint(TilerPOINT pt, uint32_t flags)');
const SetWinEventHook = user32.func(
  'uintptr_t __stdcall SetWinEventHook(uint32_t eventMin, uint32_t eventMax, uintptr_t hmod, TilerWinEventProc *cb, uint32_t pid, uint32_t tid, uint32_t flags)'
);
const UnhookWinEvent = user32.func('int __stdcall UnhookWinEvent(uintptr_t hook)');
const GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ TilerPOINT *pt)');
const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
const GetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int vk)');
const GetGUIThreadInfo = user32.func('int __stdcall GetGUIThreadInfo(uint32_t tid, _Inout_ TilerGUITHREADINFO *info)');

const OpenProcess = kernel32.func('uintptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
const CloseHandle = kernel32.func('int __stdcall CloseHandle(uintptr_t handle)');
const QueryFullProcessImageNameW = kernel32.func(
  'int __stdcall QueryFullProcessImageNameW(uintptr_t handle, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'
);

// 同一个 DwmGetWindowAttribute，按取的属性分两种输出类型声明
const DwmGetWindowAttributeRect = dwmapi.func(
  'long __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32_t attr, _Out_ TilerRECT *value, uint32_t size)'
);
const DwmGetWindowAttributeInt = dwmapi.func(
  'long __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32_t attr, _Out_ int *value, uint32_t size)'
);

const GetDpiForMonitor = shcore.func('long __stdcall GetDpiForMonitor(uintptr_t hmon, int type, _Out_ uint32_t *dpiX, _Out_ uint32_t *dpiY)');

// ---------------------------------------------------------------- 常量

const C = Object.freeze({
  GWL_STYLE: -16,
  GWL_EXSTYLE: -20,
  WS_CHILD: 0x40000000,
  WS_CAPTION: 0x00c00000,
  WS_EX_TOOLWINDOW: 0x00000080,
  GW_OWNER: 4,
  GA_ROOT: 2,
  MONITOR_DEFAULTTONEAREST: 2,
  MONITORINFOF_PRIMARY: 1,
  DWMWA_EXTENDED_FRAME_BOUNDS: 9,
  DWMWA_CLOAKED: 14,
  SWP_NOSIZE: 0x0001,
  SWP_NOMOVE: 0x0002,
  SWP_NOZORDER: 0x0004,
  SWP_NOACTIVATE: 0x0010,
  SWP_NOOWNERZORDER: 0x0200,
  SWP_ASYNCWINDOWPOS: 0x4000,
  HWND_TOP: 0,
  SW_SHOWNOACTIVATE: 4,
  EVENT_SYSTEM_FOREGROUND: 0x0003,
  EVENT_SYSTEM_MINIMIZESTART: 0x0016,
  EVENT_SYSTEM_MINIMIZEEND: 0x0017,
  EVENT_OBJECT_CREATE: 0x8000,
  EVENT_OBJECT_DESTROY: 0x8001,
  EVENT_OBJECT_SHOW: 0x8002,
  EVENT_OBJECT_HIDE: 0x8003,
  WINEVENT_OUTOFCONTEXT: 0x0000,
  WINEVENT_SKIPOWNPROCESS: 0x0002,
  VK_LBUTTON: 0x01,
  VK_RBUTTON: 0x02,
  VK_MBUTTON: 0x04,
  GUI_INMOVESIZE: 0x00000002,
  PROCESS_QUERY_LIMITED_INFORMATION: 0x1000,
  WM_CLOSE: 0x0010,
  DPI_AWARENESS_PER_MONITOR_AWARE: 2,
  DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: -4,
  MDT_EFFECTIVE_DPI: 0,
});

// ---------------------------------------------------------------- 工具

const num = (v) => (typeof v === 'bigint' ? Number(v) : v || 0);
const rectArr = (r) => [r.left, r.top, r.right, r.bottom];

function readWide(fn, hwnd, cap) {
  const buf = new Uint16Array(cap);
  const len = fn(hwnd, buf, cap);
  return len > 0 ? String.fromCharCode(...buf.subarray(0, Math.min(len, cap))) : '';
}

/**
 * 让坐标都按物理像素算（每屏单独缩放 V2）。Electron 主进程本来就是这样，这时什么也不做；
 * 普通 node 进程默认不感知 DPI，拿到的坐标是缩放过的，所以要设一下。返回当前线程是否已经按物理像素算。
 */
function ensureDpiAware() {
  try {
    if (GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) === C.DPI_AWARENESS_PER_MONITOR_AWARE) return true;
    SetProcessDpiAwarenessContext(C.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    return GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) === C.DPI_AWARENESS_PER_MONITOR_AWARE;
  } catch {
    return false;
  }
}

/** 所有顶层窗口，按 Z 序从上到下 */
function enumTopWindows() {
  const out = [];
  EnumWindows((h) => {
    out.push(num(h));
    return 1;
  }, 0);
  return out;
}

const getClass = (hwnd) => readWide(GetClassNameW, hwnd, 256);

function getTitle(hwnd) {
  const len = GetWindowTextLengthW(hwnd);
  return len > 0 ? readWide(GetWindowTextW, hwnd, Math.min(len + 1, 1024)) : '';
}

/** { pid, tid } */
function getPidTid(hwnd) {
  const out = [0];
  const tid = GetWindowThreadProcessId(hwnd, out) >>> 0;
  return { pid: out[0] >>> 0, tid };
}

const procCache = new Map(); // pid -> { name, at }

/** 进程的可执行文件名（小写），取不到时返回空串。缓存 30 秒（进程号可能被复用，不能永久缓存） */
function processName(pid) {
  if (!pid) return '';
  const now = Date.now();
  const hit = procCache.get(pid);
  if (hit && now - hit.at < 30000) return hit.name;
  let name = '';
  const h = num(OpenProcess(C.PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
  if (h) {
    try {
      const buf = new Uint16Array(1024);
      const size = [buf.length];
      if (QueryFullProcessImageNameW(h, 0, buf, size)) {
        name = path.win32.basename(String.fromCharCode(...buf.subarray(0, size[0]))).toLowerCase();
      }
    } finally {
      CloseHandle(h);
    }
  }
  if (procCache.size > 2000) procCache.clear();
  procCache.set(pid, { name, at: now });
  return name;
}

const getStyle = (hwnd) => Number(num(GetWindowLongPtrW(hwnd, C.GWL_STYLE))) >>> 0;
const getExStyle = (hwnd) => Number(num(GetWindowLongPtrW(hwnd, C.GWL_EXSTYLE))) >>> 0;

function windowRect(hwnd) {
  const r = {};
  return GetWindowRect(hwnd, r) ? rectArr(r) : [0, 0, 0, 0];
}

/** 窗口看得见的边框范围（去掉 Win10/11 的透明缩放边框） */
function frameRect(hwnd) {
  const r = {};
  if (DwmGetWindowAttributeRect(hwnd, C.DWMWA_EXTENDED_FRAME_BOUNDS, r, koffi.sizeof(RECT)) === 0) return rectArr(r);
  return windowRect(hwnd);
}

/** 窗口被 DWM 隐藏了（多半是在别的虚拟桌面上） */
function isCloaked(hwnd) {
  const v = [0];
  if (DwmGetWindowAttributeInt(hwnd, C.DWMWA_CLOAKED, v, 4) === 0) return v[0] !== 0;
  return false;
}

/** 所有显示器 [{ handle, device, rect, work, primary, dpi }]，顺序就是 EnumDisplayMonitors 给的顺序 */
function enumMonitors() {
  const mons = [];
  EnumDisplayMonitors(
    0,
    null,
    (hmon) => {
      const h = num(hmon);
      const mi = { cbSize: koffi.sizeof(MONITORINFOEXW) };
      if (GetMonitorInfoW(h, mi)) {
        const dx = [96];
        const dy = [96];
        const ok = GetDpiForMonitor(h, C.MDT_EFFECTIVE_DPI, dx, dy) === 0;
        mons.push({
          handle: h,
          device: mi.szDevice,
          rect: rectArr(mi.rcMonitor),
          work: rectArr(mi.rcWork),
          primary: !!(mi.dwFlags & C.MONITORINFOF_PRIMARY),
          dpi: ok && dx[0] ? dx[0] : 96,
        });
      }
      return 1;
    },
    0
  );
  return mons;
}

const monitorFromPoint = (x, y) => num(MonitorFromPoint({ x, y }, C.MONITOR_DEFAULTTONEAREST));

/** 这个线程正在拖动 / 改大小窗口 */
function inMoveSize(tid) {
  const gti = { cbSize: koffi.sizeof(GUITHREADINFO) };
  if (GetGUIThreadInfo(tid, gti)) return !!(gti.flags & C.GUI_INMOVESIZE);
  return false;
}

const anyMouseButtonDown = () =>
  [C.VK_LBUTTON, C.VK_RBUTTON, C.VK_MBUTTON].some((vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0);

function cursorPos() {
  const pt = {};
  return GetCursorPos(pt) ? [pt.x, pt.y] : null;
}

// ---- WinEvent 钩子 ----

/** 注册一个可以随时被系统调用的 WinEvent 回调，返回给 setWinEventHook 用的指针（用完 unregisterCallback） */
const registerWinEventProc = (fn) => koffi.register(fn, koffi.pointer(WINEVENTPROC));
const unregisterCallback = (ptr) => koffi.unregister(ptr);
const setWinEventHook = (min, max, cb, flags) => num(SetWinEventHook(min, max, 0, cb, 0, 0, flags));
const unhookWinEvent = (hook) => !!UnhookWinEvent(hook);

module.exports = {
  C,
  num,
  ensureDpiAware,
  enumTopWindows,
  getClass,
  getTitle,
  getPidTid,
  processName,
  getStyle,
  getExStyle,
  windowRect,
  frameRect,
  isCloaked,
  enumMonitors,
  monitorFromPoint,
  inMoveSize,
  anyMouseButtonDown,
  cursorPos,
  isWindow: (h) => !!IsWindow(h),
  isWindowVisible: (h) => !!IsWindowVisible(h),
  isIconic: (h) => !!IsIconic(h),
  isZoomed: (h) => !!IsZoomed(h),
  isHungAppWindow: (h) => !!IsHungAppWindow(h),
  getOwner: (h) => num(GetWindow(h, C.GW_OWNER)),
  getRoot: (h) => num(GetAncestor(h, C.GA_ROOT)),
  foregroundWindow: () => num(GetForegroundWindow()),
  // 下面这几个会改动窗口，index.js 在演练模式下不会调用
  setWindowPos: (h, after, x, y, cx, cy, flags) => !!SetWindowPos(h, after, x, y, cx, cy, flags),
  showWindow: (h, cmd) => !!ShowWindow(h, cmd),
  showWindowAsync: (h, cmd) => !!ShowWindowAsync(h, cmd),
  postMessage: (h, msg, wp, lp) => !!PostMessageW(h, msg, wp, lp),
  registerWinEventProc,
  unregisterCallback,
  setWinEventHook,
  unhookWinEvent,
};
