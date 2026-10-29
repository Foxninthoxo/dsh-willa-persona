# uninstall-guard.ps1 —— 删掉看门计划任务（顺手清掉可能残留的一次性重启任务）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File uninstall-guard.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall-guard.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File uninstall-guard.ps1 -Config .\my.json
#
# 注意：只删计划任务，不停服务、不删 StateDir / 日志。
# 任务名前缀取自 taskPrefix：命令行 > 配置文件 > 默认 DshGuard。

[CmdletBinding()]
param(
    [string]$TaskPrefix = 'DshGuard',

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

$configPath = Resolve-ConfigPath $Config
if (-not $configPath) { $configPath = $script:ConfigDefaultPath }
if ($Config -and -not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Write-Warning ("-Config 指定的文件不存在，按默认值走：" + $configPath)
}
$configUsed = if (Test-Path -LiteralPath $configPath -PathType Leaf) { $configPath } else { '' }
$cfg = Read-GuardConfig $configUsed

# $PSBoundParameters 只记真正从命令行传进来的参数：传了就以命令行为准。
if (-not $PSBoundParameters.ContainsKey('TaskPrefix')) {
    $v = Config-Value $cfg 'taskPrefix'
    if ($v) { $TaskPrefix = [string]$v }
}

$guard = "$TaskPrefix-Guard"
$restart = "$TaskPrefix-Restart"

function Show([string]$m) { Write-Host "[uninstall-guard] $m" }

function Test-Task([string]$name) {
    & schtasks.exe /query /tn $name > $null 2>&1
    return ($LASTEXITCODE -eq 0)
}

$removed = 0
if ($DryRun) {
    Show ("配置文件：" + $(if ($configUsed) { $configUsed } else { '没有，用默认任务名' }))
}

foreach ($name in @($guard, $restart)) {
    if (-not (Test-Task $name)) {
        Show ("没有这个任务，跳过：" + $name)
        continue
    }
    if ($DryRun) {
        Show ("DryRun：会删除任务 " + $name)
        Show ('  等价命令： schtasks /delete /tn "' + $name + '" /f')
        continue
    }
    & schtasks.exe /delete /tn $name /f *>&1 | ForEach-Object { Write-Host ('  ' + $_) }
    if ($LASTEXITCODE -eq 0) {
        Show ("已删除 " + $name)
        $removed++
    } else {
        Show ("删除失败 " + $name + "（权限不够时用管理员窗口重试）")
    }
}

if ($DryRun) {
    Show 'DryRun 结束，什么都没删'
    exit 0
}

if ($removed -eq 0) { Show '没有需要删的任务' } else { Show ("删了 " + $removed + " 个") }
exit 0
