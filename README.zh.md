# dsh-willa-repo（中文短版）

一个仓，两个可单独安装的 DSH 插件包：

- **`dsh-willa-persona`** —— 纯人设：人设注入、本地记忆、心账、轻量定时、随机唤醒；插件本体默认不发外部请求，记忆默认纯本地关键词检索（配了 `embeddingEndpoint` 才走向量），不装外部工具。
- **`dsh-willa`** —— 完整版：人设半侧 + 可选 QQ 桥（OneBot）、worker 派活、QQ 空间轮询、客户端页面；默认只开人设半侧（`enableWilla: false`），QQ / 空间 / 向量记忆 / worker 都要另外配置或自备外部组件。

选哪个：只要性子 + 记事 → `dsh-willa-persona`；要 QQ / 派活 / 空间 → `dsh-willa`。两个别同时启用。

## 装（发布后）

```bash
npm i dsh-willa-persona
npm i dsh-willa

dsh plugin --profile <profile> add dsh-willa-persona
dsh plugin --profile <profile> add dsh-willa
```

## 测

```bash
npm test          # 根目录，跑两个包
npm run preflight # dsh-willa 的发布前自检
```

## 文档

- 完整说明（中文）：[README.md](./README.md)
- persona：[README](./packages/dsh-willa-persona/README.md) / [中文长文](./packages/dsh-willa-persona/README.zh.md) / [LESSONS](./packages/dsh-willa-persona/LESSONS.md)
- dsh-willa：[README](./packages/dsh-willa/README.md) / [验证记录](./packages/dsh-willa/docs/VERIFY.md) / [CHANGELOG](./packages/dsh-willa/CHANGELOG.md)

隐私口径：仓里不带本机路径、QQ 号、token 或私人记忆，数据只写本机 `DSH_HOME`。依赖按包分，别说成一个口径：

| 包 | 要联网吗 | 要外部进程/工具吗 |
|---|---|---|
| `dsh-willa-persona` | 默认不发外部请求（纯本地关键词检索）；只有配了 `embeddingEndpoint` 才请求你指定的 embeddings 服务 | 不要；定时/唤醒用自带 timer，不 spawn 进程 |
| `dsh-willa` | 开了功能才要：QQ/空间连本机 OneBot HTTP/WS，向量记忆连 `memoryEmbedUrl`，`wake` 收图会按 URL 下载图片 | worker 会 spawn `dsh --profile headless` 子进程；QQ/空间要 OneBot v11 实现 |

**不开这些功能就不需要它们**（`dsh-willa` 默认 `enableWilla: false`，persona 默认 `embeddingEndpoint: ''`）。逐条代码依据见 [README.md 的依赖表](./README.md#隐私与安全)。

MIT，见 [LICENSE](./LICENSE)。
