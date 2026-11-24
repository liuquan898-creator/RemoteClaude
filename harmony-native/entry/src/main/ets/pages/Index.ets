import { controller } from '../RemoteController';
import { AppState, Screens } from '../model/AppState';
import { RcColors } from '../common/Theme';
import { AppLock } from '../common/AppLock';
import { AuthView } from '../components/AuthView';
import { SessionsView } from '../components/SessionsView';
import { RemoteView } from '../components/RemoteView';
import { ApprovalsView } from '../components/ApprovalsView';

/** 根页面：按状态切账号页、会话列表、画面页；App 锁、审批面板盖在上面（对照安卓端 ui/AppRoot.kt） */
@Entry
@ComponentV2
struct Index {
  private s: AppState = controller.state;

  aboutToAppear(): void {
    const ui = this.getUIContext();
    controller.toastSink = (text: string) => {
      try {
        ui.getPromptAction().showToast({ message: text, duration: 2500 });
      } catch (e) {
        // 页面还没准备好
      }
    };
  }

  @Monitor('s.locked')
  onLockedChanged(): void {
    if (this.s.locked) {
      this.unlock();
    }
  }

  /** 验证框正在显示：回到前台时 @Monitor 和 onPageShow 都会叫解锁，只弹一个 */
  private authInFlight: boolean = false;

  private unlock(): void {
    if (this.authInFlight) {
      return;
    }
    this.authInFlight = true;
    controller.authenticating = true;
    AppLock.authenticate((ok: boolean) => {
      this.authInFlight = false;
      controller.authenticating = false;
      if (ok) {
        controller.onUnlocked();
      }
    });
  }

  onPageShow(): void {
    if (this.s.locked) {
      this.unlock();
    }
  }

  onBackPress(): boolean {
    if (this.s.showApprovals) {
      controller.closeApprovals();
      return true;
    }
    if (this.s.screen === Screens.Remote) {
      controller.backFromRemote();
      return true;
    }
    return false;
  }

  @Builder
  lockScreen() {
    Column({ space: 16 }) {
      SymbolGlyph($r('sys.symbol.lock')).fontSize(48).fontColor([RcColors.Muted])
      Text('RemoteClaude 已锁定').fontSize(18).fontWeight(FontWeight.Medium).fontColor(RcColors.Text)
      Button('解锁')
        .backgroundColor(RcColors.Accent)
        .fontColor(RcColors.AccentText)
        .margin({ top: 8 })
        .onClick(() => this.unlock())
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  build() {
    Stack() {
      if (this.s.locked) {
        this.lockScreen()
      } else if (this.s.screen === Screens.Auth) {
        AuthView()
      } else if (this.s.screen === Screens.Sessions) {
        SessionsView()
      } else if (this.s.screen === Screens.Remote) {
        RemoteView()
      }
      // 审批面板在 App 锁着时不显示，解锁后再弹
      if (!this.s.locked && this.s.showApprovals) {
        ApprovalsView()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(RcColors.Bg)
  }
}
