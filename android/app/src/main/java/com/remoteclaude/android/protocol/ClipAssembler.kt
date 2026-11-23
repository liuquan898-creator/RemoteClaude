package com.remoteclaude.android.protocol

/**
 * 把电脑分块发来的剪贴板文字拼回去（协议文档 4.9）。
 *
 * 数据通道有序可靠，同一段的各块按顺序到。收到第 0 块就开始新的一段（没拼完的上一段丢掉）；
 * 中途来了对不上的块（换了 id、总数变了、顺序不对），说明这一段不完整，整段丢掉，等下一段的第 0 块。
 * 不是线程安全的，只在收数据通道消息的那一个线程上用。
 */
class ClipAssembler {
    private var id: String? = null
    private var count = 0
    private var next = 0
    private val buf = StringBuilder()

    /** 收到一块。这一块让整段拼齐了就返回整段文字，否则返回 null */
    fun add(chunk: ClipChunk): String? {
        if (chunk.count !in 1..MAX_CHUNKS || chunk.index !in 0 until chunk.count) {
            reset()
            return null
        }
        if (chunk.index == 0) {
            reset()
            id = chunk.id
            count = chunk.count
        } else if (chunk.id != id || chunk.count != count || chunk.index != next) {
            reset()
            return null
        }
        if (buf.length + chunk.text.length > MAX_CHARS) {
            reset()
            return null
        }
        buf.append(chunk.text)
        next = chunk.index + 1
        if (next < count) return null
        val text = buf.toString()
        reset()
        return text
    }

    fun reset() {
        id = null
        count = 0
        next = 0
        buf.setLength(0)
    }

    companion object {
        /** 被控端一段最多发 100000 个字符、每块 4000 个，这里留了余量 */
        const val MAX_CHUNKS = 256
        const val MAX_CHARS = 200_000
    }
}
