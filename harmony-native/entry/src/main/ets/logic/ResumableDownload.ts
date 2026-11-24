const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

/**
 * 能续传的下载（docs/08）里不依赖网络和文件的几个小函数，对照安卓端 update/ResumableDownload.kt 的 companion object。
 * 下载本身（OkHttp、文件读写、重试）依赖平台接口，没有移植；鸿蒙版目前也不在 App 里下载安装新版本（见 PLAN.md 第 4 节）。
 */
export class ResumableDownload {
  /** 半截文件的文件名：sha256 前 16 位加 .part；没有哈希时用最终文件名 */
  static partName(sha256: string, finalName: string): string {
    const head = sha256.substring(0, 16);
    return (head.length > 0 ? head : finalName) + '.part';
  }

  /** 续传请求的 Range 头的值；have 为 0（从头下）时返回空串，表示不带这个头 */
  static rangeHeader(have: number): string {
    return have > 0 ? `bytes=${have}-` : '';
  }

  /**
   * 续传请求的回应从哪里接着写：200 表示服务器给了整个文件，从 0 开始重写；
   * 206 要求 Content-Range 的起点正好是已有长度 have。其它情况返回 null（这个回应不能用）。
   */
  static resumeOffset(code: number, contentRange: string | null, have: number): number | null {
    if (code === 200) return 0;
    if (code !== 206) return null;
    const m = CONTENT_RANGE.exec((contentRange ?? '').trim());
    if (m === null) return null;
    const start = Number(m[1]);
    return start === have ? start : null;
  }

  /** `bytes 100-199/1000` 里的 1000；没有或是 `*` 时返回 null */
  static totalFromContentRange(contentRange: string | null): number | null {
    const m = CONTENT_RANGE.exec((contentRange ?? '').trim());
    if (m === null || m[3] === '*') return null;
    return Number(m[3]);
  }
}
