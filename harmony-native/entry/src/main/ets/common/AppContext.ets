import { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

/** 进程里共用的上下文：UIAbility 的 context 和主窗口 */
export class AppContext {
  private static ctx: common.UIAbilityContext | null = null;
  static mainWindow: window.Window | null = null;
  static foreground: boolean = true;

  static init(ctx: common.UIAbilityContext): void {
    AppContext.ctx = ctx;
  }

  static get context(): common.UIAbilityContext {
    if (AppContext.ctx === null) {
      throw new Error('AppContext 还没初始化');
    }
    return AppContext.ctx;
  }
}
