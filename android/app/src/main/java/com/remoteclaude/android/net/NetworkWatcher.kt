package com.remoteclaude.android.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper

/**
 * 监听默认网络的切换（Wi-Fi 与移动网络之间）。切换后旧连接通常已经不通，
 * 但要等心跳超时才会发现，所以一切换就通知调用方立即重连。
 *
 * 注册时系统会先回调一次当前网络，这一次不算切换。
 */
class NetworkWatcher(context: Context, private val onChanged: () -> Unit) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var current: Network? = null
    private var seenFirst = false

    fun start() {
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                main.post {
                    val changed = seenFirst && network != current
                    current = network
                    seenFirst = true
                    if (changed) onChanged()
                }
            }

            override fun onLost(network: Network) {
                main.post { if (network == current) current = null }
            }
        })
    }
}
