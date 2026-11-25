package com.remoteclaude.android.approvals

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 审批通知推迟 60 秒（docs/09 第 6 节）：按手机收到的时刻算，满了还在列表里才发 */
class ApprovalAlertDelayTest {
    private val none = emptySet<String>()

    @Test
    fun newApprovalWaitsSixtySecondsThenPosts() {
        val d = ApprovalAlertDelay()
        assertEquals(ApprovalAlertDelay.Decision(emptyList(), 60_000L), d.decide(listOf("a"), none, none, now = 1_000L))
        // 列表又推了一次（别的审批变了），还是从第一次收到算
        assertEquals(ApprovalAlertDelay.Decision(emptyList(), 30_000L), d.decide(listOf("a"), none, none, now = 31_000L))
        assertEquals(ApprovalAlertDelay.Decision(emptyList(), 1L), d.decide(listOf("a"), none, none, now = 60_999L))
        // 正好满 60 秒就发
        assertEquals(ApprovalAlertDelay.Decision(listOf("a"), null), d.decide(listOf("a"), none, none, now = 61_000L))
    }

    @Test
    fun recheckWhenTheNextOneIsDue() {
        val d = ApprovalAlertDelay()
        d.decide(listOf("a"), none, none, now = 0L)
        val r = d.decide(listOf("a", "b"), none, none, now = 20_000L)
        assertEquals(emptyList<String>(), r.post)
        assertEquals(40_000L, r.recheckInMs)
        // a 到点了，b 还要等 20 秒
        assertEquals(ApprovalAlertDelay.Decision(listOf("a"), 20_000L), d.decide(listOf("a", "b"), none, none, now = 60_000L))
        // a 发过了（调用方放进 skip），b 也到点
        assertEquals(ApprovalAlertDelay.Decision(listOf("b"), null), d.decide(listOf("a", "b"), setOf("a"), none, now = 80_000L))
    }

    @Test
    fun skippedOnesAreNotPostedAndDoNotScheduleARecheck() {
        val d = ApprovalAlertDelay()
        // 在界面上看过的、已经发了通知的不用再发，也不用为它们等
        assertEquals(ApprovalAlertDelay.Decision(emptyList(), null), d.decide(listOf("a"), setOf("a"), none, now = 0L))
        assertEquals(ApprovalAlertDelay.Decision(emptyList(), null), d.decide(listOf("a"), setOf("a"), none, now = 90_000L))
    }

    @Test
    fun alreadyAlertedOnesComeBackWithoutWaiting() {
        val d = ApprovalAlertDelay()
        // 断线重连、电脑重新上线后又推来的、以前发过通知的：马上重发（调用方让它不响）
        assertEquals(ApprovalAlertDelay.Decision(listOf("a"), 60_000L), d.decide(listOf("a", "b"), none, setOf("a"), now = 5_000L))
    }

    @Test
    fun approvalsThatLeaveTheListAreForgotten() {
        val d = ApprovalAlertDelay()
        d.decide(listOf("a"), none, none, now = 0L)
        // 在电脑上处理掉了：不在列表里，不发
        assertEquals(ApprovalAlertDelay.Decision(emptyList(), null), d.decide(emptyList(), none, none, now = 30_000L))
        // 同一个 id 又出现（比如电脑重新推），重新计时
        assertEquals(ApprovalAlertDelay.Decision(emptyList(), 60_000L), d.decide(listOf("a"), none, none, now = 70_000L))
    }

    @Test
    fun trackOnlyRecordsTheTime() {
        val d = ApprovalAlertDelay()
        // 在前台时只记时刻（界面上看得到，不发）；之后切到后台，从收到的那一刻算
        d.track(listOf("a"), now = 0L)
        assertEquals(ApprovalAlertDelay.Decision(listOf("a"), null), d.decide(listOf("a"), none, none, now = 60_000L))
        d.track(emptyList(), now = 61_000L)
        assertNull(d.decide(emptyList(), none, none, now = 62_000L).recheckInMs)
    }

    @Test
    fun customDelayAndOrderFollowTheList() {
        val d = ApprovalAlertDelay(delayMs = 10L)
        d.decide(listOf("b", "a"), none, none, now = 0L)
        assertEquals(listOf("b", "a"), d.decide(listOf("b", "a"), none, none, now = 10L).post)
        assertEquals(60_000L, ApprovalAlertDelay.DELAY_MS)
    }
}
