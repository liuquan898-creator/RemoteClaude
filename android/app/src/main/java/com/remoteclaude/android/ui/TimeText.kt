package com.remoteclaude.android.ui

import java.util.Calendar
import java.util.TimeZone

/** 会话最后活动时间的简短说法。不依赖 Android，可以做 JVM 单元测试 */
object TimeText {
    /** 刚刚、5 分钟前、3 小时前、昨天、11月12日、2025年3月4日；[at] 为 0 时返回空串 */
    fun ago(at: Long, now: Long, tz: TimeZone = TimeZone.getDefault()): String {
        if (at <= 0L) return ""
        val diff = now - at
        if (diff < MINUTE) return "刚刚" // 电脑和手机的时钟差一点时 diff 可能是负的
        if (diff < HOUR) return "${diff / MINUTE} 分钟前"
        val then = Calendar.getInstance(tz).apply { timeInMillis = at }
        val today = Calendar.getInstance(tz).apply { timeInMillis = now }
        if (sameDay(then, today)) return "${diff / HOUR} 小时前"
        val yesterday = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -1) }
        if (sameDay(then, yesterday)) return "昨天"
        val md = "${then.get(Calendar.MONTH) + 1}月${then.get(Calendar.DAY_OF_MONTH)}日"
        return if (then.get(Calendar.YEAR) == today.get(Calendar.YEAR)) md else "${then.get(Calendar.YEAR)}年$md"
    }

    private fun sameDay(a: Calendar, b: Calendar) =
        a.get(Calendar.YEAR) == b.get(Calendar.YEAR) && a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)

    private const val MINUTE = 60_000L
    private const val HOUR = 3_600_000L
}
