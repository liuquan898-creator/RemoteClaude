import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { KeyboardAvoidMode, window } from '@kit.ArkUI';
import { Log, errText } from '../common/Log';
import { AppContext } from '../common/AppContext';
import { controller } from '../RemoteController';
import { NetworkWatcher } from '../net/NetworkWatcher';

/** 留着的自定义 action：服务器以后改用 clickAction.actionType 1 时用它（现在用 actionType 0，靠 parameters 认，协议 2.10） */
const APPROVAL_ACTION = 'com.remoteclaude.mobile.APPROVAL';

export default class EntryAbility extends UIAbility {
  private network: NetworkWatcher = new NetworkWatcher();

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
    } catch (e) {
      Log.w(`setColorMode failed: ${errText(e as Object)}`);
    }
    AppContext.init(this.context);
    controller.load();
    this.handleWant(want);
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.handleWant(want);
  }

  /** 从审批通知点进来：连上后直接弹审批面板 */
  private handleWant(want: Want): void {
    const params = want.parameters;
    const fromPush = want.action === APPROVAL_ACTION ||
      (params !== undefined && (params['approvalId'] !== undefined || params['kind'] === 'approval'));
    if (fromPush) {
      Log.i('从审批通知打开');
      controller.openApprovalsWhenReady();
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        Log.e(`loadContent failed: ${JSON.stringify(err)}`);
        return;
      }
      try {
        const win = windowStage.getMainWindowSync();
        AppContext.mainWindow = win;
        // 软键盘弹出时把页面压短（像安卓的 imePadding），而不是整页往上推：顶栏和画面要一直看得见
        win.getUIContext().setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE);
      } catch (e) {
        Log.w(`getMainWindow failed: ${errText(e as Object)}`);
      }
    });
  }

  onForeground(): void {
    AppContext.foreground = true;
    this.network.start(() => controller.onNetworkChanged());
    controller.onForeground();
  }

  onBackground(): void {
    AppContext.foreground = false;
    this.network.stop();
    controller.onBackground();
  }
}
