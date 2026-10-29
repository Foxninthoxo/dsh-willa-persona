# dsh-willa

DeepSeek Harness（DSH）的**一个**插件包：人设、记忆、心账、alive 定时与随机唤醒，外加可选的 QQ（OneBot）、QQ 空间、worker 派活、Windows 看门脚本和两支筛 skill 的小工具。仓库只作源码与本地安装用，**暂不发布到 npm**。

仓库根就是包根，`package.json` 里只有 `dsh-willa` 这一个包。默认只开人设半侧（`enablePersona: true`，`enableWilla: false`）：装完只得到一个人设库，不碰你的 QQ、记忆和后台任务。

## 装

```bash
npm i dsh-willa
dsh plugin --profile <profile> add dsh-willa
```

本地开发直接指仓库根：

```bash
dsh plugin --profile <profile> add "<仓库绝对路径>"
```

profile 的 `cordis.patch.yml` 里会多一行：

```yaml
- id: willa
  name: dsh-willa
```

覆盖配置写同一个 id，只写要改的键：

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

## 这一个包装了什么

| 能力 | 在哪 | 说明 |
|---|---|---|
| 人设 | `src/persona/`、`lib/persona/` | Willa（大肥鱼）人设注入、称呼、设置页三条 `/api/dsh-willa/*` 路由。默认开。 |
| 记忆 | `src/willa/memory.js` | `mem_note` / `mem_recall` / `mem_stats` / `mem_supersede`。要配 `memoryEmbedUrl` 才注册 `mem_recall` / `mem_note`；没配就只保留 `mem_stats` / `mem_supersede`。 |
| 心账 | `src/willa/affinity.js` | `affinity_get` / `affinity_adjust` / `affinity_slot` / `affinity_list` / `affinity_migrate`。 |
| 人设卡 | `src/willa/person.js` | `person_get` / `person_list` / `person_upsert`。 |
| 生活 | `src/willa/life.js` | `life_now` / `life_set`。 |
| 定时 / 能动性 | `src/willa/alive*.js` | `alive_want` / `alive_list` / `alive_done` / `alive_drop`；到点自醒的 alive 定时器（不是通用 cron 工具）。 |
| 随机唤醒 | `src/willa/wander.js` | 隔一段随机给自己投一句，自己决定做什么。 |
| QQ（OneBot） | `src/willa/qq.js`、`wake.js` | `qq_send` / `qq_read` / `qq_status` / `qq_wake_test`；可选 WS 收消息注入会话。 |
| QQ 空间 | `src/willa/qzone.js` | 评论轮询（`qzoneEnabled`，默认关）。 |
| worker | `src/willa/worker.js` | `worker_run` / `worker_status` / `worker_list`，spawn `dsh --profile headless` 子进程。 |
| 新会话 | `src/willa/session.js` | `session_new`。 |
| 看门脚本 | `persona/guard/` | Windows PowerShell 5.1 的可选小工具：起 `dsh web`、抓带令牌的地址、看门、两段式重启。 |
| 筛 skill 的两支脚本 | `persona/scripts/` | `skill-usage.mjs` 从会话日志统计真实使用频率；`skill-lookup.mjs` 在常驻 / archive / off 里按关键词找 `SKILL.md`。 |
| 客户端页面 | `src/persona/client.js`、`lib/client.js`、`locale/`、`icon.svg` | DSH web 的设置页；只请求宿主同源 `/api/dsh-willa/*`，不出外网。 |

`enableWilla: true` 时共 **26 个工具**；四个后台（alive 定时器 / wake / wander / qzone 轮询）全用 `scope.effect` 建，插件重载不叠加。缺后端就少注册对应工具，不报错：QQ 没配 → 不出现 `qq_*`；`memoryEmbedUrl` 设空 → 不出现 `mem_recall` / `mem_note`（`mem_stats` 保留并显示「记忆未配置」）；找不到 `dsh` / `node` → 不出现 `worker_*`。纯本地的账始终在。

## 依赖（这个包的，不按包分）

**默认只开人设时不联网、不 spawn、不要外部进程。** 开了对应功能才需要下面这些，缺了就少几个工具，其余照常：

| 用途 | 需要什么 | 说明 |
|---|---|---|
| QQ 收发、收消息唤醒 | 一个 OneBot v11 实现（SnowLuma / NapCat 之类）在本机监听 HTTP，以及它的正向 WebSocket | 本包只 `POST <qqHttpUrl>/<action>`、`new WebSocket(qqWsUrl)`；**不含 OneBot 的代码或二进制**。地址和 token 自己填。 |
| QQ 空间轮询 | 同上，或用 `qzoneHttpUrl` + `qzoneToken` 单独指一个 OneBot | 默认关；开了才轮询。 |
| 记忆的语义检索 | 任一本机 OpenAI 兼容的 `/v1/embeddings` 服务 | `memoryEmbedUrl` 默认 `http://127.0.0.1:8767/v1/embeddings`；没服务就设空串：`mem_recall` / `mem_note` 不注册，`mem_stats` 仍能看本地账。 |
| worker 派活 | `dsh` CLI + `node` | `worker_run` 会 spawn `dsh --profile headless <task>`；找不到就不注册 `worker_*`。 |
| guard 看门脚本 | Windows + Windows PowerShell 5.1 | 可选，不装不影响插件。只有配了通知才连本机 OneBot。 |
| 两支筛 skill 脚本 | Node 22.15+ | 读 `sessions/**/session.v4.jsonl.zstd` 需要 `zlib.zstdDecompressSync`；零依赖，单独跑也行。 |

**B 站不在这个包里**：没有任何 B 站接口调用；记忆里可能出现 `bilibili-video` 频道，那是别的插件写进去的数据，本包只读。桌面宠物同样走宿主或别的插件。

## 目录

```text
willa-persona/
├── package.json          # 唯一的包：dsh-willa 0.1.0
├── README.md / README.zh.md
├── LICENSE / NOTICE / CHANGELOG.md / icon.svg
├── cordis.patch.yml
├── lib/                  # 构建产物（= src 的复制，link/file 安装不用先 build）
├── src/                  # 源码：persona/ + willa/ 26 个工具与四个后台
├── locale/               # zh.json / en.json
├── docs/                 # LOCAL-SETUP / PUBLISH / VERIFY / VERSION-AUDIT
├── scripts/              # build / smoke / preflight / privacy / selftest / migrate
└── persona/              # 可选工具目录
    ├── guard/            # Windows 看门脚本
    └── scripts/          # 两支筛 skill 脚本
```

## 测

需要 Node 22.15+；测试本身不需要 `npm install`。

```bash
npm run preflight   # 构建 → 冒烟 → 隐私扫描 → 客户端包壳 → 打包清单
npm test            # smoke
npm run selftest    # 门房 / worker 回执链路（临时目录 + 假 dsh bin）
cd persona && npm test   # 子目录自测（28 项）
npm pack --dry-run  # 看最终文件清单
```

`preflight` 会检查包里没有 `persona/lib`、`persona/test`、`private/`、`*.tgz`，并核对 `lib/index.js`、`lib/client.js`、`cordis.patch.yml`、`locale/{zh,en}.json`、`icon.svg`、`src/`、`docs/`、`scripts/` 和 `persona/{guard,scripts}/` 都在。

## 配置与数据

常用键：

| 键 | 默认 | 说明 |
|---|---|---|
| `enablePersona` | `true` | 人设段落 + 设置页路由 |
| `enableWilla` | `false` | 26 个工具与四个后台的总开关 |
| `aliveEnabled` | `true` | alive 到点自醒 |
| `wakeEnabled` | `false` | WS 收 QQ 消息注入会话，必须同时配 `wakeSessionId` |
| `wanderEnabled` | `false` | 随机自醒 |
| `qzoneEnabled` | `false` | QQ 空间评论轮询 |
| `memoryEmbedUrl` | `http://127.0.0.1:8767/v1/embeddings` | 设空串 = 不注册 `mem_recall` / `mem_note`（`mem_stats` 保留） |
| `personaStore` | 空 | 人设库路径；留空用 `<DSH_HOME>/storages/dsh-willa/personas.json` |

完整 40 个键的说明以 `src/config.js` 的 `DEFAULTS` 为准；旧配置兼容：顶层 `enabled: false` 同时关两半，`wake.enabled` 等旧嵌套键映射到 `wakeEnabled` 等拍平键。

数据默认落 `<DSH_HOME>/storages/dsh-willa/`；删掉就是空库。写入用「临时文件 + fsync + rename」，坏 JSON 先改名成 `.corrupt-<时间戳>.json` 留档再按空库继续。

## 隐私与许可

仓库和打包产物里**不含**作者的本机路径、QQ 号、token 或任何私人记忆；数据只写本机 `DSH_HOME`。`npm run privacy-check` 扫 `src/` 和 `lib/`，同一组关键词也可以用 `git grep` 复核。

MIT，见 [LICENSE](./LICENSE)。人设半侧来自 `dsh-persona-dafeiyu` 0.5.0（MIT），原版权声明见 [NOTICE](./NOTICE)。
