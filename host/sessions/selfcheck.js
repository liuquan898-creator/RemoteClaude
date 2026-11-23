'use strict';
/**
 * 自检：把"从手机新建会话""从手机打开会话"在这台电脑上真的走一遍，看 Claude 桌面端的界面还认不认
 * （说明见 docs/07 第 8 节）。
 *
 * 被控端靠 Claude 的界面文字和按法来点菜单，Claude 一升级就可能失效，而且不试一次看不出来：
 * 2026-11-21 Claude 升级后"菜单"按钮换了按法，直到用户在手机上点"新建"才发现。
 *
 * 会在屏幕上闪一下窗口：新建一个"新会话"窗口再关掉；打开一个没开着的会话再关掉。
 * 新会话没发第一句话，不会留下会话；打开的会话关窗口不影响它在后台运行。只关自己开出来的窗口。
 *
 * 不依赖 Electron：被控端里用，命令行里（scripts/claude-selfcheck.js）也用。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 挑一个环境来试新建：列表里第一个带环境编号的分组（列表按最近用过的排） */
function pickEnv(groups) {
  return groups.find((g) => g && g.env) || null;
}

/** 挑一个会话来试打开：最近的、没开着窗口的、有标题的 */
function pickSession(groups) {
  let best = null;
  for (const g of groups) {
    for (const s of (g && g.sessions) || []) {
      if (!s || s.open || !s.title || !s.id) continue;
      if (!best || (s.at || 0) > (best.at || 0)) best = s;
    }
  }
  return best;
}

/**
 * @param {object} opts
 * @param {{ list: Function, create: Function, open: Function, closeWindow: Function }} opts.sessions host/sessions 的接口
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.settleMs] 窗口开出来以后等多久再关（让平铺排完）
 * @returns {Promise<{ ok: boolean, steps: Array<{ name: string, ok: boolean, skipped?: boolean, code?: string, step?: string, detail?: string, ms?: number }> }>}
 */
async function runSelfCheck({ sessions, log = () => {}, settleMs = 1200 }) {
  const steps = [];
  const timed = async (fn) => {
    const t0 = Date.now();
    const r = await fn();
    return { r, ms: Date.now() - t0 };
  };
  const close = async (hwnd, title) => {
    await sleep(settleMs);
    try {
      const c = await sessions.closeWindow(hwnd, title);
      if (!c.ok) log(`自检开的窗口「${title}」没关掉: ${c.code}`);
    } catch (err) {
      log(`关自检开的窗口出错: ${err && err.message ? err.message : err}`);
    }
  };

  // 1. 读得到 Claude 的会话记录
  let groups = [];
  try {
    const list = sessions.list();
    if (!list || !list.available) steps.push({ name: 'catalog', ok: false, code: (list && list.reason) || 'no-claude' });
    else {
      groups = Array.isArray(list.groups) ? list.groups : [];
      steps.push(groups.length ? { name: 'catalog', ok: true, detail: `${groups.length} 个分组` } : { name: 'catalog', ok: false, code: 'empty' });
    }
  } catch (err) {
    steps.push({ name: 'catalog', ok: false, code: 'failed', detail: String(err && err.message ? err.message : err).slice(0, 200) });
  }
  if (!steps[0].ok) return { ok: false, steps };

  // 2. 新建会话并选上环境
  const env = pickEnv(groups);
  if (!env) steps.push({ name: 'new', ok: true, skipped: true, detail: '没有环境可试' });
  else {
    const { r, ms } = await timed(() => sessions.create(env.env));
    if (!r.ok) steps.push({ name: 'new', ok: false, code: r.code || 'failed', step: r.step || '', ms, detail: `环境「${env.name}」` });
    else {
      steps.push(
        r.envOk
          ? { name: 'new', ok: true, ms, detail: `环境「${env.name}」` }
          : { name: 'new', ok: false, code: 'env-not-picked', step: r.envFail || '', ms, detail: `窗口建出来了，环境「${env.name}」没选上` }
      );
      await close(r.hwnd, r.title);
    }
  }

  // 3. 打开一个没开着的会话
  const s = pickSession(groups);
  if (!s) steps.push({ name: 'open', ok: true, skipped: true, detail: '没有没开着的会话可试' });
  else {
    const { r, ms } = await timed(() => sessions.open(s.id));
    if (!r.ok) steps.push({ name: 'open', ok: false, code: r.code || 'failed', step: r.step || '', ms, detail: `会话「${s.title}」` });
    else {
      steps.push({ name: 'open', ok: true, ms, detail: `会话「${s.title}」` });
      // 只关自己开出来的；它本来就开着（记录里没标出来）时不动
      if (r.created) await close(r.hwnd, r.title);
    }
  }

  return { ok: steps.every((x) => x.ok), steps };
}

const STEP_NAMES = { catalog: '读 Claude 的会话记录', new: '新建会话', open: '打开会话' };

/** 给人看的一句话：哪一项没通过、卡在哪 */
function describe(result) {
  const bad = result.steps.filter((x) => !x.ok);
  if (!bad.length) return '都通过了';
  return bad
    .map((x) => `${STEP_NAMES[x.name] || x.name}没通过（${x.code}${x.step ? '，卡在 ' + x.step : ''}）`)
    .join('；');
}

module.exports = { runSelfCheck, describe, pickEnv, pickSession, STEP_NAMES };
