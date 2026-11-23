'use strict';
/**
 * 应答控制端的 list（协议文档 2.3、2.4）。
 *
 * 窗口的标题、个数枚举一下就有，只要几毫秒；缩略图要给电脑上所有窗口各截一张，花掉大半秒，
 * 几十 KB 的图还要经服务器转给手机。两样捆在一条消息里，"已打开"列表就比只传文字的"全部会话"慢一截。
 * 所以控制端说了缩略图可以后补（list 带 thumbs: "later"）时分两次回：
 * 先回不带图的列表（thumbs: "pending"），截完图再回一份带图的（thumbs: "done"）。
 * 旧版控制端的 list 不带这个字段，照旧只回一份带图的。
 *
 * 被控端页面用 <script> 直接加载（挂到 window.RcWinList），测试里用 require。
 */
(function (root) {
  /**
   * @param {object} msg 服务器转发来的 list（带 from）
   * @param {(opts?: { thumbs: boolean }) => Promise<object[]>} listWindows 主进程的窗口列表，opts.thumbs 为 false 时不截图
   * @param {(obj: object) => void} send
   */
  async function reply(msg, listWindows, send) {
    const to = msg.from;
    if (msg.thumbs !== 'later') {
      send({ type: 'windows', to, list: await listWindows() });
      return;
    }
    send({ type: 'windows', to, thumbs: 'pending', list: await listWindows({ thumbs: false }) });
    send({ type: 'windows', to, thumbs: 'done', list: await listWindows() });
  }

  const api = { reply };
  root.RcWinList = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
