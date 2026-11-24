import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { picker } from '@kit.CoreFileKit';
import { controller } from '../RemoteController';
import { AppState, Link, RtcPhase, StreamStats, UploadProgress, WindowItem } from '../model/AppState';
import { FileUploads } from '../logic/FileUploads';
import { FontZoom } from '../logic/FontZoom';
import { RcColors } from '../common/Theme';
import { AppContext } from '../common/AppContext';
import { Log, errText } from '../common/Log';
import { ApprovalBanner, LockBanner, StatusDot, connectionNotice, statusColor } from './Widgets';
import { HostDialogs, HostDialogsView, HostMenuItems } from './HostPanel';
import { RcDialog } from './Dialog';
import { RemoteStage, StageCommands } from './RemoteStage';
import { SettingsView } from './SettingsView';

function stageHint(s: AppState): string {
  if (s.link !== Link.Online || !s.hostOnline()) {
    return connectionNotice(s);
  }
  if (s.current === null) {
    return '请选择要查看的会话';
  }
  if (s.rtc === RtcPhase.Failed) {
    return '画面连接失败，正在重试…';
  }
  if (s.pcLocked && !s.hasVideo) {
    return '电脑锁屏了，解锁后显示画面';
  }
  if (s.rtc !== RtcPhase.Connected || !s.hasVideo) {
    return '正在连接画面…';
  }
  return '';
}

function uploadLabel(u: UploadProgress): string {
  const percent = FileUploads.percent(u.sent, u.total);
  const file = u.fileName;
  if (file === null) {
    if (u.pasting) {
      return '图片已传到电脑，正在粘贴…';
    }
    if (u.preparing) {
      return '正在处理图片…';
    }
    return `正在发送图片 ${percent}%（${FileUploads.sizeText(u.sent)} / ${FileUploads.sizeText(u.total)}）`;
  }
  if (u.pasting) {
    return `「${file}」已传到电脑，正在保存、粘贴路径…`;
  }
  if (u.preparing) {
    return '正在读取文件…';
  }
  return `正在发送「${file}」${percent}%（${FileUploads.sizeText(u.sent)} / ${FileUploads.sizeText(u.total)}）`;
}

function statsLines(st: StreamStats): string {
  return `${st.width}×${st.height} · ${Math.round(st.fps)} fps · ${st.kbps} kbps\n` +
    `延迟 ${st.rttMs >= 0 ? `${st.rttMs} ms` : '—'} · ${st.route || '—'}\n` +
    `编码 ${st.codec || '—'}（${st.decoder || '—'}）· 丢帧 ${st.dropped}`;
}

/** 远程画面页：顶栏、画面、进度条、字体大小条、输入栏（对照安卓端 ui/RemoteScreen.kt） */
@ComponentV2
export struct RemoteView {
  private s: AppState = controller.state;
  private dialogs: HostDialogs = new HostDialogs();
  private stageCommands: StageCommands = new StageCommands();
  @Local toolsVisible: boolean = true;
  @Local showSwitcher: boolean = false;
  @Local showSettings: boolean = false;
  @Local showFontBar: boolean = false;
  @Local text: string = '';

  aboutToAppear(): void {
    this.applyKeepScreenOn(this.s.settings.keepScreenOn);
  }

  aboutToDisappear(): void {
    this.applyKeepScreenOn(false);
  }

  @Monitor('s.settings')
  onSettings(): void {
    this.applyKeepScreenOn(this.s.settings.keepScreenOn);
  }

  /** 文件存到电脑了、路径没能粘贴时，控制器把路径放进这个输入框 */
  @Monitor('s.inputFillSeq')
  onInputFill(): void {
    const path = this.s.inputFill;
    this.text = this.text.length === 0 || this.text.endsWith(' ') ? this.text + path : `${this.text} ${path}`;
  }

  private applyKeepScreenOn(on: boolean): void {
    AppContext.mainWindow?.setWindowKeepScreenOn(on).catch(() => {
    });
  }

  leave(): void {
    controller.backFromRemote();
  }

  private async pickImage(): Promise<void> {
    controller.beginPick();
    let uri = '';
    try {
      const opts = new photoAccessHelper.PhotoSelectOptions();
      opts.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
      opts.maxSelectNumber = 1;
      const r = await new photoAccessHelper.PhotoViewPicker().select(opts);
      uri = r.photoUris.length > 0 ? r.photoUris[0] : '';
    } catch (e) {
      Log.w(`选图失败：${errText(e as Object)}`);
    }
    controller.endPickImage(uri);
  }

  private async pickFile(): Promise<void> {
    if (!controller.canSendFile()) {
      return;
    }
    controller.beginPick();
    let uri = '';
    try {
      const opts = new picker.DocumentSelectOptions();
      opts.maxSelectNumber = 1;
      const r = await new picker.DocumentViewPicker(AppContext.context).select(opts);
      uri = r.length > 0 ? r[0] : '';
    } catch (e) {
      Log.w(`选文件失败：${errText(e as Object)}`);
    }
    controller.endPickFile(uri);
  }

  private send(): void {
    if (controller.sendText(this.text, true)) {
      this.text = '';
    }
  }

  @Builder
  moreMenu() {
    Menu() {
      MenuItem({ content: this.s.settings.showStats ? '隐藏统计信息' : '显示统计信息' })
        .onClick(() => controller.updateSettings((st) => {
          st.showStats = !st.showStats;
        }))
      // 只在画面页有：要对着正在看的窗口按快捷键，调完也要看着画面才知道合不合适
      MenuItem({ content: '字体大小' }).onClick(() => {
        this.showFontBar = true;
      })
      HostMenuItems(this.s, this.dialogs)
      MenuItem({ content: '设置' }).onClick(() => {
        this.showSettings = true;
      })
    }
  }

  @Builder
  attachMenu() {
    Menu() {
      MenuItem({ content: '图片' }).onClick(() => {
        this.pickImage();
      })
      MenuItem({
        content: '文件',
        labelInfo: this.s.fileMax > 0 ? `最大 ${FileUploads.limitText(this.s.fileMax)}` : ''
      }).onClick(() => {
        this.pickFile();
      })
    }
  }

  @Builder
  topBar() {
    Row() {
      Button() {
        SymbolGlyph($r('sys.symbol.chevron_left')).fontSize(24).fontColor([RcColors.Text])
      }
      .backgroundColor(Color.Transparent)
      .width(44)
      .height(44)
      .onClick(() => this.leave())

      Row({ space: 8 }) {
        StatusDot({ color: statusColor(this.s) })
        Text(this.s.current?.title ?? '选择会话')
          .fontSize(16)
          .fontColor(RcColors.Text)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .flexShrink(1)
        SymbolGlyph($r('sys.symbol.chevron_down')).fontSize(16).fontColor([RcColors.Muted])
      }
      .layoutWeight(1)
      .padding({ left: 8, right: 8, top: 6, bottom: 6 })
      .onClick(() => {
        this.showSwitcher = true;
        controller.refreshWindows();
      })

      Button('适应', { buttonStyle: ButtonStyleMode.TEXTUAL })
        .fontSize(15)
        .padding({ left: 6, right: 6 })
        .fontColor(RcColors.Accent)
        .onClick(() => {
          this.stageCommands.resetSeq++;
        })
      Button(this.toolsVisible ? '收起' : '键盘', { buttonStyle: ButtonStyleMode.TEXTUAL })
        .fontSize(15)
        .padding({ left: 6, right: 6 })
        .fontColor(RcColors.Accent)
        .onClick(() => {
          this.toolsVisible = !this.toolsVisible;
        })
      Button() {
        SymbolGlyph($r('sys.symbol.dot_grid_1x2')).fontSize(22).fontColor([RcColors.Text])
      }
      .backgroundColor(Color.Transparent)
      .width(44)
      .height(44)
      .bindMenu(this.moreMenu())
    }
    .width('100%')
    .height(52)
    .padding({ left: 4, right: 4 })
  }

  /** 进度条：在里面读 this.s.upload，不用参数（@Builder 的参数不会跟着刷新） */
  @Builder
  uploadBar() {
    Row() {
      Column({ space: 4 }) {
        Text(uploadLabel(this.up())).fontSize(13).fontColor(RcColors.Muted).maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (this.up().preparing || this.up().pasting) {
          Progress({ value: 0, total: 100, type: ProgressType.Linear }).width('100%').color(RcColors.Accent)
            .style({ enableScanEffect: true })
        } else {
          Progress({ value: FileUploads.percent(this.up().sent, this.up().total), total: 100, type: ProgressType.Linear })
            .width('100%')
            .color(RcColors.Accent)
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      if (this.up().fileName !== null && !this.up().pasting) {
        Button('取消', { buttonStyle: ButtonStyleMode.TEXTUAL })
          .fontColor(RcColors.Accent)
          .onClick(() => controller.cancelUpload())
      }
    }
    .width('100%')
    .padding({ left: 12, right: 4, top: 6, bottom: 6 })
  }

  private up(): UploadProgress {
    return this.s.upload ?? { sent: 0, total: 0, preparing: true, pasting: false, fileName: null };
  }

  @Builder
  fontBar() {
    Row({ space: 6 }) {
      Column() {
        Text('字体大小').fontSize(14).fontColor(RcColors.Text)
        Text('所有窗口一起变').fontSize(11).fontColor(RcColors.Muted).maxLines(1)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      ForEach(FontZoom.entries, (z: FontZoom) => {
        Button(z.label)
          .fontSize(14)
          .fontColor(RcColors.Text)
          .backgroundColor(RcColors.Card)
          .border({ width: 1, color: RcColors.Line })
          .borderRadius(8)
          .height(38)
          .onClick(() => controller.fontZoom(z))
      }, (z: FontZoom) => z.name)
      Button('完成', { buttonStyle: ButtonStyleMode.TEXTUAL })
        .fontColor(RcColors.Accent)
        .onClick(() => {
          this.showFontBar = false;
        })
    }
    .width('100%')
    .padding({ left: 12, right: 4, top: 6, bottom: 6 })
  }

  @Builder
  inputBar() {
    Row({ space: 6 }) {
      Button() {
        SymbolGlyph($r('sys.symbol.plus')).fontSize(22).fontColor([RcColors.Text])
      }
      .backgroundColor(RcColors.Card)
      .width(40)
      .height(40)
      .enabled(this.s.upload === null)
      .bindMenu(this.attachMenu())

      TextArea({ text: this.text, placeholder: '在这里打字，再发到远程窗口' })
        .fontSize(15)
        .placeholderFont({ size: 14 })
        .constraintSize({ maxHeight: 110 })
        .layoutWeight(1)
        .onChange((v: string) => {
          this.text = v;
        })
      Button('发送')
        .backgroundColor(RcColors.Accent)
        .fontColor(RcColors.AccentText)
        .height(40)
        .onClick(() => this.send())
    }
    .width('100%')
    .alignItems(VerticalAlign.Bottom)
    .padding({ left: 8, right: 8, top: 8, bottom: 8 })
  }

  @Builder
  switcher() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column()
        .width('100%')
        .height('100%')
        .backgroundColor('#99000000')
        .onClick(() => {
          this.showSwitcher = false;
        })
      Column() {
        Row() {
          Text('切换会话').fontSize(18).fontWeight(FontWeight.Medium).fontColor(RcColors.Text).layoutWeight(1)
          Button() {
            SymbolGlyph($r('sys.symbol.arrow_clockwise')).fontSize(22).fontColor([RcColors.Text])
          }
          .backgroundColor(Color.Transparent)
          .onClick(() => controller.refreshWindows())
        }
        .width('100%')
        .padding({ left: 20, right: 8, top: 12 })

        if (this.s.windows.length === 0) {
          Text(connectionNotice(this.s) || '电脑上没有打开的 Claude 窗口')
            .fontColor(RcColors.Muted)
            .padding(32)
        }
        List() {
          ForEach(this.s.windows, (w: WindowItem) => {
            ListItem() {
              Row({ space: 12 }) {
                Stack() {
                  if (w.thumb !== null) {
                    Image(w.thumb).objectFit(ImageFit.Contain).width('100%').height('100%')
                  }
                }
                .width(56)
                .height(56)
                .backgroundColor(Color.Black)
                .borderRadius(4)

                Text(w.title)
                  .fontSize(14)
                  .fontColor(RcColors.Text)
                  .maxLines(2)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .layoutWeight(1)
              }
              .width('100%')
              .padding({ left: 20, right: 20, top: 8, bottom: 8 })
              .backgroundColor(this.s.current?.hwnd === w.hwnd ? RcColors.Card : Color.Transparent)
              .onClick(() => {
                this.showSwitcher = false;
                controller.select(w.hwnd, w.title);
              })
            }
          }, (w: WindowItem) => `${w.hwnd}:${w.title}:${w.thumb?.length ?? 0}`)
        }
        .constraintSize({ maxHeight: 480 })
        .padding({ bottom: 16 })
      }
      .width('100%')
      .backgroundColor(RcColors.Bg)
      .borderRadius({ topLeft: 16, topRight: 16 })
    }
    .width('100%')
    .height('100%')
  }

  build() {
    Stack() {
      Column() {
        this.topBar()
        if (this.s.pcLocked) {
          LockBanner({
            s: this.s, onUnlock: () => {
              this.dialogs.unlock = true;
            }
          })
        }
        ApprovalBanner({ s: this.s, onOpen: () => controller.openApprovals() })
        Stack({ alignContent: Alignment.TopStart }) {
          RemoteStage({ s: this.s, commands: this.stageCommands })
          if (stageHint(this.s).length > 0) {
            Text(stageHint(this.s))
              .fontColor(RcColors.Muted)
              .textAlign(TextAlign.Center)
              .padding(24)
              .width('100%')
              .height('100%')
              .hitTestBehavior(HitTestMode.Transparent)
          }
          if (this.s.settings.showStats && this.s.stats !== null) {
            Text(statsLines(this.s.stats))
              .fontSize(11)
              .fontColor(Color.White)
              .fontFamily('monospace')
              .backgroundColor('#B3000000')
              .borderRadius(6)
              .padding({ left: 8, right: 8, top: 6, bottom: 6 })
              .margin(8)
              .hitTestBehavior(HitTestMode.Transparent)
          }
        }
        .layoutWeight(1)
        .width('100%')

        if (this.s.upload !== null) {
          this.uploadBar()
        }
        // 放在画面下面而不是压在画面上：调的时候整个窗口都看得见
        if (this.showFontBar) {
          this.fontBar()
        }
        if (this.toolsVisible) {
          this.inputBar()
        }
      }
      .width('100%')
      .height('100%')

      HostDialogsView({ s: this.s, dialogs: this.dialogs })
      if (this.showSwitcher) {
        this.switcher()
      }
      if (this.s.leaveConfirm) {
        RcDialog({
          title: '文件还没发完',
          message: '离开画面会断开连接，这个文件就不发了。',
          confirmText: '不发了，离开',
          cancelText: '接着发',
          onConfirm: () => {
            this.s.leaveConfirm = false;
            controller.cancelUpload();
            controller.leaveRemote();
          },
          onCancel: () => {
            this.s.leaveConfirm = false;
          }
        })
      }
      if (this.showSettings) {
        SettingsView({
          onClose: () => {
            this.showSettings = false;
          }
        })
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor(RcColors.Bg)
  }
}
