package com.remoteclaude.android.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** 配色与网页控制端（web/style.css）一致，深色为主，和 Claude 的深色界面搭配 */
object RcColors {
    val Bg = Color(0xFF17171B)
    val Stage = Color(0xFF0C0C0F)
    val Card = Color(0xFF222229)
    val Line = Color(0xFF34343E)
    val Text = Color(0xFFECECF1)
    val Muted = Color(0xFF9B9BA8)
    val Accent = Color(0xFFD97757)
    val AccentText = Color(0xFF1B1B1F)
    val Ok = Color(0xFF3FB950)
    val Warn = Color(0xFFD29922)
    val Bad = Color(0xFFF85149)
}

private val Scheme = darkColorScheme(
    primary = RcColors.Accent,
    onPrimary = RcColors.AccentText,
    secondaryContainer = RcColors.Card,
    onSecondaryContainer = RcColors.Text,
    background = RcColors.Bg,
    onBackground = RcColors.Text,
    surface = RcColors.Bg,
    onSurface = RcColors.Text,
    surfaceVariant = RcColors.Card,
    onSurfaceVariant = RcColors.Muted,
    surfaceContainerLowest = RcColors.Bg,
    surfaceContainerLow = RcColors.Bg,
    surfaceContainer = RcColors.Card,
    surfaceContainerHigh = RcColors.Card,
    surfaceContainerHighest = RcColors.Card,
    outline = RcColors.Line,
    outlineVariant = RcColors.Line,
    error = RcColors.Bad,
)

@Composable
fun RemoteClaudeTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Scheme, content = content)
}
