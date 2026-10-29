# dsh-guard

用 Windows 计划任务把 `dsh web` 看住的一套小脚本：**起服务、抓带令牌的地址、崩了自动拉回来、要重启时安全地换一个新实例**。

这是 `dsh-willa-persona` 包里的 `guard\` 目录，属于**可选**的 Windows 小工具，不是插件运行时的一部分。下面所有命令都在本目录（`guard\`）里执行；从包根（`packages/dsh-willa-persona`）跑就把 `.\` 换成 `guard\`。

只面向 Windows + Windows PowerShell 5.1。没有外部依赖，也不连外网；只有配了 OneBot 通知时，会请求本机 `127.0.0.1` 的 OneBot HTTP。

## 它解决什么问题

`dsh web` 每次启动都会**现生成**一个访问令牌，令牌只出现在启动那行日志里：

```
dsh web: http://127.0.0.1:3080/?token=<每进程现生成>
```

没有固定文件、没有固定口令，所以浏览器里存的书签过一会儿就 401。这套脚本干的事就是：

1. 自己起一次服务，从日志里把那一行抓下来；
2. 地址存进 `StateDir\url.txt`，下次先拿它试探（200/302 算有效，401 算过期）；
3. 有效就直接开浏览器，过期或服务没起就重新起、重新抓；
4. 再挂一个看门任务（默认每 5 分钟，可配置），服务没了就拉起来。

## 文件

| 文件 | 干什么 |
|---|---|
| `open-harness.ps1` | 起服务、抓令牌地址、开页面。`-Ensure` 是看门模式（活着就退出）。 |
| `restart.ps1` | 重启的**第一段**：只注册并触发一次性计划任务，自己不停任何进程。 |
| `restart-worker.ps1` | 重启的**第二段**：由计划任务跑，停旧服务、等端口空、起新的、健康检查、按需报平安。 |
| `install-guard.ps1` | 注册/更新看门任务 `DshGuard-Guard`（间隔默认 5 分钟，可配置）。 |
| `autoconfig.ps1` | 从本机 OneBot 和 DSH profile 配置里读通知四项，自动生成 `dsh-guard.config.json`。 |
| `uninstall-guard.ps1` | 删掉看门任务（顺手清掉残留的一次性重启任务）。 |
| `config.example.json` | 配置文件的样板，复制成 `dsh-guard.config.json` 就能用。 |

## 为什么重启必须两段式

这是这套脚本里唯一一个「不这么写就一定出事」的地方。

DSH 会话里启动的子进程会被放进一个 Windows **job 对象**，job 设置了「job 一关，里面所有进程一起结束」。`dsh web` 的宿主在这个 job 里，你跑的重启脚本也在。

于是「在一个脚本里先 stop 再 start」会变成：

1. 脚本 `Stop-Process` 掉 web 宿主；
2. 宿主退出，job 里最后一个外部进程没了，job 关闭；
3. 脚本自己被 job 一起杀掉；
4. 「start」那一步永远没执行 —— 服务空着，没有任何人负责把它拉回来。

日志上的表现很典型：停在 `stop old web pid 1234`，后面那行 `launching ...` 永远不出现。

所以拆成两段：

- **第一段**（`restart.ps1`）只做一件没有副作用的事：`schtasks /create` + `/run`，然后立刻退出。它不碰服务，所以不会被 job 带走。
- **第二段**（`restart-worker.ps1`）由计划任务启动。计划任务的进程树挂在服务宿主（`svchost`）下面，**不在会话的 job 里**。它停得掉 web 宿主，停完自己还活着，可以继续把服务起回来。

一句话：**停服务的人必须活在会杀掉服务的那层之外。**

## 装

### 1. 准备 key

`dsh web` 需要 `DEEPSEEK_API_KEY`。两种给法，二选一：

- 环境变量里已经有了（用户级或系统级都行）；
- 用 `-EnvFile` 指一个文件，里面有一行 `DEEPSEEK_API_KEY=sk-...`。脚本只把它读进当前进程的环境变量，不打印、不落盘。

```powershell
# 先手动跑一次，确认能起来
powershell -ExecutionPolicy Bypass -File .\open-harness.ps1 -EnvFile C:\path\to\.env
```

起来之后地址在 `%LOCALAPPDATA%\dsh-web\url.txt`。

### 2. 注册看门任务

```powershell
powershell -ExecutionPolicy Bypass -File .\install-guard.ps1 -EnvFile C:\path\to\.env
```

先看它打算干什么，不真注册：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-guard.ps1 -EnvFile C:\path\to\.env -DryRun
```

查状态 / 立刻试跑：

```powershell
schtasks /query /tn "DshGuard-Guard" /v /fo LIST
schtasks /run   /tn "DshGuard-Guard"
```

### 3. 重启服务

```powershell
powershell -ExecutionPolicy Bypass -File .\restart.ps1 -EnvFile C:\path\to\.env
```

先看会注册什么任务、会跑什么命令（不注册、不碰服务）：

```powershell
powershell -ExecutionPolicy Bypass -File .\restart.ps1 -DryRun
```

### 4. 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-guard.ps1
```

只删计划任务，不停服务、不删状态和日志。

## 自动配置

通知那四个键不用手抄，一条命令从本机现有配置里读出来，写进脚本同目录的 `dsh-guard.config.json`：

```powershell
powershell -ExecutionPolicy Bypass -File .\autoconfig.ps1
```

先看它会写什么（不落盘）：

```powershell
powershell -ExecutionPolicy Bypass -File .\autoconfig.ps1 -DryRun
```

它读两处：

1. **OneBot 配置**：`%USERPROFILE%\Downloads\SnowLuma*\config\onebot_*.json` 里的 `networks.httpServers[0]`，取 `accessToken` 和 `host` / `port` / `path`。没有 SnowLuma 目录时，再扫脚本旁边的 `config\onebot_*.json`。`notifyToken` 就是这个 `accessToken`，`notifyUrl` 拼成 `http://<host>:<port><path>`（OneBot 一般在本机 `3000`）。不想按这个顺序找，就用 `-OneBotConfig` 直接指一个 `onebot_*.json` 文件或放它的目录（优先于默认扫描）。
2. **DSH profile 的 `cordis.patch.yml`**：`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 里 `wake.watch` 的 `private:<数字>`，有多条就取最先出现的那条当 `notifyPrivate`；`group:<数字>` 只有一个时才填 `notifyGroup`。这份 yml 里没写 `watch` 时，退回 willa-dsh 自己的默认（本机 QQ 配置里的私聊列表）；路径从仓库根往上找最多三层 `config.json`，也可以用 `-HostConfig` 直接指。

约定：

- 默认只写 `notifyPrivate` / `notifyGroup` / `notifyUrl` / `notifyToken` 四项，其余字段照 `config.example.json` 的默认（`port` 3080 等）。
- 文件已存在且没加 `-Force` 就不覆盖，打印「已有配置，加 -Force 才覆盖」。
- 输出里的 token 只显示**前 4 位 + 长度**，绝不打印完整 token；完整值只写进文件。
- 生成的是本机个人配置（含 accessToken），别提交、别外传。

## 参数

除 `autoconfig.ps1`（`-Force` / `-DryRun`，外加两个定位用的 `-OneBotConfig` / `-HostConfig`）外，五个脚本共用同一组参数，名字和默认值一致，方便互相调用时原样转发。

| 参数 | 默认值 | 配置键 | 说明 |
|---|---|---|---|
| `-Port` | `3080` | `port` | 服务监听端口 |
| `-StateDir` | `%LOCALAPPDATA%\dsh-web` | `stateDir` | 放 `url.txt` 和 `restarting.flag` |
| `-LogDir` | `%TEMP%` | `logDir` | 放 `dsh-web.log` / `dsh-web.err.log` / `dsh-restart*.log` |
| `-EnvFile` | 空 | `envFile` | 可选。给了就从里面读 `DEEPSEEK_API_KEY`；不给就用现成环境变量 |
| `-TaskPrefix` | `DshGuard` | `taskPrefix` | 任务名前缀，看门任务 `DshGuard-Guard`，一次性重启任务 `DshGuard-Restart` |
| `-PermissionMode` | 空 | `permissionMode` | 可选。给子进程设 `DSH_PERMISSION_MODE`，空表示不动 |
| `-IntervalMinutes`（仅 install-guard） | `5` | `guardEveryMinutes` | 看门间隔，分钟 |
| `-RestartWaitSeconds`（restart / worker） | `20` | `restartWaitSeconds` | 停旧服务后等端口空出来的上限，秒 |
| `-NotifyPrivate` | 空 | `notifyPrivate` | 重启/看门拉起后私聊报平安的 QQ 号；空 = 不发 |
| `-NotifyGroup` | 空 | `notifyGroup` | 同上，发到群 |
| `-NotifyUrl` | 空 | `notifyUrl` | OneBot HTTP 服务地址；空 = 不发，由 `autoconfig.ps1` 或配置给 |
| `-NotifyToken` | 空 | `notifyToken` | OneBot 的 accessToken，发 `Authorization: Bearer` |
| `-Config` | 脚本同目录的 `dsh-guard.config.json` | —— | 配置文件路径。文件不存在就用默认值，不报错 |

另外：

- `open-harness.ps1`：`-Restart` 强制重启、`-Ensure` 看门模式、`-NoOpen` 只起服务不开浏览器。
- `restart.ps1` / `install-guard.ps1` / `uninstall-guard.ps1`：`-DryRun` 只打印不执行。

## 重启后自动报平安

重启是「脱身」去做的，做完人往往不在电脑前。配好这四项，重启完会往 QQ 发一条：

| 场景 | 消息 |
|---|---|
| 重启成功 | `重启完成，服务已恢复（2026-10-28 12:34:56）` |
| 重启失败 | `重启后服务没起来，需要看日志` |
| 看门任务把服务拉起来 | `看门发现服务没在跑，已经拉起来（2026-10-28 12:34:56）` |

四个键（也都能用同名参数给，参数优先）：

```json
{
  "notifyPrivate": "10001",
  "notifyGroup": "",
  "notifyUrl": "http://<OneBot host>:<port>",
  "notifyToken": "<OneBot 的 accessToken>"
}
```

- `notifyPrivate` / `notifyGroup`：收件人。只填一个就只发一边，都填就两边都发；**两个都空 = 整个功能关掉**，一个请求都不发。
- `notifyUrl`：OneBot HTTP 服务地址，默认空（不发）；填 `http://<host>:<port>`，或让 `autoconfig.ps1` 从 OneBot 配置里拼。
- `notifyToken`：OneBot 的 `accessToken`，会以 `Authorization: Bearer <token>` 发出去。

### token 从哪来

就是 OneBot 实现（NapCat / SnowLuma 之类）配置里那个 `accessToken`。以 SnowLuma 为例，在它的 `config\onebot_<QQ号>.json` 里：

```json
{
  "networks": {
    "httpServers": [
      { "host": "127.0.0.1", "port": 3000, "accessToken": "……" }
    ]
  }
}
```

取 `networks.httpServers[0].accessToken`；`port` 和 `host` 拼起来就是 `notifyUrl`。OneBot 那边没设 token 的话 `notifyToken` 留空，脚本就不带 `Authorization` 头。

### 发不出去不影响重启

通知是**锦上添花**，不是重启流程的一部分：

- 没配收件人就静默跳过，不报错、不发请求；
- 每个请求各自 `try/catch`，超时 10 秒；连不上、超时、401 都只往 `dsh-restart-worker.log` 写一行 `notify: 发失败（忽略）…`；
- 服务起没起来，跟通知发没发出去完全分开判断。日志里 `=== worker: 好了` / `=== worker: 失败了` 才是结论。

### 261 字符的注意

`restart.ps1` / `install-guard.ps1` 只在通知配了的时候才把这几个参数拼进任务命令行，拼之前先算长度。**超了 261 就不带**（`-DryRun` 会提示），这时 worker / open-harness 会退回读脚本同目录的 `dsh-guard.config.json`，功能不丢。

这也意味着：**把配置放回脚本同目录最省事**。顺带一提，长度允许时 `-NotifyToken` 会跟着进计划任务的命令行，所以 token 会写在任务定义里（`schtasks /query /v` 能看到，只有本机当前用户读得到）。任务定义别导出、别截图外传；真要连这个都不想留，就干脆别配通知。

## 配置

参数可以从配置文件来，省得每次在命令行上重复一长串。优先级：

```
命令行参数  >  配置文件  >  内置默认值
```

只要命令行里**显式传了**某个参数，就以命令行为准（哪怕值跟默认值一样）；没传才看配置文件；配置文件里没这个键、或者文件压根不存在，就用内置默认。

### 默认找哪个文件

不传 `-Config` 时，五个脚本都读**自己所在目录**的 `dsh-guard.config.json`：

```powershell
# 同目录放一份配置，之后就什么都不用带了
Copy-Item .\config.example.json .\dsh-guard.config.json
powershell -ExecutionPolicy Bypass -File .\restart.ps1            # 配置自动生效
powershell -ExecutionPolicy Bypass -File .\restart.ps1 -Port 3099 # 这一次用 3099，别的还按配置
```

这个文件不存在是**正常情况**，不报错，直接退回默认值。想用别的文件就 `-Config` 指过去：

```powershell
powershell -ExecutionPolicy Bypass -File .\restart.ps1 -Config C:\cfg\prod.json -DryRun
```

### 字段

`config.example.json` 就是全部字段，键名不分大小写：

```json
{
  "port": 3080,
  "stateDir": "%LOCALAPPDATA%\\dsh-web",
  "logDir": "%TEMP%",
  "envFile": "",
  "taskPrefix": "DshGuard",
  "permissionMode": "",
  "guardEveryMinutes": 5,
  "restartWaitSeconds": 20,
  "notifyPrivate": "",
  "notifyGroup": "",
  "notifyUrl": "http://<OneBot host>:<port>",
  "notifyToken": ""
}
```

| 键 | 对应参数 | 说明 |
|---|---|---|
| `port` | `-Port` | 服务端口 |
| `stateDir` | `-StateDir` | 状态目录 |
| `logDir` | `-LogDir` | 日志目录 |
| `envFile` | `-EnvFile` | 放 `DEEPSEEK_API_KEY` 的文件；空字符串 = 不覆盖命令行/默认 |
| `taskPrefix` | `-TaskPrefix` | 任务名前缀 |
| `permissionMode` | `-PermissionMode` | 子进程权限模式；空 = 不动 |
| `guardEveryMinutes` | `-IntervalMinutes` | 看门任务间隔（分钟），`install-guard.ps1` 用它填 `schtasks /mo` |
| `restartWaitSeconds` | `-RestartWaitSeconds` | `restart-worker.ps1` 等端口空出来的上限（秒） |
| `notifyPrivate` | `-NotifyPrivate` | 报平安的私聊 QQ 号；空 = 不发 |
| `notifyGroup` | `-NotifyGroup` | 报平安的群号；空 = 不发 |
| `notifyUrl` | `-NotifyUrl` | OneBot HTTP 地址；空 = 不发，由 `autoconfig.ps1` 或配置给 |
| `notifyToken` | `-NotifyToken` | OneBot accessToken；空 = 不带 Authorization 头 |

**空字符串 / 缺键 / 空文件都等于「没配」**，不会把参数清空。JSON 写坏了只在 stderr 报一条警告，然后按默认值继续跑，不会拦着你干活。

### `%VAR%` 会展开

路径字段（`stateDir` / `logDir` / `envFile`）里的 `%LOCALAPPDATA%`、`%TEMP%`、`%USERPROFILE%` 这类文本会用 `[Environment]::ExpandEnvironmentVariables` 展开，写 `\\` 是因为 JSON 里反斜杠要转义。认不出的变量名原样留着。展开之后建议是绝对路径 —— 相对路径是按**运行时当前目录**算的，计划任务里的当前目录不可靠。

### 配置文件不是默认路径时

计划任务跑的是另一个进程（`restart-worker.ps1` / `open-harness.ps1 -Ensure`），它自己只会找默认位置。所以 `restart.ps1` 和 `install-guard.ps1` 在「实际用的配置**不是**同目录默认路径」时，会把 `-Config <绝对路径>` 一起拼进任务命令行。

这条会占 `schtasks /tr` 的 261 字符余量，所以要留意长度（`-DryRun` 会打印实际长度）。量级大致是：全默认约 190 字符，配置在默认位置约 220 字符；一旦用 `-Config` 指到外部路径，就会再加上一段路径长度，很容易超 261。**以 `-DryRun` 打印的数为准。**

超了怎么办：

1. **首选**：把配置放回脚本同目录（`dsh-guard.config.json`）。默认路径不带 `-Config`，最省字符。
2. 把整个 `guard` 目录挪到短路径（比如 `C:\guard`），`-File` 那段短了，什么都塞得下。
3. `-TaskPrefix` 只缩短**任务名**（`/tn`），**不缩短** `/tr` 这条命令行，帮不上这个忙。

真的超了 261，`restart.ps1` / `install-guard.ps1` 会直接报错退出，不去注册一个会被截断的任务。

## 排错

**日志在哪**

- `%TEMP%\dsh-web.log` / `dsh-web.err.log` —— 服务自己的输出。上一次的会留成 `.prev`。
- `%TEMP%\dsh-restart.log` —— 第一段（注册任务）的记录。
- `%TEMP%\dsh-restart-worker.log` —— 第二段（真停真起）的记录，带时间戳。

> 注意：`dsh-web.log` 里有带 `?token=` 的完整地址。**这是凭据**，贴日志、提 issue、发截图之前先把 token 和端口以外的东西抹掉。

**服务起不来**

1. 看 `dsh-web.err.log` 尾部。`MISSING_CREDENTIAL` = key 没给到；端口占用 = 端口被别的程序占着。
2. 手动跑 `open-harness.ps1`，不要带 `-NoOpen`，看它打印的 `[harness]` 到哪一步。
3. `dsh` 命令找不到：确认 npm 全局 bin 目录（通常是 `%APPDATA%\npm`）在 PATH 里。

**重启没生效**

1. `schtasks /query /tn "DshGuard-Restart" /v /fo LIST`，看「上次运行结果」。
2. 看 `dsh-restart-worker.log`：正常应该是 `stop old web pid ...` → `端口 ... 已空 = True` → `端口活着 = True` → `好了`。
3. 如果日志停在 `stop old web pid` 之后什么都没有，说明跑这个脚本的进程**也在**会话的 job 里 —— 它就是被一起杀掉了，检查是不是从会话里直接调了 `restart-worker.ps1`。

**看门任务不干活**

1. 默认只在当前用户登录时运行。锁屏没关系，注销就不跑。
2. `restarting.flag` 三分钟内有效，正在重启时看门会让路，这是故意的。
3. `schtasks /query ... /v` 里「上次运行结果」是 `0x0` 才算正常退出。

**配置没生效**

1. 先跑 `-DryRun`，它会打印「配置文件：…」这一行，告诉你到底读了哪个文件（或「没有，全用内置默认」）。
2. 「命令行 > 配置」：命令行上显式传了的参数一定压过配置，`-Port 3080` 也会压过配置里的 `3099`。
3. 「配置 > 计划任务」：如果配置不是脚本同目录的默认文件，任务命令行里必须带 `-Config`。`restart.ps1` / `install-guard.ps1` 的 `-DryRun` 会把完整命令行打出来，看一眼有没有。
4. JSON 写坏了不会静默糊过去：stderr 会有一条 `配置文件读不了` 的警告，然后按默认值跑。

**重启完了没收到报平安**

1. 先确认 `notifyPrivate` / `notifyGroup` 至少填了一个 —— 两个都空是故意不发。
2. `dsh-restart-worker.log` 里搜 `notify:`。`已发 /send_private_msg` = 请求出去了，问题在 OneBot / QQ 那头；`发失败（忽略）` 后面跟的原因才是线索（连不上 = 端口不对或 OneBot 没起，401 = token 不对）。
3. `notifyUrl` 的端口要和 OneBot 配置里 `httpServers[0].port` 对上，`notifyToken` 要和它的 `accessToken` 一模一样。
4. `restart.ps1 -DryRun` 看一眼任务命令行里有没有 `-NotifyPrivate` 这些；没有、且有「超过 261」的提示，就是靠同目录配置文件在生效。

**中文乱码 / 解析报 `Unexpected token` / `字符串缺少终止符`**

脚本必须存成 **UTF-8 带 BOM**。Windows PowerShell 5.1 对无 BOM 文件按系统 ANSI 代码页解析，中文注释会把语法搞坏。改完用 5.1 静态校验一遍：

```powershell
powershell.exe -NoProfile -Command "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('C:\path\open-harness.ps1',[ref]$null,[ref]$e); if($e){$e}else{'OK'}"
```

## 已知边界

- 只支持 Windows + Windows PowerShell 5.1。PowerShell 7 没测。
- 进程识别靠命令行特征（`...\dsh\lib\bin.js web`），跟 npm 包的目录布局绑着。换安装方式（比如打包成 exe）就要改 `open-harness.ps1` 里的 `$script:DshBinPattern`。
- 任务以当前用户身份、在登录会话里跑。要做成开机就起，得自己加 `/ru SYSTEM`，但那样抓不到用户会话里的浏览器，意义不大。
- `schtasks /tr` 有长度限制（261 字符）。脚本只把「和默认值不一样」的参数写进任务命令行，所以正常安装（用默认路径）时命令长约 200 字符。如果你改了 `-StateDir` / `-LogDir` 且路径很长，可能超限；用 `-Config` 指外部配置文件还会再多出一段路径（见「配置 → 配置文件不是默认路径时」）。超限时脚本直接报错不注册，这时换短路径、或把配置放回默认位置。
- 配置文件只做了这几个键，不支持注释（JSON 本身也不允许）。要写注释就写在 `config.example.json` 旁边或这份 README 里。
