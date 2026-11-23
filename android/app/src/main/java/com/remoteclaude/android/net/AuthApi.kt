package com.remoteclaude.android.net

import com.remoteclaude.android.protocol.Protocol
import com.remoteclaude.android.protocol.long
import com.remoteclaude.android.protocol.string
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** 账号接口的调用结果 */
sealed interface ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>

    /** @param code 服务器给的错误码（见协议文档 1.6），连不上服务器时为 "network" */
    data class Err(val code: String, val message: String, val retryAfter: Int? = null) : ApiResult<Nothing>
}

data class LoginResult(val token: String, val email: String)

/**
 * 账号接口：发验证码、注册、登录、重置密码、退出登录。约定见 docs/03-protocol.md 第 1 节。
 * 所有方法都是挂起函数，在 IO 线程上执行。
 */
class AuthApi {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS) // 发验证码要等邮件发出去
        .build()

    suspend fun sendCode(base: String, email: String, purpose: String): ApiResult<Int> =
        post(base, "send-code", buildJsonObject {
            put("email", email)
            put("purpose", purpose)
        }) { it.long("cooldown")?.toInt() ?: 60 }

    suspend fun register(base: String, email: String, code: String, password: String, device: DeviceInfo): ApiResult<LoginResult> =
        post(base, "register", buildJsonObject {
            put("email", email)
            put("code", code)
            put("password", password)
            putDevice(device)
        }, ::loginResult)

    suspend fun login(base: String, email: String, password: String, device: DeviceInfo): ApiResult<LoginResult> =
        post(base, "login", buildJsonObject {
            put("email", email)
            put("password", password)
            putDevice(device)
        }, ::loginResult)

    suspend fun resetPassword(base: String, email: String, code: String, password: String): ApiResult<Unit> =
        post(base, "reset-password", buildJsonObject {
            put("email", email)
            put("code", code)
            put("password", password)
        }) { }

    /** 通知服务器作废令牌；失败也无所谓，令牌会自然过期 */
    suspend fun logout(base: String, token: String) {
        post(base, "logout", JsonObject(emptyMap()), token) { }
    }

    data class DeviceInfo(val deviceId: String, val deviceName: String)

    private fun kotlinx.serialization.json.JsonObjectBuilder.putDevice(d: DeviceInfo) {
        put("clientType", "viewer")
        put("deviceId", d.deviceId)
        put("deviceName", d.deviceName)
    }

    private fun loginResult(o: JsonObject): LoginResult =
        LoginResult(o.string("token").orEmpty(), o.string("email").orEmpty())

    private suspend fun <T> post(
        base: String,
        path: String,
        body: JsonObject,
        bearer: String? = null,
        parse: (JsonObject) -> T,
    ): ApiResult<T> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$base/api/auth/$path")
            .post(body.toString().toRequestBody(JSON))
            .apply { if (bearer != null) header("Authorization", "Bearer $bearer") }
            .build()
        try {
            http.newCall(request).execute().use { res ->
                val obj = Protocol.parseObject(res.body?.string().orEmpty()) ?: JsonObject(emptyMap())
                if (res.isSuccessful) {
                    ApiResult.Ok(parse(obj))
                } else {
                    ApiResult.Err(
                        code = obj.string("error") ?: "http-${res.code}",
                        message = obj.string("message") ?: "请求失败（HTTP ${res.code}）",
                        retryAfter = obj.long("retryAfter")?.toInt(),
                    )
                }
            }
        } catch (e: IOException) {
            ApiResult.Err("network", "连不上服务器，请检查地址和网络")
        }
    }

    private suspend fun <T> post(base: String, path: String, body: JsonObject, parse: (JsonObject) -> T): ApiResult<T> =
        post(base, path, body, null, parse)

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
