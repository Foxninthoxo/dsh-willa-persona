# restart-worker.ps1 —— 两段式重启的第二段：真正停旧、起新的那一半。
#
# 谁调它：由计划任务（Task Scheduler）调，**不要** 从 DSH 会话里直接调。
# 为什么：DSH 会话里起的子进程挂在「job 关闭就一起结束」的 Windows job 里。
#        从会话里 Stop-Process 掉 web 宿主，脚本自己也会被带走，
#        「停」完成了、「起」永远执行不到。
#        计划任务起的进程树在服务宿主下面，不在会话的 job 里，
#        所以它杀得掉 web 宿主，自己还活得下来，能把服务起回来。
#
# 流程：留 flag → 停旧 web 宿主 → 等端口空 → open-harness.ps1 -NoOpen 起回来
#       → 健康检查 → 撤 flag。
#
# 日志：<LogDir>\dsh-restart-worker.log（每次追加，带时间戳）
#
# 参数优先级：命令行 > 配置文件 > 内置默认。配置文件默认找同目录的
# dsh-guard.config.json；restart.ps1 在配置不是默认路径时会用 -Config 指过来。

[CmdletBinding()]
param(
    [int]$Port = 3080,

    [string]$StateDir = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'dsh-web' } else { Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-web' }),

    [string]$LogDir = $(if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }),

    [string]$EnvFile,

    [string]$TaskPrefix = 'DshGuard',

    [string]$PermissionMode = '',

    # 停旧服务后等端口空出来的上限（秒）
    [int]$RestartWaitSeconds = 20,

    # ---- 重启完成后报平安（可选）。四个都空 = 不发任何东西。 ----
    # 私聊收件人 QQ 号；群号。都填就两边都发。
    [string]$NotifyPrivate = '',
    [string]$NotifyGroup = '',

    # OneBot HTTP 服务地址（空 = 不发；由 -NotifyUrl 或配置文件给，不写死）。
    [string]$NotifyUrl = '',

    # OneBot 的 accessToken；配了就以 Authorization: Bearer <token> 发出去。
    [string]$NotifyToken = '',

    # 配置文件路径。不传就找 $PSScriptRoot\dsh-guard.config.json，没有就用默认值。
    [string]$Config = ''
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
if ($RestartWaitSeconds -lt 1) { $RestartWaitSeconds = 1 }

# 通知四项走同一套优先级：命令行 > 配置文件 > 默认。空字符串当「没配」。
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
$log = Join-Path $LogDir 'dsh-restart-worker.log'
$flagPath = Join-Path $StateDir 'restarting.flag'
$stateFile = Join-Path $StateDir 'url.txt'
$script:DshBinPattern = 'dsh[\\/]lib[\\/]bin\.js'

function Log([string]$m) {
    $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + $m
    try {
        if (-not (Test-Path -LiteralPath $LogDir)) {
            New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
        }
        Add-Content -Path $log -Value $line -Encoding UTF8
    } catch { Write-Host $line }
}

# 发一条 QQ 通知。走 OneBot HTTP（POST /send_private_msg 或 /send_group_msg）。
# 规矩：通知只是锦上添花 —— 没配就静默跳过，发不出去只写日志，
#       绝不让它影响重启结果（每条请求各自 try/catch，超时 10 秒）。
function Send-Notify([string]$text) {
    if (-not $NotifyPrivate -and -not $NotifyGroup) {
        Log 'notify: 没配 notifyPrivate / notifyGroup，跳过'
        return
    }
    if (-not $NotifyUrl) {
        Log 'notify: 没配 notifyUrl，跳过'
        return
    }

    $base = $NotifyUrl.TrimEnd('/')
    $targets = @()
    if ($NotifyPrivate) {
        if ($NotifyPrivate -match '^\d+$') {
            $targets += @{ Path = '/send_private_msg'; Key = 'user_id'; Id = [long]$NotifyPrivate }
        } else {
            Log ('notify: notifyPrivate 不是 QQ 号，跳过：' + $NotifyPrivate)
        }
    }
    if ($NotifyGroup) {
        if ($NotifyGroup -match '^\d+$') {
            $targets += @{ Path = '/send_group_msg'; Key = 'group_id'; Id = [long]$NotifyGroup }
        } else {
            Log ('notify: notifyGroup 不是群号，跳过：' + $NotifyGroup)
        }
    }
    if ($targets.Count -eq 0) { return }

    foreach ($t in $targets) {
        try {
            # body 形状照 OneBot 11：message 是消息段数组，不是纯字符串。
            $payload = @{ message = @(@{ type = 'text'; data = @{ text = $text } }) }
            $payload[$t.Key] = $t.Id
            $json = $payload | ConvertTo-Json -Depth 6 -Compress
            $headers = @{}
            if ($NotifyToken) { $headers['Authorization'] = 'Bearer ' + $NotifyToken }
            Invoke-RestMethod -Uri ($base + $t.Path) -Method Post -Headers $headers `
                -ContentType 'application/json; charset=utf-8' `
                -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) `
                -TimeoutSec 10 -ErrorAction Stop | Out-Null
            Log ('notify: 已发 ' + $t.Path + ' id=' + $t.Id)
        } catch {
            # 超时 / 连不上 / 401：都只算「这条平安没报成」，日志里留一笔就够。
            Log ('notify: 发失败（忽略）' + $t.Path + ' id=' + $t.Id + ' —— ' + $_.Exception.Message)
        }
    }
}

function Test-PortOpen {
    param([int]$p)
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $ok = $c.ConnectAsync('127.0.0.1', $p).Wait(800)
        $c.Close()
        return $ok
    } catch { return $false }
}

Log ("=== worker: begin (task prefix " + $TaskPrefix + ", config " + $(if ($configUsed) { $configUsed } else { '<none>' }) + ")")
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# 举手：告诉看门任务（open-harness.ps1 -Ensure）现在别插手，
# 免得跟这次手动重启撞出两个实例。3 分钟后 flag 自动失效，不会永久挡住看门。
Set-Content -Path $flagPath -Value (Get-Date).ToString('o') -Encoding UTF8

try {
    # 给调用方留几秒把最后一句回复发出去（本进程不会被宿主杀，这里只是礼貌）。
    Start-Sleep -Seconds 4

    # ---- 1. 停旧的 web 宿主（只认 dsh\lib\bin.js web 这一种命令行，不碰别的 node 进程）
    $old = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match $script:DshBinPattern -and
        $_.CommandLine -match '(\s|")web(\s|"|$)'
    })
    if ($old.Count -eq 0) {
        Log 'worker: 没找到在跑的 web 宿主'
    } else {
        foreach ($p in $old) {
            Log ("worker: stop old web pid " + $p.ProcessId)
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    # ---- 2. 等端口真的空下来（最多 RestartWaitSeconds 秒，默认 20）
    $freed = $false
    for ($i = 0; $i -lt ($RestartWaitSeconds * 2); $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Test-PortOpen -p $Port)) { $freed = $true; break }
    }
    Log ("worker: 端口 $Port 已空 = $freed（最多等 $RestartWaitSeconds 秒）")

    # ---- 3. 起回来
    $oh = Join-Path $here 'open-harness.ps1'
    Log ("worker: 调 open-harness.ps1 -NoOpen（" + $oh + "）")
    if (-not (Test-Path -LiteralPath $oh)) {
        Log 'worker: FAILED 找不到 open-harness.ps1，服务现在可能是停的'
    } else {
        $callArgs = @{
            NoOpen  = $true
            Port    = $Port
            StateDir = $StateDir
            LogDir  = $LogDir
            TaskPrefix = $TaskPrefix
        }
        if ($EnvFile) { $callArgs['EnvFile'] = $EnvFile }
        if ($PermissionMode) { $callArgs['PermissionMode'] = $PermissionMode }
        # 配置不是默认路径就继续往下传，让 open-harness 读同一份。
        if ($configUsed -and -not $configIsDefault) { $callArgs['Config'] = $configUsed }
        try {
            & $oh @callArgs *>> $log
            Log ("worker: open-harness 返回 exit=" + $LASTEXITCODE)
        } catch {
            Log ('worker: open-harness 抛异常 ' + $_.Exception.Message)
        }
    }

    # ---- 4. 健康检查：端口 + 存下的地址
    Start-Sleep -Seconds 2
    $up = Test-PortOpen -p $Port
    $saved = '<missing>'
    if (Test-Path -LiteralPath $stateFile) { $saved = (Get-Content -LiteralPath $stateFile -Raw).Trim() }
    # 地址里带令牌，只记长度不记内容，免得日志本身变成凭据泄漏点。
    Log ("worker: 端口活着 = $up ; url.txt 长度 = " + $saved.Length)

    if ($up) { Log '=== worker: 好了' } else { Log '=== worker: 失败了，看上面 open-harness 的输出' }

    # ---- 5. 报平安（可选）：配了收件人才真的发。成功一条、失败一条。
    # 通知失败只写日志 —— 这条链上最重要的是服务起没起来，不能被一条消息带崩。
    try {
        if ($up) {
            Send-Notify ('重启完成，服务已恢复（' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '）')
        } else {
            Send-Notify '重启后服务没起来，需要看日志'
        }
    } catch {
        Log ('notify: 出错（忽略）' + $_.Exception.Message)
    }
}
finally {
    # 收手：撤掉 flag，看门任务恢复正常。
    Remove-Item -LiteralPath $flagPath -Force -ErrorAction SilentlyContinue
    Log 'worker: flag 已撤'
}
