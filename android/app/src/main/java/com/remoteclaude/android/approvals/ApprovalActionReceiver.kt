package com.remoteclaude.android.approvals

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.remoteclaude.android.RemoteClaudeApp

/** 审批通知上的"允许""拒绝"按钮（系统已经要求用户先解锁手机） */
class ApprovalActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_ANSWER) return
        val host = intent.getStringExtra(EXTRA_HOST) ?: return
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val choice = intent.getStringExtra(EXTRA_CHOICE)?.takeIf { it == "allow" || it == "deny" } ?: return
        val controller = (context.applicationContext as RemoteClaudeApp).controller
        ApprovalNotifier.cancel(context, id)
        if (!controller.answerApproval(host, id, choice, "", null)) {
            ApprovalNotifier.notifyFailed(context, "和服务器的连接断了，请打开 App 再处理这个审批")
        }
    }

    companion object {
        const val ACTION_ANSWER = "com.remoteclaude.android.APPROVAL_ANSWER"
        const val EXTRA_HOST = "host"
        const val EXTRA_ID = "id"
        const val EXTRA_CHOICE = "choice"
    }
}
