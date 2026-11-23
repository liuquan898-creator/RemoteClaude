package com.remoteclaude.android.protocol

import java.security.KeyFactory
import java.security.interfaces.RSAPublicKey
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

/**
 * 没连画面时解锁电脑（协议文档 2.9）：密码要经信令服务器转发，先用电脑被控端给的公钥加密，
 * 服务器只转发密文。连着画面时密码走数据通道（本来就是端到端加密），用不到这里。
 *
 * RSA-OAEP，哈希和 MGF1 都用 SHA-256，对应被控端 Node 的 `oaepHash: 'sha256'`。
 * 安卓的 `OAEPWithSHA-256AndMGF1Padding` 默认 MGF1 用 SHA-1，和 Node 对不上，所以参数写明。
 * 这个文件不依赖 Android，可以直接做 JVM 单元测试。
 */
object UnlockCipher {
    sealed interface Result {
        /** [enc] 是密文的 Base64，放进 host-cmd 的 enc */
        data class Ok(val enc: String) : Result

        /** 密码太长，这把公钥装不下 */
        object TooLong : Result

        /** 公钥不对，或者加密失败 */
        object Failed : Result
    }

    private const val TRANSFORMATION = "RSA/ECB/OAEPPadding"
    private val OAEP = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT)

    /** OAEP-SHA256 的开销：两个哈希值加两个字节 */
    private const val OVERHEAD = 2 * 32 + 2

    /** [keyBase64] 是被控端在 host-state 里给的公钥（DER，SPKI） */
    fun encrypt(keyBase64: String, password: String): Result {
        val plain = password.toByteArray(Charsets.UTF_8)
        try {
            val der = Base64.getDecoder().decode(keyBase64)
            val key = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(der)) as? RSAPublicKey ?: return Result.Failed
            val room = (key.modulus.bitLength() + 7) / 8 - OVERHEAD
            if (plain.size > room) return Result.TooLong
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key, OAEP)
            return Result.Ok(Base64.getEncoder().encodeToString(cipher.doFinal(plain)))
        } catch (e: Exception) {
            return Result.Failed
        } finally {
            plain.fill(0)
        }
    }
}
