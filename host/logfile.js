'use strict';
/**
 * 被控端的日志文件：主进程 console 的输出照常打到控制台，同时追加到 <用户数据目录>\logs\host.log。
 * 正式版是开机自启或从开始菜单起来的，控制台没人看，出了问题（比如打开会话报"卡住"）要靠这个文件查。
 * 超过 1 MB 就把旧的改名成 host.log.1，只留一份旧的。写日志失败不影响别的功能。
 */
const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 1024 * 1024;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 本地时间 2026-11-19 17:35:10.123 */
function timestamp(d = new Date()) {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** 多行的消息（比如错误堆栈）后面几行缩进，一眼能看出属于哪一条 */
function formatLine(level, text, d = new Date()) {
  const lines = String(text).split(/\r?\n/);
  return `${timestamp(d)} ${level} ${lines[0]}` + lines.slice(1).map((l) => '\n    ' + l).join('') + '\n';
}

/**
 * @param {string} file 日志文件路径
 * @param {{ maxBytes?: number, now?: () => Date }} [opts]
 */
function createLogFile(file, { maxBytes = MAX_BYTES, now = () => new Date() } = {}) {
  let size = -1;

  function rotate() {
    try {
      fs.rmSync(file + '.1', { force: true });
      fs.renameSync(file, file + '.1');
    } catch {
      // 被别的进程占着改不了名，下次再试
    }
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
  }

  function write(level, text) {
    try {
      if (size < 0) {
        try {
          size = fs.statSync(file).size;
        } catch {
          size = 0;
        }
      }
      if (size >= maxBytes) rotate();
      const line = formatLine(level, text, now());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line, 'utf8');
      size += Buffer.byteLength(line, 'utf8');
    } catch {
      // 写不进去就算了
    }
  }

  return { file, write };
}

/** 把 console.log/info/warn/error 也写进日志文件，原来的输出照旧 */
function teeConsole(logFile, con = console) {
  for (const [name, level] of [
    ['log', 'INFO'],
    ['info', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
  ]) {
    const orig = con[name].bind(con);
    con[name] = (...args) => {
      orig(...args);
      logFile.write(level, util.format(...args));
    };
  }
}

module.exports = { createLogFile, teeConsole, timestamp, formatLine, MAX_BYTES };
