package com.remoteclaude.android.update

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.random.Random

/** 断点续传（docs/08）：用一个会中途掐断连接的本机 HTTP 服务器测真实的下载过程 */
class ResumableDownloadTest {
    private val data = Random(42).nextBytes(200_000)
    private val sha = MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
    private val dir: File = Files.createTempDirectory("rc-dl").toFile()
    private val http = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build()
    private val servers = mutableListOf<FlakyServer>()

    @After
    fun cleanup() {
        servers.forEach { it.close() }
        dir.deleteRecursively()
    }

    private fun server(cuts: Int = 0, cutBytes: Int = 0, supportRange: Boolean = true, status: Int = 0) =
        FlakyServer(data, cuts, cutBytes, supportRange, status).also { servers += it }

    private fun fetch(s: FlakyServer, sha256: String = sha, delays: List<Long> = listOf(1, 1, 1), progress: MutableList<Int>? = null) =
        runBlocking {
            ResumableDownload(http, delays).fetch(s.url, "tok", dir, "app.apk", sha256, data.size.toLong()) { progress?.add(it) }
        }

    private fun part() = File(dir, ResumableDownload.partName(sha, "app.apk"))

    @Test
    fun dropsAreResumedFromWhereTheyStopped() {
        val s = server(cuts = 3, cutBytes = 50_000)
        val progress = mutableListOf<Int>()
        val file = fetch(s, progress = progress)
        assertArrayEquals(data, file.readBytes())
        assertEquals(listOf(null, "bytes=50000-", "bytes=100000-", "bytes=150000-"), s.ranges)
        assertEquals(100, progress.last())
        assertEquals("令牌照常带上", listOf("Bearer tok"), s.auths.distinct())
        assertFalse(part().exists())
    }

    @Test
    fun halfFileFromAnEarlierRunIsContinued() {
        part().apply { parentFile!!.mkdirs() }.writeBytes(data.copyOf(70_000))
        File(dir, "RemoteClaude-old.apk").writeBytes(byteArrayOf(1, 2, 3))
        val s = server()
        val file = fetch(s)
        assertArrayEquals(data, file.readBytes())
        assertEquals(listOf("bytes=70000-"), s.ranges)
        assertFalse("旧版本的安装包删掉了", File(dir, "RemoteClaude-old.apk").exists())
    }

    @Test
    fun serverWithoutRangeSupportStartsOver() {
        part().apply { parentFile!!.mkdirs() }.writeBytes(data.copyOf(70_000))
        val s = server(supportRange = false)
        assertArrayEquals(data, fetch(s).readBytes())
        assertEquals(listOf("bytes=70000-"), s.ranges)
    }

    @Test
    fun alreadyDownloadedFileIsReused() {
        File(dir, "app.apk").apply { parentFile!!.mkdirs() }.writeBytes(data)
        val s = server()
        assertArrayEquals(data, fetch(s).readBytes())
        assertTrue("不再请求服务器", s.ranges.isEmpty())
    }

    @Test
    fun wrongChecksumDeletesTheDownload() {
        val wrong = "0".repeat(64)
        val s = server()
        try {
            fetch(s, sha256 = wrong)
            fail("应该报校验不对")
        } catch (e: IOException) {
            assertTrue(e.message!!.contains("校验"))
        }
        assertFalse(File(dir, ResumableDownload.partName(wrong, "app.apk")).exists())
        assertFalse(File(dir, "app.apk").exists())
    }

    @Test
    fun givesUpWhenNothingComesThrough() {
        val s = server(cuts = 100, cutBytes = 0)
        try {
            fetch(s, delays = listOf(1, 1))
            fail("应该放弃")
        } catch (e: IOException) {
            // 第一次加两次重试
            assertEquals(3, s.ranges.size)
        }
    }

    @Test
    fun clientErrorsAreNotRetried() {
        val s = server(status = 401)
        try {
            fetch(s)
            fail("应该报错")
        } catch (e: DownloadRejected) {
            assertEquals(401, e.code)
        }
        assertEquals(1, s.ranges.size)
    }

    @Test
    fun contentRangeParsing() {
        assertEquals(0L, ResumableDownload.resumeOffset(200, null, 500))
        assertEquals(500L, ResumableDownload.resumeOffset(206, "bytes 500-999/1000", 500))
        assertNull("起点对不上不能接", ResumableDownload.resumeOffset(206, "bytes 0-999/1000", 500))
        assertNull(ResumableDownload.resumeOffset(206, null, 500))
        assertNull(ResumableDownload.resumeOffset(204, null, 0))
        assertEquals(1000L, ResumableDownload.totalFromContentRange("bytes 500-999/1000"))
        assertNull(ResumableDownload.totalFromContentRange("bytes 500-999/*"))
        assertNull(ResumableDownload.totalFromContentRange(null))
    }
}

/**
 * 本机 HTTP 服务器：前 [cuts] 次回应只发 [cutBytes] 字节就断开；[supportRange] 为 false 时不理 Range；
 * [status] 非 0 时直接回这个状态码。
 */
private class FlakyServer(
    private val data: ByteArray,
    @Volatile private var cuts: Int,
    private val cutBytes: Int,
    private val supportRange: Boolean,
    private val status: Int,
) : AutoCloseable {
    private val socket = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    val ranges: MutableList<String?> = Collections.synchronizedList(mutableListOf())
    val auths: MutableList<String?> = Collections.synchronizedList(mutableListOf())
    val url get() = "http://127.0.0.1:${socket.localPort}/download/android/app.apk"

    init {
        thread(isDaemon = true) {
            while (!socket.isClosed) {
                val s = try {
                    socket.accept()
                } catch (e: IOException) {
                    break
                }
                try {
                    handle(s)
                } catch (_: IOException) {
                }
            }
        }
    }

    private fun handle(s: Socket) = s.use {
        val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.ISO_8859_1))
        reader.readLine() ?: return
        var range: String? = null
        var auth: String? = null
        while (true) {
            val line = reader.readLine() ?: return
            if (line.isEmpty()) break
            val name = line.substringBefore(':').trim().lowercase()
            val value = line.substringAfter(':').trim()
            if (name == "range") range = value
            if (name == "authorization") auth = value
        }
        ranges += range
        auths += auth
        val out = s.getOutputStream()
        if (status != 0) {
            out.write("HTTP/1.1 $status Nope\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
            return
        }
        val start = if (supportRange) range?.removePrefix("bytes=")?.removeSuffix("-")?.toIntOrNull() ?: 0 else 0
        val head = if (start > 0) {
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes $start-${data.size - 1}/${data.size}\r\n"
        } else {
            "HTTP/1.1 200 OK\r\n"
        }
        out.write((head + "Content-Length: ${data.size - start}\r\nConnection: close\r\n\r\n").toByteArray())
        val n = if (cuts > 0) {
            cuts--
            minOf(cutBytes, data.size - start)
        } else {
            data.size - start
        }
        out.write(data, start, n)
        out.flush()
    }

    override fun close() = socket.close()
}
