package com.remoteclaude.android.ui

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.remoteclaude.android.RemoteController
import com.remoteclaude.android.Screen

@Composable
fun AppRoot(controller: RemoteController, requestUnlock: () -> Unit) {
    val state by controller.state.collectAsStateWithLifecycle()
    val context = LocalContext.current

    LaunchedEffect(controller) {
        controller.messages.collect { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() }
    }

    Surface(color = RcColors.Bg, modifier = Modifier.fillMaxSize()) {
        when {
            state.locked -> LockScreen(onUnlock = requestUnlock)
            state.screen == Screen.Loading -> Box(Modifier.fillMaxSize())
            state.screen == Screen.Auth -> AuthScreen(state, controller)
            state.screen == Screen.Sessions -> SessionsScreen(state, controller)
            state.screen == Screen.Remote -> RemoteScreen(state, controller)
        }
    }
    // 审批面板在 App 锁着时不显示，解锁后再弹
    if (!state.locked && state.showApprovals) ApprovalsSheet(state, controller)
}

@Composable
private fun LockScreen(onUnlock: () -> Unit) {
    // 一显示就弹出验证框；用户取消后可以点按钮再来
    LaunchedEffect(Unit) { onUnlock() }
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Default.Lock, contentDescription = null, tint = RcColors.Muted, modifier = Modifier.size(48.dp))
        Spacer(Modifier.height(16.dp))
        Text("RemoteClaude 已锁定", fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(24.dp))
        Button(onClick = onUnlock) { Text("解锁") }
    }
}
