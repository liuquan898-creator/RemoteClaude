package com.remoteclaude.android.image

import kotlin.math.max
import kotlin.math.roundToInt

/** 发图前缩放尺寸的计算，不依赖 Android，有单元测试 */
object ImageSizing {
    /** 长边上限。Claude 看图时会把更大的图再缩小，传更大的只是白费流量 */
    const val MAX_EDGE = 2048

    /**
     * 解码时用的 2 的幂采样率：在保证解出来的长边不小于 [maxEdge] 的前提下尽量大，
     * 省内存，最后一步再精确缩到 [maxEdge]。
     */
    fun sampleSize(width: Int, height: Int, maxEdge: Int = MAX_EDGE): Int {
        val edge = max(width, height)
        var sample = 1
        while (edge / (sample * 2) >= maxEdge) sample *= 2
        return sample
    }

    /** 等比缩小到长边不超过 [maxEdge]；本来就不大的保持原样，不放大 */
    fun fit(width: Int, height: Int, maxEdge: Int = MAX_EDGE): Pair<Int, Int> {
        val edge = max(width, height)
        if (edge <= maxEdge || edge <= 0) return width to height
        val scale = maxEdge.toDouble() / edge
        return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
    }
}
