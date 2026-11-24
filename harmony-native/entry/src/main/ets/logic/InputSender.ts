import { downEvent, keyEvent, moveEvent, textEvent, upEvent, wheelEvent } from '../protocol/Protocol';
import type { RemotePoint } from './RemotePoint';

// 调用方习惯从这里一起导入 RemotePoint
export type { RemotePoint } from './RemotePoint';

/** 定时器。平时用全局的 setTimeout / clearTimeout，单元测试里换成手动推进的假时钟 */
export interface InputTimers {
  schedule(fn: () => void, delayMs: number): number;
  cancel(handle: number): void;
}

class GlobalTimers implements InputTimers {
  schedule(fn: () => void, delayMs: number): number {
    return setTimeout(fn, delayMs);
  }

  cancel(handle: number): void {
    clearTimeout(handle);
  }
}

/**
 * 把操作编码成输入事件发给被控端。只在主线程（UI 线程）使用。对照安卓端 input/InputSender.kt。
 *
 * 滚动量先累积，每 16 毫秒最多发一条（协议文档 3.1 的要求），
 * 小数部分留到下一次，慢速拖动也不会丢掉滚动距离。
 * 安卓版只合并滚轮，移动事件只在单击时随按下、松开一起发，这里照搬。
 */
export class InputSender {
  static readonly FLUSH_INTERVAL_MS = 16;
  /** 被控端对单条滚轮事件的限制，超出的部分分到后面几条里发 */
  static readonly MAX_WHEEL = 2400;

  private readonly sendRaw: (text: string) => boolean;
  private readonly timers: InputTimers;
  private wheelX = 0;
  private wheelY = 0;
  private wheelPoint: RemotePoint | null = null;
  private flushHandle: number | null = null;

  /**
   * @param send 通过数据通道发送一条文本消息，通道没打开时返回 false
   * @param timers 不传用全局的 setTimeout / clearTimeout
   */
  constructor(send: (text: string) => boolean, timers: InputTimers | null = null) {
    this.sendRaw = send;
    this.timers = timers ?? new GlobalTimers();
  }

  /** 单击：移动、按下、松开。被控端按顺序串行处理，不需要加间隔。 */
  click(p: RemotePoint, button: number): boolean {
    if (!this.sendRaw(moveEvent(p.x, p.y))) return false;
    this.sendRaw(downEvent(p.x, p.y, button));
    this.sendRaw(upEvent(p.x, p.y, button));
    return true;
  }

  /** 累积滚动量，单位是 Windows 滚轮增量（一格 120）；dy 为正表示向上滚 */
  wheel(p: RemotePoint, dx: number, dy: number): void {
    this.wheelPoint = p;
    this.wheelX += dx;
    this.wheelY += dy;
    this.schedule();
  }

  key(key: string, mods: number): boolean {
    return this.sendRaw(keyEvent(key, mods));
  }

  text(s: string): boolean {
    return this.sendRaw(textEvent(s));
  }

  /** 切换窗口或断开时丢掉还没发出去的滚动量 */
  reset(): void {
    if (this.flushHandle !== null) {
      this.timers.cancel(this.flushHandle);
      this.flushHandle = null;
    }
    this.wheelX = 0;
    this.wheelY = 0;
    this.wheelPoint = null;
  }

  private schedule(): void {
    if (this.flushHandle !== null) return;
    this.flushHandle = this.timers.schedule(() => {
      this.flushHandle = null;
      this.flushWheel();
    }, InputSender.FLUSH_INTERVAL_MS);
  }

  private flushWheel(): void {
    const p = this.wheelPoint;
    if (p === null) return;
    // 向零取整，余下的小数部分留到下一次
    const max = InputSender.MAX_WHEEL;
    const dx = Math.min(Math.max(Math.trunc(this.wheelX), -max), max);
    const dy = Math.min(Math.max(Math.trunc(this.wheelY), -max), max);
    if (dx === 0 && dy === 0) return;
    this.sendRaw(wheelEvent(p.x, p.y, dx, dy));
    this.wheelX -= dx;
    this.wheelY -= dy;
    if (Math.abs(this.wheelX) >= 1 || Math.abs(this.wheelY) >= 1) this.schedule();
  }
}
