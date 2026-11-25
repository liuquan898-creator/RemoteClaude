import { Approval, AppUpdateInfo, HostInfo, HostState, HostUpdateState, SessionGroup } from '../protocol/Protocol';
import { AppSettings } from '../data/SettingsStore';

/** 对照安卓端 RemoteController.kt 开头的几个枚举，用字符串常量表示，ArkTS 里好比较 */
export class Screens {
  static readonly Loading = 'loading';
  static readonly Auth = 'auth';
  static readonly Sessions = 'sessions';
  static readonly Remote = 'remote';
}

/** 账号页的三种模式 */
export class AuthMode {
  static readonly Login = 'login';
  static readonly Register = 'register';
  static readonly Forgot = 'forgot';
}

/** 与信令服务器的连接状态 */
export class Link {
  static readonly Offline = 'offline';
  static readonly Connecting = 'connecting';
  static readonly Online = 'online';
}

/** 画面连接（WebRTC）的状态 */
export class RtcPhase {
  static readonly None = 'none';
  static readonly Connecting = 'connecting';
  static readonly Connected = 'connected';
  static readonly Failed = 'failed';
}

/** 会话列表页的两个页签 */
export class ListTab {
  static readonly Open = 'open';
  static readonly All = 'all';
}

/** 全部会话的加载情况：NoReply 是电脑没回话（被控端太旧），Unavailable 是电脑上没有 Claude 桌面端的会话记录 */
export class CatalogPhase {
  static readonly None = 'none';
  static readonly Loaded = 'loaded';
  static readonly Unavailable = 'unavailable';
  static readonly NoReply = 'noreply';
}

/**
 * "已打开"页签里的一个窗口；closable 为 null 表示被控端是旧版本（协议 2.8）。
 * thumbLoading：列表先到了，缩略图电脑还在截（协议 2.4），thumb 是上一次的图（data URL），没有就先空着
 */
export interface WindowItem {
  hwnd: number;
  title: string;
  minimized: boolean;
  thumb: string | null;
  closable: boolean | null;
  thumbLoading: boolean;
}

export interface CurrentWindow {
  hwnd: number;
  title: string;
}

/** 正在电脑上打开或新建会话，等它回话 */
export interface OpeningSession {
  req: string;
  label: string;
}

/**
 * 正在发的图片或文件：preparing 还在手机上处理，pasting 已经传完、等电脑存好并粘贴。
 * fileName 不为 null 表示发的是文件，可以取消
 */
export interface UploadProgress {
  sent: number;
  total: number;
  preparing: boolean;
  pasting: boolean;
  fileName: string | null;
}

/**
 * 锁定确认是为哪台电脑开的：打开时记下，提交时当前电脑换了就不发。label 是提示里的叫法（「电脑名」或"这台电脑"）
 */
export interface PcTarget {
  hostId: string;
  label: string;
}

/**
 * 输密码解锁的对话框，为哪台电脑开的（同 PcTarget）。note 是额外的说明（比如记下的密码不对了），没有时为空串；
 * canRemember：那台电脑的被控端认"记住密码"（0.9.32 起），不认时不显示那个勾、也不带 save
 */
export interface UnlockPrompt {
  hostId: string;
  label: string;
  note: string;
  canRemember: boolean;
}

/** 一条等作答的审批，带上它来自哪台电脑 */
export interface PendingApproval {
  hostId: string;
  hostName: string;
  item: Approval;
}

/** 画面统计（设置里打开"显示统计信息"时显示） */
export interface StreamStats {
  width: number;
  height: number;
  fps: number;
  kbps: number;
  rttMs: number;
  codec: string;
  decoder: string;
  route: string;
  dropped: number;
}

/**
 * 整个界面的状态，对照安卓端的 AppState。界面直接读这里的字段，RemoteController 改它们（状态管理 V2）。
 */
@ObservedV2
export class AppState {
  @Trace screen: string = Screens.Loading;
  @Trace serverInput: string = '';
  @Trace email: string = '';
  // 账号页
  @Trace authMode: string = AuthMode.Login;
  @Trace authBusy: boolean = false;
  @Trace codeSending: boolean = false;
  @Trace authError: string = '';
  @Trace authInfo: string = '';
  /** 验证码冷却结束的时刻（Date.now()） */
  @Trace codeCooldownUntil: number = 0;
  // 连接与画面
  @Trace link: string = Link.Offline;
  @Trace hosts: HostInfo[] = [];
  /** 当前选中的电脑；空串表示没选 */
  @Trace hostId: string = '';
  @Trace windows: WindowItem[] = [];
  @Trace windowsLoaded: boolean = false;
  @Trace refreshing: boolean = false;
  @Trace current: CurrentWindow | null = null;
  @Trace listTab: string = ListTab.Open;
  @Trace catalog: SessionGroup[] = [];
  @Trace catalogPhase: string = CatalogPhase.None;
  @Trace catalogRefreshing: boolean = false;
  @Trace opening: OpeningSession | null = null;
  /** 正在电脑上关掉、等回执的窗口（协议 2.8） */
  @Trace closingWindows: number[] = [];
  /** 点了关闭，但电脑上的被控端是旧版本，弹说明 */
  @Trace closeUnsupported: boolean = false;
  /** 服务器上有比本 App 新的版本（鸿蒙版暂时没有渠道，留着） */
  @Trace appUpdate: AppUpdateInfo | null = null;
  /** 当前这台电脑的被控端版本和升级状态（协议 2.6），问过才有 */
  @Trace hostUpdate: HostUpdateState | null = null;
  @Trace approvals: PendingApproval[] = [];
  @Trace showApprovals: boolean = false;
  /** 已经提交、等电脑回执的审批 id */
  @Trace answering: string[] = [];
  @Trace rtc: string = RtcPhase.None;
  @Trace hasVideo: boolean = false;
  @Trace videoWidth: number = 0;
  @Trace videoHeight: number = 0;
  @Trace upload: UploadProgress | null = null;
  /** 电脑能收文件时是单个文件的大小上限（协议 4.8），只在连着画面时知道；0 表示不知道 */
  @Trace fileMax: number = 0;
  /** 当前这台电脑的被控端认不连画面的命令（协议 2.9，被控端 0.9.6 起） */
  @Trace hostCommands: boolean = false;
  /** 当前这台电脑回了窗口列表、却没推过状态：被控端是 0.9.6 以前的版本 */
  @Trace hostTooOld: boolean = false;
  @Trace pcLocked: boolean = false;
  @Trace unlockAvailable: boolean = false;
  /** 电脑上的解锁服务核实不过（多半是旧版，要在电脑上重新安装），和"没装"分开提示 */
  @Trace unlockUntrusted: boolean = false;
  @Trace unlocking: boolean = false;
  /** 电脑记着上次解锁的密码（协议 2.9"记住解锁密码"）：点解锁时不弹输入框，直接用记下的 */
  @Trace unlockSaved: boolean = false;
  /** 电脑的被控端认"记住解锁密码"（0.9.32 起，看 host-state 里有没有布尔的 privacy） */
  @Trace unlockCanRemember: boolean = false;
  /** 输密码解锁的对话框开着，为哪台电脑开的；为 null 表示没开 */
  @Trace unlockPrompt: UnlockPrompt | null = null;
  @Trace tileAvailable: boolean = false;
  @Trace tilePaused: boolean = false;
  /** 电脑上的隐私屏开着（被控端 0.9.32 起，docs/11 第 4.4 节）：显示器盖着黑幕，电脑前的键鼠被挡住 */
  @Trace pcPrivacy: boolean = false;
  @Trace collapsedGroups: string[] = [];
  @Trace settings: AppSettings = new AppSettings();
  /** App 锁着（要验证身份才能看） */
  @Trace locked: boolean = false;
  /** 设备设置了锁屏，才能启用"打开时验证身份" */
  @Trace canLock: boolean = false;
  @Trace stats: StreamStats | null = null;
  /** 路径没能粘贴进电脑上的输入框时，放进手机上的输入框（每次变化都换一个新对象，界面据此填进去） */
  @Trace inputFill: string = '';
  @Trace inputFillSeq: number = 0;
  /** 正在发文件时点了返回：问要不要离开 */
  @Trace leaveConfirm: boolean = false;

  currentHost(): HostInfo | undefined {
    return this.hosts.find((h: HostInfo) => h.id === this.hostId);
  }

  hostOnline(): boolean {
    const h = this.currentHost();
    return h !== undefined && h.online;
  }

  /** 当前这台电脑在提示里的叫法：「电脑名」；没选电脑时是"这台电脑" */
  pcLabel(): string {
    const h = this.currentHost();
    return h !== undefined && h.name.length > 0 ? `「${h.name}」` : '这台电脑';
  }

  /** 为当前这台电脑开锁定确认时记下它 */
  pcTarget(): PcTarget {
    const t: PcTarget = { hostId: this.hostId, label: this.pcLabel() };
    return t;
  }

  /** 为当前这台电脑开解锁框时记下它；note 是额外的说明，没有时为空串 */
  unlockPromptFor(note: string): UnlockPrompt {
    const t: UnlockPrompt = { hostId: this.hostId, label: this.pcLabel(), note: note, canRemember: this.unlockCanRemember };
    return t;
  }

  /** 换成这台电脑的锁屏、平铺、隐私屏状态；hs 为 null 表示不知道 */
  applyHostState(hs: HostState | null): void {
    this.hostCommands = hs !== null;
    this.hostTooOld = false;
    this.pcLocked = hs !== null && hs.lock.locked;
    this.unlockAvailable = hs !== null && hs.lock.unlockAvailable;
    this.unlockUntrusted = hs !== null && hs.lock.unlockUntrusted;
    this.unlockSaved = hs !== null && hs.lock.saved;
    this.unlockCanRemember = hs !== null && hs.canRemember;
    this.tileAvailable = hs !== null && hs.tile.available;
    this.tilePaused = hs !== null && hs.tile.paused;
    this.pcPrivacy = hs !== null && hs.privacy;
  }
}
