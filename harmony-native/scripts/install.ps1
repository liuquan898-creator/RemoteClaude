# 构建鸿蒙原生版并装到 USB 连着的手机上（鸿蒙不能像安卓那样在 App 里下载安装新版本，用这个代替，见 docs/10）。
#
# 用法（PowerShell，在任意目录）：
#   pwsh -File harmony-native\scripts\install.ps1            # 正式版
#   pwsh -File harmony-native\scripts\install.ps1 -Debug     # 调试版（登录页能填服务器地址，允许 ws:// 明文）
#   pwsh -File harmony-native\scripts\install.ps1 -SkipBuild # 不重新构建，直接装上次的安装包
#
# 需要：DevEco Studio（默认 D:\Program Files\DevEco Studio，环境变量 DEVECO_HOME 可改）；
#       本机签名 harmony-native\signing.local.json5（见 docs/10"签名"）；
#       打包配置 deploy\prod\build.json 里的 server（环境变量 RC_BUILD_CONFIG 可改）。
# 手机要打开"开发者选项 > USB 调试"并信任这台电脑；无线调试时先运行 hdc tconn <手机IP>:<端口>。
param(
    [switch]$Debug,
    [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$deveco = if ($env:DEVECO_HOME) { $env:DEVECO_HOME } else { 'D:\Program Files\DevEco Studio' }
$node = Join-Path $deveco 'tools\node\node.exe'
$ohpm = Join-Path $deveco 'tools\ohpm\bin\ohpm.bat'
$hvigor = Join-Path $deveco 'tools\hvigor\bin\hvigorw.js'
$hdc = Join-Path $deveco 'sdk\default\openharmony\toolchains\hdc.exe'
$hap = Join-Path $root 'entry\build\default\outputs\default\entry-default-signed.hap'
foreach ($f in $node, $ohpm, $hvigor, $hdc) {
    if (-not (Test-Path $f)) { throw "找不到 $f，请确认 DevEco Studio 的安装位置（环境变量 DEVECO_HOME）" }
}

if (-not $SkipBuild) {
    $env:DEVECO_SDK_HOME = Join-Path $deveco 'sdk'
    $mode = if ($Debug) { 'debug' } else { 'release' }
    Push-Location $root
    try {
        & $node scripts\gen-build-profile.js
        if ($LASTEXITCODE -ne 0) { throw '生成 build-profile.json5 失败' }
        & $ohpm install --all | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'ohpm install 失败' }
        # 先删掉上次的安装包：构建失败时不会把旧包装上去
        Remove-Item (Join-Path $root 'entry\build\default\outputs\default\*.hap') -ErrorAction SilentlyContinue
        $log = & $node $hvigor --mode module -p product=default -p buildMode=$mode assembleHap --no-daemon 2>&1
        $code = $LASTEXITCODE
        $log | Where-Object { "$_" -match 'ERROR|Error Message|At File|BUILD' } | ForEach-Object { Write-Host $_ }
        if ($code -ne 0) { throw "构建失败（$mode）" }
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path $hap)) { throw "没有安装包 $hap，先去掉 -SkipBuild 构建一次" }
$targets = & $hdc list targets
if (-not $targets -or $targets -match 'Empty') { throw '没连上手机：检查 USB 线、手机上的"USB 调试"开关和"信任此电脑"' }
& $hdc install -r $hap
if ($LASTEXITCODE -ne 0) { throw '安装失败（手机锁屏时也装不上）' }
Write-Host "已装到手机：$((Get-Item $hap).LastWriteTime)"
