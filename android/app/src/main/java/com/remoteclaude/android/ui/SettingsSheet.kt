package com.remoteclaude.android.ui

import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.remoteclaude.android.AppState
import com.remoteclaude.android.BuildConfig
import com.remoteclaude.android.RemoteController
import com.remoteclaude.android.approvals.ApprovalNotifier
import com.remoteclaude.android.protocol.HostUpdateState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsSheet(state: AppState, controller: RemoteController, onDismiss: () -> Unit) {
    val s = state.settings
    var editServer by remember { mutableStateOf(false) }
    // 打开设置时问一次电脑被控端的版本和升级状态，之后状态有变化电脑会推过来
    LaunchedEffect(state.hostId, state.hostOnline) { if (state.hostOnline) controller.hostUpdate("status") }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = RcColors.Bg) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Text("设置", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(8.dp))

            SwitchRow("看画面时保持屏幕常亮", s.keepScreenOn) { v -> controller.updateSettings { it.copy(keepScreenOn = v) } }
            SwitchRow("长按时震动", s.haptics) { v -> controller.updateSettings { it.copy(haptics = v) } }
            SwitchRow("显示统计信息", s.showStats, note = "分辨率、帧率、码率、延迟，以及直连还是经中继") { v ->
                controller.updateSettings { it.copy(showStats = v) }
            }
            SwitchRow("同步电脑剪贴板", s.syncClipboard, note = "看画面时，电脑上新复制的文字自动放进手机剪贴板") { v ->
                controller.updateSettings { it.copy(syncClipboard = v) }
            }
            SwitchRow(
                "解锁时打开隐私屏",
                s.privacyOnUnlock,
                note = "从手机解锁电脑时，电脑的显示器先盖上黑幕、挡住电脑前的键盘鼠标，旁边的人看不到桌面；不再控制这台电脑时先锁屏再撤掉",
            ) { v -> controller.updateSettings { it.copy(privacyOnUnlock = v) } }
            SwitchRow(
                "打开时验证指纹或锁屏密码",
                s.appLock && state.canLock,
                enabled = state.canLock,
                note = if (state.canLock) "离开超过 30 秒再回来时也要验证" else "这台手机没有设置锁屏，无法启用",
            ) { v -> controller.updateSettings { it.copy(appLock = v) } }
            SwitchRow(
                "后台接收审批",
                s.backgroundApprovals,
                note = "App 不在前台时也保持连接，电脑上的 Claude 要审批或提问时发通知；系统要求通知栏常驻一条",
            ) { v -> controller.updateSettings { it.copy(backgroundApprovals = v) } }
            if (s.backgroundApprovals) {
                SoundRow()
                BatteryRow()
            }

            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = RcColors.Line)
            Text("账号：${state.email.ifEmpty { "未登录" }}", color = RcColors.Muted, fontSize = 13.sp)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "服务器：${state.serverInput.ifEmpty { "未设置" }}",
                    color = RcColors.Muted,
                    fontSize = 13.sp,
                    modifier = Modifier.weight(1f).padding(end = 12.dp),
                )
                TextButton(onClick = { editServer = true }) { Text("更换服务器") }
            }

            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = RcColors.Line)
            val progress = state.appUpdateProgress
            val newApp = state.appUpdate
            VersionRow(
                title = "App ${BuildConfig.VERSION_NAME}${if (BuildConfig.DEBUG) "（调试版）" else ""}",
                note = when {
                    progress != null -> "正在下载新版本 ${newApp?.versionName.orEmpty()}（$progress%）"
                    newApp != null -> "有新版本 ${newApp.versionName}" + if (newApp.notes.isNotBlank()) "：${newApp.notes}" else ""
                    else -> null
                },
                action = when {
                    progress != null -> null
                    newApp != null -> if (state.appUpdateReady) "安装" else "更新"
                    else -> "检查更新"
                },
                onAction = { if (newApp != null) controller.startAppUpdate() else controller.checkAppUpdate(manual = true) },
            )
            if (state.hostOnline) {
                val h = state.hostUpdate
                VersionRow(
                    title = "电脑被控端" + if (h != null && h.version.isNotEmpty()) " ${h.version}" else "",
                    note = hostUpdateNote(h),
                    action = when (h?.status) {
                        "ready" -> "立即升级"
                        "idle", "latest", "error" -> "检查更新"
                        else -> null
                    },
                    onAction = { controller.hostUpdate(if (h?.status == "ready") "install" else "check") },
                )
            }
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = {
                onDismiss()
                controller.logout()
            }) {
                Text("退出登录", color = MaterialTheme.colorScheme.error)
            }
        }
    }
    if (editServer) {
        ChangeServerDialog(
            current = state.serverInput,
            onChange = { input ->
                controller.changeServer(input).also { err -> if (err == null) onDismiss() }
            },
            onDismiss = { editServer = false },
        )
    }
}

/** 更换服务器：填新地址，确定后退出现在的账号、回到登录页（[RemoteController.changeServer]） */
@Composable
private fun ChangeServerDialog(current: String, onChange: (String) -> String?, onDismiss: () -> Unit) {
    var input by remember { mutableStateOf(current) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("更换服务器") },
        text = {
            Column {
                Text("换服务器会退出现在的账号，之后用新服务器上的账号重新登录。", color = RcColors.Muted, fontSize = 13.sp)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = input,
                    onValueChange = {
                        input = it
                        error = null
                    },
                    label = { Text("服务器地址") },
                    placeholder = { Text("rc.example.com") },
                    singleLine = true,
                    isError = error != null,
                    supportingText = error?.let { e -> { Text(e) } },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                error = onChange(input)
                if (error == null) onDismiss()
            }) { Text("更换并重新登录") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

/** 电脑被控端升级状态的说明（协议文档 2.6） */
private fun hostUpdateNote(h: HostUpdateState?): String = when (h?.status) {
    null -> "正在询问电脑…（被控端 0.7.0 以前的版本不会回答）"
    "dev" -> "从源码运行的开发版，不自动升级"
    "idle" -> "还没检查更新"
    "checking" -> "正在检查更新…"
    "latest" -> "已是最新"
    "downloading" -> "正在下载新版本 ${h.newVersion}（${h.percent}%）"
    "ready" -> "新版本 ${h.newVersion} 已下载，没人看画面时自动升级"
    "installing" -> "正在升级到 ${h.newVersion}，稍后自动重连"
    "error" -> "检查更新失败"
    else -> h.status
}

@Composable
private fun VersionRow(title: String, note: String?, action: String?, onAction: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(title)
            if (note != null) Text(note, color = RcColors.Muted, fontSize = 12.sp)
        }
        if (action != null) TextButton(onClick = onAction) { Text(action) }
    }
}

/** 没有"忽略电池优化"时，系统会在锁屏一段时间后断网、杀后台，审批就收不到了 */
@Composable
private fun BatteryRow() {
    val context = LocalContext.current
    val pm = context.getSystemService(PowerManager::class.java)
    if (pm.isIgnoringBatteryOptimizations(context.packageName)) return
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            "系统可能在锁屏后断开后台连接。国产手机还要在系统设置里允许自启动、不限制后台。",
            color = RcColors.Muted,
            fontSize = 12.sp,
            modifier = Modifier.weight(1f).padding(end = 8.dp),
        )
        TextButton(onClick = {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
            runCatching { context.startActivity(intent) }
        }) { Text("允许后台运行") }
    }
}

/** 审批通知的铃声交给系统设置：默认布谷鸟叫，换铃声、关声音都在那里 */
@Composable
private fun SoundRow() {
    val context = LocalContext.current
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text("通知铃声", color = RcColors.Text)
            Text("默认是布谷鸟叫；换铃声、关声音在手机的通知设置里", color = RcColors.Muted, fontSize = 12.sp)
        }
        TextButton(onClick = { ApprovalNotifier.openChannelSettings(context) }) { Text("去设置") }
    }
}

@Composable
private fun SwitchRow(
    title: String,
    checked: Boolean,
    enabled: Boolean = true,
    note: String? = null,
    onChange: (Boolean) -> Unit,
) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(title, color = if (enabled) RcColors.Text else RcColors.Muted)
            if (note != null) Text(note, color = RcColors.Muted, fontSize = 12.sp)
        }
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}
