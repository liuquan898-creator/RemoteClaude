// 对照 android/app/src/test/.../ui/CodeSpansTest.kt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeSpans } from '../entry/src/main/ets/logic/CodeSpans';
import type { CodeSpanPart } from '../entry/src/main/ets/logic/CodeSpans';

const Plain = (text: string): CodeSpanPart => ({ code: false, text });
const Code = (text: string): CodeSpanPart => ({ code: true, text });

test('没有反引号就是一段普通文字', () => {
  assert.deepEqual(CodeSpans.split('弄好了吗？'), [Plain('弄好了吗？')]);
});

test('行内命令拆出来', () => {
  assert.deepEqual(CodeSpans.split('请运行 `curl -s https://example.com/k.txt >> ~/.ssh/authorized_keys` 然后回车'), [
    Plain('请运行 '),
    Code('curl -s https://example.com/k.txt >> ~/.ssh/authorized_keys'),
    Plain(' 然后回车'),
  ]);
});

test('多个命令各拆各的', () => {
  assert.deepEqual(CodeSpans.split('`a` 和 `b`'), [Code('a'), Plain(' 和 '), Code('b')]);
});

test('代码块去掉语言名和首尾换行', () => {
  assert.deepEqual(CodeSpans.split('粘贴：\n```bash\nsudo apt update\nsudo apt install -y coturn\n```\n好了吗'), [
    Plain('粘贴：\n'),
    Code('sudo apt update\nsudo apt install -y coturn'),
    Plain('\n好了吗'),
  ]);
});

test('代码块第一行有空格就不是语言名', () => {
  assert.deepEqual(CodeSpans.split('```echo hi\nls```'), [Code('echo hi\nls')]);
  assert.deepEqual(CodeSpans.split('```echo hi```'), [Code('echo hi')]);
});

test('双反引号里可以有单反引号', () => {
  assert.deepEqual(CodeSpans.split('`` echo `date` ``'), [Code('echo `date`')]);
});

test('没配对的反引号当普通文字', () => {
  assert.deepEqual(CodeSpans.split('这里有个 ` 号'), [Plain('这里有个 ` 号')]);
  assert.deepEqual(CodeSpans.split('``x` 不配对'), [Plain('``x` 不配对')]);
});

test('空的反引号当普通文字', () => {
  assert.deepEqual(CodeSpans.split('空 `` 的'), [Plain('空 `` 的')]);
  assert.deepEqual(CodeSpans.split('空 `  ` 的'), [Plain('空 `  ` 的')]);
});

test('公钥这种长串原样保留', () => {
  // 编出来的一串，不是谁的公钥
  const key = "echo 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnly0123456789abcdefghijk/+XYZ' >> ~/.ssh/authorized_keys";
  assert.deepEqual(CodeSpans.split(`粘贴并回车：\`${key}\``), [Plain('粘贴并回车：'), Code(key)]);
});
