'use strict';
/**
 * 平铺配置的单元测试：TOML 子集解析、默认值、热重载、第一次运行复制模板。
 * 只在系统临时目录里读写文件，不碰用户真正的配置。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
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
} = require('../tiler/config');

const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-tiler-test-'));
  tmpDirs.push(d);
  return d;
}

/** 写文件并把修改时间改成指定值（避免同一毫秒内改两次看不出来） */
function writeAt(file, text, seconds) {
  fs.writeFileSync(file, text, 'utf8');
  fs.utimesSync(file, seconds, seconds);
}

function collectingLogger() {
  const errors = [];
  return { errors, error: (m) => errors.push(m) };
}

// ---------------------------------------------------------------- 模板

test('模板 config.default.toml 的键和值与内置默认值完全一致', () => {
  const parsed = parseToml(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(DEFAULTS).sort());
  assert.deepEqual(normalize(parsed), normalize(DEFAULTS));
});

test('默认值和 Python 版 DEFAULTS 一样（monitor_order 从按屏幕序号改成了从左到右，hide_main_window 默认改成不收主窗口）', () => {
  assert.deepEqual(normalize(DEFAULTS), {
    auto_arrange: true,
    max_per_monitor: 3,
    monitor_order: 'left-to-right',
    fill_screen: false,
    keep_monitor: false,
    rearrange_on_close: true,
    include_main_window: false,
    hide_main_window: false,
    raise_all: true,
    raise_restores_minimized: true,
    skip_maximized: false,
    gap: 0,
    delay_ms: 500,
    hotkey: 'ctrl+alt+shift+t',
    arrange_on_start: true,
    process_names: ['claude.exe'],
    window_classes: ['Chrome_WidgetWin_1'],
    exclude_title_prefixes: ['Claude · '],
  });
});

// ---------------------------------------------------------------- 解析

test('parseToml：注释、字符串、整数、布尔', () => {
  const t = parseToml(
    [
      '# 整行注释',
      '',
      'a = "hello # 不是注释"   # 行尾注释',
      "b = 'C:\\path\\不转义'",
      'c = 42',
      'd = -7',
      'e = +3',
      'f = 1_000',
      'g = true',
      'h = false',
      'i = ""',
      '  j\t=\t"缩进和制表符"  ',
    ].join('\n')
  );
  assert.deepEqual(t, {
    a: 'hello # 不是注释',
    b: 'C:\\path\\不转义',
    c: 42,
    d: -7,
    e: 3,
    f: 1000,
    g: true,
    h: false,
    i: '',
    j: '缩进和制表符',
  });
});

test('parseToml：字符串转义', () => {
  const t = parseToml('s = "a\\"b\\\\c\\n\\t\\u00e9\\U0001F600"');
  assert.equal(t.s, 'a"b\\c\n\té😀');
});

test('parseToml：十六进制 / 八进制 / 二进制、小数、指数、inf', () => {
  const t = parseToml('a = 0xff\nb = 0o17\nc = 0b101\nd = 1.5\ne = -2e3\nf = 6.02E+23\ng = inf\nh = -inf');
  assert.deepEqual(t, { a: 255, b: 15, c: 5, d: 1.5, e: -2000, f: 6.02e23, g: Infinity, h: -Infinity });
  assert.ok(Number.isNaN(parseToml('x = nan').x));
});

test('parseToml：数组可以跨行、带注释、末尾多一个逗号，也可以嵌套', () => {
  const t = parseToml(
    [
      'monitor_order = [2, 1, 3]',
      'names = [',
      '  "claude.exe",   # 主程序',
      '  # 整行注释',
      "  'other.exe',",
      ']',
      'empty = []',
      'nested = [[1, 2], ["a"]]',
    ].join('\n')
  );
  assert.deepEqual(t, { monitor_order: [2, 1, 3], names: ['claude.exe', 'other.exe'], empty: [], nested: [[1, 2], ['a']] });
});

test('parseToml：Windows 换行和 UTF-8 BOM', () => {
  assert.deepEqual(parseToml('\uFEFFa = 1\r\nb = "x"\r\n'), { a: 1, b: 'x' });
});

test('parseToml：表头、点号键、带引号的键、内联表', () => {
  const t = parseToml(
    [
      'top = 1',
      'site."key with space" = 2',
      '"quoted" = 3',
      'inline = { x = 1, y = "two", z = [3] }',
      '[extra]',
      'a = true',
      '[extra.deeper]',
      'b = 2',
      '[[items]]',
      'n = 1',
      '[[items]]',
      'n = 2',
    ].join('\n')
  );
  assert.deepEqual(t, {
    top: 1,
    site: { 'key with space': 2 },
    quoted: 3,
    inline: { x: 1, y: 'two', z: [3] },
    extra: { a: true, deeper: { b: 2 } },
    items: [{ n: 1 }, { n: 2 }],
  });
});

test('parseToml：表头后面的键不会盖掉顶层的同名键', () => {
  const t = parseToml('gap = 4\n[other]\ngap = 99');
  assert.equal(t.gap, 4);
  assert.equal(t.other.gap, 99);
});

test('parseToml：__proto__ 当普通键处理，不会污染原型', () => {
  const t = parseToml('__proto__ = 1');
  assert.equal(Object.getPrototypeOf(t), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(t, '__proto__').value, 1);
});

test('parseToml：写错了抛出带行号的异常', () => {
  const bad = [
    ['a = 1\na = 2', /第 2 行：重复的键：a/],
    ['a = "没有结束', /第 1 行：字符串缺少结束的引号/],
    ["a = 'x", /第 1 行：字符串缺少结束的引号/],
    ['a =', /第 1 行：= 后面缺少值/],
    ['a = # 注释', /= 后面缺少值/],
    ['a = 1 2', /第 1 行：这一行后面有多余的内容/],
    ['\n\na = [1, 2', /第 3 行：数组缺少结束的 ]/],
    ['a = [1 2]', /数组里的值之间要用逗号隔开/],
    ['a = yes', /看不懂的值：yes/],
    ['d = 1979-05-27', /看不懂的值/],
    ['a = 1__0', /看不懂的值/],
    ['a = """多行"""', /不支持多行字符串/],
    ['a = "\\q"', /不认识的转义/],
    ['just a line', /键名后面要有 =/],
    ['= 1', /这里应该是键名/],
    ['[t]\n[t]', /第 2 行：表 \[t\] 定义了两次/],
    ['a = 1\na.b = 2', /和前面的值冲突/],
    ['[t', /表头缺少结束的 ]/],
  ];
  for (const [text, re] of bad) assert.throws(() => parseToml(text), re, JSON.stringify(text));
});

// ---------------------------------------------------------------- 改配置文件里的一项

test('setTomlValue：只换掉这一个值，注释、空行、别的键原样保留', () => {
  const text = ['# 开头的说明', 'gap = 4', '', '# 屏幕顺序', 'monitor_order = "number"   # 行尾的注释', 'hotkey = "ctrl+t"', ''].join('\n');
  const out = setTomlValue(text, 'monitor_order', '"left-to-right"');
  assert.equal(out, text.replace('"number"', '"left-to-right"'));
  assert.deepEqual(parseToml(out), { gap: 4, monitor_order: 'left-to-right', hotkey: 'ctrl+t' });
});

test('setTomlValue：原来的值是跨行的数组也整个换掉', () => {
  const text = ['gap = 4', 'monitor_order = [', '  2, 1,  # 先右后左', '  3,', ']  # 结尾', 'delay_ms = 300', ''].join('\n');
  const out = setTomlValue(text, 'monitor_order', '"primary"');
  assert.equal(out, ['gap = 4', 'monitor_order = "primary"  # 结尾', 'delay_ms = 300', ''].join('\n'));
});

test('setTomlValue：值里、注释里出现同样的字不会被误改', () => {
  const text = ['# monitor_order = "number" 是老的默认值', 'note = "monitor_order = 1"', 'monitor_order = "number"', ''].join('\n');
  const out = setTomlValue(text, 'monitor_order', '"right-to-left"');
  assert.equal(out, ['# monitor_order = "number" 是老的默认值', 'note = "monitor_order = 1"', 'monitor_order = "right-to-left"', ''].join('\n'));
});

test('setTomlValue：原来没有这个键时加在最后；有表头时加在第一个表头前面', () => {
  assert.equal(setTomlValue('', 'monitor_order', '"number"'), 'monitor_order = "number"\n');
  assert.equal(setTomlValue('gap = 4', 'monitor_order', '"number"'), 'gap = 4\nmonitor_order = "number"\n');
  assert.equal(setTomlValue('gap = 4\n', 'monitor_order', '"number"'), 'gap = 4\nmonitor_order = "number"\n');
  const out = setTomlValue('gap = 4\n[extra]\nmonitor_order = "primary"\n', 'monitor_order', '"number"');
  assert.equal(out, 'gap = 4\nmonitor_order = "number"\n\n[extra]\nmonitor_order = "primary"\n');
  assert.deepEqual(parseToml(out), { gap: 4, monitor_order: 'number', extra: { monitor_order: 'primary' } });
});

test('setTomlValue：Windows 换行和 UTF-8 BOM 原样保留', () => {
  const text = '﻿# 说明\r\ngap = 4\r\nmonitor_order = "number"\r\n';
  assert.equal(setTomlValue(text, 'monitor_order', '"primary"'), '﻿# 说明\r\ngap = 4\r\nmonitor_order = "primary"\r\n');
  assert.equal(setTomlValue('gap = 4\r\n', 'monitor_order', '"primary"'), 'gap = 4\r\nmonitor_order = "primary"\r\n');
});

test('setTomlValue：配置本身写错了抛异常，不去改它', () => {
  assert.throws(() => setTomlValue('gap = = 4\nmonitor_order = "number"\n', 'monitor_order', '"primary"'), /^Error: 第 1 行/);
});

test('setTomlValue：模板里改屏幕顺序，只动那一行', () => {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const out = setTomlValue(template, 'monitor_order', '"number"');
  const before = template.split(/\r?\n/);
  const after = out.split(/\r?\n/);
  assert.equal(after.length, before.length);
  const changed = after.map((line, i) => (line === before[i] ? null : [before[i], line])).filter(Boolean);
  assert.deepEqual(changed, [['monitor_order = "left-to-right"', 'monitor_order = "number"']]);
  assert.deepEqual(normalize(parseToml(out)), { ...normalize(DEFAULTS), monitor_order: 'number' });
});

test('writeConfigValue：改文件里的一项，Config 重新读得到；值没变就不写', () => {
  const file = path.join(tmpDir(), 'c.toml');
  writeAt(file, '# 说明\ngap = 4\nmonitor_order = "number"\n', 1000);
  const c = new Config(file);
  assert.equal(c.data.monitor_order, 'number');
  assert.equal(writeConfigValue(file, 'monitor_order', '"right-to-left"'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '# 说明\ngap = 4\nmonitor_order = "right-to-left"\n');
  assert.equal(c.reload(true), true);
  assert.equal(c.data.monitor_order, 'right-to-left');
  assert.equal(c.data.gap, 4);
  fs.utimesSync(file, 2000, 2000);
  assert.equal(writeConfigValue(file, 'monitor_order', '"right-to-left"'), false);
  assert.equal(fs.statSync(file).mtimeMs, 2000 * 1000); // 没有重写文件
});

test('writeConfigValue：文件还没有就新建（连目录一起）；写错的文件不动它', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sub', 'c.toml');
  assert.equal(writeConfigValue(file, 'monitor_order', '"primary"'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'monitor_order = "primary"\n');
  const bad = path.join(dir, 'bad.toml');
  fs.writeFileSync(bad, 'gap = = 4\n', 'utf8');
  assert.throws(() => writeConfigValue(bad, 'monitor_order', '"primary"'), /第 1 行/);
  assert.equal(fs.readFileSync(bad, 'utf8'), 'gap = = 4\n');
});

// ---------------------------------------------------------------- 校验

test('normalize：数值下限、整数转换、进程名小写', () => {
  const d = normalize({ ...DEFAULTS, max_per_monitor: 0, gap: -5, delay_ms: 10, process_names: ['Claude.EXE'] });
  assert.equal(d.max_per_monitor, 1);
  assert.equal(d.gap, 0);
  assert.equal(d.delay_ms, 50);
  assert.deepEqual(d.process_names, ['claude.exe']);
  assert.equal(normalize({ ...DEFAULTS, max_per_monitor: 2.9 }).max_per_monitor, 2);
  assert.equal(normalize({ ...DEFAULTS, max_per_monitor: '4' }).max_per_monitor, 4);
});

test('normalize：只写了一个字符串的列表也认；hotkey 写 false 等于不要快捷键', () => {
  const d = normalize({ ...DEFAULTS, window_classes: 'X', hotkey: false });
  assert.deepEqual(d.window_classes, ['X']);
  assert.equal(d.hotkey, '');
});

test('normalize：数值或列表类型不对时抛异常', () => {
  assert.throws(() => normalize({ ...DEFAULTS, gap: 'wide' }), /gap 应该是整数/);
  assert.throws(() => normalize({ ...DEFAULTS, delay_ms: [1] }), /delay_ms 应该是整数/);
  assert.throws(() => normalize({ ...DEFAULTS, process_names: 3 }), /process_names 应该是字符串数组/);
});

test('normalize：不改动传进来的对象和内置默认值', () => {
  const raw = { ...DEFAULTS, process_names: ['A.EXE'] };
  normalize(raw);
  assert.deepEqual(raw.process_names, ['A.EXE']);
  assert.ok(Object.isFrozen(DEFAULTS));
});

// ---------------------------------------------------------------- 配置对象和热重载

test('Config：没有文件时用默认值', () => {
  const c = new Config(path.join(tmpDir(), 'none.toml'));
  assert.deepEqual(c.data, normalize(DEFAULTS));
  assert.equal(c.reload(), false);
});

test('Config：只写了部分键时其余用默认值；未知的键保留但不影响', () => {
  const file = path.join(tmpDir(), 'c.toml');
  writeAt(file, 'max_per_monitor = 2\nfoo = "bar"\n', 1000);
  const c = new Config(file);
  assert.equal(c.data.max_per_monitor, 2);
  assert.equal(c.data.gap, 0);
  assert.equal(c.data.foo, 'bar');
});

test('Config：修改时间变了才重新读', () => {
  const file = path.join(tmpDir(), 'c.toml');
  writeAt(file, 'gap = 4\n', 1000);
  const c = new Config(file);
  assert.equal(c.data.gap, 4);
  assert.equal(c.reload(), false);
  writeAt(file, 'gap = 6\n', 1000); // 内容变了但修改时间没变：不读（和 Python 版一样只看修改时间）
  assert.equal(c.reload(), false);
  assert.equal(c.data.gap, 4);
  writeAt(file, 'gap = 8\n', 2000);
  assert.equal(c.reload(), true);
  assert.equal(c.data.gap, 8);
  assert.equal(c.reload(true), true); // 强制重读
});

test('Config：写错了沿用之前的配置并记错误，改好后再读进来', () => {
  const file = path.join(tmpDir(), 'c.toml');
  const logger = collectingLogger();
  writeAt(file, 'gap = 4\nmonitor_order = [2, 1]\n', 1000);
  const c = new Config(file, logger);
  writeAt(file, 'gap = = 5\n', 2000);
  assert.equal(c.reload(), false);
  assert.equal(c.data.gap, 4);
  assert.deepEqual(c.data.monitor_order, [2, 1]);
  assert.match(logger.errors[0], /^读取配置失败，沿用之前的配置：第 1 行/);
  assert.equal(c.reload(), false); // 同一个坏文件不会反复报错
  assert.equal(logger.errors.length, 1);
  writeAt(file, 'gap = "wide"\n', 3000);
  assert.equal(c.reload(), false);
  assert.match(logger.errors[1], /^配置数值不对，沿用之前的配置：gap/);
  writeAt(file, 'gap = 5\n', 4000);
  assert.equal(c.reload(), true);
  assert.equal(c.data.gap, 5);
  assert.equal(c.data.monitor_order, 'left-to-right'); // 新文件里没写，回到默认值
});

test('Config：文件被删掉后回到默认值', () => {
  const file = path.join(tmpDir(), 'c.toml');
  writeAt(file, 'gap = 4\n', 1000);
  const c = new Config(file);
  fs.rmSync(file);
  assert.equal(c.reload(), true);
  assert.equal(c.data.gap, 0);
});

// ---------------------------------------------------------------- 路径和第一次运行

test('配置目录：默认在用户目录下的 .claude-window-tiler，可以用 CLAUDE_TILER_HOME 改', () => {
  const saved = process.env.CLAUDE_TILER_HOME;
  try {
    delete process.env.CLAUDE_TILER_HOME;
    assert.equal(dataDir(), path.join(os.homedir(), '.claude-window-tiler'));
    process.env.CLAUDE_TILER_HOME = path.join(os.tmpdir(), 'tiler-home');
    assert.equal(defaultConfigPath(), path.join(os.tmpdir(), 'tiler-home', 'config.toml'));
    assert.equal(defaultLogPath(), path.join(os.tmpdir(), 'tiler-home', 'tiler.log'));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_TILER_HOME;
    else process.env.CLAUDE_TILER_HOME = saved;
  }
});

test('ensureConfig：没有配置时从模板复制，已经有了就不动', () => {
  const file = path.join(tmpDir(), 'sub', 'dir', 'config.toml');
  assert.equal(ensureConfig(file), true);
  assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  fs.writeFileSync(file, 'gap = 9\n');
  assert.equal(ensureConfig(file), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'gap = 9\n');
});

test('ensureConfig：模板不存在时不报错', () => {
  const file = path.join(tmpDir(), 'config.toml');
  assert.equal(ensureConfig(file, path.join(tmpDir(), 'missing.toml')), false);
  assert.equal(fs.existsSync(file), false);
});
