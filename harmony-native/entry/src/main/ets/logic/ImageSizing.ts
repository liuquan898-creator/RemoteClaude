/** 缩放后的宽高（对照 Kotlin 返回的 Pair<Int, Int>） */
export interface ImageSize {
  width: number;
  height: number;
}

/** 发图前缩放尺寸的计算，不依赖鸿蒙接口，有单元测试。对照安卓端 image/ImageSizing.kt */
export class ImageSizing {
  /** 长边上限。Claude 看图时会把更大的图再缩小，传更大的只是白费流量 */
  static readonly MAX_EDGE = 2048;

  /**
   * 解码时用的 2 的幂采样率：在保证解出来的长边不小于 maxEdge 的前提下尽量大，
   * 省内存，最后一步再精确缩到 maxEdge。
   */
  static sampleSize(width: number, height: number, maxEdge: number = ImageSizing.MAX_EDGE): number {
    const edge = Math.max(width, height);
    let sample = 1;
    // maxEdge 不是正数时直接返回 1，免得死循环
    while (maxEdge > 0 && Math.floor(edge / (sample * 2)) >= maxEdge) sample *= 2;
    return sample;
  }

  /** 等比缩小到长边不超过 maxEdge；本来就不大的保持原样，不放大 */
  static fit(width: number, height: number, maxEdge: number = ImageSizing.MAX_EDGE): ImageSize {
    const edge = Math.max(width, height);
    if (edge <= maxEdge || edge <= 0) return { width, height };
    const scale = maxEdge / edge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }
}
