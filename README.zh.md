# dsh-willa-repo（中文短版）

一个仓，两个可单独安装的 DSH 插件包：

- **`dsh-willa-persona`** —— 纯人设：人设注入、本地记忆、心账、轻量定时、随机唤醒；默认不联网、不装外部工具。
- **`dsh-willa`** —— 完整版：人设半侧 + 可选 QQ 桥（OneBot）、worker 派活、QQ 空间轮询、客户端页面；默认只开人设半侧，其余要自己配。

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

隐私口径：仓里不带本机路径、QQ 号、token 或私人记忆；两个包默认不联网，外部能力都要显式配置。

MIT，见 [LICENSE](./LICENSE)。
