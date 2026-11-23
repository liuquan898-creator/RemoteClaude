package com.remoteclaude.android.approvals

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.remoteclaude.android.R
import com.remoteclaude.android.RemoteClaudeApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * 后台接收审批时的前台服务（docs/09 第 6 节）。它自己什么都不做，只是让系统不杀 App 的进程，
 * 和服务器的连接由 RemoteController 维持。系统要求这时通知栏常驻一条通知。
 * 安卓 12 起不能从后台启动前台服务，所以在 App 打开时就启动，之后一直开着（开机、App 更新后由 [BootReceiver] 拉起）。
 */
class ApprovalService : Service() {
    override fun onCreate() {
        super.onCreate()
        ApprovalNotifier.ensureChannels(this)
        val note = NotificationCompat.Builder(this, ApprovalNotifier.CHANNEL_KEEPALIVE)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("RemoteClaude 正在后台接收审批")
            .setContentText("电脑上的 Claude 要审批或提问时会通知你")
            .setContentIntent(ApprovalNotifier.openAppIntent(this, false))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        ServiceCompat.startForeground(this, ApprovalNotifier.KEEPALIVE_ID, note, type)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val TAG = "ApprovalService"

        /** 启动；不允许从后台启动时（安卓 12 起的限制）返回 false */
        fun start(ctx: Context): Boolean = try {
            ContextCompat.startForegroundService(ctx, Intent(ctx, ApprovalService::class.java))
            true
        } catch (e: Exception) {
            Log.w(TAG, "启动后台接收审批的服务失败", e)
            false
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, ApprovalService::class.java))
        }
    }
}

/** 开机或 App 更新后，按设置把后台接收审批重新开起来 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val controller = (context.applicationContext as RemoteClaudeApp).controller
        val pending = goAsync()
        CoroutineScope(Dispatchers.Main).launch {
            try {
                controller.awaitLoaded()
                controller.syncBackgroundService()
            } finally {
                pending.finish()
            }
        }
    }
}
