package com.remoteclaude.android.update

import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext

/** 服务器回的状态码说明不用再试了（没登录、文件不存在之类） */
class DownloadRejected(val code: Int) : IOException("服务器返回 $code")

/**
 * 能续传的下载（docs/08）。手机从内地连香港服务器常常丢包掉线，安装包又有几十 MB，
 * 所以没下完的部分存成 `<sha256 前 16 位>.part`：
 * - 断线后自动等一会儿，带 `Range: bytes=<已有长度>-` 从断点接着下，连续失败 [retryDelaysMs] 次才放弃；
 * - App 被关掉、下次再点"更新"，找到同一个文件名也接着下；
 * - 服务器不支持续传（回 200）就从头写；全部下完核对 SHA-256，对了才改名成 [finalName]。
 *
 * 只依赖 OkHttp 和文件，不依赖安卓，方便在电脑上测试。
 */
class ResumableDownload(
    private val http: OkHttpClient,
    private val retryDelaysMs: List<Long> = listOf(1_000, 2_000, 5_000, 10_000, 15_000, 30_000),
) {
    /**
     * 下载 [url] 到 [dir]/[finalName] 并核对 [sha256]（小写十六进制）。[size] 是预期大小，0 表示不知道。
     * [onProgress] 给 0 到 100，在调用者的线程上执行。失败抛 IOException。
     */
    suspend fun fetch(
        url: String,
        token: String,
        dir: File,
        finalName: String,
        sha256: String,
        size: Long,
        onProgress: suspend (Int) -> Unit,
    ): File {
        dir.mkdirs()
        val target = File(dir, finalName)
        val part = File(dir, partName(sha256, finalName))
        // 目录里只留这次的文件，旧版本的安装包和半截文件都删掉
        dir.listFiles()?.forEach { if (it != target && it != part) it.delete() }
        if (target.exists() && sha256Of(target) == sha256) return target
        target.delete()

        var failures = 0
        while (true) {
            coroutineContext.ensureActive()
            val before = part.length()
            try {
                if (attempt(url, token, part, size, onProgress)) break
            } catch (e: DownloadRejected) {
                throw e
            } catch (e: IOException) {
                // 这一次下到了新内容就重新计数，只有一直下不动才放弃
                failures = if (part.length() > before) 1 else failures + 1
                if (failures > retryDelaysMs.size) throw e
                delay(retryDelaysMs[failures - 1])
            }
        }

        if (sha256Of(part) != sha256) {
            part.delete()
            throw IOException("安装包校验不对，可能下载不完整")
        }
        if (!part.renameTo(target)) {
            part.copyTo(target, overwrite = true)
            part.delete()
        }
        return target
    }

    /** 下一次；下完返回 true。断线抛 IOException，由上面决定要不要再试 */
    private suspend fun attempt(url: String, token: String, part: File, size: Long, onProgress: suspend (Int) -> Unit): Boolean {
        var have = part.length()
        if (size > 0 && have > size) {
            part.delete()
            have = 0
        }
        if (size > 0 && have == size) return true
        val req = Request.Builder().url(url).header("Authorization", "Bearer $token").apply {
            if (have > 0) header("Range", "bytes=$have-")
        }.build()
        http.newCall(req).execute().use { res ->
            if (res.code == 416) {
                // 半截文件比服务器上的还长（服务器换过文件），从头下
                part.delete()
                throw IOException("服务器上的文件变了")
            }
            if (res.code in 400..499) throw DownloadRejected(res.code)
            if (!res.isSuccessful) throw IOException("服务器返回 ${res.code}")
            val offset = resumeOffset(res.code, res.header("Content-Range"), have)
                ?: throw IOException("服务器的续传回应不对")
            val body = res.body ?: throw IOException("没有内容")
            val total = totalFromContentRange(res.header("Content-Range"))
                ?: body.contentLength().takeIf { it >= 0 }?.let { offset + it }
                ?: size
            var done = offset
            var last = -1
            suspend fun report() {
                val p = if (total > 0) (done * 100 / total).toInt().coerceIn(0, 100) else 0
                if (p != last) {
                    last = p
                    onProgress(p)
                }
            }
            report()
            body.byteStream().use { input ->
                FileOutputStream(part, offset > 0).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        coroutineContext.ensureActive()
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        report()
                    }
                }
            }
            if (total > 0 && done < total) throw IOException("连接提前断了")
        }
        return true
    }

    companion object {
        fun partName(sha256: String, finalName: String): String =
            (sha256.take(16).takeIf { it.isNotEmpty() } ?: finalName) + ".part"

        /**
         * 续传请求的回应从哪里接着写：200 表示服务器给了整个文件，从 0 开始重写；
         * 206 要求 Content-Range 的起点正好是已有长度 [have]。其它情况返回 null（这个回应不能用）。
         */
        fun resumeOffset(code: Int, contentRange: String?, have: Long): Long? = when (code) {
            200 -> 0L
            206 -> CONTENT_RANGE.matchEntire(contentRange?.trim().orEmpty())
                ?.groupValues?.get(1)?.toLongOrNull()?.takeIf { it == have }
            else -> null
        }

        /** `bytes 100-199/1000` 里的 1000；没有或是 `*` 时返回 null */
        fun totalFromContentRange(contentRange: String?): Long? =
            CONTENT_RANGE.matchEntire(contentRange?.trim().orEmpty())?.groupValues?.get(3)?.toLongOrNull()

        private val CONTENT_RANGE = Regex("""bytes (\d+)-(\d+)/(\d+|\*)""")

        fun sha256Of(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    digest.update(buf, 0, n)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
