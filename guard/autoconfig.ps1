# autoconfig.ps1 —— 从本机现有配置自动生成 dsh-guard.config.json
#
# 读两处（都容错，读不到就留空并打印原因）：
#   1. OneBot 配置：SnowLuma 的 config\onebot_*.json 里 networks.httpServers[0]，
#      取 accessToken 和 host / port / path，拼出 notifyUrl。
#   2. DSH profile 的 cordis.patch.yml 里 wake.watch，取 private:<数字> / group:<数字>。
#      yml 里没写 watch 时，退回 willa-dsh 自己的默认（本机 QQ 配置的私聊列表）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\autoconfig.ps1 -DryRun   # 只打印
#   powershell -ExecutionPolicy Bypass -File .\autoconfig.ps1           # 写入同目录
#   powershell -ExecutionPolicy Bypass -File .\autoconfig.ps1 -Force    # 覆盖已有的
#   powershell ... -OneBotConfig C:\path\onebot.json -HostConfig C:\path\config.json
#     # 前两个参数可跳过默认扫描，直接指 OneBot / 宿主配置
#
# 输出里的 token 永远只显示前 4 位 + 长度，不打印完整值。

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$DryRun,

    # 可选：OneBot 配置（onebot_*.json 文件，或放它的目录）。不传就先扫
    # %USERPROFILE%\Downloads\SnowLuma*\config，再看脚本旁的 config\。
    [string]$OneBotConfig = '',

    # 可选：willa-dsh 宿主的 config.json（读 worlds.qq.privates 当最后回退）。
    # 不传就从仓库根往上找最多三层 config.json。
    [string]$HostConfig = ''
)

$ErrorActionPreference = 'Continue'

$scriptDir = $PSScriptRoot
$targetPath = Join-Path $scriptDir 'dsh-guard.config.json'
$examplePath = Join-Path $scriptDir 'config.example.json'

function Show([string]$m) { Write-Host "[autoconfig] $m" }

# token 打码：前 4 位 + 长度。空值就写 <空>。
function Mask-Token([string]$t) {
    if (-not $t) { return '<空>' }
    $n = [Math]::Min(4, $t.Length)
    return $t.Substring(0, $n) + '****（长度 ' + $t.Length + '，已打码）'
}

function Try-ReadJson([string]$path) {
    if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop
        if (-not $raw -or -not $raw.Trim()) { return $null }
        return ($raw | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        return $null
    }
}

# 在 yaml 里找 wake.watch 块，按出现顺序返回 private:<数字> / group:<数字>。
# 只做够用的行扫描，不引入 YAML 解析器。
function Get-WakeWatch([string]$ymlPath) {
    $result = New-Object System.Collections.ArrayList
    if (-not $ymlPath -or -not (Test-Path -LiteralPath $ymlPath -PathType Leaf)) { return @() }
    try {
        $lines = Get-Content -LiteralPath $ymlPath -Encoding UTF8 -ErrorAction Stop
    } catch {
        return @()
    }

    $inWake = $false
    $inWatch = $false
    $wakeIndent = -1
    $watchIndent = -1

    foreach ($line in $lines) {
        if ($null -eq $line) { continue }
        $trimmed = $line.TrimEnd()
        if ($trimmed.Trim() -eq '') { continue }
        $indent = $trimmed.Length - $trimmed.TrimStart().Length
        $content = $trimmed.TrimStart()
        if ($content.StartsWith('#')) { continue }

        if (-not $inWake) {
            if ($content -match '^wake\s*:\s*(#.*)?$') {
                $inWake = $true
                $wakeIndent = $indent
                $inWatch = $false
            }
            continue
        }

        # 出了 wake 块；同一行若又是新的 wake: 就接上
        if ($indent -le $wakeIndent) {
            $inWake = $false
            $inWatch = $false
            if ($content -match '^wake\s*:') {
                $inWake = $true
                $wakeIndent = $indent
            }
            continue
        }

        if (-not $inWatch) {
            if ($content -match '^watch\s*:\s*(?<rest>.*)$') {
                $inWatch = $true
                $watchIndent = $indent
                $rest = $Matches['rest']
                if ($rest -and $rest -notmatch '^\s*#') {
                    foreach ($m in [regex]::Matches($rest, '(?:private|group)\s*:\s*\d+')) {
                        [void]$result.Add($m.Value)
                    }
                }
            }
            continue
        }

        # 出了 watch 块（下一个同级键）
        if ($indent -le $watchIndent) {
            $inWatch = $false
            continue
        }

        if ($content -match '^-\s*(?<item>.+)$') {
            $item = $Matches['item'].Trim()
            $m = [regex]::Match($item, '(?:private|group)\s*:\s*\d+')
            if ($m.Success) { [void]$result.Add($m.Value) }
        } else {
            foreach ($m in [regex]::Matches($content, '(?:private|group)\s*:\s*\d+')) {
                [void]$result.Add($m.Value)
            }
        }
    }

    return @($result)
}

# ---------------------------------------------------------------- 用户目录
$userHome = $env:USERPROFILE
if (-not $userHome) { $userHome = $HOME }
if (-not $userHome) {
    Show '读不到用户目录（$env:USERPROFILE / $HOME 都空），没法继续'
    exit 1
}

# ---------------------------------------------------------------- 1. OneBot
# 优先级：-OneBotConfig（文件或目录）> Downloads\SnowLuma*\config > 脚本旁 config\。
$onebotCandidates = New-Object System.Collections.ArrayList
if ($OneBotConfig) {
    $ob = $OneBotConfig
    if (-not [System.IO.Path]::IsPathRooted($ob)) { $ob = Join-Path (Get-Location).Path $ob }
    if (Test-Path -LiteralPath $ob -PathType Leaf) {
        [void]$onebotCandidates.Add((Resolve-Path -LiteralPath $ob).Path)
    } elseif (Test-Path -LiteralPath $ob -PathType Container) {
        $files = Get-ChildItem -LiteralPath $ob -File -Filter 'onebot_*.json' -ErrorAction SilentlyContinue |
            Sort-Object Name
        foreach ($f in $files) { [void]$onebotCandidates.Add($f.FullName) }
    } else {
        Show ('-OneBotConfig 指的文件/目录不存在，继续按默认位置找：' + $ob)
    }
}
$downloads = Join-Path $userHome 'Downloads'
if (Test-Path -LiteralPath $downloads -PathType Container) {
    $snowDirs = Get-ChildItem -LiteralPath $downloads -Directory -Filter 'SnowLuma*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending
    foreach ($d in $snowDirs) {
        $cfgDir = Join-Path $d.FullName 'config'
        if (-not (Test-Path -LiteralPath $cfgDir -PathType Container)) { continue }
        $files = Get-ChildItem -LiteralPath $cfgDir -File -Filter 'onebot_*.json' -ErrorAction SilentlyContinue |
            Sort-Object Name
        foreach ($f in $files) { [void]$onebotCandidates.Add($f.FullName) }
    }
}
$localCfgDir = Join-Path $scriptDir 'config'
if (Test-Path -LiteralPath $localCfgDir -PathType Container) {
    $files = Get-ChildItem -LiteralPath $localCfgDir -File -Filter 'onebot_*.json' -ErrorAction SilentlyContinue |
        Sort-Object Name
    foreach ($f in $files) { [void]$onebotCandidates.Add($f.FullName) }
}

$onebotPath = ''
$onebotServer = $null
foreach ($candidate in $onebotCandidates) {
    $j = Try-ReadJson $candidate
    if ($null -eq $j) { continue }
    if (-not $j.networks -or -not $j.networks.httpServers) { continue }
    $servers = @($j.networks.httpServers)
    if ($servers.Count -lt 1 -or $null -eq $servers[0]) { continue }
    $onebotPath = $candidate
    $onebotServer = $servers[0]
    break
}

$notifyUrl = ''
$notifyToken = ''
$onebotNote = ''
if ($onebotServer) {
    $h = [string]$onebotServer.host
    if (-not $h) { $h = '127.0.0.1'; $onebotNote += 'host 没写，按 127.0.0.1；' }
    $p = [string]$onebotServer.port
    if (-not $p) { $onebotNote += 'port 没写，拼不出 notifyUrl（用 -NotifyUrl 或配置文件手动给）；' }
    $path = [string]$onebotServer.path
    if (-not $path) { $path = '/' }
    $path = $path.TrimEnd('/')
    if ($path -and -not $path.StartsWith('/')) { $path = '/' + $path }
    if ($h -and $p) { $notifyUrl = 'http://' + $h + ':' + $p + $path }
    $notifyToken = [string]$onebotServer.accessToken
    if (-not $notifyToken) { $onebotNote += 'accessToken 是空的（OneBot 那边没设 token）；' }
} else {
    $onebotNote = '没找到能解析出 networks.httpServers 的 onebot_*.json'
}

# ---------------------------------------------------------------- 2. wake.watch
$profileDir = Join-Path (Join-Path $userHome '.dsh\profiles') 'web'
$ymlPath = Join-Path $profileDir 'cordis.patch.yml'
$watchEntries = @()
$watchSource = ''
$watchKind = ''
$watchNote = ''

if (Test-Path -LiteralPath $ymlPath -PathType Leaf) {
    $watchEntries = @(Get-WakeWatch $ymlPath)
    if ($watchEntries.Count -gt 0) {
        $watchSource = $ymlPath
        $watchKind = 'yml'
    }
} else {
    $watchNote = '找不到 ' + $ymlPath
}

# 退一步：profile 的 package.json 里 willa-dsh 指向的插件目录，读它自己的 patch。
if ($watchEntries.Count -eq 0) {
    $pkgPath = Join-Path $profileDir 'package.json'
    $pkg = Try-ReadJson $pkgPath
    if ($pkg -and $pkg.dependencies -and $pkg.dependencies.'willa-dsh') {
        $dep = [string]$pkg.dependencies.'willa-dsh'
        $dep = $dep -replace '^link:', ''
        if ($dep -match '^[A-Za-z]:') {
            $pluginYml = Join-Path $dep 'cordis.patch.yml'
            $entries = @(Get-WakeWatch $pluginYml)
            if ($entries.Count -gt 0) {
                $watchEntries = $entries
                $watchSource = $pluginYml
                $watchKind = 'plugin'
            }
        }
    }
}

# 再退一步：willa-dsh 的默认监听列表就写在本机 QQ 配置里（worlds.qq.privates），
# 拿第一条启用的私聊。-HostConfig 优先；没给就从仓库根往上找最多三层 config.json
# （不写死安装目录）：<repo>\config.json → <父>\config.json → <祖父>\config.json。
if ($watchEntries.Count -eq 0) {
    $hostCandidates = New-Object System.Collections.ArrayList
    if ($HostConfig) {
        $hcPath = $HostConfig
        if (-not [System.IO.Path]::IsPathRooted($hcPath)) { $hcPath = Join-Path (Get-Location).Path $hcPath }
        [void]$hostCandidates.Add($hcPath)
    } else {
        $probe = Split-Path $scriptDir -Parent
        for ($i = 0; $i -lt 3 -and $probe; $i++) {
            [void]$hostCandidates.Add((Join-Path $probe 'config.json'))
            $probe = Split-Path $probe -Parent
        }
    }
    foreach ($hostCfg in $hostCandidates) {
        $hc = Try-ReadJson $hostCfg
        if ($hc -and $hc.worlds -and $hc.worlds.qq -and $hc.worlds.qq.privates) {
            $privates = @($hc.worlds.qq.privates)
            $first = $privates | Where-Object { $null -ne $_ -and $_.enabled -ne $false } | Select-Object -First 1
            if ($first -and $first.id) {
                $watchEntries = @('private:' + [string]$first.id)
                $watchSource = $hostCfg
                $watchKind = 'qqconfig'
                break
            }
        }
    }
}

$notifyPrivate = ''
$notifyGroup = ''
$privateIds = @()
$groupIds = @()
foreach ($entry in $watchEntries) {
    if ($entry -match '^private:(\d+)$') {
        $privateIds += $Matches[1]
    } elseif ($entry -match '^group:(\d+)$') {
        $groupIds += $Matches[1]
    }
}
if ($privateIds.Count -gt 0) { $notifyPrivate = $privateIds[0] }
$uniqueGroups = @($groupIds | Select-Object -Unique)
if ($uniqueGroups.Count -eq 1) {
    $notifyGroup = $uniqueGroups[0]
} elseif ($uniqueGroups.Count -gt 1) {
    $watchNote += 'wake.watch 里有 ' + $uniqueGroups.Count + ' 个 group:，按规定 notifyGroup 留空；'
}

if (-not $notifyPrivate -and -not $watchNote) {
    $watchNote = $ymlPath + ' 里没有 wake.watch 的 private: 条目，也没找到可退回的配置'
}
if (-not $notifyPrivate) { $watchNote = $watchNote.TrimEnd('；') }

# ---------------------------------------------------------------- 3. 合成配置
$config = $null
if (Test-Path -LiteralPath $examplePath -PathType Leaf) {
    $config = Try-ReadJson $examplePath
}
if ($null -eq $config) {
    $config = [pscustomobject]@{
        port               = 3080
        stateDir           = '%LOCALAPPDATA%\dsh-web'
        logDir             = '%TEMP%'
        envFile            = ''
        taskPrefix         = 'DshGuard'
        permissionMode     = ''
        guardEveryMinutes  = 5
        restartWaitSeconds = 20
        notifyPrivate      = ''
        notifyGroup        = ''
        notifyUrl          = ''
        notifyToken        = ''
    }
}

# 只改通知四项，其它字段原样保留样板里的默认值。
function Set-ConfigValue($obj, [string]$name, $value) {
    $prop = $obj.PSObject.Properties | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
    if ($prop) {
        $prop.Value = $value
    } else {
        $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value
    }
}
Set-ConfigValue $config 'notifyPrivate' $notifyPrivate
Set-ConfigValue $config 'notifyGroup'   $notifyGroup
Set-ConfigValue $config 'notifyUrl'     $notifyUrl
Set-ConfigValue $config 'notifyToken'   $notifyToken

# ---------------------------------------------------------------- 4. 打印 / 写入
$exists = Test-Path -LiteralPath $targetPath -PathType Leaf

Show ('目标文件：' + $targetPath)
if ($onebotPath) {
    Show ('OneBot 配置：' + $onebotPath)
} else {
    Show ('OneBot 配置：没找到（' + $onebotNote + '）')
}
Show ('  notifyUrl   = ' + $(if ($notifyUrl) { $notifyUrl } else { '<空>' }))
Show ('  notifyToken = ' + (Mask-Token $notifyToken))
if ($onebotNote -and $onebotPath) { Show ('  说明：' + $onebotNote) }

if ($watchKind -eq 'yml') {
    Show ('wake.watch 来源：' + $watchSource)
} elseif ($watchKind -eq 'plugin') {
    Show ('wake.watch 来源：' + $watchSource + '（profile yml 里没配 watch）')
} elseif ($watchKind -eq 'qqconfig') {
    Show 'wake.watch：profile yml 里没配 watch，退回本机 QQ 配置的私聊列表'
    Show ('  来源：' + $watchSource)
} else {
    Show 'wake.watch 来源：没找到（notifyPrivate 留空）'
}
Show ('  notifyPrivate = ' + $(if ($notifyPrivate) { $notifyPrivate } else { '<空>' }))
Show ('  notifyGroup   = ' + $(if ($notifyGroup) { $notifyGroup } else { '<空>' }))
if ($watchNote) { Show ('  说明：' + $watchNote) }

if ($DryRun) {
    if ($exists -and -not $Force) {
        Show '目标文件已存在；真跑时加 -Force 才会覆盖，不加就保持原样'
    }
    Show 'DryRun：只打印，不写文件'
    exit 0
}

if ($exists -and -not $Force) {
    Show '已有配置，加 -Force 才覆盖'
    exit 0
}

$json = $config | ConvertTo-Json -Depth 5
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($targetPath, $json + [Environment]::NewLine, $utf8NoBom)
} catch {
    Show ('写文件失败：' + $_.Exception.Message)
    exit 1
}

Show ('写好了：' + $targetPath)
Show '提醒：这是本机个人配置（含 accessToken），别提交、别外传'
exit 0
