package com.remoteclaude.android.input

import com.remoteclaude.android.protocol.InputEvents
import org.junit.Assert.assertEquals
import org.junit.Test

class FontZoomTest {
    /** 发给电脑的就是 Claude 的三个缩放快捷键：Ctrl+=、Ctrl+-、Ctrl+0（协议文档 4.3 的按键事件） */
    @Test
    fun sendsClaudeZoomShortcuts() {
        fun event(z: FontZoom) = InputEvents.key(z.key, z.mods)
        assertEquals("""{"t":"k","k":"=","m":1}""", event(FontZoom.Larger))
        assertEquals("""{"t":"k","k":"-","m":1}""", event(FontZoom.Smaller))
        assertEquals("""{"t":"k","k":"0","m":1}""", event(FontZoom.Reset))
    }

    /** 按钮从左到右：缩小、默认、放大 */
    @Test
    fun buttonsOrder() {
        assertEquals(listOf("缩小", "默认", "放大"), FontZoom.entries.map { it.label })
    }
}
