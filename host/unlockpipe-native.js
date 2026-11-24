'use strict';
/**
 * unlockpipe.js 用到的 Win32 调用（koffi）。Node 的 net 套接字拿不到管道句柄，
 * 没法问"对面是谁"，所以连解锁服务的管道改由这里直接用 CreateFileW / WriteFile / ReadFile。
 * 全部是不会卡住的调用：读之前先用 PeekNamedPipe 看有多少字节，等待由上层用定时器轮询。
 */
const koffi = require('koffi');

const kernel32 = koffi.load('kernel32.dll');
const advapi32 = koffi.load('advapi32.dll');

const CreateFileW = kernel32.func(
  'intptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, intptr_t sa, uint32_t disposition, uint32_t flags, intptr_t tmpl)'
);
const GetLastError = kernel32.func('uint32_t __stdcall GetLastError()');
const CloseHandle = kernel32.func('int __stdcall CloseHandle(intptr_t h)');
const WriteFile = kernel32.func('int __stdcall WriteFile(intptr_t h, const uint8_t *buf, uint32_t len, _Out_ uint32_t *written, intptr_t ov)');
const ReadFile = kernel32.func('int __stdcall ReadFile(intptr_t h, _Out_ uint8_t *buf, uint32_t len, _Out_ uint32_t *read, intptr_t ov)');
const PeekNamedPipe = kernel32.func(
  'int __stdcall PeekNamedPipe(intptr_t h, intptr_t buf, uint32_t len, intptr_t read, _Out_ uint32_t *avail, intptr_t left)'
);
const GetNamedPipeServerProcessId = kernel32.func('int __stdcall GetNamedPipeServerProcessId(intptr_t h, _Out_ uint32_t *pid)');
const OpenProcess = kernel32.func('intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
const QueryFullProcessImageNameW = kernel32.func(
  'int __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'
);
const LocalFree = kernel32.func('void * __stdcall LocalFree(void *mem)');
const GetSecurityInfo = advapi32.func(
  'uint32_t __stdcall GetSecurityInfo(intptr_t h, int type, uint32_t info, _Out_ void **owner, void *group, void *dacl, void *sacl, _Out_ void **sd)'
);
const ConvertSidToStringSidW = advapi32.func('int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **str)');

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
// 只允许对面"认出"我们是谁，不允许它冒用我们的身份去干别的
const SECURITY_SQOS_PRESENT = 0x00100000;
const SECURITY_IDENTIFICATION = 0x00010000;
const INVALID_HANDLE = -1;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PIPE_BUSY = 231;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SE_KERNEL_OBJECT = 6;
const OWNER_SECURITY_INFORMATION = 1;

const num = (v) => (typeof v === 'bigint' ? Number(BigInt.asIntN(64, v)) : v);

function open(name) {
  const h = num(CreateFileW(name, (GENERIC_READ | GENERIC_WRITE) >>> 0, 0, 0, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, 0));
  if (h !== INVALID_HANDLE && h !== 0) return { handle: h };
  const err = GetLastError();
  if (err === ERROR_FILE_NOT_FOUND) return { error: 'not-found' };
  if (err === ERROR_PIPE_BUSY) return { error: 'busy' };
  return { error: 'open-failed', code: err };
}

function serverPid(h) {
  const out = [0];
  return GetNamedPipeServerProcessId(h, out) ? out[0] >>> 0 : 0;
}

function processImage(pid) {
  const ph = num(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
  if (!ph) return '';
  try {
    const buf = new Uint16Array(1024);
    const size = [buf.length];
    return QueryFullProcessImageNameW(ph, 0, buf, size) ? String.fromCharCode(...buf.subarray(0, size[0])) : '';
  } finally {
    CloseHandle(ph);
  }
}

/** 管道对象所有者的 SID 字符串，取不到返回空串 */
function pipeOwner(h) {
  const owner = [null];
  const sd = [null];
  if (GetSecurityInfo(h, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION, owner, null, null, null, sd) !== 0) return '';
  try {
    const str = [null];
    if (!owner[0] || !ConvertSidToStringSidW(owner[0], str) || !str[0]) return '';
    try {
      return koffi.decode(str[0], 'char16_t', -1);
    } finally {
      LocalFree(str[0]);
    }
  } finally {
    if (sd[0]) LocalFree(sd[0]);
  }
}

function write(h, data) {
  const written = [0];
  return !!WriteFile(h, data, data.length, written, 0) && written[0] === data.length;
}

/** 管道里现成可读的字节数；对面已经关了或出错返回 -1 */
function available(h) {
  const avail = [0];
  return PeekNamedPipe(h, 0, 0, 0, avail, 0) ? avail[0] >>> 0 : -1;
}

function read(h, n) {
  if (n <= 0) return null;
  const buf = Buffer.alloc(n);
  const got = [0];
  if (!ReadFile(h, buf, n, got, 0) || got[0] === 0) return null;
  return buf.subarray(0, got[0]);
}

function close(h) {
  CloseHandle(h);
}

module.exports = { open, serverPid, processImage, pipeOwner, write, available, read, close };
