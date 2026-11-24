# RemoteClaude 解锁服务的安装、升级、卸载。设计见 docs/06-unlock-service.md
#
# 用法（普通身份运行即可，脚本会弹出管理员确认）：
#   powershell -ExecutionPolicy Bypass -File host\unlock-service\install.ps1             安装或升级
#   powershell -ExecutionPolicy Bypass -File host\unlock-service\install.ps1 -Uninstall  卸载
#
# 服务以 SYSTEM 身份运行，所以程序直接以管理员身份编译进 Program Files，
# 不经过普通用户能改的目录。日志目录 C:\ProgramData\RemoteClaude 也由这里建好并锁住权限。
# -ExpectSha256 <哈希>：提权后核对要编译的源码，一致才装；不给就把哈希打出来等你输入 y
param([switch]$Uninstall, [string]$ExpectSha256 = '')

$ErrorActionPreference = 'Stop'
$name = 'RemoteClaudeUnlock'
# 必须是 64 位的 Program Files：被控端只认 %ProgramW6432%\RemoteClaude\RemoteClaudeUnlock.exe（host/unlockpipe.js）
$programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$dir = Join-Path $programFiles 'RemoteClaude'
$exe = Join-Path $dir 'RemoteClaudeUnlock.exe'
$dataDir = Join-Path $env:ProgramData 'RemoteClaude'

# 用 SID 而不是名字，中文 Windows 上组名是"管理员""用户"
$sidSystem = 'S-1-5-18'
$sidAdmins = 'S-1-5-32-544'
$sidUsers = 'S-1-5-32-545'

# 只在以管理员身份运行的 64 位 Windows PowerShell 5.1 里干活；否则用它重新打开自己（会弹出管理员确认）。
# PowerShell 7 建不出建立时就带权限的目录，32 位的拿到的 Program Files 是 (x86)
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -or $PSVersionTable.PSEdition -ne 'Desktop' -or -not [Environment]::Is64BitProcess) {
    $ps = Join-Path $env:WINDIR 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'   # 32 位进程看到的 64 位 System32
    if (-not (Test-Path $ps)) { $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe' }
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Uninstall) { $argList += '-Uninstall' }
    if ($ExpectSha256) { $argList += @('-ExpectSha256', $ExpectSha256) }
    Start-Process -FilePath $ps -ArgumentList $argList -Verb RunAs
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

# 读路径本身的属性，不跟随链接；指向不存在目标的链接也算"存在"。不存在返回 $null
function Get-RawAttributes([string]$path) {
    try { return [IO.File]::GetAttributes($path) } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return $null }
}

function Test-Exists([string]$path) { return $null -ne (Get-RawAttributes $path) }

function Test-ReparsePoint([string]$path) {
    $attrs = Get-RawAttributes $path
    return ($null -ne $attrs) -and (($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Test-TrustedOwner([string]$path) {
    $owner = (Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value
    return $owner -eq $sidSystem -or $owner -eq $sidAdmins
}

# 目录里只应有服务自己写的日志：管理员或 SYSTEM 所有的普通文件。别的（子目录、链接、普通用户放进来的文件）都不可信
function Test-DataDirClean([string]$path) {
    foreach ($child in Get-ChildItem -LiteralPath $path -Force) {
        if ($child.PSIsContainer) { return $false }
        if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        if (-not (Test-TrustedOwner $child.FullName)) { return $false }
    }
    return $true
}

# 把可疑的旧目录整个挪开（只改名，不跟随链接、不递归删除），之后建一个全新的
function Move-Aside([string]$path) {
    $aside = "$path.untrusted-$(Get-Date -Format 'yyyyMMddHHmmss')"
    [IO.Directory]::Move($path, $aside)
    Write-Host "警告：$path 不可信（是链接、所有者不是管理员，或里面有别人放的东西），已挪到 $aside，请确认后自行删除。" -ForegroundColor Yellow
}

# C:\ProgramData\RemoteClaude：SYSTEM、管理员完全控制，普通用户只读。服务以 SYSTEM 身份往里写日志，
# 普通用户要是能在里面建链接，就能把 SYSTEM 的写入引到别的文件上
function Initialize-DataDir {
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        if (Test-Exists $dataDir) {
            if ((Test-ReparsePoint $dataDir) -or -not (Test-TrustedOwner $dataDir) -or -not (Test-DataDirClean $dataDir)) {
                Move-Aside $dataDir
            }
        }
        if (-not (Test-Exists $dataDir)) {
            # 建的时候就带上最终权限，不留普通用户可写的空档
            $sec = New-Object Security.AccessControl.DirectorySecurity
            $sec.SetAccessRuleProtection($true, $false)
            $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
            $none = [Security.AccessControl.PropagationFlags]::None
            foreach ($rule in @(@($sidSystem, 'FullControl'), @($sidAdmins, 'FullControl'), @($sidUsers, 'ReadAndExecute'))) {
                $sid = New-Object Security.Principal.SecurityIdentifier($rule[0])
                $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $rule[1], $inherit, $none, 'Allow')))
            }
            [IO.Directory]::CreateDirectory($dataDir, $sec) | Out-Null
        }
        # 再确认一次：不是链接、所有者可信（防止上面两步之间被人抢先建了同名目录）
        if ((Test-ReparsePoint $dataDir) -or -not (Test-TrustedOwner $dataDir)) {
            throw "$dataDir 不可信（可能有程序在安装过程中抢先建了它），已中止安装"
        }
        # 已确认不是链接，icacls 不会跟随到别处；只改这个目录本身，不用 /T 递归
        & icacls.exe $dataDir /inheritance:r /grant:r "*${sidSystem}:(OI)(CI)F" "*${sidAdmins}:(OI)(CI)F" "*${sidUsers}:(OI)(CI)RX" /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "设置 $dataDir 的权限失败" }
        # 锁住权限以后别人放不进新东西了；再查一遍里面，在锁之前混进来的就整个挪开重来
        if (Test-DataDirClean $dataDir) {
            foreach ($child in Get-ChildItem -LiteralPath $dataDir -Force) {
                & icacls.exe $child.FullName /reset /Q | Out-Null
            }
            return
        }
    }
    throw "$dataDir 一直被人塞进不可信的东西，已中止安装"
}

try {
    Remove-UnlockService
    if ($Uninstall) {
        if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
        Write-Host '解锁服务已卸载。' -ForegroundColor Green
        Write-Host "日志目录 $dataDir 保留未删，不需要可以手动删除。"
    } else {
        $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        if (-not (Test-Path $csc)) { throw "找不到 .NET Framework 自带的 C# 编译器：$csc" }
        Initialize-DataDir
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        # 仓库目录普通用户可写：先把源码复制进只有管理员能改的安装目录，核对哈希后用副本编译，
        # 免得在你看过代码之后、点"是"之前被人改掉
        $src = Join-Path $dir 'UnlockService.cs'
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'UnlockService.cs') -Destination $src -Force
        $hash = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
        Write-Host '即将编译的 UnlockService.cs，SHA256：' -NoNewline
        Write-Host $hash -ForegroundColor Yellow
        if ($ExpectSha256) {
            if ($hash -ne $ExpectSha256.ToUpperInvariant()) { throw "源码哈希和预期的 $ExpectSha256 不一致，不安装" }
            Write-Host '和预期的哈希一致。' -ForegroundColor Green
        } else {
            if ((Read-Host '核对一致后输入 y 继续安装') -ne 'y') { throw '已取消，没有安装' }
        }
        & $csc /nologo /codepage:65001 /target:exe /optimize+ /platform:x64 "/out:$exe" /reference:System.ServiceProcess.dll $src
        if ($LASTEXITCODE -ne 0) { throw '编译失败' }

        & sc.exe create $name binPath= "`"$exe`"" start= auto obj= LocalSystem DisplayName= 'RemoteClaude Unlock' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '创建服务失败' }
        # PowerShell 5.1 传给 sc.exe 时会吃掉内层引号，路径里有空格时成了"不带引号的服务路径"；直接把带引号的写进注册表
        Set-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$name" -Name ImagePath -Value ('"' + $exe + '"')
        & sc.exe description $name 'Types the Windows password or PIN into the lock screen when RemoteClaude asks. See docs/06-unlock-service.md' | Out-Null
        & sc.exe failure $name reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Null
        Start-Service -Name $name
        Write-Host "解锁服务已安装并启动：$exe" -ForegroundColor Green
        Write-Host '请核对下面的 BINARY_PATH_NAME 带引号、指向 Program Files，SERVICE_START_NAME 是 LocalSystem：'
        & sc.exe qc $name | Out-Host
        Write-Host '被控端 30 秒内会发现它，不用重启。日志在 C:\ProgramData\RemoteClaude\unlock.log（不含密码）。'
    }
} catch {
    Write-Host "出错：$_" -ForegroundColor Red
}
Read-Host '按回车关闭'
