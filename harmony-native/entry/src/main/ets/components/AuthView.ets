import { controller, SERVER_EDITABLE } from '../RemoteController';
import { AppState, AuthMode } from '../model/AppState';
import { RcColors } from '../common/Theme';
import BuildProfile from 'BuildProfile';

/** 登录、注册、找回密码共用一个页面，按模式显示不同的输入项（对照安卓端 ui/AuthScreen.kt） */
@ComponentV2
export struct AuthView {
  private s: AppState = controller.state;
  @Local server: string = controller.state.serverInput;
  @Local email: string = controller.state.email;
  @Local code: string = '';
  /** 密码只放在内存里 */
  @Local password: string = '';
  @Local now: number = Date.now();
  private ticker: number = -1;

  aboutToAppear(): void {
    this.ticker = setInterval(() => {
      this.now = Date.now();
    }, 500);
  }

  aboutToDisappear(): void {
    clearInterval(this.ticker);
  }

  @Monitor('s.authMode')
  onModeChanged(): void {
    this.code = '';
    this.password = '';
  }

  private submit(): void {
    switch (this.s.authMode) {
      case AuthMode.Register:
        controller.register(this.server, this.email, this.code, this.password);
        break;
      case AuthMode.Forgot:
        controller.resetPassword(this.server, this.email, this.code, this.password);
        break;
      default:
        controller.login(this.server, this.email, this.password);
        break;
    }
  }

  private cooldownLeft(): number {
    return Math.max(0, Math.ceil((this.s.codeCooldownUntil - this.now) / 1000));
  }

  private subtitle(): string {
    switch (this.s.authMode) {
      case AuthMode.Register:
        return '用邮箱注册账号。电脑上的被控端和手机登录同一个账号，就能配对使用';
      case AuthMode.Forgot:
        return '用邮箱验证码重新设置密码，所有已登录的设备都会下线';
      default:
        return '登录后查看和操作电脑上的 Claude 会话窗口';
    }
  }

  private passwordLabel(): string {
    switch (this.s.authMode) {
      case AuthMode.Register:
        return '设置密码（至少 8 位）';
      case AuthMode.Forgot:
        return '新密码（至少 8 位）';
      default:
        return '密码';
    }
  }

  private submitLabel(): string {
    switch (this.s.authMode) {
      case AuthMode.Register:
        return '注册并登录';
      case AuthMode.Forgot:
        return '重置密码';
      default:
        return '登录';
    }
  }

  private codeButtonLabel(): string {
    if (this.s.codeSending) {
      return '发送中…';
    }
    const left = this.cooldownLeft();
    return left > 0 ? `${left} 秒后重发` : '发送验证码';
  }

  @Builder
  field(label: string) {
    Text(label).fontSize(13).fontColor(RcColors.Muted).margin({ top: 12, bottom: 4 })
  }

  build() {
    Scroll() {
      Column() {
        Text('RemoteClaude').fontSize(26).fontWeight(FontWeight.Medium).fontColor(RcColors.Text)
        Text(this.subtitle()).fontSize(14).fontColor(RcColors.Muted).margin({ top: 4, bottom: 12 })
        if (SERVER_EDITABLE) {
          this.field('服务器地址')
          TextInput({ text: this.server, placeholder: BuildProfile.SERVER_ADDRESS || 'rc.example.com' })
            .type(InputType.URL)
            .onChange((v: string) => {
              this.server = v;
            })
        }
        this.field('邮箱')
        TextInput({ text: this.email, placeholder: 'a@example.com' })
          .type(InputType.Email)
          .onChange((v: string) => {
            this.email = v;
          })
        if (this.s.authMode !== AuthMode.Login) {
          this.field('验证码')
          Row({ space: 8 }) {
            TextInput({ text: this.code, placeholder: '6 位数字' })
              .type(InputType.Number)
              .maxLength(6)
              .layoutWeight(1)
              .onChange((v: string) => {
                this.code = v.replace(/\D/g, '').substring(0, 6);
              })
            Button(this.codeButtonLabel())
              .enabled(this.cooldownLeft() === 0 && !this.s.codeSending)
              .backgroundColor(RcColors.Card)
              .fontColor(RcColors.Text)
              .onClick(() => controller.sendCode(this.server, this.email))
          }
        }
        this.field(this.passwordLabel())
        TextInput({ text: this.password })
          .type(InputType.Password)
          .enterKeyType(EnterKeyType.Done)
          .onChange((v: string) => {
            this.password = v;
          })
          .onSubmit(() => this.submit())
        if (this.s.authError.length > 0) {
          Text(this.s.authError).fontColor(RcColors.Bad).fontSize(14).margin({ top: 12 })
        }
        if (this.s.authInfo.length > 0) {
          Text(this.s.authInfo).fontColor(RcColors.Ok).fontSize(14).margin({ top: 12 })
        }
        Button() {
          if (this.s.authBusy) {
            LoadingProgress().width(24).height(24).color(RcColors.AccentText)
          } else {
            Text(this.submitLabel()).fontColor(RcColors.AccentText).fontSize(16)
          }
        }
        .width('100%')
        .height(48)
        .margin({ top: 20 })
        .backgroundColor(RcColors.Accent)
        .enabled(!this.s.authBusy)
        .onClick(() => this.submit())

        Row() {
          if (this.s.authMode !== AuthMode.Login) {
            Button('去登录', { buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontColor(RcColors.Accent)
              .onClick(() => controller.setAuthMode(AuthMode.Login))
          }
          if (this.s.authMode !== AuthMode.Register) {
            Button('注册账号', { buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontColor(RcColors.Accent)
              .onClick(() => controller.setAuthMode(AuthMode.Register))
          }
          if (this.s.authMode !== AuthMode.Forgot) {
            Button('忘记密码', { buttonStyle: ButtonStyleMode.TEXTUAL })
              .fontColor(RcColors.Accent)
              .onClick(() => controller.setAuthMode(AuthMode.Forgot))
          }
        }
        .width('100%')
        .justifyContent(FlexAlign.Center)
        .margin({ top: 8 })

        if (BuildProfile.DEBUG) {
          Text('调试版：局域网里的测试服务器填 ws://电脑IP:8787').fontSize(12).fontColor(RcColors.Muted).margin({ top: 12 })
        }
      }
      .width('100%')
      .constraintSize({ maxWidth: 420 })
      .alignItems(HorizontalAlign.Start)
      .padding({ left: 24, right: 24, top: 48, bottom: 32 })
    }
    .width('100%')
    .height('100%')
    .align(Alignment.Top)
  }
}
