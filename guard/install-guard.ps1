# install-guard.ps1 —— 注册（或更新）每 5 分钟一次的看门计划任务。
#
# 看门任务做的事：跑 open-harness.ps1 -Ensure -NoOpen。
#   - 服务活着 → 直接 exit 0，什么也不动；
#   - 服务没了 → 拉起来；
#   - 正在重启（restarting.flag 三分钟内）→ 让路。
#
# 任务只在你登录时运行（默认 /ru 当前用户），因为 dsh web 本来就是按会话起的。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File install-guard.ps1
#   powershell -ExecutionPolicy Bypass -File install-guard.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File install-guard.ps1 -Config .\my.json
#   powershell -ExecutionPolicy Bypass -File uninstall-guard.ps1     # 删掉
#
# 参数优先级：命令行 > 配置文件 > 内置默认。配置文件默认找同目录的
# dsh-guard.config.json，不存在就用默认值（不报错）。看门间隔取自
# guardEveryMinutes（命令行用 -IntervalMinutes 覆盖）。

[CmdletBinding()]
param(
    [int]$Port = 3080,

    [string]$StateDir = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'dsh-web' } else { Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-web' }),

    [string]$LogDir = $(if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }),

    [string]$EnvFile,

    [string]$TaskPrefix = 'DshGuard',

    # 可选：给 dsh 子进程设 DSH_PERMISSION_MODE。留空表示不动，用 dsh 自己的默认。
    [string]$PermissionMode = '',

    # 看门间隔（分钟）。配置文件里叫 guardEveryMinutes。
    [int]$IntervalMinutes = 5,

    # ---- 看门把服务拉起来之后报平安（可选），转给 open-harness.ps1 -Ensure ----
    # 四个都空 = 没这功能；只在配了的时候才进任务命令行。
    [string]$NotifyPrivate = '',
    [string]$NotifyGroup = '',
    [string]$NotifyUrl = '',
    [string]$NotifyToken = '',

    # 配置文件路径。不传就找 $PSScriptRoot\dsh-guard.config.json，没有就用默认值。
    [string]$Config = '',

    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

# ---- 配置：优先级 命令行 > 配置文件 > 内置默认 ----
# 默认读脚本同目录的 dsh-guard.config.json。不存在就算了，不报错，退回默认值。
# 配置文件里的路径可以写 %VAR%，这里统一展开。
$script:ConfigDefaultPath = Join-Path $PSScriptRoot 'dsh-guard.config.json'

function Resolve-ConfigPath([string]$p) {
    if (-not $p) { return $null }
    if (-not [System.IO.Path]::IsPathRooted($p)) { $p = Join-Path (Get-Location).Path $p }
    return [System.IO.Path]::GetFullPath($p)
}

function Read-GuardConfig([string]$path) {
    if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop
        if (-not $raw -or -not $raw.Trim()) { return $null }
        return ($raw | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        Write-Warning ("配置文件读不了，按默认值走：" + $path + " —— " + $_.Exception.Message)
        return $null
    }
}

# 取配置项；键名不分大小写，没有这个键就返回 $null。
function Config-Value($cfg, [string]$name) {
    if ($null -eq $cfg) { return $null }
    $p = $cfg.PSObject.Properties | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
    if ($null -eq $p) { return $null }
    return $p.Value
}

function Expand-ConfigPath([string]$s) {
    if (-not $s) { return $s }
    return [System.Environment]::ExpandEnvironmentVariables($s)
}

$configPath = Resolve-ConfigPath $Config
if (-not $configPath) { $configPath = $script:ConfigDefaultPath }
if ($Config -and -not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Write-Warning ("-Config 指定的文件不存在，按默认值走：" + $configPath)
}
$configUsed = if (Test-Path -LiteralPath $configPath -PathType Leaf) { $configPath } else { '' }
$cfg = Read-GuardConfig $configUsed

# $PSBoundParameters 只记真正从命令行传进来的参数：传了就以命令行为准。
if (-not $PSBoundParameters.ContainsKey('Port')) {
    $v = Config-Value $cfg 'port'
    if ($null -ne $v -and "$v" -ne '') { $Port = [int]$v }
}
if (-not $PSBoundParameters.ContainsKey('StateDir')) {
    $v = Expand-ConfigPath (Config-Value $cfg 'stateDir')
    if ($v) { $StateDir = $v }
}
if (-not $PSBoundParameters.ContainsKey('LogDir')) {
    $v = Expand-ConfigPath (Config-Value $cfg 'logDir')
    if ($v) { $LogDir = $v }
}
if (-not $PSBoundParameters.ContainsKey('EnvFile')) {
    $v = Expand-ConfigPath (Config-Value $cfg 'envFile')
    if ($v) { $EnvFile = $v }
}
if (-not $PSBoundParameters.ContainsKey('TaskPrefix')) {
    $v = Config-Value $cfg 'taskPrefix'
    if ($v) { $TaskPrefix = [string]$v }
}
if (-not $PSBoundParameters.ContainsKey('PermissionMode')) {
    $v = Config-Value $cfg 'permissionMode'
    if ($v) { $PermissionMode = [string]$v }
}
if (-not $PSBoundParameters.ContainsKey('IntervalMinutes')) {
    $v = Config-Value $cfg 'guardEveryMinutes'
    if ($null -ne $v -and "$v" -ne '') { $IntervalMinutes = [int]$v }
}

# 通知四项：空字符串当「没配」，不会把参数清空。
if (-not $PSBoundParameters.ContainsKey('NotifyPrivate')) {
    $v = Config-Value $cfg 'notifyPrivate'
    if ($v) { $NotifyPrivate = [string]$v }
}
if (-not $PSBoundParameters.ContainsKey('NotifyGroup')) {
    $v = Config-Value $cfg 'notifyGroup'
    if ($v) { $NotifyGroup = [string]$v }
}
if (-not $PSBoundParameters.ContainsKey('NotifyUrl')) {
    $v = Config-Value $cfg 'notifyUrl'
    if ($v) { $NotifyUrl = [string]$v }
}
if (-not $PSBoundParameters.ContainsKey('NotifyToken')) {
    $v = Config-Value $cfg 'notifyToken'
    if ($v) { $NotifyToken = [string]$v }
}

$configIsDefault = (-not $configUsed) -or ([System.IO.Path]::GetFullPath($configUsed).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($script:ConfigDefaultPath).TrimEnd('\'))

$here = $PSScriptRoot
$taskName = "$TaskPrefix-Guard"
$openHarness = Join-Path $here 'open-harness.ps1'

function Show([string]$m) { Write-Host "[install-guard] $m" }

# 同目录没有配置文件时提一句，省得通知四项还得手抄。
if (-not (Test-Path -LiteralPath $script:ConfigDefaultPath -PathType Leaf)) {
    Show '同目录没有 dsh-guard.config.json，可以跑 autoconfig.ps1 自动生成（先加 -DryRun 看看）'
}

function Q([string]$s) {
    if ($s -and $s -match '[\s"]') { return '"' + $s + '"' }
    return $s
}

if (-not (Test-Path -LiteralPath $openHarness)) {
    Show "找不到 $openHarness，先确认脚本都放在同一个目录"
    exit 1
}
if ($IntervalMinutes -lt 1) {
    Show "-IntervalMinutes 至少是 1"
    exit 1
}

function Same([string]$a, [string]$b) {
    if (-not $a -and -not $b) { return $true }
    if (-not $a -or -not $b) { return $false }
    return ([System.IO.Path]::GetFullPath($a).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($b).TrimEnd('\'))
}

# schtasks /tr 只有 261 字符的余量，所以只把「和默认值不一样」的参数写进命令行。
# 计划任务跟本脚本是同一个用户，脚本自己推导出来的默认值跟这里一致。
$defState = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'dsh-web' } else { Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-web' })
$defLog = $(if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() })

$parts = @(
    'powershell.exe',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', (Q $openHarness),
    '-Ensure',
    '-NoOpen'
)
# 配置文件不是默认路径时，看门任务自己找不到它，必须把 -Config 带进命令行。
if ($configUsed -and -not $configIsDefault) { $parts += @('-Config', (Q $configUsed)) }
if ($Port -ne 3080) { $parts += @('-Port', $Port) }
if (-not (Same $StateDir $defState)) { $parts += @('-StateDir', (Q $StateDir)) }
if (-not (Same $LogDir $defLog)) { $parts += @('-LogDir', (Q $LogDir)) }
if ($TaskPrefix -ne 'DshGuard') { $parts += @('-TaskPrefix', $TaskPrefix) }
if ($EnvFile) { $parts += @('-EnvFile', (Q $EnvFile)) }
if ($PermissionMode) { $parts += @('-PermissionMode', $PermissionMode) }
$tr = ($parts -join ' ')

# 通知参数：只在非空时才带；带之前先算长度，超 261 就不带。
# open-harness 自己也会读默认位置的配置文件，所以不带不等于没这功能。
$notifyParts = @()
if ($NotifyPrivate -or $NotifyGroup) {
    if ($NotifyPrivate) { $notifyParts += @('-NotifyPrivate', $NotifyPrivate) }
    if ($NotifyGroup) { $notifyParts += @('-NotifyGroup', $NotifyGroup) }
    if ($NotifyUrl) { $notifyParts += @('-NotifyUrl', (Q $NotifyUrl)) }
    if ($NotifyToken) { $notifyParts += @('-NotifyToken', (Q $NotifyToken)) }
}

$notifyDropped = $false
if ($notifyParts.Count -gt 0) {
    $trWithNotify = (($parts + $notifyParts) -join ' ')
    if ($trWithNotify.Length -le 261) {
        $tr = $trWithNotify
    } else {
        $notifyDropped = $true
    }
}

if ($DryRun) {
    Show 'DryRun：不注册任务，只打印会做的事'
    Show ''
    Show ("任务名：" + $taskName + "（每 " + $IntervalMinutes + " 分钟，仅当前用户登录时）")
    Show ("配置文件：" + $(if ($configUsed) { $configUsed + $(if ($configIsDefault) { '（默认路径）' } else { '（-Config 会带进任务命令行）' }) } else { '没有，全用内置默认' }))
    Show ("生效的参数：Port=" + $Port + "  StateDir=" + $StateDir + "  LogDir=" + $LogDir + "  TaskPrefix=" + $TaskPrefix)
    if ($PermissionMode) { Show ("  PermissionMode=" + $PermissionMode) }
    Show ("看门间隔：" + $IntervalMinutes + " 分钟（配置键 guardEveryMinutes）")
    if ($NotifyPrivate -or $NotifyGroup -or $NotifyToken) {
        Show ("通知：NotifyPrivate=" + $(if ($NotifyPrivate) { $NotifyPrivate } else { '<空>' }) +
              "  NotifyGroup=" + $(if ($NotifyGroup) { $NotifyGroup } else { '<空>' }) +
              "  NotifyUrl=" + $NotifyUrl +
              "  NotifyToken=" + $(if ($NotifyToken) { '<已配，长度 ' + $NotifyToken.Length + '，不打印>' } else { '<空>' }))
        Show '      看门真把服务拉起来时发一条；服务活着不打扰'
    } else {
        Show '通知：没配 notifyPrivate / notifyGroup，看门不报平安'
    }
    Show '任务命令行：'
    Write-Host ('  ' + $tr)
    Show ("命令行长度：" + $tr.Length + " 字符（schtasks 的上限 261）")
    if ($notifyDropped) {
        Show '注意：带上通知参数会超过 261，已按规矩不带；open-harness 会退回读配置文件里的 notify*。'
        Show '      想让通知生效：把 dsh-guard.config.json 放回脚本同目录（默认路径）就行。'
    }
    Show ''
    Show '等价的手工命令：'
    Write-Host ('  schtasks /create /tn "' + $taskName + '" /tr "' + $tr + '" /sc minute /mo ' + $IntervalMinutes + ' /f')
    exit 0
}

# 超了宁可失败，也别注册一个会被截断的任务。
if ($tr.Length -gt 261) {
    Show ("任务命令行 " + $tr.Length + " 字符，超过 schtasks 上限 261，没注册")
    Show '办法：把 guard 目录挪到短路径（比如 C:\guard）；或把配置放回默认位置'
    Show '      （脚本同目录的 dsh-guard.config.json，就不必带 -Config）。'
    Show '      -TaskPrefix 只缩短任务名，不缩短这条命令行。'
    exit 1
}
if ($tr.Length -gt 240) {
    Show ("警告：命令行 " + $tr.Length + " 字符，接近 schtasks 上限；建议把 dsh-guard 目录挪到短路径")
}
if ($notifyDropped) {
    Show '通知参数会让命令行超过 261，所以没带（不影响看门）；open-harness 会退回读配置文件里的 notify*'
    Show '想让通知生效：把 dsh-guard.config.json 放回脚本同目录（默认路径）'
}

Show ("注册 " + $taskName + "，每 " + $IntervalMinutes + " 分钟一次")
& schtasks.exe /create /tn $taskName /tr $tr /sc minute /mo $IntervalMinutes /f *>&1 | ForEach-Object { Write-Host ('  ' + $_) }
$code = $LASTEXITCODE

if ($code -ne 0) {
    Show ("注册失败，exit=" + $code + "（看上面 schtasks 的输出；权限不够时用管理员窗口重试）")
    exit 1
}

Show '注册好了。查状态：'
Show ('  schtasks /query /tn "' + $taskName + '" /v /fo LIST')
Show ('立刻试跑一次： schtasks /run /tn "' + $taskName + '"')
exit 0
