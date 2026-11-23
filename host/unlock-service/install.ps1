# RemoteClaude 解锁服务的安装、升级、卸载。设计见 docs/06-unlock-service.md
#
# 用法（普通身份运行即可，脚本会弹出管理员确认）：
#   powershell -ExecutionPolicy Bypass -File host\unlock-service\install.ps1             安装或升级
#   powershell -ExecutionPolicy Bypass -File host\unlock-service\install.ps1 -Uninstall  卸载
#
# 服务以 SYSTEM 身份运行，所以程序直接以管理员身份编译进 Program Files，
# 不经过普通用户能改的目录。
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$name = 'RemoteClaudeUnlock'
$dir = Join-Path $env:ProgramFiles 'RemoteClaude'
$exe = Join-Path $dir 'RemoteClaudeUnlock.exe'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Uninstall) { $argList += '-Uninstall' }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs
    return
}

function Remove-UnlockService {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $svc) { return }
    if ($svc.Status -ne 'Stopped') {
        Stop-Service -Name $name -Force
        $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
    }
    & sc.exe delete $name | Out-Null
    # 等服务管理器真正删掉，否则紧接着创建会报"已标记为删除"
    for ($i = 0; $i -lt 20 -and (Get-Service -Name $name -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }
}

try {
    Remove-UnlockService
    if ($Uninstall) {
        if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
        Write-Host '解锁服务已卸载。' -ForegroundColor Green
    } else {
        $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        if (-not (Test-Path $csc)) { throw "找不到 .NET Framework 自带的 C# 编译器：$csc" }
        $src = Join-Path $PSScriptRoot 'UnlockService.cs'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        & $csc /nologo /codepage:65001 /target:exe /optimize+ /platform:x64 "/out:$exe" /reference:System.ServiceProcess.dll $src
        if ($LASTEXITCODE -ne 0) { throw '编译失败' }

        & sc.exe create $name binPath= "`"$exe`"" start= auto obj= LocalSystem DisplayName= 'RemoteClaude Unlock' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '创建服务失败' }
        & sc.exe description $name 'Types the Windows password or PIN into the lock screen when RemoteClaude asks. See docs/06-unlock-service.md' | Out-Null
        & sc.exe failure $name reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
        Start-Service -Name $name
        Write-Host "解锁服务已安装并启动：$exe" -ForegroundColor Green
        Write-Host '被控端 30 秒内会发现它，不用重启。日志在 C:\ProgramData\RemoteClaude\unlock.log（不含密码）。'
    }
} catch {
    Write-Host "出错：$_" -ForegroundColor Red
}
Read-Host '按回车关闭'
