'use strict';
/**
 * 被控端自己所在的 Windows 会话的状况（koffi）：会话号、控制台会话号、连接状态、协议。
 * 用来认出"远程桌面断开了"：那时会话还在、程序照常跑，但没有画面，采集不了窗口（docs/06"远程桌面断开后从手机接回"）。
 * 判断逻辑在 lockstate.js，这里只取数。
 */
const koffi = require('koffi');

const kernel32 = koffi.load('kernel32.dll');
const wtsapi32 = koffi.load('wtsapi32.dll');

const GetCurrentProcessId = kernel32.func('uint32_t __stdcall GetCurrentProcessId()');
const ProcessIdToSessionId = kernel32.func('int __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t *session)');
const WTSGetActiveConsoleSessionId = kernel32.func('uint32_t __stdcall WTSGetActiveConsoleSessionId()');
const WTSQuerySessionInformationW = wtsapi32.func(
  'int __stdcall WTSQuerySessionInformationW(intptr_t server, uint32_t session, int infoClass, _Out_ void **buf, _Out_ uint32_t *bytes)'
);
const WTSFreeMemory = wtsapi32.func('void __stdcall WTSFreeMemory(void *mem)');

const WTS_CURRENT_SERVER_HANDLE = 0;
const WTSConnectState = 8;
const WTSClientProtocolType = 16;

/** 查一项会话信息，按 type 解出来；查不到返回 null */
function query(session, infoClass, type, minBytes) {
  const buf = [null];
  const bytes = [0];
  if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, session, infoClass, buf, bytes) || !buf[0]) return null;
  try {
    return bytes[0] >= minBytes ? koffi.decode(buf[0], type) : null;
  } finally {
    WTSFreeMemory(buf[0]);
  }
}

/** { sessionId, consoleId, connectState, protocol }；查不到的项为 null */
function current() {
  const out = [0];
  const sessionId = ProcessIdToSessionId(GetCurrentProcessId(), out) ? out[0] >>> 0 : null;
  const consoleId = WTSGetActiveConsoleSessionId() >>> 0;
  if (sessionId === null) return { sessionId, consoleId, connectState: null, protocol: null };
  return {
    sessionId,
    consoleId,
    connectState: query(sessionId, WTSConnectState, 'int32_t', 4),
    protocol: query(sessionId, WTSClientProtocolType, 'uint16_t', 2),
  };
}

module.exports = { current };
