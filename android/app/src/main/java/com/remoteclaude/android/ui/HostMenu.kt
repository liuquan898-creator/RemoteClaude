package com.remoteclaude.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
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
import com.remoteclaude.android.UnlockPrompt
import com.remoteclaude.android.windows.HostCommands

/**
 * 会话列表页和画面页右上角菜单里"操作电脑"的部分：重排窗口、所有会话提到最前、暂停或恢复自动平铺、
 * 锁定或解锁电脑，以及锁屏提示条、锁定确认、输入密码的对话框。两个页面共用，免得两边不一致。
 * 这几项和具体哪个窗口无关：连着画面时走数据通道，没连画面时走信令通道（协议文档 2.9）。
 */

/**
 * 锁定确认是为哪台电脑开的，没开时为 null；每个页面各有一份。换了电脑就关掉。
 * 解锁输入框由 RemoteController 管（[AppState.unlockPrompt]），它要绑定是哪台电脑
 */
@Stable
class HostDialogs {
    var lockConfirm by mutableStateOf<String?>(null)
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
                dialogs.lockConfirm = state.hostId
            },
        )
        HostCommands.LockItem.Unlock -> DropdownMenuItem(
            text = { Text(if (state.unlocking) "正在解锁电脑…" else "解锁电脑") },
            enabled = menu.lockEnabled && !state.unlocking,
            onClick = {
                onPicked()
                controller.requestUnlock()
            },
        )
    }
    // 电脑记着解锁密码时（协议文档 2.9"记住解锁密码"）可以让它忘掉，走信令通道的 host-cmd
    if (state.unlockSaved && state.hostCommands) {
        DropdownMenuItem(
            text = { Text("忘掉记下的解锁密码") },
            enabled = state.link == Link.Online && state.hostOnline,
            onClick = {
                onPicked()
                controller.forgetUnlockPassword()
            },
        )
    }
    // 隐私屏（docs/11 第 4.4 节）走信令通道的 host-cmd、要靠解锁服务：被控端 0.9.32 起才认（旧版回 bad-op），
    // 服务装了且核实过才显示；锁着时不显示，解锁那一下会按设置自动盖
    if (state.hostCommands && state.canRemember && state.unlockAvailable && !state.pcLocked) {
        DropdownMenuItem(
            text = { Text(if (state.pcPrivacy) "关闭隐私屏" else "打开隐私屏") },
            enabled = menu.lockEnabled,
            onClick = {
                onPicked()
                controller.setPrivacy(!state.pcPrivacy)
            },
        )
    }
}

/** 锁定确认和输入密码的对话框，放在页面最外层 */
@Composable
fun HostDialogsHost(state: AppState, controller: RemoteController, dialogs: HostDialogs) {
    state.unlockPrompt?.let { prompt ->
        UnlockDialog(
            prompt = prompt,
            onUnlock = { password, save -> controller.unlockPc(prompt.host, password, save) },
            onDismiss = controller::dismissUnlockPrompt,
        )
    }
    // 锁定确认是为原来那台开的：换了电脑就关掉（确认时还会再核对一次）
    LaunchedEffect(state.hostId) {
        if (dialogs.lockConfirm != null && dialogs.lockConfirm != state.hostId) dialogs.lockConfirm = null
    }
    dialogs.lockConfirm?.let { host ->
        val name = state.hosts.firstOrNull { it.id == host }?.name
        AlertDialog(
            onDismissRequest = { dialogs.lockConfirm = null },
            title = { Text("锁定${HostCommands.pcLabel(name)}？") },
            text = {
                Text(
                    when {
                        state.unlockAvailable -> "效果和在电脑上按 Win+L 一样。之后可以在这里输入 Windows 密码或 PIN 解锁。"
                        state.unlockUntrusted ->
                            "效果和在电脑上按 Win+L 一样。这台电脑上的解锁服务要重新安装（版本太旧或没通过核实），锁定后只能回到电脑前解锁。"
                        else -> "效果和在电脑上按 Win+L 一样。这台电脑没装解锁服务，锁定后只能回到电脑前解锁。"
                    },
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    dialogs.lockConfirm = null
                    controller.lockPc(host)
                }) { Text("锁定") }
            },
            dismissButton = { TextButton(onClick = { dialogs.lockConfirm = null }) { Text("取消") } },
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
            Text("${HostCommands.pcLabel(state.currentHost?.name)}已锁屏", fontWeight = FontWeight.SemiBold)
            Text(
                when {
                    state.unlockingSaved -> "正在用记下的密码解锁…"
                    state.unlockAvailable && state.unlockSaved -> "解锁后才能操作。记着密码，点解锁不用再输"
                    state.unlockAvailable -> "解锁后才能操作"
                    state.unlockUntrusted -> "电脑上的解锁服务要重新安装（版本太旧或没通过核实），现在要回到电脑前解锁"
                    else -> "电脑上没装解锁服务，要回到电脑前解锁"
                },
                color = RcColors.Muted,
                fontSize = 12.sp,
            )
        }
        if (state.unlockAvailable) {
            Button(onClick = onUnlock, enabled = !state.unlocking) { Text(if (state.unlocking) "解锁中…" else "解锁") }
        }
    }
}

/**
 * 输入 [prompt] 那台电脑的 Windows 密码或 PIN，标题写明是哪台，免得解错。密码只放在这个对话框的内存里，发出去就丢掉；
 * 勾着"记住密码"时由电脑加密后存到服务器上（协议文档 2.9"记住解锁密码"），手机不存。
 * 被控端太旧、不认记住密码时（[UnlockPrompt.canRemember] 为 false）不显示那个勾，也不带 save
 */
@Composable
private fun UnlockDialog(prompt: UnlockPrompt, onUnlock: (String, Boolean?) -> Unit, onDismiss: () -> Unit) {
    var password by remember(prompt) { mutableStateOf("") }
    var save by remember(prompt) { mutableStateOf(true) }
    val submit = { if (password.isNotEmpty()) onUnlock(password, if (prompt.canRemember) save else null) }
    val label = HostCommands.pcLabel(prompt.name)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("解锁${label}") },
        text = {
            Column {
                prompt.note?.let { note ->
                    Text(note, color = RcColors.Warn, fontSize = 13.sp)
                    Spacer(Modifier.height(8.dp))
                }
                Text(
                    "输入${label}的 Windows 登录密码或 PIN。" + if (prompt.canRemember) "" else "只用这一次，手机和电脑都不保存。",
                    color = RcColors.Muted,
                    fontSize = 13.sp,
                )
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
                if (prompt.canRemember) {
                    Spacer(Modifier.height(8.dp))
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .toggleable(value = save, role = Role.Checkbox, onValueChange = { save = it }),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = save, onCheckedChange = null)
                        Spacer(Modifier.width(8.dp))
                        Text("记住密码")
                    }
                    Text(
                        if (save) {
                            "解开以后由这台电脑加密，存在服务器上，只有这台电脑解得开。下次点解锁不用再输"
                        } else {
                            "只用这一次，不保存。电脑原来记下的也会删掉"
                        },
                        color = RcColors.Muted,
                        fontSize = 12.sp,
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = submit, enabled = password.isNotEmpty()) { Text("解锁") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}
