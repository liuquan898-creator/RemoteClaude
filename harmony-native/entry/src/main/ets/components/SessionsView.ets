import { controller } from '../RemoteController';
import { AppState, CatalogPhase, Link, ListTab, WindowItem } from '../model/AppState';
import { HostInfo, SessionEntry, SessionGroup } from '../protocol/Protocol';
import { HostCommands } from '../logic/HostCommands';
import { WindowClose } from '../logic/WindowClose';
import { TimeText } from '../logic/TimeText';
import { RcColors } from '../common/Theme';
import { ApprovalBanner, LockBanner, StatusBanner, StatusDot, WindowThumb } from './Widgets';
import { HostDialogs, HostDialogsView, HostMenuItems } from './HostPanel';
import { RcDialog } from './Dialog';
import { SettingsView } from './SettingsView';

/** 每组先显示这么多个会话，其余的点"显示全部"再展开 */
const SHOW_FIRST = 5;

/** 电脑没连上时两个页签共用的提示；连上了返回空串 */
function hostNotice(s: AppState): string {
  if (s.link !== Link.Online) {
    return '正在连接服务器…';
  }
  if (s.hosts.length === 0) {
    return '这个账号还没有电脑登录\n请在电脑上运行被控端，用同一个账号登录';
  }
  if (s.currentHost() === undefined) {
    return '请在上面选一台电脑';
  }
  if (!s.hostOnline()) {
    return '这台电脑不在线\n请确认电脑已开机、被控端在运行';
  }
  return '';
}

function emptyText(s: AppState): string {
  const n = hostNotice(s);
  if (n.length > 0) {
    return n;
  }
  return !s.windowsLoaded ? '正在获取窗口列表…' : '电脑上没有打开的 Claude 窗口\n可以到「全部会话」里打开一个';
}

function catalogEmptyText(s: AppState): string {
  const n = hostNotice(s);
  if (n.length > 0) {
    return n;
  }
  switch (s.catalogPhase) {
    case CatalogPhase.None:
      return '正在获取会话列表…';
    case CatalogPhase.NoReply:
      return '电脑没有回应\n被控端可能是旧版本，更新到 0.6.0 以后才能浏览会话';
    case CatalogPhase.Unavailable:
      return '电脑上没找到 Claude 桌面端的会话记录';
    default:
      return s.catalog.length === 0 ? 'Claude 桌面端里还没有会话' : '';
  }
}

/** 会话列表页：电脑切换栏、"已打开"窗口网格、"全部会话"（对照安卓端 ui/SessionsScreen.kt） */
@ComponentV2
export struct SessionsView {
  private s: AppState = controller.state;
  private dialogs: HostDialogs = new HostDialogs();
  @Local showSettings: boolean = false;
  @Local showHostUpgrade: boolean = false;
  @Local confirmNew: SessionGroup | null = null;
  /** "显示全部"展开了的组 */
  @Local expanded: string[] = [];
  @Local now: number = Date.now();
  /** 网格的宽度（vp），按它算一行放几张卡片：每张至少 150vp，和安卓的 GridCells.Adaptive(150.dp) 一样 */
  @Local gridWidth: number = 360;

  aboutToAppear(): void {
    controller.refreshWindows();
    if (this.s.listTab === ListTab.All) {
      controller.refreshCatalog();
    }
  }

  private refresh(): void {
    this.now = Date.now();
    if (this.s.listTab === ListTab.All) {
      controller.refreshCatalog();
    } else {
      controller.refreshWindows();
    }
  }

  @Builder
  menu() {
    Menu() {
      HostMenuItems(this.s, this.dialogs)
      if (HostCommands.needsUpgrade(this.s.link === Link.Online && this.s.hostOnline(), this.s.hostTooOld)) {
        MenuItem({ content: '重排窗口、锁定电脑…', labelInfo: '要先升级被控端' })
          .onClick(() => {
            this.showHostUpgrade = true;
          })
      }
      MenuItem({ content: '设置' }).onClick(() => {
        this.showSettings = true;
      })
    }
  }

  @Builder
  topBar() {
    Row() {
      Text(this.s.currentHost()?.name ?? '选择会话')
        .fontSize(20)
        .fontWeight(FontWeight.Medium)
        .fontColor(RcColors.Text)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      Button() {
        SymbolGlyph($r('sys.symbol.arrow_clockwise')).fontSize(22).fontColor([RcColors.Text])
      }
      .backgroundColor(Color.Transparent)
      .width(44)
      .height(44)
      .onClick(() => this.refresh())

      Button() {
        SymbolGlyph($r('sys.symbol.dot_grid_1x2')).fontSize(22).fontColor([RcColors.Text])
      }
      .backgroundColor(Color.Transparent)
      .width(44)
      .height(44)
      .bindMenu(this.menu())
    }
    .width('100%')
    .height(56)
    .padding({ left: 16, right: 4 })
  }

  @Builder
  hostBar() {
    Scroll() {
      Row({ space: 8 }) {
        ForEach(this.s.hosts, (h: HostInfo) => {
          Row({ space: 6 }) {
            StatusDot({ color: h.online ? RcColors.Ok : RcColors.Muted })
            Text(h.online ? h.name : `${h.name}（离线）`)
              .fontSize(14)
              .fontColor(h.online ? RcColors.Text : RcColors.Muted)
              .maxLines(1)
          }
          .padding({ left: 12, right: 12, top: 8, bottom: 8 })
          .borderRadius(18)
          .backgroundColor(h.id === this.s.hostId ? RcColors.Card : RcColors.Bg)
          .border({ width: 1, color: h.id === this.s.hostId ? RcColors.Accent : RcColors.Line })
          .onClick(() => controller.selectHost(h.id))
        }, (h: HostInfo) => `${h.id}:${h.online}:${h.name}`)
      }
      .padding({ left: 12, right: 12, top: 4, bottom: 4 })
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .width('100%')
  }

  @Builder
  tabs() {
    Row() {
      this.tab(ListTab.Open)
      this.tab(ListTab.All)
    }
    .width('100%')
    .border({ width: { bottom: 1 }, color: RcColors.Line })
  }

  private tabLabel(key: string): string {
    if (key === ListTab.All) {
      return '全部会话';
    }
    return this.s.windows.length === 0 ? '已打开' : `已打开 ${this.s.windows.length}`;
  }

  /** 页签：标题在这里按状态算（@Builder 的字符串参数是按值传的，状态变了不会跟着刷新） */
  @Builder
  tab(key: string) {
    Column() {
      Text(this.tabLabel(key))
        .fontSize(15)
        .fontColor(this.s.listTab === key ? RcColors.Accent : RcColors.Muted)
        .padding({ top: 12, bottom: 10 })
      Divider()
        .strokeWidth(2)
        .color(this.s.listTab === key ? RcColors.Accent : Color.Transparent)
        .width(48)
    }
    .layoutWeight(1)
    .onClick(() => controller.setListTab(key))
  }

  @Builder
  empty(text: string) {
    // 空状态也要能下拉，所以放在可滚动的列表里
    List() {
      ListItem() {
        Text(text)
          .fontSize(14)
          .fontColor(RcColors.Muted)
          .textAlign(TextAlign.Center)
          .width('100%')
          .padding({ top: 120, left: 32, right: 32 })
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  windowCard(w: WindowItem) {
    Column() {
      Stack({ alignContent: Alignment.TopEnd }) {
        WindowThumb(w)
        // 关闭按钮压在缩略图右上角，不挡标题。Claude 主窗口不能关，没有按钮
        if (w.closable !== false) {
          Stack() {
            Stack() {
              if (this.s.closingWindows.includes(w.hwnd)) {
                LoadingProgress().width(16).height(16).color(Color.White)
              } else {
                SymbolGlyph($r('sys.symbol.xmark')).fontSize(16).fontColor([Color.White])
              }
            }
            .width(28)
            .height(28)
            .borderRadius(14)
            .backgroundColor('#CC1E1E1E')
            .border({ width: 1, color: '#66FFFFFF' })
          }
          .width(44)
          .height(44)
          .onClick(() => controller.closeWindow(w))
        }
      }
      .width('100%')

      Text(w.title)
        .fontSize(14)
        .fontColor(RcColors.Text)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .margin({ top: 6 })
        .width('100%')
    }
    .padding(8)
    .borderRadius(10)
    .backgroundColor(RcColors.Card)
    .border({ width: 1, color: RcColors.Line })
    .opacity(this.s.closingWindows.includes(w.hwnd) ? 0.6 : 1)
    .enabled(!this.s.closingWindows.includes(w.hwnd))
    .onClick(() => controller.select(w.hwnd, w.title))
  }

  @Builder
  openTab() {
    Refresh({ refreshing: this.s.refreshing }) {
      if (this.s.windows.length === 0) {
        this.empty(emptyText(this.s))
      } else {
        Grid() {
          ForEach(this.s.windows, (w: WindowItem) => {
            GridItem() {
              this.windowCard(w)
            }
          }, (w: WindowItem) => `${w.hwnd}:${w.title}:${w.thumb?.length ?? 0}:${w.closable}`)
        }
        .columnsTemplate(this.gridColumns())
        .columnsGap(10)
        .rowsGap(10)
        .padding(12)
        .width('100%')
        .height('100%')
        .onAreaChange((_: Area, area: Area) => {
          this.gridWidth = area.width as number;
        })
      }
    }
    .onRefreshing(() => controller.refreshWindows())
    .layoutWeight(1)
  }

  @Builder
  groupHeader(g: SessionGroup) {
    Row() {
      SymbolGlyph($r(this.s.collapsedGroups.includes(g.key) ? 'sys.symbol.chevron_right' : 'sys.symbol.chevron_down'))
        .fontSize(18)
        .fontColor([RcColors.Muted])
        .margin({ right: 6 })
      Column() {
        Row({ space: 8 }) {
          Text(g.name)
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor(RcColors.Accent)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .flexShrink(1)
          // 折叠着也能看出里面有几个会话
          if (g.sessions.length > 0) {
            Text(`${g.sessions.length}`).fontSize(13).fontColor(RcColors.Muted)
          }
        }

        if (g.folder.length > 0 && g.folder !== g.name) {
          Text(g.folder)
            .fontSize(12)
            .fontColor(RcColors.Muted)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      // 只有保存过的环境能新建；按目录分出来的组没有对应的环境
      if (g.env !== null) {
        Button('＋ 新建', { buttonStyle: ButtonStyleMode.TEXTUAL })
          .fontColor(RcColors.Accent)
          .onClick(() => {
            this.confirmNew = g;
          })
      }
    }
    .width('100%')
    .constraintSize({ minHeight: 48 })
    .padding({ left: 8, right: 4, top: 6 })
    .onClick(() => controller.toggleGroup(g.key))
  }

  @Builder
  sessionRow(e: SessionEntry) {
    Row() {
      Column() {
        Text(e.title.length > 0 ? e.title : '（未命名会话）')
          .fontSize(14)
          .fontColor(RcColors.Text)
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        if (TimeText.ago(e.at, this.now).length > 0) {
          Text(TimeText.ago(e.at, this.now)).fontSize(12).fontColor(RcColors.Muted)
        }
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)

      if (e.open) {
        Text('已打开')
          .fontSize(11)
          .fontColor(RcColors.Ok)
          .padding({ left: 8, right: 8, top: 2, bottom: 2 })
          .borderRadius(10)
          .border({ width: 1, color: RcColors.Ok })
          .margin({ left: 8 })
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .backgroundColor(RcColors.Card)
    .borderRadius(8)
    .onClick(() => controller.openSession(e))
  }

  private gridColumns(): string {
    const n = Math.max(1, Math.floor((this.gridWidth - 24 + 10) / (150 + 10)));
    return new Array<string>(n).fill('1fr').join(' ');
  }

  private shown(g: SessionGroup): SessionEntry[] {
    return this.expanded.includes(g.key) ? g.sessions : g.sessions.slice(0, SHOW_FIRST);
  }

  @Builder
  catalogTab() {
    Refresh({ refreshing: this.s.catalogRefreshing }) {
      if (catalogEmptyText(this.s).length > 0) {
        this.empty(catalogEmptyText(this.s))
      } else {
        List() {
          ForEach(this.s.catalog, (g: SessionGroup) => {
            ListItemGroup({ header: this.groupHeader(g), space: 6 }) {
              if (!this.s.collapsedGroups.includes(g.key)) {
                ForEach(this.shown(g), (e: SessionEntry) => {
                  ListItem() {
                    this.sessionRow(e)
                  }
                  .padding({ left: 12, right: 12 })
                }, (e: SessionEntry) => `${e.id}:${e.title}:${e.open}:${e.at}`)
                if (g.sessions.length === 0) {
                  ListItem() {
                    Text('还没有会话').fontSize(13).fontColor(RcColors.Muted).padding({ left: 16, bottom: 8 })
                  }
                } else if (g.sessions.length > SHOW_FIRST) {
                  ListItem() {
                    Text(this.expanded.includes(g.key) ? '收起' : `显示全部 ${g.sessions.length} 个`)
                      .fontSize(13)
                      .fontColor(RcColors.Accent)
                      .width('100%')
                      .padding({ left: 16, right: 16, top: 10, bottom: 10 })
                      .onClick(() => {
                        this.expanded = this.expanded.includes(g.key) ?
                        this.expanded.filter((k: string) => k !== g.key) : this.expanded.concat([g.key]);
                      })
                  }
                }
              }
            }
          }, (g: SessionGroup) => `${g.key}:${g.sessions.length}:${this.s.collapsedGroups.includes(g.key)}:` +
          `${this.expanded.includes(g.key)}:${g.sessions.map((e: SessionEntry) => e.id + e.open).join(',')}`)
        }
        .width('100%')
        .height('100%')
        .padding({ bottom: 16 })
      }
    }
    .onRefreshing(() => {
      this.now = Date.now();
      controller.refreshCatalog();
    })
    .layoutWeight(1)
  }

  build() {
    Stack() {
      Column() {
        this.topBar()
        // 账号下有多台电脑，或者当前这台不在线时，显示电脑切换栏
        if (this.s.hosts.length > 1 || (this.s.hosts.length > 0 && !this.s.hostOnline())) {
          this.hostBar()
        }
        StatusBanner({ s: this.s })
        if (this.s.pcLocked) {
          LockBanner({
            s: this.s, onUnlock: () => {
              this.dialogs.unlock = true;
            }
          })
        }
        ApprovalBanner({ s: this.s, onOpen: () => controller.openApprovals() })
        this.tabs()
        if (this.s.listTab === ListTab.Open) {
          this.openTab()
        } else {
          this.catalogTab()
        }
      }
      .width('100%')
      .height('100%')

      HostDialogsView({ s: this.s, dialogs: this.dialogs })

      if (this.showHostUpgrade) {
        RcDialog({
          title: '电脑上的被控端版本太旧',
          message: HostCommands.UNSUPPORTED_TEXT,
          confirmText: '升级被控端',
          cancelText: '以后再说',
          onConfirm: () => {
            this.showHostUpgrade = false;
            controller.hostUpdate('install');
          },
          onCancel: () => {
            this.showHostUpgrade = false;
          }
        })
      }
      if (this.confirmNew !== null) {
        RcDialog({
          title: `在「${this.confirmNew.name}」新建会话？`,
          message: '电脑上会开一个新的会话窗口并选好这个环境，你在画面里输入第一句话就开始了。',
          confirmText: '新建',
          onConfirm: () => {
            const g = this.confirmNew;
            this.confirmNew = null;
            if (g !== null) {
              controller.newSession(g);
            }
          },
          onCancel: () => {
            this.confirmNew = null;
          }
        })
      }
      if (this.s.closeUnsupported) {
        RcDialog({
          title: '电脑上的被控端版本太旧',
          message: WindowClose.UNSUPPORTED_TEXT,
          confirmText: '升级被控端',
          cancelText: '以后再说',
          onConfirm: () => {
            controller.dismissCloseUnsupported();
            controller.hostUpdate('install');
          },
          onCancel: () => controller.dismissCloseUnsupported()
        })
      }
      if (this.s.opening !== null) {
        RcDialog({
          confirmText: '不等了',
          cancelText: '',
          onConfirm: () => controller.cancelOpening(),
          onCancel: () => {
          }
        }) {
          Row({ space: 16 }) {
            LoadingProgress().width(28).height(28).color(RcColors.Accent)
            Text(this.s.opening?.label ?? '').fontSize(15).fontColor(RcColors.Text).layoutWeight(1)
          }
        }
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
