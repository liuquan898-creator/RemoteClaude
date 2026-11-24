import { AppState, Link, PendingApproval, RtcPhase, WindowItem } from '../model/AppState';
import { RcColors } from '../common/Theme';
import { HostInfo } from '../protocol/Protocol';

/** 绿：画面已连通；黄：正在连接；红：与服务器断开或被控端不在线（对照安卓端 ui/Widgets.kt） */
export function statusColor(s: AppState): string {
  if (s.link === Link.Offline || (s.link === Link.Online && !s.hostOnline())) {
    return RcColors.Bad;
  }
  if (s.link === Link.Online && s.rtc === RtcPhase.Connected && s.hasVideo) {
    return RcColors.Ok;
  }
  return RcColors.Warn;
}

/** 连接状态的文字说明；一切正常时返回空串 */
export function connectionNotice(s: AppState): string {
  const host: HostInfo | undefined = s.currentHost();
  if (s.link === Link.Connecting) {
    return '正在连接服务器…';
  }
  if (s.link === Link.Offline) {
    return '与服务器的连接已断开';
  }
  if (s.hosts.length === 0) {
    return '这个账号还没有电脑登录。请在电脑上运行被控端，用同一个账号登录';
  }
  if (host === undefined) {
    return '请选择一台电脑';
  }
  if (!host.online) {
    return `电脑「${host.name}」不在线`;
  }
  return '';
}

/** 状态小圆点。做成组件而不是 @Builder：@Builder 的参数按值传，颜色变了不会跟着刷新 */
@ComponentV2
export struct StatusDot {
  @Param color: string = RcColors.Muted;

  build() {
    Circle().width(10).height(10).fill(this.color)
  }
}

@ComponentV2
export struct StatusBanner {
  @Require @Param s: AppState;

  build() {
    if (connectionNotice(this.s).length > 0) {
      Row({ space: 8 }) {
        StatusDot({ color: statusColor(this.s) })
        Text(connectionNotice(this.s)).fontSize(13).fontColor(RcColors.Muted).layoutWeight(1)
      }
      .width('100%')
      .backgroundColor(RcColors.Card)
      .padding({ left: 16, right: 16, top: 8, bottom: 8 })
    }
  }
}

/** 电脑锁屏时显示在顶栏下面：能解锁时给出"解锁"按钮，否则说明原因 */
@ComponentV2
export struct LockBanner {
  @Require @Param s: AppState;
  @Event onUnlock: () => void = () => {
  };

  build() {
    Row() {
      Column() {
        Text('电脑已锁屏').fontSize(15).fontWeight(FontWeight.Medium).fontColor(RcColors.Text)
        Text(this.s.unlockAvailable ? '解锁后才能操作' : '电脑上没装解锁服务，要回到电脑前解锁')
          .fontSize(12).fontColor(RcColors.Muted)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      if (this.s.unlockAvailable) {
        Button(this.s.unlocking ? '解锁中…' : '解锁')
          .enabled(!this.s.unlocking)
          .backgroundColor(RcColors.Accent)
          .fontColor(RcColors.AccentText)
          .height(36)
          .onClick(() => this.onUnlock())
      }
    }
    .width('100%')
    .backgroundColor(RcColors.Card)
    .padding({ left: 12, right: 12, top: 6, bottom: 6 })
  }
}

/** 有审批在等时显示在会话列表和画面页顶部（docs/09），点开审批面板 */
@ComponentV2
export struct ApprovalBanner {
  @Require @Param s: AppState;
  @Event onOpen: () => void = () => {
  };

  private title(): string {
    const n = this.s.approvals.length;
    const first: PendingApproval = this.s.approvals[0];
    if (n > 1) {
      return `有 ${n} 个审批等你处理`;
    }
    return first.item.kind === 'ask' ? 'Claude 在问你' : `Claude 要审批 ${first.item.tool}`;
  }

  build() {
    if (this.s.approvals.length > 0) {
      Row() {
        Column() {
          Text(this.title()).fontSize(14).fontWeight(FontWeight.Medium).fontColor(RcColors.Text)
          Text(this.s.approvals[0].item.title).fontSize(12).fontColor(RcColors.Muted).maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)

        Text('处理').fontSize(14).fontColor(RcColors.Accent).margin({ left: 12 })
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      .backgroundColor(RcColors.Card)
      .borderRadius(8)
      .border({ width: 1, color: RcColors.Warn })
      .margin({ left: 12, right: 12, top: 4, bottom: 4 })
      .onClick(() => this.onOpen())
    }
  }
}

/** 缩略图：电脑给的是 data URL，Image 直接认 */
@Builder
export function WindowThumb(item: WindowItem) {
  Stack() {
    if (item.thumb !== null) {
      Image(item.thumb).objectFit(ImageFit.Contain).width('100%').height('100%')
    } else if (!item.thumbLoading) {
      // 缩略图电脑还在截的时候先空着，不闪一下"无预览"
      Text(item.minimized ? '已最小化' : '无预览').fontSize(12).fontColor(RcColors.Muted)
    }
  }
  .width('100%')
  .height(170)
  .backgroundColor(Color.Black)
  .borderRadius(6)
  .clip(true)
}
