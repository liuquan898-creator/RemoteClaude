package com.remoteclaude.android.video

import android.content.Context
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.view.TextureView
import org.webrtc.EglBase
import org.webrtc.EglRenderer
import org.webrtc.GlRectDrawer
import org.webrtc.VideoFrame
import org.webrtc.VideoSink
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 显示远程画面的 TextureView，同时是 WebRTC 的视频接收端。
 *
 * 为了放大后仍然清晰，这里让渲染缓冲区等于视频的原始分辨率，逐像素画进去，
 * 再用 TextureView 的变换矩阵完成缩放和平移；而不是先按控件大小画、再放大位图。
 *
 * 注意 TextureView 在控件尺寸变化时会把缓冲区重设成控件大小，所以每次尺寸变化后要改回来。
 */
class VideoTextureView(context: Context) : TextureView(context), TextureView.SurfaceTextureListener, VideoSink {
    private val renderer = EglRenderer("RemoteVideo")
    private val main = Handler(Looper.getMainLooper())
    private var initialized = false
    private var surface: SurfaceTexture? = null
    private var viewport: Viewport? = null

    // 解码线程写、主线程读
    @Volatile private var frameW = 0
    @Volatile private var frameH = 0

    /** 视频分辨率变化（包括第一帧），在主线程回调 */
    var onVideoSize: ((Int, Int) -> Unit)? = null

    init {
        surfaceTextureListener = this
        isOpaque = false
        addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> applyTransform() }
    }

    /** 必须在加入界面之前调用一次 */
    fun init(eglContext: EglBase.Context) {
        if (initialized) return
        renderer.init(eglContext, EglBase.CONFIG_PLAIN, GlRectDrawer())
        initialized = true
    }

    /** 释放渲染线程。调用前先把自己从视频轨道上摘下来 */
    fun release() {
        if (!initialized) return
        initialized = false
        renderer.release()
    }

    fun applyViewport(vp: Viewport) {
        viewport = vp
        applyTransform()
    }

    override fun onFrame(frame: VideoFrame) {
        val w = frame.rotatedWidth
        val h = frame.rotatedHeight
        if (w != frameW || h != frameH) {
            frameW = w
            frameH = h
            main.post { onFrameSizeChanged(w, h) }
        }
        renderer.onFrame(frame)
    }

    private fun onFrameSizeChanged(w: Int, h: Int) {
        resizeBuffer()
        onVideoSize?.invoke(w, h)
        applyTransform()
    }

    /** 把渲染缓冲区设成视频分辨率，并重建 EGL 表面让新尺寸立即生效 */
    private fun resizeBuffer() {
        val st = surface ?: return
        val w = frameW
        val h = frameH
        if (!initialized || w <= 0 || h <= 0) return
        renderer.releaseEglSurface {} // 排在渲染线程队首执行
        st.setDefaultBufferSize(w, h)
        renderer.createEglSurface(st) // 排在队尾，所以一定在上面的释放之后
    }

    /**
     * TextureView 默认把缓冲区拉伸铺满控件；这里在此基础上换算成"画面按 scale 缩放、平移到 (panX, panY)"。
     */
    private fun applyTransform() {
        val vp = viewport ?: return
        if (!vp.hasContent || width == 0 || height == 0) return
        val m = Matrix()
        m.setScale(vp.scale * vp.videoW / width, vp.scale * vp.videoH / height)
        m.postTranslate(vp.panX, vp.panY)
        setTransform(m)
    }

    override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
        surface = st
        if (!initialized) return
        if (frameW > 0 && frameH > 0) {
            st.setDefaultBufferSize(frameW, frameH)
        }
        renderer.createEglSurface(st)
        applyTransform()
    }

    override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) {
        // TextureView 刚把缓冲区改成了控件大小，改回视频分辨率
        resizeBuffer()
        applyTransform()
    }

    override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
        surface = null
        val latch = CountDownLatch(1)
        renderer.releaseEglSurface { latch.countDown() }
        latch.await(2, TimeUnit.SECONDS)
        return true
    }

    override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
}
