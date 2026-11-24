import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN = 0x5243; // 'RC'
const TAG = 'RemoteClaude';

/**
 * 日志。注意：不要打印密码、登录令牌、验证码、TURN 凭据（docs/04 安全要求）。
 * 看日志：hdc shell hilog -T RemoteClaude
 */
export class Log {
  static i(msg: string): void {
    hilog.info(DOMAIN, TAG, '%{public}s', msg);
  }

  static w(msg: string): void {
    hilog.warn(DOMAIN, TAG, '%{public}s', msg);
  }

  static e(msg: string): void {
    hilog.error(DOMAIN, TAG, '%{public}s', msg);
  }
}

/** 把捕获到的错误变成一行文字 */
export function errText(e: Object | undefined | null): string {
  if (e === undefined || e === null) {
    return 'unknown';
  }
  if (e instanceof Error) {
    return e.message;
  }
  try {
    return JSON.stringify(e);
  } catch (_) {
    return String(e);
  }
}
