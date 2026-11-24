import { controller, SERVER_EDITABLE } from '../RemoteController';
import { AppState } from '../model/AppState';
import { HostUpdateState } from '../protocol/Protocol';
import { AppSettings } from '../data/SettingsStore';
import { RcColors } from '../common/Theme';
import BuildProfile from 'BuildProfile';

/** 电脑被控端升级状态的说明（协议 2.6） */
function hostUpdateNote(h: HostUpdateState | null): string {
  if (h === null) {
    return '正在询问电脑…（被控端 0.7.0 以前的版本不会回答）';
  }
  switch (h.status) {
    case 'dev':
      return '从源码运行的开发版，不自动升级';
    case 'idle':
      return '还没检查更新';
    case 'checking':
      return '正在检查更新…';
    case 'latest':
      return '已是最新';
    case 'downloading':
      return `正在下载新版本 ${h.newVersion}（${h.percent}%）`;
    case 'ready':
      return `新版本 ${h.newVersion} 已下载，没人看画面时自动升级`;
    case 'installing':
      return `正在升级到 ${h.newVersion}，稍后自动重连`;
    case 'error':
      return '检查更新失败';
    default:
      return h.status;
  }
}

function hostUpdateAction(h: HostUpdateState | null): string {
  if (h === null) {
    return '';
  }
  if (h.status === 'ready') {
    return '立即升级';
  }
  return h.status === 'idle' || h.status === 'latest' || h.status === 'error' ? '检查更新' : '';
}

/** 一行开关。做成组件：@Builder 的参数按值传，开关状态变了不会跟着刷新 */
@ComponentV2
struct SwitchRow {
  @Param title: string = '';
  @Param checked: boolean = false;
  @Param enabledRow: boolean = true;
  @Param note: string = '';
  @Event onChange: (v: boolean) => void = () => {
  };

  build() {
    Row() {
      Column() {
        Text(this.title).fontSize(15).fontColor(this.enabledRow ? RcColors.Text : RcColors.Muted)
        if (this.note.length > 0) {
          Text(this.note).fontSize(12).fontColor(RcColors.Muted)
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .padding({ right: 12 })

      Toggle({ type: ToggleType.Switch, isOn: this.checked })
        .enabled(this.enabledRow)
        .selectedColor(RcColors.Accent)
        .onChange((v: boolean) => this.onChange(v))
    }
    .width('100%')
    .padding({ top: 6, bottom: 6 })
  }
}

/** 版本一行：标题、说明、右边一个按钮（可没有） */
@ComponentV2
struct VersionRow {
  @Param title: string = '';
  @Param note: string = '';
  @Param action: string = '';
  @Event onAction: () => void = () => {
  };

  build() {
    Row() {
      Column() {
        Text(this.title).fontSize(15).fontColor(RcColors.Text)
        if (this.note.length > 0) {
          Text(this.note).fontSize(12).fontColor(RcColors.Muted)
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
      .padding({ right: 12 })

      if (this.action.length > 0) {
        Button(this.action, { buttonStyle: ButtonStyleMode.TEXTUAL })
          .fontColor(RcColors.Accent)
          .onClick(() => this.onAction())
      }
    }
    .width('100%')
    .padding({ top: 4, bottom: 4 })
  }
}

/** 设置（对照安卓端 ui/SettingsSheet.kt）。从底部弹出 */
@ComponentV2
export struct SettingsView {
  private s: AppState = controller.state;
  @Event onClose: () => void = () => {
  };

  aboutToAppear(): void {
    // 打开设置时问一次电脑被控端的版本和升级状态，之后状态有变化电脑会推过来
    if (this.s.hostOnline()) {
      controller.hostUpdate('status');
    }
  }

  private hostTitle(): string {
    const h = this.s.hostUpdate;
    return '电脑被控端' + (h !== null && h.version.length > 0 ? ` ${h.version}` : '');
  }

  build() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#99000000')
        .onClick(() => this.onClose())
      Scroll() {
        Column() {
          Text('设置').fontSize(18).fontWeight(FontWeight.Medium).fontColor(RcColors.Text).margin({ bottom: 8 })
          SwitchRow({
            title: '看画面时保持屏幕常亮', checked: this.s.settings.keepScreenOn,
            onChange: (v: boolean) => controller.updateSettings((st: AppSettings) => {
              st.keepScreenOn = v;
            })
          })
          SwitchRow({
            title: '长按时震动', checked: this.s.settings.haptics,
            onChange: (v: boolean) => controller.updateSettings((st: AppSettings) => {
              st.haptics = v;
            })
          })
          SwitchRow({
            title: '显示统计信息', checked: this.s.settings.showStats, note: '分辨率、帧率、码率、延迟，以及直连还是经中继',
            onChange: (v: boolean) => controller.updateSettings((st: AppSettings) => {
              st.showStats = v;
            })
          })
          SwitchRow({
            title: '同步电脑剪贴板', checked: this.s.settings.syncClipboard,
            note: '看画面时，电脑上新复制的文字自动放进手机剪贴板',
            onChange: (v: boolean) => controller.updateSettings((st: AppSettings) => {
              st.syncClipboard = v;
            })
          })
          SwitchRow({
            title: '打开时验证身份', checked: this.s.settings.appLock && this.s.canLock, enabledRow: this.s.canLock,
            note: this.s.canLock ? '人脸、指纹或锁屏密码；离开超过 30 秒再回来时也要验证' : '这台手机没有设置锁屏密码，无法启用',
            onChange: (v: boolean) => controller.updateSettings((st: AppSettings) => {
              st.appLock = v;
            })
          })
          Text('审批提醒：App 不在前台时，电脑上的 Claude 要审批或提问会收到华为推送通知（要在 AppGallery Connect 开通推送服务），点通知回到 App 作答。')
            .fontSize(12)
            .fontColor(RcColors.Muted)
            .margin({ top: 6 })

          Divider().color(RcColors.Line).margin({ top: 12, bottom: 12 })
          Text(`账号：${this.s.email || '未登录'}`).fontSize(13).fontColor(RcColors.Muted)
          if (SERVER_EDITABLE) {
            Text(`服务器：${this.s.serverInput || '未设置'}`).fontSize(13).fontColor(RcColors.Muted)
          }
          Divider().color(RcColors.Line).margin({ top: 12, bottom: 12 })
          VersionRow({
            title: `App ${BuildProfile.VERSION_NAME}${BuildProfile.DEBUG ? '（调试版）' : ''}`,
            note: '鸿蒙版不能在 App 里下载安装新版本，新版用电脑上的安装脚本装（见 docs/10-harmony-client.md）'
          })
          if (this.s.hostOnline()) {
            VersionRow({
              title: this.hostTitle(),
              note: hostUpdateNote(this.s.hostUpdate),
              action: hostUpdateAction(this.s.hostUpdate),
              onAction: () => controller.hostUpdate(this.s.hostUpdate?.status === 'ready' ? 'install' : 'check')
            })
          }
          Button('退出登录', { buttonStyle: ButtonStyleMode.TEXTUAL })
            .fontColor(RcColors.Bad)
            .margin({ top: 8 })
            .onClick(() => {
              this.onClose();
              controller.logout();
            })
        }
        .alignItems(HorizontalAlign.Start)
        .padding({ left: 20, right: 20, top: 16, bottom: 24 })
      }
      .width('100%')
      .constraintSize({ maxHeight: '85%' })
      .backgroundColor(RcColors.Bg)
      .borderRadius({ topLeft: 16, topRight: 16 })
    }
    .width('100%')
    .height('100%')
  }
}
