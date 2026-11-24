import type { ClipChunk } from './Protocol';

/**
 * 把电脑分块发来的剪贴板文字拼回去（协议 4.9），对照安卓端 protocol/ClipAssembler.kt。
 *
 * 数据通道有序可靠，同一段的各块按顺序到。收到第 0 块就开始新的一段（没拼完的上一段丢掉）；
 * 中途来了对不上的块（换了 id、总数变了、顺序不对），说明这一段不完整，整段丢掉，等下一段的第 0 块。
 */
export class ClipAssembler {
  /** 被控端一段最多发 100000 个字符、每块 4000 个，这里留了余量 */
  static readonly MAX_CHUNKS = 256;
  static readonly MAX_CHARS = 200000;

  private id: string | null = null;
  private count = 0;
  private next = 0;
  private parts: string[] = [];
  private length = 0;

  /** 收到一块。这一块让整段拼齐了就返回整段文字，否则返回 null */
  add(chunk: ClipChunk): string | null {
    if (chunk.count < 1 || chunk.count > ClipAssembler.MAX_CHUNKS || chunk.index < 0 || chunk.index >= chunk.count) {
      this.reset();
      return null;
    }
    if (chunk.index === 0) {
      this.reset();
      this.id = chunk.id;
      this.count = chunk.count;
    } else if (chunk.id !== this.id || chunk.count !== this.count || chunk.index !== this.next) {
      this.reset();
      return null;
    }
    if (this.length + chunk.text.length > ClipAssembler.MAX_CHARS) {
      this.reset();
      return null;
    }
    this.parts.push(chunk.text);
    this.length += chunk.text.length;
    this.next = chunk.index + 1;
    if (this.next < this.count) return null;
    const text = this.parts.join('');
    this.reset();
    return text;
  }

  reset(): void {
    this.id = null;
    this.count = 0;
    this.next = 0;
    this.parts = [];
    this.length = 0;
  }
}
