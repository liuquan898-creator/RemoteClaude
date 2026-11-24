package com.remoteclaude.android.ui

import android.os.SystemClock
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
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
import com.remoteclaude.android.AuthMode
import com.remoteclaude.android.BuildConfig
import com.remoteclaude.android.RemoteController
import kotlinx.coroutines.delay

/** 登录、注册、找回密码共用一个页面，按模式显示不同的输入项 */
@Composable
fun AuthScreen(state: AppState, controller: RemoteController) {
    // 存的地址变了（启动时读出来、在设置里换了服务器）就跟着变；旋转屏幕时保留正在填的
    var server by rememberSaveable(state.serverInput) { mutableStateOf(state.serverInput) }
    var email by rememberSaveable { mutableStateOf(state.email) }
    var code by rememberSaveable { mutableStateOf("") }
    // 密码只放在内存里，不进保存状态
    var password by remember { mutableStateOf("") }
    val mode = state.authMode
    val needsCode = mode != AuthMode.Login

    // 验证码倒计时：每秒刷新一次剩余秒数
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    LaunchedEffect(state.codeCooldownUntil) {
        while (true) {
            now = SystemClock.elapsedRealtime()
            if (now >= state.codeCooldownUntil) break
            delay(500)
        }
    }
    val cooldownLeft = ((state.codeCooldownUntil - now + 999) / 1000).coerceAtLeast(0)

    // 重置密码成功后切回登录页，清掉验证码和密码
    LaunchedEffect(mode) {
        code = ""
        password = ""
    }

    val submit: () -> Unit = {
        when (mode) {
            AuthMode.Login -> controller.login(server, email, password)
            AuthMode.Register -> controller.register(server, email, code, password)
            AuthMode.Forgot -> controller.resetPassword(server, email, code, password)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
            Text("RemoteClaude", fontSize = 26.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(4.dp))
            Text(
                when (mode) {
                    AuthMode.Login -> "登录后查看和操作电脑上的 Claude 会话窗口"
                    AuthMode.Register -> "用邮箱注册账号。电脑上的被控端和手机登录同一个账号，就能配对使用"
                    AuthMode.Forgot -> "用邮箱验证码重新设置密码，所有已登录的设备都会下线"
                },
                color = RcColors.Muted,
            )
            Spacer(Modifier.height(24.dp))

            // App 里不带服务器地址，一直显示地址框；填过的地址登录成功后存下来，下次自动填上
            OutlinedTextField(
                value = server,
                onValueChange = { server = it },
                label = { Text("服务器地址") },
                placeholder = { Text("rc.example.com") },
                supportingText = { Text("和电脑被控端填的是同一个服务器") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(4.dp))
            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                label = { Text("邮箱") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )

            if (needsCode) {
                Spacer(Modifier.height(12.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = code,
                        onValueChange = { v -> code = v.filter { it.isDigit() }.take(6) },
                        label = { Text("验证码") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Next),
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.size(8.dp))
                    OutlinedButton(
                        onClick = { controller.sendCode(server, email) },
                        enabled = cooldownLeft == 0L && !state.codeSending,
                        modifier = Modifier.height(56.dp).padding(top = 6.dp),
                    ) {
                        Text(
                            when {
                                state.codeSending -> "发送中…"
                                cooldownLeft > 0 -> "${cooldownLeft} 秒后重发"
                                else -> "发送验证码"
                            },
                        )
                    }
                }
            }

            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = {
                    Text(
                        when (mode) {
                            AuthMode.Login -> "密码"
                            AuthMode.Register -> "设置密码（至少 8 位）"
                            AuthMode.Forgot -> "新密码（至少 8 位）"
                        },
                    )
                },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                modifier = Modifier.fillMaxWidth(),
            )

            state.authError?.let {
                Spacer(Modifier.height(12.dp))
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            state.authInfo?.let {
                Spacer(Modifier.height(12.dp))
                Text(it, color = RcColors.Ok)
            }

            Spacer(Modifier.height(20.dp))
            Button(
                onClick = submit,
                enabled = !state.authBusy,
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) {
                if (state.authBusy) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                } else {
                    Text(
                        when (mode) {
                            AuthMode.Login -> "登录"
                            AuthMode.Register -> "注册并登录"
                            AuthMode.Forgot -> "重置密码"
                        },
                    )
                }
            }

            Spacer(Modifier.height(8.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                if (mode != AuthMode.Login) TextButton(onClick = { controller.setAuthMode(AuthMode.Login) }) { Text("去登录") }
                if (mode != AuthMode.Register) TextButton(onClick = { controller.setAuthMode(AuthMode.Register) }) { Text("注册账号") }
                if (mode != AuthMode.Forgot) TextButton(onClick = { controller.setAuthMode(AuthMode.Forgot) }) { Text("忘记密码") }
            }

            if (BuildConfig.ALLOW_CLEARTEXT) {
                Spacer(Modifier.height(12.dp))
                Text(
                    "调试版：模拟器连本机服务器填 ws://10.0.2.2:8787，局域网填 ws://电脑IP:8787",
                    color = RcColors.Muted,
                    fontSize = 12.sp,
                )
            }
        }
    }
}
