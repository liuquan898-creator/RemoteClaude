import { fileIo as fs } from '@kit.CoreFileKit';
import { FileUploads } from '../logic/FileUploads';

/**
 * 用户在系统文件选择器里选的一个文件，对照安卓端 files/FileSource.kt。
 * 选择器给的 uri 带着这次的读权限，直接按 uri 打开读。
 */
export class FileSource {
  readonly name: string;
  readonly size: number;
  private file: fs.File;

  private constructor(file: fs.File, name: string, size: number) {
    this.file = file;
    this.name = name;
    this.size = size;
  }

  /** 打开文件。超过 max 字节时抛 FileTooLarge */
  static open(uri: string, max: number): FileSource {
    const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    const size = fs.statSync(file.fd).size;
    let raw = file.name;
    if (!raw) {
      try {
        raw = decodeURIComponent(uri.substring(uri.lastIndexOf('/') + 1));
      } catch (e) {
        raw = '';
      }
    }
    const name = FileUploads.displayName(raw);
    if (size > max) {
      fs.closeSync(file);
      throw new FileTooLarge(name);
    }
    return new FileSource(file, name, size);
  }

  /** 从 offset 起读最多 buf.byteLength 个字节，返回读到的字节数，0 表示读完了 */
  read(buf: ArrayBuffer, offset: number): number {
    return fs.readSync(this.file.fd, buf, { offset: offset, length: buf.byteLength });
  }

  release(): void {
    try {
      fs.closeSync(this.file);
    } catch (e) {
      // 已经关了
    }
  }
}

export class FileTooLarge extends Error {
  readonly fileName: string;

  constructor(name: string) {
    super('file too large');
    this.fileName = name;
  }
}
