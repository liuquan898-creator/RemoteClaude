/**
 * 把用户填的（或打包时写进来的）服务器地址整理成信令 WebSocket 地址和账号接口的 HTTP 地址。
 * 对照安卓端 protocol/ServerAddress.kt。
 *
 *   rc.example.com             -> wss://rc.example.com/ws      https://rc.example.com
 *   https://rc.example.com     -> wss://rc.example.com/ws      https://rc.example.com
 *   ws://192.168.1.10:8787     -> ws://192.168.1.10:8787/ws    http://192.168.1.10:8787   （仅允许明文时）
 *   wss://rc.example.com/rc/ws -> wss://rc.example.com/rc/ws   https://rc.example.com/rc
 */
/** 整理结果。ok 为 false 时只有 reason 有意义（ArkTS 不认可辨识联合的收窄，所以做成一个接口） */
export interface ServerAddressResult {
  ok: boolean;
  /** 信令 WebSocket 地址 */
  url: string;
  /** 账号接口的根地址，后面接 /api/... */
  httpBase: string;
  reason: string;
}

function invalid(reason: string): ServerAddressResult {
  return { ok: false, url: '', httpBase: '', reason };
}

export function parseServerAddress(input: string, allowCleartext: boolean): ServerAddressResult {
  const raw = input.trim();
  if (raw.length === 0) return invalid('请填写服务器地址');

  const schemeEnd = raw.indexOf('://');
  const scheme = schemeEnd >= 0 ? raw.substring(0, schemeEnd).toLowerCase() : 'wss';
  const rest = schemeEnd >= 0 ? raw.substring(schemeEnd + 3) : raw;
  let wsScheme: string;
  if (scheme === 'wss' || scheme === 'https') wsScheme = 'wss';
  else if (scheme === 'ws' || scheme === 'http') wsScheme = 'ws';
  else return invalid(`不支持的地址格式：${scheme}`);
  if (wsScheme === 'ws' && !allowCleartext) return invalid('只能连接 https 或 wss 地址');

  // 不用 URL 类：鸿蒙的 url 模块和 node 的行为不完全一样，这里自己拆，规则简单
  const m = /^([^/?#:@\s]+|\[[0-9a-fA-F:.]+\])(?::(\d{1,5}))?(\/[^?#\s]*)?$/.exec(rest);
  if (m === null) return invalid('服务器地址格式不正确');
  const host = m[1].toLowerCase();
  const port = m[2] !== undefined ? `:${m[2]}` : '';
  const rawPath = m[3] ?? '';
  const path = rawPath === '' || rawPath === '/' ? '/ws' : rawPath;
  const httpScheme = wsScheme === 'wss' ? 'https' : 'http';
  let basePath = path.endsWith('/') ? path.substring(0, path.length - 1) : path;
  if (basePath.endsWith('/ws')) basePath = basePath.substring(0, basePath.length - 3);
  return { ok: true, url: `${wsScheme}://${host}${port}${path}`, httpBase: `${httpScheme}://${host}${port}${basePath}`, reason: '' };
}
