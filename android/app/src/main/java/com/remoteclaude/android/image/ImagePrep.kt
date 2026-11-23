package com.remoteclaude.android.image

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import java.io.ByteArrayOutputStream
import java.io.IOException

/**
 * 把用户选的图片整理成发给电脑的样子（协议文档 4.5 的建议）：
 * 按拍摄方向转正，长边缩到 [ImageSizing.MAX_EDGE] 以内，重新编码。
 * 重新编码同时去掉了照片里的拍摄位置等元数据。
 *
 * PNG（多半是截图，文字要清楚）保持 PNG，太大才改成 JPEG；其它格式一律转成 JPEG。
 * 很耗时，要在后台线程调用。
 */
object ImagePrep {
    /** 被控端接受的上限 */
    const val MAX_BYTES = 10 * 1024 * 1024
    private const val PNG_LIMIT = 6 * 1024 * 1024
    private const val JPEG_QUALITY = 85

    class Prepared(val bytes: ByteArray, val mime: String, val width: Int, val height: Int)

    @Throws(IOException::class)
    fun prepare(context: Context, uri: Uri): Prepared {
        val resolver = context.contentResolver
        val keepPng = resolver.getType(uri) == "image/png"
        val decoded = decode(resolver, uri)
        val bitmap = scaleToFit(decoded)
        try {
            if (keepPng) {
                val png = encode(bitmap, Bitmap.CompressFormat.PNG, 100)
                if (png.size <= PNG_LIMIT) return Prepared(png, "image/png", bitmap.width, bitmap.height)
            }
            // JPEG 没有透明通道，透明的地方先铺成白色，免得变黑
            val opaque = if (bitmap.hasAlpha()) flatten(bitmap) else bitmap
            try {
                val jpeg = encode(opaque, Bitmap.CompressFormat.JPEG, JPEG_QUALITY)
                return Prepared(jpeg, "image/jpeg", opaque.width, opaque.height)
            } finally {
                if (opaque !== bitmap) opaque.recycle()
            }
        } finally {
            bitmap.recycle()
            if (decoded !== bitmap) decoded.recycle()
        }
    }

    private fun decode(resolver: ContentResolver, uri: Uri): Bitmap {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // ImageDecoder 会自己按 EXIF 方向转正
            val source = ImageDecoder.createSource(resolver, uri)
            return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                decoder.setTargetSampleSize(ImageSizing.sampleSize(info.size.width, info.size.height))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE // 硬件位图不能直接在画布上重画
            }
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IOException("无法识别的图片")
        val options = BitmapFactory.Options().apply { inSampleSize = ImageSizing.sampleSize(bounds.outWidth, bounds.outHeight) }
        val bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
            ?: throw IOException("无法解码图片")
        val orientation = runCatching {
            resolver.openInputStream(uri)?.use {
                ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            }
        }.getOrNull() ?: ExifInterface.ORIENTATION_NORMAL
        return rotate(bitmap, orientation)
    }

    /** 安卓 9 以下 BitmapFactory 不管 EXIF 方向，要自己转 */
    private fun rotate(bitmap: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
            else -> return bitmap
        }
        val out = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, m, true)
        if (out !== bitmap) bitmap.recycle()
        return out
    }

    private fun scaleToFit(bitmap: Bitmap): Bitmap {
        val (w, h) = ImageSizing.fit(bitmap.width, bitmap.height)
        if (w == bitmap.width && h == bitmap.height) return bitmap
        return Bitmap.createScaledBitmap(bitmap, w, h, true)
    }

    private fun flatten(bitmap: Bitmap): Bitmap {
        val out = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
        Canvas(out).apply {
            drawColor(Color.WHITE)
            drawBitmap(bitmap, 0f, 0f, null)
        }
        return out
    }

    private fun encode(bitmap: Bitmap, format: Bitmap.CompressFormat, quality: Int): ByteArray {
        val out = ByteArrayOutputStream(256 * 1024)
        if (!bitmap.compress(format, quality, out)) throw IOException("图片编码失败")
        return out.toByteArray()
    }
}
