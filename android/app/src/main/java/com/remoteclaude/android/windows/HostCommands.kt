package com.remoteclaude.android.windows

/**
 * 右上角菜单里"操作电脑"的几项：重排窗口、所有会话提到最前、暂停或恢复自动平铺、锁定或解锁电脑。
 * 连着画面时走数据通道（协议文档 4.6、4.7）；停在会话列表、没连画面时走信令通道（协议文档 2.9），
 * 要电脑上的被控端 0.9.6 或更新的版本。这里只管哪几项显示、能不能点、提示什么，不依赖 Android。
 */
object HostCommands {
    /** 电脑上的被控端从这个版本起认不连画面的命令 */
    const val MIN_HOST_VERSION = "0.9.6"

    /** 锁定那一项现在是什么 */
    enum class LockItem { Lock, Unlock }

    /**
     * @param tile 显示平铺的三项（重排、提到最前、暂停或恢复）
     * @param lock 电脑没锁时是"锁定电脑"，锁着时是"解锁电脑"
     * @param lockEnabled 锁定或解锁那一项能不能点
     */
    data class Menu(val tile: Boolean, val lock: LockItem, val lockEnabled: Boolean)

    /**
     * @param online 连着服务器，而且当前这台电脑在线
     * @param commands 电脑的被控端认不连画面的命令（收到过它的 host-state）
     * @param rtcConnected 画面连接是通的（数据通道能用）
     * @param tileAvailable 电脑上的窗口平铺在运行
     * @param unlockAvailable 电脑上装了解锁服务
     */
    fun menu(
        online: Boolean,
        commands: Boolean,
        rtcConnected: Boolean,
        tileAvailable: Boolean,
        pcLocked: Boolean,
        unlockAvailable: Boolean,
    ): Menu {
        val ready = online && (commands || rtcConnected)
        return Menu(
            tile = ready && tileAvailable,
            lock = if (pcLocked) LockItem.Unlock else LockItem.Lock,
            lockEnabled = ready && (!pcLocked || unlockAvailable),
        )
    }

    /**
     * 会话列表页要不要提示升级被控端。
     * @param tooOld 这次连上以后电脑回过窗口列表，却没推过 host-state：是旧版本。
     *   host-state 在控制端一连上时就推，总比窗口列表先到，所以回了列表还没有状态就不会再有了
     */
    fun needsUpgrade(online: Boolean, tooOld: Boolean): Boolean = online && tooOld

    /** 被控端是旧版本时的说明 */
    val UNSUPPORTED_TEXT =
        "不打开会话窗口就重排窗口、锁定和解锁电脑，要电脑上的被控端 $MIN_HOST_VERSION 或更新的版本。" +
            "可以让它现在升级，升级时被控端会重启，几十秒后自动重连。升级之前，这几项在打开某个会话窗口后的右上角菜单里。"

    /** 被控端是旧版本、又没连画面时点了命令的短提示 */
    const val UNSUPPORTED_TOAST = "电脑上的被控端版本太旧，升级到 $MIN_HOST_VERSION 以后才能在这里操作"

    /** 解锁回执对应的提示；[code] 为 null 表示没等到回执，[OK] 表示解开了 */
    fun unlockText(code: String?): String? = when (code) {
        null -> "电脑没有回应，电脑上的被控端可能需要更新"
        OK -> "电脑已解锁"
        "closed" -> "连接断开了，不知道电脑解锁了没有"
        // 被控端重启后换了密钥，手机手里的还是旧的；新的随后会推过来
        "bad-key", "replayed" -> "电脑上的被控端刚重启过，请再试一次"
        else -> null
    }

    const val OK = "ok"
}
