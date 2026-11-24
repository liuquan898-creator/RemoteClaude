/**
 * 拆出来的一段。对照安卓端 CodeSpans.Part（Plain / Code 两个子类）：
 * ArkTS 不好用辨识联合，这里做成一个接口，code 为 true 表示是要原样复制的代码
 */
export interface CodeSpanPart {
  code: boolean;
  text: string;
}

function isWs(c: string): boolean {
  return /\s/.test(c);
}

function isBlank(s: string): boolean {
  return s.trim().length === 0;
}

/** 去掉首尾的 \n 和 \r（对照 Kotlin 的 trim('\n', '\r')） */
function trimNewlines(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s.charAt(start) === '\n' || s.charAt(start) === '\r')) start++;
  while (end > start && (s.charAt(end - 1) === '\n' || s.charAt(end - 1) === '\r')) end--;
  return s.substring(start, end);
}

/**
 * 把 Claude 提问里的文字按 Markdown 的代码写法拆开（docs/09 第 6 节）：
 * 用反引号括起来的（`命令` 或 ```代码块```）是要用户原样复制的内容，手机上单独显示并带"复制"按钮。
 * 没配对的反引号当普通文字。对照安卓端 ui/CodeSpans.kt。
 */
export class CodeSpans {
  static split(s: string): CodeSpanPart[] {
    const out: CodeSpanPart[] = [];
    let plain = '';
    const flush = (): void => {
      if (plain.length > 0) {
        out.push({ code: false, text: plain });
        plain = '';
      }
    };
    let i = 0;
    while (i < s.length) {
      if (s.charAt(i) !== '`') {
        plain += s.charAt(i);
        i++;
        continue;
      }
      const n = CodeSpans.runLength(s, i);
      const close = CodeSpans.findClose(s, i + n, n);
      if (close < 0) {
        plain += s.substring(i, i + n);
        i += n;
        continue;
      }
      const raw = s.substring(i + n, close);
      const body = n >= 3 ? CodeSpans.fencedBody(raw) : CodeSpans.inlineBody(raw);
      if (isBlank(body)) {
        plain += s.substring(i, close + n);
      } else {
        flush();
        out.push({ code: true, text: body });
      }
      i = close + n;
    }
    flush();
    return out;
  }

  private static runLength(s: string, from: number): number {
    let n = 0;
    while (from + n < s.length && s.charAt(from + n) === '`') n++;
    return n;
  }

  /** 找长度正好是 n 的一串反引号；更长或更短的串跳过 */
  private static findClose(s: string, from: number, n: number): number {
    let j = from;
    while (j < s.length) {
      const k = s.indexOf('`', j);
      if (k < 0) return -1;
      const r = CodeSpans.runLength(s, k);
      if (r === n) return k;
      j = k + r;
    }
    return -1;
  }

  /** 代码块：第一行是语言名（或空）就去掉，再去掉首尾换行 */
  private static fencedBody(raw: string): string {
    let body = raw;
    const nl = body.indexOf('\n');
    if (nl >= 0) {
      const first = body.substring(0, nl).trim();
      let hasWs = false;
      for (let i = 0; i < first.length; i++) {
        if (isWs(first.charAt(i))) {
          hasWs = true;
          break;
        }
      }
      if (!hasWs) body = body.substring(nl + 1);
    }
    return trimNewlines(body);
  }

  /** 行内代码：两头各有一个空格时各去掉一个（和 Markdown 一样） */
  private static inlineBody(raw: string): string {
    if (raw.length >= 2 && raw.startsWith(' ') && raw.endsWith(' ') && !isBlank(raw)) {
      return raw.substring(1, raw.length - 1);
    }
    return raw;
  }
}
