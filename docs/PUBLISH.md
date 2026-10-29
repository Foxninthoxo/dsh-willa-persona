# 发布（暂不发布）

**这个包暂不发布到 npm。** 仓库只作源码与本地安装（`dsh plugin --profile <profile> add "<仓库根>"`）使用。

本地自检照旧：

```powershell
node scripts\preflight.mjs   # 构建 → 冒烟 → 隐私 → 客户端包壳 → 打包清单
```

哪天要发布，先跟 Fox 确认；旧版流程可以从 git 历史里翻。
