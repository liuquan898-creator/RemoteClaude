package com.remoteclaude.android.windows

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WindowCloseTest {
    @Test
    fun cardIsRemovedWhenClosedOrAlreadyGone() {
        assertTrue(WindowClose.removesCard(ok = true, code = ""))
        assertTrue(WindowClose.removesCard(ok = false, code = "gone"))
        // 句柄换成了别的会话、关不掉、主窗口：卡片留着（换了的会由电脑推来的新列表更新）
        for (code in listOf("changed", "still-open", "not-closable", "failed")) {
            assertFalse(code, WindowClose.removesCard(ok = false, code = code))
        }
    }

    @Test
    fun texts() {
        assertEquals("已关闭「推杆系统网口版调试」，会话还在「全部会话」里", WindowClose.resultText(true, "", "推杆系统网口版调试"))
        assertEquals("「新会话」已经关掉了", WindowClose.resultText(false, "gone", "新会话"))
        assertEquals("这个窗口刚换成了别的会话，没有关，列表已刷新", WindowClose.resultText(false, "changed", "x"))
        assertEquals("Claude 主窗口不能从手机关", WindowClose.resultText(false, "not-closable", "Claude"))
        assertEquals("电脑上的「x」没有关掉，请在电脑上看看", WindowClose.resultText(false, "still-open", "x"))
        assertEquals("没能关掉「这个窗口」（failed）", WindowClose.resultText(false, "failed", ""))
        assertTrue(WindowClose.UNSUPPORTED_TEXT.contains(WindowClose.MIN_HOST_VERSION))
    }
}
