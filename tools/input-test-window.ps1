# 输入测试窗口
#
# 打开一个带文本框的窗口，把收到的鼠标、键盘、文字事件逐条写进日志文件。
# 用它来验证远程输入是否准确，避免拿真实的 Claude 会话窗口做试验。
#
# 用法（PowerShell 7）:
#   pwsh -File tools/input-test-window.ps1 -Log $env:TEMP\rc-input-test.log
#
# 配合方法:
#   1. 在 host/config.json 的 targets 里临时加上 "pwsh.exe"，重启被控端
#   2. 控制端的会话列表里会多出 "RemoteClaude 输入测试窗口"，选中它
#   3. 远程点击、滚动、打字、粘贴图片，然后查看日志（粘贴的图片显示在窗口下方）
#   4. 测完把 "pwsh.exe" 从 targets 里删掉
#
# 窗口以"不激活"方式显示（不抢焦点），所以第一次远程点击还能顺便验证
# 被控端把后台窗口切到前台的逻辑。
param(
    [string]$Log = (Join-Path $env:TEMP 'rc-input-test.log')
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RcTestWin {
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@
# 按物理像素工作，日志里的坐标才能和被控端算出的落点精确比对
[void][RcTestWin]::SetProcessDpiAwarenessContext([IntPtr](-4))

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Set-Content -Path $Log -Value "started" -Encoding utf8

$form = New-Object Windows.Forms.Form
$form.Text = "RemoteClaude 输入测试窗口"
$form.StartPosition = 'Manual'
$form.Left = 160; $form.Top = 160; $form.Width = 900; $form.Height = 640

$box = New-Object Windows.Forms.TextBox
$box.Multiline = $true
$box.ScrollBars = 'Vertical'
$box.Dock = 'Fill'
$box.Font = New-Object Drawing.Font('Microsoft YaHei UI', 14)
$form.Controls.Add($box)

# 文本框不接收图片，按 Ctrl+V 时剪贴板里是图片就显示在这里，并把尺寸写进日志
$pic = New-Object Windows.Forms.PictureBox
$pic.Dock = 'Bottom'
$pic.Height = 220
$pic.SizeMode = 'Zoom'
$pic.BackColor = [Drawing.Color]::FromArgb(40, 40, 40)
$form.Controls.Add($pic)

function Write-TestLog([string]$line) { Add-Content -Path $Log -Value $line -Encoding utf8 }

$box.Add_MouseDown({ param($s, $e)
    $origin = $box.PointToScreen([Drawing.Point]::new(0, 0))
    Write-TestLog ("down {0} client={1},{2} screen={3},{4}" -f $e.Button, $e.X, $e.Y, ($origin.X + $e.X), ($origin.Y + $e.Y)) })
$box.Add_MouseUp({ param($s, $e) Write-TestLog ("up {0}" -f $e.Button) })
$box.Add_MouseWheel({ param($s, $e) Write-TestLog ("wheel {0}" -f $e.Delta) })
$box.Add_KeyDown({ param($s, $e)
    Write-TestLog ("key {0} mods={1}" -f $e.KeyCode, $e.Modifiers)
    if ($e.Control -and $e.KeyCode -eq 'V' -and [Windows.Forms.Clipboard]::ContainsImage()) {
        $img = [Windows.Forms.Clipboard]::GetImage()
        $pic.Image = $img
        Write-TestLog ("paste-image {0}x{1}" -f $img.Width, $img.Height)
    } })
$box.Add_TextChanged({ Write-TestLog ("text=[{0}]" -f ($box.Text -replace "`r`n", "\n")) })
$form.Add_Activated({ Write-TestLog "activated" })
$form.Add_Deactivate({ Write-TestLog "deactivated" })

$handle = $form.Handle
[void][RcTestWin]::ShowWindow($handle, 4)   # SW_SHOWNOACTIVATE
Write-TestLog ("hwnd={0}" -f $handle.ToInt64())
Write-Host "测试窗口已打开，日志: $Log"
[Windows.Forms.Application]::Run($form)
