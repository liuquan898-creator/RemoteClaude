# 替用户在 Claude 桌面端里点菜单：把会话开成单独窗口、在新窗口里新建会话、选环境、检查窗口内容、关窗口。
# 用 Windows 的界面自动化接口（UI Automation）按名字找按钮和菜单项并按下去，不移动鼠标、不发键盘。
# 由被控端 host/sessions/index.js 调用，说明见 docs/07-claude-sessions.md。
#
# 用法（文字参数用 UTF-8 的 base64 传，免得引号、开头的 - 之类被命令行误解）：
#   -Action popout   -Hwnd <主窗口> -Title <会话标题b64>   主窗口正显示这个会话时，按"更多选项 > 打开方式 > 新建窗口"
#   -Action newwin   -Hwnd <主窗口>                         按"菜单 > 文件 > 在新窗口中新建会话"
#   -Action pickenv  -Hwnd <新会话窗口> -EnvName <环境名b64> 在新会话的输入框下选环境
#   -Action checkdoc -Hwnd <会话窗口> -Title <会话标题b64> [-SettleMs <毫秒>]
#                    等窗口里的页面真的显示这个会话（页面标题对上）；页面停在别的会话上超过 SettleMs 就不等了
#   -Action close    -Hwnd <会话窗口>                       按窗口自己的"关闭"
#   -Action dialog   -Hwnd <会话窗口> -Choice allow|deny|always [-Expect <网站名b64>] [-Probe 1]
#                    按会话里桌面端自己弹的确认框（"允许 Claude 在 xxx 上执行 JavaScript？"）的"允许一次""拒绝"，
#                    或者第一次打开网站的那种框上的"始终允许"；
#                    给了 Expect 就先核对框里的文字带这个网站名，对不上不按；Probe 为 1 时只找只核对、不按
#
# 输出一行 JSON（只含英文，中文用 UTF-8 的 base64）：{"ok":true,...} 或 {"ok":false,"code":"ui-missing","step":"..."}
param(
  [Parameter(Mandatory = $true)][ValidateSet('popout', 'newwin', 'pickenv', 'checkdoc', 'close', 'dialog')][string]$Action,
  [Parameter(Mandatory = $true)][long]$Hwnd,
  [string]$Title = '',
  [string]$EnvName = '',
  [string]$Choice = '',
  [string]$Expect = '',
  [int]$Probe = 0,
  [int]$TimeoutMs = 10000,
  [int]$SettleMs = 6000
)
$ErrorActionPreference = 'Stop'

function Out-Result($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  exit 0
}

function Decode([string]$b64) {
  if (-not $b64) { return '' }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))
}

function Encode([string]$s) {
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
}

try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
} catch {
  Out-Result @{ ok = $false; code = 'no-uia' }
}

$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

# Claude 界面上的文字，目前认简体中文和英文；Claude 改了文字就在这里补
$L = @{
  moreOptions = @('{0} 的更多选项', 'More options for {0}')
  openIn      = @('打开方式', 'Open in')
  newWindow   = @('新建窗口', 'New window')
  menu        = @('菜单', 'Menu')
  file        = @('文件', 'File')
  newInWindow = @('在新窗口中新建会话', 'New Session in New Window')
  envPrefix   = @('环境：', 'Environment: ')
  envSearch   = @('搜索环境', 'Search environments')
  close       = @('关闭', 'Close')
  allowOnce   = @('允许一次', 'Allow once')
  moreAllow   = @('更多允许选项', 'More allow options')
  alwaysAllow = @('始终允许', 'Always allow')
  deny        = @('拒绝', 'Deny')
}

$win = $null
try { $win = $AE::FromHandle([IntPtr]$Hwnd) } catch {}
if (-not $win) { Out-Result @{ ok = $false; code = 'no-window' } }

function Find-All($ctlType) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $ctlType)
  return $win.FindAll($Scope::Descendants, $cond)
}

# 名字在候选里、且在屏幕上的元素；有几个时取最靠上的
function Find-Named($ctlType, [string[]]$names, [switch]$Prefix) {
  $best = $null
  foreach ($e in (Find-All $ctlType)) {
    $c = $e.Current
    if ($c.IsOffscreen) { continue }
    $hit = $false
    foreach ($n in $names) {
      if ($Prefix) { if ($c.Name.StartsWith($n)) { $hit = $true } } elseif ($c.Name -eq $n) { $hit = $true }
    }
    if (-not $hit) { continue }
    if (-not $best -or $c.BoundingRectangle.Y -lt $best.Current.BoundingRectangle.Y) { $best = $e }
  }
  return $best
}

# 找到元素并对它做一件事，直到成功或超时。Claude 的界面边加载边重画，刚找到的元素可能马上失效，所以找和做一起重试
function Invoke-Step([string]$step, [scriptblock]$find, [scriptblock]$act, [int]$ms = $TimeoutMs) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($ms)
  do {
    try {
      $e = & $find
      if ($e) {
        & $act $e
        return $e
      }
    } catch {}
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  Out-Result @{ ok = $false; code = 'ui-missing'; step = $step }
}

# 等到 $test 返回真，超时返回假
function Wait-True([scriptblock]$test, [int]$ms) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($ms)
  do {
    try { if (& $test) { return $true } } catch {}
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

# 按一个按钮或菜单项。界面自动化里"按"有两种：展开（ExpandCollapse，带下拉的按钮和子菜单）和调用（Invoke，普通按钮）。
# 同一个按钮在不同版本的 Claude 里可能换一种：标题栏的"菜单"按钮在 6.6395 只认调用，6.28899 起只认展开，
# 按老办法调用就一直失败，手机上报"没找到要点的菜单"（2026-11-21）。所以优先用原来那种，不支持就换另一种
function Press($e, [string]$prefer) {
  $ecp = [System.Windows.Automation.ExpandCollapsePattern]::Pattern
  $ivp = [System.Windows.Automation.InvokePattern]::Pattern
  $p = $null
  if ($prefer -eq 'expand') {
    if ($e.TryGetCurrentPattern($ecp, [ref]$p)) { $p.Expand() } else { $e.GetCurrentPattern($ivp).Invoke() }
  } else {
    if ($e.TryGetCurrentPattern($ivp, [ref]$p)) { $p.Invoke() } else { $e.GetCurrentPattern($ecp).Expand() }
  }
}

$expand = { param($e) Press $e 'expand' }
$invoke = { param($e) Press $e 'invoke' }

switch ($Action) {
  'popout' {
    $t = Decode $Title
    if (-not $t) { Out-Result @{ ok = $false; code = 'bad-args' } }
    $names = $L.moreOptions | ForEach-Object { $_ -f $t }
    # 主窗口刚收到打开会话的链接，等它切到这个会话；标题栏上的"更多选项"比侧栏里的靠上
    Invoke-Step 'more-options' { Find-Named $CT::Button $names } $expand | Out-Null
    Invoke-Step 'open-in' { Find-Named $CT::MenuItem $L.openIn } $expand 3000 | Out-Null
    Invoke-Step 'new-window' { Find-Named $CT::MenuItem $L.newWindow } $invoke 3000 | Out-Null
    Out-Result @{ ok = $true }
  }
  'newwin' {
    Invoke-Step 'menu' { Find-Named $CT::Button $L.menu } $invoke | Out-Null
    Invoke-Step 'file' { Find-Named $CT::MenuItem $L.file } $expand 3000 | Out-Null
    Invoke-Step 'new-in-window' { Find-Named $CT::MenuItem $L.newInWindow } $invoke 3000 | Out-Null
    Out-Result @{ ok = $true }
  }
  'pickenv' {
    $name = Decode $EnvName
    if (-not $name) { Out-Result @{ ok = $false; code = 'bad-args' } }
    $want = $L.envPrefix | ForEach-Object { $_ + $name }
    $isWanted = { $b = Find-Named $CT::Button $L.envPrefix -Prefix; $b -and ($want -contains $b.Current.Name) }
    # 新窗口刚出来，输入框要等一会儿才有，界面还会边加载边重画；已经是这个环境就不用选
    $chip = Invoke-Step 'env-button' { Find-Named $CT::Button $L.envPrefix -Prefix } { param($e) }
    if (Wait-True $isWanted 300) { Out-Result @{ ok = $true; already = $true } }
    Invoke-Step 'env-button' { Find-Named $CT::Button $L.envPrefix -Prefix } $expand 5000 | Out-Null
    Invoke-Step 'env-search' { Find-Named $CT::Edit $L.envSearch } {
      param($e) $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($name)
    } 3000 | Out-Null
    # 环境选项的名字是"<环境名> ，编辑环境，右方向键"这样的，按开头认
    $rx = '^' + [regex]::Escape($name) + '(\s*[，,]|$)'
    Invoke-Step 'env-option' {
      foreach ($r in (Find-All $CT::RadioButton)) { if (-not $r.Current.IsOffscreen -and $r.Current.Name -match $rx) { return $r } }
    } $invoke 3000 | Out-Null
    if (-not (Wait-True $isWanted 3000)) { Out-Result @{ ok = $false; code = 'ui-missing'; step = 'env-confirm' } }
    Out-Result @{ ok = $true }
  }
  'checkdoc' {
    # 会话窗口里的页面标题是会话名（主窗口里是"会话名 - Claude Code"）。
    # Claude 会复用关掉后藏起来的窗口，有时窗口标题换成了会话名，页面却还停在别的内容上（docs/07 第 6 节）；
    # 长会话的页面也可能要加载一阵。所以：页面标题对上就成功；SettleMs 之后页面还显示着别的会话，算卡住（other）；
    # 一直没有像样的页面标题（还在加载，名字是空的或只是"Claude"）就等到 TimeoutMs（loading）。
    # 失败时把最后看到的页面标题带回去（seen，UTF-8 的 base64），被控端写进日志
    $t = Decode $Title
    $docCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Document)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $seen = @()
    do {
      try {
        # 主窗口里有两层页面（底下一层是加载时的占位页，名字是空的），所以每个都看
        $names = @(foreach ($d in $win.FindAll($Scope::Descendants, $docCond)) { [string]$d.Current.Name })
        $seen = $names
        foreach ($n in $names) {
          if ($n -eq $t -or $n.StartsWith($t + ' - ')) { Out-Result @{ ok = $true; ms = $sw.ElapsedMilliseconds } }
        }
        $other = @($names | Where-Object { $_ -and $_ -ne 'Claude' })
        if ($other.Count -gt 0 -and $sw.ElapsedMilliseconds -ge $SettleMs) {
          Out-Result @{ ok = $false; code = 'stuck'; reason = 'other'; ms = $sw.ElapsedMilliseconds; seen = (Encode ($seen -join ' | ')) }
        }
      } catch {}
      Start-Sleep -Milliseconds 150
    } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    Out-Result @{ ok = $false; code = 'stuck'; reason = 'loading'; ms = $sw.ElapsedMilliseconds; seen = (Encode ($seen -join ' | ')) }
  }
  'close' {
    Invoke-Step 'close' { Find-Named $CT::Button $L.close } $invoke 3000 | Out-Null
    Out-Result @{ ok = $true }
  }
  'dialog' {
    # 桌面端自己弹的确认框在会话内容的最下面。Claude 6.28899 实测有两种样子，按钮都认调用：
    #   每次操作都问的（"允许 Claude 在 xxx 上执行 JavaScript？"）：一行里是"拒绝""允许一次"；
    #   第一次打开一个网站的（"允许 Claude 操作 https://xxx？"）：一行里是"拒绝""始终允许""更多允许选项"，
    #   "允许一次"收在"更多允许选项"的下拉里。
    # 框可能被滚到屏幕外，所以不要求在屏幕上；会话里以前的框答完就收起了，万一有几个，取最靠下的那个
    # Choice：allow 允许一次、deny 拒绝、always 始终允许（只有第二种框有这个按钮）
    if (@('allow', 'deny', 'always') -notcontains $Choice) { Out-Result @{ ok = $false; code = 'bad-args' } }
    $want = Decode $Expect
    $pair = {
      $anchor = $null
      $denies = @()
      $alwayses = @()
      foreach ($b in (Find-All $CT::Button)) {
        $c = $b.Current
        if (-not $c.IsEnabled) { continue }
        if (($L.allowOnce -contains $c.Name) -or ($L.moreAllow -contains $c.Name)) {
          if (-not $anchor -or $c.BoundingRectangle.Y -gt $anchor.Current.BoundingRectangle.Y) { $anchor = $b }
        } elseif ($L.deny -contains $c.Name) { $denies += $b }
        elseif ($L.alwaysAllow -contains $c.Name) { $alwayses += $b }
      }
      if (-not $anchor) { return $null }
      # 同一个框里的"拒绝"和"允许一次"（或"更多允许选项"）在同一行，"始终允许"有的话也在这一行
      $y = $anchor.Current.BoundingRectangle.Y
      $sameRow = { param($list) $list | Where-Object { [Math]::Abs($_.Current.BoundingRectangle.Y - $y) -lt 40 } | Select-Object -First 1 }
      $deny = & $sameRow $denies
      if (-not $deny) { return $null }
      $inMenu = $L.moreAllow -contains $anchor.Current.Name
      return @{ allow = $anchor; deny = $deny; always = (& $sameRow $alwayses); inMenu = $inMenu }
    }
    $found = $null
    if (-not (Wait-True { $script:found = & $pair; $null -ne $script:found } $TimeoutMs)) {
      Out-Result @{ ok = $false; code = 'ui-missing'; step = 'dialog-buttons' }
    }
    $found = $script:found
    # 框里的文字：从"允许一次"往上找，第一层带文字的就是这个框（标题、说明，一共几段）。
    # 只在文字很少的那几层里核对网站名：再往上是整段对话，里面别处也会出现网站名，不能拿来核对
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $txtCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Text)
    $text = ''
    $p = $found.allow
    for ($i = 0; $i -lt 8 -and $p; $i++) {
      $p = $walker.GetParent($p)
      if (-not $p) { break }
      $parts = @(foreach ($t in $p.FindAll($Scope::Descendants, $txtCond)) { [string]$t.Current.Name })
      if ($parts.Count -eq 0) { continue }
      if ($parts.Count -gt 12) { break }
      $text = ($parts -join '')
      if (-not $want -or $text.Contains($want)) { break }
    }
    $seen = if ($text.Length -gt 300) { $text.Substring(0, 300) } else { $text }
    if ($want -and -not $text.Contains($want)) {
      Out-Result @{ ok = $false; code = 'mismatch'; seen = (Encode $seen) }
    }
    $btn = switch ($Choice) { 'allow' { $found.allow } 'always' { $found.always } default { $found.deny } }
    # 要"始终允许"，但这个框上没有这个按钮（每次操作都问的那种框不给长期授权）
    if (-not $btn) { Out-Result @{ ok = $false; code = 'ui-missing'; step = 'dialog-always'; seen = (Encode $seen) } }
    $viaMenu = ($Choice -eq 'allow') -and $found.inMenu
    $hadFocus = $false
    try { $hadFocus = [bool]$btn.Current.HasKeyboardFocus } catch {}
    if ($Probe -eq 1) { Out-Result @{ ok = $true; probe = $true; focused = $hadFocus; menu = [bool]$found.inMenu; always = [bool]$found.always; seen = (Encode $seen) } }
    # 实测（2026-11-21，用户在手机上连着答了 3 个框，每个都要选两次）：焦点不在按钮上时，"调用"只是把焦点移过来，
    # 框没有反应；焦点已经在按钮上时再调用才算点了。所以先把焦点放上去、等一下再调用。
    # 这样还没反应的话，被控端过两秒看桌面端日志里没有结果，会再来一次（dialogwatch.js）
    if (-not $hadFocus) {
      try { $btn.SetFocus() } catch {}
      Start-Sleep -Milliseconds 400
    }
    if ($viaMenu) {
      # "允许一次"在"更多允许选项"的下拉里：展开，再按里面的那一项。
      # 这条路写的时候没能在真框上试（替用户按批准框被 Claude Code 的安全检查拦下了，只能等用户自己在手机上选），
      # 所以找那一项时不挑它是哪种控件（菜单项、单选项……），名字对、可用、能调用就行
      try { Press $btn 'expand' } catch { Out-Result @{ ok = $false; code = 'ui-missing'; step = 'dialog-press' } }
      $findItem = {
        foreach ($n in $L.allowOnce) {
          $cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $n)
          foreach ($e in $win.FindAll($Scope::Descendants, $cond)) {
            $c = $e.Current
            if (-not $c.IsEnabled -or $c.ControlType -eq $CT::Text) { continue }
            $pp = $null
            if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pp)) { return $e }
          }
        }
        return $null
      }
      $script:item = $null
      if (-not (Wait-True { $script:item = & $findItem; $null -ne $script:item } 4000)) {
        # 没找到：把下拉里看到的东西带回去（被控端写进日志），再把下拉收起来，别让它一直开着
        $names = @()
        foreach ($t in @($CT::MenuItem, $CT::ListItem, $CT::RadioButton)) {
          foreach ($e in (Find-All $t)) { $names += [string]$e.Current.Name }
        }
        try { $btn.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() } catch {}
        $list = ($names -join ' | ')
        if ($list.Length -gt 300) { $list = $list.Substring(0, 300) }
        Out-Result @{ ok = $false; code = 'ui-missing'; step = 'dialog-menu'; seen = (Encode $list) }
      }
      try { Press $script:item 'invoke' } catch { Out-Result @{ ok = $false; code = 'ui-missing'; step = 'dialog-menu-press' } }
      Out-Result @{ ok = $true; focused = $hadFocus; menu = $true; seen = (Encode $seen) }
    }
    try { Press $btn 'invoke' } catch { Out-Result @{ ok = $false; code = 'ui-missing'; step = 'dialog-press' } }
    Out-Result @{ ok = $true; focused = $hadFocus; menu = $false; seen = (Encode $seen) }
  }
}
