import { parseObject } from './Protocol';

/** 账号接口（协议第 1 节）回复的解析结果 */
export interface AuthReply {
  ok: boolean;
  /** 登录、注册成功时有 */
  token: string;
  email: string;
  /** 发验证码成功时的冷却秒数 */
  cooldown: number;
  /** 失败时的错误码和给人看的说明 */
  error: string;
  message: string;
  retryAfter: number;
}

const FALLBACK: Record<string, string> = {
  'bad-request': '请求格式不对',
  'bad-email': '邮箱格式不对',
  'weak-password': '密码至少 8 位',
  'bad-code': '验证码错误或已过期',
  'email-taken': '这个邮箱已经注册过了，请直接登录',
  'bad-credentials': '邮箱或密码不对',
  unauthorized: '登录已失效，请重新登录',
  'registration-closed': '服务器关闭了注册',
  'too-many': '操作太频繁，请稍后再试',
  'mail-unavailable': '服务器没有配置发信',
  'mail-failed': '发信失败，请稍后再试',
};

/** 解析账号接口的回复。status 是 HTTP 状态码；2xx 视为成功 */
export function parseAuthReply(status: number, body: string): AuthReply {
  const o = parseObject(body) ?? {};
  const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
  const n = (k: string): number => (typeof o[k] === 'number' ? (o[k] as number) : 0);
  if (status >= 200 && status < 300) {
    return { ok: true, token: s('token'), email: s('email'), cooldown: n('cooldown'), error: '', message: '', retryAfter: 0 };
  }
  const error = s('error') || `http-${status}`;
  let message = s('message') || FALLBACK[error] || `服务器返回 ${status}`;
  const retryAfter = n('retryAfter');
  if (error === 'too-many' && retryAfter > 0 && !s('message')) message = `操作太频繁，请 ${retryAfter} 秒后再试`;
  return { ok: false, token: '', email: '', cooldown: 0, error, message, retryAfter };
}
