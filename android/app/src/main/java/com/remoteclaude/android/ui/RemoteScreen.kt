package com.remoteclaude.android.ui

import android.content.ActivityNotFoundException
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.remoteclaude.android.AppState
import com.remoteclaude.android.Link
import com.remoteclaude.android.RemoteController
import com.remoteclaude.android.RtcPhase
import com.remoteclaude.android.UploadProgress
import com.remoteclaude.android.files.FileUploads
import com.remoteclaude.android.input.FontZoom
import com.remoteclaude.android.protocol.InputEvents
import com.remoteclaude.android.rtc.StreamStats
import com.remoteclaude.android.video.RemoteStageView
import java.util.Locale

/**
 * 按键栏先不显示（用户 2026-11-19："现在感觉没有太大的用处，先把那一条隐藏掉"）。代码都留着，改成 true 就回来。
 * 没有它时：回车是输入框空着点"发送"；换行在手机输入框里直接换；Esc、退格、方向键、Tab、全选、复制、撤销没有替代，
 * 只能在画面上点 Claude 自己的按钮（比如停止按钮）。见 docs/04"远程画面页"
 */
private const val SHOW_KEY_BAR = false

/**
 * 输入栏的"填入"（只填文字、不按回车）也先不显示（用户同日："感觉也没有什么太大的作用，也先去掉"）。
 * controller.sendText(text, pressEnter = false) 留着，改成 true 就回来
 */
private const val SHOW_FILL_BUTTON = false

/** 按键栏，事件见 docs/04-android-client.md 的按键栏表格 */
private data class KeySpec(val label: String, val key: String, val mods: Int = 0)

private val KEYS = listOf(
    KeySpec("Esc", "Escape"),
    KeySpec("回车", "Enter"),
    KeySpec("换行", "Enter", InputEvents.MOD_SHIFT),
    KeySpec("退格", "Backspace"),
    KeySpec("↑", "ArrowUp"),
    KeySpec("↓", "ArrowDown"),
    KeySpec("←", "ArrowLeft"),
    KeySpec("→", "ArrowRight"),
    KeySpec("Tab", "Tab"),
    KeySpec("Shift+Tab", "Tab", InputEvents.MOD_SHIFT),
    KeySpec("Del", "Delete"),
    KeySpec("全选", "a", InputEvents.MOD_CTRL),
    KeySpec("复制", "c", InputEvents.MOD_CTRL),
    KeySpec("粘贴", "v", InputEvents.MOD_CTRL),
    KeySpec("撤销", "z", InputEvents.MOD_CTRL),
)

/** AndroidView 里的画面控件，供"适应"按钮调用 */
private class StageHolder {
    var view: RemoteStageView? = null
}

@Composable
fun RemoteScreen(state: AppState, controller: RemoteController) {
    val stats by controller.stats.collectAsStateWithLifecycle()
    var toolsVisible by rememberSaveable { mutableStateOf(true) }
    var showSwitcher by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    // 调字体大小的那一条：从"更多"菜单里叫出来，点"完成"收起
    var showFontBar by rememberSaveable { mutableStateOf(false) }
    val hostDialogs = rememberHostDialogs()
    var showLeaveConfirm by remember { mutableStateOf(false) }
    var attachOpen by remember { mutableStateOf(false) }
    var text by rememberSaveable { mutableStateOf("") }
    val stage = remember { StageHolder() }
    val view = LocalView.current
    // 系统的照片选择器：不用申请相册权限，选完回到这里把图片发给电脑
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        controller.endPickImage(uri)
    }
    // 系统的文件选择器，任意类型（协议文档 4.8）：也不用申请存储权限
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        controller.endPickFile(uri)
    }
    // 文件存到电脑了、路径没能粘贴时，控制器把路径放进这个输入框
    LaunchedEffect(Unit) {
        controller.inputFill.collect { path -> text = if (text.isEmpty() || text.endsWith(" ")) text + path else "$text $path" }
    }
    // 正在发文件时离开画面会断开连接，文件就发不完了，先问一下
    val leave = {
        if (state.upload?.let { it.fileName != null && !it.pasting } == true) showLeaveConfirm = true else controller.leaveRemote()
    }

    BackHandler { leave() }

    DisposableEffect(state.settings.keepScreenOn) {
        view.keepScreenOn = state.settings.keepScreenOn
        onDispose { view.keepScreenOn = false }
    }

    Column(Modifier.fillMaxSize().background(RcColors.Bg).systemBarsPadding().imePadding()) {
        // ---------------------------------------------------------------- 顶栏
        Row(
            modifier = Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = leave) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回会话列表")
            }
            Row(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .clickable {
                        showSwitcher = true
                        controller.refreshWindows()
                    }
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StatusDot(statusColor(state))
                Spacer(Modifier.width(8.dp))
                Text(
                    state.current?.title ?: "选择会话",
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Icon(Icons.Default.ArrowDropDown, contentDescription = "切换会话", tint = RcColors.Muted)
            }
            TextButton(onClick = { stage.view?.resetZoom() }) { Text("适应") }
            TextButton(onClick = { toolsVisible = !toolsVisible }) { Text(if (toolsVisible) "收起" else "键盘") }
            Box {
                IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "更多") }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text(if (state.settings.showStats) "隐藏统计信息" else "显示统计信息") },
                        onClick = {
                            menuOpen = false
                            controller.updateSettings { it.copy(showStats = !it.showStats) }
                        },
                    )
                    // 只在画面页有：要对着正在看的窗口按快捷键，调完也要看着画面才知道合不合适
                    DropdownMenuItem(text = { Text("字体大小") }, onClick = {
                        menuOpen = false
                        showFontBar = true
                    })
                    // 重排窗口、提到最前、暂停平铺、锁定或解锁：和会话列表页的菜单是同一套（HostMenu.kt）
                    HostMenuItems(state, controller, hostDialogs, onPicked = { menuOpen = false })
                    DropdownMenuItem(text = { Text("设置") }, onClick = {
                        menuOpen = false
                        showSettings = true
                    })
                }
            }
        }

        if (state.pcLocked) LockBanner(state, onUnlock = controller::requestUnlock)
        ApprovalBanner(state, onOpen = controller::openApprovals)

        // ---------------------------------------------------------------- 画面区
        Box(Modifier.weight(1f).fillMaxWidth().background(RcColors.Stage)) {
            AndroidView(
                factory = { ctx ->
                    RemoteStageView(ctx).also { s ->
                        s.video.init(controller.rtc.eglBase.eglBaseContext)
                        s.listener = controller.stageListener
                        controller.attachRenderer(s.video)
                        stage.view = s
                    }
                },
                update = { s -> s.hapticsEnabled = state.settings.haptics },
                onRelease = { s ->
                    controller.detachRenderer(s.video)
                    s.video.release()
                    if (stage.view === s) stage.view = null
                },
                modifier = Modifier.fillMaxSize(),
            )
            stageHint(state)?.let {
                Text(
                    it,
                    color = RcColors.Muted,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.align(Alignment.Center).padding(24.dp),
                )
            }
            if (state.settings.showStats) {
                stats?.let { StatsOverlay(it, Modifier.align(Alignment.TopStart).padding(8.dp)) }
            }
        }

        state.upload?.let { UploadBar(it, onCancel = controller::cancelUpload) }
        // 放在画面下面而不是压在画面上：调的时候整个窗口都看得见。底部工具栏收起时也照常显示
        if (showFontBar) FontBar(onStep = controller::fontZoom, onClose = { showFontBar = false })

        // ---------------------------------------------------------------- 按键栏与输入栏
        if (toolsVisible) {
            if (SHOW_KEY_BAR) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    KEYS.forEach { k -> KeyButton(k.label) { controller.sendKey(k.key, k.mods) } }
                }
            }
            Row(
                // 按键栏不显示时，上边也留出和下边一样的空隙，输入栏不贴着画面
                modifier = Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = if (SHOW_KEY_BAR) 0.dp else 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Box {
                    IconButton(
                        onClick = { attachOpen = true },
                        enabled = state.upload == null,
                        modifier = Modifier.size(40.dp),
                    ) {
                        Icon(Icons.Default.Add, contentDescription = "发送图片或文件")
                    }
                    DropdownMenu(expanded = attachOpen, onDismissRequest = { attachOpen = false }) {
                        DropdownMenuItem(
                            text = { Text("图片") },
                            onClick = {
                                attachOpen = false
                                controller.beginPick()
                                try {
                                    pickImage.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                } catch (e: ActivityNotFoundException) {
                                    controller.endPickImage(null)
                                }
                            },
                        )
                        DropdownMenuItem(
                            text = {
                                Column {
                                    Text("文件")
                                    Text(
                                        "存到电脑上，把路径粘贴进输入框" + (state.fileMax?.let { "，最大 ${FileUploads.limitText(it)}" } ?: ""),
                                        fontSize = 12.sp,
                                        color = RcColors.Muted,
                                    )
                                }
                            },
                            onClick = {
                                attachOpen = false
                                if (controller.canSendFile()) {
                                    controller.beginPick()
                                    try {
                                        pickFile.launch(arrayOf("*/*"))
                                    } catch (e: ActivityNotFoundException) {
                                        controller.endPickFile(null)
                                    }
                                }
                            },
                        )
                    }
                }
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text("在这里打字，再发到远程窗口", fontSize = 14.sp) },
                    maxLines = 4,
                    modifier = Modifier.weight(1f),
                )
                if (SHOW_FILL_BUTTON) {
                    FilledTonalButton(
                        onClick = { if (text.isNotEmpty() && controller.sendText(text, pressEnter = false)) text = "" },
                    ) { Text("填入") }
                }
                Button(onClick = { if (controller.sendText(text, pressEnter = true)) text = "" }) { Text("发送") }
            }
        }
    }

    if (showSwitcher) {
        SwitcherSheet(
            state = state,
            onRefresh = controller::refreshWindows,
            onPick = { hwnd, title ->
                showSwitcher = false
                controller.select(hwnd, title)
            },
            onDismiss = { showSwitcher = false },
        )
    }
    if (showSettings) SettingsSheet(state, controller, onDismiss = { showSettings = false })
    HostDialogsHost(state, controller, hostDialogs)
    if (showLeaveConfirm) {
        AlertDialog(
            onDismissRequest = { showLeaveConfirm = false },
            title = { Text("文件还没发完") },
            text = { Text("离开画面会断开连接，这个文件就不发了。") },
            confirmButton = {
                TextButton(onClick = {
                    showLeaveConfirm = false
                    controller.cancelUpload()
                    controller.leaveRemote()
                }) { Text("不发了，离开") }
            },
            dismissButton = { TextButton(onClick = { showLeaveConfirm = false }) { Text("接着发") } },
        )
    }
}

/** 发图片、文件的进度：处理、传输、等电脑存好并粘贴。发文件时右边有"取消" */
@Composable
private fun UploadBar(u: UploadProgress, onCancel: () -> Unit) {
    val file = u.fileName
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            val percent = FileUploads.percent(u.sent, u.total)
            val label = when {
                file == null && u.pasting -> "图片已传到电脑，正在粘贴…"
                file == null && u.preparing -> "正在处理图片…"
                file == null -> "正在发送图片 $percent%（${FileUploads.sizeText(u.sent)} / ${FileUploads.sizeText(u.total)}）"
                u.pasting -> "「$file」已传到电脑，正在保存、粘贴路径…"
                u.preparing -> "正在读取文件…"
                else -> "正在发送「$file」$percent%（${FileUploads.sizeText(u.sent)} / ${FileUploads.sizeText(u.total)}）"
            }
            Text(label, fontSize = 13.sp, color = RcColors.Muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(4.dp))
            if (u.preparing || u.pasting) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
            } else {
                LinearProgressIndicator(progress = { percent / 100f }, modifier = Modifier.fillMaxWidth())
            }
        }
        if (file != null && !u.pasting) TextButton(onClick = onCancel) { Text("取消") }
    }
}

private fun stageHint(state: AppState): String? = when {
    state.link != Link.Online || !state.hostOnline -> connectionNotice(state)
    state.current == null -> "请选择要查看的会话"
    state.rtc == RtcPhase.Failed -> "画面连接失败，正在重试…"
    state.pcLocked && !state.hasVideo -> "电脑锁屏了，解锁后显示画面"
    state.rtc != RtcPhase.Connected || !state.hasVideo -> "正在连接画面…"
    else -> null
}

/**
 * 调电脑上 Claude 字体大小的一条（见 [FontZoom]）。按一下变一档，可以连着按，边按边看画面；
 * 不显示当前是百分之几：电脑不回报，手机只管按键
 */
@Composable
private fun FontBar(onStep: (FontZoom) -> Unit, onClose: () -> Unit) {
    Row(
        // 上下各留 6dp，和发文件的进度条一样：底部工具栏收起时这一条在最下面，不贴着屏幕边
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text("字体大小", fontSize = 14.sp, maxLines = 1)
            Text("所有窗口一起变", fontSize = 11.sp, color = RcColors.Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        FontZoom.entries.forEach { z -> KeyButton(z.label) { onStep(z) } }
        TextButton(onClick = onClose) { Text("完成") }
    }
}

@Composable
private fun KeyButton(label: String, onClick: () -> Unit) {
    // 普通的可点击控件在触屏模式下不抢焦点，点这些键时输入框保持焦点，软键盘不会收起
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(8.dp),
        color = RcColors.Card,
        border = BorderStroke(1.dp, RcColors.Line),
        modifier = Modifier.heightIn(min = 38.dp).widthIn(min = 46.dp),
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
            Text(label, fontSize = 14.sp)
        }
    }
}

@Composable
private fun StatsOverlay(s: StreamStats, modifier: Modifier = Modifier) {
    val path = when (s.relayed) {
        true -> "经中继"
        false -> "直连"
        null -> "—"
    }
    val types = listOfNotNull(s.localType, s.remoteType).joinToString("/")
    val lines = listOf(
        "${s.width}×${s.height} · ${String.format(Locale.US, "%.0f", s.fps)} fps · ${s.kbps} kbps",
        "延迟 ${s.rttMs?.let { "$it ms" } ?: "—"} · $path${if (types.isNotEmpty()) " ($types)" else ""}",
        "编码 ${s.codec ?: "—"}",
    )
    Column(
        modifier
            .background(Color(0xB3000000), RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 6.dp)
    ) {
        lines.forEach { Text(it, color = Color.White, fontSize = 11.sp, fontFamily = FontFamily.Monospace) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwitcherSheet(
    state: AppState,
    onRefresh: () -> Unit,
    onPick: (Long, String) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = RcColors.Bg) {
        Row(
            Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("切换会话", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            IconButton(onClick = onRefresh) { Icon(Icons.Default.Refresh, contentDescription = "刷新") }
        }
        if (state.windows.isEmpty()) {
            Text(
                connectionNotice(state) ?: "电脑上没有打开的 Claude 窗口",
                color = RcColors.Muted,
                modifier = Modifier.fillMaxWidth().padding(32.dp),
                textAlign = TextAlign.Center,
            )
        }
        LazyColumn(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
            items(state.windows, key = { it.hwnd }) { w ->
                val selected = state.current?.hwnd == w.hwnd
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onPick(w.hwnd, w.title) }
                        .background(if (selected) RcColors.Card else Color.Transparent)
                        .padding(horizontal = 20.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    WindowThumb(w, Modifier.size(width = 48.dp, height = 64.dp).clip(RoundedCornerShape(4.dp)))
                    Spacer(Modifier.width(12.dp))
                    Text(
                        w.title,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        color = if (selected) RcColors.Accent else RcColors.Text,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}
