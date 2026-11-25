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
        // 要先盖隐私屏却没盖上，被控端没解锁：说清楚为什么、怎么办
        assertTrue(HostCommands.unlockText("privacy-failed").orEmpty().contains("隐私屏没盖上"))
        // 其余的错误码（still-locked、rate-limited…）用和画面页一样的提示
        assertNull(HostCommands.unlockText("still-locked"))
        assertTrue(HostCommands.UNSUPPORTED_TEXT.contains(HostCommands.MIN_HOST_VERSION))
        assertTrue(HostCommands.UNSUPPORTED_TOAST.contains(HostCommands.MIN_HOST_VERSION))
    }

    @Test
    fun savedPasswordResults() {
        // 记下的密码不对了、没有了：弹输入框，框里说明为什么要输
        assertEquals("记下的密码不对了（可能改过密码），已经删掉，请重新输入", HostCommands.unlockText("saved-wrong"))
        assertTrue(HostCommands.unlockText("no-saved").orEmpty().contains("请输入"))
        assertTrue(HostCommands.needsPassword("saved-wrong"))
        assertTrue(HostCommands.needsPassword("no-saved"))
        // 别的错误照常提示，不弹输入框（只试一次，记下的留着）
        for (code in listOf(null, HostCommands.OK, "still-locked", "rate-limited", "privacy-failed", "closed")) {
            assertFalse(code.toString(), HostCommands.needsPassword(code))
        }

        assertTrue(HostCommands.forgetText(HostCommands.OK).startsWith("已忘掉"))
        assertEquals("电脑没有回应", HostCommands.forgetText(null))
        assertTrue(HostCommands.forgetText("bad-op").contains("太旧"))
        assertTrue(HostCommands.forgetText("failed").contains("failed"))
    }

    @Test
    fun hostChangedTexts() {
        // 解锁框开着时换了电脑：和网页、鸿蒙端同一句
        assertEquals("选的电脑换了，解锁框已经关掉，密码没有发出去", HostCommands.PROMPT_CLOSED_TEXT)
        assertTrue(HostCommands.HOST_CHANGED_TEXT.contains("没有发出去"))
        // 框开着时那台电脑下线了、已经解开了：说清是哪台
        assertEquals("「办公室电脑」下线了，解锁框已经关掉，密码没有发出去", HostCommands.promptOfflineText("办公室电脑"))
        assertEquals("这台电脑已经解锁了，解锁框已经关掉", HostCommands.promptUnlockedText(null))
    }

    @Test
    fun pcLabelNamesTheComputer() {
        assertEquals("「办公室电脑」", HostCommands.pcLabel("办公室电脑"))
        assertEquals("「家里」", HostCommands.pcLabel("  家里 "))
        // 不知道名字
        assertEquals("这台电脑", HostCommands.pcLabel(null))
        assertEquals("这台电脑", HostCommands.pcLabel(""))
        assertEquals("这台电脑", HostCommands.pcLabel("   "))
    }
}
