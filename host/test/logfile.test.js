'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogFile, teeConsole, timestamp, formatLine } = require('../logfile');
const { describeCheck } = require('../sessions');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-log-'));
const at = new Date(2026, 10, 19, 17, 35, 9, 7);
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('时间是本地时间，精确到毫秒', () => {
  assert.equal(timestamp(at), '2026-11-19 17:35:09.007');
});

test('多行消息后面几行缩进', () => {
  assert.equal(formatLine('ERROR', '出错了\nat a\r\nat b', at), '2026-11-19 17:35:09.007 ERROR 出错了\n    at a\n    at b\n');
});

test('日志写进文件，目录不存在就建', () => {
  const file = path.join(tmpDir(), 'logs', 'host.log');
  const log = createLogFile(file, { now: () => at });
  log.write('INFO', '[会话] 在电脑上打开会话「明年项目计划」');
  log.write('WARN', '第二行');
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '2026-11-19 17:35:09.007 INFO [会话] 在电脑上打开会话「明年项目计划」\n2026-11-19 17:35:09.007 WARN 第二行\n'
  );
});

test('超过上限就把旧的改名成 .1，只留一份旧的', () => {
  const file = path.join(tmpDir(), 'host.log');
  fs.writeFileSync(file, 'x'.repeat(100));
  fs.writeFileSync(file + '.1', 'more old');
  const log = createLogFile(file, { maxBytes: 100, now: () => at });
  log.write('INFO', 'a');
  assert.equal(fs.readFileSync(file + '.1', 'utf8'), 'x'.repeat(100));
  assert.equal(fs.readFileSync(file, 'utf8'), '2026-11-19 17:35:09.007 INFO a\n');
  // 接着写，按自己记的大小判断，再超了又换一次
  for (let i = 0; i < 4; i++) log.write('INFO', 'b');
  assert.ok(fs.statSync(file).size < 100 + 40);
  assert.ok(fs.readFileSync(file + '.1', 'utf8').startsWith('2026-11-19'));
});

test('写不进去不抛错', () => {
  const dir = tmpDir();
  const log = createLogFile(dir); // 路径是个目录，写不进去
  assert.doesNotThrow(() => log.write('INFO', 'x'));
});

test('console 的输出照旧，同时写进日志', () => {
  const printed = [];
  const written = [];
  const con = { log: (...a) => printed.push(['log', ...a]), info: () => {}, warn: (...a) => printed.push(['warn', ...a]), error: () => {} };
  teeConsole({ write: (level, text) => written.push([level, text]) }, con);
  con.log('[会话] 打开', 3, '次');
  con.warn('出错: %s', 'boom');
  assert.deepEqual(printed, [['log', '[会话] 打开', 3, '次'], ['warn', '出错: %s', 'boom']]);
  assert.deepEqual(written, [['INFO', '[会话] 打开 3 次'], ['WARN', '出错: boom']]);
});

test('页面检查没通过时，日志里写清楚是哪种、等了多久、页面上是什么', () => {
  assert.equal(
    describeCheck({ ok: false, code: 'stuck', reason: 'other', ms: 6012, seen: b64('通知声音提醒功能') }),
    '页面停在别的会话上，等了 6.0 秒，页面标题：通知声音提醒功能'
  );
  assert.equal(describeCheck({ ok: false, code: 'stuck', reason: 'loading', ms: 20031, seen: '' }), '页面一直没显示出内容，等了 20.0 秒，页面标题：（空）');
  assert.equal(describeCheck({ ok: false, code: 'timeout' }), '检查没完成（timeout）');
});
