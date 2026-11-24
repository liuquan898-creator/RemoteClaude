package com.remoteclaude.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAddressTest {
    private fun ok(input: String, cleartext: Boolean = false): ServerAddress.Result.Ok {
        val r = ServerAddress.parse(input, cleartext)
        assertTrue("应当合法: $input -> $r", r is ServerAddress.Result.Ok)
        return r as ServerAddress.Result.Ok
    }

    private fun invalid(input: String, cleartext: Boolean = false) {
        val r = ServerAddress.parse(input, cleartext)
        assertTrue("应当不合法: $input -> $r", r is ServerAddress.Result.Invalid)
    }

    @Test
    fun bareHostDefaultsToWss() {
        val r = ok("rc.example.com")
        assertEquals("wss://rc.example.com/ws", r.url)
        assertEquals("https://rc.example.com", r.httpBase)
    }

    @Test
    fun httpsBecomesWss() = assertEquals("wss://rc.example.com/ws", ok("https://rc.example.com/").url)

    @Test
    fun keepsPortAndCustomPath() {
        val r = ok("wss://rc.example.com:8443/rc/ws")
        assertEquals("wss://rc.example.com:8443/rc/ws", r.url)
        assertEquals("https://rc.example.com:8443/rc", r.httpBase)
    }

    @Test
    fun trimsWhitespace() = assertEquals("wss://rc.example.com/ws", ok("  rc.example.com  ").url)

    @Test
    fun cleartextOnlyWhenAllowed() {
        val emulator = ok("ws://10.0.2.2:8787", cleartext = true)
        assertEquals("ws://10.0.2.2:8787/ws", emulator.url)
        assertEquals("http://10.0.2.2:8787", emulator.httpBase)
        assertEquals("ws://192.168.1.5:8787/ws", ok("http://192.168.1.5:8787", cleartext = true).url)
        invalid("ws://10.0.2.2:8787")
        invalid("http://rc.example.com")
    }

    @Test
    fun acceptsSameFormsAsHost() {
        assertEquals("wss://rc.example.com/ws", ok("wss://rc.example.com/ws").url)
        assertEquals("ws://127.0.0.1:8787/ws", ok("ws://127.0.0.1:8787/ws", cleartext = true).url)
    }

    @Test
    fun restoresStoredAddress() {
        // 以前的正式版登录时存下的是打包时写进去的地址（只有域名），升级后照样能用
        val r = ServerAddress.restore("rc.example.com", allowCleartext = false)
        assertEquals("wss://rc.example.com/ws", r?.url)
        assertEquals("https://rc.example.com", r?.httpBase)
        assertNull(ServerAddress.restore("", allowCleartext = false))
        assertNull(ServerAddress.restore("ws://10.0.2.2:8787", allowCleartext = false))
        assertEquals("ws://10.0.2.2:8787/ws", ServerAddress.restore("ws://10.0.2.2:8787", allowCleartext = true)?.url)
    }

    @Test
    fun rejectsGarbage() {
        invalid("")
        invalid("   ")
        invalid("ftp://rc.example.com")
        invalid("https://")
    }
}
