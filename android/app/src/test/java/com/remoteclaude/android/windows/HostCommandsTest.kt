package com.remoteclaude.android.windows

import com.remoteclaude.android.windows.HostCommands.LockItem
import com.remoteclaude.android.windows.HostCommands.Menu
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HostCommandsTest {
    private fun menu(
        online: Boolean = true,
        commands: Boolean = true,
        rtcConnected: Boolean = false,
        tileAvailable: Boolean = true,
        pcLocked: Boolean = false,
        unlockAvailable: Boolean = true,
    ) = HostCommands.menu(online, commands, rtcConnected, tileAvailable, pcLocked, unlockAvailable)

    @Test
    fun listPageWithNewHostShowsEverythingWithoutAVideoConnection() {
        assertEquals(Menu(tile = true, lock = LockItem.Lock, lockEnabled = true), menu())
        // 平铺没在运行（比如旧的平铺插件还在跑）：只剩锁定
        assertEquals(Menu(tile = false, lock = LockItem.Lock, lockEnabled = true), menu(tileAvailable = false))
    }

    @Test
    fun oldHostOnlyWorksWhileWatching() {
        // 旧版被控端、没连画面：平铺状态不知道，锁定点不了
        assertEquals(Menu(tile = false, lock = LockItem.Lock, lockEnabled = false), menu(commands = false, tileAvailable = false))
        // 连着画面（数据通道）时和以前一样
        assertEquals(Menu(tile = true, lock = LockItem.Lock, lockEnabled = true), menu(commands = false, rtcConnected = true))
    }

    @Test
    fun offlineDisablesEverything() {
        assertEquals(Menu(tile = false, lock = LockItem.Lock, lockEnabled = false), menu(online = false))
        assertEquals(Menu(tile = false, lock = LockItem.Unlock, lockEnabled = false), menu(online = false, pcLocked = true))
    }

    @Test
    fun lockedPcOffersUnlockWhenTheServiceIsInstalled() {
        assertEquals(Menu(tile = true, lock = LockItem.Unlock, lockEnabled = true), menu(pcLocked = true))
        // 没装解锁服务：只能回到电脑前解锁，这一项点不了
        assertEquals(Menu(tile = true, lock = LockItem.Unlock, lockEnabled = false), menu(pcLocked = true, unlockAvailable = false))
    }

    @Test
    fun upgradeHintOnlyWhenTheHostAnsweredButNeverPushedItsState() {
        assertTrue(HostCommands.needsUpgrade(online = true, tooOld = true))
        // 还没回过窗口列表：可能只是 host-state 还在路上
        assertFalse(HostCommands.needsUpgrade(online = true, tooOld = false))
        assertFalse(HostCommands.needsUpgrade(online = false, tooOld = true))
    }

    @Test
    fun texts() {
        assertEquals("电脑已解锁", HostCommands.unlockText(HostCommands.OK))
        assertEquals("电脑没有回应，电脑上的被控端可能需要更新", HostCommands.unlockText(null))
        assertEquals("连接断开了，不知道电脑解锁了没有", HostCommands.unlockText("closed"))
        assertEquals("电脑上的被控端刚重启过，请再试一次", HostCommands.unlockText("bad-key"))
        assertEquals("电脑上的被控端刚重启过，请再试一次", HostCommands.unlockText("replayed"))
        // 其余的错误码（still-locked、rate-limited…）用和画面页一样的提示
        assertNull(HostCommands.unlockText("still-locked"))
        assertTrue(HostCommands.UNSUPPORTED_TEXT.contains(HostCommands.MIN_HOST_VERSION))
        assertTrue(HostCommands.UNSUPPORTED_TOAST.contains(HostCommands.MIN_HOST_VERSION))
    }
}
