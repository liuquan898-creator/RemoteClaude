import { connection } from '@kit.NetworkKit';
import { Log, errText } from '../common/Log';

/**
 * 监听默认网络的切换（Wi-Fi 与移动网络之间），切了就让控制器立即重连（docs/04"生命周期与网络"），
 * 对照安卓端 net/NetworkWatcher.kt。注册时系统会先报一次当前网络，那一次不算切换。
 */
export class NetworkWatcher {
  private conn: connection.NetConnection | null = null;
  private current: number = -1;

  start(onChanged: () => void): void {
    if (this.conn !== null) {
      return;
    }
    try {
      const c = connection.createNetConnection();
      c.on('netAvailable', (net: connection.NetHandle) => {
        const prev = this.current;
        this.current = net.netId;
        if (prev !== -1 && prev !== net.netId) {
          Log.i(`默认网络换了：${prev} -> ${net.netId}`);
          onChanged();
        }
      });
      c.on('netLost', (net: connection.NetHandle) => {
        if (net.netId === this.current) {
          this.current = 0; // 断了；再连上时算切换
        }
      });
      c.register(() => {
      });
      this.conn = c;
    } catch (e) {
      Log.w(`监听网络失败：${errText(e as Object)}`);
    }
  }

  stop(): void {
    const c = this.conn;
    this.conn = null;
    this.current = -1;
    if (c !== null) {
      c.unregister(() => {
      });
    }
  }
}
