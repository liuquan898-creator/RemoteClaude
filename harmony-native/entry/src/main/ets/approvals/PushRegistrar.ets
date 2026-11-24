import { pushService } from '@kit.PushKit';
import { Log, errText } from '../common/Log';

/**
 * 华为 Push Kit 的推送令牌。鸿蒙不让 App 常驻后台保持连接，审批提醒改由服务器经 Push Kit 推通知（docs/09）。
 * 要在 AppGallery Connect 给本应用开通推送服务，签名关联了 AGC 的应用才拿得到令牌；拿不到时审批只在 App 打开时收得到。
 */
export class PushRegistrar {
  /** 取推送令牌；拿不到返回空串 */
  static async token(): Promise<string> {
    try {
      const t = await pushService.getToken();
      Log.i(`拿到推送令牌（${t.length} 个字符）`);
      return t;
    } catch (e) {
      Log.w(`拿不到推送令牌（可能还没在 AppGallery Connect 开通推送服务）：${errText(e as Object)}`);
      return '';
    }
  }

  /** 退出登录时作废本机的推送令牌，免得退出后还收到这个账号的通知 */
  static async drop(): Promise<void> {
    try {
      await pushService.deleteToken();
    } catch (e) {
      Log.w(`删除推送令牌失败：${errText(e as Object)}`);
    }
  }
}
