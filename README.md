# dsh-willa-repo

一个仓库，两个可以**单独安装**的 DeepSeek Harness（DSH）插件包。两个包名字很像，先看这张表：

| 包 | npm 名 | 是什么 | 装它得到什么 |
|---|---|---|---|
| [`packages/dsh-willa-persona`](./packages/dsh-willa-persona/) | `dsh-willa-persona` | 纯人设包 | Willa（大肥鱼）人设注入、本地记忆、心账、轻量定时、随机唤醒。**默认不联网、不装外部工具**，也不含 QQ / B站 / 桌面宠物。 |
| [`packages/dsh-willa`](./packages/dsh-willa/) | `dsh-willa` | 完整版 | 人设半侧 + 可选 QQ 桥（OneBot，含收发 / 注入 / 空间轮询）、worker 派活、客户端页面。默认只开人设半侧（`enableWilla: false`），QQ 等能力要自己配。 |

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

这个仓**不含**作者的本机路径、QQ 号、token 或任何私人记忆；两个包默认不联网，QQ、embedding 向量检索、worker 都要显式配置后才启用，数据只写本机 `DSH_HOME`。

## License

MIT，见 [LICENSE](./LICENSE)。`dsh-willa` 的人设半侧来自 `dsh-persona-dafeiyu` 0.5.0（MIT），原版权声明见该包的 `NOTICE`。