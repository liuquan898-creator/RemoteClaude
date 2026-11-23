package com.remoteclaude.android.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

class TimeTextTest {
    private val tz = TimeZone.getTimeZone("Asia/Shanghai")

    private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int): Long =
        Calendar.getInstance(tz).apply {
            clear()
            set(y, mo - 1, d, h, mi)
        }.timeInMillis

    @Test
    fun shortAgoTexts() {
        val now = at(2026, 11, 18, 21, 30)
        assertEquals("", TimeText.ago(0L, now, tz))
        assertEquals("刚刚", TimeText.ago(now - 20_000, now, tz))
        assertEquals("刚刚", TimeText.ago(now + 90_000, now, tz)) // 电脑时钟快了一点
        assertEquals("5 分钟前", TimeText.ago(at(2026, 11, 18, 21, 25), now, tz))
        assertEquals("3 小时前", TimeText.ago(at(2026, 11, 18, 18, 10), now, tz))
        assertEquals("昨天", TimeText.ago(at(2026, 11, 17, 23, 50), now, tz))
        assertEquals("11月12日", TimeText.ago(at(2026, 11, 12, 9, 0), now, tz))
        assertEquals("2025年3月4日", TimeText.ago(at(2025, 3, 4, 9, 0), now, tz))
    }

    @Test
    fun justAfterMidnightYesterdayIsYesterday() {
        val now = at(2026, 1, 1, 0, 30)
        assertEquals("昨天", TimeText.ago(at(2025, 12, 31, 22, 0), now, tz))
    }
}
