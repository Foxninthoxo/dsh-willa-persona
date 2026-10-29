# dsh-willa（中文短版）

一个仓库、一个包：仓库根就是 `dsh-willa` 0.1.0，只作源码与本地安装用，**暂不发布到 npm**。人设默认可用；开 `enableWilla` 后才有记忆、心账、定时与随机唤醒。QQ（OneBot）、QQ 空间、worker、guard 和两支筛 skill 的脚本按需启用。

## 装

```bash
npm i dsh-willa
dsh plugin --profile <profile> add dsh-willa
```

本地开发把包名换成仓库根绝对路径。默认 `enablePersona: true` / `enableWilla: false`：装完只是一个人设库，不碰 QQ、记忆和后台任务。

## 里面有什么

- **人设**：Willa（大肥鱼）注入、称呼、设置页 `/api/dsh-willa/*` 三条路由。
- **记忆 / 心账 / 人设卡 / 生活 / 能动性**：`enableWilla: true` 才挂；记忆要配 `memoryEmbedUrl`（OpenAI 兼容 embeddings）才注册 `mem_recall` / `mem_note`，没配只留 `mem_stats` / `mem_supersede`。
- **定时 / 随机唤醒**：alive 定时器 + wander；`scope.effect` 建，重载不叠加。
- **QQ（OneBot）**：`qq_*` 四个工具 + 可选 WS 收消息注入；**不含 OneBot 本体**。
- **QQ 空间**：评论轮询，默认关。
- **worker**：`worker_*` 三个工具，spawn `dsh --profile headless`。
- **guard**：`persona/guard/` 的 Windows PowerShell 5.1 看门/重启脚本，可选。
- **两支筛 skill 脚本**：`persona/scripts/skill-usage.mjs` 和 `skill-lookup.mjs`，零依赖。

依赖表、配置键、数据位置和完整说明看 [README.md](./README.md)。

## 测

```bash
npm run preflight   # 构建 → 冒烟 → 隐私 → 客户端包壳 → 打包清单
npm test
npm run selftest
cd persona && npm test   # 子目录自测（28 项）
```

## 依赖口径

默认不开 `enableWilla` 时不联网、不 spawn、不要外部进程。开了才需要：OneBot v11（QQ / 空间 / wake）、OpenAI 兼容 embeddings（记忆，配了才启用）、`dsh` + `node`（worker）、Windows PowerShell 5.1（guard）。B 站不在这个包里。

MIT，见 [LICENSE](./LICENSE)。
