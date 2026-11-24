import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { AppContext } from '../common/AppContext';

const FILE = 'settings';

/** 设置、设备编号、登录状态的本地存储，对照安卓端 data/SettingsStore.kt。 */
export class SettingsStore {
  private static prefs(): preferences.Preferences {
    return preferences.getPreferencesSync(AppContext.context, { name: FILE });
  }

  static getString(key: string, def: string = ''): string {
    const v = SettingsStore.prefs().getSync(key, def);
    return typeof v === 'string' ? v as string : def;
  }

  static putString(key: string, value: string): void {
    const p = SettingsStore.prefs();
    p.putSync(key, value);
    p.flush();
  }

  static remove(key: string): void {
    const p = SettingsStore.prefs();
    p.deleteSync(key);
    p.flush();
  }

  /** 第一次运行时随机生成并一直保存的设备编号（协议 1.3）。不是机密 */
  static deviceId(): string {
    let id = SettingsStore.getString('device_id');
    if (id.length === 0) {
      id = util.generateRandomUUID(false).replace(/-/g, '');
      SettingsStore.putString('device_id', id);
    }
    return id;
  }
}
