'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withStartBitrate } = require('../sdp');

// 安卓端 answer 的样子（删减过）：VP9 有 fmtp，VP8 没有，rtx 指向 VP9
const ANSWER = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=video 9 UDP/TLS/RTP/SAVPF 98 99 96 97',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=rtpmap:98 VP9/90000',
  'a=rtcp-fb:98 nack',
  'a=fmtp:98 profile-id=0',
  'a=rtpmap:99 rtx/90000',
  'a=fmtp:99 apt=98',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=mid:1',
  'a=fmtp:98 should-not-change',
  '',
].join('\r\n');

test('起步码率：给视频编码的 fmtp 加上，没有 fmtp 的补一行，rtx 不动', () => {
  const out = withStartBitrate(ANSWER, 2500);
  const lines = out.split('\r\n');
  assert.ok(lines.includes('a=fmtp:98 profile-id=0;x-google-start-bitrate=2500'));
  assert.equal(lines[lines.indexOf('a=rtpmap:96 VP8/90000') + 1], 'a=fmtp:96 x-google-start-bitrate=2500');
  assert.ok(lines.includes('a=fmtp:99 apt=98'));
  assert.ok(lines.includes('a=fmtp:97 apt=96'));
  // 数据通道段里的同号行不动
  assert.ok(lines.includes('a=fmtp:98 should-not-change'));
  // 只多了一行，换行风格不变，结尾的空行还在
  assert.equal(lines.length, ANSWER.split('\r\n').length + 1);
  assert.ok(out.endsWith('\r\n'));
});

test('起步码率：已经有的值换成新的，重复改不会叠加', () => {
  const once = withStartBitrate(ANSWER, 2500);
  const twice = withStartBitrate(once, 3000);
  assert.ok(twice.includes('a=fmtp:98 profile-id=0;x-google-start-bitrate=3000'));
  assert.ok(twice.includes('a=fmtp:96 x-google-start-bitrate=3000'));
  assert.equal(twice.split('x-google-start-bitrate').length - 1, 2);
});

test('起步码率：值不对或不是字符串就原样返回；只有 \\n 换行也能处理', () => {
  assert.equal(withStartBitrate(ANSWER, 0), ANSWER);
  assert.equal(withStartBitrate(ANSWER, NaN), ANSWER);
  assert.equal(withStartBitrate(undefined, 2500), undefined);
  const lf = ANSWER.replace(/\r\n/g, '\n');
  const out = withStartBitrate(lf, 2000);
  assert.ok(!out.includes('\r'));
  assert.ok(out.includes('a=fmtp:98 profile-id=0;x-google-start-bitrate=2000'));
});

test('起步码率：H264 的 fmtp 参数保留原样', () => {
  const sdp = 'v=0\nm=video 9 UDP/TLS/RTP/SAVPF 102\na=rtpmap:102 H264/90000\na=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\n';
  assert.ok(
    withStartBitrate(sdp, 2500).includes('a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=2500'),
  );
});
