package com.remoteclaude.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 用户可以在设置里改的选项 */
data class AppSettings(
    val keepScreenOn: Boolean = true,
    val haptics: Boolean = true,
    val showStats: Boolean = false,
    val appLock: Boolean = true,
    /** App 不在前台时也保持连接、用系统通知提醒审批（docs/09 第 6 节） */
    val backgroundApprovals: Boolean = true,
    /** 看画面时，电脑上新复制的文字自动放进手机剪贴板（协议文档 4.9） */
    val syncClipboard: Boolean = true,
)

/** 启动时一次性读出的全部本地数据 */
data class StoredData(
    val server: String,
    /** 登录令牌（已解密） */
    val session: String?,
    val email: String,
    /** 本机设备编号，第一次运行时随机生成 */
    val deviceId: String,
    val lastHost: String,
    val lastHwnd: Long,
    val settings: AppSettings,
    /** "全部会话"里折叠起来的环境 */
    val collapsedGroups: Set<String>,
)

private val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

/**
 * 本地存储。口令从不落盘；会话令牌用 Android Keystore 里的密钥加密后再存。
 */
class SettingsStore(context: Context) {
    private val store = context.applicationContext.settingsDataStore
    private val cipher = TokenCipher()

    private object Keys {
        val server = stringPreferencesKey("server")
        // 协议 2 的登录令牌和协议 1 的会话令牌不通用，换个键名，旧值自然作废
        val session = stringPreferencesKey("token_encrypted")
        val email = stringPreferencesKey("email")
        val deviceId = stringPreferencesKey("device_id")
        val lastHost = stringPreferencesKey("last_host")
        val lastHwnd = longPreferencesKey("last_hwnd")
        val keepScreenOn = booleanPreferencesKey("keep_screen_on")
        val haptics = booleanPreferencesKey("haptics")
        val showStats = booleanPreferencesKey("show_stats")
        val appLock = booleanPreferencesKey("app_lock")
        val backgroundApprovals = booleanPreferencesKey("background_approvals")
        val syncClipboard = booleanPreferencesKey("sync_clipboard")
        val collapsedGroups = stringSetPreferencesKey("collapsed_groups")
    }

    suspend fun load(): StoredData = withContext(Dispatchers.IO) {
        var p = store.data.first()
        if (p[Keys.deviceId].isNullOrEmpty()) {
            val id = UUID.randomUUID().toString().replace("-", "").take(24)
            store.edit { it[Keys.deviceId] = id }
            p = store.data.first()
        }
        val defaults = AppSettings()
        StoredData(
            server = p[Keys.server].orEmpty(),
            session = p[Keys.session]?.let(cipher::decrypt),
            email = p[Keys.email].orEmpty(),
            deviceId = p[Keys.deviceId].orEmpty(),
            lastHost = p[Keys.lastHost].orEmpty(),
            lastHwnd = p[Keys.lastHwnd] ?: 0L,
            settings = AppSettings(
                keepScreenOn = p[Keys.keepScreenOn] ?: defaults.keepScreenOn,
                haptics = p[Keys.haptics] ?: defaults.haptics,
                showStats = p[Keys.showStats] ?: defaults.showStats,
                appLock = p[Keys.appLock] ?: defaults.appLock,
                backgroundApprovals = p[Keys.backgroundApprovals] ?: defaults.backgroundApprovals,
                syncClipboard = p[Keys.syncClipboard] ?: defaults.syncClipboard,
            ),
            collapsedGroups = p[Keys.collapsedGroups].orEmpty(),
        )
    }

    suspend fun saveServer(server: String) = edit { it[Keys.server] = server }

    suspend fun saveSession(session: String?) {
        val encrypted = session?.let { withContext(Dispatchers.IO) { cipher.encrypt(it) } }
        edit { if (encrypted == null) it.remove(Keys.session) else it[Keys.session] = encrypted }
    }

    suspend fun saveEmail(email: String) = edit { it[Keys.email] = email }

    /** 记住上次看的电脑和窗口，回到前台、重启 App 后自动回去 */
    suspend fun saveLastView(host: String, hwnd: Long) = edit {
        it[Keys.lastHost] = host
        it[Keys.lastHwnd] = hwnd
    }

    suspend fun saveSettings(s: AppSettings) = edit {
        it[Keys.keepScreenOn] = s.keepScreenOn
        it[Keys.haptics] = s.haptics
        it[Keys.showStats] = s.showStats
        it[Keys.appLock] = s.appLock
        it[Keys.backgroundApprovals] = s.backgroundApprovals
        it[Keys.syncClipboard] = s.syncClipboard
    }

    /** "全部会话"里折叠起来的环境；环境删掉以后它的记录留着也没关系，超过 [MAX_COLLAPSED] 个就不再多记 */
    suspend fun saveCollapsedGroups(keys: Set<String>) = edit { it[Keys.collapsedGroups] = keys.take(MAX_COLLAPSED).toSet() }

    private suspend fun edit(block: (androidx.datastore.preferences.core.MutablePreferences) -> Unit) {
        withContext(Dispatchers.IO) { store.edit { block(it) } }
    }
}

private const val MAX_COLLAPSED = 500

/**
 * AES-GCM 加解密，密钥保存在 Android Keystore 里，不能导出。
 * 卸载重装或系统清掉密钥后旧密文解不开，此时当作没有登录过。
 */
private class TokenCipher {
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    fun encrypt(plain: String): String {
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    fun decrypt(encoded: String): String? = runCatching {
        val all = Base64.decode(encoded, Base64.NO_WRAP)
        val c = Cipher.getInstance(TRANSFORMATION)
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, all, 0, IV_LENGTH))
        String(c.doFinal(all, IV_LENGTH, all.size - IV_LENGTH), Charsets.UTF_8)
    }.getOrNull()

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "remoteclaude_session"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_LENGTH = 12
    }
}
