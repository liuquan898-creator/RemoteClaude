/**
 * 锁定那一项现在是什么。对照安卓端 HostCommands.LockItem 枚举：
 * 做成只有两个静态实例的类，ArkTS 里照样写 LockItem.Lock、LockItem.Unlock，用 === 比较
 */
export class LockItem {
  static readonly Lock = new LockItem('Lock');
  static readonly Unlock = new LockItem('Unlock');

  /** 和 Kotlin 枚举的 name 一样 */
  readonly name: string;

  private constructor(name: string) {
    this.name = name;
  }
}

/**
 * 右上角菜单"操作电脑"那几项的显示状态（对照安卓端 HostCommands.Menu）。
 * 不叫 Menu：ArkUI 有同名的内置组件，在 .ets 里导入会挡住它
 */
export interface HostCommandsMenu {
  /** 显示平铺的三项（重排、提到最前、暂停或恢复） */
  tile: boolean;
  /** 电脑没锁时是"锁定电脑"，锁着时是"解锁电脑" */
  lock: LockItem;
  /** 锁定或解锁那一项能不能点 */
  lockEnabled: boolean;
}

/**
 * 右上角菜单里"操作电脑"的几项：重排窗口、所有会话提到最前、暂停或恢复自动平铺、锁定或解锁电脑。
 * 连着画面时走数据通道（协议文档 4.6、4.7）；停在会话列表、没连画面时走信令通道（协议文档 2.9），
 * 要电脑上的被控端 0.9.6 或更新的版本。这里只管哪几项显示、能不能点、提示什么。
 * 对照安卓端 windows/HostCommands.kt。
 */
export class HostCommands {
  /** 电脑上的被控端从这个版本起认不连画面的命令 */
  static readonly MIN_HOST_VERSION = '0.9.6';

  static readonly OK = 'ok';

  /** 被控端是旧版本时的说明 */
  static readonly UNSUPPORTED_TEXT =
    `不打开会话窗口就重排窗口、锁定和解锁电脑，要电脑上的被控端 ${HostCommands.MIN_HOST_VERSION} 或更新的版本。` +
    '可以让它现在升级，升级时被控端会重启，几十秒后自动重连。升级之前，这几项在打开某个会话窗口后的右上角菜单里。';

  /** 被控端是旧版本、又没连画面时点了命令的短提示 */
  static readonly UNSUPPORTED_TOAST = `电脑上的被控端版本太旧，升级到 ${HostCommands.MIN_HOST_VERSION} 以后才能在这里操作`;

  /**
   * @param online 连着服务器，而且当前这台电脑在线
   * @param commands 电脑的被控端认不连画面的命令（收到过它的 host-state）
   * @param rtcConnected 画面连接是通的（数据通道能用）
   * @param tileAvailable 电脑上的窗口平铺在运行
   * @param unlockAvailable 电脑上装了解锁服务
   */
  static menu(
    online: boolean,
    commands: boolean,
    rtcConnected: boolean,
    tileAvailable: boolean,
    pcLocked: boolean,
    unlockAvailable: boolean,
  ): HostCommandsMenu {
    const ready = online && (commands || rtcConnected);
    return {
      tile: ready && tileAvailable,
      lock: pcLocked ? LockItem.Unlock : LockItem.Lock,
      lockEnabled: ready && (!pcLocked || unlockAvailable),
    };
  }

  /**
   * 会话列表页要不要提示升级被控端。
   * @param tooOld 这次连上以后电脑回过窗口列表，却没推过 host-state：是旧版本。
   *   host-state 在控制端一连上时就推，总比窗口列表先到，所以回了列表还没有状态就不会再有了
   */
  static needsUpgrade(online: boolean, tooOld: boolean): boolean {
    return online && tooOld;
  }

  /** 解锁回执对应的提示；code 为 null 表示没等到回执，OK 表示解开了；其余返回 null（用画面页的通用提示） */
  static unlockText(code: string | null): string | null {
    if (code === null) return '电脑没有回应，电脑上的被控端可能需要更新';
    switch (code) {
      case HostCommands.OK:
        return '电脑已解锁';
      case 'closed':
        return '连接断开了，不知道电脑解锁了没有';
      // 被控端重启后换了密钥，手机手里的还是旧的；新的随后会推过来
      case 'bad-key':
      case 'replayed':
        return '电脑上的被控端刚重启过，请再试一次';
      // 要先盖隐私屏却没盖上，被控端没有解锁（docs/11 第 4.4 节）
      case 'privacy-failed':
        return '隐私屏没盖上，没有解锁。电脑上的解锁服务可能要重新安装；也可以在设置里关掉“解锁时打开隐私屏”';
      // 用记下的密码解锁（协议 2.9"记住解锁密码"）：不对了被控端已经删掉；或者电脑上其实没有
      case 'saved-wrong':
        return '记下的密码不对了（可能改过密码），已经删掉，请重新输入';
      case 'no-saved':
        return '电脑上没有记下的密码了，请输入密码';
      default:
        return null;
    }
  }

  /** 用记下的密码解锁的结果要不要弹输入框让用户手动输（只试一次，别的错误照常提示） */
  static needsPassword(code: string | null): boolean {
    return code === 'saved-wrong' || code === 'no-saved';
  }

  /** 开、关隐私屏（docs/11 第 4.4 节）的回执对应的提示；code 为 null 表示没等到回执 */
  static privacyText(on: boolean, code: string | null): string {
    if (code === HostCommands.OK) {
      return on ? '已打开隐私屏：电脑的显示器盖上了黑幕' : '已关闭隐私屏';
    }
    if (code === null) {
      return '电脑没有回应';
    }
    if (code === 'bad-op') {
      return '电脑上的被控端太旧，不支持隐私屏，请升级';
    }
    return on ? '隐私屏没打开，电脑上的解锁服务可能要重新安装' : '隐私屏没关掉';
  }

  /** 忘掉记下的解锁密码（forget-password）的回执对应的提示 */
  static forgetText(code: string | null): string {
    if (code === HostCommands.OK) {
      return '电脑已经忘掉记下的解锁密码';
    }
    if (code === null) {
      return '电脑没有回应';
    }
    if (code === 'bad-op') {
      return '电脑上的被控端太旧，请升级';
    }
    return `没能忘掉记下的密码（${code}）`;
  }
}
