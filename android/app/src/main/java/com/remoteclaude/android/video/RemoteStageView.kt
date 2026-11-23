package com.remoteclaude.android.video

import android.annotation.SuppressLint
import android.content.Context
import android.os.SystemClock
import android.view.Choreographer
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.widget.FrameLayout
import com.remoteclaude.android.input.RemotePoint
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.hypot

/**
 * 远程画面区：显示画面，并把触摸手势翻译成远程操作（安卓设计文档"手势映射"一节）。
 *
 *   单指轻点      -> 左键单击
 *   单指长按      -> 右键单击，带震动
 *   单指拖动      -> 滚动远程内容，松手后有惯性
 *   双指捏合/拖动 -> 只缩放、平移本地画面，不发事件
 */
@SuppressLint("ViewConstructor")
class RemoteStageView(context: Context) : FrameLayout(context) {
    interface Listener {
        fun onTap(point: RemotePoint)
        fun onLongPress(point: RemotePoint)
        /** dx、dy 是远程像素数，dy 为正表示向上滚（内容向下移动） */
        fun onScroll(point: RemotePoint, dx: Double, dy: Double)
        fun onVideoSize(width: Int, height: Int)
    }

    val video = VideoTextureView(context)
    val viewport = Viewport()
    var listener: Listener? = null
    var hapticsEnabled = true

    private val config = ViewConfiguration.get(context)
    private val touchSlop = config.scaledTouchSlop
    private val doubleTapSlop = config.scaledDoubleTapSlop
    private val minFlingVelocity = config.scaledMinimumFlingVelocity.toFloat()

    private enum class Mode { Idle, Tap, Scroll, Pinch, Done }

    private var mode = Mode.Idle
    private var downX = 0f
    private var downY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var downPoint: RemotePoint? = null
    private var verticalAxis = true
    private var velocity: VelocityTracker? = null

    private var pinchStartDistance = 1f
    private var pinchStartZoom = 1f
    private var pinchMidX = 0f
    private var pinchMidY = 0f

    private var lastTapAt = 0L
    private var lastTapX = 0f
    private var lastTapY = 0f
    private var lastTapPoint: RemotePoint? = null

    private val longPress = Runnable {
        if (mode != Mode.Tap) return@Runnable
        mode = Mode.Done
        val p = downPoint ?: return@Runnable
        if (hapticsEnabled) performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        listener?.onLongPress(p)
    }

    init {
        setBackgroundColor(STAGE_COLOR)
        addView(video, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        video.onVideoSize = { w, h ->
            if (viewport.setVideoSize(w, h)) applyViewport()
            listener?.onVideoSize(w, h)
        }
    }

    fun resetZoom() {
        viewport.reset()
        applyViewport()
    }

    private fun applyViewport() = video.applyViewport(viewport)

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        viewport.setStageSize(w.toFloat(), h.toFloat())
        applyViewport()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        removeCallbacks(longPress)
        stopFling()
    }

    // 所有触摸都由这里处理，不交给子控件
    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean = true

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                stopFling()
                parent?.requestDisallowInterceptTouchEvent(true)
                mode = Mode.Tap
                downX = e.x
                downY = e.y
                lastX = e.x
                lastY = e.y
                downPoint = viewport.toRemote(e.x, e.y)
                velocity?.recycle()
                velocity = VelocityTracker.obtain().also { it.addMovement(e) }
                postDelayed(longPress, LONG_PRESS_MS)
            }

            MotionEvent.ACTION_POINTER_DOWN -> {
                removeCallbacks(longPress)
                if (e.pointerCount == 2) {
                    mode = Mode.Pinch
                    pinchStartDistance = distance(e)
                    pinchStartZoom = viewport.zoom
                    pinchMidX = midX(e)
                    pinchMidY = midY(e)
                }
            }

            MotionEvent.ACTION_MOVE -> {
                velocity?.addMovement(e)
                if (mode == Mode.Pinch && e.pointerCount >= 2) {
                    val mx = midX(e)
                    val my = midY(e)
                    viewport.panBy(mx - pinchMidX, my - pinchMidY)
                    pinchMidX = mx
                    pinchMidY = my
                    viewport.zoomAt(mx, my, pinchStartZoom * distance(e) / pinchStartDistance)
                    applyViewport()
                } else {
                    if (mode == Mode.Tap && hypot(e.x - downX, e.y - downY) > touchSlop) {
                        removeCallbacks(longPress)
                        mode = Mode.Scroll
                        // 起手时锁定方向：横向位移超过纵向两倍才算横向滚动
                        verticalAxis = abs(e.x - downX) <= abs(e.y - downY) * 2
                    }
                    if (mode == Mode.Scroll) {
                        emitScroll(e.x - lastX, e.y - lastY)
                        lastX = e.x
                        lastY = e.y
                    }
                }
            }

            MotionEvent.ACTION_POINTER_UP -> {
                // 双指操作中抬起一指后，剩下那指不再触发任何操作，直到全部抬起
                if (mode == Mode.Pinch) mode = Mode.Done
            }

            MotionEvent.ACTION_UP -> {
                removeCallbacks(longPress)
                when (mode) {
                    Mode.Tap -> handleTap()
                    Mode.Scroll -> velocity?.let { vt ->
                        vt.computeCurrentVelocity(1000, MAX_FLING_VELOCITY)
                        val v = if (verticalAxis) vt.yVelocity else vt.xVelocity
                        if (abs(v) > minFlingVelocity) startFling(v)
                    }
                    else -> Unit
                }
                endGesture()
            }

            MotionEvent.ACTION_CANCEL -> {
                removeCallbacks(longPress)
                endGesture()
            }
        }
        return true
    }

    private fun endGesture() {
        mode = Mode.Idle
        velocity?.recycle()
        velocity = null
    }

    private fun handleTap() {
        performClick()
        var p = downPoint ?: return
        val now = SystemClock.uptimeMillis()
        // 连续两次轻点落在差不多的位置时，用同一个远程坐标，让电脑能认出双击
        val previous = lastTapPoint
        if (previous != null && now - lastTapAt < DOUBLE_TAP_MS && hypot(downX - lastTapX, downY - lastTapY) < doubleTapSlop) {
            p = previous
        }
        lastTapAt = now
        lastTapX = downX
        lastTapY = downY
        lastTapPoint = p
        listener?.onTap(p)
    }

    override fun performClick(): Boolean = super.performClick()

    /** 屏幕上的手指位移换算成远程滚动量；手指向下拖，内容跟着向下（向上滚） */
    private fun emitScroll(dxScreen: Float, dyScreen: Float) {
        val p = downPoint ?: return
        val k = viewport.remotePerScreenPx.toDouble()
        if (verticalAxis) {
            if (dyScreen != 0f) listener?.onScroll(p, 0.0, dyScreen * k)
        } else {
            if (dxScreen != 0f) listener?.onScroll(p, -dxScreen * k, 0.0)
        }
    }

    // ------------------------------------------------------------------ 惯性滚动

    private var flingVelocity = 0f
    private var flingLastNanos = 0L
    private val flingFrame = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            val dt = (frameTimeNanos - flingLastNanos) / 1e9f
            flingLastNanos = frameTimeNanos
            if (dt > 0f) {
                flingVelocity *= exp(-dt / FLING_TIME_CONSTANT_S)
                if (abs(flingVelocity) < FLING_STOP_VELOCITY) {
                    flingVelocity = 0f
                    return
                }
                val step = flingVelocity * dt
                if (verticalAxis) emitScroll(0f, step) else emitScroll(step, 0f)
            }
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    private fun startFling(v: Float) {
        flingVelocity = v
        flingLastNanos = System.nanoTime()
        Choreographer.getInstance().postFrameCallback(flingFrame)
    }

    private fun stopFling() {
        flingVelocity = 0f
        Choreographer.getInstance().removeFrameCallback(flingFrame)
    }

    // ------------------------------------------------------------------ 双指几何

    private fun distance(e: MotionEvent): Float =
        hypot(e.getX(0) - e.getX(1), e.getY(0) - e.getY(1)).coerceAtLeast(1f)

    private fun midX(e: MotionEvent): Float = (e.getX(0) + e.getX(1)) / 2f

    private fun midY(e: MotionEvent): Float = (e.getY(0) + e.getY(1)) / 2f

    private companion object {
        const val LONG_PRESS_MS = 550L
        const val DOUBLE_TAP_MS = 400L
        const val MAX_FLING_VELOCITY = 8000f
        const val FLING_TIME_CONSTANT_S = 0.3f
        /** 低于这个速度（屏幕像素/秒）就停下，免得松手后拖出一长串一两个单位的小滚动 */
        const val FLING_STOP_VELOCITY = 200f
        const val STAGE_COLOR = 0xFF0C0C0F.toInt()
    }
}
