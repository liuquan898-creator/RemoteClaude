// 安卓端 InputSender 没有单元测试，这里补上：单击的事件顺序、滚轮 16 毫秒合并、小数留到下一次、单条上限、reset
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputSender } from '../entry/src/main/ets/logic/InputSender';
import type { InputTimers } from '../entry/src/main/ets/logic/InputSender';
import { BUTTON_RIGHT, MOD_SHIFT } from '../entry/src/main/ets/protocol/Protocol';

/** 手动推进的假定时器 */
class FakeTimers implements InputTimers {
  now = 0;
  private nextId = 1;
  private pending = new Map<number, { at: number; fn: () => void }>();

  schedule(fn: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + delayMs, fn });
    return id;
  }

  cancel(handle: number): void {
    this.pending.delete(handle);
  }

  get count(): number {
    return this.pending.size;
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let firstId = -1;
      let firstAt = Infinity;
      for (const [id, t] of this.pending) {
        if (t.at <= end && t.at < firstAt) {
          firstAt = t.at;
          firstId = id;
        }
      }
      if (firstId < 0) break;
      const t = this.pending.get(firstId)!;
      this.pending.delete(firstId);
      this.now = t.at;
      t.fn();
    }
    this.now = end;
  }
}

function setup(open = true): { sent: Record<string, unknown>[]; timers: FakeTimers; input: InputSender } {
  const sent: Record<string, unknown>[] = [];
  const timers = new FakeTimers();
  const input = new InputSender((text) => {
    if (!open) return false;
    sent.push(JSON.parse(text) as Record<string, unknown>);
    return true;
  }, timers);
  return { sent, timers, input };
}

const P = { x: 0.25, y: 0.75 };

test('单击按顺序发移动、按下、松开', () => {
  const { sent, input } = setup();
  assert.equal(input.click(P, BUTTON_RIGHT), true);
  assert.deepEqual(sent, [
    { t: 'm', x: 0.25, y: 0.75 },
    { t: 'd', x: 0.25, y: 0.75, b: 2 },
    { t: 'u', x: 0.25, y: 0.75, b: 2 },
  ]);
});

test('通道没开时单击返回 false', () => {
  const { input } = setup(false);
  assert.equal(input.click(P, 0), false);
  assert.equal(input.key('Enter', 0), false);
  assert.equal(input.text('x'), false);
});

test('按键和文字直接发', () => {
  const { sent, input } = setup();
  assert.equal(input.key('Enter', MOD_SHIFT), true);
  assert.equal(input.text('你好 😀'), true);
  assert.deepEqual(sent, [
    { t: 'k', k: 'Enter', m: 2 },
    { t: 't', s: '你好 😀' },
  ]);
});

test('16 毫秒内的滚动合并成一条', () => {
  const { sent, timers, input } = setup();
  input.wheel(P, 0, 50);
  input.wheel(P, 0, 50);
  input.wheel({ x: 0.5, y: 0.5 }, 10, 20.5);
  assert.equal(sent.length, 0);
  timers.advance(15);
  assert.equal(sent.length, 0);
  timers.advance(1);
  // 用最后一次的位置；小数部分 0.5 留着，不够 1 不再发
  assert.deepEqual(sent, [{ t: 'w', x: 0.5, y: 0.5, dx: 10, dy: 120 }]);
  assert.equal(timers.count, 0);
});

test('滚动的小数部分留到下一次', () => {
  const { sent, timers, input } = setup();
  input.wheel(P, 0, 0.6);
  timers.advance(16);
  assert.equal(sent.length, 0); // 不满 1 不发
  input.wheel(P, 0, 0.6);
  timers.advance(16);
  assert.deepEqual(sent, [{ t: 'w', x: 0.25, y: 0.75, dx: 0, dy: 1 }]);
  // 余下 0.2，再来 -1.5 → -1.3，向零取整发 -1
  input.wheel(P, 0, -1.5);
  timers.advance(16);
  assert.deepEqual(sent[1], { t: 'w', x: 0.25, y: 0.75, dx: 0, dy: -1 });
});

test('超过单条上限的分到后面几条里发，每 16 毫秒一条', () => {
  const { sent, timers, input } = setup();
  input.wheel(P, 0, -6000);
  timers.advance(16);
  assert.deepEqual(sent.map((m) => m['dy']), [-2400]);
  timers.advance(16);
  assert.deepEqual(sent.map((m) => m['dy']), [-2400, -2400]);
  timers.advance(16);
  assert.deepEqual(sent.map((m) => m['dy']), [-2400, -2400, -1200]);
  timers.advance(100);
  assert.equal(sent.length, 3);
});

test('reset 丢掉还没发的滚动量', () => {
  const { sent, timers, input } = setup();
  input.wheel(P, 0, 120);
  input.reset();
  assert.equal(timers.count, 0);
  timers.advance(100);
  assert.equal(sent.length, 0);
  // 之后照常
  input.wheel(P, 0, 0.4);
  input.wheel(P, 0, 0.7);
  timers.advance(16);
  assert.deepEqual(sent, [{ t: 'w', x: 0.25, y: 0.75, dx: 0, dy: 1 }]);
});

test('不传定时器时用全局 setTimeout', async () => {
  const sent: string[] = [];
  const input = new InputSender((text) => {
    sent.push(text);
    return true;
  });
  input.wheel(P, 0, 120);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sent.length, 1);
  input.reset();
});
