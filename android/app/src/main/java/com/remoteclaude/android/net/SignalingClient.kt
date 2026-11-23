package com.remoteclaude.android.net

import android.os.Handler
import android.os.Looper
import com.remoteclaude.android.protocol.Incoming
import com.remoteclaude.android.protocol.Protocol
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * 信令 WebSocket 连接。只负责连接、收发和解析，重连策略由调用方决定。
 * 所有回调都在主线程上执行；主动 close() 之后不会再收到这条连接的任何回调。
 */
class SignalingClient(private val listener: Listener) {
    interface Listener {
        /** 连接已建立，应立即发送 auth */
        fun onOpen()
        fun onMessage(msg: Incoming)
        /** 连接断开或连接失败（主动 close() 的不算） */
        fun onClosed()
    }

    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        // 服务器 30 秒 ping 一次，这里再主动 ping：断网后 20 多秒内就能发现连接已死
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var socket: WebSocket? = null
    /** 每次连接或关闭都加一，用来丢弃旧连接的迟到回调 */
    private var generation = 0

    val isActive: Boolean get() = socket != null

    fun connect(url: String) {
        close()
        val gen = generation
        val request = Request.Builder().url(url).build() // OkHttp 会把 ws:// wss:// 换成 http:// https://
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                post(gen) { listener.onOpen() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                // 解析放在网络线程，窗口列表带缩略图，有几十 KB
                val msg = Protocol.parse(text) ?: return
                post(gen) { listener.onMessage(msg) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                post(gen) { ended() }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                post(gen) { ended() }
            }
        })
    }

    fun send(text: String): Boolean = socket?.send(text) ?: false

    fun close() {
        generation++
        socket?.close(1000, null)
        socket = null
    }

    private fun ended() {
        socket = null
        generation++
        listener.onClosed()
    }

    private fun post(gen: Int, block: () -> Unit) {
        main.post { if (gen == generation) block() }
    }
}
