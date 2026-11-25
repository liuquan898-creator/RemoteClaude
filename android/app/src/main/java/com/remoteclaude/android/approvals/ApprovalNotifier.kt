package com.remoteclaude.android.approvals

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.remoteclaude.android.MainActivity
import com.remoteclaude.android.R
import com.remoteclaude.android.protocol.Approval

/** 一条等待作答的审批，带上来自哪台电脑 */
data class PendingApproval(val hostId: String, val hostName: String, val item: Approval)

/**
 * 审批的系统通知（docs/09 第 6 节）。App 在前台时不发（界面上能看到），切到后台后只给没在界面上看过的新审批发，
 * 而且等手机收到它满 60 秒、电脑上还没处理才发（列表里马上就有）；审批在别处答了或结束了，通知自动撤掉。审批类的通知上有"允许""拒绝"，按了要先解锁手机；提问类的点开 App 作答。
 * 提示音是渠道的铃声，默认布谷鸟叫，用户在系统的通知设置里换或关；连着来几条只响第一条，断线重连后重发的不再响。
 * 审批通知归在同一组里，带一条不响的汇总。
 */
object ApprovalNotifier {
    /**
     * 0.9.3 起渠道的默认铃声是布谷鸟叫，换铃声、关声音交给系统设置。渠道的声音建好后 App 改不了，
     * 所以每次换做法都换个编号，旧渠道删掉：0.8.x 的 approvals（系统默认铃声）、0.9.0～0.9.2 的 approvals_quiet（无声，App 自己放）
     */
    const val CHANNEL_APPROVALS = "approvals_ring"
    private val OLD_CHANNELS = listOf("approvals", "approvals_quiet")
    const val CHANNEL_KEEPALIVE = "keepalive"
    const val KEEPALIVE_ID = 1
    const val EXTRA_OPEN_APPROVALS = "open_approvals"
    private const val TAG = "approval"
    private const val NOTE_ID = 2
    private const val SUMMARY_ID = 3
    /**
     * 审批通知自己分一组、带一条汇总：不分组的话，Android 16 在已有一条通知时会把新来的和它自动归成一组，
     * 新来的那条不响不震（模拟器实测，docs/05 的 2.21）。组里由单条通知负责响，汇总本身不响
     */
    private const val GROUP = "approvals"

    /** 已经发了通知的审批 */
    private val shown = HashSet<String>()
    /** 在 App 界面上出现过的审批，切到后台后不再为它们发通知 */
    private val seen = HashSet<String>()
    /** 响过、震过的审批：断线重连后同一个审批重新发通知时不再响 */
    private val alerted = LinkedHashSet<String>()
    /** 新审批的通知推迟发（docs/09 第 6 节） */
    private val alertDelay = ApprovalAlertDelay()
    /** 汇总通知上写的条数，0 表示没发 */
    private var summaryCount = 0

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        OLD_CHANNELS.forEach(nm::deleteNotificationChannel)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_APPROVALS, "审批和提问", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "电脑上的 Claude 要你审批或回答问题。默认铃声是布谷鸟叫"
                setSound(
                    // 按名字找资源：资源编号每次编译可能变，渠道里存的地址却改不了
                    Uri.parse("android.resource://${ctx.packageName}/raw/cuckoo"),
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                enableVibration(true)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_KEEPALIVE, "后台连接", NotificationManager.IMPORTANCE_MIN).apply {
                description = "后台接收审批时系统要求常驻的一条通知，可以在这里把它折叠起来"
                setShowBadge(false)
            },
        )
    }

    fun notificationId(approvalId: String): Int = approvalId.hashCode()

    /** 系统里"审批和提问"这类通知的设置页（换铃声、关声音）；个别手机打不开就退到 App 的通知设置 */
    fun openChannelSettings(ctx: Context) {
        val channel = Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
            .putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL_APPROVALS)
        val app = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
        for (intent in listOf(channel, app)) {
            if (runCatching { ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess) return
        }
    }

    fun openAppIntent(ctx: Context, openApprovals: Boolean): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_OPEN_APPROVALS, openApprovals)
        return PendingIntent.getActivity(ctx, if (openApprovals) 1 else 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /**
     * 按当前的审批列表增删通知；[foreground] 为真时撤掉全部（界面上能看到）。
     * 新审批推迟发（[ApprovalAlertDelay]）：手机收到满 60 秒、还没处理才发；[now] 是 SystemClock.elapsedRealtime。
     * 一次发出几条新通知时只有第一条响铃、震动，其余静默；响过的审批重发通知也静默，也不再等。
     * 返回还有推迟着的、多久以后要再调一次，没有为 null。
     */
    @SuppressLint("MissingPermission") // areNotificationsEnabled 已经检查过
    fun sync(ctx: Context, list: List<PendingApproval>, foreground: Boolean, now: Long): Long? {
        val nm = NotificationManagerCompat.from(ctx)
        val order = list.map { it.item.id }
        val ids = order.toSet()
        for (id in shown.toList()) {
            if (foreground || id !in ids) {
                nm.cancel(TAG, notificationId(id))
                shown.remove(id)
            }
        }
        seen.retainAll(ids)
        if (foreground) {
            seen.addAll(ids)
            alertDelay.track(order, now)
            syncSummary(ctx, nm)
            return null
        }
        if (!nm.areNotificationsEnabled()) {
            alertDelay.track(order, now)
            syncSummary(ctx, nm)
            return null
        }
        val decision = alertDelay.decide(order, skip = shown + seen, alerted = alerted, now = now)
        val due = decision.post.toSet()
        val manyHosts = list.map { it.hostId }.distinct().size > 1
        var rang = false
        for (a in list) {
            val id = a.item.id
            if (id !in due || id in shown) continue
            val ring = alerted.add(id) && !rang
            if (ring) rang = true
            nm.notify(TAG, notificationId(id), build(ctx, a, manyHosts, silent = !ring))
            shown.add(id)
        }
        while (alerted.size > 200) alerted.remove(alerted.first())
        syncSummary(ctx, nm)
        return decision.recheckInMs
    }

    fun cancel(ctx: Context, approvalId: String) {
        val nm = NotificationManagerCompat.from(ctx)
        nm.cancel(TAG, notificationId(approvalId))
        shown.remove(approvalId)
        syncSummary(ctx, nm)
    }

    /** 组里还有通知就发（或更新）汇总，没了就撤；汇总不响 */
    @SuppressLint("MissingPermission")
    private fun syncSummary(ctx: Context, nm: NotificationManagerCompat) {
        val count = if (nm.areNotificationsEnabled()) shown.size else 0
        if (count == summaryCount) return
        summaryCount = count
        if (count == 0) {
            nm.cancel(TAG, SUMMARY_ID)
            return
        }
        nm.notify(
            TAG,
            SUMMARY_ID,
            NotificationCompat.Builder(ctx, CHANNEL_APPROVALS)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("Claude 在等你")
                .setContentText("$count 个审批或提问")
                .setGroup(GROUP)
                .setGroupSummary(true)
                .setSilent(true)
                .setContentIntent(openAppIntent(ctx, true))
                .setAutoCancel(true)
                .build(),
        )
    }

    /** 通知上的按钮没发出去时，提示打开 App */
    @SuppressLint("MissingPermission")
    fun notifyFailed(ctx: Context, text: String) {
        val nm = NotificationManagerCompat.from(ctx)
        if (!nm.areNotificationsEnabled()) return
        nm.notify(
            TAG,
            NOTE_ID,
            NotificationCompat.Builder(ctx, CHANNEL_APPROVALS)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("审批没有发出去")
                .setContentText(text)
                .setContentIntent(openAppIntent(ctx, true))
                .setAutoCancel(true)
                .build(),
        )
    }

    private fun build(ctx: Context, a: PendingApproval, manyHosts: Boolean, silent: Boolean): android.app.Notification {
        val item = a.item
        val where = (if (manyHosts) "${a.hostName} · " else "") + item.title + if (item.agent.isNotEmpty()) "（子代理）" else ""
        val title = if (item.isAsk) "Claude 在问你：$where" else "Claude 要审批 ${item.tool}：$where"
        val body = if (item.isAsk) {
            item.questions.joinToString("\n") { it.question }
        } else {
            listOfNotNull(
                item.description.takeIf { it.isNotEmpty() },
                item.params.firstOrNull()?.let { "${it.key}：${it.value.take(300)}" },
            ).joinToString("\n")
        }
        val b = NotificationCompat.Builder(ctx, CHANNEL_APPROVALS)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(body.lineSequence().firstOrNull().orEmpty())
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setWhen(item.createdAt.takeIf { it > 0 } ?: System.currentTimeMillis())
            .setShowWhen(true)
            .setContentIntent(openAppIntent(ctx, true))
            .setAutoCancel(true)
            .setGroup(GROUP)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            // 静默的不响铃、不震动，也不弹横幅，只进通知栏
            .setSilent(silent)
            // 锁屏上只显示"有新的审批"，内容要解锁后看
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(ctx, CHANNEL_APPROVALS)
                    .setSmallIcon(R.drawable.ic_notify)
                    .setContentTitle(if (item.isAsk) "Claude 在问你" else "Claude 要审批")
                    .setContentText("解锁后查看")
                    .build(),
            )
        if (!item.isAsk) {
            b.addAction(action(ctx, a, "allow", "允许"))
            b.addAction(action(ctx, a, "deny", "拒绝"))
        }
        return b.build()
    }

    private fun action(ctx: Context, a: PendingApproval, choice: String, label: String): NotificationCompat.Action {
        val intent = Intent(ctx, ApprovalActionReceiver::class.java)
            .setAction(ApprovalActionReceiver.ACTION_ANSWER)
            .putExtra(ApprovalActionReceiver.EXTRA_HOST, a.hostId)
            .putExtra(ApprovalActionReceiver.EXTRA_ID, a.item.id)
            .putExtra(ApprovalActionReceiver.EXTRA_CHOICE, choice)
        val pi = PendingIntent.getBroadcast(
            ctx,
            (a.item.id + choice).hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        // 按了要先解锁手机：拿到手机的人不能在锁屏上直接替你批准
        return NotificationCompat.Action.Builder(0, label, pi).setAuthenticationRequired(true).build()
    }
}
