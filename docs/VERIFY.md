# 验过什么（dsh-willa 合并，2026-10-28 ~ 10-29）

这份只记**真跑过的东西**和当时的结果，方便以后判断能不能信。没跑的不写进来。

## 一条命令自检

```powershell
node scripts\preflight.mjs
```
依次跑 **构建 → 冒烟 → 隐私扫描 → 客户端包壳/插件页元数据 → 打包清单核对**。
2026-10-29 改成单包布局后全绿：文件数 69（约 180 KB），`lib/client.js` /
`locale/{zh,en}.json` / `icon.svg` / `src/` / `docs/` / `scripts/` 都在，
`persona/lib`、`persona/test`、`private/` 没进包（只带 `persona/guard/` 和 `persona/scripts/`）。

其中 `scripts\client-shape.mjs` 专门盯四件最容易出错又最难查的事：
`lib/client.js` 是 `__ModuleLoader__` 包壳、**loader id 等于包名**、bundle 里没有旧包名/旧 `/api/` 前缀、
`locale` 有 `meta.title`/`meta.description`、`icon.svg` ≤256 KiB、`exports` 与 `dsh.*` 字段指向正确。

## 门房校验与 worker 回执（2026-10-29 移植后自检）

`npm run selftest`（`scripts/selftest-door-worker.mjs`）只碰临时目录、用假 dsh bin，不派真会话：

- **插件入口 1 项**：假 ctx `apply()` 之后调 `qq_send.execute(args, exec)`，确认 exec 真的传到门房校验；
  旧会话拒、当前门房放行到「真去发」（端口 1，网络失败为止，不真发 QQ）。
- **门房 7 例**：门房自己放行 / 旧会话拒（按 `wake.sessionId`）/ wake 指向别人拒（文件写着自己也拒，
  证明不取并集）/ wake 为空回退 `door-session.txt` / 拿不到 self 放行 / 两个口径都读不到放行 /
  拒绝日志写不进去也照拒。
- **worker 回执**：`.done.json` 字段齐、tail 去 ANSI、注入恰好一次、重复 `finish()` 不重复注入、
  非 0 退出用 `[worker 出错了]` 带 tail 最后 3 行、`worker_list` 不把 `.done.json` 当 worker。

结果：全绿（2026-10-29 10:54，临时目录 `%TEMP%\dsh-willa-selftest-*`，跑完自删）。

## 隔离 profile 里的真装（`willa-merge-test`）

```
dsh plugin --profile willa-merge-test add "<仓库根>"
dsh --profile willa-merge-test --dump-config
```
→ 输出里有 `id: willa` / `name: dsh-willa` / `enablePersona: true` / `enableWilla: false`（默认值）。
把该 profile 的 `cordis.patch.yml` 覆盖成 `enableWilla: true` + 本机真实路径后，`--dump-config` 也能看到覆盖生效。

## 真会话（headless，带真 key）

问「如果你有 mem_stats 就直接调用一次」：
→ 它**真的调到了** `mem_stats`，贴回「老账 1895 条…新记 42 条」。

问「有没有 qq_status / alive_list」：
→ 答「alive_list 有，qq_status 没有」——**正是 D.2 的预期**（`qqToken` 没配就不注册 QQ 那四个）。

会话语气也带着人设（"哼，就本鱼没偷偷加餐"之类），说明人设段落在 headless 也生效。

## 挖出并修掉的一个真 bug（值得单独记）

按合并方案 C.4 写的是「不静态 inject，需要时 `ctx.inject(['tools'], cb)`」。结果：
- 探测日志显示 `apply` 跑了、`mountWilla` 进了、**工具数 22**；
- 但模型那轮的工具表里**一个都没有**，问它 `mem_stats` 答「没有」。

原因：headless 在插件加载后立刻组装第一轮请求，动态 `inject` 的回调晚一拍，注册没进这一轮的快照。
修法：跟两个老包一致——**静态 `inject = ['tools','systemPrompt']` + `apply` 里同步挂**；
可选服务（`webServer`）仍由人设模块内部动态 `inject`。修完同一个问法就答「有」并能真调了。

## Web 宿主（真起了一个 web 实例验）

做法：新建一个临时 profile `willa-web-test`（`$DSH_HOME/profiles/willa-web-test`），
`bundles` 写成 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-willa"]`，
用 **3081** 端口起（不碰 live 的 3080）：

```
dsh plugin --profile willa-web-test add file:<仓库根>
# 然后把 package.json 的 dsh.profile.bundles 里 dsh-headless 换成 @deepseek-ai/dsh-web-app
dsh --profile willa-web-test --port 3081 --no-open
```

结果（2026-10-29 00:5x）：
- 首页 `HTTP 200`，37 KB；
- **`GET /api/dsh-willa/status` → 200**，返回
  `"plugin":"dsh-willa","active":true,"current":"dafeiyu","currentName":"大肥鱼","section":"dafeiyu:persona"`；
- 旧前缀 `/api/dsh-persona-dafeiyu/status` → **404**（不跟旧包抢路由）；
- 首页的客户端模块清单里**出现了 `dsh-willa/client.js`**（宿主认到了我们的客户端半侧）。

验完已把 3081 关掉、进程清干净，**全程没碰 live 的 `web` profile 和 3080**（3080 一直活着）。

## 没验到的（别当已验）

- **设置页 UI 真点一遍**：只验到「路由通 + 包壳被宿主收录」，没在浏览器里点开面板看渲染；
  单独拉 `plugins/dsh-willa/client.js` 是 404（宿主走的是合并 bundle 那套路径），没继续深挖。
- **live `web` profile 的切换**：没做（等 Fox 点头，步骤在 `docs/LOCAL-SETUP.md`）。
- **人设库迁移**：脚本三种情况都验过（dry-run / 真迁 9414 B / 重复跑拒绝），但**没在真库上跑**——
  真库 `storages\dsh-willa\personas.json` 现在仍然不存在。
