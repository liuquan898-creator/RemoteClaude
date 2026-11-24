import { VideoRenderController, ScalingMode } from '@ohos/webrtc';
import { vibrator } from '@kit.SensorServiceKit';
import { controller } from '../RemoteController';
import { AppState } from '../model/AppState';
import { Viewport } from '../logic/Viewport';
import { RemotePoint } from '../logic/RemotePoint';
import { RcColors } from '../common/Theme';
import { Log } from '../common/Log';

const LONG_PRESS_MS = 550;
const DOUBLE_TAP_MS = 400;
/** 轻点判定的手指容差（vp），相当于安卓的 ViewConfiguration.scaledTouchSlop */
const TOUCH_SLOP_VP = 8;
const DOUBLE_TAP_SLOP_VP = 100;
const MIN_FLING_VELOCITY = 150;
const MAX_FLING_VELOCITY = 8000;
const FLING_TIME_CONSTANT_S = 0.3;
/** 低于这个速度（屏幕像素/秒）就停下，免得松手后拖出一长串很小的滚动 */
const FLING_STOP_VELOCITY = 200;

const MODE_IDLE = 0;
const MODE_TAP = 1;
const MODE_SCROLL = 2;
const MODE_PINCH = 3;
const MODE_DONE = 4;

/** 一次移动的记录，用来算松手时的速度 */
interface Sample {
  t: number;
  x: number;
  y: number;
}

/** "适应"按钮和画面页之间传的命令 */
@ObservedV2
export class StageCommands {
  @Trace resetSeq: number = 0;
}

/**
 * 远程画面区：显示画面，并把触摸手势翻译成远程操作（对照安卓端 video/RemoteStageView.kt，docs/04"手势映射"）。
 *
 *   单指轻点      -> 左键单击
 *   单指长按      -> 右键单击，带震动
 *   单指拖动      -> 滚动远程内容，松手后有惯性
 *   双指捏合/拖动 -> 只缩放、平移本地画面，不发事件
 *
 * 清晰度：XComponent 的大小设成视频的原始像素尺寸，渲染缓冲区就等于视频分辨率；显示时再用 scale 缩放、
 * position 平移，放大后小字也不糊（对照安卓端自写的 VideoTextureView）。
 */
@ComponentV2
export struct RemoteStage {
  @Require @Param s: AppState;
  @Require @Param commands: StageCommands;
  private render: VideoRenderController = new VideoRenderController();
  private vp: Viewport = new Viewport();
  /** 视口变了就加一，界面据此重新布局 */
  @Local layoutSeq: number = 0;

  private mode: number = MODE_IDLE;
  private downX: number = 0;
  private downY: number = 0;
  private lastX: number = 0;
  private lastY: number = 0;
  private downPoint: RemotePoint | null = null;
  private verticalAxis: boolean = true;
  private samples: Sample[] = [];
  private pinchStartDistance: number = 1;
  private pinchStartZoom: number = 1;
  private pinchMidX: number = 0;
  private pinchMidY: number = 0;
  private lastTapAt: number = 0;
  private lastTapX: number = 0;
  private lastTapY: number = 0;
  private lastTapPoint: RemotePoint | null = null;
  private longPressTimer: number = -1;
  private flingTimer: number = -1;
  private flingVelocity: number = 0;
  private flingLast: number = 0;

  aboutToAppear(): void {
    this.render.setScalingMode(ScalingMode.Fill);
    this.render.onFrameSizeChanged = (w: number, h: number) => {
      Log.i(`画面分辨率 ${w}x${h}`);
      if (this.vp.setVideoSize(w, h)) {
        this.layoutSeq++;
      }
      controller.onVideoSize(w, h);
    };
    controller.attachRenderer(this.render);
  }

  aboutToDisappear(): void {
    this.cancelLongPress();
    this.stopFling();
    controller.detachRenderer(this.render);
  }

  @Monitor('commands.resetSeq')
  onReset(): void {
    this.vp.reset();
    this.layoutSeq++;
  }

  private px(vpValue: number): number {
    return this.getUIContext().vp2px(vpValue);
  }

  private toVp(pxValue: number): number {
    return this.getUIContext().px2vp(pxValue);
  }

  // ------------------------------------------------------------------ 触摸

  private handleTouch(e: TouchEvent): void {
    const touches = e.touches;
    switch (e.type) {
      case TouchType.Down:
        if (touches.length <= 1) {
          this.onFirstDown(this.px(e.changedTouches[0].x), this.px(e.changedTouches[0].y));
        } else if (touches.length === 2) {
          this.cancelLongPress();
          this.mode = MODE_PINCH;
          this.pinchStartDistance = this.distance(touches);
          this.pinchStartZoom = this.vp.zoom;
          this.pinchMidX = this.midX(touches);
          this.pinchMidY = this.midY(touches);
        }
        break;
      case TouchType.Move:
        if (this.mode === MODE_PINCH && touches.length >= 2) {
          const mx = this.midX(touches);
          const my = this.midY(touches);
          this.vp.panBy(mx - this.pinchMidX, my - this.pinchMidY);
          this.pinchMidX = mx;
          this.pinchMidY = my;
          this.vp.zoomAt(mx, my, this.pinchStartZoom * this.distance(touches) / this.pinchStartDistance);
          this.layoutSeq++;
        } else if (touches.length >= 1) {
          const x = this.px(touches[0].x);
          const y = this.px(touches[0].y);
          this.samples.push({ t: Date.now(), x: x, y: y });
          if (this.samples.length > 8) {
            this.samples.shift();
          }
          if (this.mode === MODE_TAP && Math.hypot(x - this.downX, y - this.downY) > this.px(TOUCH_SLOP_VP)) {
            this.cancelLongPress();
            this.mode = MODE_SCROLL;
            // 起手时锁定方向：横向位移超过纵向两倍才算横向滚动
            this.verticalAxis = Math.abs(x - this.downX) <= Math.abs(y - this.downY) * 2;
          }
          if (this.mode === MODE_SCROLL) {
            this.emitScroll(x - this.lastX, y - this.lastY);
            this.lastX = x;
            this.lastY = y;
          }
        }
        break;
      case TouchType.Up:
        if (touches.length > 1) {
          // 双指操作中抬起一指后，剩下那指不再触发任何操作，直到全部抬起
          if (this.mode === MODE_PINCH) {
            this.mode = MODE_DONE;
          }
          break;
        }
        this.cancelLongPress();
        if (this.mode === MODE_TAP) {
          this.handleTap();
        } else if (this.mode === MODE_SCROLL) {
          const v = this.releaseVelocity();
          if (Math.abs(v) > MIN_FLING_VELOCITY) {
            this.startFling(Math.max(-MAX_FLING_VELOCITY, Math.min(MAX_FLING_VELOCITY, v)));
          }
        }
        this.mode = MODE_IDLE;
        this.samples = [];
        break;
      case TouchType.Cancel:
        this.cancelLongPress();
        this.mode = MODE_IDLE;
        this.samples = [];
        break;
      default:
        break;
    }
  }

  private onFirstDown(x: number, y: number): void {
    this.stopFling();
    this.mode = MODE_TAP;
    this.downX = x;
    this.downY = y;
    this.lastX = x;
    this.lastY = y;
    this.downPoint = this.vp.toRemote(x, y);
    this.samples = [{ t: Date.now(), x: x, y: y }];
    this.cancelLongPress();
    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = -1;
      if (this.mode !== MODE_TAP) {
        return;
      }
      this.mode = MODE_DONE;
      const p = this.downPoint;
      if (p === null) {
        return;
      }
      if (this.s.settings.haptics) {
        vibrator.startVibration({ type: 'time', duration: 30 }, { usage: 'touch' }).catch(() => {
        });
      }
      controller.longPress(p);
    }, LONG_PRESS_MS);
  }

  private handleTap(): void {
    let p = this.downPoint;
    if (p === null) {
      return;
    }
    const now = Date.now();
    // 连续两次轻点落在差不多的位置时，用同一个远程坐标，让电脑能认出双击
    const prev = this.lastTapPoint;
    if (prev !== null && now - this.lastTapAt < DOUBLE_TAP_MS &&
      Math.hypot(this.downX - this.lastTapX, this.downY - this.lastTapY) < this.px(DOUBLE_TAP_SLOP_VP)) {
      p = prev;
    }
    this.lastTapAt = now;
    this.lastTapX = this.downX;
    this.lastTapY = this.downY;
    this.lastTapPoint = p;
    controller.tap(p);
  }

  /** 屏幕上的手指位移换算成远程滚动量；手指向下拖，内容跟着向下（向上滚） */
  private emitScroll(dxScreen: number, dyScreen: number): void {
    const p = this.downPoint;
    if (p === null) {
      return;
    }
    const k = this.vp.remotePerScreenPx;
    if (this.verticalAxis) {
      if (dyScreen !== 0) {
        controller.scroll(p, 0, dyScreen * k);
      }
    } else if (dxScreen !== 0) {
      controller.scroll(p, -dxScreen * k, 0);
    }
  }

  /** 松手前最近一段的速度（屏幕像素/秒） */
  private releaseVelocity(): number {
    const now = Date.now();
    const recent = this.samples.filter((s: Sample) => now - s.t <= 100);
    if (recent.length < 2) {
      return 0;
    }
    const a = recent[0];
    const b = recent[recent.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) {
      return 0;
    }
    return this.verticalAxis ? (b.y - a.y) / dt : (b.x - a.x) / dt;
  }

  private startFling(v: number): void {
    this.flingVelocity = v;
    this.flingLast = Date.now();
    this.flingTimer = setInterval(() => {
      const now = Date.now();
      const dt = (now - this.flingLast) / 1000;
      this.flingLast = now;
      if (dt <= 0) {
        return;
      }
      this.flingVelocity *= Math.exp(-dt / FLING_TIME_CONSTANT_S);
      if (Math.abs(this.flingVelocity) < FLING_STOP_VELOCITY) {
        this.stopFling();
        return;
      }
      const step = this.flingVelocity * dt;
      if (this.verticalAxis) {
        this.emitScroll(0, step);
      } else {
        this.emitScroll(step, 0);
      }
    }, 16);
  }

  private stopFling(): void {
    this.flingVelocity = 0;
    if (this.flingTimer >= 0) {
      clearInterval(this.flingTimer);
      this.flingTimer = -1;
    }
  }

  private cancelLongPress(): void {
    if (this.longPressTimer >= 0) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = -1;
    }
  }

  private distance(t: TouchObject[]): number {
    return Math.max(1, Math.hypot(this.px(t[0].x - t[1].x), this.px(t[0].y - t[1].y)));
  }

  private midX(t: TouchObject[]): number {
    return this.px((t[0].x + t[1].x) / 2);
  }

  private midY(t: TouchObject[]): number {
    return this.px((t[0].y + t[1].y) / 2);
  }

  // ------------------------------------------------------------------ 布局

  /** 视频的原始尺寸（vp）；还不知道时先占满画面区 */
  private videoWVp(): number {
    this.layoutSeq;
    return this.vp.hasContent ? this.toVp(this.vp.videoW) : 0;
  }

  private videoHVp(): number {
    this.layoutSeq;
    return this.vp.hasContent ? this.toVp(this.vp.videoH) : 0;
  }

  private scaleValue(): number {
    this.layoutSeq;
    return this.vp.hasContent ? this.vp.scale : 1;
  }

  private panXVp(): number {
    this.layoutSeq;
    return this.toVp(this.vp.panX);
  }

  private panYVp(): number {
    this.layoutSeq;
    return this.toVp(this.vp.panY);
  }

  build() {
    Stack({ alignContent: Alignment.TopStart }) {
      XComponent({ type: XComponentType.SURFACE, controller: this.render })
        .width(this.videoWVp() > 0 ? this.videoWVp() : '100%')
        .height(this.videoHVp() > 0 ? this.videoHVp() : '100%')
        .position({ x: this.panXVp(), y: this.panYVp() })
        .scale({ x: this.scaleValue(), y: this.scaleValue(), centerX: 0, centerY: 0 })
        .hitTestBehavior(HitTestMode.None)
      // 盖在画面上收触摸
      Column()
        .width('100%')
        .height('100%')
        .onTouch((e: TouchEvent) => this.handleTouch(e))
    }
    .width('100%')
    .height('100%')
    .clip(true)
    .backgroundColor(RcColors.Stage)
    .onAreaChange((_: Area, area: Area) => {
      this.vp.setStageSize(this.px(area.width as number), this.px(area.height as number));
      this.layoutSeq++;
    })
  }
}
