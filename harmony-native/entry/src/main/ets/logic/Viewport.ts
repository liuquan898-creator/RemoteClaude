import type { RemotePoint } from './RemotePoint';

function coerceIn(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * 画面在屏幕上的摆放：完整显示时的基础缩放、用户的放大倍数和平移量，
 * 以及屏幕坐标到远程相对坐标的换算。公式见 docs/04-android-client.md 的"坐标换算"一节。
 * 对照安卓端 video/Viewport.kt。
 *
 * 纯计算，不依赖鸿蒙接口，有单元测试（harmony-native/test）。所有长度单位都是屏幕像素。
 */
export class Viewport {
  static readonly MAX_ZOOM = 6;

  private _videoW = 0;
  private _videoH = 0;
  private _stageW = 0;
  private _stageH = 0;
  private _zoom = 1;
  private _panX = 0;
  private _panY = 0;

  get videoW(): number {
    return this._videoW;
  }

  get videoH(): number {
    return this._videoH;
  }

  get stageW(): number {
    return this._stageW;
  }

  get stageH(): number {
    return this._stageH;
  }

  get zoom(): number {
    return this._zoom;
  }

  get panX(): number {
    return this._panX;
  }

  get panY(): number {
    return this._panY;
  }

  get hasContent(): boolean {
    return this._videoW > 0 && this._videoH > 0 && this._stageW > 0 && this._stageH > 0;
  }

  /** 完整显示画面所需的基础缩放 */
  get fit(): number {
    return this.hasContent ? Math.min(this._stageW / this._videoW, this._stageH / this._videoH) : 1;
  }

  /** 远程 1 像素在屏幕上占多少像素 */
  get scale(): number {
    return this.fit * this._zoom;
  }

  get displayW(): number {
    return this._videoW * this.scale;
  }

  get displayH(): number {
    return this._videoH * this.scale;
  }

  /** 屏幕上 1 像素对应远程多少像素，用来把手指移动换算成滚动量 */
  get remotePerScreenPx(): number {
    return this.hasContent ? 1 / this.scale : 1;
  }

  get isZoomed(): boolean {
    return this._zoom > 1.001;
  }

  /** 视频分辨率变了（切换会话、电脑上调整窗口大小）就还原缩放。返回是否有变化 */
  setVideoSize(w: number, h: number): boolean {
    if (w === this._videoW && h === this._videoH) return false;
    this._videoW = w;
    this._videoH = h;
    this.reset();
    return true;
  }

  setStageSize(w: number, h: number): void {
    this._stageW = w;
    this._stageH = h;
    this.clamp();
  }

  reset(): void {
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this.clamp();
  }

  /** 以屏幕上的 (cx, cy) 为中心缩放到 target 倍，手指下的内容保持不动 */
  zoomAt(cx: number, cy: number, target: number): void {
    const next = coerceIn(target, 1, Viewport.MAX_ZOOM);
    const k = next / this._zoom;
    this._panX = cx - (cx - this._panX) * k;
    this._panY = cy - (cy - this._panY) * k;
    this._zoom = next;
    this.clamp();
  }

  panBy(dx: number, dy: number): void {
    this._panX += dx;
    this._panY += dy;
    this.clamp();
  }

  /**
   * 屏幕坐标换算成远程相对坐标。落在画面外的黑边上时返回 null；
   * clampEdge 为真时改为贴到最近的边上。
   */
  toRemote(sx: number, sy: number, clampEdge: boolean = false): RemotePoint | null {
    if (!this.hasContent) return null;
    let x = (sx - this._panX) / this.displayW;
    let y = (sy - this._panY) / this.displayH;
    if (clampEdge) {
      x = coerceIn(x, 0, 1);
      y = coerceIn(y, 0, 1);
    } else if (x < 0 || x > 1 || y < 0 || y > 1) {
      return null;
    }
    return { x, y };
  }

  /** 画面比显示区小的方向居中；比显示区大的方向限制平移，不露出黑边 */
  private clamp(): void {
    if (!this.hasContent) return;
    const w = this.displayW;
    const h = this.displayH;
    this._panX = w <= this._stageW ? (this._stageW - w) / 2 : coerceIn(this._panX, this._stageW - w, 0);
    this._panY = h <= this._stageH ? (this._stageH - h) / 2 : coerceIn(this._panY, this._stageH - h, 0);
  }
}
