package com.remoteclaude.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import com.remoteclaude.android.approvals.ApprovalNotifier
import kotlinx.coroutines.launch
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.remoteclaude.android.ui.AppRoot
import com.remoteclaude.android.ui.RemoteClaudeTheme

/** 唯一的界面。继承 FragmentActivity 是为了用系统的指纹/锁屏密码验证框 */
class MainActivity : FragmentActivity() {
    private val controller: RemoteController
        get() = (application as RemoteClaudeApp).controller

    /** 安卓 13 起发通知要用户允许；拒了也不影响在 App 里审批 */
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        setContent {
            RemoteClaudeTheme {
                AppRoot(controller, requestUnlock = ::promptUnlock)
            }
        }
        handleIntent(intent)
        lifecycleScope.launch {
            controller.awaitLoaded()
            askNotificationPermission()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** 点审批通知打开 App 时，直接打开审批面板 */
    private fun handleIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(ApprovalNotifier.EXTRA_OPEN_APPROVALS, false) == true) {
            intent.removeExtra(ApprovalNotifier.EXTRA_OPEN_APPROVALS)
            controller.openApprovalsWhenReady()
        }
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (!controller.state.value.settings.backgroundApprovals) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** 拿到这台手机就等于能在电脑上执行命令，所以打开时先验证身份（可在设置里关掉） */
    private fun promptUnlock() {
        if (controller.authenticating) return
        if (!controller.deviceCanLock()) {
            controller.onUnlocked()
            return
        }
        controller.authenticating = true
        val prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    controller.onUnlocked()
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    controller.authenticating = false
                }
            },
        )
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle("解锁 RemoteClaude")
                .setSubtitle("验证指纹或锁屏密码")
                .setAllowedAuthenticators(BIOMETRIC_WEAK or DEVICE_CREDENTIAL)
                .build()
        )
    }
}
