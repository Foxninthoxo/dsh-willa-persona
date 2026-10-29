# 发布清单（等 Fox 建仓库之后照这条走）

现状：包已经能装、能跑、preflight 全绿；**GitHub 仓库还没建**（`package.json` 的
`repository/homepage/bugs` 因此留空），所以发布这一步只差「建仓 + push + npm publish」。

## 0. 先确认本地是绿的

```powershell
cd <workspace>\dsh-willa
node scripts\preflight.mjs      # 构建 → 冒烟 → 隐私 → 客户端包壳 → 打包清单
```

任何一步红都别往下走。

## 1. 建仓库（Fox 在网页上点，或给他授权后我来建）

- 仓库名：`Foxninthoxo/dsh-willa`
- **不要**勾 README / .gitignore / license（本地都有了，勾了会冲突）
- 公开（npm 包要能被找到，README 里链过去）

## 2. 填 `repository` 字段

`package.json` 里补：

```json
"repository": { "type": "git", "url": "git+https://github.com/Foxninthoxo/dsh-willa.git" },
"homepage": "https://github.com/Foxninthoxo/dsh-willa#readme",
"bugs": { "url": "https://github.com/Foxninthoxo/dsh-willa/issues" }
```

## 3. 第一次提交

```powershell
cd <workspace>\dsh-willa
git init -b main
git add -A
git commit -m "dsh-willa 0.1.0：人设库 + 可选伙伴工具（合并 willa-dsh 与旧人设包）"
git remote add origin git@github.com:Foxninthoxo/dsh-willa.git
git push -u origin main
```

> 提交前再扫一眼 `git status`：**不该出现** `private/`、`node_modules/`、`*.tgz`、`docs/`。
> `lib/` 要进库（`link:` 安装时不用先 build）。

## 4. npm 发布（要 Fox 的账号和他点头）

```powershell
npm login          # Fox 自己在弹出的浏览器里登
npm publish        # 0.1.0 首次发布；prepublishOnly 会自动跑 preflight
```

- 包名 `dsh-willa` 2026-10-26 查过 npm registry 是 404（未占）；**发之前再查一次**。
- 想先看包里有什么：`npm pack --dry-run`（preflight 已经帮你核过一遍）。
- 版本：0.x 起步（DSH 自己还在 rc）。

## 5. 发完之后

- README 顶部把「状态」改成已发布，写清默认值（人设开、私活关）。
- 在 `partner/plugin-merge-plan.md` 末尾记一条「已发布 0.1.0」。
- 自己的 live profile 切换按 `docs/LOCAL-SETUP.md` 走（**切之前先备份 profile 的 package.json 和 cordis.patch.yml**）。

## 不要做的事

- **别**把 `repository` 指到 `Willa-private`（那是私有备份库）。
- **别**在没跑 preflight 的情况下 `npm publish`。
- **别**把本机的 `docs/`（含 LOCAL-SETUP 里的本机路径）打进 npm 包 —— `files` 白名单已经排除，别改回去。
