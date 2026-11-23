package com.remoteclaude.android.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.os.Build
import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.remoteclaude.android.AppState
import com.remoteclaude.android.RemoteController
import com.remoteclaude.android.approvals.PendingApproval
import com.remoteclaude.android.protocol.Approval
import com.remoteclaude.android.protocol.ApprovalQuestion

/** 有审批在等时显示在会话列表和画面页顶部（docs/09 第 6 节），点开审批面板 */
@Composable
fun ApprovalBanner(state: AppState, onOpen: () -> Unit) {
    val n = state.approvals.size
    if (n == 0) return
    val first = state.approvals.first().item
    Surface(
        onClick = onOpen,
        color = RcColors.Card,
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, RcColors.Warn),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    if (n == 1) (if (first.isAsk) "Claude 在问你" else "Claude 要审批 ${first.tool}") else "有 $n 个审批等你处理",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(first.title, color = RcColors.Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text("处理", color = RcColors.Accent, fontSize = 14.sp, modifier = Modifier.padding(start = 12.dp))
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ApprovalsSheet(state: AppState, controller: RemoteController) {
    val manyHosts = state.approvals.map { it.hostId }.distinct().size > 1
    val now = System.currentTimeMillis()
    ModalBottomSheet(
        onDismissRequest = controller::closeApprovals,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = RcColors.Bg,
    ) {
        Text(
            "等你处理（${state.approvals.size}）",
            fontSize = 18.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        LazyColumn(Modifier.fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp)) {
            items(state.approvals, key = { it.item.id }) { a ->
                ApprovalCard(a, manyHosts, now, busy = a.item.id in state.answering, controller)
            }
        }
    }
}

@Composable
private fun ApprovalCard(a: PendingApproval, manyHosts: Boolean, now: Long, busy: Boolean, controller: RemoteController) {
    val item = a.item
    Surface(
        color = RcColors.Card,
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(
                (if (manyHosts) "${a.hostName} · " else "") + item.title,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            val sub = listOfNotNull(
                item.cwd.takeIf { it.isNotEmpty() },
                TimeText.ago(item.createdAt, now).takeIf { it.isNotEmpty() },
                item.agent.takeIf { it.isNotEmpty() }?.let { "子代理 $it" },
            ).joinToString(" · ")
            if (sub.isNotEmpty()) Text(sub, color = RcColors.Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(10.dp))
            if (item.isAsk) {
                AskBody(item, busy) { choice, answers -> controller.answerApproval(a.hostId, item.id, choice, "", answers) }
            } else {
                PermissionBody(item, busy) { choice, text -> controller.answerApproval(a.hostId, item.id, choice, text, null) }
            }
        }
    }
}

@Composable
private fun PermissionBody(item: Approval, busy: Boolean, onAnswer: (choice: String, text: String) -> Unit) {
    var denyNote by remember(item.id) { mutableStateOf<String?>(null) }
    Text(item.tool, color = RcColors.Accent, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    if (item.description.isNotEmpty()) Text(item.description, fontSize = 14.sp)
    for (p in item.params) ParamView(p.key, p.value)
    if (!item.complete) Text("有参数太长，手机上没有显示全", color = RcColors.Warn, fontSize = 12.sp)
    Spacer(Modifier.height(10.dp))
    if (busy) {
        Text("已提交，等电脑确认…", color = RcColors.Muted, fontSize = 13.sp)
        return
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = { onAnswer("allow", "") }) { Text("允许") }
        OutlinedButton(onClick = { onAnswer("deny", "") }) { Text("拒绝") }
        TextButton(onClick = { denyNote = "" }) { Text("拒绝并说明") }
    }
    denyNote?.let { note ->
        AlertDialog(
            onDismissRequest = { denyNote = null },
            title = { Text("拒绝并说明") },
            text = {
                OutlinedTextField(
                    value = note,
                    onValueChange = { denyNote = it },
                    placeholder = { Text("告诉 Claude 为什么拒绝、应该怎么做") },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    denyNote = null
                    onAnswer("deny", note.trim())
                }) { Text("拒绝") }
            },
            dismissButton = { TextButton(onClick = { denyNote = null }) { Text("取消") } },
        )
    }
}

@Composable
private fun ParamView(key: String, value: String) {
    var expanded by remember { mutableStateOf(false) }
    val long = value.length > 400 || value.count { it == '\n' } > 8
    val copy = rememberCopier()
    Column(Modifier.fillMaxWidth().padding(top = 6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(key, color = RcColors.Muted, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text("复制", color = RcColors.Accent, fontSize = 12.sp, modifier = Modifier.clickable { copy(value) }.padding(horizontal = 4.dp, vertical = 2.dp))
        }
        Surface(color = RcColors.Bg, shape = RoundedCornerShape(6.dp), modifier = Modifier.fillMaxWidth()) {
            SelectionContainer {
                Text(
                    value,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    maxLines = if (expanded || !long) Int.MAX_VALUE else 8,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(8.dp),
                )
            }
        }
        if (long) {
            Text(
                if (expanded) "收起" else "展开全部",
                color = RcColors.Accent,
                fontSize = 12.sp,
                modifier = Modifier.clickable { expanded = !expanded }.padding(vertical = 4.dp),
            )
        }
    }
}

/** 提问：每个问题选一个（或几个）选项，也可以自己填 */
@Composable
private fun AskBody(item: Approval, busy: Boolean, onAnswer: (choice: String, answers: Map<String, Any>?) -> Unit) {
    // 问题原文 -> 选中的选项；问题原文 -> 自己填的文字
    val picked = remember(item.id) { mutableStateMapOf<String, Set<String>>() }
    val custom = remember(item.id) { mutableStateMapOf<String, String>() }
    for (q in item.questions) {
        QuestionView(q, picked[q.question].orEmpty(), custom[q.question].orEmpty(), onPick = { picked[q.question] = it }, onCustom = { custom[q.question] = it })
        Spacer(Modifier.height(8.dp))
    }
    val answers: Map<String, Any>? = run {
        val out = LinkedHashMap<String, Any>()
        for (q in item.questions) {
            val sel = picked[q.question].orEmpty()
            val text = custom[q.question].orEmpty().trim()
            when {
                q.multiSelect && (sel.isNotEmpty() || text.isNotEmpty()) ->
                    out[q.question] = q.options.map { it.label }.filter { it in sel } + listOfNotNull(text.takeIf { it.isNotEmpty() })
                !q.multiSelect && text.isNotEmpty() -> out[q.question] = text
                !q.multiSelect && sel.isNotEmpty() -> out[q.question] = sel.first()
                else -> return@run null
            }
        }
        out
    }
    if (busy) {
        Text("已提交，等电脑确认…", color = RcColors.Muted, fontSize = 13.sp)
        return
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = { answers?.let { onAnswer("allow", it) } }, enabled = answers != null) { Text("提交") }
        TextButton(onClick = { onAnswer("deny", null) }) { Text("不回答") }
    }
}

@Composable
private fun QuestionView(
    q: ApprovalQuestion,
    picked: Set<String>,
    custom: String,
    onPick: (Set<String>) -> Unit,
    onCustom: (String) -> Unit,
) {
    if (q.header.isNotEmpty()) Text(q.header, color = RcColors.Accent, fontSize = 12.sp)
    TextWithCode(q.question)
    for (o in q.options) {
        val on = o.label in picked
        Row(
            Modifier
                .fillMaxWidth()
                .clickable {
                    onPick(if (q.multiSelect) (if (on) picked - o.label else picked + o.label) else setOf(o.label))
                    if (!q.multiSelect) onCustom("")
                }
                .heightIn(min = 40.dp)
                .padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (q.multiSelect) Checkbox(checked = on, onCheckedChange = null) else RadioButton(selected = on, onClick = null)
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(o.label, fontSize = 14.sp)
                if (o.description.isNotEmpty()) Text(o.description, color = RcColors.Muted, fontSize = 12.sp)
            }
        }
    }
    OutlinedTextField(
        value = custom,
        onValueChange = {
            onCustom(it)
            if (!q.multiSelect && it.isNotEmpty()) onPick(emptySet())
        },
        placeholder = { Text(if (q.multiSelect) "另外补充（可不填）" else "或者自己填") },
        singleLine = false,
        maxLines = 4,
        modifier = Modifier.fillMaxWidth(),
    )
}

/**
 * 问题原文：反引号括起来的命令单独显示成一块，带"复制"按钮（CodeSpans）。
 * 用户在手机上看到的是电脑画面，没法从画面上复制文字，所以要他运行的命令都从这里复制。
 */
@Composable
private fun TextWithCode(text: String) {
    val parts = remember(text) { CodeSpans.split(text) }
    val copy = rememberCopier()
    for (p in parts) {
        when (p) {
            is CodeSpans.Plain -> {
                val t = p.text.trim()
                if (t.isNotEmpty()) SelectionContainer { Text(t, fontSize = 14.sp, fontWeight = FontWeight.Medium) }
            }
            is CodeSpans.Code -> Surface(
                color = RcColors.Bg,
                shape = RoundedCornerShape(6.dp),
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SelectionContainer(Modifier.weight(1f)) {
                        Text(p.text, fontFamily = FontFamily.Monospace, fontSize = 13.sp, modifier = Modifier.padding(8.dp))
                    }
                    TextButton(onClick = { copy(p.text) }) { Text("复制") }
                }
            }
        }
    }
}

/** 复制到手机剪贴板；Android 13 起系统自己会提示，之前的版本弹个"已复制" */
@Composable
private fun rememberCopier(): (String) -> Unit {
    val context = LocalContext.current
    return remember(context) {
        { text: String ->
            val cm = context.getSystemService(ClipboardManager::class.java)
            cm?.setPrimaryClip(ClipData.newPlainText("RemoteClaude", text))
            if (Build.VERSION.SDK_INT < 33) Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
        }
    }
}
