package com.remoteclaude.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.remoteclaude.android.AppState
import com.remoteclaude.android.CatalogPhase
import com.remoteclaude.android.Link
import com.remoteclaude.android.ListTab
import com.remoteclaude.android.RemoteController
import com.remoteclaude.android.WindowItem
import com.remoteclaude.android.protocol.HostInfo
import com.remoteclaude.android.protocol.SessionEntry
import com.remoteclaude.android.protocol.SessionGroup
import com.remoteclaude.android.windows.HostCommands
import com.remoteclaude.android.windows.WindowClose

/** 每组先显示这么多个会话，其余的点"显示全部"再展开 */
private const val SHOW_FIRST = 5

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(state: AppState, controller: RemoteController) {
    var showSettings by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var showHostUpgrade by remember { mutableStateOf(false) }
    val hostDialogs = rememberHostDialogs()
    var confirmNew by remember { mutableStateOf<SessionGroup?>(null) }

    // 进入页面时拉一次列表（未连上服务器时会在连上后自动拉）
    LaunchedEffect(Unit) {
        controller.refreshWindows()
        if (state.listTab == ListTab.All) controller.refreshCatalog()
    }
    val refresh = { if (state.listTab == ListTab.All) controller.refreshCatalog() else controller.refreshWindows() }

    Column(Modifier.fillMaxSize().systemBarsPadding()) {
        Row(
            modifier = Modifier.fillMaxWidth().height(56.dp).padding(start = 16.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                state.currentHost?.name ?: "选择会话",
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = refresh) { Icon(Icons.Default.Refresh, contentDescription = "刷新") }
            // 和画面页右上角是同一套菜单（少一项"显示统计信息"，那个只对正在看的画面有意义）：
            // 不用先点开某个窗口，就能重排窗口、把会话提到最前、暂停平铺、锁定和解锁电脑
            Box {
                IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "更多") }
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    HostMenuItems(state, controller, hostDialogs, onPicked = { menuOpen = false })
                    if (HostCommands.needsUpgrade(state.link == Link.Online && state.hostOnline, state.hostTooOld)) {
                        DropdownMenuItem(
                            text = {
                                Column {
                                    Text("重排窗口、锁定电脑…")
                                    Text("要先升级电脑上的被控端", fontSize = 12.sp, color = RcColors.Muted)
                                }
                            },
                            onClick = {
                                menuOpen = false
                                showHostUpgrade = true
                            },
                        )
                    }
                    DropdownMenuItem(text = { Text("设置") }, onClick = {
                        menuOpen = false
                        showSettings = true
                    })
                }
            }
        }

        // 账号下有多台电脑，或者当前这台不在线时，显示电脑切换栏
        if (state.hosts.size > 1 || (state.hosts.isNotEmpty() && !state.hostOnline)) {
            HostBar(state.hosts, state.hostId, onPick = controller::selectHost)
        }
        StatusBanner(state)
        if (state.pcLocked) LockBanner(state, onUnlock = controller::requestUnlock)
        ApprovalBanner(state, onOpen = controller::openApprovals)
        UpdateBanner(state, onUpdate = controller::startAppUpdate)

        PrimaryTabRow(selectedTabIndex = state.listTab.ordinal, containerColor = RcColors.Bg) {
            Tab(
                selected = state.listTab == ListTab.Open,
                onClick = { controller.setListTab(ListTab.Open) },
                text = { Text(if (state.windows.isEmpty()) "已打开" else "已打开 ${state.windows.size}") },
                selectedContentColor = RcColors.Accent,
                unselectedContentColor = RcColors.Muted,
            )
            Tab(
                selected = state.listTab == ListTab.All,
                onClick = { controller.setListTab(ListTab.All) },
                text = { Text("全部会话") },
                selectedContentColor = RcColors.Accent,
                unselectedContentColor = RcColors.Muted,
            )
        }

        when (state.listTab) {
            ListTab.Open -> PullToRefreshBox(
                isRefreshing = state.refreshing,
                onRefresh = controller::refreshWindows,
                modifier = Modifier.weight(1f).fillMaxWidth(),
            ) {
                if (state.windows.isEmpty()) {
                    EmptyList(emptyText(state))
                } else {
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(150.dp),
                        contentPadding = PaddingValues(12.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(state.windows, key = { it.hwnd }) { w ->
                            WindowCard(
                                w,
                                closing = w.hwnd in state.closingWindows,
                                onClick = { controller.select(w.hwnd, w.title) },
                                onClose = { controller.closeWindow(w) },
                            )
                        }
                    }
                }
            }
            ListTab.All -> PullToRefreshBox(
                isRefreshing = state.catalogRefreshing,
                onRefresh = controller::refreshCatalog,
                modifier = Modifier.weight(1f).fillMaxWidth(),
            ) {
                val notice = catalogEmptyText(state)
                if (notice != null) {
                    EmptyList(notice)
                } else {
                    CatalogList(
                        groups = state.catalog,
                        collapsed = state.collapsedGroups,
                        onToggle = controller::toggleGroup,
                        onOpen = controller::openSession,
                        onNew = { confirmNew = it },
                    )
                }
            }
        }
    }

    if (showSettings) SettingsSheet(state, controller, onDismiss = { showSettings = false })
    HostDialogsHost(state, controller, hostDialogs)

    if (showHostUpgrade) {
        AlertDialog(
            onDismissRequest = { showHostUpgrade = false },
            title = { Text("电脑上的被控端版本太旧") },
            text = { Text(HostCommands.UNSUPPORTED_TEXT) },
            confirmButton = {
                TextButton(onClick = {
                    showHostUpgrade = false
                    controller.hostUpdate("install")
                }) { Text("升级被控端") }
            },
            dismissButton = { TextButton(onClick = { showHostUpgrade = false }) { Text("以后再说") } },
        )
    }

    confirmNew?.let { group ->
        AlertDialog(
            onDismissRequest = { confirmNew = null },
            title = { Text("在「${group.name}」新建会话？") },
            text = { Text("电脑上会开一个新的会话窗口并选好这个环境，你在画面里输入第一句话就开始了。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmNew = null
                    controller.newSession(group)
                }) { Text("新建") }
            },
            dismissButton = { TextButton(onClick = { confirmNew = null }) { Text("取消") } },
        )
    }

    if (state.closeUnsupported) {
        AlertDialog(
            onDismissRequest = controller::dismissCloseUnsupported,
            title = { Text("电脑上的被控端版本太旧") },
            text = { Text(WindowClose.UNSUPPORTED_TEXT) },
            confirmButton = {
                TextButton(onClick = {
                    controller.dismissCloseUnsupported()
                    controller.hostUpdate("install")
                }) { Text("升级被控端") }
            },
            dismissButton = { TextButton(onClick = controller::dismissCloseUnsupported) { Text("以后再说") } },
        )
    }

    state.opening?.let { opening ->
        AlertDialog(
            onDismissRequest = {},
            title = null,
            text = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.5.dp)
                    Spacer(Modifier.width(16.dp))
                    Text(opening.label)
                }
            },
            confirmButton = { TextButton(onClick = controller::cancelOpening) { Text("不等了") } },
        )
    }
}

/** 服务器上有新的 App 安装包时提示（docs/08）；点"更新"下载后交给系统安装 */
@Composable
private fun UpdateBanner(state: AppState, onUpdate: () -> Unit) {
    val info = state.appUpdate ?: return
    val progress = state.appUpdateProgress
    Surface(
        color = RcColors.Card,
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, RcColors.Accent),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Row(Modifier.padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("有新版本 ${info.versionName}", fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                if (info.notes.isNotBlank()) {
                    Text(info.notes, color = RcColors.Muted, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            if (progress != null) {
                Text("下载中 $progress%", color = RcColors.Muted, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 12.dp))
            } else {
                TextButton(onClick = onUpdate) { Text(if (state.appUpdateReady) "安装" else "更新") }
            }
        }
    }
}

@Composable
private fun EmptyList(text: String) {
    // 空状态也要能下拉，所以放在可滚动的列表里
    LazyColumn(Modifier.fillMaxSize()) {
        item {
            Box(Modifier.fillParentMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                Text(text, color = RcColors.Muted, textAlign = TextAlign.Center)
            }
        }
    }
}

@Composable
private fun CatalogList(
    groups: List<SessionGroup>,
    collapsed: Set<String>,
    onToggle: (String) -> Unit,
    onOpen: (SessionEntry) -> Unit,
    onNew: (SessionGroup) -> Unit,
) {
    val expanded = remember { mutableStateMapOf<String, Boolean>() }
    val now = System.currentTimeMillis()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
        groups.forEach { g ->
            val folded = g.key in collapsed
            item(key = "h:" + g.key) { GroupHeader(g, folded, onToggle = { onToggle(g.key) }, onNew = onNew) }
            // 折叠起来的环境只留这一行
            if (folded) return@forEach
            val showAll = expanded[g.key] == true
            val shown = if (showAll) g.sessions else g.sessions.take(SHOW_FIRST)
            items(shown, key = { "s:" + it.id }) { s -> SessionRow(s, now, onClick = { onOpen(s) }) }
            when {
                g.sessions.isEmpty() -> item(key = "e:" + g.key) {
                    Text("还没有会话", color = RcColors.Muted, fontSize = 13.sp, modifier = Modifier.padding(start = 16.dp, top = 2.dp, bottom = 8.dp))
                }
                g.sessions.size > SHOW_FIRST -> item(key = "m:" + g.key) {
                    Text(
                        if (showAll) "收起" else "显示全部 ${g.sessions.size} 个",
                        color = RcColors.Accent,
                        fontSize = 13.sp,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { expanded[g.key] = !showAll }
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                    )
                }
            }
        }
    }
}

/**
 * 一个环境（或一个工作目录）的标题行。名字用强调色，和下面白色的会话标题分开；
 * 点这一行折叠或展开它下面的会话，折叠的状态记在本机
 */
@Composable
private fun GroupHeader(group: SessionGroup, folded: Boolean, onToggle: () -> Unit, onNew: (SessionGroup) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(top = 6.dp)
            .clickable(onClickLabel = if (folded) "展开" else "折叠", onClick = onToggle)
            .heightIn(min = 48.dp)
            .padding(start = 8.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (folded) Icons.AutoMirrored.Filled.KeyboardArrowRight else Icons.Default.KeyboardArrowDown,
            contentDescription = if (folded) "已折叠" else "已展开",
            tint = RcColors.Muted,
            modifier = Modifier.size(22.dp),
        )
        Spacer(Modifier.width(4.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    group.name,
                    color = RcColors.Accent,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                // 折叠着也能看出里面有几个会话
                if (group.sessions.isNotEmpty()) {
                    Spacer(Modifier.width(8.dp))
                    Text("${group.sessions.size}", color = RcColors.Muted, fontSize = 13.sp)
                }
            }
            if (group.folder.isNotEmpty() && group.folder != group.name) {
                Text(group.folder, color = RcColors.Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        // 只有保存过的环境能新建；按目录分出来的组没有对应的环境
        if (group.env != null) {
            TextButton(onClick = { onNew(group) }) {
                Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(4.dp))
                Text("新建")
            }
        }
    }
}

@Composable
private fun SessionRow(s: SessionEntry, now: Long, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(8.dp),
        color = RcColors.Card,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 3.dp),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(s.title.ifEmpty { "（未命名会话）" }, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val ago = TimeText.ago(s.at, now)
                if (ago.isNotEmpty()) Text(ago, color = RcColors.Muted, fontSize = 12.sp)
            }
            if (s.open) {
                Spacer(Modifier.width(8.dp))
                Surface(shape = RoundedCornerShape(10.dp), color = RcColors.Bg, border = BorderStroke(1.dp, RcColors.Ok)) {
                    Text("已打开", color = RcColors.Ok, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp))
                }
            }
        }
    }
}

@Composable
private fun HostBar(hosts: List<HostInfo>, currentId: String?, onPick: (String) -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        hosts.forEach { h ->
            val selected = h.id == currentId
            Surface(
                onClick = { onPick(h.id) },
                shape = RoundedCornerShape(18.dp),
                color = if (selected) RcColors.Card else RcColors.Bg,
                border = BorderStroke(1.dp, if (selected) RcColors.Accent else RcColors.Line),
            ) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(if (h.online) RcColors.Ok else RcColors.Muted)
                    Spacer(Modifier.width(6.dp))
                    Text(
                        if (h.online) h.name else "${h.name}（离线）",
                        color = if (h.online) RcColors.Text else RcColors.Muted,
                        fontSize = 14.sp,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

/** 电脑没连上时两个页签共用的提示；连上了返回 null */
private fun hostNotice(state: AppState): String? = when {
    state.link != Link.Online -> "正在连接服务器…"
    state.hosts.isEmpty() -> "这个账号还没有电脑登录\n请在电脑上运行被控端，用同一个账号登录"
    state.currentHost == null -> "请在上面选一台电脑"
    !state.hostOnline -> "这台电脑不在线\n请确认电脑已开机、被控端在运行"
    else -> null
}

private fun emptyText(state: AppState): String = hostNotice(state) ?: when {
    !state.windowsLoaded -> "正在获取窗口列表…"
    else -> "电脑上没有打开的 Claude 窗口\n可以到「全部会话」里打开一个"
}

private fun catalogEmptyText(state: AppState): String? = hostNotice(state) ?: when (state.catalogPhase) {
    CatalogPhase.None -> "正在获取会话列表…"
    CatalogPhase.NoReply -> "电脑没有回应\n被控端可能是旧版本，更新到 0.6.0 以后才能浏览会话"
    CatalogPhase.Unavailable -> "电脑上没找到 Claude 桌面端的会话记录"
    CatalogPhase.Loaded -> if (state.catalog.isEmpty()) "Claude 桌面端里还没有会话" else null
}

@Composable
private fun WindowCard(item: WindowItem, closing: Boolean, onClick: () -> Unit, onClose: () -> Unit) {
    Surface(
        onClick = onClick,
        enabled = !closing,
        shape = RoundedCornerShape(10.dp),
        color = RcColors.Card,
        border = BorderStroke(1.dp, RcColors.Line),
        modifier = Modifier.alpha(if (closing) 0.6f else 1f),
    ) {
        Column(Modifier.padding(8.dp)) {
            Box {
                WindowThumb(item, Modifier.fillMaxWidth().height(170.dp).clip(RoundedCornerShape(6.dp)))
                // 关闭按钮压在缩略图右上角（多半是缩略图两边的黑边），不挡标题。Claude 主窗口不能关，没有按钮
                if (item.closable != false) {
                    CloseButton(item.title, closing, onClose, Modifier.align(Alignment.TopEnd))
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(item.title, maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
        }
    }
}

/** 卡片右上角的关闭按钮：触摸区 44dp，看得见的是 28dp 的深色圆；关的时候换成转圈 */
@Composable
private fun CloseButton(title: String, closing: Boolean, onClose: () -> Unit, modifier: Modifier = Modifier) {
    IconButton(onClick = onClose, enabled = !closing, modifier = modifier.size(44.dp)) {
        Surface(
            shape = CircleShape,
            color = Color(0xCC1E1E1E),
            border = BorderStroke(1.dp, Color(0x66FFFFFF)),
            modifier = Modifier.size(28.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                if (closing) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = Color.White)
                } else {
                    Icon(Icons.Default.Close, contentDescription = "关闭「$title」", tint = Color.White, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}
