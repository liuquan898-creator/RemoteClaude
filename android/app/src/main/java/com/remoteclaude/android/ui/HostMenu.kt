package com.remoteclaude.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.remoteclaude.android.AppState
import com.remoteclaude.android.Link
import com.remoteclaude.android.RemoteController
import com.remoteclaude.android.RtcPhase
import com.remoteclaude.android.windows.HostCommands

/**
 * 会话列表页和画面页右上角菜单里"操作电脑"的部分：重排窗口、所有会话提到最前、暂停或恢复自动平铺、
 * 锁定或解锁电脑，以及锁屏提示条、锁定确认、输入密码的对话框。两个页面共用，免得两边不一致。
 * 这几项和具体哪个窗口无关：连着画面时走数据通道，没连画面时走信令通道（协议文档 2.9）。
 */

/** 锁定确认、解锁对话框开没开；每个页面各有一份 */
@Stable
class HostDialogs {
    var lockConfirm by mutableStateOf(false)
    var unlock by mutableStateOf(false)
}

@Composable
fun rememberHostDialogs(): HostDialogs = remember { HostDialogs() }

/** 菜单里的这几项。放在 DropdownMenu 里用；[onPicked] 用来收起菜单 */
@Composable
fun HostMenuItems(state: AppState, controller: RemoteController, dialogs: HostDialogs, onPicked: () -> Unit) {
    val menu = HostCommands.menu(
        online = state.link == Link.Online && state.hostOnline,
        commands = state.hostCommands,
        rtcConnected = state.rtc == RtcPhase.Connected,
        tileAvailable = state.tileAvailable,
        pcLocked = state.pcLocked,
        unlockAvailable = state.unlockAvailable,
    )
    if (menu.tile) {
        DropdownMenuItem(text = { Text("重排窗口") }, onClick = {
            onPicked()
            controller.tile("arrange")
        })
        DropdownMenuItem(text = { Text("所有会话提到最前") }, onClick = {
            onPicked()
            controller.tile("raise")
        })
        DropdownMenuItem(
            text = { Text(if (state.tilePaused) "恢复自动平铺" else "暂停自动平铺") },
            onClick = {
                onPicked()
                controller.tile(if (state.tilePaused) "resume" else "pause")
            },
        )
    }
    when (menu.lock) {
        HostCommands.LockItem.Lock -> DropdownMenuItem(
            text = { Text("锁定电脑") },
            enabled = menu.lockEnabled,
            onClick = {
                onPicked()
                dialogs.lockConfirm = true
            },
        )
        HostCommands.LockItem.Unlock -> DropdownMenuItem(
            text = { Text(if (state.unlocking) "正在解锁电脑…" else "解锁电脑") },
            enabled = menu.lockEnabled && !state.unlocking,
            onClick = {
                onPicked()
                dialogs.unlock = true
            },
        )
    }
}

/** 锁定确认和输入密码的对话框，放在页面最外层 */
@Composable
fun HostDialogsHost(state: AppState, controller: RemoteController, dialogs: HostDialogs) {
    if (dialogs.unlock) {
        UnlockDialog(
            onUnlock = { password ->
                dialogs.unlock = false
                controller.unlockPc(password)
            },
            onDismiss = { dialogs.unlock = false },
        )
    }
    if (dialogs.lockConfirm) {
        AlertDialog(
            onDismissRequest = { dialogs.lockConfirm = false },
            title = { Text("锁定电脑？") },
            text = {
                Text(
                    if (state.unlockAvailable) "效果和在电脑上按 Win+L 一样。之后可以在这里输入 Windows 密码或 PIN 解锁。"
                    else "效果和在电脑上按 Win+L 一样。这台电脑没装解锁服务，锁定后只能回到电脑前解锁。",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    dialogs.lockConfirm = false
                    controller.lockPc()
                }) { Text("锁定") }
            },
            dismissButton = { TextButton(onClick = { dialogs.lockConfirm = false }) { Text("取消") } },
        )
    }
}

/** 电脑锁屏时显示在顶栏下面：能解锁时给出"解锁"按钮，否则说明原因 */
@Composable
fun LockBanner(state: AppState, onUnlock: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().background(RcColors.Card).padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("电脑已锁屏", fontWeight = FontWeight.SemiBold)
            Text(
                if (state.unlockAvailable) "解锁后才能操作" else "电脑上没装解锁服务，要回到电脑前解锁",
                color = RcColors.Muted,
                fontSize = 12.sp,
            )
        }
        if (state.unlockAvailable) {
            Button(onClick = onUnlock, enabled = !state.unlocking) { Text(if (state.unlocking) "解锁中…" else "解锁") }
        }
    }
}

/** 输入 Windows 密码或 PIN。密码只放在这个对话框的内存里，发出去就丢掉 */
@Composable
private fun UnlockDialog(onUnlock: (String) -> Unit, onDismiss: () -> Unit) {
    var password by remember { mutableStateOf("") }
    val submit = { if (password.isNotEmpty()) onUnlock(password) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("解锁电脑") },
        text = {
            Column {
                Text("输入这台电脑的 Windows 登录密码或 PIN。只用这一次，手机和电脑都不保存。", color = RcColors.Muted, fontSize = 13.sp)
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("密码或 PIN") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onDone = { submit() }),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = { TextButton(onClick = submit, enabled = password.isNotEmpty()) { Text("解锁") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}
