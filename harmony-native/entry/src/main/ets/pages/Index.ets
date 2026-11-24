import webrtc, { VideoRenderController, ScalingMode } from '@ohos/webrtc';
import { deviceInfo } from '@kit.BasicServicesKit';
import BuildProfile from 'BuildProfile';
import { AuthApi } from '../net/AuthApi';
import { SignalingClient } from '../net/SignalingClient';
import { PeerSession } from '../rtc/PeerSession';
import { SettingsStore } from '../data/SettingsStore';
import { Log, errText } from '../common/Log';
import {
  HostInfo, IceServerSpec, Incoming, RemoteWindow, answerMessage, authMessage, downEvent, iceMessage, listMessage,
  moveEvent, selectMessage, stopMessage, upEvent, BUTTON_LEFT
} from '../protocol/Protocol';
import { parseServerAddress, ServerAddressResult } from '../protocol/ServerAddress';

/**
 * 阶段 0：验证 @ohos/webrtc 能不能用。登录 → 选电脑 → 列窗口 → 点一个 → 出画面 → 点画面发一次单击。
 * 之后会换成正式的页面。
 */
@Entry
@Component
struct Index {
  @State status: string = '';
  @State email: string = SettingsStore.getString('email');
  @State password: string = '';
  @State loggedIn: boolean = SettingsStore.getString('token').length > 0;
  @State hosts: HostInfo[] = [];
  @State hostId: string = '';
  @State windows: RemoteWindow[] = [];
  @State viewing: boolean = false;
  @State videoW: number = 0;
  @State videoH: number = 0;
  @State stageW: number = 0;
  @State stageH: number = 0;
  @State stats: string = '';
  private api: AuthApi = new AuthApi();
  private iceServers: IceServerSpec[] = [];
  private peer: PeerSession | null = null;
  private render: VideoRenderController = new VideoRenderController();
  private statsTimer: number = -1;
  private lastFrames: number = 0;
  private lastBytes: number = 0;
  private lastTs: number = 0;
  private signaling: SignalingClient = new SignalingClient({
    onOpen: () => {
      this.status = '已连上信令，正在鉴权…';
      this.signaling.send(authMessage(SettingsStore.getString('token'), 'harmony/0.2.0'));
    },
    onMessage: (msg: Incoming) => this.handle(msg),
    onClosed: () => {
      this.status = '信令断开了';
    }
  });

  private server(): ServerAddressResult {
    return parseServerAddress(BuildProfile.SERVER_ADDRESS, false);
  }

  aboutToAppear(): void {
    this.render.setScalingMode(ScalingMode.Fill);
    this.render.onFrameSizeChanged = (w: number, h: number) => {
      Log.i(`画面分辨率 ${w}x${h}`);
      this.videoW = w;
      this.videoH = h;
    };
    if (this.loggedIn) {
      this.connect();
    }
  }

  aboutToDisappear(): void {
    this.stopViewing();
    this.signaling.close();
  }

  private async login(): Promise<void> {
    const s = this.server();
    if (!s.ok) {
      this.status = s.reason;
      return;
    }
    this.status = '正在登录…';
    const r = await this.api.login(s.httpBase, this.email.trim(), this.password, {
      deviceId: SettingsStore.deviceId(),
      deviceName: deviceInfo.marketName || deviceInfo.productModel || '鸿蒙手机'
    });
    if (!r.ok) {
      this.status = r.message;
      return;
    }
    this.password = '';
    SettingsStore.putString('email', r.email);
    SettingsStore.putString('token', r.token);
    this.loggedIn = true;
    this.connect();
  }

  private connect(): void {
    const s = this.server();
    if (!s.ok) {
      this.status = s.reason;
      return;
    }
    this.status = `正在连接 ${s.url}…`;
    this.signaling.connect(s.url);
  }

  private handle(msg: Incoming): void {
    switch (msg.type) {
      case 'auth-ok': {
        this.iceServers = msg.iceServers;
        this.hosts = msg.hosts;
        this.status = `已登录 ${msg.email}，${msg.hosts.length} 台电脑，ICE 服务器 ${msg.iceServers.length} 个`;
        const online = msg.hosts.filter((h: HostInfo) => h.online);
        if (online.length > 0) {
          this.pickHost(online[0].id);
        }
        break;
      }
      case 'auth-fail':
        this.status = `鉴权失败：${msg.reason}`;
        if (msg.reason === 'bad-token' || msg.reason === 'revoked') {
          SettingsStore.remove('token');
          this.loggedIn = false;
          this.signaling.close();
        }
        break;
      case 'hosts':
        this.hosts = msg.hosts;
        break;
      case 'windows':
        if (msg.host === this.hostId) {
          this.windows = msg.list;
        }
        break;
      case 'offer':
        this.onOffer(msg.host, msg.sdp);
        break;
      case 'ice':
        this.peer?.addRemoteIce(msg.candidate);
        break;
      case 'selected':
        this.status = `已切换到 ${msg.title}`;
        break;
      case 'error':
        this.status = `错误：${msg.code}`;
        break;
      case 'window-closed':
        this.status = '窗口关了';
        this.stopViewing();
        break;
      default:
        break;
    }
  }

  private pickHost(id: string): void {
    this.hostId = id;
    this.windows = [];
    this.signaling.send(listMessage(id));
  }

  private select(w: RemoteWindow): void {
    this.status = `正在连接画面：${w.title}`;
    this.viewing = true;
    this.signaling.send(selectMessage(this.hostId, w.hwnd));
  }

  private async onOffer(host: string, sdp: string): Promise<void> {
    if (host !== this.hostId) {
      return;
    }
    this.peer?.close();
    const t0 = Date.now();
    const peer = new PeerSession(this.iceServers, {
      onLocalIce: (c) => this.signaling.send(iceMessage(host, c)),
      onVideoTrack: (track: webrtc.MediaStreamTrack) => {
        Log.i(`收到视频轨道，用时 ${Date.now() - t0}ms`);
        this.render.setVideoTrack(track);
      },
      onConnectionState: (state: string) => {
        this.status = `画面连接：${state}（${Date.now() - t0}ms）`;
      },
      onInputOpen: () => Log.i('input 通道已打开'),
      onInputError: (code: string) => {
        this.status = `电脑回报：${code}`;
      },
      onImageReply: () => {
      },
      onLockState: (s) => Log.i(`锁屏状态 ${s.locked}`),
      onUnlockResult: () => {
      },
      onTileState: () => {
      },
      onFileCaps: (max: number) => Log.i(`可以发文件，上限 ${max}`),
      onFileReply: () => {
      },
      onClipboardText: (text: string) => Log.i(`电脑复制了 ${text.length} 个字`),
      onClipboardSkipped: () => {
      }
    });
    this.peer = peer;
    try {
      const answer = await peer.acceptOffer(sdp);
      this.signaling.send(answerMessage(host, answer));
      this.startStats();
    } catch (e) {
      this.status = `应答失败：${errText(e as Object)}`;
    }
  }

  private startStats(): void {
    if (this.statsTimer >= 0) {
      clearInterval(this.statsTimer);
    }
    this.statsTimer = setInterval(() => this.readStats(), 1000);
  }

  private async readStats(): Promise<void> {
    const peer = this.peer;
    if (peer === null) {
      return;
    }
    try {
      const report = await peer.getStats();
      let line = '';
      let codecId = '';
      let pairId = '';
      const all = new Map<string, Record<string, Object>>();
      report.stats.forEach((v: webrtc.RTCStats, k: string) => {
        all.set(k, v as Object as Record<string, Object>);
      });
      all.forEach((s: Record<string, Object>) => {
        if (s['type'] === 'inbound-rtp' && s['kind'] === 'video') {
          const frames = (s['framesDecoded'] as number) ?? 0;
          const bytes = (s['bytesReceived'] as number) ?? 0;
          const ts = (s['timestamp'] as number) ?? 0;
          const dt = (ts - this.lastTs) / 1000;
          const fps = dt > 0 ? (frames - this.lastFrames) / dt : 0;
          const kbps = dt > 0 ? (bytes - this.lastBytes) * 8 / 1000 / dt : 0;
          this.lastFrames = frames;
          this.lastBytes = bytes;
          this.lastTs = ts;
          codecId = (s['codecId'] as string) ?? '';
          line += `${s['frameWidth'] ?? '?'}x${s['frameHeight'] ?? '?'} ${fps.toFixed(1)}fps ${kbps.toFixed(0)}kbps ` +
            `解码器 ${s['decoderImplementation'] ?? '?'} 丢帧 ${s['framesDropped'] ?? 0}`;
        }
        if (s['type'] === 'transport') {
          pairId = (s['selectedCandidatePairId'] as string) ?? '';
        }
      });
      const codec = all.get(codecId);
      if (codec !== undefined) {
        line += ` ${codec['mimeType']}`;
      }
      const pair = all.get(pairId);
      if (pair !== undefined) {
        const local = all.get(pair['localCandidateId'] as string);
        const remote = all.get(pair['remoteCandidateId'] as string);
        const rtt = pair['currentRoundTripTime'] as number;
        line += `\nRTT ${rtt !== undefined ? Math.round(rtt * 1000) : '?'}ms 本端 ${local?.['candidateType'] ?? '?'} ` +
          `对端 ${remote?.['candidateType'] ?? '?'}`;
      }
      this.stats = line;
    } catch (e) {
      this.stats = `统计出错：${errText(e as Object)}`;
    }
  }

  private stopViewing(): void {
    if (this.statsTimer >= 0) {
      clearInterval(this.statsTimer);
      this.statsTimer = -1;
    }
    this.render.setVideoTrack(null);
    if (this.peer !== null) {
      this.peer.close();
      this.peer = null;
      if (this.hostId.length > 0) {
        this.signaling.send(stopMessage(this.hostId));
      }
    }
    this.viewing = false;
    this.videoW = 0;
    this.videoH = 0;
  }

  /** 画面在画面区里按比例完整显示并居中时的显示宽高 */
  private fitW(): number {
    if (this.videoW <= 0 || this.stageW <= 0) {
      return 0;
    }
    const fit = Math.min(this.stageW / this.videoW, this.stageH / this.videoH);
    return this.videoW * fit;
  }

  private fitH(): number {
    if (this.videoH <= 0 || this.stageH <= 0) {
      return 0;
    }
    const fit = Math.min(this.stageW / this.videoW, this.stageH / this.videoH);
    return this.videoH * fit;
  }

  private click(localX: number, localY: number): void {
    const w = this.fitW();
    const h = this.fitH();
    if (w <= 0 || h <= 0 || this.peer === null) {
      return;
    }
    const x = localX / w;
    const y = localY / h;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      return;
    }
    this.peer.sendInput(moveEvent(x, y));
    this.peer.sendInput(downEvent(x, y, BUTTON_LEFT));
    this.peer.sendInput(upEvent(x, y, BUTTON_LEFT));
    this.status = `点了 (${x.toFixed(3)}, ${y.toFixed(3)})`;
  }

  @Builder
  loginForm() {
    Column({ space: 12 }) {
      Text('RemoteClaude 原生版（阶段 0 验证）').fontSize(20).fontColor('#F2F2F2')
      TextInput({ text: this.email, placeholder: '邮箱' })
        .type(InputType.Email)
        .onChange((v: string) => {
          this.email = v;
        })
      TextInput({ text: this.password, placeholder: '密码' })
        .type(InputType.Password)
        .onChange((v: string) => {
          this.password = v;
        })
      Button('登录').width('100%').onClick(() => {
        this.login();
      })
    }
    .padding(24)
  }

  @Builder
  windowList() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        ForEach(this.hosts, (h: HostInfo) => {
          Button(`${h.name}${h.online ? '' : '（离线）'}`)
            .fontSize(13)
            .backgroundColor(h.id === this.hostId ? '#D97757' : '#333333')
            .onClick(() => this.pickHost(h.id))
        }, (h: HostInfo) => h.id)
        Button('刷新').fontSize(13).onClick(() => this.pickHost(this.hostId))
      }

      List({ space: 6 }) {
        ForEach(this.windows, (w: RemoteWindow) => {
          ListItem() {
            Text(`${w.title}  ${w.width}×${w.height}`)
              .fontColor('#F2F2F2')
              .padding(12)
              .width('100%')
              .backgroundColor('#2A2A2A')
              .borderRadius(8)
              .onClick(() => this.select(w))
          }
        }, (w: RemoteWindow) => `${w.hwnd}`)
      }
      .layoutWeight(1)
    }
    .padding(12)
    .layoutWeight(1)
  }

  @Builder
  stage() {
    Column() {
      Row({ space: 8 }) {
        Button('返回').fontSize(13).onClick(() => this.stopViewing())
        Text(this.stats).fontSize(11).fontColor('#9FD39F').layoutWeight(1)
      }
      .padding(6)

      Stack() {
        XComponent({ type: XComponentType.SURFACE, controller: this.render })
          .width(this.fitW() > 0 ? px2vp(this.fitW()) : '100%')
          .height(this.fitH() > 0 ? px2vp(this.fitH()) : '100%')
          .gesture(TapGesture().onAction((e: GestureEvent) => {
            const f = e.fingerList[0];
            if (f !== undefined) {
              this.click(vp2px(f.localX), vp2px(f.localY));
            }
          }))
      }
      .layoutWeight(1)
      .width('100%')
      .backgroundColor(Color.Black)
      .onAreaChange((_: Area, area: Area) => {
        this.stageW = vp2px(area.width as number);
        this.stageH = vp2px(area.height as number);
      })
    }
    .layoutWeight(1)
  }

  build() {
    Column() {
      if (!this.loggedIn) {
        this.loginForm()
      } else if (this.viewing) {
        this.stage()
      } else {
        this.windowList()
      }
      Text(this.status).fontSize(12).fontColor('#A0A0A0').padding(8).width('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#1A1A1A')
  }
}
