'use strict';
/**
 * 剪贴板回传（协议文档 4.9）：有控制端在看画面时盯着电脑的剪贴板，文字变了就整理成 clip 消息，
 * 由页面经数据通道发给控制端，控制端放进自己的剪贴板。
 *
 * 只发"有人在看的这段时间里发生的变化"：开始看之前剪贴板里已有的内容不发。
 * 被控端自己为粘贴写进去的内容（长文字、图片、文件路径）不算变化：那是控制端刚发来的，不用再发回去。
 *
 * 系统接口都从外面传进来，这个文件不依赖 Electron，测试里直接 require。
 */

/** 一次最多回传这么多个字符（UTF-16 单元），再长的不发，只告诉控制端太长了 */
const MAX_CHARS = 100000;
/** 一条 clip 消息最多带这么多个字符：全是中文时约 12 KB，和图片、文件的分块差不多大 */
const CHUNK_CHARS = 4000;
/** 多久看一次剪贴板序号。只是读一个数，不打开剪贴板 */
const POLL_MS = 300;
/** 发现序号变了以后等这么久再读：一次复制常常分几步写进剪贴板，等它写完 */
const SETTLE_MS = 120;
/** 剪贴板里明明有文字却读出空的（别的程序正占着剪贴板），隔一会儿再读，最多读这么多次 */
const READ_TRIES = 3;
const RETRY_GAP_MS = 150;
/** 这么短的时间里读到和上次一样的文字，当成同一次复制（有的程序一次复制会让序号变好几回） */
const REPEAT_MS = 1500;
/** 自己写完剪贴板以后这么久之内读到同样的文字，当成自己写的那份 */
const OWN_ECHO_MS = 3000;

/** 按长度切块，不把一个代理对（表情这类字符）切成两半 */
function chunkText(text, size = CHUNK_CHARS) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const c = text.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1; // 这一块的最后一个是代理对的前一半：留给下一块
      if (end <= i) end = Math.min(text.length, i + size); // size 为 1 时切不开，只能照切
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** 把一段文字整理成按顺序发的 clip 消息 */
function buildMessages(id, text) {
  const parts = chunkText(text);
  return parts.map((s, i) => ({ t: 'clip', id, i, n: parts.length, s }));
}

/**
 * @param {object} deps
 * @param {() => number} deps.seq 剪贴板序号，内容每变一次就加
 * @param {() => boolean} deps.hasText 剪贴板里有没有文字
 * @param {() => boolean} deps.excluded 内容是否被标了"不要让监视剪贴板的程序处理"（密码管理器会这么标）
 * @param {() => boolean} deps.locked 电脑是否锁屏
 * @param {() => Promise<string>} deps.readText
 * @param {(msgs: object[]) => void} deps.emit 把要发给控制端的消息交出去
 * @param {(text: string) => void} [deps.log]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 */
function createClipWatch(deps) {
  const log = deps.log || (() => {});
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;

  let timer = null;
  let lastSeq = 0;
  let writes = 0; // 自己正在写剪贴板的次数
  let reading = false;
  let lastText = null;
  let lastAt = 0;
  let ownText = null;
  let ownAt = 0;
  let counter = 0;

  /** 有控制端开始看画面：记下现在的序号，之后变了才算 */
  function start() {
    if (timer) return;
    lastSeq = deps.seq();
    lastText = null;
    timer = setInterval(() => {
      tick().catch((err) => log('读剪贴板出错: ' + (err && err.message ? err.message : err)));
    }, POLL_MS);
    if (timer.unref) timer.unref();
  }

  /** 没人看了：停下，不再读剪贴板 */
  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    lastText = null;
    ownText = null;
  }

  /**
   * 被控端自己写剪贴板时用它包起来，这次变化就不会被当成电脑上的复制发回控制端。
   * @param {() => Promise<any>} fn 真正写剪贴板的函数
   * @param {string} [text] 写进去的文字（写的是图片时不传）
   */
  async function ownWrite(fn, text) {
    writes++;
    try {
      return await fn();
    } finally {
      writes--;
      lastSeq = deps.seq();
      ownText = typeof text === 'string' ? normalize(text) : null;
      ownAt = now();
    }
  }

  function normalize(text) {
    return text.replace(/\r\n?/g, '\n'); // Windows 剪贴板里是 CRLF，手机上用 LF
  }

  /** 看一次。定时器调它；测试里直接调 */
  async function tick() {
    if (!timer || writes || reading) return;
    const seq = deps.seq();
    if (seq === lastSeq) return;
    reading = true;
    try {
      await sleep(SETTLE_MS);
      if (!timer || writes) return; // 自己正在写：写完会把序号记成最新的
      if (deps.seq() !== seq) return; // 还在变，下一轮再看
      lastSeq = seq;
      // 锁屏时系统不让读；没有文字的（图片、文件）不管；标了不让监视的不碰
      if (deps.locked() || !deps.hasText()) return;
      if (deps.excluded()) {
        log('剪贴板里的内容标了不让监视（多半是密码管理器），没有回传');
        return;
      }
      let text = '';
      for (let i = 0; i < READ_TRIES && !text; i++) {
        if (i) await sleep(RETRY_GAP_MS);
        try {
          text = await deps.readText();
        } catch {
          text = '';
        }
        if (typeof text !== 'string') text = '';
      }
      // 读的过程中又变了：读到的不知道是哪一份，下一轮重读
      if (!timer || writes || deps.seq() !== seq) return;
      if (!text) return;
      text = normalize(text);
      const t = now();
      if (ownText !== null && text === ownText && t - ownAt < OWN_ECHO_MS) return;
      if (text === lastText && t - lastAt < REPEAT_MS) return;
      lastText = text;
      lastAt = t;
      if (text.length > MAX_CHARS) {
        log(`剪贴板里的文字有 ${text.length} 个字符，超过 ${MAX_CHARS}，没有回传`);
        deps.emit([{ t: 'clip-skip', code: 'too-large' }]);
        return;
      }
      counter += 1;
      // 日志里只记长度，不记内容
      log(`剪贴板里的文字已发给控制端（${text.length} 个字符）`);
      deps.emit(buildMessages('c' + counter.toString(36), text));
    } finally {
      reading = false;
    }
  }

  return {
    start,
    stop,
    ownWrite,
    tick,
    get running() {
      return !!timer;
    },
  };
}

module.exports = { createClipWatch, chunkText, buildMessages, MAX_CHARS, CHUNK_CHARS, POLL_MS };
