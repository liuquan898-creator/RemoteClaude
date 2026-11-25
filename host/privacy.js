'use strict';
/**
 * 隐私屏（docs/11 第 4.4 节）：让解锁服务在电脑的真显示器上盖黑幕、挡本地键鼠，被控端照常采集、操作 Claude。
 *   - on：从手机解锁前先盖好（解锁那一刻不露桌面），或者手机上手动打开；
 *   - off：手机上手动关掉，只撤黑幕；
 *   - end：控制结束，先锁屏再撤，桌面一刻也不露出来。
 * 开着期间每 PING_MS 报一次平安（PING shade，和虚拟屏的分开记），服务 15 秒收不到就自己按 end 收尾，
 * 被控端崩了、撤没撤成功，都不会露出桌面。
 * 电脑前的人按了 Ctrl+Alt+Del：服务那边锁屏、撤黑幕，报平安的回应里 shade=0，这里跟着记成关了。
 * 管道由调用方传入，测试里换成假的。
 */

const PING_MS = 2000;
// 各命令最多等多久：盖要等黑幕程序盖好、钩子装好（服务最多等 5 秒，没就绪再撤掉、最多 8 秒）；
// 撤要先锁屏、等锁屏通知，服务最多等 8 秒；报平安要比服务的 15 秒租约短得多
const TIMEOUT_MS = { 'SHADE ON': 15000, 'SHADE OFF': 12000, 'SHADE END': 12000, 'PING shade': 3000 };

/**
 * @param {object} opts
 * @param {(line: string, timeoutMs: number) => Promise<{ line?: string, error?: string } | null>} opts.ask 问解锁服务
 * @param {(text: string) => void} opts.log
 * @param {(on: boolean) => void} [opts.onChange] 开了、关了以后调用（推给控制端）
 */
function createPrivacy({ ask, log, onChange = () => {}, setTimer = setInterval, clearTimer = clearInterval, pingMs = PING_MS }) {
  let on = false;
  let pingTimer = null;
  let pinging = false;
  let removing = 0; // 排着、正在做的撤（off、end）有几个：这期间报平安回 shade=0 是自己撤的，不是有人按了 Ctrl+Alt+Del
  let queue = Promise.resolve();

  async function request(line) {
    const r = (await ask(line, TIMEOUT_MS[line])) || {};
    if (typeof r.line === 'string') return r.line;
    return 'ERR ' + (r.error || 'no-service');
  }

  function set(next) {
    if (next === on) return;
    on = next;
    if (on && !pingTimer) {
      pingTimer = setTimer(() => {
        ping().catch(() => {});
      }, pingMs);
    } else if (!on && pingTimer) {
      clearTimer(pingTimer);
      pingTimer = null;
    }
    onChange(on);
  }

  async function ping() {
    if (pinging) return;
    pinging = true;
    try {
      const reply = await request('PING shade');
      if (on && removing === 0 && reply.startsWith('OK') && /\bshade=0\b/.test(reply)) {
        log('电脑前有人按了 Ctrl+Alt+Del（或者弹了管理员确认框），电脑已锁屏，隐私屏撤了');
        set(false);
      }
    } finally {
      pinging = false;
    }
  }

  /**
   * 一次只做一件：盖、撤都要和服务说话，后来的排队；撤是在轮到它时才看开没开（排在一个还没做完的"盖"后面时也能撤掉它）。
   * 撤没成功也不再报平安：服务 15 秒收不到就自己先锁屏再撤（看门狗），不能靠 PING 让黑幕一直留着
   */
  function run(line, after) {
    const removal = line !== 'SHADE ON';
    if (removal) removing++;
    queue = queue
      .then(async () => {
        if (removal && !on) return true;
        const reply = await request(line);
        if (reply === 'OK') {
          after();
          return true;
        }
        log(`${removal ? '撤隐私屏' : '盖隐私屏'}没成功：${reply}${removal ? '（解锁服务 15 秒后会自己锁屏、撤掉）' : ''}`);
        if (removal) set(false);
        return false;
      })
      .catch((err) => {
        log(`隐私屏出错：${err.message}`);
        if (removal) set(false);
        return false;
      })
      .finally(() => {
        if (removal) removing--;
      });
    return queue;
  }

  return {
    /** 盖上黑幕。返回是否盖上了 */
    on(reason) {
      return run('SHADE ON', () => {
        if (!on) log(`${reason}，盖上了隐私屏`);
        set(true);
      });
    },
    /** 手机上关了隐私屏：只撤黑幕，不锁屏 */
    off() {
      return run('SHADE OFF', () => {
        log('手机上关了隐私屏');
        set(false);
      });
    },
    /** 控制结束：先锁屏再撤黑幕 */
    end() {
      return run('SHADE END', () => {
        log('控制结束，锁了屏、撤了隐私屏');
        set(false);
      });
    },
    isOn() {
      return on;
    },
  };
}

/**
 * 从手机解锁，按需先盖隐私屏（docs/11 第 4.4 节）。返回给控制端的错误码，成功是 null。
 *   - 要不要盖：手机带了 privacy（true、false）就按手机的，没带按配置 defaultOn；
 *   - 手机明确要盖、却没盖上：不解锁，回 privacy-failed（解锁那一刻会露出桌面）。按配置默认盖的没盖上照常解锁：
 *     旧版解锁服务不认 SHADE，不能因此解不了锁；
 *   - 远程桌面断开、要先接回的（detached）：解锁前盖不了（会话不在电脑的显示器上），接回、解开以后再盖，那一下会露出桌面；
 *   - 解锁做完时控制已经结束了（手机走了）：盖着的先锁屏再撤，不留一块没人撤的黑幕；接回的也不再补盖。
 * @param {{ privacy?: boolean, defaultOn: boolean, detached: boolean, unlock: () => Promise<string|null>,
 *   shade: { on: (reason: string) => Promise<boolean>, end: () => Promise<boolean> }, active: () => boolean }} opts
 */
async function unlockWithPrivacy({ privacy, defaultOn, detached, unlock, shade, active }) {
  const want = typeof privacy === 'boolean' ? privacy : defaultOn;
  if (want && !detached) {
    const covered = await shade.on('从手机解锁');
    if (!covered && privacy === true) return 'privacy-failed';
  }
  const code = await unlock();
  if (!active()) {
    await shade.end();
    return code;
  }
  if (want && detached && !code) await shade.on('从手机接回、解锁');
  return code;
}

module.exports = { createPrivacy, unlockWithPrivacy, PING_MS };
