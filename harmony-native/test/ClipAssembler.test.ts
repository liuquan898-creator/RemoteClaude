// 对照 android/app/src/test/.../protocol/ClipAssemblerTest.kt：剪贴板回传（docs/03-protocol.md 4.9）
// Kotlin 的 parseClipChunk / parseClipSkip 对应 parseChannelMessage 的 clip / clip-skip
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClipAssembler } from '../entry/src/main/ets/protocol/ClipAssembler';
import { parseChannelMessage } from '../entry/src/main/ets/protocol/Protocol';
import type { ClipChunk } from '../entry/src/main/ets/protocol/Protocol';

function chunk(id: string, index: number, count: number, text: string): ClipChunk {
  return { id, index, count, text };
}

/** 解析出的剪贴板块；不是 clip 消息时为 null */
function clipChunk(text: string): ClipChunk | null {
  const m = parseChannelMessage(text);
  return m !== null && m.t === 'clip' ? m.chunk : null;
}

function clipSkip(text: string): string | null {
  const m = parseChannelMessage(text);
  return m !== null && m.t === 'clip-skip' ? m.code : null;
}

test('解析 clip 消息', () => {
  assert.deepEqual(
    clipChunk('{"t":"clip","id":"c1","i":0,"n":1,"s":"你好\\n第二行 \\"引号\\" 😀"}'),
    chunk('c1', 0, 1, '你好\n第二行 "引号" 😀'),
  );
  assert.deepEqual(clipChunk('{"t":"clip","id":"c2","i":2,"n":3,"s":""}'), chunk('c2', 2, 3, ''));

  // 缺字段、序号超出范围、块数离谱的都不认（整条消息返回 null）
  for (const bad of [
    '{"t":"clip","i":0,"n":1,"s":"a"}',
    '{"t":"clip","id":"","i":0,"n":1,"s":"a"}',
    '{"t":"clip","id":"c1","i":0,"n":1}',
    '{"t":"clip","id":"c1","i":1,"n":1,"s":"a"}',
    '{"t":"clip","id":"c1","i":-1,"n":1,"s":"a"}',
    '{"t":"clip","id":"c1","i":0,"n":0,"s":"a"}',
    '{"t":"clip","id":"c1","i":0,"n":100000,"s":"a"}',
    `{"t":"clip","id":"${'x'.repeat(33)}","i":0,"n":1,"s":"a"}`,
    '不是 JSON',
  ]) {
    assert.equal(parseChannelMessage(bad), null, bad);
  }

  assert.equal(clipSkip('{"t":"clip-skip","code":"too-large"}'), 'too-large');
  assert.equal(clipSkip('{"t":"clip-skip"}'), 'unknown');
  assert.equal(clipSkip('{"t":"clip","id":"c1","i":0,"n":1,"s":"a"}'), null);
});

test('别的解析不会把剪贴板消息当成自己的，反过来也一样', () => {
  assert.equal(parseChannelMessage('{"t":"clip","id":"c1","i":0,"n":1,"s":"a"}')?.t, 'clip');
  assert.equal(parseChannelMessage('{"t":"clip-skip","code":"too-large"}')?.t, 'clip-skip');
  assert.equal(clipChunk('{"t":"lock","locked":true,"unlock":false}'), null);
  assert.equal(clipChunk('{"t":"err","code":"covered"}'), null);
  assert.equal(clipSkip('{"t":"err","code":"too-large"}'), null);
});

test('只有一块时立刻拼完', () => {
  const a = new ClipAssembler();
  assert.equal(a.add(chunk('c1', 0, 1, '只有一块')), '只有一块');
  assert.equal(a.add(chunk('c2', 0, 1, '第二段')), '第二段');
});

test('按顺序拼起来', () => {
  const a = new ClipAssembler();
  assert.equal(a.add(chunk('c1', 0, 3, '第一块，')), null);
  assert.equal(a.add(chunk('c1', 1, 3, '第二块😀，')), null);
  assert.equal(a.add(chunk('c1', 2, 3, '第三块')), '第一块，第二块😀，第三块');
});

test('表情被切成两半也能原样拼回', () => {
  const emoji = '😀';
  const a = new ClipAssembler();
  assert.equal(a.add(chunk('c1', 0, 2, 'a' + emoji.charAt(0))), null);
  assert.equal(a.add(chunk('c1', 1, 2, emoji.charAt(1) + 'b')), 'a😀b');
});

test('来了新的第 0 块就丢掉没拼完的', () => {
  const a = new ClipAssembler();
  assert.equal(a.add(chunk('c1', 0, 3, '没拼完的')), null);
  assert.equal(a.add(chunk('c2', 0, 2, '新的一段，')), null);
  assert.equal(a.add(chunk('c2', 1, 2, '拼完了')), '新的一段，拼完了');
});

test('对不上的块让整段作废', () => {
  const a = new ClipAssembler();
  // 缺了第 1 块
  assert.equal(a.add(chunk('c1', 0, 3, 'a')), null);
  assert.equal(a.add(chunk('c1', 2, 3, 'c')), null);
  // 丢掉以后，这一段后面的块也不认
  assert.equal(a.add(chunk('c1', 1, 3, 'b')), null);
  assert.equal(a.add(chunk('c1', 2, 3, 'c')), null);
  // 换了 id
  assert.equal(a.add(chunk('c2', 0, 2, 'a')), null);
  assert.equal(a.add(chunk('c3', 1, 2, 'b')), null);
  // 总数变了
  assert.equal(a.add(chunk('c4', 0, 2, 'a')), null);
  assert.equal(a.add(chunk('c4', 1, 3, 'b')), null);
  // 没有第 0 块就来了后面的
  assert.equal(new ClipAssembler().add(chunk('c5', 1, 2, 'b')), null);
  // 之后新的一段照常
  assert.equal(a.add(chunk('c6', 0, 1, '好的')), '好的');
});

test('超过长度上限的整段丢掉', () => {
  const a = new ClipAssembler();
  const big = '长'.repeat(ClipAssembler.MAX_CHARS / 2);
  assert.equal(a.add(chunk('c1', 0, 3, big)), null);
  assert.equal(a.add(chunk('c1', 1, 3, big)), null);
  assert.equal(a.add(chunk('c1', 2, 3, '多出来的')), null);
  // 正好到上限的可以
  assert.equal(a.add(chunk('c2', 0, 2, big)), null);
  assert.equal(a.add(chunk('c2', 1, 2, big))?.length, ClipAssembler.MAX_CHARS);
});

test('块号离谱的不认', () => {
  const a = new ClipAssembler();
  assert.equal(a.add(chunk('c1', 0, 0, 'a')), null);
  assert.equal(a.add(chunk('c1', 3, 2, 'a')), null);
  assert.equal(a.add(chunk('c1', 0, ClipAssembler.MAX_CHUNKS + 1, 'a')), null);
  assert.equal(a.add(chunk('c1', 0, 1, 'a')), 'a');
});
