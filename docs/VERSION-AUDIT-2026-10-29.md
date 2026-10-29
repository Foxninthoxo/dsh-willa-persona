# 版本审计 2026-10-29：仓库 `dsh-willa` vs 本机部署 `willa-dsh`

## 审计对象

- **仓库版**：单包 `dsh-willa` 0.1.0，仓库根即包根。人设半侧 + willa 半侧（26 个工具、四个后台）合并在一起，源码在 `src/`，构建产物在 `lib/`。
- **部署版**：本机正在跑的 `willa-dsh`（只有 willa 半侧；人设由另一个独立包提供）。工具与后台都在 `lib/` 下，配置项和本机端口、路径、账号写在部署目录的 patch 与代码里。

审计方法：逐文件对读；另用假 ctx 把两个包各挂一遍，抓 26 个工具的名称、description、parameters 做结构化对比。工具名与参数结构可以直接机比，行为差异靠逐函数对读。

## 对比表

| 文件 / 项目 | 部署版 | 仓库版 | 判定 |
|---|---|---|---|
| `lib/index.js` / `src/index.js` | 约 1260 行单文件，26 个工具和四个后台全在里面；本机工作区、QQ 号、门房会话、NapCat 配置读取全部写死 | 约 125 行入口，按 `enablePersona` / `enableWilla` 条件挂载；工具拆到 `src/willa/*`，路径统一走 `src/paths.js` | 增 1（条件挂载 + `scope.effect` 生命周期）；私 1 |
| `session.js` / `qq.js`（部署逻辑在 `index.js`） | 门房守卫、会话挑选、注入都在入口或 `wake` 里；QQ token 拼在 URL query 上 | 门房守卫与会话挑选独立成模块；token 走 `Authorization` 头；QQ 配置不全就不注册 `qq_*` | 缺 0；增 3（`session` 1 + `qq` 2）；私 0（已计入入口） |
| `config.js` / `paths.js` | 无独立配置层，路径从源码位置反推；OneBot 等默认值散在代码里 | 40 键 `DEFAULTS` + 旧键迁移 + standard-schema 校验；所有路径从 `DSH_HOME` / 配置派生 | 缺 0；增 2；私 0 |
| `worker.js` | 回执 `done.json`、5 分钟过期、2 秒合并（最多 5 条）、kill 记 `null` 都已具备；dsh / node / env / patch / 工作目录全写死 | 同样的回执、过期、合并与去重；新增 `findOnPath`、`.cmd` → `.js` shim 解析、`workerDshBin` / `workerNodeBin` / `workerProfile` / `workerEnvFile` / `workerPatchFile` 配置，环境变量优先 | 缺 0；增 2；私 1 |
| `wake.js` | 收消息后拼上「我此刻」状态和「这人」摘要；指定门房叫不醒时回退到自动挑会话；没配门房也能自动挑 | 只注入消息正文，**没有**生活状态与人设卡前缀；指定门房注入失败只记日志，消息丢弃；启动必须显式 `wakeSessionId`，不猜会话 | **缺 3**；增 3（启动门禁、收图落绝对路径、WS 清理）；私 1 |
| `wander.js` | 爱好、待办从固定私有文件读；待办过滤用 `done` 字段（与 `alive` 实际存的 `doneAt` 对不上，会推已完成的事） | 同样的权重与静默时段；待办按 `doneAt` 过滤（修掉部署版这个 bug）；爱好文件先数据目录、再旧工作区回退；间隔与 prompt 全配置 | 缺 0；增 2；私 1 |
| `memory.js` | 旧向量库、v2 向量、embed 地址与模型名全写死；`channel` / `person` 过滤、向量解码、`supersede`、`stats` 完整 | 同样的检索与过滤；`memoryOldVectors` / `memoryV2Vectors` / `memoryEmbedUrl` / `memoryEmbedModel` 配置；给了旧部署目录时仍可兜底读旧向量；没配 embed 就不注册 `mem_recall` / `mem_note` | 缺 0；增 1；私 1 |
| `person.js` | 人设卡读写完整，`summaryLine` 给唤醒消息拼摘要 | 卡片字段、摘要实现一致；多一个「记忆没配时只给卡、不翻记忆」的降级 | 缺 0；增 1；私 1 |
| `life.js` | 心情漂移、精力回血、`lineFor(qq)` 给唤醒消息拼状态 | 漂移与回血逻辑逐行等价；`lineFor` 也有实现，但 `wake` 没调用（算在 `wake` 缺 1 里） | 缺 0；增 0；私 1 |
| `affinity.js` | 分数衰减、±10 上限、迁移去重完整；负面情绪会顺手压一下全局心情 | 账本逻辑等价；但 `affinity.register(scope)` 没把 `life` 传进去，`life.set(...)` 永远拿不到实例，**「扣分压心情」联动失效** | **缺 1**；增 1（迁移源配置化）；私 1 |
| `alive.js` | 到点计算、只叫一次、done / drop 完整；定时器在入口里常开 | 逻辑等价；新增 `aliveEnabled` 开关，定时器拆到 `alive-timer.js` 并用 `scope.effect` 清理 | 缺 0；增 1；私 1 |
| `qzone.js` | 轮询、评论数变化才查详情、`seen` 去重、首次只建档、200 条上限完整；SnowLuma 配置路径和自己的 QQ 号写死 | 逻辑等价；端点三选一（`qzoneHttpUrl` + `qzoneToken` / `qzoneOnebotConfig` / 未配置不启动），自己的 QQ 号走 `qqSelfId`，轮询用 `scope.effect` 清理 | 缺 0；增 1；私 1 |
| 实际配置（patch / 配置段） | 顶层 `enabled` / `wake` / `wander` / `qzoneWatch` 四段嵌套；OneBot 地址、token、监听列表默认从本机另一个应用的 `config.json` 读；`alive` 没有开关 | 40 个拍平键（`src/config.js` 的 `DEFAULTS`），旧嵌套键向后映射；路径、账号、后端地址全部显式配置；alive 有开关 | 配置模型不同；仓库更通用 |
| `package.json` | 名称 `willa-dsh`，`private`，只含 willa 半侧；`engines` 是 dsh `>=0.2.0-rc.1` / node `>=22`；`files` 只有 `lib` + patch | 名称 `dsh-willa` 0.1.0，合并人设半侧；`engines` 是 dsh `>=0.2.0-rc.2` / node `>=22.15`；`files` 包含 `src/`、`docs/`、`scripts/` 和 `persona` 的两个工具目录 | 仓库多了人设半侧与文档/脚本 |
| 工具数量与定义 | 26 个，始终全部注册；后端没配时报错在调用时暴露 | 26 个，按后端裁剪：全量 26 / 无 QQ 22 / 无 embed 24 / 无 worker 23 / 纯本地 17 | 名称 26/26 一致；4 处 description/参数只是脱敏措辞不同，无功能差异 |
| 人设半侧 | 不在 `willa-dsh` 里，靠另一个独立人设包 | 已合并进 `src/persona/` + `lib/persona/` | 仓库新增 |

合计：**4 条「部署有、仓库没有」+ 18 条「仓库新增/改进」+ 10 类「本机私有硬编码」= 32 条差异**。

## 结论

**仓库里这份不是本机部署的完整拷贝**：它是同一套 26 个工具 + 四个后台的通用化重构版，核心算法基本等价，并额外合并了人设半侧；本机的 QQ 号、绝对路径、token、门房会话等私有值一条都没带进仓库，但有 **4 处部署有、仓库没有的功能**——`wake` 丢了生活状态/人设卡前缀、指定门房失败后不回退、必须显式配置门房（这条是刻意的安全取舍），以及 `affinity` 的「扣分压心情」联动没接线（这条是 bug）。

## 后续该做什么

1. **先修 3 处回归**：`wake` 注入前拼回 `life.lineFor()` + `person.summaryLine()`；`wake` 指定门房失败时回退到自动挑会话；`affinity.register` 调用处把 `life` 实例传进去。`wander` 的 `doneAt` 修复已经在仓库里，不用再动。
2. **门房策略二选一**：要么保留「必须显式 `wakeSessionId`」并在 README 写清（安全，但换会话后重启要手工改配置）；要么加一个显式开关允许自动挑会话（可用，但可能把消息送进 headless 干活会话）。
3. **切本机 profile 前核对路径口径**：收图目录从「工作区 `blobs/qq-inbox`」变成「数据目录 `blobs/qq-inbox`」；旧向量库要配 `willaCompanionHome` 或 `memoryOldVectors` 才读得到；worker 日志、门房文件、`qzone-watch.json` 都跟着 `willaDataDir` 走。`docs/LOCAL-SETUP.md` 里的配置样例要逐项对上，别只写 QQ 三项。
4. **切之前跑全绿**：`npm run preflight`、`npm test`、`cd persona && npm test`；切完停掉旧的两个包，别让两套人设和两套 wake 同时开。
5. **把这次的对读固化成脚本**：用假 ctx 分别挂载部署包与仓库包，对比工具名、description、parameters 和关键导出，做成 `scripts/tool-parity.mjs`，以后每次改部署或改仓库都先跑一遍，避免再靠人眼对 1260 行。
6. **保持隐私扫描 0 命中**：本审计只写文件级/行为级差异，不写本机 QQ 号、绝对路径、token；后续新增文档同样遵守。

## 附：这次机比得到的硬数据

- 部署版工具 26 个，仓库版 26 个，交集 26 个，无「仅部署」或「仅仓库」工具。
- 工具定义只有 4 处差异：`affinity_migrate`、`mem_note`、`mem_recall`（含 `channel` 参数示例）、`qq_send`，全部是把本机 QQ 号/固定条数换成通用措辞。
- 仓库配置键 40 个；`npm test` 的挂载结果是「26 全量 / 22 无 QQ / 24 无 embed / 23 无 worker / 17 纯本地」，四个后台可全开、可全关、dispose 后不残留。
