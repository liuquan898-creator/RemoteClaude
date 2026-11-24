import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { Log, errText } from '../common/Log';

/** 加密结果：ok 时 enc 是密文的 Base64；tooLong 表示密码太长、这把公钥装不下 */
export interface UnlockCipherResult {
  ok: boolean;
  tooLong: boolean;
  enc: string;
}

/** OAEP-SHA256 的开销：两个哈希值加两个字节 */
const OVERHEAD = 2 * 32 + 2;

/**
 * 没连画面时解锁电脑（协议 2.9），对照安卓端 protocol/UnlockCipher.kt：密码要经信令服务器转发，
 * 先用电脑被控端给的公钥加密，服务器只转发密文。
 *
 * RSA-OAEP，哈希和 MGF1 都用 SHA-256（被控端 Node 的 oaepHash: 'sha256'）。
 */
export class UnlockCipher {
  /** keyBase64 是被控端在 host-state 里给的公钥（DER，SubjectPublicKeyInfo） */
  static encrypt(keyBase64: string, password: string): UnlockCipherResult {
    const plain = new util.TextEncoder().encodeInto(password);
    try {
      const der = new util.Base64Helper().decodeSync(keyBase64);
      // 被控端用 3072 位；算法名里的位数要和公钥一致，按常见的几种试
      for (const bits of [3072, 2048, 4096]) {
        let pub: cryptoFramework.PubKey;
        try {
          const gen = cryptoFramework.createAsyKeyGenerator(`RSA${bits}`);
          pub = gen.convertKeySync({ data: der }, null).pubKey;
        } catch (e) {
          continue;
        }
        const room = bits / 8 - OVERHEAD;
        if (plain.length > room) {
          return { ok: false, tooLong: true, enc: '' };
        }
        const cipher = cryptoFramework.createCipher(`RSA${bits}|PKCS1_OAEP|SHA256|MGF1_SHA256`);
        cipher.initSync(cryptoFramework.CryptoMode.ENCRYPT_MODE, pub, null);
        const out = cipher.doFinalSync({ data: plain });
        return { ok: true, tooLong: false, enc: new util.Base64Helper().encodeToStringSync(out.data) };
      }
      Log.w('解锁公钥的格式不认识');
      return { ok: false, tooLong: false, enc: '' };
    } catch (e) {
      Log.w(`加密解锁密码失败：${errText(e as Object)}`);
      return { ok: false, tooLong: false, enc: '' };
    } finally {
      plain.fill(0);
    }
  }
}
