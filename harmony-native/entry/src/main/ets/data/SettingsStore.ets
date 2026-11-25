import { preferences } from '@kit.ArkData';
import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { AppContext } from '../common/AppContext';
import { Log, errText } from '../common/Log';

const FILE = 'settings';
const TOKEN_ALIAS = 'login_token';
/** "全部会话"里最多记这么多个折叠的环境 */
const MAX_COLLAPSED = 500;

/** 用户可以在设置里改的选项，对照安卓端 data/SettingsStore.kt 的 AppSettings */
export class AppSettings {
  keepScreenOn: boolean = true;
  haptics: boolean = true;
  showStats: boolean = false;
  /** 打开 App 时验证身份（指纹、人脸或锁屏密码） */
  appLock: boolean = true;
  /** 看画面时，电脑上新复制的文字自动放进手机剪贴板（协议 4.9） */
  syncClipboard: boolean = true;
  /** 从手机解锁时先在电脑的真显示器上盖隐私屏的黑幕，电脑前的人看不到桌面（docs/11 第 4.4 节） */
  privacyOnUnlock: boolean = true;

  copy(): AppSettings {
    const s = new AppSettings();
    s.keepScreenOn = this.keepScreenOn;
    s.haptics = this.haptics;
    s.showStats = this.showStats;
    s.appLock = this.appLock;
    s.syncClipboard = this.syncClipboard;
    s.privacyOnUnlock = this.privacyOnUnlock;
    return s;
  }
}

/** 启动时一次性读出的全部本地数据 */
export interface StoredData {
  server: string;
  /** 登录令牌；没登录时为空串 */
  session: string;
  email: string;
  deviceId: string;
  lastHost: string;
  lastHwnd: number;
  settings: AppSettings;
  collapsedGroups: string[];
  /** 已经登记到服务器的推送令牌（退出登录时注销用） */
  pushToken: string;
}

/**
 * 本地存储，对照安卓端 data/SettingsStore.kt。密码从不落盘；登录令牌放在系统的关键资产存储（Asset Store Kit）里，
 * 由系统加密保管，卸载 App 时一起删掉。其它设置放在 Preferences 里。
 */
export class SettingsStore {
  private static prefs(): preferences.Preferences {
    return preferences.getPreferencesSync(AppContext.context, { name: FILE });
  }

  private static str(p: preferences.Preferences, key: string): string {
    const v = p.getSync(key, '');
    return typeof v === 'string' ? v as string : '';
  }

  private static bool(p: preferences.Preferences, key: string, def: boolean): boolean {
    const v = p.getSync(key, def);
    return typeof v === 'boolean' ? v as boolean : def;
  }

  private static num(p: preferences.Preferences, key: string): number {
    const v = p.getSync(key, 0);
    return typeof v === 'number' ? v as number : 0;
  }

  static load(): StoredData {
    const p = SettingsStore.prefs();
    let deviceId = SettingsStore.str(p, 'device_id');
    if (deviceId.length === 0) {
      deviceId = util.generateRandomUUID(false).replace(/-/g, '').substring(0, 24);
      p.putSync('device_id', deviceId);
      p.flushSync();
    }
    const d = new AppSettings();
    const s = new AppSettings();
    s.keepScreenOn = SettingsStore.bool(p, 'keep_screen_on', d.keepScreenOn);
    s.haptics = SettingsStore.bool(p, 'haptics', d.haptics);
    s.showStats = SettingsStore.bool(p, 'show_stats', d.showStats);
    s.appLock = SettingsStore.bool(p, 'app_lock', d.appLock);
    s.syncClipboard = SettingsStore.bool(p, 'sync_clipboard', d.syncClipboard);
    s.privacyOnUnlock = SettingsStore.bool(p, 'privacy_on_unlock', d.privacyOnUnlock);
    const collapsed = SettingsStore.str(p, 'collapsed_groups');
    let groups: string[] = [];
    if (collapsed.length > 0) {
      try {
        groups = JSON.parse(collapsed) as string[];
      } catch (e) {
        groups = [];
      }
    }
    // 阶段 0 的验证版把令牌明文放在 Preferences 里，搬进关键资产存储
    const legacy = SettingsStore.str(p, 'token');
    if (legacy.length > 0) {
      SettingsStore.saveSession(legacy);
      p.deleteSync('token');
      p.flushSync();
    }
    return {
      server: SettingsStore.str(p, 'server'),
      session: SettingsStore.readToken(),
      email: SettingsStore.str(p, 'email'),
      deviceId: deviceId,
      lastHost: SettingsStore.str(p, 'last_host'),
      lastHwnd: SettingsStore.num(p, 'last_hwnd'),
      settings: s,
      collapsedGroups: groups,
      pushToken: SettingsStore.str(p, 'push_token')
    };
  }

  private static put(key: string, value: preferences.ValueType): void {
    try {
      const p = SettingsStore.prefs();
      p.putSync(key, value);
      p.flushSync();
    } catch (e) {
      Log.w(`保存设置 ${key} 失败：${errText(e as Object)}`);
    }
  }

  static saveServer(server: string): void {
    SettingsStore.put('server', server);
  }

  static saveEmail(email: string): void {
    SettingsStore.put('email', email);
  }

  /** 记住上次看的电脑和窗口，回到前台、重启 App 后自动回去 */
  static saveLastView(host: string, hwnd: number): void {
    SettingsStore.put('last_host', host);
    SettingsStore.put('last_hwnd', hwnd);
  }

  static saveSettings(s: AppSettings): void {
    SettingsStore.put('keep_screen_on', s.keepScreenOn);
    SettingsStore.put('haptics', s.haptics);
    SettingsStore.put('show_stats', s.showStats);
    SettingsStore.put('app_lock', s.appLock);
    SettingsStore.put('sync_clipboard', s.syncClipboard);
    SettingsStore.put('privacy_on_unlock', s.privacyOnUnlock);
  }

  static saveCollapsedGroups(keys: string[]): void {
    SettingsStore.put('collapsed_groups', JSON.stringify(keys.slice(0, MAX_COLLAPSED)));
  }

  static savePushToken(token: string): void {
    SettingsStore.put('push_token', token);
  }

  // ------------------------------------------------------------------ 登录令牌（关键资产存储）

  private static alias(): asset.AssetMap {
    const m: asset.AssetMap = new Map();
    m.set(asset.Tag.ALIAS, new util.TextEncoder().encodeInto(TOKEN_ALIAS));
    return m;
  }

  /** 保存登录令牌；空串表示清掉 */
  static saveSession(token: string): void {
    try {
      asset.removeSync(SettingsStore.alias());
    } catch (e) {
      // 原来没有，不要紧
    }
    if (token.length === 0) {
      return;
    }
    try {
      const m = SettingsStore.alias();
      m.set(asset.Tag.SECRET, new util.TextEncoder().encodeInto(token));
      // 开机后第一次解锁手机之前读不到；推送拉起 App 时手机已经解锁过
      m.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED);
      asset.addSync(m);
    } catch (e) {
      Log.e(`保存登录令牌失败：${errText(e as Object)}`);
    }
  }

  private static readToken(): string {
    try {
      const q = SettingsStore.alias();
      q.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
      const res = asset.querySync(q);
      if (res.length === 0) {
        return '';
      }
      const secret = res[0].get(asset.Tag.SECRET);
      if (secret instanceof Uint8Array) {
        return util.TextDecoder.create('utf-8').decodeToString(secret as Uint8Array);
      }
      return '';
    } catch (e) {
      // 没存过时 querySync 抛"找不到"
      return '';
    }
  }
}
