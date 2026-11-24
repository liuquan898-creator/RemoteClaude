// 对照 android/app/src/test/.../files/FileUploadsTest.kt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FileUploads, StallWatch } from '../entry/src/main/ets/logic/FileUploads';

test('delivered 不会是负数，也不会超过交出去的', () => {
  assert.equal(FileUploads.delivered(1000, 300), 700);
  assert.equal(FileUploads.delivered(1000, 5000), 0);
  assert.equal(FileUploads.delivered(1000, 0), 1000);
  assert.equal(FileUploads.delivered(0, 0), 0);
});

test('percent 处理空文件和大文件', () => {
  assert.equal(FileUploads.percent(0, 0), 100);
  assert.equal(FileUploads.percent(0, 100), 0);
  assert.equal(FileUploads.percent(50, 100), 50);
  assert.equal(FileUploads.percent(104_857_599, 104_857_600), 99);
  assert.equal(FileUploads.percent(200, 100), 100);
  // 超过 2 GB 也不溢出
  assert.equal(FileUploads.percent(3 * 1024 * 1024 * 1024, 6 * 1024 * 1024 * 1024), 50);
});

test('大小和上限的说法', () => {
  assert.equal(FileUploads.sizeText(1), '1 KB');
  assert.equal(FileUploads.sizeText(1024 * 1024 - 1), '1024 KB');
  assert.equal(FileUploads.sizeText((1024 * 1024 * 3) / 2), '1.5 MB');
  assert.equal(FileUploads.limitText(100 * 1024 * 1024), '100 MB');
  assert.equal(FileUploads.limitText((1024 * 1024 * 3) / 2), '1.5 MB');
});

test('文件名去掉路径，没有时用默认的', () => {
  assert.equal(FileUploads.displayName('报告.pdf'), '报告.pdf');
  assert.equal(FileUploads.displayName('  /storage/emulated/0/Download/报告.pdf '), '报告.pdf');
  assert.equal(FileUploads.displayName('dir\\a.txt'), 'a.txt');
  assert.equal(FileUploads.displayName(null), 'file');
  assert.equal(FileUploads.displayName('   '), 'file');
  assert.equal(FileUploads.displayName('', 'doc'), 'doc');
});

test('hex 和 SHA-256 的十六进制一致', () => {
  const digest = new Uint8Array(createHash('sha256').update('abc').digest());
  assert.equal(FileUploads.hex(digest), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(FileUploads.hex(new Uint8Array([0, 255, 16])), '00ff10');
});

test('放进输入框的路径和被控端粘贴的一样', () => {
  assert.equal(
    FileUploads.pathForInput('C:\\Users\\a\\Downloads\\RemoteClaude\\x.pdf'),
    'C:\\Users\\a\\Downloads\\RemoteClaude\\x.pdf ',
  );
  assert.equal(FileUploads.pathForInput('C:\\d\\my file.pdf'), '"C:\\d\\my file.pdf" ');
});

test('粘贴失败的原因很短', () => {
  assert.equal(FileUploads.pasteFailureText('locked'), '电脑锁屏了');
  assert.equal(FileUploads.pasteFailureText('window-gone'), '窗口已关闭');
  assert.equal(FileUploads.pasteFailureText(null), '出错了');
});

test('StallWatch 只在没有进展时报卡住', () => {
  const w = new StallWatch(30_000);
  assert.equal(w.stalled(0, 0), false);
  assert.equal(w.stalled(0, 29_000), false);
  assert.equal(w.stalled(100, 29_500), false); // 有进展，重新计时
  assert.equal(w.stalled(100, 59_000), false);
  assert.equal(w.stalled(100, 59_501), true);
  assert.equal(w.stalled(200, 60_000), false);
});
