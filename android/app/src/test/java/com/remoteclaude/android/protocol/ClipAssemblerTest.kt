package com.remoteclaude.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 剪贴板回传（docs/03-protocol.md 4.9）：解析 clip 消息、把分块拼回去 */
class ClipAssemblerTest {
    private fun chunk(id: String, i: Int, n: Int, s: String) = ClipChunk(id, i, n, s)

    @Test
    fun parsesClipMessages() {
        assertEquals(
            ClipChunk("c1", 0, 1, "你好\n第二行 \"引号\" 😀"),
            Protocol.parseClipChunk("""{"t":"clip","id":"c1","i":0,"n":1,"s":"你好\n第二行 \"引号\" 😀"}"""),
        )
        assertEquals(ClipChunk("c2", 2, 3, ""), Protocol.parseClipChunk("""{"t":"clip","id":"c2","i":2,"n":3,"s":""}"""))

        // 缺字段、序号超出范围、块数离谱的都不认
        assertNull(Protocol.parseClipChunk("""{"t":"clip","i":0,"n":1,"s":"a"}"""))
        assertNull(Protocol.parseClipChunk("""{"t":"clip","id":"","i":0,"n":1,"s":"a"}"""))
        assertNull(Protocol.parseClipChunk("""{"t":"clip","id":"c1","i":0,"n":1}"""))
        assertNull(Protocol.parseClipChunk("""{"t":"clip","id":"c1","i":1,"n":1,"s":"a"}"""))
        assertNull(Protocol.parseClipChunk("""{"t":"clip","id":"c1","i":-1,"n":1,"s":"a"}"""))
        assertNull(Protocol.parseClipChunk("""{"t":"clip","id":"c1","i":0,"n":0,"s":"a"}"""))
        assertNull(Protocol.parseClipChunk("""{"t":"clip","id":"c1","i":0,"n":100000,"s":"a"}"""))
        assertNull(Protocol.parseClipChunk("不是 JSON"))

        assertEquals("too-large", Protocol.parseClipSkip("""{"t":"clip-skip","code":"too-large"}"""))
        assertEquals("unknown", Protocol.parseClipSkip("""{"t":"clip-skip"}"""))
        assertNull(Protocol.parseClipSkip("""{"t":"clip","id":"c1","i":0,"n":1,"s":"a"}"""))
    }

    @Test
    fun otherParsersIgnoreClipMessages() {
        val clip = """{"t":"clip","id":"c1","i":0,"n":1,"s":"a"}"""
        val skip = """{"t":"clip-skip","code":"too-large"}"""
        for (m in listOf(clip, skip)) {
            assertNull(Protocol.parseLockState(m))
            assertNull(Protocol.parseTileState(m))
            assertNull(Protocol.parseUnlockResult(m))
            assertNull(Protocol.parseImageReply(m))
            assertNull(Protocol.parseFileCaps(m))
            assertNull(Protocol.parseInputError(m))
        }
        // 反过来，别的消息也不会被当成剪贴板
        assertNull(Protocol.parseClipChunk("""{"t":"lock","locked":true,"unlock":false}"""))
        assertNull(Protocol.parseClipChunk("""{"t":"err","code":"covered"}"""))
        assertNull(Protocol.parseClipSkip("""{"t":"err","code":"too-large"}"""))
    }

    @Test
    fun singleChunkCompletesAtOnce() {
        val a = ClipAssembler()
        assertEquals("只有一块", a.add(chunk("c1", 0, 1, "只有一块")))
        // 下一段照常
        assertEquals("第二段", a.add(chunk("c2", 0, 1, "第二段")))
    }

    @Test
    fun joinsChunksInOrder() {
        val a = ClipAssembler()
        assertNull(a.add(chunk("c1", 0, 3, "第一块，")))
        assertNull(a.add(chunk("c1", 1, 3, "第二块😀，")))
        assertEquals("第一块，第二块😀，第三块", a.add(chunk("c1", 2, 3, "第三块")))
    }

    @Test
    fun surrogatePairSplitAcrossChunksSurvives() {
        // 被控端不会把表情切成两半，但就算切了，拼回去也要是原样
        val emoji = "😀"
        val a = ClipAssembler()
        assertNull(a.add(chunk("c1", 0, 2, "a" + emoji[0])))
        assertEquals("a😀b", a.add(chunk("c1", 1, 2, emoji[1] + "b")))
    }

    @Test
    fun newFirstChunkDropsUnfinishedOne() {
        val a = ClipAssembler()
        assertNull(a.add(chunk("c1", 0, 3, "没拼完的")))
        assertNull(a.add(chunk("c2", 0, 2, "新的一段，")))
        assertEquals("新的一段，拼完了", a.add(chunk("c2", 1, 2, "拼完了")))
    }

    @Test
    fun mismatchedChunkDropsWholeClip() {
        // 缺了第 1 块
        val a = ClipAssembler()
        assertNull(a.add(chunk("c1", 0, 3, "a")))
        assertNull(a.add(chunk("c1", 2, 3, "c")))
        // 丢掉以后，这一段后面的块也不认
        assertNull(a.add(chunk("c1", 1, 3, "b")))
        assertNull(a.add(chunk("c1", 2, 3, "c")))

        // 换了 id
        assertNull(a.add(chunk("c2", 0, 2, "a")))
        assertNull(a.add(chunk("c3", 1, 2, "b")))

        // 总数变了
        assertNull(a.add(chunk("c4", 0, 2, "a")))
        assertNull(a.add(chunk("c4", 1, 3, "b")))

        // 没有第 0 块就来了后面的
        assertNull(ClipAssembler().add(chunk("c5", 1, 2, "b")))

        // 之后新的一段照常
        assertEquals("好的", a.add(chunk("c6", 0, 1, "好的")))
    }

    @Test
    fun dropsClipLongerThanLimit() {
        val a = ClipAssembler()
        val big = "长".repeat(ClipAssembler.MAX_CHARS / 2)
        assertNull(a.add(chunk("c1", 0, 3, big)))
        assertNull(a.add(chunk("c1", 1, 3, big)))
        assertNull(a.add(chunk("c1", 2, 3, "多出来的")))
        // 正好到上限的可以
        assertNull(a.add(chunk("c2", 0, 2, big)))
        assertEquals(ClipAssembler.MAX_CHARS, a.add(chunk("c2", 1, 2, big))?.length)
    }

    @Test
    fun rejectsNonsenseChunkNumbers() {
        val a = ClipAssembler()
        assertNull(a.add(chunk("c1", 0, 0, "a")))
        assertNull(a.add(chunk("c1", 3, 2, "a")))
        assertNull(a.add(chunk("c1", 0, ClipAssembler.MAX_CHUNKS + 1, "a")))
        assertEquals("a", a.add(chunk("c1", 0, 1, "a")))
    }
}
