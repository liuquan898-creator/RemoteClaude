package com.remoteclaude.android.video

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ViewportTest {
    private val eps = 1e-4

    private fun <T> nn(value: T?): T {
        assertNotNull(value)
        return value!!
    }

    /** 854×1380 的竖长窗口，显示在 1080×1600 的手机画面区里 */
    private fun phone() = Viewport().apply {
        setStageSize(1080f, 1600f)
        setVideoSize(854, 1380)
    }

    @Test
    fun fitsAndCentersHorizontally() {
        val vp = phone()
        // 高度受限：1600 / 1380
        assertEquals(1600f / 1380f, vp.fit, 1e-5f)
        assertEquals(1600f, vp.displayH, 0.01f)
        assertEquals((1080f - vp.displayW) / 2f, vp.panX, 0.01f)
        assertEquals(0f, vp.panY, 0.01f)
    }

    @Test
    fun centerMapsToMiddle() {
        val vp = phone()
        val p = nn(vp.toRemote(540f, 800f))
        assertEquals(0.5, p.x, eps)
        assertEquals(0.5, p.y, eps)
    }

    @Test
    fun blackBarsReturnNullUnlessClamped() {
        val vp = phone()
        assertNull(vp.toRemote(5f, 800f))
        val clamped = nn(vp.toRemote(5f, 800f, clampEdge = true))
        assertEquals(0.0, clamped.x, eps)
    }

    @Test
    fun zoomKeepsPointUnderFinger() {
        val vp = phone()
        val before = nn(vp.toRemote(600f, 900f))
        vp.zoomAt(600f, 900f, 3f)
        val after = nn(vp.toRemote(600f, 900f))
        assertEquals(before.x, after.x, eps)
        assertEquals(before.y, after.y, eps)
        assertTrue(vp.isZoomed)
    }

    @Test
    fun zoomIsClampedToRange() {
        val vp = phone()
        vp.zoomAt(500f, 500f, 100f)
        assertEquals(Viewport.MAX_ZOOM, vp.zoom, 1e-5f)
        vp.zoomAt(500f, 500f, 0.1f)
        assertEquals(1f, vp.zoom, 1e-5f)
    }

    @Test
    fun panNeverShowsBlackBarsWhenZoomed() {
        val vp = phone()
        vp.zoomAt(540f, 800f, 4f)
        vp.panBy(100000f, 100000f)
        assertEquals(0f, vp.panX, 0.01f)
        assertEquals(0f, vp.panY, 0.01f)
        vp.panBy(-1e7f, -1e7f)
        assertEquals(1080f - vp.displayW, vp.panX, 0.01f)
        assertEquals(1600f - vp.displayH, vp.panY, 0.01f)
    }

    @Test
    fun videoSizeChangeResetsZoom() {
        val vp = phone()
        vp.zoomAt(540f, 800f, 2f)
        assertTrue(vp.setVideoSize(1280, 2088))
        assertFalse(vp.isZoomed)
        assertFalse(vp.setVideoSize(1280, 2088))
    }

    @Test
    fun remotePerScreenPxIsInverseOfScale() {
        val vp = phone()
        assertEquals(1f / vp.scale, vp.remotePerScreenPx, 1e-6f)
        vp.zoomAt(540f, 800f, 2f)
        assertEquals(1f / vp.scale, vp.remotePerScreenPx, 1e-6f)
    }

    @Test
    fun emptyViewportMapsNothing() {
        assertNull(Viewport().toRemote(10f, 10f))
    }
}
