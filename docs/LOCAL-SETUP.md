# 本机切换到 dsh-willa（Fox 自己这台机器）

目标：让 Fox 的 `web` profile 从「`willa-dsh` + `dsh-persona-dafeiyu` 两个包」切换到「`dsh-willa` 一个包」，
**且随时能一键切回来**。切换之前 `dsh-willa` 必须先在隔离 profile 里装过、`--dump-config` 正常。

> 现状（2026-10-29）：单包已合并完成，`dsh-willa` 的 26 个工具和四个后台都已迁入。
> live 的 `web` profile 还没切；**切之前先备份 profile，再按下面的步骤走。**

## 前置检查

```powershell
# 1) 包的形状对不对（不装，只看）
cd <仓库根>
node scripts\smoke.mjs
node scripts\privacy-check.mjs
npm pack --dry-run          # 清单应含根包 + persona/guard、persona/scripts，不含 persona/lib、persona/test、private/

# 2) 隔离 profile 里能装、能解析
dsh plugin --profile willa-merge-test add "<仓库根>"
dsh --profile willa-merge-test --dump-config
# 期望看到：  id: willa / name: dsh-willa / enablePersona: true / enableWilla: false
```

## 切换步骤（确认无误后再执行）

1. **备份两个东西**（不要跳过）：
   ```powershell
   Copy-Item "$env:USERPROFILE\.dsh\profiles\web\package.json" "$env:USERPROFILE\.dsh\profiles\web\package.json.bak-willa-merge"
   Copy-Item "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml.bak-willa-merge"
   ```
2. 装上合并包（`link:` 指向工作区，改代码不用重装）：
   ```powershell
   dsh plugin --profile web add "<仓库根>"
   ```
3. 在 `~\.dsh\profiles\web\cordis.patch.yml` 里覆盖同一个 id 的配置（本机才需要的那几项）：
   ```yaml
   - id: willa
     config:
       enablePersona: true
       enableWilla: true
       willaWorkspace: '<工作区绝对路径>'
       willaDataDir: '<工作区绝对路径>\private'
       qqHttpUrl: 'http://127.0.0.1:3000'
       qqWsUrl: 'ws://127.0.0.1:3001'
       qqSelfId: '<你的QQ号>'
   ```
   `qqToken` 现在是空（SnowLuma 的 accessToken 已置空、只监听回环），所以不用填；
   填了反而会发 `Bearer ` 空头。**secret 类字段真要写时，别写进 git 里的任何文件。**
4. **把旧的两个包关掉**（别同时开：两套 `systemPrompt` 段落会打架、两个 wake 会抢会话）：
   ```powershell
   dsh plugin --profile web remove willa-dsh
   dsh plugin --profile web remove dsh-persona-dafeiyu
   ```
5. 重启 dsh web（走 `skills\dsh-web\` 的脚本，不要裸 `dsh web`；重启后 SnowLuma 可能一起掉，
   按 `skills\snowluma-recover` 救）。
6. 验：`--dump-config` 有 `id: willa`；网页里设置页能看到「人设 / 伙伴」；`qq_status` 能回「大肥鱼」；
   `mem_stats` 条数对得上。

## 回滚（30 秒）

```powershell
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\package.json.bak-willa-merge" "$env:USERPROFILE\.dsh\profiles\web\package.json" -Force
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml.bak-willa-merge" "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" -Force
dsh plugin --profile web add willa-dsh
dsh plugin --profile web add dsh-persona-dafeiyu
# 然后重启 dsh web
```

## 数据迁移（只在第一次切的时候做）

- 人设库：旧的 `<DSH_HOME>\storages\dsh-persona-dafeiyu\personas.json`，
  新包默认读 `<DSH_HOME>\storages\dsh-willa\personas.json`。用脚本迁（2026-10-29 加）：
  ```powershell
  node scripts\migrate-persona-store.mjs          # 只看计划
  node scripts\migrate-persona-store.mjs --apply  # 真写；目标已存在就拒绝（exit 2）
  ```
  脚本只复制不删旧库；`--force` 才会覆盖（先备份成 `.bak-<时间>`）。**别让新旧两个包同时写同一份。**
- Willa 的私活数据在 `workspace\private\`（`people.json` / `affinity.json` / `life.json` / `alive.json` /
  `memory-notes.json` / `memory-vectors-v2.json` / `workers\`）：`willaDataDir` 指过去就不用搬。

## 已知坑（踩过的，别再踩）

- **客户端 bundle 的 loader id 必须等于包名**（`dsh-willa`），否则加载后注册不上、设置页空白。
  `scripts\build.mjs` 里有自检，id 不对会直接构建失败。
- **`resolve(HERE,'..','..')` 反推工作区**那种写法装进 `node_modules` 会落到 node_modules ——
  合并包统一走 `src\paths.js` 的 `dataDir()`，别再引入。
- **`files` 白名单只管 `npm pack`**，`link:` 安装不过滤：调试时别把 `private\` 放进包目录。
