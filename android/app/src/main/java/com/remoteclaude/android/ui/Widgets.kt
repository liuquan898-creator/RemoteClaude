package com.remoteclaude.android.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.remoteclaude.android.AppState
import com.remoteclaude.android.Link
import com.remoteclaude.android.RtcPhase
import com.remoteclaude.android.WindowItem

@Composable
fun StatusDot(color: Color, modifier: Modifier = Modifier) {
    Box(modifier.size(10.dp).background(color, CircleShape))
}

/** 绿：画面已连通；黄：正在连接；红：与服务器断开或被控端不在线 */
fun statusColor(state: AppState): Color = when {
    state.link == Link.Offline || (state.link == Link.Online && !state.hostOnline) -> RcColors.Bad
    state.link == Link.Online && state.rtc == RtcPhase.Connected && state.hasVideo -> RcColors.Ok
    else -> RcColors.Warn
}

/** 连接状态的文字说明；一切正常时返回 null */
fun connectionNotice(state: AppState): String? {
    val host = state.currentHost
    return when {
        state.link == Link.Connecting -> "正在连接服务器…"
        state.link == Link.Offline -> "与服务器的连接已断开"
        state.hosts.isEmpty() -> "这个账号还没有电脑登录。请在电脑上运行被控端，用同一个账号登录"
        host == null -> "请选择一台电脑"
        !host.online -> "电脑「${host.name}」不在线"
        else -> null
    }
}

@Composable
fun StatusBanner(state: AppState) {
    val text = connectionNotice(state) ?: return
    Row(
        modifier = Modifier.fillMaxWidth().background(RcColors.Card).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(statusColor(state))
        Text(text, color = RcColors.Muted, fontSize = 13.sp, modifier = Modifier.padding(start = 8.dp))
    }
}

@Composable
fun WindowThumb(item: WindowItem, modifier: Modifier = Modifier) {
    Box(modifier.background(Color.Black), contentAlignment = Alignment.Center) {
        if (item.thumb != null) {
            Image(
                bitmap = item.thumb,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize(),
            )
        } else if (!item.thumbLoading) {
            // 缩略图电脑还在截的时候先空着，不闪一下"无预览"
            Text(if (item.minimized) "已最小化" else "无预览", color = RcColors.Muted, fontSize = 12.sp)
        }
    }
}
