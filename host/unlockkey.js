'use strict';
/**
 * 不连画面时解锁用的密钥（协议文档 2.9）。
 *
 * 连着画面时，解锁密码走数据通道（DTLS 端到端加密，服务器看不到）。停在会话列表时没有数据通道，
 * 密码只能经信令服务器转发，所以先用这里的公钥加密：被控端每次启动生成一对 RSA 密钥，公钥随
 * host-state 发给控制端，私钥只在主进程的内存里。服务器只转发密文。
 *
 * 密文只认一次：录下来的密文重发会被拒绝（RSA-OAEP 每次加密结果都不同，正常的控制端不会发出重复的密文）。
 * 被控端重启后密钥换新，旧密文全部作废。
 */
const crypto = require('crypto');

/** OAEP-SHA256 下 3072 位密钥最多能加密 318 字节，够放 Windows 密码 */
const KEY_BITS = 3072;
/**
 * 最多记住这么多条用过的密文，满了就不再接受新的（重启被控端后恢复）。
 * 不能挤掉旧的腾地方：公钥是公开的，谁都能造出一堆能解开的密文，把录下来的那条挤出去再重放。
 * 解锁服务 15 分钟内只让失败 3 次，正常用远远到不了这个数
 */
const MAX_SEEN = 10000;

/**
 * @param {object} [opts]
 * @param {number} [opts.bits] 密钥位数
 * @param {string} [opts.privateKeyPem] 测试用：不生成，直接用这把私钥
 * @param {(msg: string) => void} [opts.log]
 */
function createUnlockKey({ bits = KEY_BITS, privateKeyPem = null, log = () => {} } = {}) {
  let privateKey = null;
  let publicKey = null;
  let keyBytes = 0;
  const seen = new Set();

  function use(key) {
    privateKey = key;
    keyBytes = Math.ceil(key.asymmetricKeyDetails.modulusLength / 8);
    publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
  }

  const ready = new Promise((resolve) => {
    if (privateKeyPem) {
      use(crypto.createPrivateKey(privateKeyPem));
      resolve();
      return;
    }
    crypto.generateKeyPair('rsa', { modulusLength: bits }, (err, _pub, priv) => {
      if (err) log('生成解锁用的密钥失败: ' + err.message);
      else use(priv);
      resolve();
    });
  });

  /**
   * 解开控制端发来的密文。成功返回 { password }；失败返回 { code }：
   * bad-key 解不开（多半是被控端重启过，控制端手里是旧公钥），replayed 这条密文已经用过，failed 用过的密文记满了。
   */
  function open(enc) {
    if (!privateKey || typeof enc !== 'string' || !enc || enc.length > 4096) return { code: 'bad-key' };
    const data = Buffer.from(enc, 'base64');
    // 长度必须正好等于密钥长度：少了前导零的密文数值相同、字节不同，会绕过下面的重放检查
    if (data.length !== keyBytes) return { code: 'bad-key' };
    const mark = crypto.createHash('sha256').update(data).digest('base64');
    if (seen.has(mark)) return { code: 'replayed' };
    if (seen.size >= MAX_SEEN) return { code: 'failed' };
    let plain;
    try {
      plain = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, data);
    } catch {
      return { code: 'bad-key' };
    }
    seen.add(mark);
    const password = plain.toString('utf8');
    plain.fill(0);
    return password ? { password } : { code: 'bad-key' };
  }

  return {
    /** 密钥生成好了（或生成失败）时完成 */
    ready,
    /** 公钥：DER（SPKI）的 Base64；还没生成好时为 null */
    get publicKey() {
      return publicKey;
    },
    open,
  };
}

module.exports = { createUnlockKey, KEY_BITS };
