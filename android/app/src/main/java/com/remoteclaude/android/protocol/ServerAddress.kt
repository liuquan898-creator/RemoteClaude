package com.remoteclaude.android.protocol

import java.net.URI
import java.net.URISyntaxException

/**
 * 把用户填的服务器地址整理成信令 WebSocket 地址和账号接口的 HTTP 地址。
 *
 *   rc.example.com             -> wss://rc.example.com/ws      https://rc.example.com
 *   https://rc.example.com     -> wss://rc.example.com/ws      https://rc.example.com
 *   ws://10.0.2.2:8787         -> ws://10.0.2.2:8787/ws        http://10.0.2.2:8787   （仅调试版允许明文）
 *   wss://rc.example.com/rc/ws -> wss://rc.example.com/rc/ws   https://rc.example.com/rc
 */
object ServerAddress {
    sealed interface Result {
        /** @param url 信令 WebSocket 地址；@param httpBase 账号接口的根地址，后面接 /api/... */
        data class Ok(val url: String, val httpBase: String) : Result
        data class Invalid(val reason: String) : Result
    }

    fun parse(input: String, allowCleartext: Boolean): Result {
        val raw = input.trim()
        if (raw.isEmpty()) return Result.Invalid("请填写服务器地址")

        val schemeEnd = raw.indexOf("://")
        val scheme = if (schemeEnd >= 0) raw.substring(0, schemeEnd).lowercase() else "wss"
        val rest = if (schemeEnd >= 0) raw.substring(schemeEnd + 3) else raw
        val wsScheme = when (scheme) {
            "wss", "https" -> "wss"
            "ws", "http" -> "ws"
            else -> return Result.Invalid("不支持的地址格式：$scheme")
        }
        if (wsScheme == "ws" && !allowCleartext) {
            return Result.Invalid("只能连接 https 或 wss 地址")
        }

        val uri = try {
            URI("$wsScheme://$rest")
        } catch (_: URISyntaxException) {
            return Result.Invalid("服务器地址格式不正确")
        }
        val host = uri.host
        if (host.isNullOrEmpty()) return Result.Invalid("服务器地址格式不正确")

        val port = if (uri.port > 0) ":${uri.port}" else ""
        val path = uri.rawPath.let { if (it.isNullOrEmpty() || it == "/") "/ws" else it }
        val httpScheme = if (wsScheme == "wss") "https" else "http"
        val basePath = path.removeSuffix("/").removeSuffix("/ws")
        return Result.Ok("$wsScheme://$host$port$path", "$httpScheme://$host$port$basePath")
    }
}
