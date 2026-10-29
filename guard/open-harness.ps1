# open-harness.ps1 —— 起 DSH Web、抓带令牌的地址、看门。
#
# 为什么需要这个脚本：
#   dsh web 每次启动都会现生成一个访问令牌，令牌只打印在启动那行
#   `dsh web: <url>?token=...` 里，不会写到任何固定文件。所以想拿到可用地址，
#   只能「自己起一次，再把日志里那一行抓下来」。本脚本负责起服务、抓那一行、
#   把地址存进 StateDir\url.txt；下次先拿存下的地址探一下，还有效就直接开。
#
# 这个文件是可公开版本：不含任何机器名、账号、私有目录。所有路径走参数，
# 默认值用 $PSScriptRoot / 环境变量推导。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File open-harness.ps1 [-Port 3080]
#   powershell -ExecutionPolicy Bypass -File open-harness.ps1 -Restart      # 强制重启
#   powershell -ExecutionPolicy Bypass -File open-harness.ps1 -NoOpen       # 只起服务，不开浏览器
#   powershell -ExecutionPolicy Bypass -File open-harness.ps1 -Ensure -NoOpen  # 看门模式（给计划任务）
#   powershell -ExecutionPolicy Bypass -File open-harness.ps1 -Config .\my.json
#
# 参数优先级：命令行 > 配置文件 > 内置默认。配置文件默认找同目录的
# dsh-guard.config.json，不存在就用默认值（不报错）；-Config 可以指别的文件。
#
# 注意：这个文件必须存成 UTF-8 **带 BOM**。Windows PowerShell 5.1 对无 BOM 的
# 文件按系统 ANSI 代码页解析，中文注释会把脚本解析崩掉（报 Unexpected token）。

[CmdletBinding()]
param(
    [int]$Port = 3080,

    # 服务状态目录：放 url.txt（带令牌的地址）和 restarting.flag（重启避让标记）
    [string]$StateDir = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'dsh-web' } else { Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-web' }),

    # 日志目录：dsh-web.log / dsh-web.err.log
    [string]$LogDir = $(if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }),

    # 可选：从这个文件里读 DEEPSEEK_API_KEY（形如 KEY=value，可带引号）。
    # 不给就要求当前进程环境里已经有这个变量。
    [string]$EnvFile,

    # 计划任务名前缀，只用于提示文案；实际任务名见 install-guard.ps1
    [string]$TaskPrefix = 'DshGuard',

    # 可选：给 dsh 子进程设 DSH_PERMISSION_MODE。留空表示不动，用 dsh 自己的默认。
    # 需要 worker 在会话工作区之外跑原生程序时，才显式传 danger-full-access。
    [string]$PermissionMode = '',

    # ---- 看门把服务拉起来之后报平安（可选）。四个都空 = 不发 ----
    [string]$NotifyPrivate = '',
    [string]$NotifyGroup = '',
    # 空 = 不发；地址由 -NotifyUrl 或配置文件给，不写死。
    [string]$NotifyUrl = '',
    [string]$NotifyToken = '',

    # 配置文件路径。不传就找 $PSScriptRoot\dsh-guard.config.json，没有就用默认值。
    [string]$Config = '',

    [switch]$Restart,
    [switch]$Ensure,
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'

function Say($m) { Write-Host "[harness] $m" }

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

# 通知四项：空字符串当「没配」。
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

$stateFile = Join-Path $StateDir 'url.txt'
$log = Join-Path $LogDir 'dsh-web.log'
$err = Join-Path $LogDir 'dsh-web.err.log'

# 识别「正在跑的 dsh web 宿主」用：npm 全局安装后入口是 ...\dsh\lib\bin.js，
# 命令行里带 web 子命令。只认这个特征，避免误杀机器上别的 node 进程。
$script:DshBinPattern = 'dsh[\\/]lib[\\/]bin\.js'

function Test-Port {
    param([int]$p)
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $ok = $c.ConnectAsync('127.0.0.1', $p).Wait(800)
        $c.Close()
        return $ok
    } catch { return $false }
}

# 看门把服务拉起来之后发一条 QQ 通知（OneBot HTTP）。
# 只在 -Ensure 且真的拉起过的时候调；没配就静默跳过，发不出去只打印一句。
function Send-Notify([string]$text) {
    if (-not $NotifyPrivate -and -not $NotifyGroup) { return }
    if (-not $NotifyUrl) { return }

    $base = $NotifyUrl.TrimEnd('/')
    $targets = @()
    if ($NotifyPrivate -and $NotifyPrivate -match '^\d+$') {
        $targets += @{ Path = '/send_private_msg'; Key = 'user_id'; Id = [long]$NotifyPrivate }
    }
    if ($NotifyGroup -and $NotifyGroup -match '^\d+$') {
        $targets += @{ Path = '/send_group_msg'; Key = 'group_id'; Id = [long]$NotifyGroup }
    }

    foreach ($t in $targets) {
        try {
            $payload = @{ message = @(@{ type = 'text'; data = @{ text = $text } }) }
            $payload[$t.Key] = $t.Id
            $json = $payload | ConvertTo-Json -Depth 6 -Compress
            $headers = @{}
            if ($NotifyToken) { $headers['Authorization'] = 'Bearer ' + $NotifyToken }
            Invoke-RestMethod -Uri ($base + $t.Path) -Method Post -Headers $headers `
                -ContentType 'application/json; charset=utf-8' `
                -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) `
                -TimeoutSec 10 -ErrorAction Stop | Out-Null
            Say ('通知已发 ' + $t.Path)
        } catch {
            # 通知失败不影响服务：这里只留一句话，不抛。
            Say ('通知没发出去（不影响服务）：' + $_.Exception.Message)
        }
    }
}

# 用存下的令牌地址探一下：200/302/303 算有效，401 就是令牌过期了。
function Test-Url($url) {
    if (-not $url) { return $false }
    try {
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.AllowAutoRedirect = $false
        $req.Timeout = 4000
        $res = $req.GetResponse()
        $code = [int]$res.StatusCode
        $res.Close()
        return ($code -eq 200 -or $code -eq 302 -or $code -eq 303)
    } catch [System.Net.WebException] {
        $r = $_.Exception.Response
        if ($r) {
            $code = [int]$r.StatusCode
            return ($code -eq 200 -or $code -eq 302 -or $code -eq 303)
        }
        return $false
    } catch { return $false }
}

# 从日志里抠出带令牌的地址。日志尾部会夹一堆 \0 填充，先清掉。
function Read-UrlFromLog {
    param([string]$path)
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    # 重定向出去的 stdout 被 dsh 进程独占着，必须 FileShare.ReadWrite 才读得到。
    $t = $null
    try {
        $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
        $sr = New-Object System.IO.StreamReader($fs)
        $t = $sr.ReadToEnd()
        $sr.Close(); $fs.Close()
    } catch { return $null }
    if (-not $t) { return $null }
    $t = $t -replace "`0", ""
    $m = [regex]::Matches($t, 'dsh web:\s*(http\S+?token=[A-Za-z0-9_\-]+)')
    if ($m.Count -gt 0) { return $m[$m.Count - 1].Groups[1].Value }
    return $null
}

function Get-DshWebProcess {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine -match $script:DshBinPattern -and
            $_.CommandLine -match '(\s|")web(\s|"|$)'
        }
}

function Stop-OldWeb {
    $procs = @(Get-DshWebProcess)
    foreach ($p in $procs) {
        Say ("停掉旧的 web 宿主 pid " + $p.ProcessId)
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($procs.Count -gt 0) { Start-Sleep -Seconds 2 }
}

# 重启时 worker 会留一个新鲜的 flag，看门任务看到就让路，
# 免得守护周期跟手动重启撞一起、起出两个实例。
$restartFlag = Join-Path $StateDir 'restarting.flag'
if ($Ensure -and (Test-Path -LiteralPath $restartFlag)) {
    $flagAge = (Get-Date) - (Get-Item -LiteralPath $restartFlag).LastWriteTime
    if ($flagAge.TotalMinutes -lt 3) {
        Say '正在重启，让路'
        exit 0
    }
}

# -Ensure：只看门。服务活着就静静退出，绝不重启；没起才拉起。
if ($Ensure -and (Test-Port $Port)) { exit 0 }

# ---- 1. 服务活着、手里的地址还有效 → 直接开
$saved = if (Test-Path -LiteralPath $stateFile) { (Get-Content -LiteralPath $stateFile -Raw).Trim() } else { $null }
if (-not $Restart -and (Test-Port $Port) -and (Test-Url $saved)) {
    Say '服务在跑，令牌有效，直接开'
    if (-not $NoOpen) { Start-Process $saved }
    exit 0
}

# ---- 2. 否则（没起 / 令牌过期 / 被要求重启）自己起一个，抓那一行
Say '正在起 Harness ...'
Stop-OldWeb

# key 只进这个进程的环境变量：不打印、不落盘、不写进日志。
function Import-KeyFromEnvFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "找不到 -EnvFile 指定的文件: $Path"
    }
    $line = Get-Content -LiteralPath $Path -ErrorAction Stop |
        Where-Object { $_ -match '^\s*DEEPSEEK_API_KEY\s*=' } |
        Select-Object -First 1
    if (-not $line) {
        throw "-EnvFile 里没有 DEEPSEEK_API_KEY: $Path"
    }
    $k = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
    if (-not $k) { throw "-EnvFile 里的 DEEPSEEK_API_KEY 是空的: $Path" }
    $env:DEEPSEEK_API_KEY = $k
}

if ($EnvFile) { Import-KeyFromEnvFile -Path $EnvFile }
if (-not $env:DEEPSEEK_API_KEY) {
    Say '没有 DEEPSEEK_API_KEY：用 -EnvFile 指一个含该键的文件，或先把它放进环境变量'
    exit 1
}

if ($PermissionMode) { $env:DSH_PERMISSION_MODE = $PermissionMode }

# 计划任务里的 PATH 往往比交互式会话短，把 Node 的常规安装位置补上（存在才补）。
$extra = @(
    (Join-Path $env:ProgramFiles 'nodejs'),
    (Join-Path $env:APPDATA 'npm')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
if ($extra.Count -gt 0) {
    $env:Path = ($extra -join ';') + ';' + $env:Path
}

$exe = $null
foreach ($name in @('dsh.cmd', 'dsh.exe', 'dsh')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c) { $exe = $c.Source; break }
}
if (-not $exe) {
    Say '找不到 dsh 命令：确认 npm 全局 bin 目录在 PATH 里（通常是 %APPDATA%\npm）'
    exit 1
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# 上一次的日志先留一份再清：服务要是自己掉了，才有上一趟的痕迹可查。
foreach ($old in @($log, $err)) {
    if (Test-Path -LiteralPath $old) {
        Copy-Item -LiteralPath $old -Destination ($old + '.prev') -Force -ErrorAction SilentlyContinue
    }
}
Remove-Item -LiteralPath $log, $err -Force -ErrorAction SilentlyContinue
# 旧地址先作废，免得下次误用。
Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue

$p = Start-Process -FilePath $exe -ArgumentList @('web', '--no-open') `
    -RedirectStandardOutput $log -RedirectStandardError $err `
    -PassThru -WindowStyle Hidden
Say "进程起来了（pid $($p.Id)），等它打印带令牌的地址 ..."

$url = $null
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 1000
    $url = Read-UrlFromLog $log
    if ($url) { break }
    if ($p.HasExited) { break }
}

if (-not $url) {
    Say '没抓到地址，服务可能起失败了。看这两个日志：'
    Say "  $log"
    Say "  $err"
    if (Test-Path -LiteralPath $err) {
        Get-Content -LiteralPath $err -Tail 15 | ForEach-Object { Write-Host "    $_" }
    }
    # 只有看门模式才报：手动起失败，人就在电脑前，不用再发一条。
    if ($Ensure) {
        try { Send-Notify '看门想把服务拉起来，但没起来，需要看日志' }
        catch { Say ('通知没发出去（不影响服务）：' + $_.Exception.Message) }
    }
    exit 1
}

# 等服务真的能接受连接，再开浏览器。
for ($i = 0; $i -lt 30; $i++) {
    if (Test-Url $url) { break }
    Start-Sleep -Milliseconds 1000
}

Set-Content -Path $stateFile -Value $url -NoNewline -Encoding ASCII
Say '开着呢'
if (-not $NoOpen) { Start-Process $url }

# 看门模式能走到这里是「服务本来没在跑、这次真拉起来了」，配了就报一声。
# 普通启动 / restart-worker 调的那次不发 —— 那条路有自己的健康检查通知，别重复。
if ($Ensure) {
    try { Send-Notify ('看门发现服务没在跑，已经拉起来（' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '）') }
    catch { Say ('通知没发出去（不影响服务）：' + $_.Exception.Message) }
}
exit 0
