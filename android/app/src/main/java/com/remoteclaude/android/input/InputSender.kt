package com.remoteclaude.android.input

import android.os.Handler
import android.os.Looper
import com.remoteclaude.android.protocol.InputEvents
import kotlin.math.abs

/**
 * 把操作编码成输入事件发给被控端。只在主线程使用。
 *
 * 滚动量先累积，每 16 毫秒最多发一条（协议文档 3.1 的要求），
 * 小数部分留到下一次，慢速拖动也不会丢掉滚动距离。
 *
 * @param sendRaw 通过数据通道发送一条文本消息，通道没打开时返回 false
 */
class InputSender(private val sendRaw: (String) -> Boolean) {
    private val handler = Handler(Looper.getMainLooper())
    private var wheelX = 0.0
    private var wheelY = 0.0
    private var wheelPoint: RemotePoint? = null
    private var flushScheduled = false
    private val flush = Runnable {
        flushScheduled = false
        flushWheel()
    }

    /** 单击：移动、按下、松开。被控端按顺序串行处理，不需要加间隔。 */
    fun click(p: RemotePoint, button: Int): Boolean {
        if (!sendRaw(InputEvents.move(p))) return false
        sendRaw(InputEvents.down(p, button))
        sendRaw(InputEvents.up(p, button))
        return true
    }

    /** 累积滚动量，单位是 Windows 滚轮增量（一格 120）；dy 为正表示向上滚 */
    fun wheel(p: RemotePoint, dx: Double, dy: Double) {
        wheelPoint = p
        wheelX += dx
        wheelY += dy
        schedule()
    }

    fun key(key: String, mods: Int): Boolean = sendRaw(InputEvents.key(key, mods))

    fun text(s: String): Boolean = sendRaw(InputEvents.text(s))

    /** 切换窗口或断开时丢掉还没发出去的滚动量 */
    fun reset() {
        handler.removeCallbacks(flush)
        flushScheduled = false
        wheelX = 0.0
        wheelY = 0.0
        wheelPoint = null
    }

    private fun schedule() {
        if (flushScheduled) return
        flushScheduled = true
        handler.postDelayed(flush, FLUSH_INTERVAL_MS)
    }

    private fun flushWheel() {
        val p = wheelPoint ?: return
        // toInt 向零取整，余下的小数部分留到下一次
        val dx = wheelX.toInt().coerceIn(-MAX_WHEEL, MAX_WHEEL)
        val dy = wheelY.toInt().coerceIn(-MAX_WHEEL, MAX_WHEEL)
        if (dx == 0 && dy == 0) return
        sendRaw(InputEvents.wheel(p, dx, dy))
        wheelX -= dx
        wheelY -= dy
        if (abs(wheelX) >= 1.0 || abs(wheelY) >= 1.0) schedule()
    }

    private companion object {
        const val FLUSH_INTERVAL_MS = 16L
        /** 被控端对单条滚轮事件的限制，超出的部分分到后面几条里发 */
        const val MAX_WHEEL = 2400
    }
}
