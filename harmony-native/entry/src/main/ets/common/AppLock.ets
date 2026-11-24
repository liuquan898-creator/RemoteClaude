import { userAuth } from '@kit.UserAuthenticationKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { Log, errText } from './Log';

/**
 * 打开 App 时验证身份（人脸、指纹或锁屏密码），对照安卓端的 BiometricPrompt。拿到这台手机就等于能在电脑上执行命令，
 * 所以默认开着（docs/04 安全要求）。
 */
export class AppLock {
  static authenticate(onDone: (ok: boolean) => void): void {
    try {
      const challenge = cryptoFramework.createRandom().generateRandomSync(16).data;
      const param: userAuth.AuthParam = {
        challenge: challenge,
        authType: [userAuth.UserAuthType.FACE, userAuth.UserAuthType.FINGERPRINT, userAuth.UserAuthType.PIN],
        authTrustLevel: userAuth.AuthTrustLevel.ATL1
      };
      const widget: userAuth.WidgetParam = { title: '验证身份后使用 RemoteClaude' };
      const auth = userAuth.getUserAuthInstance(param, widget);
      auth.on('result', {
        onResult: (r: userAuth.UserAuthResult) => {
          onDone(r.result === userAuth.UserAuthResultCode.SUCCESS);
        }
      });
      auth.start();
    } catch (e) {
      Log.w(`验证身份失败：${errText(e as Object)}`);
      onDone(false);
    }
  }
}
