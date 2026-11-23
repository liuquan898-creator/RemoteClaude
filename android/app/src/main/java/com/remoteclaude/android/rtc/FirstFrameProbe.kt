package com.remoteclaude.android.rtc

import android.os.Handler
import android.os.Looper
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 挂在视频轨道上，收到第一帧时在主线程回调一次，之后的帧直接忽略。
 *
 * 用它而不是渲染控件的"分辨率变化"来判断画面是否已经出来：
 * 断线重连后新画面的分辨率常常和之前一样，渲染控件不会再报变化。
 */
class FirstFrameProbe(private val onFirstFrame: () -> Unit) : VideoSink {
    private val fired = AtomicBoolean(false)
    private val main = Handler(Looper.getMainLooper())

    override fun onFrame(frame: VideoFrame) {
        if (fired.compareAndSet(false, true)) main.post(onFirstFrame)
    }
}
