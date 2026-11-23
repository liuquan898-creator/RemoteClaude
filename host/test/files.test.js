'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { FileReceiver, safeName, variantName, reserveUnique, pasteTextFor, PARTIAL_DIR } = require('../files');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 按 16 KB 一块喂给接收端，和控制端的分块一样 */
function feed(rx, key, id, buf, chunk = 16 * 1024) {
  for (let off = 0; off < buf.length; off += chunk) rx.write(key, id, new Uint8Array(buf.subarray(off, off + chunk)));
}

const partials = (dir) => (fs.existsSync(path.join(dir, PARTIAL_DIR)) ? fs.readdirSync(path.join(dir, PARTIAL_DIR)) : []);

test('safeName：只取最后一段，去掉 Windows 不允许的字符', () => {
  assert.equal(safeName('报告.pdf'), '报告.pdf');
  assert.equal(safeName('..\\..\\Windows\\win.ini'), 'win.ini');
  assert.equal(safeName('/etc/passwd'), 'passwd');
  assert.equal(safeName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.equal(safeName('tab\there\n.txt'), 'tabhere.txt');
  assert.equal(safeName('  名字.  . '), '名字');
  assert.equal(safeName('notes.txt:secret'), 'notes.txt_secret');
});

test('safeName：空名字、全是点、保留设备名', () => {
  assert.equal(safeName(''), 'file');
  assert.equal(safeName(null), 'file');
  assert.equal(safeName('...'), 'file');
  assert.equal(safeName('dir/'), 'file');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('nul.txt'), '_nul.txt');
  assert.equal(safeName('com1.log'), '_com1.log');
  assert.equal(safeName('console.log'), 'console.log');
  assert.equal(safeName('.env'), '.env');
});

test('safeName：太长时截短，保留扩展名，不拆开表情', () => {
  const long = '长'.repeat(200) + '.pdf';
  const s = safeName(long);
  assert.equal(Array.from(s).length, 120);
  assert.ok(s.endsWith('.pdf'));
  const emoji = '😀'.repeat(130);
  const e = safeName(emoji);
  assert.equal(Array.from(e).length, 120);
  assert.ok(Array.from(e).every((c) => c === '😀'));
});

test('variantName：同名时加 (n)，和资源管理器一样', () => {
  assert.equal(variantName('报告.pdf', 0), '报告.pdf');
  assert.equal(variantName('报告.pdf', 1), '报告 (1).pdf');
  assert.equal(variantName('archive.tar.gz', 2), 'archive.tar (2).gz');
  assert.equal(variantName('README', 3), 'README (3)');
  assert.equal(variantName('.env', 1), '.env (1)');
});

test('reserveUnique：已有的文件不覆盖，大小写不同也算同名', async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'old');
  fs.writeFileSync(path.join(dir, 'a (1).txt'), 'old1');
  const p = await reserveUnique(dir, 'a.txt');
  assert.equal(path.basename(p), 'a (2).txt');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'old');
  if (process.platform === 'win32') {
    const q = await reserveUnique(dir, 'A.TXT');
    assert.equal(path.basename(q), 'A (3).TXT');
  }
});

test('pasteTextFor：有空格时加引号，末尾留一个空格', () => {
  assert.equal(pasteTextFor('C:\\Users\\a\\Downloads\\RemoteClaude\\x.pdf'), 'C:\\Users\\a\\Downloads\\RemoteClaude\\x.pdf ');
  assert.equal(pasteTextFor('C:\\Users\\a\\Downloads\\RemoteClaude\\my file.pdf'), '"C:\\Users\\a\\Downloads\\RemoteClaude\\my file.pdf" ');
});

test('收一个文件：内容一致，临时文件删掉', async (t) => {
  const dir = tmpDir(t);
  const rx = new FileReceiver({ dir });
  const data = crypto.randomBytes(300 * 1024 + 7);
  assert.equal(rx.begin('v1', 'f1', '数据.bin', data.length), null);
  feed(rx, 'v1', 'f1', data);
  const r = await rx.end('v1', 'f1', sha(data));
  assert.equal(r.code, undefined);
  assert.equal(r.path, path.join(dir, '数据.bin'));
  assert.equal(r.name, '数据.bin');
  assert.ok(fs.readFileSync(r.path).equals(data));
  assert.deepEqual(partials(dir), []);
});

test('同名不覆盖：第二个文件存成 (1)', async (t) => {
  const dir = tmpDir(t);
  const rx = new FileReceiver({ dir });
  const a = Buffer.from('first');
  const b = Buffer.from('second');
  rx.begin('v1', 'a', 'x.txt', a.length);
  feed(rx, 'v1', 'a', a);
  const r1 = await rx.end('v1', 'a', sha(a));
  rx.begin('v1', 'b', 'x.txt', b.length);
  feed(rx, 'v1', 'b', b);
  const r2 = await rx.end('v1', 'b', sha(b));
  assert.equal(path.basename(r1.path), 'x.txt');
  assert.equal(path.basename(r2.path), 'x (1).txt');
  assert.equal(fs.readFileSync(r1.path, 'utf8'), 'first');
  assert.equal(fs.readFileSync(r2.path, 'utf8'), 'second');
});

test('空文件也能收', async (t) => {
  const dir = tmpDir(t);
  const rx = new FileReceiver({ dir });
  assert.equal(rx.begin('v1', 'e', 'empty.txt', 0), null);
  const r = await rx.end('v1', 'e', sha(Buffer.alloc(0)));
  assert.equal(fs.statSync(r.path).size, 0);
});

test('太大、大小不对、磁盘不够时拒收', async (t) => {
  const dir = tmpDir(t);
  const rx = new FileReceiver({ dir, maxBytes: 1000, freeBytes: () => 5000, minFree: 4500 });
  assert.equal(rx.begin('v1', 'a', 'a', 1001), 'file-too-large');
  assert.equal(rx.begin('v1', 'a', 'a', -1), 'file-bad');
  assert.equal(rx.begin('v1', 'a', 'a', 1.5), 'file-bad');
  assert.equal(rx.begin('v1', '', 'a', 10), 'file-bad');
  assert.equal(rx.begin('v1', 'a', 'a', 600), 'disk-full');
  assert.equal(rx.begin('v1', 'a', 'a', 400), null);
  rx.abort('v1');
  await rx.idle();
  assert.deepEqual(partials(dir), []);
});

test('少收、多收、校验和不对都回 file-bad，不留下文件', async (t) => {
  const dir = tmpDir(t);
  const rx = new FileReceiver({ dir });
  const data = crypto.randomBytes(40000);

  rx.begin('v1', 'short', 'short.bin', data.length);
  feed(rx, 'v1', 'short', data.subarray(0, 30000));
  assert.deepEqual(await rx.end('v1', 'short', sha(data)), { code: 'file-bad' });

  rx.begin('v1', 'long', 'long.bin', data.length - 1);
  feed(rx, 'v1', 'long', data);
  assert.deepEqual(await rx.end('v1', 'long', ''), { code: 'file-bad' });

  rx.begin('v1', 'hash', 'hash.bin', data.length);
  feed(rx, 'v1', 'hash', data);
  assert.deepEqual(await rx.end('v1', 'hash', sha(Buffer.from('other'))), { code: 'file-bad' });

  assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== PARTIAL_DIR), []);
  assert.deepEqual(partials(dir), []);
});

test('不带校验和时只核对字节数', async (t) => {
  const dir = tmpDir(t);
  const rx = new FileReceiver({ dir });
  const data = Buffer.from('hello');
  rx.begin('v1', 'n', 'n.txt', data.length);
  feed(rx, 'v1', 'n', data);
  const r = await rx.end('v1', 'n', '');
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'hello');
});

test('取消、换新文件时删掉没收完的临时文件；旧编号的数据不写进新文件', async (t) => {
  const dir = tmpDir(t);
  const rx = new FileReceiver({ dir });
  rx.begin('v1', 'a', 'a.bin', 100);
  rx.write('v1', 'a', new Uint8Array(50));
  rx.abort('v1');
  assert.deepEqual(await rx.end('v1', 'a', ''), { code: 'file-bad' });

  rx.begin('v1', 'b', 'b.bin', 10);
  rx.write('v1', 'b', new Uint8Array(4));
  rx.begin('v1', 'c', 'c.txt', 3); // 上一个没收完就来了新的
  rx.write('v1', 'b', new Uint8Array(6)); // 迟到的旧数据
  rx.write('v1', 'c', new Uint8Array([0x61, 0x62, 0x63]));
  const r = await rx.end('v1', 'c', '');
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'abc');
  await rx.idle();
  assert.deepEqual(partials(dir), []);
});

test('两个控制端同时传，各自独立', async (t) => {
  const dir = tmpDir(t);
  const rx = new FileReceiver({ dir });
  const a = crypto.randomBytes(50000);
  const b = crypto.randomBytes(70000);
  rx.begin('v1', 'a', 'same.bin', a.length);
  rx.begin('v2', 'b', 'same.bin', b.length);
  for (let off = 0; off < 70000; off += 10000) {
    if (off < a.length) rx.write('v1', 'a', new Uint8Array(a.subarray(off, off + 10000)));
    rx.write('v2', 'b', new Uint8Array(b.subarray(off, off + 10000)));
  }
  const [ra, rb] = await Promise.all([rx.end('v1', 'a', sha(a)), rx.end('v2', 'b', sha(b))]);
  assert.notEqual(ra.path, rb.path);
  assert.ok(fs.readFileSync(ra.path).equals(a));
  assert.ok(fs.readFileSync(rb.path).equals(b));
});

test('cleanupStale：只删放久了的临时文件', (t) => {
  const dir = tmpDir(t);
  const rx = new FileReceiver({ dir });
  const pdir = path.join(dir, PARTIAL_DIR);
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, 'old.part'), 'x');
  fs.writeFileSync(path.join(pdir, 'new.part'), 'y');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(pdir, 'old.part'), old, old);
  assert.equal(rx.cleanupStale(60 * 60 * 1000), 1);
  assert.deepEqual(fs.readdirSync(pdir), ['new.part']);
});
