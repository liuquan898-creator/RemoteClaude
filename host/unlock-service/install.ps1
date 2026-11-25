# RemoteClaude 解锁服务的安装、升级、卸载。设计见 docs/06-unlock-service.md
#
# 用法（普通身份运行即可，脚本会弹出管理员确认）：
#   powershell -ExecutionPolicy Bypass -File host\unlock-service\install.ps1             安装或升级
#   powershell -ExecutionPolicy Bypass -File host\unlock-service\install.ps1 -Uninstall  卸载
#
# 服务以 SYSTEM 身份运行，所以程序直接以管理员身份编译进 Program Files，
# 不经过普通用户能改的目录。日志目录 C:\ProgramData\RemoteClaude 也由这里建好并锁住权限。
# -ExpectSha256 <哈希>：提权后核对要编译的源码，一致才装；不给就把哈希打出来等你输入 y
#
# 被控端窗口里的"安装解锁服务"按钮（host/unlockinstall.js）从隐藏的窗口里这样调用：
#   install.ps1 -FromHost -ExpectSha256 <被控端自带源码的哈希>
# -FromHost：不管现在是不是管理员，都在新窗口里以管理员身份重新打开自己（不然出错时没人看得到），
#   等它结束，用它的退出码退出：0 装好了，1 失败，2 没能以管理员身份打开（多半是在确认框里点了"否"）。
# -NoPause：装好了就直接关窗口，不等回车；出错时照样等你看完按回车。-FromHost 重新打开自己时带上它
param([switch]$Uninstall, [string]$ExpectSha256 = '', [switch]$FromHost, [switch]$NoPause)

$ErrorActionPreference = 'Stop'
$name = 'RemoteClaudeUnlock'
# 必须是 64 位的 Program Files：被控端只认 %ProgramW6432%\RemoteClaude\RemoteClaudeUnlock.exe（host/unlockpipe.js）
$programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$dir = Join-Path $programFiles 'RemoteClaude'
$exe = Join-Path $dir 'RemoteClaudeUnlock.exe'
$src = Join-Path $dir 'UnlockService.cs'
# 安装时先复制、编译成这两个临时文件，核对、编译都成功了才去动旧服务，再改成正式的名字；
# 替换时原来的文件先改名成 .old 备份。都和正式文件放在同一个只有管理员能改的目录里，不放 %TEMP% 之类普通用户能改的地方
$srcNew = Join-Path $dir 'UnlockService.new.cs'
$exeNew = Join-Path $dir 'RemoteClaudeUnlock.new.exe'
$srcOld = Join-Path $dir 'UnlockService.old.cs'
$exeOld = Join-Path $dir 'RemoteClaudeUnlock.old.exe'
$dataDir = Join-Path $env:ProgramData 'RemoteClaude'

# 用 SID 而不是名字，中文 Windows 上组名是"管理员""用户"
$sidSystem = 'S-1-5-18'
$sidAdmins = 'S-1-5-32-544'
$sidUsers = 'S-1-5-32-545'

# 只在以管理员身份运行的 64 位 Windows PowerShell 5.1 里干活；否则用它重新打开自己（会弹出管理员确认）。
# PowerShell 7 建不出建立时就带权限的目录，32 位的拿到的 Program Files 是 (x86)
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($FromHost -or -not $isAdmin -or $PSVersionTable.PSEdition -ne 'Desktop' -or -not [Environment]::Is64BitProcess) {
    $ps = Join-Path $env:WINDIR 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'   # 32 位进程看到的 64 位 System32
    if (-not (Test-Path $ps)) { $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe' }
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Uninstall) { $argList += '-Uninstall' }
    if ($ExpectSha256) { $argList += @('-ExpectSha256', $ExpectSha256) }
    if ($FromHost -or $NoPause) { $argList += '-NoPause' }
    if (-not $FromHost) {
        Start-Process -FilePath $ps -ArgumentList $argList -Verb RunAs
        return
    }
    try {
        $proc = Start-Process -FilePath $ps -ArgumentList $argList -Verb RunAs -PassThru
    } catch {
        Write-Host "没能以管理员身份运行：$($_.Exception.Message)"
        exit 2
    }
    # 先取一下句柄，进程退出后才读得到退出码
    $null = $proc.Handle
    $proc.WaitForExit()
    exit $proc.ExitCode
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
    try {
        [IO.Directory]::Move($path, $aside)
    } catch {
        # 这一步在停旧服务之前做，旧服务这时还在运行：它写日志时会短暂打开里面的文件，目录正好挪不动
        throw "$path 不可信，要挪开，但挪不动：$($_.Exception.Message)。可能有程序正开着里面的文件（比如正在运行的解锁服务恰好在写日志，或者打开着日志的编辑器）。请关掉这些程序，或者先停止解锁服务（以管理员身份运行 sc.exe stop RemoteClaudeUnlock），再重新运行安装脚本"
    }
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

# 删掉安装用的临时文件和 .old 备份，包括上次中途被关掉、或者当时删不掉留下的。只删路径本身，是链接也只删链接、不跟随。
# 正式文件不在时不删它的备份：那是上次替换到一半没能改回去，备份就是原来的程序
function Remove-TempFiles {
    $paths = @($srcNew, $exeNew)
    if (Test-Exists $src) { $paths += $srcOld }
    if (Test-Exists $exe) { $paths += $exeOld }
    foreach ($path in $paths) {
        if (Test-Exists $path) {
            try { [IO.File]::Delete($path) } catch { throw "删不掉 $path（可能还有程序在用它）：$($_.Exception.Message)" }
        }
    }
}

# 在同一目录里改名，不跟随链接，目标已存在就失败。正在运行的 exe 也能改名（只是删不掉），
# 所以不用等旧服务进程、注入进程退干净；只为杀毒软件之类短暂占着文件的情况，失败了隔 0.25 秒再试，最多约 5 秒
function Rename-File([string]$from, [string]$to) {
    for ($i = 0; ; $i++) {
        try {
            [IO.File]::Move($from, $to)
            return
        } catch {
            if ($i -ge 20) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

# 用 $from 换掉 $to：现有的 $to 先改名成备份 $backup，再把 $from 改名成 $to；就位失败就把备份改回去。
# 备份由 Remove-TempFiles 删：成功后删不掉（还在运行）就留到下次安装
function Move-IntoPlace([string]$from, [string]$to, [string]$backup) {
    $hadOld = Test-Exists $to
    if ($hadOld) { Rename-File $to $backup }
    try {
        Rename-File $from $to
    } catch {
        $why = $_.Exception.Message
        if (-not $hadOld) { throw "没能把 $from 改名成 $to：$why" }
        try { Rename-File $backup $to } catch { throw "没能把 $from 改名成 $to：$why。原来的文件也没能改回去，还在 $backup" }
        throw "没能把 $from 改名成 $to，原来的文件已经改回：$why"
    }
}

# 停旧服务以后出错时调用：按服务现在的实际状态说明。服务注册和程序都还在、服务没在运行，就试着把它启动起来
#（用的可能是原来的程序，也可能已经换成新的）
function Repair-AfterFailure {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    $which = if ($exeReplaced) { '新编译的程序' } else { '原来的程序' }
    $rerun = '请处理上面的问题后重新运行安装脚本。'
    if (-not $svc) {
        $state = if ($hadService) { '旧的解锁服务已经删除，新的没有装好。' } else { '解锁服务没有装好。' }
        Write-Host "$state$rerun" -ForegroundColor Yellow
    } elseif ($svc.Status -eq 'Running') {
        if ($exeReplaced) {
            Write-Host "解锁服务在运行（$which），但安装没有全部完成。$rerun" -ForegroundColor Yellow
        } else {
            Write-Host '旧的解锁服务没有停下来，还在照常运行，没有改动。'
        }
    } elseif (-not (Test-Exists $exe)) {
        $where = if (Test-Exists $exeOld) { "，原来的程序在 $exeOld" } else { '' }
        Write-Host "解锁服务没在运行，$exe 也不在了，没法启动$where。$rerun" -ForegroundColor Yellow
    } else {
        try {
            Start-Service -Name $name
            Write-Host "解锁服务停掉以后出了错，已经把它重新启动起来，用的是$which。安装没有全部完成，$rerun" -ForegroundColor Yellow
        } catch {
            Write-Host "解锁服务没在运行（状态 $($svc.Status)），也没能重新启动：$($_.Exception.Message)。$rerun" -ForegroundColor Yellow
        }
    }
}

# $replacing：开始停用、替换旧服务以后为 $true，在这之前出错或取消，旧服务和旧程序原样不动；
# 之后出错由 Repair-AfterFailure 看实际状态处理。$hadService：开始替换前装着服务；$exeReplaced：新程序已经就位
$replacing = $false
$hadService = $false
$exeReplaced = $false
$failed = $false
try {
    if ($Uninstall) {
        Remove-UnlockService
        if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
        Write-Host '解锁服务已卸载。' -ForegroundColor Green
        Write-Host "日志目录 $dataDir 保留未删，不需要可以手动删除。"
    } else {
        $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        if (-not (Test-Path $csc)) { throw "找不到 .NET Framework 自带的 C# 编译器：$csc" }
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Remove-TempFiles
        # 仓库目录普通用户可写：先把源码复制进只有管理员能改的安装目录，核对哈希后用副本编译，
        # 免得在你看过代码之后、点"是"之前被人改掉。复制、核对、编译都用临时文件名，旧服务这时照常运行
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'UnlockService.cs') -Destination $srcNew -Force
        $hash = (Get-FileHash -LiteralPath $srcNew -Algorithm SHA256).Hash
        Write-Host '即将编译的 UnlockService.cs，SHA256：' -NoNewline
        Write-Host $hash -ForegroundColor Yellow
        if ($ExpectSha256) {
            if ($hash -ne $ExpectSha256.ToUpperInvariant()) { throw "源码哈希和预期的 $ExpectSha256 不一致，不安装" }
            Write-Host '和预期的哈希一致。' -ForegroundColor Green
        } else {
            if ((Read-Host '核对一致后输入 y 继续安装') -ne 'y') { throw '已取消，没有安装' }
        }
        & $csc /nologo /codepage:65001 /target:exe /optimize+ /platform:x64 "/out:$exeNew" /reference:System.ServiceProcess.dll $srcNew
        if ($LASTEXITCODE -ne 0) { throw '编译失败，没有安装' }
        # 可能把可疑的日志目录挪开重建，所以也放在核对、编译之后：取消时不动它，它出错时旧服务也还没动
        Initialize-DataDir

        # 到这里才停掉、删除旧服务，换上新程序和对应的源码
        $hadService = $null -ne (Get-Service -Name $name -ErrorAction SilentlyContinue)
        $replacing = $true
        Remove-UnlockService
        Move-IntoPlace $exeNew $exe $exeOld
        $exeReplaced = $true
        Move-IntoPlace $srcNew $src $srcOld
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
    $failed = $true
    Write-Host "出错：$_" -ForegroundColor Red
    if (-not $Uninstall) {
        if ($replacing) {
            try { Repair-AfterFailure } catch { Write-Host "查看、恢复解锁服务时又出错：$_" -ForegroundColor Red }
        } else {
            Write-Host '原来的解锁服务（如果装过）没有改动。'
        }
    }
} finally {
    if (-not $Uninstall) {
        try { Remove-TempFiles } catch { Write-Host "$_。下次安装时会再清。" -ForegroundColor Yellow }
    }
}
if ($failed -or -not $NoPause) { Read-Host '按回车关闭' | Out-Null }
# 被控端靠退出码知道装没装好（-FromHost）
if ($failed) { exit 1 }
exit 0
