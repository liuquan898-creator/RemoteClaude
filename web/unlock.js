'use strict';
/**
 * 没连画面时解锁电脑（协议文档 2.9）：密码要经信令服务器转发，先用电脑被控端在 host-state 里给的公钥加密，
 * 服务器只转发密文。连着画面时密码走数据通道（本来就是端到端加密），用不到这里。
 *
 * RSA-OAEP，哈希和 MGF1 都用 SHA-256，标签为空，对应被控端 Node 的 `oaepHash: 'sha256'`（host/unlockkey.js）
 * 和安卓端的 protocol/UnlockCipher.kt。WebCrypto 的 RSA-OAEP 里 MGF1 用的就是 importKey 时给的哈希。
 *
 * window.RcUnlock.encrypt(keyBase64, password) 返回 Promise：
 *   { enc }                 密文的 Base64，放进 host-cmd 的 enc
 *   { code: 'too-long' }    密码太长，这把公钥装不下（3072 位最多 318 字节）
 *   { code: 'no-crypto' }   浏览器不让用 WebCrypto（页面不是 https 打开的）
 *   { code: 'failed' }      公钥不对，或者加密失败
 */
(() => {
  /** OAEP-SHA256 的开销：两个哈希值加两个字节 */
  const OAEP_OVERHEAD = 2 * 32 + 2;

  function fromBase64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function encrypt(keyBase64, password) {
    const subtle = window.crypto && window.crypto.subtle;
    if (!subtle) return { code: 'no-crypto' };
    const plain = new TextEncoder().encode(password);
    try {
      const key = await subtle.importKey('spki', fromBase64(keyBase64), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      const room = Math.ceil(key.algorithm.modulusLength / 8) - OAEP_OVERHEAD;
      if (plain.length > room) return { code: 'too-long' };
      const enc = await subtle.encrypt({ name: 'RSA-OAEP' }, key, plain);
      return { enc: toBase64(new Uint8Array(enc)) };
    } catch {
      return { code: 'failed' };
    } finally {
      plain.fill(0);
    }
  }

  window.RcUnlock = { encrypt };
})();
