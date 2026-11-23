package com.remoteclaude.android.ui

/**
 * 把 Claude 提问里的文字按 Markdown 的代码写法拆开（docs/09 第 6 节）：
 * 用反引号括起来的（`命令` 或 ```代码块```）是要用户原样复制的内容，手机上单独显示并带"复制"按钮。
 * 没配对的反引号当普通文字。
 */
object CodeSpans {
    sealed interface Part {
        val text: String
    }

    data class Plain(override val text: String) : Part

    data class Code(override val text: String) : Part

    fun split(s: String): List<Part> {
        val out = mutableListOf<Part>()
        val plain = StringBuilder()
        fun flush() {
            if (plain.isNotEmpty()) {
                out += Plain(plain.toString())
                plain.clear()
            }
        }
        var i = 0
        while (i < s.length) {
            if (s[i] != '`') {
                plain.append(s[i])
                i++
                continue
            }
            val n = runLength(s, i)
            val close = findClose(s, i + n, n)
            if (close < 0) {
                plain.append(s, i, i + n)
                i += n
                continue
            }
            val body = if (n >= 3) fencedBody(s.substring(i + n, close)) else inlineBody(s.substring(i + n, close))
            if (body.isBlank()) {
                plain.append(s, i, close + n)
            } else {
                flush()
                out += Code(body)
            }
            i = close + n
        }
        flush()
        return out
    }

    private fun runLength(s: String, from: Int): Int {
        var n = 0
        while (from + n < s.length && s[from + n] == '`') n++
        return n
    }

    /** 找长度正好是 n 的一串反引号；更长或更短的串跳过 */
    private fun findClose(s: String, from: Int, n: Int): Int {
        var j = from
        while (j < s.length) {
            val k = s.indexOf('`', j)
            if (k < 0) return -1
            val r = runLength(s, k)
            if (r == n) return k
            j = k + r
        }
        return -1
    }

    /** 代码块：第一行是语言名（或空）就去掉，再去掉首尾换行 */
    private fun fencedBody(raw: String): String {
        var body = raw
        val nl = body.indexOf('\n')
        if (nl >= 0 && body.substring(0, nl).trim().none { it.isWhitespace() }) body = body.substring(nl + 1)
        return body.trim('\n', '\r')
    }

    /** 行内代码：两头各有一个空格时各去掉一个（和 Markdown 一样） */
    private fun inlineBody(raw: String): String =
        if (raw.length >= 2 && raw.startsWith(' ') && raw.endsWith(' ') && raw.isNotBlank()) raw.substring(1, raw.length - 1) else raw
}
