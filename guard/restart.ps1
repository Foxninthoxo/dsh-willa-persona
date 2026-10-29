# restart.ps1 —— 从 DSH 会话里「脱身」重启 dsh web 的第一段：只注册一次性计划任务，不做停止动作。
#
# 为什么不能在这个脚本里直接 stop 宿主：
#   DSH 会话里起的子进程都挂在同一个 Windows job 对象里，job 设了
#   「job 关闭就把里面所有进程一起结束」。web 宿主在这个 job 里，
#   脚本自己也在。脚本一旦 Stop-Process 掉宿主，宿主一退 job 就关，
#   脚本跟着被带走，「停」完成了、「起」那一步永远没机会执行，
#   结果是服务空着、没有任何人把它拉回来。
#
#   所以拆成两段：
#     第一段（本脚本）：只调 schtasks 注册并 /run 一个一次性任务，写完就退出。
#     第二段（restart-worker.ps1）：由计划任务启动。计划任务的进程树在
#       服务宿主（svchost）下面，不在会话的 job 里，所以它停得掉 web 宿主，
#       停完自己还活着，能继续把服务起回来。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File restart.ps1
#   powershell -ExecutionPolicy Bypass -File restart.ps1 -DryRun     # 只打印会做什么
#   powershell -ExecutionPolicy Bypass -File restart.ps1 -Config .\my.json
#
# 参数优先级：命令行 > 配置文件 > 内置默认。配置文件默认找同目录的
# dsh-guard.config.json，不存在就用默认值（不报错）。
# 配置文件不是默认路径时，会把 -Config 一起拼进 restart-worker.ps1 的命令行，
# 保证计划任务里跑的那一层读的是同一份配置（这条会占 schtasks 的 261 字符余量）。
#
# 日志：<LogDir>\dsh-restart.log（本层）；<LogDir>\dsh-restart-worker.log（真干活那层）

[CmdletBinding()]
param(
    [int]$Port = 3080,

    [string]$StateDir = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'dsh-web' } else { Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-web' }),

    [string]$LogDir = $(if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }),

    [string]$EnvFile,

    [string]$TaskPrefix = 'DshGuard',

    [string]$PermissionMode = '',

    # 停旧服务后等端口空出来的上限（秒），转给 restart-worker.ps1
    [int]$RestartWaitSeconds = 20,

    # ---- 重启完成后报平安（可选），原样转给 restart-worker.ps1 ----
    # 四个都空 = 不发任何东西；只在配了的时候才进任务命令行。
    [string]$NotifyPrivate = '',
    [string]$NotifyGroup = '',
    [string]$NotifyUrl = '',
    [string]$NotifyToken = '',

    # 配置文件路径。不传就找 $PSScriptRoot\dsh-guard.config.json，没有就用默认值。
    [string]$Config = '',

    # 只打印「会注册什么任务、会跑什么命令」，不真注册、不碰服务。
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
if (-not $PSBoundParameters.ContainsKey('RestartWaitSeconds')) {
    $v = Config-Value $cfg 'restartWaitSeconds'
    if ($null -ne $v -and "$v" -ne '') { $RestartWaitSeconds = [int]$v }
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

$here = $PSScriptRoot
$taskName = "$TaskPrefix-Restart"
$worker = Join-Path $here 'restart-worker.ps1'
$log = Join-Path $LogDir 'dsh-restart.log'

function Log([string]$m) {
    $line = (Get-Date).ToString('HH:mm:ss') + '  ' + $m
    if ($DryRun) { Write-Host $line; return }
    try {
        if (-not (Test-Path -LiteralPath $LogDir)) {
            New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
        }
        Add-Content -Path $log -Value $line -Encoding UTF8
    } catch { Write-Host $line }
}

function Show([string]$m) { Write-Host "[restart] $m" }

# 把参数拼成计划任务要跑的命令行。路径里有空格时加引号。
function Q([string]$s) {
    if ($s -and $s -match '[\s"]') { return '"' + $s + '"' }
    return $s
}

function Same([string]$a, [string]$b) {
    if (-not $a -and -not $b) { return $true }
    if (-not $a -or -not $b) { return $false }
    return ([System.IO.Path]::GetFullPath($a).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($b).TrimEnd('\'))
}

# schtasks /tr 只有 261 字符的余量，所以只把「和默认值不一样」的参数写进命令行。
# 计划任务跟本脚本是同一个用户，worker 自己推导出来的默认值跟这里一致。
$defState = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'dsh-web' } else { Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-web' })
$defLog = $(if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() })

$parts = @(
    'powershell.exe',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', (Q $worker)
)
# 配置文件不是默认路径时，worker 自己找不到它，必须把 -Config 带进命令行。
$configIsDefault = (-not $configUsed) -or (Same $configUsed $script:ConfigDefaultPath)
if ($configUsed -and -not $configIsDefault) { $parts += @('-Config', (Q $configUsed)) }
if ($Port -ne 3080) { $parts += @('-Port', $Port) }
if (-not (Same $StateDir $defState)) { $parts += @('-StateDir', (Q $StateDir)) }
if (-not (Same $LogDir $defLog)) { $parts += @('-LogDir', (Q $LogDir)) }
if ($TaskPrefix -ne 'DshGuard') { $parts += @('-TaskPrefix', $TaskPrefix) }
if ($EnvFile) { $parts += @('-EnvFile', (Q $EnvFile)) }
if ($PermissionMode) { $parts += @('-PermissionMode', $PermissionMode) }
if ($RestartWaitSeconds -ne 20) { $parts += @('-RestartWaitSeconds', $RestartWaitSeconds) }
$tr = ($parts -join ' ')

# 通知参数：只在非空时才带。带之前先算长度 —— schtasks /tr 只有 261 字符，
# 超了就不带（worker 找不到命令行参数会退回自己读配置文件，功能不丢）。
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
    Show 'DryRun：不注册任务、不碰服务，只把会做的事打印出来'
    Show ''
    Show ("会注册的一次性任务名：" + $taskName)
    Show '触发方式：/sc once /st 00:00，注册完立刻 /run 一次'
    Show ''
    Show ("配置文件：" + $(if ($configUsed) { $configUsed + $(if ($configIsDefault) { '（默认路径）' } else { '（-Config 会带进任务命令行）' }) } else { '没有，全用内置默认' }))
    Show '生效的参数（没写进命令行的，worker 用自己的默认值）：'
    Show ("  Port=" + $Port + "  StateDir=" + $StateDir + "  LogDir=" + $LogDir + "  TaskPrefix=" + $TaskPrefix)
    if ($EnvFile) { Show ("  EnvFile=" + $EnvFile) }
    if ($PermissionMode) { Show ("  PermissionMode=" + $PermissionMode) }
    Show ("  RestartWaitSeconds=" + $RestartWaitSeconds)
    if ($NotifyPrivate -or $NotifyGroup -or $NotifyToken) {
        Show ("  NotifyPrivate=" + $(if ($NotifyPrivate) { $NotifyPrivate } else { '<空>' }) +
              "  NotifyGroup=" + $(if ($NotifyGroup) { $NotifyGroup } else { '<空>' }))
        Show ("  NotifyUrl=" + $NotifyUrl +
              "  NotifyToken=" + $(if ($NotifyToken) { '<已配，长度 ' + $NotifyToken.Length + '，不打印>' } else { '<空>' }))
    } else {
        Show '  NotifyPrivate/NotifyGroup/NotifyToken=空 —— 不发通知'
    }
    Show ''
    Show '任务命令行（就是 schtasks /tr 的值）：'
    Write-Host ('  ' + $tr)
    Show ("命令行长度：" + $tr.Length + " 字符（schtasks 的上限 261）")
    if ($notifyDropped) {
        Show ''
        Show '注意：带上通知参数会超过 261，已按规矩不带；worker 会退回读配置文件里的 notify*。'
        Show '      想让通知生效：把 dsh-guard.config.json 放回脚本同目录（默认路径）就行。'
    }
    Show ''
    Show '等价的手工命令：'
    Write-Host ('  schtasks /create /tn "' + $taskName + '" /tr "' + $tr + '" /sc once /st 00:00 /f')
    Write-Host ('  schtasks /run /tn "' + $taskName + '"')
    Show ''
    Show ("之后由 $worker 停旧 web、等端口空、再调 open-harness.ps1 -NoOpen 起回来")
    exit 0
}

Log 'restart: begin'

if (-not (Test-Path -LiteralPath $worker)) {
    Log ("restart: FAILED 找不到 " + $worker)
    Write-Host "[restart] 找不到 $worker"
    exit 1
}

# schtasks /tr 硬上限 261。超了宁可失败，也别注册一个会被截断的任务。
if ($tr.Length -gt 261) {
    Log ("restart: FAILED 任务命令行 " + $tr.Length + " 字符，超过 schtasks 上限 261")
    Write-Host ("[restart] 任务命令行 " + $tr.Length + " 字符，超过 schtasks 的 261 上限，没注册")
    Write-Host '[restart] 办法：把 guard 目录挪到短路径（比如 C:\guard）；或把配置放回默认位置'
    Write-Host '[restart]       （脚本同目录的 dsh-guard.config.json，就不必带 -Config）。'
    Write-Host '[restart]       -TaskPrefix 只缩短任务名，不缩短这条命令行。'
    exit 1
}
if ($tr.Length -gt 240) {
    Log ("restart: WARN 命令行太长（" + $tr.Length + " 字符），schtasks 可能截断；建议把 -StateDir/-LogDir 换成短路径")
}
if ($notifyDropped) {
    Log ('restart: WARN 通知参数会让命令行超 261，没带；worker 会退回读配置文件里的 notify*')
    Write-Host '[restart] 通知参数会让命令行超过 261，所以没带（不影响重启）'
    Write-Host '[restart] 想让通知生效：把 dsh-guard.config.json 放回脚本同目录（默认路径）。'
}

Log ("restart: 注册一次性任务 " + $taskName)
& schtasks.exe /create /tn $taskName /tr $tr /sc once /st 00:00 /f *>&1 | ForEach-Object { Log ('  ' + $_) }
$createExit = $LASTEXITCODE
Log ("restart: 注册 exit=" + $createExit)

if ($createExit -ne 0) {
    Log 'restart: 注册失败，退回去什么也不做（宿主还活着，这是安全的失败）'
    Write-Host "[restart] 注册任务失败，服务没动"
    exit 1
}

Log ("restart: 立刻运行 " + $taskName)
& schtasks.exe /run /tn $taskName *>&1 | ForEach-Object { Log ('  ' + $_) }
Log ("restart: run exit=" + $LASTEXITCODE)

Log 'restart: 交给计划任务了，本进程退出；几秒后宿主会被 worker 停掉，这里是最后一笔'
Write-Host "[restart] 已交给计划任务 $taskName，几秒后服务会换一个新实例"
exit 0
