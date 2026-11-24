// 对照 android/app/src/test/.../video/ViewportTest.kt
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Viewport } from '../entry/src/main/ets/logic/Viewport';
import type { RemotePoint } from '../entry/src/main/ets/logic/RemotePoint';

const EPS = 1e-4;

function near(actual: number, expected: number, eps: number): void {
  assert.ok(Math.abs(actual - expected) <= eps, `期望 ${expected}，实际 ${actual}`);
}

function nn(p: RemotePoint | null): RemotePoint {
  assert.notEqual(p, null);
  return p as RemotePoint;
}

/** 854×1380 的竖长窗口，显示在 1080×1600 的手机画面区里 */
function phone(): Viewport {
  const vp = new Viewport();
  vp.setStageSize(1080, 1600);
  vp.setVideoSize(854, 1380);
  return vp;
}

test('高度受限时完整显示并水平居中', () => {
  const vp = phone();
  near(vp.fit, 1600 / 1380, 1e-5);
  near(vp.displayH, 1600, 0.01);
  near(vp.panX, (1080 - vp.displayW) / 2, 0.01);
  near(vp.panY, 0, 0.01);
});

test('中心点对应画面中间', () => {
  const p = nn(phone().toRemote(540, 800));
  near(p.x, 0.5, EPS);
  near(p.y, 0.5, EPS);
});

test('黑边上返回 null，clampEdge 时贴边', () => {
  const vp = phone();
  assert.equal(vp.toRemote(5, 800), null);
  near(nn(vp.toRemote(5, 800, true)).x, 0, EPS);
});

test('缩放时手指下的内容不动', () => {
  const vp = phone();
  const before = nn(vp.toRemote(600, 900));
  vp.zoomAt(600, 900, 3);
  const after = nn(vp.toRemote(600, 900));
  near(after.x, before.x, EPS);
  near(after.y, before.y, EPS);
  assert.ok(vp.isZoomed);
});

test('缩放倍数限制在 1 到 MAX_ZOOM', () => {
  const vp = phone();
  vp.zoomAt(500, 500, 100);
  near(vp.zoom, Viewport.MAX_ZOOM, 1e-5);
  vp.zoomAt(500, 500, 0.1);
  near(vp.zoom, 1, 1e-5);
});

test('放大后平移不露黑边', () => {
  const vp = phone();
  vp.zoomAt(540, 800, 4);
  vp.panBy(100000, 100000);
  near(vp.panX, 0, 0.01);
  near(vp.panY, 0, 0.01);
  vp.panBy(-1e7, -1e7);
  near(vp.panX, 1080 - vp.displayW, 0.01);
  near(vp.panY, 1600 - vp.displayH, 0.01);
});

test('视频分辨率变了就还原缩放', () => {
  const vp = phone();
  vp.zoomAt(540, 800, 2);
  assert.equal(vp.setVideoSize(1280, 2088), true);
  assert.equal(vp.isZoomed, false);
  assert.equal(vp.setVideoSize(1280, 2088), false);
});

test('remotePerScreenPx 是 scale 的倒数', () => {
  const vp = phone();
  near(vp.remotePerScreenPx, 1 / vp.scale, 1e-6);
  vp.zoomAt(540, 800, 2);
  near(vp.remotePerScreenPx, 1 / vp.scale, 1e-6);
});

test('没有内容时什么都换算不了', () => {
  assert.equal(new Viewport().toRemote(10, 10), null);
});
