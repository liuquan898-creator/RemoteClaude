'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reply } = require('../winlist');

/** 假的主进程窗口列表：不要缩略图时马上回，要缩略图时等测试放行（模拟截图要花的时间） */
function fakeLister() {
  const calls = [];
  let release;
  const captured = new Promise((resolve) => (release = resolve));
  const listWindows = async (opts) => {
    calls.push(opts);
    if (opts && opts.thumbs === false) return [{ hwnd: 1, title: 'a', thumb: null }];
    await captured;
    return [{ hwnd: 1, title: 'a', thumb: 'data:image/jpeg;base64,AAAA' }];
  };
  return { calls, listWindows, release };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('旧版控制端的 list：只回一份带缩略图的列表', async () => {
  const { calls, listWindows, release } = fakeLister();
  const sent = [];
  const done = reply({ type: 'list', from: 'v1' }, listWindows, (m) => sent.push(m));
  await tick();
  assert.deepEqual(sent, []); // 截图没完，什么都还没发
  release();
  await done;
  assert.deepEqual(calls, [undefined]);
  assert.deepEqual(sent, [{ type: 'windows', to: 'v1', list: [{ hwnd: 1, title: 'a', thumb: 'data:image/jpeg;base64,AAAA' }] }]);
});

test('缩略图可以后补：不等截图先回列表，截完再补一份', async () => {
  const { calls, listWindows, release } = fakeLister();
  const sent = [];
  const done = reply({ type: 'list', from: 'v2', thumbs: 'later' }, listWindows, (m) => sent.push(m));
  await tick();
  // 截图还卡着，不带图的列表已经发出去了
  assert.deepEqual(sent, [{ type: 'windows', to: 'v2', thumbs: 'pending', list: [{ hwnd: 1, title: 'a', thumb: null }] }]);
  release();
  await done;
  assert.deepEqual(calls, [{ thumbs: false }, undefined]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], { type: 'windows', to: 'v2', thumbs: 'done', list: [{ hwnd: 1, title: 'a', thumb: 'data:image/jpeg;base64,AAAA' }] });
});

test('thumbs 是别的值时按旧版处理', async () => {
  const { listWindows, release } = fakeLister();
  const sent = [];
  release();
  await reply({ type: 'list', from: 'v3', thumbs: true }, listWindows, (m) => sent.push(m));
  assert.equal(sent.length, 1);
  assert.equal('thumbs' in sent[0], false);
});
