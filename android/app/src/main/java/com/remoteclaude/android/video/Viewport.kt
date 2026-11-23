package com.remoteclaude.android.video

import com.remoteclaude.android.input.RemotePoint
import kotlin.math.min

/**
 * 画面在屏幕上的摆放：完整显示时的基础缩放、用户的放大倍数和平移量，
 * 以及屏幕坐标到远程相对坐标的换算。公式见 docs/04-android-client.md 的"坐标换算"一节。
 *
 * 纯计算，不依赖 Android，有单元测试。所有长度单位都是屏幕像素。
 */
class Viewport {
    var videoW = 0
        private set
    var videoH = 0
        private set
    var stageW = 0f
        private set
    var stageH = 0f
        private set
    var zoom = 1f
        private set
    var panX = 0f
        private set
    var panY = 0f
        private set

    val hasContent: Boolean get() = videoW > 0 && videoH > 0 && stageW > 0f && stageH > 0f

    /** 完整显示画面所需的基础缩放 */
    val fit: Float get() = if (hasContent) min(stageW / videoW, stageH / videoH) else 1f

    /** 远程 1 像素在屏幕上占多少像素 */
    val scale: Float get() = fit * zoom

    val displayW: Float get() = videoW * scale
    val displayH: Float get() = videoH * scale

    /** 屏幕上 1 像素对应远程多少像素，用来把手指移动换算成滚动量 */
    val remotePerScreenPx: Float get() = if (hasContent) 1f / scale else 1f

    val isZoomed: Boolean get() = zoom > 1.001f

    /** 视频分辨率变了（切换会话、电脑上调整窗口大小）就还原缩放。返回是否有变化 */
    fun setVideoSize(w: Int, h: Int): Boolean {
        if (w == videoW && h == videoH) return false
        videoW = w
        videoH = h
        reset()
        return true
    }

    fun setStageSize(w: Float, h: Float) {
        stageW = w
        stageH = h
        clamp()
    }

    fun reset() {
        zoom = 1f
        panX = 0f
        panY = 0f
        clamp()
    }

    /** 以屏幕上的 (cx, cy) 为中心缩放到 [target] 倍，手指下的内容保持不动 */
    fun zoomAt(cx: Float, cy: Float, target: Float) {
        val next = target.coerceIn(1f, MAX_ZOOM)
        val k = next / zoom
        panX = cx - (cx - panX) * k
        panY = cy - (cy - panY) * k
        zoom = next
        clamp()
    }

    fun panBy(dx: Float, dy: Float) {
        panX += dx
        panY += dy
        clamp()
    }

    /**
     * 屏幕坐标换算成远程相对坐标。落在画面外的黑边上时返回 null；
     * [clampEdge] 为真时改为贴到最近的边上。
     */
    fun toRemote(sx: Float, sy: Float, clampEdge: Boolean = false): RemotePoint? {
        if (!hasContent) return null
        var x = ((sx - panX) / displayW).toDouble()
        var y = ((sy - panY) / displayH).toDouble()
        if (clampEdge) {
            x = x.coerceIn(0.0, 1.0)
            y = y.coerceIn(0.0, 1.0)
        } else if (x < 0.0 || x > 1.0 || y < 0.0 || y > 1.0) {
            return null
        }
        return RemotePoint(x, y)
    }

    /** 画面比显示区小的方向居中；比显示区大的方向限制平移，不露出黑边 */
    private fun clamp() {
        if (!hasContent) return
        val w = displayW
        val h = displayH
        panX = if (w <= stageW) (stageW - w) / 2f else panX.coerceIn(stageW - w, 0f)
        panY = if (h <= stageH) (stageH - h) / 2f else panY.coerceIn(stageH - h, 0f)
    }

    companion object {
        const val MAX_ZOOM = 6f
    }
}
