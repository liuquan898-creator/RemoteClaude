import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { Log, errText } from './Log';

/**
 * 切到后台时多撑一会儿不被挂起：选图、选文件（系统选择器在别的进程里，App 会进后台）、正在发文件。
 * 用的是系统的短时任务（单次最多约 3 分钟，每天总量有限），对照安卓端"选图最多 2 分钟、发文件最多 10 分钟"。
 * 鸿蒙不允许普通 App 长时间在后台保持网络连接，发文件超过这个时间系统会挂起 App，文件就发不完了。
 */
export class BackgroundGuard {
  private static requestId: number = -1;

  /** 申请一段后台时间；重复调用只保留一份 */
  static begin(reason: string): void {
    if (BackgroundGuard.requestId >= 0) {
      return;
    }
    try {
      const info = backgroundTaskManager.requestSuspendDelay(reason, () => {
        Log.i('后台时间用完了');
        BackgroundGuard.end();
      });
      BackgroundGuard.requestId = info.requestId;
      Log.i(`申请了后台时间：${reason}，${info.actualDelayTime} 毫秒`);
    } catch (e) {
      Log.w(`申请后台时间失败：${errText(e as Object)}`);
    }
  }

  static end(): void {
    const id = BackgroundGuard.requestId;
    BackgroundGuard.requestId = -1;
    if (id < 0) {
      return;
    }
    try {
      backgroundTaskManager.cancelSuspendDelay(id);
    } catch (e) {
      Log.w(`取消后台时间失败：${errText(e as Object)}`);
    }
  }
}
