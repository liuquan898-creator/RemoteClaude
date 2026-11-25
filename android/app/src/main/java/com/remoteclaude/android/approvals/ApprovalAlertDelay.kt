package com.remoteclaude.android.approvals

/**
 * 审批的系统通知推迟发（docs/09 第 6 节"通知推迟 60 秒"）：手机第一次收到一条审批满 [delayMs]、它还在列表里才发。
 * 电脑前的人多半马上就在电脑上点了，不用再响手机。按手机自己的时钟算（调用方传 SystemClock.elapsedRealtime），
 * 电脑和手机的时钟可能对不上。不依赖 Android，方便测试。
 */
class ApprovalAlertDelay(private val delayMs: Long = DELAY_MS) {
    /** 审批 id -> 手机第一次收到它的时刻 */
    private val firstSeen = HashMap<String, Long>()

    /** [post] 是这次该发通知的（按列表顺序），[recheckInMs] 是还有没到点的、多久以后再看一次，没有为 null */
    data class Decision(val post: List<String>, val recheckInMs: Long?)

    /** 记下新出现的审批是什么时候收到的，忘掉不在列表里的 */
    fun track(ids: Collection<String>, now: Long) {
        val current = ids.toSet()
        firstSeen.keys.retainAll(current)
        for (id in current) firstSeen.getOrPut(id) { now }
    }

    /**
     * [ids] 是现在的审批列表；[skip] 里的不用发（已经发了、在界面上看过）；[alerted] 里的以前发过通知，
     * 断线重连、电脑重新上线后又出现了，不用再等。
     */
    fun decide(ids: List<String>, skip: Set<String>, alerted: Set<String>, now: Long): Decision {
        track(ids, now)
        val post = ArrayList<String>()
        var recheck: Long? = null
        for (id in ids.distinct()) {
            if (id in skip) continue
            val left = (firstSeen[id] ?: now) + delayMs - now
            if (left <= 0 || id in alerted) {
                post += id
            } else {
                recheck = minOf(recheck ?: left, left)
            }
        }
        return Decision(post, recheck)
    }

    companion object {
        const val DELAY_MS = 60_000L
    }
}
