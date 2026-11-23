package com.remoteclaude.android.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.MessageDigest

class FileUploadsTest {
    @Test
    fun deliveredNeverNegativeOrAboveHanded() {
        assertEquals(700L, FileUploads.delivered(1000, 300))
        assertEquals(0L, FileUploads.delivered(1000, 5000))
        assertEquals(1000L, FileUploads.delivered(1000, 0))
        assertEquals(0L, FileUploads.delivered(0, 0))
    }

    @Test
    fun percentHandlesEmptyAndBigFiles() {
        assertEquals(100, FileUploads.percent(0, 0))
        assertEquals(0, FileUploads.percent(0, 100))
        assertEquals(50, FileUploads.percent(50, 100))
        assertEquals(99, FileUploads.percent(104_857_599, 104_857_600))
        assertEquals(100, FileUploads.percent(200, 100))
        // 超过 2 GB 也不溢出
        assertEquals(50, FileUploads.percent(3L * 1024 * 1024 * 1024, 6L * 1024 * 1024 * 1024))
    }

    @Test
    fun sizeAndLimitText() {
        assertEquals("1 KB", FileUploads.sizeText(1))
        assertEquals("1024 KB", FileUploads.sizeText(1024 * 1024 - 1))
        assertEquals("1.5 MB", FileUploads.sizeText(1024 * 1024 * 3 / 2))
        assertEquals("100 MB", FileUploads.limitText(100L * 1024 * 1024))
        assertEquals("1.5 MB", FileUploads.limitText(1024 * 1024 * 3 / 2))
    }

    @Test
    fun displayNameDropsPathAndFallsBack() {
        assertEquals("报告.pdf", FileUploads.displayName("报告.pdf"))
        assertEquals("报告.pdf", FileUploads.displayName("  /storage/emulated/0/Download/报告.pdf "))
        assertEquals("a.txt", FileUploads.displayName("dir\\a.txt"))
        assertEquals("file", FileUploads.displayName(null))
        assertEquals("file", FileUploads.displayName("   "))
        assertEquals("doc", FileUploads.displayName("", fallback = "doc"))
    }

    @Test
    fun hexMatchesSha256() {
        val digest = MessageDigest.getInstance("SHA-256").digest("abc".toByteArray())
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", FileUploads.hex(digest))
        assertEquals("00ff10", FileUploads.hex(byteArrayOf(0, -1, 16)))
    }

    @Test
    fun pathForInputMatchesHostPasteText() {
        // 和被控端 files.js 的 pasteTextFor 一致
        assertEquals("C:\\Users\\a\\Downloads\\RemoteClaude\\x.pdf ", FileUploads.pathForInput("C:\\Users\\a\\Downloads\\RemoteClaude\\x.pdf"))
        assertEquals("\"C:\\d\\my file.pdf\" ", FileUploads.pathForInput("C:\\d\\my file.pdf"))
    }

    @Test
    fun pasteFailureTextIsShort() {
        assertEquals("电脑锁屏了", FileUploads.pasteFailureText("locked"))
        assertEquals("窗口已关闭", FileUploads.pasteFailureText("window-gone"))
        assertEquals("出错了", FileUploads.pasteFailureText(null))
    }

    @Test
    fun stallWatchTriggersOnlyWithoutProgress() {
        val w = StallWatch(30_000)
        assertFalse(w.stalled(0, 0))
        assertFalse(w.stalled(0, 29_000))
        assertFalse(w.stalled(100, 29_500)) // 有进展，重新计时
        assertFalse(w.stalled(100, 59_000))
        assertTrue(w.stalled(100, 59_501))
        assertFalse(w.stalled(200, 60_000))
    }
}
