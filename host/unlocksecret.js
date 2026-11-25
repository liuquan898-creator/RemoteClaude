'use strict';
/**
 * 记住解锁密码（docs/06"记住解锁密码"，协议文档 2.9、4.6）：
 *   - 从手机手动输密码解开了电脑、手机说要记住时，用 Windows DPAPI（Electron 的 safeStorage）加密，
 *     密文存到服务器上这台电脑名下。这台电脑上不留，服务器解不开：两边各只有一半；
 *   - 被控端连上服务器时取回密文，放在内存里。手机要"用记下的密码解锁"时在这里解开，交给解锁服务；
 *   - 记下的密码不对了（解锁后还是锁着）就删掉，手机再让用户手动输。
 * 和服务器说话经页面的信令连接（send），服务器的回应由页面交回来（reply）。加密、解密由调用方传入，测试里换成假的。
 *
 * 回应和请求对不上号的情况：服务器按收到的顺序一条条回，所以 put 的回应按发出的顺序排队认领；
 * 要删的没删成（断线、服务器出错）记着 deletePending，下次连上先删再取，取回来的也不认，免得删掉的密码又回来。
 */

/** 服务器收的密文最长多少（hub.js 的 MAX_SECRET_LEN） */
const MAX_BLOB = 4096;
const BLOB_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 服务器回的错误码只取认得的样子，免得把奇怪的内容写进日志 */
function errorOf(msg) {
  const e = msg && typeof msg.error === 'string' ? msg.error : '';
  return /^[a-z-]{1,32}$/.test(e) ? e : 'failed';
}

/**
 * @param {object} opts
 * @param {(password: string) => string} opts.encrypt 加密成 Base64
 * @param {(blob: string) => string} opts.decrypt 解开；解不开时抛异常
 * @param {() => boolean} [opts.available] 这台电脑上能不能加密（safeStorage.isEncryptionAvailable）
 * @param {(msg: { op: string, blob?: string }) => boolean} opts.send 发给服务器（unlock-secret），发不出去返回 false
 * @param {(text: string) => void} opts.log 不写密码、不写密文
 * @param {(saved: boolean) => void} [opts.onChange] 有没有记下的密码变了
 */
function createUnlockSecret({ encrypt, decrypt, available = () => true, send, log, onChange = () => {} }) {
  let blob = null; // 服务器上的密文：取回的、或者刚存上的
  /** 发了 put、服务器还没回的密文，按发出的顺序；forget 时作废（换成 null），回应来了照样认领、但不再算数 */
  let puts = [];
  /** 要删的还没确认删掉：下次连上先删，取回来的也不认 */
  let deletePending = false;
  /** 发了几次 get 还没回 */
  let gets = 0;

  function set(next) {
    const had = blob !== null;
    blob = next;
    if ((blob !== null) !== had) onChange(blob !== null);
  }

  function sendDelete() {
    deletePending = true;
    if (!send({ op: 'delete' })) log('没连着服务器，记下的解锁密码等下次连上再删');
  }

  /** 连上服务器以后：有没删成的先删；再取一次。这台电脑上没法加密就不取（取回来也解不开） */
  function fetch() {
    if (deletePending) sendDelete();
    if (!available()) return;
    if (send({ op: 'get' })) gets++;
  }

  /** 服务器的回应：{ op: 'get'|'put'|'delete', ok, blob?, error? } */
  function reply(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.op === 'get') {
      if (gets > 0) gets--;
      if (!msg.ok) return log(`取记下的解锁密码没成功：${errorOf(msg)}`);
      // 要删的还没删掉、或者取的时候本机又记了新的（还在等服务器回）：这份是旧的，不认
      if (deletePending || puts.some((p) => p !== null)) return;
      const got = typeof msg.blob === 'string' && msg.blob.length <= MAX_BLOB && BLOB_RE.test(msg.blob) ? msg.blob : null;
      set(got);
      return;
    }
    if (msg.op === 'put') {
      const mine = puts.shift();
      if (mine === undefined) return; // 不是这里发的（被控端重启前的）
      if (!msg.ok) return log(`记解锁密码没成功：${errorOf(msg)}`);
      // 后面还有更新的 put 在等：以最后一个为准
      if (mine === null || puts.length) return;
      set(mine);
      log('记下了这次的解锁密码（加密后存在服务器上，只有这台电脑解得开）');
      return;
    }
    if (msg.op === 'delete') {
      if (msg.ok) deletePending = false;
      else log(`删记下的解锁密码没成功：${errorOf(msg)}，下次连上再删`);
    }
  }

  function has() {
    return blob !== null;
  }

  /** 删掉记下的密码。服务器上有没有都发一次删除：内存里没有时（没取到）服务器上也可能有；没删成下次连上再删 */
  function forget(reason) {
    const had = blob !== null;
    puts = puts.map(() => null);
    set(null);
    sendDelete();
    log(had ? `删掉了记下的解锁密码（${reason}）` : `没有记下的解锁密码可删（${reason}）`);
  }

  /**
   * 解开记下的密码。没有、或者解不开（换了 Windows 用户、被控端的资料目录被清过）返回 null；解不开的顺手删掉
   */
  function take() {
    if (blob === null) return null;
    try {
      const password = decrypt(blob);
      if (typeof password === 'string' && password) return password;
    } catch (err) {
      log(`记下的解锁密码解不开：${err && err.message}`);
    }
    forget('解不开');
    return null;
  }

  /** 记下这次解开电脑的密码。返回发出去了没有（存没存上要等服务器回） */
  function remember(password) {
    if (typeof password !== 'string' || !password) return false;
    if (!available()) {
      log('这台电脑上没法加密（系统的数据保护不可用），不记解锁密码');
      return false;
    }
    let next;
    try {
      next = encrypt(password);
    } catch (err) {
      log(`加密解锁密码失败：${err && err.message}`);
      return false;
    }
    if (typeof next !== 'string' || !next || next.length > MAX_BLOB) {
      log('加密后的解锁密码太长，不记');
      return false;
    }
    if (!send({ op: 'put', blob: next })) {
      log('没连着服务器，这次的解锁密码没记下');
      return false;
    }
    // 存上了，原来没删成的那份也就被盖掉了
    deletePending = false;
    puts.push(next);
    return true;
  }

  return { fetch, reply, has, take, remember, forget };
}

/**
 * 手动输密码解开了电脑以后，按手机说的记住或忘掉（docs/06"记住解锁密码"）。
 * save 是 true：记住；false：手机上没勾"记住密码"，原来记下的也删掉；别的（旧版手机不带）：不动。没解开（code 不是 null）时什么都不做
 */
function afterManualUnlock(secret, code, password, save) {
  if (code) return;
  if (save === true) secret.remember(password);
  else if (save === false && secret.has()) secret.forget('手机上没勾“记住密码”');
}

/**
 * 用记下的密码解锁。没有记下的回 no-saved；解锁后还是锁着（密码改过了）就删掉、回 saved-wrong，手机让用户手动输。
 * 别的结果（rate-limited、privacy-failed、not-locked…）原样回，记下的密码留着
 * @param {(password: string) => Promise<string|null>} unlock 交给解锁服务（main.js 的 unlockWith），成功回 null
 */
async function unlockWithSaved(secret, unlock) {
  const password = secret.take();
  if (!password) return 'no-saved';
  const code = await unlock(password);
  if (code === 'still-locked') {
    secret.forget('记下的密码不对，电脑还是锁着');
    return 'saved-wrong';
  }
  return code;
}

module.exports = { createUnlockSecret, afterManualUnlock, unlockWithSaved, MAX_BLOB };
