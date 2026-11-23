package com.remoteclaude.android.image

import org.junit.Assert.assertEquals
import org.junit.Test

class ImageSizingTest {
    @Test
    fun smallImagesAreNotSampledOrScaled() {
        assertEquals(1, ImageSizing.sampleSize(1080, 2424))
        assertEquals(1080 to 1920, ImageSizing.fit(1080, 1920))
        assertEquals(2048 to 1000, ImageSizing.fit(2048, 1000))
    }

    @Test
    fun sampleSizeKeepsLongEdgeAtLeastMax() {
        // 4000 / 2 = 2000 < 2048，不能再减半
        assertEquals(1, ImageSizing.sampleSize(4000, 3000))
        // 12 MP 照片 4096x3072：减半正好 2048
        assertEquals(2, ImageSizing.sampleSize(4096, 3072))
        // 50 MP 8160x6144：除以 2 是 4080，除以 4 是 2040 < 2048，所以是 2
        assertEquals(2, ImageSizing.sampleSize(6144, 8160))
        assertEquals(4, ImageSizing.sampleSize(8192, 6000))
    }

    @Test
    fun fitScalesLongEdgeToMaxKeepingAspect() {
        assertEquals(2048 to 1536, ImageSizing.fit(4000, 3000))
        assertEquals(1536 to 2048, ImageSizing.fit(3000, 4000))
        // 超长截图：宽度按比例缩小，至少 1 像素
        assertEquals(1 to 2048, ImageSizing.fit(10, 30000))
    }

    @Test
    fun degenerateSizesAreLeftAlone() {
        assertEquals(0 to 0, ImageSizing.fit(0, 0))
        assertEquals(1, ImageSizing.sampleSize(0, 0))
    }
}
