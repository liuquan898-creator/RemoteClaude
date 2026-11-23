package com.remoteclaude.android.input

import com.remoteclaude.android.protocol.InputEvents

/**
 * 调电脑上 Claude 的字体大小：给正在看的窗口按 Claude 自己的缩放快捷键。走的是现成的按键事件（协议文档 4.3），
 * 被控端不用改。用户的要求（2026-11-22）："手机上需要调大字体才能看得更清楚一点"。
 *
 * 快捷键是从 Claude 桌面端 6.28899 的程序包里读出来的：Ctrl+= 放大（菜单上写的是 Ctrl+加号，等号是它另外认的一个
 * 不显示的快捷键），Ctrl+- 缩小，Ctrl+0 还原。按一下变一档（约 10%），范围 25%～500%，
 * 电脑上所有 Claude 窗口一起变，不只是正在看的这一个。
 */
enum class FontZoom(val label: String, val key: String) {
    Smaller("缩小", "-"),
    Reset("默认", "0"),
    Larger("放大", "="),
    ;

    /** 三个都是按住 Ctrl */
    val mods: Int get() = InputEvents.MOD_CTRL
}
