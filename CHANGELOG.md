# 更新日志

## 未发布

### willa 半侧
- `qq_send` 加门房校验：不是当前门房就拒发。门房口径**严格串行**——内存里的门房 id
  （`wakeSessionId`，`session_new` 会当场改它）有值就只认它，没有才回退
  `<willaDataDir>/door-session.txt`；拿不到自己的 `sessionId`、或两个口径都读不到时
  fail-open 放行（只在 stderr 说一句）。拒绝时写一行 `<willaDataDir>/qq-send-blocked.log`
  再抛错，日志写不进去也照拒。
- `worker_run` 干完主动回执：子进程 exit 时写 `<id>.done.json`（id / exitCode / signal /
  finishedAt / logPath / tail 最后 20 行 / task 前 120 字），并往门房会话注入
  `[worker 回来了]` 或 `[worker 出错了]`（带 tail 最后 3 行）；同 id 只写一次、只注入一次。
- 回执再加两道闸：`finishedAt` 超过 5 分钟的不再注入（只打 stderr，`done.json` 照写）；
  2 秒内先后结束的合成一条（最多 5 个），失败的那几条仍单独成条、成功的合并，带
  `详见 worker_list`。

### dsh-guard（`persona/guard/`）
- `restart-worker.ps1` 修「重启 dsh web 把 OneBot 桥一起带走」：停进程只认
  `@deepseek-ai/dsh/lib/bin.js web`，排除命令行/父进程链上的 SnowLuma 与父进程为
  DSH `runner.js` 的进程，只 `Stop-Process -Id`；web 健康后按 `bridgeEnsureScript`
  （或沿脚本目录往上找 `skills\qq-bridge\ensure.ps1`）跑一次 ensure，失败重试一次，
  仍失败只记日志并调一次 `grab-qr.ps1 -Notify`，重启退出码保持 0。

### 工程
- 新增 `npm run selftest`（`scripts/selftest-door-worker.mjs`）：插件入口 1 项 + 门房 7 例 +
  worker 回执，只碰临时目录、假 dsh bin。
- 改成单包布局：仓库根就是 `dsh-willa`，删掉 `packages/` 与 npm workspaces；
  原 `dsh-willa-persona` 整套移入 `persona/`（`private: true`）。
- `files` 扩到 `src/`、`docs/`、`scripts/`、`persona/guard/`、`persona/scripts/`；
  `persona/lib`、`persona/test` 明确排除。preflight 的打包清单同步改口径。
- 根 README 重写成「一个包装什么」，依赖表按本包真实行为重写；根 `guard:install`
  指到 `persona/guard/install-guard.ps1`，两支筛 skill 的脚本仍从 `persona/scripts/` 直接跑。

## 0.1.0 — 2026-10-29

第一个版本：把 `willa-dsh`（26 个工具 + 四个后台）和 `dsh-persona-dafeiyu`（人设库）合成一个包。

**对外默认**：只开人设（`enablePersona: true`），私活全关（`enableWilla: false`）。
装了就是一个人设库；用户的 QQ、记忆、后台任务一概不碰。

### 人设半侧
- 从 `dsh-persona-dafeiyu` 0.5.0（MIT）迁入，保留原版权声明（`NOTICE` / `LICENSE`）。
- 三条路由改为 `/api/dsh-willa/{status,mutate,persona}`；客户端 bundle 的 loader id 改为 `dsh-willa`。
- 人设库默认 `$DSH_HOME/storages/dsh-willa/personas.json`，`personaStore` 可覆盖；
  旧库迁移用 `scripts/migrate-persona-store.mjs`（默认 dry-run，目标已存在就拒绝）。

### willa 半侧（`enableWilla: true` 才挂）
- 26 个工具：QQ 四个、记忆四个、心账五个、人设卡三个、生活两个、能动性四个、派活三个、新会话一个。
- 四个后台：`alive` 定时器、`wake`（OneBot WS 收消息注入会话）、`wander`（随机自醒）、`qzone` 轮询；
  全部用 `scope.effect` 建，**插件重载不叠加**。
- **缺后端就不注册对应工具**：QQ 没配 → 不出现 `qq_*`；embed 没配 → 只剩 `mem_stats`（显示「记忆未配置」）；
  `dsh`/`node` 找不到 → 不出现 `worker_*`。纯本地的账始终在。
- 26 处本机硬编码全部改成配置项（40 个键），没有再读别人的配置文件。

### 工程
- `npm run preflight`：构建 → 冒烟 → 隐私扫描 → 客户端包壳/元数据 → 打包清单，一条命令跑完。
- `lib/` 进库，`link:` / `file:` 安装不用先构建。
- 同一份代码里不再出现本机路径、QQ 号、token（隐私扫描守着）。

### 已知
- 设置页 UI 没在真实浏览器里点过（路由与宿主收录已验，见 `docs/VERIFY.md`）。
- `package.json` 的 `repository` / `homepage` / `bugs` 等 GitHub 仓库定了再补。
