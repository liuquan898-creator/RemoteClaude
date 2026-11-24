import { MOD_CTRL } from '../protocol/Protocol';

/**
 * 调电脑上 Claude 的字体大小：给正在看的窗口按 Claude 自己的缩放快捷键。走的是现成的按键事件（协议文档 4.3），
 * 被控端不用改。用户的要求（2026-11-22）："手机上需要调大字体才能看得更清楚一点"。
 *
 * 快捷键是从 Claude 桌面端 6.28899 的程序包里读出来的：Ctrl+= 放大（菜单上写的是 Ctrl+加号，等号是它另外认的一个
 * 不显示的快捷键），Ctrl+- 缩小，Ctrl+0 还原。按一下变一档（约 10%），范围 25%～500%，
 * 电脑上所有 Claude 窗口一起变，不只是正在看的这一个。
 *
 * 对照安卓端 input/FontZoom.kt 的枚举：做成只有三个静态实例的类，照样写 FontZoom.Larger.key，
 * FontZoom.entries 是按钮从左到右的顺序，比较用 ===。
 */
export class FontZoom {
  static readonly Smaller = new FontZoom('Smaller', '缩小', '-');
  static readonly Reset = new FontZoom('Reset', '默认', '0');
  static readonly Larger = new FontZoom('Larger', '放大', '=');

  /** 和 Kotlin 的 FontZoom.entries 一样，按声明顺序 */
  static readonly entries: FontZoom[] = [FontZoom.Smaller, FontZoom.Reset, FontZoom.Larger];

  /** 和 Kotlin 枚举的 name 一样 */
  readonly name: string;
  readonly label: string;
  readonly key: string;

  private constructor(name: string, label: string, key: string) {
    this.name = name;
    this.label = label;
    this.key = key;
  }

  /** 三个都是按住 Ctrl */
  get mods(): number {
    return MOD_CTRL;
  }
}
