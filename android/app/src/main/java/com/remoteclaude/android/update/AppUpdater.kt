package com.remoteclaude.android.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import com.remoteclaude.android.protocol.AppUpdateInfo
import com.remoteclaude.android.protocol.Protocol
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * App 内升级（docs/08）：向自己的服务器查最新安装包，下载到缓存目录、核对 SHA-256，再交给系统安装。
 * 下载要带登录令牌。系统安装界面要用户点一次"安装"，这是安卓的规定，绕不过去。
 */
class AppUpdater(private val context: Context) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        // 线路差时连接会卡住不动，早点断开好从断点重连
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    sealed interface Check {
        data class Found(val info: AppUpdateInfo) : Check
        data object None : Check
        data class Failed(val message: String) : Check
    }

    /** 查服务器上的最新版本；不比当前版本新时返回 [Check.None] */
    suspend fun check(httpBase: String, token: String, currentCode: Int): Check = withContext(Dispatchers.IO) {
        val req = Request.Builder().url("$httpBase/api/update/android").header("Authorization", "Bearer $token").build()
        try {
            http.newCall(req).execute().use { res ->
                val body = res.body?.string().orEmpty()
                when {
                    res.code == 404 -> Check.None // 还没发布过
                    !res.isSuccessful -> Check.Failed("服务器返回 ${res.code}")
                    else -> {
                        val info = Protocol.parseAppUpdate(body) ?: return@withContext Check.Failed("服务器返回的版本信息不对")
                        if (info.packageName == context.packageName && info.versionCode > currentCode) Check.Found(info) else Check.None
                    }
                }
            }
        } catch (e: IOException) {
            Check.Failed("连不上服务器")
        }
    }

    /**
     * 下载安装包并核对哈希，[onProgress] 给 0 到 100（在主线程上调用）；失败抛 IOException。
     * 断线会自动从断点接着下，App 关掉后再下也接着上次的进度（见 [ResumableDownload]）。
     */
    suspend fun download(httpBase: String, token: String, info: AppUpdateInfo, onProgress: (Int) -> Unit): File =
        withContext(Dispatchers.IO) {
            ResumableDownload(http).fetch(
                url = httpBase + info.url,
                token = token,
                dir = File(context.cacheDir, UPDATE_DIR),
                finalName = "RemoteClaude-${info.versionName.ifEmpty { info.versionCode.toString() }}.apk",
                sha256 = info.sha256.lowercase(),
                size = info.size,
            ) { p -> withContext(Dispatchers.Main) { onProgress(p) } }
        }

    /** 系统是否允许本 App 安装应用（第一次要用户在设置里打开） */
    fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

    /** 打开"允许安装未知应用"的设置页 */
    fun openInstallPermission() {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    /** 打开系统的安装界面 */
    fun install(file: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    private companion object {
        const val UPDATE_DIR = "updates"
    }
}
