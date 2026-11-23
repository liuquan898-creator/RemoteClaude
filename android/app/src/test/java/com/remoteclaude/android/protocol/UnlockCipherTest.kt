package com.remoteclaude.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyFactory
import java.security.spec.MGF1ParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

/**
 * 没连画面时解锁用的密码加密（协议文档 2.9）。要和被控端 Node 的
 * `privateDecrypt({ padding: RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' })` 对得上，
 * 所以除了自己加密自己解，还解一条 Node 加密出来的密文；反过来，被控端的测试
 * （host/test/unlockkey.test.js）解一条这里加密出来的密文。
 */
class UnlockCipherTest {
    /** 只给测试用的一对 2048 位密钥，被控端的测试里是同一对 */
    private val publicKey =
        "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA06OTFwsZt/PuiCkqTmW2RMbZjV9lqax4x7j7rhubJLil2U8YUvzw8GOWrReJBTo6qV5MFmMWMwR3" +
            "2aF8fWwK1dnbekwM6XSDDpJppz6O/q7j5+Vj2iMI9NWzvsz34FPBgdz+u2Bory/De6vTZ6c5/uuFZbuToi8UIRlsQUBhxlYaM1NoxVWaexCwC6gL7Yd5" +
            "SmS2zGuR3mDgWjB6OgHnRw6gre4F8vHkrSW0exU4wJZHgmFXhfHzxI9xweh5DxbRElODCj/QWFvTIDEOlBioUHC/q5rfMy3bJx1cRhNSWGsIOg6b8uVR" +
            "yZw8tnk14w3ClhE5hu6yXnDXGowqZO2i3wIDAQAB"

    private val privateKey =
        "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDTo5MXCxm38+6IKSpOZbZExtmNX2WprHjHuPuuG5skuKXZTxhS/PDwY5atF4kFOjqpXkwW" +
            "YxYzBHfZoXx9bArV2dt6TAzpdIMOkmmnPo7+ruPn5WPaIwj01bO+zPfgU8GB3P67YGivL8N7q9Nnpzn+64Vlu5OiLxQhGWxBQGHGVhozU2jFVZp7ELAL" +
            "qAvth3lKZLbMa5HeYOBaMHo6AedHDqCt7gXy8eStJbR7FTjAlkeCYVeF8fPEj3HB6HkPFtESU4MKP9BYW9MgMQ6UGKhQcL+rmt8zLdsnHVxGE1JYawg6" +
            "Dpvy5VHJnDy2eTXjDcKWETmG7rJecNcajCpk7aLfAgMBAAECggEANnu0SKjfaJdgD2aFkSQnHaKRbA8khV80wrnQ9Pv/Xx839u8hRHAAeOoyZoIaEKHy" +
            "axqu/M5qbxzV281yVnmDepU4ps3APzNy78PqdhcpSdBtNIw9vfDqA9mmCdcLcxEszkk9vLAvkvX5XbOY22TWDdXFBDEbaxOym2jHkS7JXPziojV1CdwA" +
            "sJVcinoboGFinsDc5ASLvY4FVXqHQ0oSZOHSr0XivpnijJ7Ej6pjQAjrcf5HSb3N1o46KLHq5YSQlPkRwxiv1kmgBnpYwL0EG21RzuP8+7WkV07AjSKl" +
            "T8ItNkzMs3ZK7Is4ZZva18N+LcTaI4EuO3qVocGThWc+bQKBgQDva9DoWSxR7ijYxPObbHQz9e0AJoZ/seNKLmC/a83fSbVlTceTaojPOPNj5RAkcvnB" +
            "aEcaa9xKEj2QqGAfxoqro8/M/OFxy6vGQRGEhAJ8olQyh7tWIMgoakUMR/uQekTgZk8gcvNp++ivGqJB805QlZeWEb+bRhggM72FUC0lowKBgQDiS0SD" +
            "mqjuC/HzwmO2/EDzYCycJjfcgtjAM6iClTD2n87g+GZy80h/E6Chj30I6qedsMWqMQxgH09q/YGG4Xte0T8MIvvssBh+EH/w1O+nrdEXAOa8uDJGPX4C" +
            "aXzrgV7pnbcD/TuW/em9Gr1TVpTND865tE0KBUyJOWDaR5wJlQKBgQCfje9z2HGTzC6Gf4KFMpqiQiMGdaYulUMOnae2CcbyJjHv6Ay3rkisKJzzFqVS" +
            "VRkijjbMYdM1vcAvljYxFuQ1DH8gcepgJsY74gMll7/8hUWtQw1SkZgybtfDHnmEyCb8kNHsow6as9lWUF6PqvCm/Xo+9WcGuIi9dR25KTxdFwKBgF2f" +
            "WkdAc2eZFY8N+4c3Mf/+6DXqMe5PTDGorazo4IsIbuTwoCIquPGqQyjUXpyTyKka+4yAImiaS5cuLqqJGyuNUpJI3wV7jYaKeQRAdK5g4UKtIsktQ89/" +
            "nWSOFBqzOXtZvuAtorvDbTLJn06dYY69XX/DMqRUsOeND57/RXVJAoGBAOXAs5hbdx5BcgOHHTptjbxwSvlHjudSHQol3aqk2ECPKFQFy7QlqUG6QiM/" +
            "G4GB9U0ND+Ia0mmeqqja2M5llolBpotPtV4R/JdAN34NkcDmv83Ra5th5s+LrJZF0VE8/WnD9OT/n+dVxjEJcuPOVicXvy4eF4gwxNKOx733qLjF"

    /** 按被控端的做法解密：OAEP，哈希和 MGF1 都是 SHA-256 */
    private fun decrypt(enc: String): String {
        val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(privateKey)))
        val cipher = Cipher.getInstance("RSA/ECB/OAEPPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT))
        return String(cipher.doFinal(Base64.getDecoder().decode(enc)), Charsets.UTF_8)
    }

    private fun encrypt(password: String): String = (UnlockCipher.encrypt(publicKey, password) as UnlockCipher.Result.Ok).enc

    @Test
    fun encryptsSoThatTheHostCanDecrypt() {
        val password = "Pässwörd 密码 123!"
        val enc = encrypt(password)
        assertEquals(password, decrypt(enc))
        // 密文正好是密钥那么长（被控端按长度检查）
        assertEquals(256, Base64.getDecoder().decode(enc).size)
        // 每次加密结果都不同，被控端靠这个拒绝重放
        assertNotEquals(enc, encrypt(password))
    }

    @Test
    fun matchesNodeOaepSha256() {
        // 用 Node 加密出来的：crypto.publicEncrypt({ key, padding: RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, …)
        val fromNode =
            "njKO5n3p9KhVZnudhG0M2O+5NUInxvyUt405pzxf2IRSAxSNAvcnZcIps9ZZDTDI4wMTrhvSXPNLVYxSpm8hMp53YldmzgcJL6WDDpAUk/UKZLNYgLeAdCAx" +
                "uePj/faE3Ik1Sub45o3eLgnG+SZArvQASQUT4BRcXuZHIy1c29UFWoG/c6yTR9HEy/eDVYdo2XQG3CiJ4r6Um/OVARnHUsIIB1DOc/p1YAG0qd3RKtlL" +
                "yJ/taRfJbEFhNDohImj87vwMul3vCO9o0truNJ3CmjicOKd0jqlaN/YyNvVLiTYsyBWzisyffExyKdjSnA7Odtul+Gp0VmCrMvoYQ6ttjg=="
        assertEquals("Node 加密的 pässwörd 123", decrypt(fromNode))
    }

    @Test
    fun refusesPasswordsThatDoNotFit() {
        // 2048 位密钥：256 − 66 = 190 字节
        assertTrue(UnlockCipher.encrypt(publicKey, "a".repeat(190)) is UnlockCipher.Result.Ok)
        assertEquals(UnlockCipher.Result.TooLong, UnlockCipher.encrypt(publicKey, "a".repeat(191)))
        // 按 UTF-8 字节算，不是按字符算
        assertEquals(UnlockCipher.Result.TooLong, UnlockCipher.encrypt(publicKey, "密".repeat(64)))
    }

    @Test
    fun badKeysFail() {
        assertEquals(UnlockCipher.Result.Failed, UnlockCipher.encrypt("不是 Base64", "x"))
        assertEquals(UnlockCipher.Result.Failed, UnlockCipher.encrypt("AAAA", "x"))
        assertEquals(UnlockCipher.Result.Failed, UnlockCipher.encrypt("", "x"))
    }

    /** 生成 host/test/unlockkey.test.js 里那条"安卓端加密的密文"时用过；留着方便以后重新生成 */
    @Test
    fun printsFixtureForHostTest() {
        println("ANDROID_FIXTURE " + encrypt("安卓加密的 pässwörd 456"))
    }
}
