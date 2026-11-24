import { http } from '@kit.NetworkKit';
import { AuthReply, parseAuthReply } from '../protocol/AuthReplies';
import { Log, errText } from '../common/Log';

/** 登录时告诉服务器的设备信息（协议 1.3） */
export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
}

interface SendCodeBody {
  email: string;
  purpose: string;
}

interface LoginBody {
  email: string;
  password: string;
  clientType: string;
  deviceId: string;
  deviceName: string;
}

interface RegisterBody {
  email: string;
  code: string;
  password: string;
  clientType: string;
  deviceId: string;
  deviceName: string;
}

interface ResetBody {
  email: string;
  code: string;
  password: string;
}

/**
 * 账号接口：发验证码、注册、登录、重置密码、退出登录（协议第 1 节），对照安卓端 net/AuthApi.kt。
 * 连不上服务器时返回 error 为 network 的 AuthReply。
 */
export class AuthApi {
  sendCode(base: string, email: string, purpose: string): Promise<AuthReply> {
    const body: SendCodeBody = { email: email, purpose: purpose };
    return this.post(base, 'send-code', JSON.stringify(body), '');
  }

  login(base: string, email: string, password: string, device: DeviceInfo): Promise<AuthReply> {
    const body: LoginBody = {
      email: email,
      password: password,
      clientType: 'viewer',
      deviceId: device.deviceId,
      deviceName: device.deviceName
    };
    return this.post(base, 'login', JSON.stringify(body), '');
  }

  register(base: string, email: string, code: string, password: string, device: DeviceInfo): Promise<AuthReply> {
    const body: RegisterBody = {
      email: email,
      code: code,
      password: password,
      clientType: 'viewer',
      deviceId: device.deviceId,
      deviceName: device.deviceName
    };
    return this.post(base, 'register', JSON.stringify(body), '');
  }

  resetPassword(base: string, email: string, code: string, password: string): Promise<AuthReply> {
    const body: ResetBody = { email: email, code: code, password: password };
    return this.post(base, 'reset-password', JSON.stringify(body), '');
  }

  /** 通知服务器作废令牌；失败也无所谓，令牌会自然过期 */
  async logout(base: string, token: string): Promise<void> {
    await this.post(base, 'logout', '{}', token);
  }

  private async post(base: string, path: string, body: string, bearer: string): Promise<AuthReply> {
    const req = http.createHttp();
    const header: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
    if (bearer.length > 0) {
      header['Authorization'] = `Bearer ${bearer}`;
    }
    try {
      const res = await req.request(`${base}/api/auth/${path}`, {
        method: http.RequestMethod.POST,
        header: header,
        extraData: body,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 10000,
        readTimeout: 30000 // 发验证码要等邮件发出去
      });
      return parseAuthReply(res.responseCode, typeof res.result === 'string' ? res.result as string : '');
    } catch (e) {
      Log.w(`账号接口 ${path} 连不上：${errText(e as Object)}`);
      const r: AuthReply = {
        ok: false, token: '', email: '', cooldown: 0, error: 'network',
        message: '连不上服务器，请检查网络', retryAfter: 0
      };
      return r;
    } finally {
      req.destroy();
    }
  }
}
