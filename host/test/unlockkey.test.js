'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createUnlockKey, KEY_BITS } = require('../unlockkey');

/** 按控制端的做法加密：RSA-OAEP，哈希和 MGF1 都是 SHA-256 */
function seal(publicKeyB64, text) {
  const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(text, 'utf8')).toString('base64');
}

/** 只给测试用的一对 2048 位密钥，安卓端的测试（UnlockCipherTest.kt）里是同一对 */
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDTo5MXCxm38+6IKSpOZbZExtmNX2WprHjHuPuuG5skuKXZTxhS/PDwY5atF4kFOjqpXkwW
YxYzBHfZoXx9bArV2dt6TAzpdIMOkmmnPo7+ruPn5WPaIwj01bO+zPfgU8GB3P67YGivL8N7q9Nnpzn+64Vlu5OiLxQhGWxBQGHGVhozU2jFVZp7ELAL
qAvth3lKZLbMa5HeYOBaMHo6AedHDqCt7gXy8eStJbR7FTjAlkeCYVeF8fPEj3HB6HkPFtESU4MKP9BYW9MgMQ6UGKhQcL+rmt8zLdsnHVxGE1JYawg6
Dpvy5VHJnDy2eTXjDcKWETmG7rJecNcajCpk7aLfAgMBAAECggEANnu0SKjfaJdgD2aFkSQnHaKRbA8khV80wrnQ9Pv/Xx839u8hRHAAeOoyZoIaEKHy
axqu/M5qbxzV281yVnmDepU4ps3APzNy78PqdhcpSdBtNIw9vfDqA9mmCdcLcxEszkk9vLAvkvX5XbOY22TWDdXFBDEbaxOym2jHkS7JXPziojV1CdwA
sJVcinoboGFinsDc5ASLvY4FVXqHQ0oSZOHSr0XivpnijJ7Ej6pjQAjrcf5HSb3N1o46KLHq5YSQlPkRwxiv1kmgBnpYwL0EG21RzuP8+7WkV07AjSKl
T8ItNkzMs3ZK7Is4ZZva18N+LcTaI4EuO3qVocGThWc+bQKBgQDva9DoWSxR7ijYxPObbHQz9e0AJoZ/seNKLmC/a83fSbVlTceTaojPOPNj5RAkcvnB
aEcaa9xKEj2QqGAfxoqro8/M/OFxy6vGQRGEhAJ8olQyh7tWIMgoakUMR/uQekTgZk8gcvNp++ivGqJB805QlZeWEb+bRhggM72FUC0lowKBgQDiS0SD
mqjuC/HzwmO2/EDzYCycJjfcgtjAM6iClTD2n87g+GZy80h/E6Chj30I6qedsMWqMQxgH09q/YGG4Xte0T8MIvvssBh+EH/w1O+nrdEXAOa8uDJGPX4C
aXzrgV7pnbcD/TuW/em9Gr1TVpTND865tE0KBUyJOWDaR5wJlQKBgQCfje9z2HGTzC6Gf4KFMpqiQiMGdaYulUMOnae2CcbyJjHv6Ay3rkisKJzzFqVS
VRkijjbMYdM1vcAvljYxFuQ1DH8gcepgJsY74gMll7/8hUWtQw1SkZgybtfDHnmEyCb8kNHsow6as9lWUF6PqvCm/Xo+9WcGuIi9dR25KTxdFwKBgF2f
WkdAc2eZFY8N+4c3Mf/+6DXqMe5PTDGorazo4IsIbuTwoCIquPGqQyjUXpyTyKka+4yAImiaS5cuLqqJGyuNUpJI3wV7jYaKeQRAdK5g4UKtIsktQ89/
nWSOFBqzOXtZvuAtorvDbTLJn06dYY69XX/DMqRUsOeND57/RXVJAoGBAOXAs5hbdx5BcgOHHTptjbxwSvlHjudSHQol3aqk2ECPKFQFy7QlqUG6QiM/
G4GB9U0ND+Ia0mmeqqja2M5llolBpotPtV4R/JdAN34NkcDmv83Ra5th5s+LrJZF0VE8/WnD9OT/n+dVxjEJcuPOVicXvy4eF4gwxNKOx733qLjF
-----END PRIVATE KEY-----`;

/** 安卓端的 UnlockCipher 用上面那把公钥加密 "安卓加密的 pässwörd 456" 得到的密文（UnlockCipherTest 的 printsFixtureForHostTest 打出来的） */
const FROM_ANDROID =
  'cCSQ5phhaQ/VN+voxZQHfJoUQWuWWsAvDSIBrnNqPwSWSdbWAZFfnPKw7bDEpOw3DksrG8q7tVg99ZWsK3RF1KPZILIWsjdC9xSWUMpabfo/tnzZpOgRZLUwB1DQzSzedPR2' +
  'scjklNTEx4+kqOsfD0feZcEMRgxMcVVRtnUcoV0AKUa0iYl2h2/vPGi2u7YPXCRvGhv+ZyU3wjAXpRzfp1qp/E+mj1thkZjTlkkON3dgICp6mK6+XhA+oeE9mGsjxheclmFM' +
  'jVGKR2lN5HrGzNbTabBApOQXQT5UaG3rv9mcKcy/NdnjiLbc1A77e3ehXdrjal2VlXKACTc3rMWUaQ==';

test('默认生成 3072 位的密钥：公钥是 DER（SPKI）的 Base64，解得开用它加密的密码', async () => {
  const k = createUnlockKey();
  assert.equal(k.publicKey, null, '还没生成好');
  assert.deepEqual(k.open('AAAA'), { code: 'bad-key' }, '还没生成好时什么都解不开');
  await k.ready;
  const pub = crypto.createPublicKey({ key: Buffer.from(k.publicKey, 'base64'), format: 'der', type: 'spki' });
  assert.equal(pub.asymmetricKeyDetails.modulusLength, KEY_BITS);
  assert.equal(KEY_BITS, 3072);
  assert.deepEqual(k.open(seal(k.publicKey, 'Pässwörd 密码 123!')), { password: 'Pässwörd 密码 123!' });
  // 318 字节是 3072 位密钥在 OAEP-SHA256 下的上限
  assert.deepEqual(k.open(seal(k.publicKey, 'a'.repeat(318))), { password: 'a'.repeat(318) });
});

test('同一条密文只认一次；重新加密的认', async () => {
  const k = createUnlockKey({ privateKeyPem: TEST_KEY });
  await k.ready;
  const enc = seal(k.publicKey, 'secret');
  assert.deepEqual(k.open(enc), { password: 'secret' });
  assert.deepEqual(k.open(enc), { code: 'replayed' });
  // Base64 写法不同（去掉补位、中间加空白）、字节相同，也算同一条
  assert.deepEqual(k.open(enc.replace(/=+$/, '')), { code: 'replayed' });
  assert.deepEqual(k.open(enc.slice(0, 10) + ' \n' + enc.slice(10)), { code: 'replayed' });
  assert.deepEqual(k.open(seal(k.publicKey, 'secret')), { password: 'secret' });
});

test('解不开的都回 bad-key：别的密钥加密的、长度不对的、乱写的', async () => {
  const k = createUnlockKey({ privateKeyPem: TEST_KEY });
  await k.ready;
  const other = createUnlockKey({ bits: 2048 });
  await other.ready;
  assert.notEqual(other.publicKey, k.publicKey);
  assert.deepEqual(k.open(seal(other.publicKey, 'secret')), { code: 'bad-key' }, '被控端重启后密钥换了，旧公钥加密的解不开');

  const enc = Buffer.from(seal(k.publicKey, 'secret'), 'base64');
  assert.equal(enc.length, 256);
  assert.deepEqual(k.open(enc.subarray(1).toString('base64')), { code: 'bad-key' }, '少一个字节');
  assert.deepEqual(k.open(Buffer.concat([Buffer.alloc(1), enc]).toString('base64')), { code: 'bad-key' }, '前面多一个零');
  for (const bad of ['', 'AAAA', '不是 Base64', 'x'.repeat(5000), null, undefined, 123, {}, []]) {
    assert.deepEqual(k.open(bad), { code: 'bad-key' }, String(bad));
  }
  // 解不开的不占"用过"的名额，之后正常的照样能解
  assert.deepEqual(k.open(enc.toString('base64')), { password: 'secret' });
});

test('空密码不算解开', async () => {
  const k = createUnlockKey({ privateKeyPem: TEST_KEY });
  await k.ready;
  assert.deepEqual(k.open(seal(k.publicKey, '')), { code: 'bad-key' });
});

test('解得开安卓端加密出来的密文（OAEP 的哈希和 MGF1 两边都是 SHA-256）', async () => {
  const k = createUnlockKey({ privateKeyPem: TEST_KEY });
  await k.ready;
  assert.deepEqual(k.open(FROM_ANDROID), { password: '安卓加密的 pässwörd 456' });
});
