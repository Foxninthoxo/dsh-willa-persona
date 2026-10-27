# dsh-willa-persona（中文说明）

DeepSeek Harness（DSH）插件：注入「Willa / 大肥鱼」人设，附带本地记忆、心账、轻量定时和随机唤醒。
默认不联网、不安装外部工具，也不附带任何私人数据。完整说明见 [README.md](./README.md)。

## 爱好

随机唤醒会按权重从「爱好 / 没做完的定时任务 / 发呆」里挑一句，措辞随机。爱好用 `hobby_add` / `hobby_list` / `hobby_remove` 维护，存在 `storages/dsh-willa-persona/hobbies.json`。

## 30 秒上手

```bash
# 从 npm 安装（发布后）
dsh plugin --profile <profile> add dsh-willa-persona

# 或从本地目录安装
dsh plugin --profile <profile> add "<本包目录的绝对路径>"
```

装完直接说话即可。第一次它会问你怎么称呼，也可以随时用 `willa_set_owner` 改名。
同一个 profile 不要同时启用另一个人设插件。

## 配置项

都写在插件行的 `config` 里，全部可选。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时不注入人设，工具仍可用。 |
| `ownerName` | `""` | 显式指定称呼；留空就先问、再记进 `owner.json`。 |
| `allowExtraTools` | `false` | `true` 只允许模型「先问再装」外部工具，不会真的加工具。 |
| `embeddingEndpoint` | `""` | OpenAI 兼容 embeddings 地址；空 = 纯关键词检索。 |
| `scheduleEnabled` | `true` | `false` 时关闭定时工具和调度。 |
| `wanderEnabled` | `true` | `false` 时关闭随机唤醒。 |
| `wanderMinMinutes` / `wanderMaxMinutes` | `45` / `120` | 随机唤醒间隔（分钟）。 |

## 数据在哪

默认在 `<DSH_HOME>/storages/dsh-willa-persona/`（未设置 `DSH_HOME` 时是 `~/.dsh/`）：

- `memory.json`：记忆
- `xinchang.json`：心账
- `schedules.json`：定时任务
- `wander.json`：下次唤醒时间
- `owner.json`：对方称呼（首次设置后生成）

删掉这个目录就是清空。写入用临时文件 + fsync + rename，不留半截 JSON。

## 支持的 DSH 版本

`>=0.2.0 <0.4.0`（开发机实测 `0.2.1-rc.2`），以 `package.json` 的 `engines.dsh` 为准。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
