import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { Incoming, parseIncoming } from '../protocol/Protocol';
import { Log, errText } from '../common/Log';

export interface SignalingListener {
  /** 连接已建立，应立即发送 auth */
  onOpen: () => void;
  onMessage: (msg: Incoming) => void;
  /** 连接断开或连接失败（主动 close() 的不算） */
  onClosed: () => void;
}

/**
 * 信令 WebSocket 连接（协议第 2 节），对照安卓端 net/SignalingClient.kt。
 * 只负责连接、收发和解析，重连策略由调用方决定。主动 close() 之后不会再收到这条连接的任何回调。
 * 服务器每 30 秒 ping 一次，系统的 WebSocket 自动回 pong。
 */
export class SignalingClient {
  private socket: webSocket.WebSocket | null = null;
  /** 每次连接或关闭都加一，用来丢弃旧连接的迟到回调 */
  private generation: number = 0;
  private listener: SignalingListener;

  constructor(listener: SignalingListener) {
    this.listener = listener;
  }

  get isActive(): boolean {
    return this.socket !== null;
  }

  connect(url: string): void {
    this.close();
    const gen = this.generation;
    const ws = webSocket.createWebSocket();
    this.socket = ws;
    ws.on('open', () => {
      if (gen === this.generation) {
        this.listener.onOpen();
      }
    });
    ws.on('message', (err: BusinessError, value: string | ArrayBuffer) => {
      if (gen !== this.generation || err || typeof value !== 'string') {
        return;
      }
      const msg = parseIncoming(value as string);
      if (msg !== null) {
        this.listener.onMessage(msg);
      }
    });
    ws.on('close', () => {
      this.ended(gen);
    });
    ws.on('error', (err: BusinessError) => {
      Log.w(`信令连接出错：${errText(err)}`);
      this.ended(gen);
    });
    ws.connect(url).catch((err: BusinessError) => {
      Log.w(`信令连不上：${errText(err)}`);
      this.ended(gen);
    });
  }

  send(text: string): boolean {
    const ws = this.socket;
    if (ws === null) {
      return false;
    }
    ws.send(text).catch((err: BusinessError) => {
      Log.w(`信令发送失败：${errText(err)}`);
    });
    return true;
  }

  close(): void {
    this.generation++;
    const ws = this.socket;
    this.socket = null;
    if (ws !== null) {
      ws.off('open');
      ws.off('message');
      ws.off('close');
      ws.off('error');
      ws.close().catch(() => {
      });
    }
  }

  private ended(gen: number): void {
    if (gen !== this.generation) {
      return;
    }
    const ws = this.socket;
    this.socket = null;
    this.generation++;
    if (ws !== null) {
      ws.close().catch(() => {
      });
    }
    this.listener.onClosed();
  }
}
