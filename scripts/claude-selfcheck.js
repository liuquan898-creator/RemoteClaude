#!/usr/bin/env node
'use strict';
/**
 * 在这台电脑上用仓库里的源码把"新建会话""打开会话"真的走一遍（说明见 docs/07 第 8 节）：
 *
 *   node scripts/claude-selfcheck.js          给人看的结果
 *   node scripts/claude-selfcheck.js --json   只输出一行 JSON
 *
 * 和被控端里 Claude 升级后的自动自检是同一段代码（host/sessions/selfcheck.js），区别是这里用的是工作目录里的源码，
 * 改完 host/sessions 以后先拿它验证，不用打包、不用起第二个被控端。在普通 node 里跑（koffi 不需要 Electron）。
 *
 * 会在屏幕上闪一下窗口：新建一个"新会话"窗口再关掉，打开一个没开着的会话再关掉。电脑锁屏时做不了。
 * 正在运行的被控端的平铺会照常排这两个窗口。退出码：0 都通过，1 有没通过的，2 没法跑。
 */
const path = require('path');
const { execFile } = require('child_process');

const HOST = path.join(__dirname, '..', 'host');
const win32 = require(path.join(HOST, 'win32.js'));
const { createSessions } = require(path.join(HOST, 'sessions'));
const { runSelfCheck, describe, STEP_NAMES } = require(path.join(HOST, 'sessions', 'selfcheck.js'));
const { claudeVersionOf } = require(path.join(HOST, 'claudecheck.js'));

const json = process.argv.includes('--json');
const TARGETS = ['claude.exe'];
const say = (msg) => {
  if (!json) console.log(msg);
};

function claudeVersion() {
  const w = win32.enumTargetWindows(TARGETS).find((x) => x.className === 'Chrome_WidgetWin_1');
  return w ? claudeVersionOf(win32.processExePath(win32.windowPid(w.hwnd))) : '';
}

(async () => {
  if (win32.isLocked()) {
    say('电脑锁屏了，做不了');
    if (json) console.log(JSON.stringify({ ok: false, error: 'locked' }));
    process.exit(2);
  }
  const version = claudeVersion();
  say(`Claude 桌面端版本: ${version || '（屏幕上没有 Claude 窗口，认不出）'}`);
  const sessions = createSessions({
    log: (m) => say('  [会话] ' + m),
    win32,
    targets: TARGETS,
    // 被控端里是 Electron 的 shell.openExternal，这里用系统的 start，效果一样
    openUrl: (url) => new Promise((resolve) => execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => resolve())),
    idleSeconds: () => 0,
  });
  const result = await runSelfCheck({ sessions, log: (m) => say('  ' + m) });
  for (const s of result.steps) {
    const mark = s.skipped ? '跳过' : s.ok ? '通过' : '没通过';
    const extra = [s.detail, s.ms != null ? `${(s.ms / 1000).toFixed(1)} 秒` : '', s.ok ? '' : `${s.code}${s.step ? '，卡在 ' + s.step : ''}`].filter(Boolean).join('，');
    say(`${mark}  ${STEP_NAMES[s.name] || s.name}${extra ? '（' + extra + '）' : ''}`);
  }
  say(`结论: ${describe(result)}`);
  if (json) console.log(JSON.stringify({ claude: version, ...result, summary: describe(result) }));
  process.exit(result.ok ? 0 : 1);
})().catch((err) => {
  if (json) console.log(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
  else console.error('出错: ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
