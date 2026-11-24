/**
 * 从手机关掉电脑上的会话窗口（协议文档 2.8）：回执怎么处理、提示什么。
 * 关闭只是关掉电脑上的窗口，会话不删，在后台照常跑，"全部会话"里能再打开（docs/07 第 4 节）。
 * 对照安卓端 windows/WindowClose.kt。
 */
export class WindowClose {
  /** 电脑上的被控端从这个版本起认关闭窗口的请求 */
  static readonly MIN_HOST_VERSION = '0.9.1';

  /** 电脑最多等 3 秒窗口消失，再加上生成新列表和网络来回 */
  static readonly TIMEOUT_MS = 10000;

  /** 被控端是旧版本、不认关闭请求时的说明 */
  static readonly UNSUPPORTED_TEXT =
    `从手机关闭会话窗口要电脑上的被控端 ${WindowClose.MIN_HOST_VERSION} 或更新的版本。可以让它现在升级，升级时被控端会重启，几十秒后自动重连。`;

  /** 卡片该不该拿掉：关掉了，或者电脑上本来就没有这个窗口了 */
  static removesCard(ok: boolean, code: string): boolean {
    return ok || code === 'gone';
  }

  /** 回执对应的提示；关掉了也提示一句，说明会话还在 */
  static resultText(ok: boolean, code: string, title: string): string {
    const name = title.length > 0 ? title : '这个窗口';
    if (ok) return `已关闭「${name}」，会话还在「全部会话」里`;
    switch (code) {
      case 'gone':
        return `「${name}」已经关掉了`;
      case 'changed':
        return '这个窗口刚换成了别的会话，没有关，列表已刷新';
      case 'not-closable':
        return 'Claude 主窗口不能从手机关';
      case 'still-open':
        return `电脑上的「${name}」没有关掉，请在电脑上看看`;
      default:
        return `没能关掉「${name}」（${code}）`;
    }
  }
}
