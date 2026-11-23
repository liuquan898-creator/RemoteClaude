package com.remoteclaude.android

import com.remoteclaude.android.approvals.ApprovalNotifier
import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.remoteclaude.android.net.NetworkWatcher

class RemoteClaudeApp : Application() {
    lateinit var controller: RemoteController
        private set

    override fun onCreate() {
        super.onCreate()
        ApprovalNotifier.ensureChannels(this)
        controller = RemoteController(this)

        // 整个应用进入前台或后台（而不是单个界面），据此连接或断开
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = controller.onForeground()
            override fun onStop(owner: LifecycleOwner) = controller.onBackground()
        })

        NetworkWatcher(this) { controller.onNetworkChanged() }.start()
    }
}
