'use strict';
/**
 * 改写控制端发回的 answer，给视频编码加上起步码率（x-google-start-bitrate，单位 kbps）。
 *
 * Chromium 发送端的带宽估计默认从 300kbps 起步，满屏文字一滚动就要好几 Mbps，
 * 每次打开画面都要二十多秒才爬上去，刚打开就滑会卡（docs/05 的 2.14）。
 * 发送端的起步值取自对方描述里这个编码的参数，所以改的是收到的 answer，不是自己的 offer。
 *
 * 被控端页面用 <script> 直接加载（挂到 window.RcSdp），测试里用 require。
 */
(function (root) {
  const VIDEO_CODECS = new Set(['vp8', 'vp9', 'h264', 'av1', 'h265']);

  /** 一个 m= 段里的视频编码号（不含 rtx、red、ulpfec） */
  function codecPts(section) {
    const pts = new Set();
    for (const l of section) {
      const m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(l);
      if (m && VIDEO_CODECS.has(m[2].toLowerCase())) pts.add(m[1]);
    }
    return pts;
  }

  function patchVideoSection(section, rate) {
    const pts = codecPts(section);
    const seen = new Set();
    const out = section.map((l) => {
      const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
      if (!f || !pts.has(f[1])) return l;
      seen.add(f[1]);
      const params = f[2].split(';').filter((p) => p.trim() && !/^\s*x-google-start-bitrate=/.test(p));
      params.push(`x-google-start-bitrate=${rate}`);
      return `a=fmtp:${f[1]} ${params.join(';')}`;
    });
    // 没有 fmtp 行的编码（比如 VP8）在 rtpmap 后面补一行
    for (const pt of pts) {
      if (seen.has(pt)) continue;
      const i = out.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
      out.splice(i + 1, 0, `a=fmtp:${pt} x-google-start-bitrate=${rate}`);
    }
    return out;
  }

  /**
   * @param {string} sdp
   * @param {number} kbps 不是正数时原样返回
   * @returns {string}
   */
  function withStartBitrate(sdp, kbps) {
    const rate = Math.round(Number(kbps));
    if (typeof sdp !== 'string' || !(rate > 0)) return sdp;
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    // 按 m= 行切段：第一段是会话级的行
    const sections = [[]];
    for (const l of sdp.split(/\r?\n/)) {
      if (l.startsWith('m=')) sections.push([]);
      sections[sections.length - 1].push(l);
    }
    return sections
      .map((s) => (s.length && s[0].startsWith('m=video ') ? patchVideoSection(s, rate) : s))
      .flat()
      .join(eol);
  }

  const api = { withStartBitrate };
  root.RcSdp = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
