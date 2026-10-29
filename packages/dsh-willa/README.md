# dsh-willa

人设库 + 可选 QQ / 记忆 / 状态工具的 DeepSeek Harness 合并插件。

> 状态（2026-10-28 深夜）：**人设半侧已完成**，**26 个工具已迁入**，
> 后台那半（alive 定时器 / wake / wander / qzone 轮询）**正在迁**。
> `enablePersona` 默认 `true`，`enableWilla` 默认 `false` —— 对外发布时就是这个默认：
> 装了只得到一个人设库，不会碰用户的 QQ、记忆和后台任务。

## 装法

```powershell
dsh plugin --profile <profile> add "<本目录绝对路径>"
```

profile 的 `cordis.patch.yml` 里会多出一行：

```yaml
- id: willa
  name: dsh-willa
```

自己的覆盖配置写同一个 id（只写要改的键，别整份抄）：

```yaml
- id: willa
  config:
    enableWilla: true
    willaWorkspace: 'C:\...\workspace'
    willaDataDir: 'C:\...\workspace\private'
    qqHttpUrl: 'http://127.0.0.1:3000'
    qqWsUrl: 'ws://127.0.0.1:3001'
    qqSelfId: '<你的QQ号>'
```

## 依赖（自己不打包，自己装）

**本包运行时不是纯离线**：开了 `enableWilla` 且配了对应后端，它会连本机 OneBot、请求 embeddings 服务、spawn `dsh` 子进程。默认 `enableWilla: false`，只做人设库时不发生这些。逐项：

| 用途 | 需要什么 | 去哪拿 |
|---|---|---|
| QQ 收发（`qq_*` 工具） | 一个 OneBot v11 实现（SnowLuma / NapCat 之类）在本机监听 HTTP；本包只 `POST <qqHttpUrl>/<action>` | 各自官方 Releases 自行下载安装；SnowLuma 是第三方专有运行时，**不随本项目分发** |
| QQ 收消息唤醒（`wake`） | 同一个 OneBot 的正向 WebSocket 地址（`qqWsUrl`）；收到图片会按消息里的 URL 下载到 `blobs/qq-inbox` | 同上 |
| QQ 空间轮询（`qzone`） | 同上；还要它的 `onebot_*.json`，或直接给 `qzoneHttpUrl` + `qzoneToken` | 同上 |
| 记忆的语义检索 | 任一本机 OpenAI 兼容的 `/embeddings` 服务 | `memoryEmbedUrl` 默认指向 `http://127.0.0.1:8767/v1/embeddings`；没这个服务就把它设为空串，`mem_recall` / `mem_note` 不注册，`mem_stats` 仍能看本地账 |
| 派活（`worker_*`） | `dsh` CLI + `node` | `worker_run` 会 spawn `dsh --profile headless <task>`；找不到 `dsh` 或 `node` 就不注册 `worker_*` |

**本包不含任何 OneBot 实现的代码或二进制**，只跟它暴露的 HTTP / WebSocket 说话。装好 OneBot 端之后，把地址和 token 填进配置（`qqHttpUrl` / `qqWsUrl` / `qqToken` / `qqSelfId`），**本包不需要知道它装在哪**。没配就只是少几个工具，其余照常。

**B 站不在本包**：本包没有任何 B 站接口调用；记忆里可能出现 `bilibili-video` 频道，那是作者另外装的插件写进去的数据，本包只读。桌面宠物、B 站视频这类能力都走宿主/别的插件，与本包无关。

## 开关（40 个配置键，常用这几个）

| 键 | 默认 | 说明 |
|---|---|---|
| `enablePersona` | `true` | 挂人设段落 + 设置页的 `/api/dsh-willa/*` 路由 |
| `enableWilla` | `false` | 挂 26 个工具（QQ / 记忆 / 心账 / 人设卡 / 生活 / 能动性 / 派活 / 新会话） |
| `aliveEnabled` | `true` | alive 到点自醒的定时器 |
| `wakeEnabled` | `false` | WS 收 QQ 消息注入会话（**必须同时配 `wakeSessionId`，没配就不启动，不乱猜**） |
| `wanderEnabled` | `false` | 隔一段随机自醒 |
| `qzoneEnabled` | `false` | QQ 空间评论轮询 |

**缺后端就少注册工具**（不是报错）：QQ 没配 → 不出现 `qq_send/qq_read/qq_status/qq_wake_test`；
`memoryEmbedUrl` 设成空串 → 不出现 `mem_recall/mem_note`（`mem_stats` 保留并显示「记忆未配置」）；
`dsh`/`node` 拿不到 → 不出现 `worker_run/worker_status/worker_list`。纯本地的账（心账/人设卡/生活/能动性）始终在。

旧配置兼容：顶层 `enabled:false` 同时关掉两半；`wake.enabled` 等旧嵌套开关映射到 `wakeEnabled` 等拍平键。

人设库默认在 `<DSH_HOME>/storages/dsh-willa/personas.json`，可用 `personaStore` 覆盖。
旧的 `dsh-persona-dafeiyu` 库不会自动搬（旧文件保留，想沿用就把 `personaStore` 指过去）。

## 目录

```text
src/
  index.js        唯一入口；静态 inject ['tools','systemPrompt']，apply 里同步挂
  config.js       配置默认值 + 浅合并 + standard-schema
  paths.js        所有路径从 DSH_HOME / 配置派生，不从源码位置反推
  persona/        人设宿主半侧 + 浏览器半侧（client.js 已带 loader 壳）
  willa/          工具与后台：tools/qq/memory/affinity/person/life/alive/worker/session/util
                  + alive-timer / wake / wander / qzone
lib/              构建产物（目前 = 复制 src；将来换 esbuild 时看 scripts/build.mjs 注释）
locale/           zh.json / en.json（插件页标题与描述）
icon.svg          插件页图标
docs/LOCAL-SETUP.md   Fox 本机从「两个包」切到「一个包」的步骤与回滚
docs/VERIFY.md        验过什么、没验到什么（只记真跑过的）
scripts/
  preflight.mjs   一条命令自检：构建 → 冒烟 → 隐私 → 客户端包壳 → 打包清单（npm run preflight）
  build.mjs       构建 + 客户端 bundle id 自检
  smoke.mjs       冒烟：配置键数、工具数、降级后的工具数、定时器清理
  client-shape.mjs    客户端 bundle 壳 / loader id / locale / icon / exports 校验
  privacy-check.mjs   扫本机私货（路径 / QQ 号 / token）
  migrate-persona-store.mjs  人设库一次性迁移（默认 dry-run）
```

## 已知缺口

- `src/persona/catalog.js`、`store.js` 还没从 `persona/index.js` 拆出来（原包就是单文件 bundle）。
- 人设库迁移要手动跑一次：`node scripts/migrate-persona-store.mjs --apply`（见 `docs/LOCAL-SETUP.md`）。

## 许可

MIT。人设半侧来自 dsh-persona-dafeiyu 0.5.0（MIT），原版权声明见 `NOTICE` 与 `LICENSE`。
