/**
 * 远程窗口内的相对位置：x、y 取值 0 到 1，(0, 0) 是画面左上角。
 * 被控端按窗口当前的实际尺寸换算成屏幕像素，见 docs/03-protocol.md 第 3 节。
 * 对照安卓端 input/RemotePoint.kt。
 */
export interface RemotePoint {
  x: number;
  y: number;
}
