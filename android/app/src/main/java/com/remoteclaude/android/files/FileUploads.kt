package com.remoteclaude.android.files

import java.util.Locale

/**
 * 发文件（协议文档 4.8）用到的常量和纯计算，不依赖安卓，有单元测试。
 */
object FileUploads {
    /** 每个二进制帧的大小，和图片一样 */
    const val CHUNK = 16 * 1024
    /** 每次从文件里读这么多，再切成 [CHUNK] 发出 */
    const val READ_BLOCK = 256 * 1024
    /** file 通道里排队超过这么多就等一等：够把中继的往返填满，又不至于撑爆通道的缓冲（16 MB 会被关掉） */
    const val MAX_BUFFERED = 1024 * 1024L
    /** 通道里的数据这么久一点都没送出去，算卡住了 */
    const val STALL_MS = 30_000L
    /** 等 file 通道建好 */
    const val OPEN_TIMEOUT_MS = 10_000L
    /** 发完以后等电脑核对、存好、粘贴路径 */
    const val REPLY_TIMEOUT_MS = 30_000L

    /** 发出去的字节里大致已经送到网络上的：交给通道的减去还在通道里排队的 */
    fun delivered(handed: Long, buffered: Long): Long = (handed - buffered).coerceIn(0, handed.coerceAtLeast(0))

    fun percent(done: Long, total: Long): Int =
        if (total <= 0) 100 else (done * 100 / total).toInt().coerceIn(0, 100)

    fun sizeText(bytes: Long): String = when {
        bytes < 1024 * 1024 -> "${(bytes + 1023) / 1024} KB"
        else -> String.format(Locale.ROOT, "%.1f MB", bytes / 1048576.0)
    }

    /** "最大 100 MB" 这种说法里的大小，整 MB 时不带小数 */
    fun limitText(bytes: Long): String =
        if (bytes % (1024 * 1024) == 0L) "${bytes / (1024 * 1024)} MB" else sizeText(bytes)

    /**
     * 给电脑的文件名：系统选择器给不出名字时用 [fallback]。只去掉首尾空白和路径，
     * Windows 不允许的字符由电脑那边处理（被控端 files.js 的 safeName）。
     */
    fun displayName(raw: String?, fallback: String = "file"): String {
        val s = raw?.substringAfterLast('/')?.substringAfterLast('\\')?.trim().orEmpty()
        return s.ifEmpty { fallback }
    }

    fun hex(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            out.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
        }
        return out.toString()
    }

    private val HEX = "0123456789abcdef".toCharArray()

    /** 放进手机输入框的路径，和电脑直接粘贴的一样（被控端 files.js 的 pasteTextFor）：有空白时加引号，末尾留一个空格 */
    fun pathForInput(path: String): String = (if (path.any { it.isWhitespace() }) "\"$path\"" else path) + " "

    /** 粘贴没成功时的原因，放进一句话里用，要短 */
    fun pasteFailureText(code: String?): String = when (code) {
        "locked" -> "电脑锁屏了"
        "front-failed" -> "切不到那个窗口"
        "window-gone" -> "窗口已关闭"
        else -> "出错了"
    }
}

/**
 * 判断传输卡住了没有：送出去的字节数超过 [limitMs] 没有增加就算卡住。
 * 电脑那边断了、网络不通时，通道里的数据一直排着发不出去，不靠这个就会一直等下去。
 */
class StallWatch(private val limitMs: Long) {
    private var best = -1L
    private var since = 0L

    fun stalled(delivered: Long, nowMs: Long): Boolean {
        if (delivered > best) {
            best = delivered
            since = nowMs
            return false
        }
        return nowMs - since > limitMs
    }
}
