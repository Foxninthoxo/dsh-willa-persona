# dsh-willa-repo

一个仓库，两个可以**单独安装**的 DeepSeek Harness（DSH）插件包。两个包名字很像，先看这张表：

| 包 | npm 名 | 是什么 | 装它得到什么 |
|---|---|---|---|
| [`packages/dsh-willa-persona`](./packages/dsh-willa-persona/) | `dsh-willa-persona` | 纯人设包 | Willa（大肥鱼）人设注入、本地记忆、心账、轻量定时、随机唤醒。**插件本体默认不发外部请求**，记忆默认纯本地关键词检索；不含 QQ / B站 / 桌面宠物。 |
| [`packages/dsh-willa`](./packages/dsh-willa/) | `dsh-willa` | 完整版 | 人设半侧 + 可选 QQ 桥（OneBot，含收发 / 注入 / 空间轮询）、worker 派活、客户端页面。默认只开人设半侧（`enableWilla: false`）；QQ、向量检索、worker 都要另外配置或自备外部组件（见[依赖表](#隐私与安全)）。 |

**怎么选**：只想要一个会记事、会自己提醒自己的 Willa，装 `dsh-willa-persona`；要把 QQ、派活、QQ 空间也接上，装 `dsh-willa`。两个包**不要同时启用**，否则两套人设会一起进 systemPrompt。

两个包共用一套人设来源和发布节奏，所以放在一个仓里；各自的 `package.json` 仍然独立，可以分别发 npm。

## 装

从 npm（发布后）：

```bash
npm i dsh-willa-persona
npm i dsh-willa
```

作为 DSH 插件装（发布后可直接用包名；本地开发时把包名换成包的绝对路径）：

```bash
dsh plugin --profile <profile> add dsh-willa-persona
dsh plugin --profile <profile> add dsh-willa
```

装完直接说话就行。数据默认落在 `<DSH_HOME>/storages/<包名>/`，删掉就是空库。详细配置、工具列表、数据结构和踩坑记录看各包的 README：

- persona：[README](./packages/dsh-willa-persona/README.md) / [中文](./packages/dsh-willa-persona/README.zh.md) / [LESSONS](./packages/dsh-willa-persona/LESSONS.md)
- dsh-willa：[README](./packages/dsh-willa/README.md) / [验证记录](./packages/dsh-willa/docs/VERIFY.md) / [CHANGELOG](./packages/dsh-willa/CHANGELOG.md)

## 测

在仓库根（需要 Node 22.15+，测试本身不需要 `npm install`）：

```bash
npm test          # 两个包的 test 都跑：persona 的 selftest + dsh-willa 的 smoke
npm run preflight # dsh-willa：构建 → 冒烟 → 隐私扫描 → 客户端包壳 → 打包清单
```

单独跑：

```bash
cd packages/dsh-willa-persona
npm test                 # 28 项

cd packages/dsh-willa
npm run preflight        # 发布前一条命令自检
npm run selftest         # 门房 / worker 回执链路
```

根目录的 `npm run guard:install` 已挪回子包：`cd packages/dsh-willa-persona && npm run guard:install -- -EnvFile <path>`。

## 目录

```text
willa-persona/
├── package.json          # private，workspaces: ["packages/*"]，只放脚本，不发布
├── README.md
├── README.zh.md
├── LICENSE
├── .gitignore            # 两边规则合并
└── packages/
    ├── dsh-willa-persona/
    │   ├── lib/ test/ scripts/ guard/
    │   ├── LESSONS.md
    │   ├── cordis.patch.yml
    │   ├── package.json
    │   ├── LICENSE
    │   └── README.md / README.zh.md
    └── dsh-willa/
        ├── lib/ src/ docs/ locale/ scripts/
        ├── cordis.patch.yml
        ├── package.json
        ├── CHANGELOG.md / NOTICE / LICENSE / icon.svg
        └── README.md / .gitignore
```

## 隐私与安全

这个仓**不含**作者的本机路径、QQ 号、token 或任何私人记忆，数据只写本机 `DSH_HOME`。两个包对网络和外部进程的要求**不一样**，分开说：

| 包 | 要联网吗 | 要外部进程/工具吗 | 可选依赖 |
|---|---|---|---|
| `dsh-willa-persona` | **默认不发任何外部请求**：记忆默认走纯本地关键词/子串检索。只有显式配了 `embeddingEndpoint`，才会把记忆正文和查询词 POST 到**你指定的** OpenAI 兼容 `/v1/embeddings`。 | 不要。定时和随机唤醒用本包自己的 timer（宿主有 `ctx.schedule` 就借，没有也照跑），不 spawn 任何进程。 | `embeddingEndpoint`（OpenAI 兼容 embeddings 服务）；可选的 `guard\` 看门脚本（PowerShell，只在配了通知时连本机 OneBot `127.0.0.1`）。 |
| `dsh-willa` | **开了对应功能才联网**：QQ 收发/读记录连你配的 OneBot HTTP，`wake` 连 OneBot 正向 WS，QQ 空间轮询连 OneBot HTTP，向量记忆 POST 到 `memoryEmbedUrl`（默认 `http://127.0.0.1:8767/v1/embeddings`）；`wake` 收到图片时还会按 OneBot 给的 URL 下载图片。默认 `enableWilla: false` 时这些都不发生。 | **worker 要 `dsh` + `node`，会 spawn `dsh --profile headless <task>` 子进程**；QQ / 空间要一个 OneBot v11 实现（SnowLuma / NapCat 之类）在本机监听端口。缺了就不注册对应工具，其余照常。 | OneBot v11 实现、OpenAI 兼容 embeddings 服务、`dsh` CLI + Node。 |

**不开这些功能就不需要它们**：`dsh-willa` 默认 `enableWilla: false`，装完只得到人设库；`dsh-willa-persona` 默认 `embeddingEndpoint: ''`，从头到尾只读写本地 JSON。B 站不在两个包里：本仓没有 B 站调用，记忆里出现 `bilibili-video` 频道也只是读别的插件写进来的数据；作者的 B 站能力来自另行安装的插件（如 `dsh-plugin-bilibili`），与本仓无关。

依据（按文件/函数）：

- persona 默认检索：`packages/dsh-willa-persona/lib/storage.js` 的 `recallMemory()`（关键词/子串计分）；唯一的外部请求是 `embedText()`，只有 `noteMemory()` / `searchMemory()` 在 `embeddingEndpoint` 非空时才调。
- persona 定时：`lib/schedule.js` 的 `ScheduleEngine`（自带 timer + `schedules.json`）；宿主有 `ctx.schedule` 时按 `backend: host` 借用，没有就 `backend: local`。
- dsh-willa QQ：`packages/dsh-willa/src/willa/qq.js` 的 `call()` → `POST <qqHttpUrl>/<action>`；`wake.js` 的 `watchOneBot()` → `new WebSocket(qqWsUrl)`。
- dsh-willa 空间：`qzone.js` 的 `makeCall()` → `POST <OneBot>/<action>`（`qzoneHttpUrl` 或 `qzoneOnebotConfig`）。
- dsh-willa 向量记忆：`memory.js` 的 `embed()` → `POST memoryEmbedUrl`；`memoryEmbedUrl` 设为空串才彻底关掉 `mem_recall` / `mem_note`。
- dsh-willa worker：`worker.js` 的 `run()` → `spawn(dsh|node, ['--profile', 'headless', task])`；找不到 `dsh` 或 `node` 就不注册 `worker_*`。
- dsh-willa 收图：`wake.js` 的 `saveImage()` → `fetch(图片 URL)`，URL 来自 OneBot 消息段（通常是腾讯图床），这是本包唯一可能访问外网的路径。
- 客户端设置页 `lib/client.js` 只请求宿主同源 `/api/dsh-willa/*`，不出外网。

## License

MIT，见 [LICENSE](./LICENSE)。`dsh-willa` 的人设半侧来自 `dsh-persona-dafeiyu` 0.5.0（MIT），原版权声明见该包的 `NOTICE`。