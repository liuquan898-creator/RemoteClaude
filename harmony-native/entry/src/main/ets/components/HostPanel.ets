import { controller } from '../RemoteController';
import { AppState, Link, RtcPhase } from '../model/AppState';
import { HostCommands, HostCommandsMenu } from '../logic/HostCommands';
import { RcColors } from '../common/Theme';
import { RcDialog } from './Dialog';

/**
 * 会话列表页和画面页右上角菜单里"操作电脑"的部分（对照安卓端 ui/HostMenu.kt）：重排窗口、所有会话提到最前、
 * 暂停或恢复自动平铺、锁定或解锁电脑，以及锁定确认、输入密码的对话框。两个页面共用。
 */
@ObservedV2
export class HostDialogs {
  @Trace lockConfirm: boolean = false;
  @Trace unlock: boolean = false;
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
        dialogs.unlock = true;
      })
  } else {
    MenuItem({ content: '锁定电脑' })
      .enabled(hostMenu(s).lockEnabled)
      .onClick(() => {
        dialogs.lockConfirm = true;
      })
  }
}

/** 锁定确认和输入密码的对话框，放在页面最外层的 Stack 里 */
@ComponentV2
export struct HostDialogsView {
  @Require @Param s: AppState;
  @Require @Param dialogs: HostDialogs;
  /** 密码只在这个对话框的内存里，发出去就丢掉 */
  @Local password: string = '';

  private submit(): void {
    const p = this.password;
    this.password = '';
    this.dialogs.unlock = false;
    if (p.length > 0) {
      controller.unlockPc(p);
    }
  }

  build() {
    Stack() {
      if (this.dialogs.lockConfirm) {
        RcDialog({
          title: '锁定电脑？',
          message: this.s.unlockAvailable ? '效果和在电脑上按 Win+L 一样。之后可以在这里输入 Windows 密码或 PIN 解锁。' :
            this.s.unlockUntrusted ?
              '效果和在电脑上按 Win+L 一样。这台电脑上的解锁服务要重新安装（版本太旧或没通过核实），锁定后只能回到电脑前解锁。' :
              '效果和在电脑上按 Win+L 一样。这台电脑没装解锁服务，锁定后只能回到电脑前解锁。',
          confirmText: '锁定',
          onConfirm: () => {
            this.dialogs.lockConfirm = false;
            controller.lockPc();
          },
          onCancel: () => {
            this.dialogs.lockConfirm = false;
          }
        })
      }
      if (this.dialogs.unlock) {
        RcDialog({
          title: '解锁电脑',
          message: '输入这台电脑的 Windows 登录密码或 PIN。只用这一次，手机和电脑都不保存。',
          confirmText: '解锁',
          confirmEnabled: this.password.length > 0,
          onConfirm: () => this.submit(),
          onCancel: () => {
            this.password = '';
            this.dialogs.unlock = false;
          }
        }) {
          TextInput({ text: this.password, placeholder: '密码或 PIN' })
            .type(InputType.Password)
            .defaultFocus(true)
            .enterKeyType(EnterKeyType.Done)
            .onChange((v: string) => {
              this.password = v;
            })
            .onSubmit(() => this.submit())
        }
      }
    }
    .width('100%')
    .height('100%')
    .hitTestBehavior(this.dialogs.lockConfirm || this.dialogs.unlock ? HitTestMode.Default : HitTestMode.Transparent)
  }
}
