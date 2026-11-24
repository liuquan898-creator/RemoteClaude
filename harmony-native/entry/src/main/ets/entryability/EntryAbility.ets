import { AbilityConstant, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { Log, errText } from '../common/Log';
import { AppContext } from '../common/AppContext';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    try {
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_DARK);
    } catch (e) {
      Log.w(`setColorMode failed: ${errText(e as Object)}`);
    }
    AppContext.init(this.context);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        Log.e(`loadContent failed: ${JSON.stringify(err)}`);
        return;
      }
      try {
        AppContext.mainWindow = windowStage.getMainWindowSync();
      } catch (e) {
        Log.w(`getMainWindow failed: ${errText(e as Object)}`);
      }
    });
  }

  onForeground(): void {
    AppContext.foreground = true;
  }

  onBackground(): void {
    AppContext.foreground = false;
  }
}
