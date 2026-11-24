import { image } from '@kit.ImageKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { ImageSizing } from '../logic/ImageSizing';

/** 整理好的图片 */
export interface PreparedImage {
  bytes: ArrayBuffer;
  mime: string;
  width: number;
  height: number;
}

/** 被控端接受的上限 */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const PNG_LIMIT = 6 * 1024 * 1024;
const JPEG_QUALITY = 85;

/**
 * 把用户选的图片整理成发给电脑的样子（协议 4.5 的建议），对照安卓端 image/ImagePrep.kt：
 * 按拍摄方向转正，长边缩到 ImageSizing.MAX_EDGE 以内，重新编码（顺带去掉拍摄位置等元数据）。
 * PNG（多半是截图）保持 PNG，太大才改成 JPEG；其它格式一律转成 JPEG。
 */
export class ImagePrep {
  static async prepare(uri: string): Promise<PreparedImage> {
    const file = fs.openSync(uri, fs.OpenMode.READ_ONLY);
    let source: image.ImageSource | null = null;
    let pm: image.PixelMap | null = null;
    try {
      source = image.createImageSource(file.fd);
      const info = await source.getImageInfo();
      const keepPng = info.mimeType === 'image/png';
      const fit = ImageSizing.fit(info.size.width, info.size.height);
      pm = await source.createPixelMap({
        desiredSize: { width: fit.width, height: fit.height },
        editable: true
      });
      await ImagePrep.orient(source, pm);
      const out = await pm.getImageInfo();
      const packer = image.createImagePacker();
      try {
        if (keepPng) {
          const png = await packer.packToData(pm, { format: 'image/png', quality: 100 });
          if (png.byteLength <= PNG_LIMIT) {
            return { bytes: png, mime: 'image/png', width: out.size.width, height: out.size.height };
          }
        }
        const jpeg = await packer.packToData(pm, { format: 'image/jpeg', quality: JPEG_QUALITY });
        return { bytes: jpeg, mime: 'image/jpeg', width: out.size.width, height: out.size.height };
      } finally {
        packer.release();
      }
    } finally {
      pm?.release();
      source?.release();
      fs.closeSync(file);
    }
  }

  /** 按 EXIF 的方向把照片转正 */
  private static async orient(source: image.ImageSource, pm: image.PixelMap): Promise<void> {
    let o = '';
    try {
      o = await source.getImageProperty(image.PropertyKey.ORIENTATION);
    } catch (e) {
      return; // 没有方向信息（截图、PNG）
    }
    switch (o) {
      case 'Top-right':
        await pm.flip(true, false);
        break;
      case 'Bottom-right':
        await pm.rotate(180);
        break;
      case 'Bottom-left':
        await pm.flip(false, true);
        break;
      case 'Left-top':
        await pm.rotate(90);
        await pm.flip(true, false);
        break;
      case 'Right-top':
        await pm.rotate(90);
        break;
      case 'Right-bottom':
        await pm.rotate(270);
        await pm.flip(true, false);
        break;
      case 'Left-bottom':
        await pm.rotate(270);
        break;
      default:
        break;
    }
  }
}
