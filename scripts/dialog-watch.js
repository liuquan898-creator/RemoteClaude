#!/usr/bin/env node
'use strict';
/**
 * 排查"电脑上弹了确认框，手机没收到提醒"用：照被控端的办法读 Claude 桌面端的日志，
 * 把现在还在等的确认框、会发给手机的提醒打印出来。只读，不发任何东西到手机（说明见 docs/09 第 4 节）。
 *
 *   node scripts/dialog-watch.js            看 15 秒
 *   node scripts/dialog-watch.js --secs 120 看 120 秒（这期间新弹的框也会打印）
 *   node scripts/dialog-watch.js --log <main.log 的路径>
 */
const path = require('path');
const { createDialogWatch, createSessionRegistry, findLogFile, TICK_MS } = require('../host/dialogwatch');
const { createApprovals } = require('../host/approvals');

const args = process.argv.slice(2);
const arg = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const secs = Number(arg('--secs', 15)) || 15;
const logFile = arg('--log', '') ? path.resolve(arg('--log', '')) : findLogFile();

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (msg) => console.log(`${stamp()} ${msg}`);

if (!logFile) {
  console.error('没找到 Claude 桌面端的日志（%LOCALAPPDATA%\\Claude\\logs\\main.log 或 %APPDATA%\\Claude\\logs\\main.log）');
  process.exit(2);
}
say('日志：' + logFile);

// 只读审批目录（看插件有没有审批挂着），不写心跳、不发提醒
const approvals = createApprovals({ log: () => {} });
const registry = createSessionRegistry();
const watch = createDialogWatch({
  log: say,
  logFile: () => logFile,
  sessionOf: (id) => registry.byLocal(id),
  sessionOfCli: (id) => registry.byCli(id),
  approvals: () => approvals.pending(),
  notify: (key, n) => say(`  → 会给手机发提醒 [${n.title}] ${n.text}`),
  clearNotice: () => {},
});

let last = '';
function round() {
  approvals.refresh();
  watch.tick();
  const now = Date.now();
  const text =
    watch.pending
      .map((p) => {
        const s = registry.byLocal(p.session);
        return `  ${p.tool}${p.origin ? ' ' + p.origin : ''}  「${s.title || p.session}」 等了 ${Math.round((now - p.at) / 1000)} 秒${p.noticed ? '，已提醒' : ''}`;
      })
      .join('\n') || '  （没有）';
  const key = text.replace(/等了 \d+ 秒/g, '');
  if (key !== last) say('还在等的确认框：\n' + text);
  last = key;
}

round();
const timer = setInterval(round, TICK_MS);
setTimeout(() => {
  clearInterval(timer);
  say('结束');
}, secs * 1000);
