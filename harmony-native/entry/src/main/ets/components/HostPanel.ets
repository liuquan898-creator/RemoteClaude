import { controller } from '../RemoteController';
import { AppState, Link, PcTarget, RtcPhase, UnlockPrompt } from '../model/AppState';
import { HostCommands, HostCommandsMenu } from '../logic/HostCommands';
import { RcColors } from '../common/Theme';
import { RcDialog } from './Dialog';

/**
 * 会话列表页和画面页右上角菜单里"操作电脑"的部分（对照安卓端 ui/HostMenu.kt）：重排窗口、所有会话提到最前、
 * 暂停或恢复自动平铺、锁定或解锁电脑、开关隐私屏、忘掉记下的解锁密码，以及锁定确认、输入密码的对话框。两个页面共用。
 * 输密码的对话框开没开记在 AppState.unlockPrompt 里：记下的密码不对了时控制器也要弹它
 */
@ObservedV2
export class HostDialogs {
  /** 锁定确认是为哪台电脑开的；为 null 表示没开 */
  @Trace lockConfirm: PcTarget | null = null;
}

export function hostMenu(s: AppState): HostCommandsMenu {
  return HostCommands.menu(
    s.link === Link.Online && s.hostOnline(),
    s.hostCommands,
    s.rtc === RtcPhase.Connected,
    s.tileAvailable,
    s.pcLocked,
    s.unlockAvailable
  );
}

/** 菜单里的这几项，放进页面的菜单构建函数里 */
@Builder
export function HostMenuItems(s: AppState, dialogs: HostDialogs) {
  if (hostMenu(s).tile) {
    MenuItem({ content: '重排窗口' }).onClick(() => controller.tile('arrange'))
    MenuItem({ content: '所有会话提到最前' }).onClick(() => controller.tile('raise'))
    MenuItem({ content: s.tilePaused ? '恢复自动平铺' : '暂停自动平铺' })
      .onClick(() => controller.tile(s.tilePaused ? 'resume' : 'pause'))
  }
  if (s.pcLocked) {
    MenuItem({ content: s.unlocking ? '正在解锁电脑…' : '解锁电脑' })
      .enabled(hostMenu(s).lockEnabled && !s.unlocking)
      .onClick(() => {
        controller.requestUnlock();
      })
  } else {
    MenuItem({ content: '锁定电脑' })
      .enabled(hostMenu(s).lockEnabled)
      .onClick(() => {
        dialogs.lockConfirm = s.pcTarget();
      })
  }
  // 隐私屏（docs/11 第 4.4 节）走信令通道的 host-cmd、要靠解锁服务：电脑认这种命令、服务装了且核实过才显示；
  // 锁着时不显示，解锁那一下会按设置自动盖。被控端 0.9.32 起才有（host-state 带布尔的 privacy，unlockCanRemember
  // 就是拿它认的版本），0.9.6 到 0.9.31 回 bad-op，不显示
  if (s.hostCommands && s.unlockCanRemember && s.unlockAvailable && !s.pcLocked) {
    MenuItem({ content: s.pcPrivacy ? '关闭隐私屏' : '打开隐私屏' })
      .enabled(hostMenu(s).lockEnabled)
      .onClick(() => {
        controller.setPrivacy(!s.pcPrivacy);
      })
  }
  // 电脑记着解锁密码时才显示（协议 2.9"记住解锁密码"），这个命令只走信令通道
  if (s.hostCommands && s.unlockSaved) {
    MenuItem({ content: '忘掉记下的解锁密码' })
      .enabled(hostMenu(s).lockEnabled)
      .onClick(() => {
        controller.forgetUnlockPassword();
      })
  }
}

/**
 * 输密码解锁的对话框。只在 AppState.unlockPrompt 不为 null 时建出来：关掉（取消、发出、退出登录、换电脑、退到后台）
 * 就连同输了一半的密码一起销毁，下次打开是空的
 */
@ComponentV2
struct UnlockPromptDialog {
  @Require @Param prompt: UnlockPrompt | null;
  /** 密码只在这个对话框的内存里，发出去就丢掉 */
  @Local password: string = '';
  /** "记住密码"，默认勾着（协议 2.9"记住解锁密码"）；被控端不认时不显示 */
  @Local remember: boolean = true;

  /** 框还开着、却换成了另一次弹出（别的电脑、记下的密码不对了）：清掉输了一半的密码 */
  @Monitor('prompt')
  onPromptChanged(): void {
    this.password = '';
    this.remember = true;
  }

  private close(): void {
    this.password = '';
    controller.dismissUnlockPrompt();
  }

  /** 发给对话框打开时的那台电脑；当前电脑换了，控制器不发、会提示 */
  private submit(): void {
    const t = this.prompt;
    const p = this.password;
    // 被控端不认"记住密码"（框里没显示那个勾）就不带 save
    const save: boolean | null = t !== null && t.canRemember ? this.remember : null;
    this.close();
    if (t !== null && p.length > 0) {
      controller.unlockPc(t.hostId, p, save);
    }
  }

  private title(): string {
    const t = this.prompt;
    return `解锁${t !== null ? t.label : '这台电脑'}`;
  }

  /** 弹框的原因，比如记下的密码不对了；平常没有 */
  private note(): string {
    const t = this.prompt;
    return t !== null ? t.note : '';
  }

  private canRemember(): boolean {
    const t = this.prompt;
    return t !== null && t.canRemember;
  }

  build() {
    RcDialog({
      title: this.title(),
      message: this.canRemember() ? '输入这台电脑的 Windows 登录密码或 PIN。' :
        '输入这台电脑的 Windows 登录密码或 PIN。只用这一次，手机和电脑都不保存。',
      confirmText: '解锁',
      confirmEnabled: this.password.length > 0,
      onConfirm: () => this.submit(),
      onCancel: () => this.close()
    }) {
      if (this.note().length > 0) {
        Text(this.note()).fontSize(13).fontColor(RcColors.Warn)
      }
      TextInput({ text: this.password, placeholder: '密码或 PIN' })
        .type(InputType.Password)
        .defaultFocus(true)
        .enterKeyType(EnterKeyType.Done)
        .onChange((v: string) => {
          this.password = v;
        })
        .onSubmit(() => this.submit())
      if (this.canRemember()) {
        Row({ space: 8 }) {
          Toggle({ type: ToggleType.Checkbox, isOn: this.remember })
            .selectedColor(RcColors.Accent)
            .onChange((v: boolean) => {
              this.remember = v;
            })
          Text('记住密码')
            .fontSize(14)
            .fontColor(RcColors.Text)
            .onClick(() => {
              this.remember = !this.remember;
            })
        }
        Text(this.remember ? '密码加密后存在服务器上，只有这台电脑解得开；下次从手机解锁不用再输' :
          '只用这一次，手机和电脑都不保存；原来记下的也一起删掉')
          .fontSize(12)
          .fontColor(RcColors.Muted)
      }
    }
  }
}

/** 锁定确认和输入密码的对话框，放在页面最外层的 Stack 里 */
@ComponentV2
export struct HostDialogsView {
  @Require @Param s: AppState;
  @Require @Param dialogs: HostDialogs;

  /** 锁定确认是为原来那台电脑开的：换了电脑就关掉（提交时还会再核对一次） */
  @Monitor('s.hostId')
  onHostChanged(): void {
    this.dialogs.lockConfirm = null;
  }

  private confirmLock(): void {
    const t = this.dialogs.lockConfirm;
    this.dialogs.lockConfirm = null;
    if (t !== null) {
      controller.lockPc(t.hostId);
    }
  }

  private lockTitle(): string {
    const t = this.dialogs.lockConfirm;
    return `锁定${t !== null ? t.label : '这台电脑'}？`;
  }

  build() {
    Stack() {
      if (this.dialogs.lockConfirm !== null) {
        RcDialog({
          title: this.lockTitle(),
          message: this.s.unlockAvailable ? '效果和在电脑上按 Win+L 一样。之后可以在这里输入 Windows 密码或 PIN 解锁。' :
            this.s.unlockUntrusted ?
              '效果和在电脑上按 Win+L 一样。这台电脑上的解锁服务要重新安装（版本太旧或没通过核实），锁定后只能回到电脑前解锁。' :
              '效果和在电脑上按 Win+L 一样。这台电脑没装解锁服务，锁定后只能回到电脑前解锁。',
          confirmText: '锁定',
          onConfirm: () => this.confirmLock(),
          onCancel: () => {
            this.dialogs.lockConfirm = null;
          }
        })
      }
      if (this.s.unlockPrompt !== null) {
        UnlockPromptDialog({ prompt: this.s.unlockPrompt })
      }
    }
    .width('100%')
    .height('100%')
    .hitTestBehavior(this.dialogs.lockConfirm !== null || this.s.unlockPrompt !== null ? HitTestMode.Default :
      HitTestMode.Transparent)
  }
}
