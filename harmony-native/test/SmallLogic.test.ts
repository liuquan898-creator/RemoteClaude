// 对照 android/app/src/test/.../image/ImageSizingTest.kt、input/FontZoomTest.kt、ui/TimeTextTest.kt、
// update/ResumableDownloadTest.kt 的 contentRangeParsing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageSizing } from '../entry/src/main/ets/logic/ImageSizing';
import { FontZoom } from '../entry/src/main/ets/logic/FontZoom';
import { TimeText } from '../entry/src/main/ets/logic/TimeText';
import { ResumableDownload } from '../entry/src/main/ets/logic/ResumableDownload';
import { keyEvent } from '../entry/src/main/ets/protocol/Protocol';

// ------------------------------------------------------------------ ImageSizing

test('小图不采样也不缩放', () => {
  assert.equal(ImageSizing.sampleSize(1080, 2424), 1);
  assert.deepEqual(ImageSizing.fit(1080, 1920), { width: 1080, height: 1920 });
  assert.deepEqual(ImageSizing.fit(2048, 1000), { width: 2048, height: 1000 });
});

test('采样率保证长边不小于上限', () => {
  assert.equal(ImageSizing.sampleSize(4000, 3000), 1);
  assert.equal(ImageSizing.sampleSize(4096, 3072), 2);
  assert.equal(ImageSizing.sampleSize(6144, 8160), 2);
  assert.equal(ImageSizing.sampleSize(8192, 6000), 4);
});

test('fit 把长边缩到上限并保持比例', () => {
  assert.deepEqual(ImageSizing.fit(4000, 3000), { width: 2048, height: 1536 });
  assert.deepEqual(ImageSizing.fit(3000, 4000), { width: 1536, height: 2048 });
  assert.deepEqual(ImageSizing.fit(10, 30000), { width: 1, height: 2048 });
});

test('退化的尺寸原样返回', () => {
  assert.deepEqual(ImageSizing.fit(0, 0), { width: 0, height: 0 });
  assert.equal(ImageSizing.sampleSize(0, 0), 1);
  assert.equal(ImageSizing.sampleSize(100, 100, 0), 1);
});

// ------------------------------------------------------------------ FontZoom

test('发给电脑的是 Claude 的三个缩放快捷键', () => {
  const event = (z: FontZoom): string => keyEvent(z.key, z.mods);
  assert.equal(event(FontZoom.Larger), '{"t":"k","k":"=","m":1}');
  assert.equal(event(FontZoom.Smaller), '{"t":"k","k":"-","m":1}');
  assert.equal(event(FontZoom.Reset), '{"t":"k","k":"0","m":1}');
});

test('按钮从左到右：缩小、默认、放大', () => {
  assert.deepEqual(
    FontZoom.entries.map((z) => z.label),
    ['缩小', '默认', '放大'],
  );
  assert.equal(FontZoom.Larger.name, 'Larger');
});

// ------------------------------------------------------------------ TimeText

const SHANGHAI = 480;

function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h, mi) - SHANGHAI * 60000;
}

test('最后活动时间的简短说法', () => {
  const now = at(2026, 11, 18, 21, 30);
  assert.equal(TimeText.ago(0, now, SHANGHAI), '');
  assert.equal(TimeText.ago(now - 20_000, now, SHANGHAI), '刚刚');
  assert.equal(TimeText.ago(now + 90_000, now, SHANGHAI), '刚刚'); // 电脑时钟快了一点
  assert.equal(TimeText.ago(at(2026, 11, 18, 21, 25), now, SHANGHAI), '5 分钟前');
  assert.equal(TimeText.ago(at(2026, 11, 18, 18, 10), now, SHANGHAI), '3 小时前');
  assert.equal(TimeText.ago(at(2026, 11, 17, 23, 50), now, SHANGHAI), '昨天');
  assert.equal(TimeText.ago(at(2026, 11, 12, 9, 0), now, SHANGHAI), '11月12日');
  assert.equal(TimeText.ago(at(2025, 3, 4, 9, 0), now, SHANGHAI), '2025年3月4日');
});

test('刚过零点时前一天晚上算昨天', () => {
  const now = at(2026, 1, 1, 0, 30);
  assert.equal(TimeText.ago(at(2025, 12, 31, 22, 0), now, SHANGHAI), '昨天');
});

test('时区决定是不是同一天', () => {
  // 北京时间 1 月 2 日 01:00 和 1 月 1 日 22:00：北京算昨天，UTC 下是同一天（17:00 和 14:00）
  const now = at(2026, 1, 2, 1, 0);
  const then = at(2026, 1, 1, 22, 0);
  assert.equal(TimeText.ago(then, now, SHANGHAI), '昨天');
  assert.equal(TimeText.ago(then, now, 0), '3 小时前');
  // 不传时区用本机时区，至少能给出一个结果
  assert.notEqual(TimeText.ago(then, now), '');
});

// ------------------------------------------------------------------ ResumableDownload

test('续传回应的解析', () => {
  assert.equal(ResumableDownload.resumeOffset(200, null, 500), 0);
  assert.equal(ResumableDownload.resumeOffset(206, 'bytes 500-999/1000', 500), 500);
  assert.equal(ResumableDownload.resumeOffset(206, 'bytes 0-999/1000', 500), null); // 起点对不上不能接
  assert.equal(ResumableDownload.resumeOffset(206, null, 500), null);
  assert.equal(ResumableDownload.resumeOffset(204, null, 0), null);
  assert.equal(ResumableDownload.totalFromContentRange('bytes 500-999/1000'), 1000);
  assert.equal(ResumableDownload.totalFromContentRange(' bytes 500-999/1000 '), 1000);
  assert.equal(ResumableDownload.totalFromContentRange('bytes 500-999/*'), null);
  assert.equal(ResumableDownload.totalFromContentRange(null), null);
});

test('半截文件名和 Range 头', () => {
  assert.equal(ResumableDownload.partName('0123456789abcdef0123', 'app.hap'), '0123456789abcdef.part');
  assert.equal(ResumableDownload.partName('', 'app.hap'), 'app.hap.part');
  assert.equal(ResumableDownload.rangeHeader(0), '');
  assert.equal(ResumableDownload.rangeHeader(1234), 'bytes=1234-');
});
