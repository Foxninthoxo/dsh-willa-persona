---
name: dsh-guard
description: 用 Windows 计划任务看住 dsh web：起服务并抓带令牌的地址、-Ensure 看门、两段式安全重启（重启必须走计划任务，不能在会话里直接 stop 宿主）。服务连不上、令牌过期、要重启 dsh web、或要装/卸载看门任务时用。
---

# dsh-guard —— 看住 dsh web

一套脚本，全部 Windows PowerShell 5.1；五个主脚本参数一致，可以互相转发，另有一个 `autoconfig.ps1` 自动生成配置。本目录是 `dsh-willa` 包内 `persona/guard/` 的留档工具，属于可选工具，不是插件运行时的一部分。

## 先判断该用哪个

| 情况 | 用什么 |
|---|---|
| 服务没起 / 令牌过期，想打开界面 | `open-harness.ps1` |
| 换了 key、服务卡住，要换一个新实例 | `restart.ps1` |
| 服务崩了要能自愈 | `install-guard.ps1`（一次性装好就行） |
| 不想让它自愈了 | `uninstall-guard.ps1` |

**不要** 从会话里直接跑 `restart-worker.ps1`。它是给计划任务调的；从会话里跑会跟服务一起被 job 杀掉，见下面「为什么」。

## 常用命令

```powershell
# 起服务 + 开浏览器
powershell -ExecutionPolicy Bypass -File .\open-harness.ps1 -EnvFile C:\path\to\.env

# 只起服务，不开页面
powershell -ExecutionPolicy Bypass -File .\open-harness.ps1 -NoOpen -EnvFile C:\path\to\.env

# 强制重启（注册一次性任务，交给计划任务去停和起）
powershell -ExecutionPolicy Bypass -File .\restart.ps1 -EnvFile C:\path\to\.env

# 只看会做什么，不真干
powershell -ExecutionPolicy Bypass -File .\restart.ps1 -EnvFile C:\path\to\.env -DryRun

# 装 / 更新看门任务（间隔默认 5 分钟）
powershell -ExecutionPolicy Bypass -File .\install-guard.ps1 -EnvFile C:\path\to\.env

# 删任务
powershell -ExecutionPolicy Bypass -File .\uninstall-guard.ps1

# 用指定的配置文件（不写 -Config 就读脚本同目录的 dsh-guard.config.json）
powershell -ExecutionPolicy Bypass -File .\restart.ps1 -Config C:\cfg\prod.json -DryRun
```

不带 `-EnvFile` 时，要求 `$env:DEEPSEEK_API_KEY` 已经存在，否则脚本直接报错退出（不会起一个必然 `MISSING_CREDENTIAL` 的服务）。

## 配置

不想每次在命令行上带一长串参数，就把 `config.example.json` 复制成脚本同目录的 `dsh-guard.config.json`。五个脚本都认它。

**优先级：命令行 > 配置文件 > 内置默认。** 命令行显式传了的参数压过配置；配置文件不存在、缺键、空字符串都等于「没配」，退回默认值，不报错。

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

| 键 | 参数 | 用途 |
|---|---|---|
| `port` | `-Port` | 服务端口 |
| `stateDir` | `-StateDir` | 状态目录（`url.txt` / flag） |
| `logDir` | `-LogDir` | 日志目录 |
| `envFile` | `-EnvFile` | key 文件；空 = 不动 |
| `taskPrefix` | `-TaskPrefix` | 任务名前缀 |
| `permissionMode` | `-PermissionMode` | 子进程权限模式；空 = 不动 |
| `guardEveryMinutes` | `-IntervalMinutes` | 看门间隔（分钟） |
| `restartWaitSeconds` | `-RestartWaitSeconds` | worker 等端口空出来的上限（秒） |
| `notifyPrivate` | `-NotifyPrivate` | 报平安私聊 QQ 号；空 = 不发 |
| `notifyGroup` | `-NotifyGroup` | 报平安群号；空 = 不发 |
| `notifyUrl` | `-NotifyUrl` | OneBot HTTP 地址 |
| `notifyToken` | `-NotifyToken` | OneBot accessToken |

路径字段里的 `%LOCALAPPDATA%` / `%TEMP%` 这类 `%VAR%` 会展开；展开后建议是绝对路径。

### 自动生成配置

通知四项不用手抄，跑 `autoconfig.ps1`：

```powershell
powershell -ExecutionPolicy Bypass -File .\autoconfig.ps1 -DryRun   # 先看，不写
powershell -ExecutionPolicy Bypass -File .\autoconfig.ps1           # 写同目录 dsh-guard.config.json
powershell -ExecutionPolicy Bypass -File .\autoconfig.ps1 -Force    # 覆盖已有的
```

它读 `%USERPROFILE%\Downloads\SnowLuma*\config\onebot_*.json` 的 `networks.httpServers[0]` 拿 `notifyUrl` / `notifyToken`（可用 `-OneBotConfig` 直接指文件或目录），读 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 的 `wake.watch` 拿 `notifyPrivate`（第一条 `private:`）/ `notifyGroup`（只有一个 `group:` 时）。yml 没写 watch 就退回本机 QQ 配置里的私聊列表（路径按脚本位置推，可用 `-HostConfig` 指）；都读不到就留空并打印原因。输出里 token 只显示前 4 位 + 长度，绝不打印完整值。

**转发规矩**：配置文件不是默认路径时，`restart.ps1` / `install-guard.ps1` 会把 `-Config <绝对路径>` 拼进计划任务命令行，否则 worker / 看门那层读的是默认路径、跟你以为的不是同一份。这会吃 `schtasks /tr` 的 261 字符额度 —— 所以优先把配置放回默认位置；实在要用外部的，就把 `guard` 目录挪到短路径（`-TaskPrefix` 只缩短任务名，不缩短 `/tr`）。超限时脚本直接报错不注册。

## 重启后自动报平安

重启（和看门拉起服务）之后发一条 QQ 消息，省得人在外面不知道成没成。配置驱动，四个键：

```json
{
  "notifyPrivate": "10001",
  "notifyGroup": "",
  "notifyUrl": "http://<OneBot host>:<port>",
  "notifyToken": "<OneBot 的 accessToken>"
}
```

- `notifyPrivate` / `notifyGroup`：收件人，填哪个发哪个，都填两边都发；**两个都空 = 功能关掉**，一个请求都不发。
- `notifyUrl`：OneBot HTTP 地址，默认空（不发）；填 `http://<host>:<port>` 或让 `autoconfig.ps1` 拼。
- `notifyToken`：OneBot 配置里的 `accessToken`。SnowLuma 在 `config\onebot_<QQ>.json` 的 `networks.httpServers[0].accessToken`；NapCat 在它自己的 OneBot 配置里。没设 token 就留空，请求不带 `Authorization`。

走 OneBot 11：`POST <notifyUrl>/send_private_msg`（或 `/send_group_msg`），body 是 `{"user_id":…,"message":[{"type":"text","data":{"text":"…"}}]}`，头 `Authorization: Bearer <token>`。

消息：成功 `重启完成，服务已恢复（<时间>）`；失败 `重启后服务没起来，需要看日志`；看门拉起是 `看门发现服务没在跑，已经拉起来（<时间>）`。

**发不出去不影响重启**：没配就跳过；每个请求各自 `try/catch`、超时 10 秒，失败只在 `dsh-restart-worker.log` 里留一行 `notify: 发失败（忽略）…`。重启成没成看 `=== worker: 好了 / 失败了`，不看通知。

**261 注意**：这四个参数只在配了收件人时才拼进任务命令行，拼之前先算长度，超 261 就不带并提示（`-DryRun` 能看到），worker / open-harness 会退回读同目录配置文件。所以配置放脚本同目录最稳。长度允许时 token 会进任务定义（`schtasks /query /v` 可见，本机当前用户可读），别把任务导出或截图外传。

## 为什么重启必须两段式

DSH 会话里起的子进程挂在同一个 Windows job 里，job 是「关闭即全杀」。web 宿主在这个 job 里，重启脚本也在。

所以「先 stop 再 start」的写法会：停掉宿主 → job 关闭 → 脚本自己被杀 → start 永远执行不到 → 服务空着没人管。

拆开之后：

1. `restart.ps1` 只 `schtasks /create` + `/run`，不碰服务，所以不会被带走；
2. `restart-worker.ps1` 由计划任务启动，进程树在服务宿主下，不在会话 job 里，停得掉宿主、自己也活得下来。

**规矩：任何要停 dsh web 宿主的操作，都必须从计划任务里发起。**

## 关键文件与状态

| 路径 | 是什么 |
|---|---|
| `<StateDir>\url.txt` | 带令牌的地址。**是凭据**，别贴出去 |
| `<StateDir>\restarting.flag` | 重启避让标记，3 分钟内 `-Ensure` 让路 |
| `<LogDir>\dsh-web.log` / `.err.log` | 服务输出，上一次留 `.prev` |
| `<LogDir>\dsh-restart.log` | 第一段记录 |
| `<LogDir>\dsh-restart-worker.log` | 第二段记录，带时间戳 |

默认 `StateDir=%LOCALAPPDATA%\dsh-web`，`LogDir=%TEMP%`。

## 排错顺序

1. **服务没起来**：看 `dsh-web.err.log` 尾部。`MISSING_CREDENTIAL` = key 没给到；连接被拒 = 端口没监听。
2. **重启没生效**：`schtasks /query /tn "DshGuard-Restart" /v /fo LIST` 看上次结果，再翻 `dsh-restart-worker.log`。正常序列是 `stop old web pid ...` → `端口 ... 已空 = True` → `端口活着 = True` → `好了`。
3. **日志停在 `stop old web pid` 后面就没了**：跑脚本的进程也在会话 job 里，被一起杀了。确认是从计划任务发起的，不是会话里直接调的 worker。
4. **看门不干活**：任务默认只在当前用户登录时跑；`restarting.flag` 三分钟内会让路；`schtasks ... /v` 里「上次运行结果」应为 `0x0`。
5. **配置没生效**：先看 `-DryRun` 打印的「配置文件：…」；命令行显式传的参数一定压过配置；配置不是默认路径时，任务命令行里必须有 `-Config`（`-DryRun` 会打出来）。
6. **解析报 `Unexpected token` / `字符串缺少终止符`**：文件被存成无 BOM 了。5.1 会按 ANSI 读中文。重新存成 UTF-8 带 BOM，再用 `[System.Management.Automation.Language.Parser]::ParseFile()` 校验。

## 改脚本时的硬约束

- **必须 UTF-8 带 BOM**。无 BOM 时 5.1 按系统 ANSI 解析，中文注释能把语法搞崩。
- 五个脚本的参数表和默认值保持一致（`-Port` / `-StateDir` / `-LogDir` / `-EnvFile` / `-TaskPrefix` / `-PermissionMode` / `-Config`，另加 `-IntervalMinutes`、`-RestartWaitSeconds`、`-NotifyPrivate` / `-NotifyGroup` / `-NotifyUrl` / `-NotifyToken`）。注册任务时只把「和默认值不一样」的参数拼进命令行（`restart.ps1` / `install-guard.ps1` 里的 `Same()` 负责判断），这样才不会撞上 `schtasks /tr` 的 261 字符上限。**改默认值要五个脚本一起改**，否则计划任务里的 worker 会算出不同的 `StateDir`，flag 就避让不上。
- 配置合并走 `$PSBoundParameters.ContainsKey(...)`：它只认真从命令行传进来的参数，所以「命令行 > 配置文件 > 默认」是这么落地的。**别改用「值是否等于默认值」来判断**，用户显式传 `-Port 3080` 时那种写法会把配置里的端口又抢回去。合并必须在算 `$log` / `$stateFile` 之前做。
- 配置里路径字段要 `ExpandEnvironmentVariables` 展开 `%VAR%`；配置不是默认路径时，注册任务的脚本必须把 `-Config` 转发给 worker / 看门那层。
- `-Ensure` 分支里**不许**出现任何停止/重启动作。看门只能「没起就拉起」。
- 日志里不要打印完整令牌地址，只打长度；`url.txt` 本身是凭据文件，别当普通文本外传。通知的 `notifyToken` 同理：日志里只记发没发、发到哪，不记 token。
- 通知必须在健康检查**之后**发，而且整段包在 `try/catch` 里 —— 通知失败绝不影响重启结果。收件人两个都空时直接返回，不要发空请求。
- 进程匹配只认 `...\dsh\lib\bin.js` + `web` 子命令，别放宽成「所有 node.exe」，会误杀别的东西。
- 改完至少跑一遍 5.1 解析校验，再跑 `restart.ps1 -DryRun` 确认命令行拼得对。
