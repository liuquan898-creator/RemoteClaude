package com.remoteclaude.android.ui

import com.remoteclaude.android.ui.CodeSpans.Code
import com.remoteclaude.android.ui.CodeSpans.Plain
import org.junit.Assert.assertEquals
import org.junit.Test

class CodeSpansTest {
    @Test
    fun `没有反引号就是一段普通文字`() {
        assertEquals(listOf(Plain("弄好了吗？")), CodeSpans.split("弄好了吗？"))
    }

    @Test
    fun `行内命令拆出来`() {
        assertEquals(
            listOf(Plain("请运行 "), Code("curl -s https://example.com/k.txt >> ~/.ssh/authorized_keys"), Plain(" 然后回车")),
            CodeSpans.split("请运行 `curl -s https://example.com/k.txt >> ~/.ssh/authorized_keys` 然后回车"),
        )
    }

    @Test
    fun `多个命令各拆各的`() {
        assertEquals(
            listOf(Code("a"), Plain(" 和 "), Code("b")),
            CodeSpans.split("`a` 和 `b`"),
        )
    }

    @Test
    fun `代码块去掉语言名和首尾换行`() {
        assertEquals(
            listOf(Plain("粘贴：\n"), Code("sudo apt update\nsudo apt install -y coturn"), Plain("\n好了吗")),
            CodeSpans.split("粘贴：\n```bash\nsudo apt update\nsudo apt install -y coturn\n```\n好了吗"),
        )
    }

    @Test
    fun `代码块第一行有空格就不是语言名`() {
        assertEquals(listOf(Code("echo hi\nls")), CodeSpans.split("```echo hi\nls```"))
        assertEquals(listOf(Code("echo hi")), CodeSpans.split("```echo hi```"))
    }

    @Test
    fun `双反引号里可以有单反引号`() {
        assertEquals(listOf(Code("echo `date`")), CodeSpans.split("`` echo `date` ``"))
    }

    @Test
    fun `没配对的反引号当普通文字`() {
        assertEquals(listOf(Plain("这里有个 ` 号")), CodeSpans.split("这里有个 ` 号"))
        assertEquals(listOf(Plain("``x` 不配对")), CodeSpans.split("``x` 不配对"))
    }

    @Test
    fun `空的反引号当普通文字`() {
        assertEquals(listOf(Plain("空 `` 的")), CodeSpans.split("空 `` 的"))
        assertEquals(listOf(Plain("空 `  ` 的")), CodeSpans.split("空 `  ` 的"))
    }

    @Test
    fun `公钥这种长串原样保留`() {
        // 编出来的一串，不是谁的公钥
        val key = "echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly0123456789abcdefghijk/+XYZ' >> ~/.ssh/authorized_keys"
        assertEquals(listOf(Plain("粘贴并回车："), Code(key)), CodeSpans.split("粘贴并回车：`$key`"))
    }
}
