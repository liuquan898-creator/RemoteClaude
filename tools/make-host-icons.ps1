# 生成被控端的窗口图标和托盘图标（与安卓 App 图标同一个图案：窗口 + 鼠标指针）。
# 用法: pwsh -File tools/make-host-icons.ps1
#   host/assets/icon.png         256×256，窗口和任务栏用
#   host/assets/tray-on.png      16×16 / tray-on@2x.png 32×32，已连上服务器（橙色）
#   host/assets/tray-off.png     16×16 / tray-off@2x.png 32×32，未连上（灰色）
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\host\assets'
New-Item -ItemType Directory -Force $out | Out-Null

function New-Icon([int]$size, [System.Drawing.Color]$bg, [string]$file) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)
    $s = $size / 48.0  # 图案按 48×48 设计

    # 圆角方形底
    $r = 10 * $s
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
    $path.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $path.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $path.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $path.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush $bg), $path)

    # 窗口外框和标题栏
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([Math]::Max(1.2, 3 * $s))
    $pen.LineJoin = 'Round'
    $g.DrawRectangle($pen, [float](9 * $s), [float](10 * $s), [float](30 * $s), [float](24 * $s))
    $g.DrawLine($pen, [float](9 * $s), [float](16.5 * $s), [float](39 * $s), [float](16.5 * $s))

    # 鼠标指针
    [System.Drawing.PointF[]]$pts = @(@(27, 22), @(27, 41), @(31.3, 36.8), @(34.3, 43), @(37, 41.7), @(34, 35.6), @(39.6, 35.6)) |
        ForEach-Object { New-Object System.Drawing.PointF ([float]($_[0] * $s)), ([float]($_[1] * $s)) }
    $g.FillPolygon([System.Drawing.Brushes]::White, $pts)
    $edge = New-Object System.Drawing.Pen $bg, ([Math]::Max(1, 1.8 * $s))
    $edge.LineJoin = 'Round'
    $g.DrawPolygon($edge, $pts)

    $g.Dispose()
    $bmp.Save((Join-Path $out $file), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$accent = [System.Drawing.Color]::FromArgb(255, 0xD9, 0x77, 0x57)
$grey = [System.Drawing.Color]::FromArgb(255, 0x6B, 0x6B, 0x76)
New-Icon 256 $accent 'icon.png'
New-Icon 16 $accent 'tray-on.png'
New-Icon 32 $accent 'tray-on@2x.png'
New-Icon 16 $grey 'tray-off.png'
New-Icon 32 $grey 'tray-off@2x.png'
Get-ChildItem $out | Select-Object Name, Length
