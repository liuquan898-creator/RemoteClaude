package com.remoteclaude.android.files

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.IOException
import java.io.InputStream

/**
 * 用户在系统文件选择器里选的一个文件：名字、大小，以及从头读它的办法。
 *
 * 有的文件提供方（网盘之类）给不出大小，这时先把文件复制到 App 的缓存目录，边复制边数，
 * 超过 [limit] 就停下；之后从副本读，用完调 [release] 删掉。
 */
class FileSource private constructor(
    private val context: Context,
    private val uri: Uri,
    val name: String,
    val size: Long,
    private val copy: File?,
) {
    fun open(): InputStream =
        copy?.inputStream() ?: context.contentResolver.openInputStream(uri) ?: throw IOException("打不开这个文件")

    fun release() {
        copy?.delete()
    }

    /** 文件超过上限，没有读完 */
    class TooLarge(val name: String) : IOException("文件太大")

    companion object {
        /** 很耗时（可能要复制整个文件），要在后台线程调用 */
        @Throws(IOException::class)
        fun from(context: Context, uri: Uri, limit: Long): FileSource {
            var name: String? = null
            var size = -1L
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                }
            }
            val display = FileUploads.displayName(name ?: uri.lastPathSegment)
            if (size > limit) throw TooLarge(display)
            if (size >= 0) return FileSource(context, uri, display, size, null)

            val dir = File(context.cacheDir, "upload").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() } // 上次没删掉的
            val copy = File(dir, "pending")
            var total = 0L
            try {
                (context.contentResolver.openInputStream(uri) ?: throw IOException("打不开这个文件")).use { input ->
                    copy.outputStream().use { out ->
                        val buf = ByteArray(FileUploads.READ_BLOCK)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            total += n
                            if (total > limit) throw TooLarge(display)
                            out.write(buf, 0, n)
                        }
                    }
                }
            } catch (e: Exception) {
                copy.delete()
                throw e
            }
            return FileSource(context, uri, display, total, copy)
        }
    }
}
