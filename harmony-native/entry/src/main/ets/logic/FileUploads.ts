const HEX = '0123456789abcdef';

/**
 * 发文件（协议文档 4.8）用到的常量和纯计算，不依赖鸿蒙接口，有单元测试。
 * 对照安卓端 files/FileUploads.kt。Kotlin 的 Long 在这里都是 number（2^53 以内都精确，够用）。
 */
export class FileUploads {
  /** 每个二进制帧的大小，和图片一样 */
  static readonly CHUNK = 16 * 1024;
  /** 每次从文件里读这么多，再切成 CHUNK 发出 */
  static readonly READ_BLOCK = 256 * 1024;
  /** file 通道里排队超过这么多就等一等：够把中继的往返填满，又不至于撑爆通道的缓冲（16 MB 会被关掉） */
  static readonly MAX_BUFFERED = 1024 * 1024;
  /** 通道里的数据这么久一点都没送出去，算卡住了 */
  static readonly STALL_MS = 30000;
  /** 等 file 通道建好 */
  static readonly OPEN_TIMEOUT_MS = 10000;
  /** 发完以后等电脑核对、存好、粘贴路径 */
  static readonly REPLY_TIMEOUT_MS = 30000;

  /** 发出去的字节里大致已经送到网络上的：交给通道的减去还在通道里排队的 */
  static delivered(handed: number, buffered: number): number {
    return Math.min(Math.max(handed - buffered, 0), Math.max(handed, 0));
  }

  static percent(done: number, total: number): number {
    if (total <= 0) return 100;
    return Math.min(Math.max(Math.trunc((done * 100) / total), 0), 100);
  }

  static sizeText(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.floor((bytes + 1023) / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  /** "最大 100 MB" 这种说法里的大小，整 MB 时不带小数 */
  static limitText(bytes: number): string {
    const mb = 1024 * 1024;
    return bytes % mb === 0 ? `${bytes / mb} MB` : FileUploads.sizeText(bytes);
  }

  /**
   * 给电脑的文件名：系统选择器给不出名字时用 fallback。只去掉首尾空白和路径，
   * Windows 不允许的字符由电脑那边处理（被控端 files.js 的 safeName）。
   */
  static displayName(raw: string | null, fallback: string = 'file'): string {
    if (raw === null) return fallback;
    const afterSlash = raw.substring(raw.lastIndexOf('/') + 1);
    const s = afterSlash.substring(afterSlash.lastIndexOf('\\') + 1).trim();
    return s.length > 0 ? s : fallback;
  }

  /** 小写十六进制，用来写 SHA-256 摘要 */
  static hex(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i] & 0xff;
      out += HEX.charAt(v >>> 4) + HEX.charAt(v & 0x0f);
    }
    return out;
  }

  /** 放进手机输入框的路径，和电脑直接粘贴的一样（被控端 files.js 的 pasteTextFor）：有空白时加引号，末尾留一个空格 */
  static pathForInput(path: string): string {
    return (/\s/.test(path) ? `"${path}"` : path) + ' ';
  }

  /** 粘贴没成功时的原因，放进一句话里用，要短 */
  static pasteFailureText(code: string | null): string {
    switch (code) {
      case 'locked':
        return '电脑锁屏了';
      case 'front-failed':
        return '切不到那个窗口';
      case 'window-gone':
        return '窗口已关闭';
      default:
        return '出错了';
    }
  }
}

/**
 * 判断传输卡住了没有：送出去的字节数超过 limitMs 没有增加就算卡住。
 * 电脑那边断了、网络不通时，通道里的数据一直排着发不出去，不靠这个就会一直等下去。
 */
export class StallWatch {
  private readonly limitMs: number;
  private best = -1;
  private since = 0;

  constructor(limitMs: number) {
    this.limitMs = limitMs;
  }

  stalled(delivered: number, nowMs: number): boolean {
    if (delivered > this.best) {
      this.best = delivered;
      this.since = nowMs;
      return false;
    }
    return nowMs - this.since > this.limitMs;
  }
}
