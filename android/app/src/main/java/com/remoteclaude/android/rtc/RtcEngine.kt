package com.remoteclaude.android.rtc

import android.content.Context
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory

/**
 * WebRTC 的全局对象：原生库初始化、OpenGL 上下文、连接工厂。整个进程只建一份。
 *
 * App 只接收画面，不发送；但工厂仍需要一个编码器工厂参数，给默认的即可。
 * 解码器优先用手机的硬件解码，不支持的编码格式自动退回软件解码。
 */
class RtcEngine(context: Context) {
    val eglBase: EglBase = EglBase.create()
    val factory: PeerConnectionFactory

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                .createInitializationOptions()
        )
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .createPeerConnectionFactory()
    }
}
