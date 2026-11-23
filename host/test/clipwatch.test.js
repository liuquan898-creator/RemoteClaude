'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClipWatch, chunkText, buildMessages, MAX_CHARS, CHUNK_CHARS } = require('../clipwatch');

/**
 * 假的剪贴板：copy() 相当于电脑上有人复制了一段文字。
 * 时间是假的，sleep 只把钟往前拨，不真的等。
 */
function fakeClipboard() {
  const c = {
    seq: 10,
    text: '',
    hasText: true,
    excluded: false,
    locked: false,
    clock: 1000,
    reads: 0,
    sent: [],
    logs: [],
    /** 每次 readText 之前调一下，用来模拟"读的过程中又变了"、"先读出空的" */
    beforeRead: null,
    copy(text) {
      c.text = text;
      c.hasText = true;
      c.seq += 1;
    },
  };
  c.watch = createClipWatch({
    seq: () => c.seq,
    hasText: () => c.hasText,
    excluded: () => c.excluded,
    locked: () => c.locked,
    readText: async () => {
      c.reads += 1;
      if (c.beforeRead) {
        const r = c.beforeRead(c.reads);
        if (r !== undefined) return r;
      }
      return c.text;
    },
    emit: (msgs) => c.sent.push(msgs),
    log: (m) => c.logs.push(m),
    sleep: async (ms) => {
      c.clock += ms;
    },
    now: () => c.clock,
  });
  return c;
}

/** 把发出去的 clip 消息拼回文字 */
function joined(msgs) {
  return msgs.map((m) => m.s).join('');
}

test('开始看之前已有的内容不发，之后复制的才发', async () => {
  const c = fakeClipboard();
  c.text = '早就在剪贴板里的';
  c.watch.start();
  await c.watch.tick();
  assert.deepEqual(c.sent, []);
  assert.equal(c.reads, 0);

  c.copy('新复制的');
  await c.watch.tick();
  assert.equal(c.sent.length, 1);
  assert.deepEqual(c.sent[0], [{ t: 'clip', id: 'c1', i: 0, n: 1, s: '新复制的' }]);

  await c.watch.tick(); // 没再变
  assert.equal(c.sent.length, 1);
  c.watch.stop();
});

test('没人看的时候不读剪贴板；重新开始看时从当时的序号算起', async () => {
  const c = fakeClipboard();
  c.copy('没人看时复制的');
  await c.watch.tick();
  assert.equal(c.reads, 0);

  c.watch.start();
  c.watch.stop();
  c.copy('停了以后复制的');
  await c.watch.tick();
  assert.equal(c.reads, 0);

  c.watch.start();
  await c.watch.tick();
  assert.deepEqual(c.sent, []);
  c.watch.stop();
});

test('换行转成 LF；日志里只有长度没有内容', async () => {
  const c = fakeClipboard();
  c.watch.start();
  c.copy('第一行\r\n第二行\r第三行');
  await c.watch.tick();
  assert.equal(joined(c.sent[0]), '第一行\n第二行\n第三行');
  assert.ok(c.logs.some((l) => l.includes('11 个字符')));
  assert.ok(!c.logs.some((l) => l.includes('第一行')));
  c.watch.stop();
});

test('被控端自己写进去的不发回去', async () => {
  const c = fakeClipboard();
  c.watch.start();
  await c.watch.ownWrite(async () => c.copy('手机发来的长文字\r\n第二行'), '手机发来的长文字\n第二行');
  await c.watch.tick();
  assert.deepEqual(c.sent, []);
  assert.equal(c.reads, 0);
  c.watch.stop();
});

test('自己写的过程中不读；写完以后序号才又动了一下，读到的还是自己那份也不发', async () => {
  const c = fakeClipboard();
  c.watch.start();
  let midTick;
  await c.watch.ownWrite(async () => {
    c.copy('C:\\Users\\a\\Downloads\\RemoteClaude\\报告.pdf ');
    midTick = c.watch.tick(); // 正写着的时候定时器到了
    await midTick;
  }, 'C:\\Users\\a\\Downloads\\RemoteClaude\\报告.pdf ');
  assert.equal(c.reads, 0);

  c.seq += 1; // 系统在写完之后又动了一下序号，内容没变
  await c.watch.tick();
  assert.equal(c.reads, 1);
  assert.deepEqual(c.sent, []);

  // 过了一阵，电脑上的人真的复制了同样的文字：要发
  c.clock += 5000;
  c.copy('C:\\Users\\a\\Downloads\\RemoteClaude\\报告.pdf ');
  await c.watch.tick();
  assert.equal(c.sent.length, 1);
  c.watch.stop();
});

test('自己写的是图片时，之后电脑上复制文字照常发', async () => {
  const c = fakeClipboard();
  c.watch.start();
  await c.watch.ownWrite(async () => {
    c.seq += 1;
    c.hasText = false;
  });
  await c.watch.tick();
  assert.deepEqual(c.sent, []);
  c.copy('图片之后复制的文字');
  await c.watch.tick();
  assert.equal(joined(c.sent[0]), '图片之后复制的文字');
  c.watch.stop();
});

test('没有文字（图片、文件）、锁屏、标了不让监视的都不读', async () => {
  const c = fakeClipboard();
  c.watch.start();

  c.seq += 1;
  c.hasText = false;
  await c.watch.tick();

  c.copy('锁屏时的');
  c.locked = true;
  await c.watch.tick();
  c.locked = false;

  c.copy('密码管理器里的密码');
  c.excluded = true;
  await c.watch.tick();
  c.excluded = false;

  assert.equal(c.reads, 0);
  assert.deepEqual(c.sent, []);
  assert.ok(c.logs.some((l) => l.includes('不让监视')));
  assert.ok(!c.logs.some((l) => l.includes('密码管理器里的密码')));

  // 上面几次都算看过了，不会在条件恢复后补发
  await c.watch.tick();
  assert.deepEqual(c.sent, []);
  c.watch.stop();
});

test('序号还在变就先不读，稳定下来再读', async () => {
  const c = fakeClipboard();
  let bumped = false;
  const watch = createClipWatch({
    seq: () => c.seq,
    hasText: () => true,
    excluded: () => false,
    locked: () => false,
    readText: async () => ((c.reads += 1), c.text),
    emit: (msgs) => c.sent.push(msgs),
    sleep: async () => {
      // 第一次等的时候，复制的程序又写了一步
      if (!bumped) {
        bumped = true;
        c.copy('写完整了');
      }
    },
    now: () => c.clock,
  });
  watch.start();
  c.copy('写了一半');
  await watch.tick();
  assert.equal(c.reads, 0);
  await watch.tick();
  assert.equal(c.reads, 1);
  assert.equal(joined(c.sent[0]), '写完整了');
  watch.stop();
});

test('读的过程中又变了：这次读到的不发，下一轮重读', async () => {
  const c = fakeClipboard();
  c.watch.start();
  c.copy('第一份');
  c.beforeRead = (n) => {
    if (n === 1) c.copy('第二份');
  };
  await c.watch.tick();
  assert.deepEqual(c.sent, []);
  await c.watch.tick();
  assert.equal(c.sent.length, 1);
  assert.equal(joined(c.sent[0]), '第二份');
  c.watch.stop();
});

test('有文字却读出空的（剪贴板被占着）：隔一会儿再读', async () => {
  const c = fakeClipboard();
  c.watch.start();
  c.copy('第二次才读到');
  c.beforeRead = (n) => (n === 1 ? '' : undefined);
  await c.watch.tick();
  assert.equal(c.reads, 2);
  assert.equal(joined(c.sent[0]), '第二次才读到');

  c.copy('一直读不到');
  c.beforeRead = () => {
    throw new Error('占用');
  };
  await c.watch.tick();
  assert.equal(c.reads, 5);
  assert.equal(c.sent.length, 1);
  c.watch.stop();
});

test('一次复制让序号变了几回：同样的文字短时间内只发一次，隔久了再复制照发', async () => {
  const c = fakeClipboard();
  c.watch.start();
  c.copy('同一段');
  await c.watch.tick();
  c.seq += 1;
  await c.watch.tick();
  assert.equal(c.sent.length, 1);

  c.clock += 2000;
  c.copy('同一段');
  await c.watch.tick();
  assert.equal(c.sent.length, 2);
  assert.equal(c.sent[1][0].id, 'c2');
  c.watch.stop();
});

test('太长的不发内容，只告诉控制端', async () => {
  const c = fakeClipboard();
  c.watch.start();
  c.copy('长'.repeat(MAX_CHARS + 1));
  await c.watch.tick();
  assert.deepEqual(c.sent, [[{ t: 'clip-skip', code: 'too-large' }]]);

  c.copy('长'.repeat(MAX_CHARS));
  await c.watch.tick();
  assert.equal(c.sent.length, 2);
  assert.equal(joined(c.sent[1]).length, MAX_CHARS);
  c.watch.stop();
});

test('长文字切成几条，顺序和总数都带上，拼回去一字不差', () => {
  const text = '中文English😀\n'.repeat(1200);
  const msgs = buildMessages('c9', text);
  assert.equal(msgs.length, Math.ceil(text.length / CHUNK_CHARS));
  msgs.forEach((m, i) => {
    assert.equal(m.t, 'clip');
    assert.equal(m.id, 'c9');
    assert.equal(m.i, i);
    assert.equal(m.n, msgs.length);
    assert.ok(m.s.length <= CHUNK_CHARS);
    // 每条编码后都远小于数据通道单条消息的安全大小
    assert.ok(Buffer.byteLength(JSON.stringify(m), 'utf8') < 16 * 1024);
  });
  assert.equal(joined(msgs), text);
});

test('切块不把表情切成两半', () => {
  const parts = chunkText('a😀b😀c', 2);
  assert.deepEqual(parts, ['a', '😀', 'b', '😀', 'c']);
  for (const p of parts) assert.ok(!/[\ud800-\udbff]$/.test(p));
  assert.deepEqual(chunkText('', 4), []);
  assert.deepEqual(chunkText('abcd', 4), ['abcd']);
  assert.deepEqual(chunkText('abcde', 4), ['abcd', 'e']);
});
