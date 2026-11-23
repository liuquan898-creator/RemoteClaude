'use strict';
/**
 * 平铺配置：读 config.toml，文件改过就重新读（和 Python 版 Config.reload 一样按修改时间判断）。
 *
 * 配置文件位置和原来的 Python 版是同一个：%USERPROFILE%\.claude-window-tiler\config.toml
 * （环境变量 CLAUDE_TILER_HOME 可以改目录），这样原来的设置直接沿用。
 * 不放 AppData：从 Claude（MSIX 打包应用）里启动的进程，写 AppData 可能被重定向到 Claude 自己的包目录。
 *
 * 只认 TOML 的一个子集，够 config.default.toml 用：注释、key = value、字符串（"..." 和 '...'）、
 * 整数、小数、布尔、数组（可以跨行、带注释、末尾多一个逗号）、内联表、[表头]。
 * 不支持多行字符串和日期时间，遇到就当配置写错了处理。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = Object.freeze({
  auto_arrange: true,
  max_per_monitor: 3,
  monitor_order: 'left-to-right',
  fill_screen: false,
  keep_monitor: false,
  rearrange_on_close: true,
  include_main_window: false,
  hide_main_window: true,
  raise_all: true,
  raise_restores_minimized: true,
  skip_maximized: false,
  gap: 0,
  delay_ms: 500,
  hotkey: 'ctrl+alt+shift+t',
  arrange_on_start: true,
  process_names: Object.freeze(['claude.exe']),
  window_classes: Object.freeze(['Chrome_WidgetWin_1']),
  exclude_title_prefixes: Object.freeze(['Claude · ']),
});

const TEMPLATE_PATH = path.join(__dirname, 'config.default.toml');

/** 配置和日志所在的目录 */
function dataDir() {
  return process.env.CLAUDE_TILER_HOME || path.join(os.homedir(), '.claude-window-tiler');
}

function defaultConfigPath() {
  return path.join(dataDir(), 'config.toml');
}

function defaultLogPath() {
  return path.join(dataDir(), 'tiler.log');
}

// ---------------------------------------------------------------- TOML 子集解析

const BARE_KEY = /[A-Za-z0-9_-]+/y;
const VALUE_END = /[ \t\n,\]}#]/;

/**
 * 解析 TOML 文本，返回普通对象。写错了抛出带行号的异常。
 * @param {string} text
 * @param {{ spans: Map<string, number[]>, firstTable: number | null }} [info] 传了就顺带记下位置（改配置文件用，见 setTomlValue）：
 *   spans 是每个顶层键的值在文本里的 [开始, 结束)，firstTable 是第一个 [表头] 的位置。
 *   位置按去掉开头的 BOM、把 \r\n 换成 \n 之后的文本算。
 */
function parseToml(text, info) {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  let pos = 0;
  const root = {};
  let table = root;
  const explicitTables = new WeakSet(); // 用 [表头] 定义过的表，不能再定义一次

  const lineAt = (p) => src.slice(0, p).split('\n').length;
  const fail = (msg, p = pos) => {
    throw new Error(`第 ${lineAt(p)} 行：${msg}`);
  };
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const define = (obj, k, value) =>
    Object.defineProperty(obj, k, { value, enumerable: true, writable: true, configurable: true });
  const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

  const skipWs = () => {
    while (src[pos] === ' ' || src[pos] === '\t') pos++;
  };
  const skipComment = () => {
    if (src[pos] === '#') while (pos < src.length && src[pos] !== '\n') pos++;
  };
  const skipBlank = () => {
    for (;;) {
      skipWs();
      if (src[pos] === '#') skipComment();
      else if (src[pos] === '\n') pos++;
      else return;
    }
  };
  const endOfLine = () => {
    skipWs();
    skipComment();
    if (pos >= src.length) return;
    if (src[pos] === '\n') {
      pos++;
      return;
    }
    fail('这一行后面有多余的内容');
  };

  function parseBasicString() {
    if (src.startsWith('"""', pos)) fail('不支持多行字符串');
    const start = pos;
    pos++;
    let out = '';
    for (;;) {
      if (pos >= src.length || src[pos] === '\n') fail('字符串缺少结束的引号', start);
      const c = src[pos++];
      if (c === '"') return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = src[pos++];
      const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
      if (e !== undefined && has(simple, e)) {
        out += simple[e];
      } else if (e === 'u' || e === 'U') {
        const n = e === 'u' ? 4 : 8;
        const hex = src.slice(pos, pos + n);
        const cp = /^[0-9a-fA-F]+$/.test(hex) && hex.length === n ? parseInt(hex, 16) : -1;
        if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail(`\\${e} 后面要跟 ${n} 位有效的十六进制数`);
        out += String.fromCodePoint(cp);
        pos += n;
      } else {
        fail(`不认识的转义：\\${e === undefined ? '' : e}`);
      }
    }
  }

  function parseLiteralString() {
    if (src.startsWith("'''", pos)) fail('不支持多行字符串');
    const start = pos;
    const end = src.indexOf("'", pos + 1);
    const nl = src.indexOf('\n', pos + 1);
    if (end < 0 || (nl >= 0 && nl < end)) fail('字符串缺少结束的引号', start);
    pos = end + 1;
    return src.slice(start + 1, end);
  }

  function parseKey() {
    const parts = [];
    for (;;) {
      skipWs();
      const c = src[pos];
      if (c === '"') parts.push(parseBasicString());
      else if (c === "'") parts.push(parseLiteralString());
      else {
        BARE_KEY.lastIndex = pos;
        const m = BARE_KEY.exec(src);
        if (!m) fail('这里应该是键名');
        parts.push(m[0]);
        pos += m[0].length;
      }
      skipWs();
      if (src[pos] !== '.') return parts;
      pos++;
    }
  }

  function assign(obj, parts, value, at) {
    let cur = obj;
    for (const k of parts.slice(0, -1)) {
      if (!has(cur, k)) define(cur, k, {});
      else if (!isPlainObject(cur[k])) fail(`键 ${parts.join('.')} 和前面的值冲突`, at);
      cur = cur[k];
    }
    const last = parts[parts.length - 1];
    if (has(cur, last)) fail(`重复的键：${parts.join('.')}`, at);
    define(cur, last, value);
  }

  function parseNumber(token, at) {
    const t = token.replace(/_/g, '');
    const underscoresOk = !/(^|[^0-9a-fA-F])_|_($|[^0-9a-fA-F])/.test(token);
    if (!underscoresOk) fail(`看不懂的值：${token}`, at);
    if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
    if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t.slice(2), 16);
    if (/^0o[0-7]+$/.test(t)) return parseInt(t.slice(2), 8);
    if (/^0b[01]+$/.test(t)) return parseInt(t.slice(2), 2);
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t) && /[.eE]/.test(t)) return parseFloat(t);
    if (/^[+-]?inf$/.test(t)) return t[0] === '-' ? -Infinity : Infinity;
    if (/^[+-]?nan$/.test(t)) return NaN;
    return fail(`看不懂的值：${token}（只支持字符串、数字、true/false、数组）`, at);
  }

  function parseArray() {
    const start = pos;
    pos++;
    const arr = [];
    for (;;) {
      skipBlank();
      if (pos >= src.length) fail('数组缺少结束的 ]', start);
      if (src[pos] === ']') {
        pos++;
        return arr;
      }
      arr.push(parseValue());
      skipBlank();
      if (src[pos] === ',') {
        pos++;
        continue;
      }
      if (src[pos] === ']') {
        pos++;
        return arr;
      }
      fail(pos >= src.length ? '数组缺少结束的 ]' : '数组里的值之间要用逗号隔开', pos >= src.length ? start : pos);
    }
  }

  function parseInlineTable() {
    pos++;
    const obj = {};
    skipWs();
    if (src[pos] === '}') {
      pos++;
      return obj;
    }
    for (;;) {
      const at = pos;
      const key = parseKey();
      if (src[pos] !== '=') fail('键名后面要有 =');
      pos++;
      skipWs();
      assign(obj, key, parseValue(), at);
      skipWs();
      if (src[pos] === ',') {
        pos++;
        continue;
      }
      if (src[pos] === '}') {
        pos++;
        return obj;
      }
      fail('内联表里的值之间要用逗号隔开');
    }
  }

  function parseValue() {
    const c = src[pos];
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    if (c === '[') return parseArray();
    if (c === '{') return parseInlineTable();
    const at = pos;
    while (pos < src.length && !VALUE_END.test(src[pos])) pos++;
    const token = src.slice(at, pos);
    if (!token) fail('这里缺少值', at);
    if (token === 'true') return true;
    if (token === 'false') return false;
    return parseNumber(token, at);
  }

  function openTable(parts, isArray, at) {
    let cur = root;
    parts.forEach((k, i) => {
      const last = i === parts.length - 1;
      if (last && isArray) {
        if (!has(cur, k)) define(cur, k, []);
        if (!Array.isArray(cur[k])) fail(`[[${parts.join('.')}]] 和前面的值冲突`, at);
        const t = {};
        cur[k].push(t);
        cur = t;
        return;
      }
      if (!has(cur, k)) define(cur, k, {});
      let next = cur[k];
      if (Array.isArray(next) && !last) next = next[next.length - 1];
      if (!isPlainObject(next)) fail(`表 ${parts.join('.')} 和前面的值冲突`, at);
      if (last) {
        if (explicitTables.has(next)) fail(`表 [${parts.join('.')}] 定义了两次`, at);
        explicitTables.add(next);
      }
      cur = next;
    });
    return cur;
  }

  for (;;) {
    skipBlank();
    if (pos >= src.length) break;
    const at = pos;
    if (src[pos] === '[') {
      const isArray = src[pos + 1] === '[';
      pos += isArray ? 2 : 1;
      const key = parseKey();
      if (isArray ? !src.startsWith(']]', pos) : src[pos] !== ']') fail('表头缺少结束的 ]');
      pos += isArray ? 2 : 1;
      table = openTable(key, isArray, at);
      if (info && info.firstTable == null) info.firstTable = at;
      endOfLine();
      continue;
    }
    const key = parseKey();
    if (src[pos] !== '=') fail('键名后面要有 =');
    pos++;
    skipWs();
    if (pos >= src.length || src[pos] === '\n' || src[pos] === '#') fail('= 后面缺少值');
    const valueAt = pos;
    assign(table, key, parseValue(), at);
    if (info && table === root && key.length === 1) info.spans.set(key[0], [valueAt, pos]);
    endOfLine();
  }
  return root;
}

// ---------------------------------------------------------------- 改配置文件里的一项

/**
 * 把配置文本里顶层的 key 改成 literal（已经写成 TOML 的值，如 '"left-to-right"'）。
 * 只换掉这一个值，注释、空行、别的键、换行符（\n 还是 \r\n）都原样保留；原来的值跨了几行（数组）也整个换掉。
 * 原来没有这个键时加一行：有 [表头] 就加在第一个表头前面，没有就加在最后。
 * 文本本身写错了抛异常（带行号），不去改它。
 */
function setTomlValue(text, key, literal) {
  const raw = String(text);
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  const crlf = raw.includes('\r\n');
  const src = raw.slice(bom.length).replace(/\r\n/g, '\n');
  const info = { spans: new Map(), firstTable: null };
  parseToml(src, info);
  const span = info.spans.get(key);
  let out;
  if (span) {
    out = src.slice(0, span[0]) + literal + src.slice(span[1]);
  } else {
    const line = `${key} = ${literal}\n`;
    if (info.firstTable != null) out = `${src.slice(0, info.firstTable)}${line}\n${src.slice(info.firstTable)}`;
    else out = src + (src === '' || src.endsWith('\n') ? '' : '\n') + line;
  }
  return bom + (crlf ? out.replace(/\n/g, '\r\n') : out);
}

/**
 * 改配置文件里的一个顶层键（见 setTomlValue），文件还没有就新建。返回文件是否有改动。
 * 配置文件写错了、读不了、写不进去时抛异常，文件保持原样。
 */
function writeConfigValue(file, key, literal) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const next = setTomlValue(text, key, literal);
  if (next === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return true;
}

// ---------------------------------------------------------------- 校验

function toInt(v, key) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  throw new Error(`${key} 应该是整数，现在是 ${JSON.stringify(v)}`);
}

function toStringList(v, key) {
  if (typeof v === 'string') return [v]; // 只写了一个字符串也认
  if (Array.isArray(v)) return v.map((s) => String(s));
  throw new Error(`${key} 应该是字符串数组，现在是 ${JSON.stringify(v)}`);
}

/** 补全 / 规整配置值；数值不对时抛异常（调用方沿用之前的配置） */
function normalize(raw) {
  const data = { ...raw };
  data.max_per_monitor = Math.max(1, toInt(data.max_per_monitor, 'max_per_monitor'));
  data.gap = Math.max(0, toInt(data.gap, 'gap'));
  data.delay_ms = Math.max(50, toInt(data.delay_ms, 'delay_ms'));
  data.process_names = toStringList(data.process_names, 'process_names').map((s) => s.toLowerCase());
  data.window_classes = toStringList(data.window_classes, 'window_classes');
  data.exclude_title_prefixes = toStringList(data.exclude_title_prefixes, 'exclude_title_prefixes');
  if (Array.isArray(data.monitor_order)) data.monitor_order = [...data.monitor_order];
  data.hotkey = data.hotkey ? String(data.hotkey) : ''; // "" / false 表示不要快捷键
  return data;
}

// ---------------------------------------------------------------- 配置对象

class Config {
  /**
   * @param {string} file 配置文件路径
   * @param {{ error?: (msg: string) => void }} [logger] 读配置出错时用来写日志
   */
  constructor(file, logger) {
    this.path = file;
    this.mtime = undefined;
    this.logger = logger || null;
    this.data = normalize(DEFAULTS);
    this.reload(true);
  }

  /** 配置文件改过就重新读；读失败沿用上一次的配置。返回是否重新读了。 */
  reload(force = false) {
    let mtime = null;
    try {
      mtime = fs.statSync(this.path).mtimeMs;
    } catch {
      mtime = null;
    }
    if (!force && mtime === this.mtime) return false;
    this.mtime = mtime;
    const raw = { ...DEFAULTS };
    if (mtime !== null) {
      try {
        Object.assign(raw, parseToml(fs.readFileSync(this.path, 'utf8')));
      } catch (err) {
        this.error(`读取配置失败，沿用之前的配置：${err.message}`);
        return false;
      }
    }
    try {
      this.data = normalize(raw);
    } catch (err) {
      this.error(`配置数值不对，沿用之前的配置：${err.message}`);
      return false;
    }
    return true;
  }

  error(msg) {
    if (this.logger && this.logger.error) this.logger.error(msg);
  }
}

/**
 * 配置文件还没有时，从模板复制一份（第一次运行）。已经有了就不动，用户的设置不会被覆盖。
 * 返回这次是否新建了文件。
 */
function ensureConfig(file = defaultConfigPath(), template = TEMPLATE_PATH) {
  if (fs.existsSync(file)) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(template, file, fs.constants.COPYFILE_EXCL);
    return true;
  } catch {
    return false; // 没有模板也能跑，用内置默认值
  }
}

module.exports = {
  DEFAULTS,
  TEMPLATE_PATH,
  dataDir,
  defaultConfigPath,
  defaultLogPath,
  parseToml,
  setTomlValue,
  writeConfigValue,
  normalize,
  Config,
  ensureConfig,
};
