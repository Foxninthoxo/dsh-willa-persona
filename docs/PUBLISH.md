# 发布清单（dsh-willa 单包）

现状（2026-10-29）：仓库 `Foxninthoxo/dsh-willa-persona` 已存在，仓库根就是唯一的包 `dsh-willa` 0.1.0；`persona/` 是留档，已标 `private`。本地 preflight 全绿后，只差 npm 发布这一步。

## 0. 先确认本地是绿的

```powershell
cd <仓库根>
node scripts\preflight.mjs      # 构建 → 冒烟 → 隐私 → 客户端包壳 → 打包清单
```

任何一步红都别往下走。

## 1. 核对 `package.json`

- `name` 是 `dsh-willa`，`version` 是 `0.1.0`，**没有** `private`。
- `files` 覆盖 `lib/ src/ locale/ docs/ scripts/ persona/guard/ persona/scripts/` 和根部的 patch / README / LICENSE / NOTICE / CHANGELOG / icon；**不包含** `persona/lib`、`persona/test`。
- 根部的单文件用 `/` 前缀锚定（如 `/README.md`、`/cordis.patch.yml`）：npm 的 `files` glob 不锚定时会按文件名匹配到 `persona/` 里的同名文件。
- `repository` 指向 `Foxninthoxo/dsh-willa-persona`，`homepage` 是仓库根，不再带 `packages/...` 子目录。
- `persona/package.json` 必须保留 `"private": true`，永远不要 `npm publish` 它。

## 2. 版本与 CHANGELOG

- 首次发布保持 `0.1.0`；之后每次改动先在 `CHANGELOG.md` 的「未发布」里记一行，再改版本号。
- 打 tag 可选：`git tag v0.1.0`，但**推不推、什么时候推由 Fox 定**。

## 3. npm 发布（要 Fox 的账号和他点头）

```powershell
npm login          # Fox 自己在弹出的浏览器里登
npm publish --dry-run
npm publish        # 0.1.0 首次发布；prepublishOnly 会自动跑 preflight
```

- 包名 `dsh-willa` 发之前再查一次 registry 是否被占。
- 想先看包里有什么：`npm pack --dry-run`（preflight 已经核过一遍）。
- 版本：0.x 起步（DSH 自己还在 rc）。

## 4. 发完之后

- README 顶部补「已发布」和默认值（人设开、私活关）。
- 在 `partner/plugin-merge-plan.md` 末尾记一条「已发布 0.1.0」。
- 自己的 live profile 切换按 `docs/LOCAL-SETUP.md` 走（**切之前先备份 profile 的 package.json 和 cordis.patch.yml**）。

## 不要做的事

- **别**把 `repository` 指到 `Willa-private`（那是私有备份库）。
- **别**在没跑 preflight 的情况下 `npm publish`。
- **别**把 `persona/lib`、`persona/test`、`private/` 打进 npm 包；`files` 白名单已经排掉，别改回去。
- **别**把项目根当成 npm workspaces 再来一遍：这里只有一个包，`packages/` 已经删了。
