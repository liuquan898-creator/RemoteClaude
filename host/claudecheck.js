'use strict';
/**
 * Claude 升级后自动自检（说明见 docs/07 第 8 节）。
 *
 * 被控端替用户在 Claude 桌面端里点菜单（host/sessions），靠的是 Claude 的界面文字和按法，Claude 一升级就可能失效。
 * 2026-11-21 就是这样：Claude 夜里升级，第二天用户在手机上点"新建"才发现走不通。所以：
 *   - 定时看 Claude 的版本（从 claude.exe 的路径里认）。版本变了、被控端自己换了版本、或者上次自检没通过又过了一阵，
 *     就记下"要自检"；
 *   - 等电脑空闲（没锁屏、没人看画面、几分钟没人动键鼠、没有正在做的打开/新建）时跑一遍 sessions/selfcheck.js；
 *   - 结果写进状态文件（自动修复的定时任务读它，这个任务 2026-11-22 起停用）；没通过就提醒手机，通过了就把提醒收回。
 *
 * 系统接口都从外面传进来，这个文件不依赖 Electron，测试里直接 require。
 */
const fs = require('fs');
const path = require('path');
const { runSelfCheck, describe } = require('./sessions/selfcheck');

/** 电脑这么久没人动键鼠才算空闲：自检会在屏幕上闪窗口，别打扰正在用电脑的人 */
const IDLE_S = 120;
/** 上次没通过、之后什么都没变，隔这么久再试一次（万一是一时的毛病） */
const RETRY_MS = 6 * 3600 * 1000;
const NOTICE_KEY = 'claude-selfcheck';

/** 从 claude.exe 的完整路径里认出 Claude 的版本；认不出就用文件的修改时间顶替（变了就算换了版本） */
function claudeVersionOf(exePath, statSync = fs.statSync) {
  if (!exePath) return '';
  // 商店版：...\WindowsApps\Claude_6.28899.2.0_x64__pzs8sxrjxfjjc\app\claude.exe
  let m = /[\\/]Claude_(\d+(?:\.\d+)+)_[^\\/]*[\\/]/i.exec(exePath);
  if (m) return m[1];
  // 安装程序版：...\AnthropicClaude\app-1.2.3\claude.exe
  m = /[\\/]app-(\d+(?:\.\d+)+)[\\/]/i.exec(exePath);
  if (m) return m[1];
  try {
    return 'exe-' + Math.round(statSync(exePath).mtimeMs);
  } catch {
    return '';
  }
}

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} deps
 * @param {(msg: string) => void} deps.log
 * @param {string} deps.stateFile 自检结果写在这里
 * @param {string} deps.hostVersion 被控端自己的版本
 * @param {() => string} deps.claudeExe 正在运行的 claude.exe 的完整路径，Claude 没在运行时空串
 * @param {object} deps.sessions host/sessions 的接口（list、create、open、closeWindow、busy）
 * @param {() => boolean} deps.locked
 * @param {() => number} deps.viewers 正在看画面的控制端个数
 * @param {() => number} deps.idleSeconds
 * @param {() => void} [deps.before] 开始自检前调一下（让平铺别把这次切窗口当成用户在切）
 * @param {(key: string, notice: object) => void} [deps.notify] 提醒手机
 * @param {(key: string) => void} [deps.clearNotice]
 * @param {() => number} [deps.now]
 * @param {Function} [deps.selfCheck] 测试时换掉
 */
function createClaudeCheck(deps) {
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  const selfCheck = deps.selfCheck || runSelfCheck;
  let state = readState(deps.stateFile);
  let running = false;
  let announced = ''; // 已经在日志里说过"要自检"的原因，免得每分钟说一遍

  /** 现在要不要自检：返回原因，不用就返回空串 */
  function reason(version) {
    if (!state) return '还没自检过';
    if (state.claude !== version) return `Claude 从 ${state.claude || '?'} 换成了 ${version}`;
    if (state.host !== deps.hostVersion) return `被控端从 ${state.host || '?'} 换成了 ${deps.hostVersion}`;
    if (!state.ok && now() - (Number(state.checkedAt) || 0) > RETRY_MS) return '上次没通过，再试一次';
    return '';
  }

  function save(next) {
    state = next;
    try {
      fs.mkdirSync(path.dirname(deps.stateFile), { recursive: true });
      fs.writeFileSync(deps.stateFile, JSON.stringify(next, null, 2));
    } catch (err) {
      log('写自检结果失败: ' + err.message);
    }
  }

  /** 定时调：要自检、电脑又空闲，就跑一遍。返回这次跑的结果，没跑返回 null */
  async function tick() {
    if (running) return null;
    const version = claudeVersionOf(deps.claudeExe());
    if (!version) return null; // Claude 没在运行
    const why = reason(version);
    if (!why) return null;
    if (announced !== why) {
      announced = why;
      log(`${why}，等电脑空闲（没锁屏、没人看画面、${IDLE_S} 秒没人操作）时自检一遍打开和新建会话`);
    }
    if (deps.locked() || deps.viewers() > 0 || deps.idleSeconds() < IDLE_S || deps.sessions.busy) return null;
    return run(version, why);
  }

  async function run(version, why) {
    running = true;
    try {
      log(`开始自检（${why}）：会新建一个会话窗口再关掉、打开一个会话再关掉`);
      if (deps.before) deps.before();
      let result;
      try {
        result = await selfCheck({ sessions: deps.sessions, log });
      } catch (err) {
        result = { ok: false, steps: [{ name: 'run', ok: false, code: 'failed', detail: String(err && err.message ? err.message : err).slice(0, 200) }] };
      }
      const summary = describe(result);
      save({ claude: version, host: deps.hostVersion, checkedAt: now(), ok: result.ok, summary, steps: result.steps });
      announced = '';
      log(`自检结果（Claude ${version}）：${summary}`);
      if (result.ok) {
        if (deps.clearNotice) deps.clearNotice(NOTICE_KEY);
      } else if (deps.notify) {
        deps.notify(NOTICE_KEY, {
          title: 'Claude 升级自检',
          tool: '自检没通过',
          header: '自检没通过',
          text:
            `电脑上的 Claude 桌面端现在是 ${version}，被控端自检：${summary}。手机上对应的操作可能用不了。` +
            // 自动修复的定时任务 2026-11-22 起停用了（每 3 小时开一个会话，用户嫌会话太多），所以不再说"会来处理"
            '要修的话，在 RemoteClaude 的任意一个会话里说一声"Claude 升级后自检没通过"。',
        });
      }
      return result;
    } finally {
      running = false;
    }
  }

  return {
    tick,
    get state() {
      return state;
    },
    get running() {
      return running;
    },
  };
}

module.exports = { createClaudeCheck, claudeVersionOf, IDLE_S, RETRY_MS, NOTICE_KEY };
