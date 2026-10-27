# dsh-willa-persona

安装（npm 发布后）：`dsh plugin --profile <profile> add dsh-willa-persona`
支持的 DSH 版本：`>=0.2.0 <0.4.0`

DeepSeek Harness（DSH）插件：把「Willa / 大肥鱼」的人设做成 systemPrompt 注入，另外带一套**本地**记忆库、心账，以及本包自带的轻量定时和随机唤醒。

这个包**默认不联网、不装任何外部工具、不依赖别人的调度插件**；宿主有 `ctx.schedule` 时会借，没有就用自己的 timer。适合想直接用这个性子、但不想继承作者私人关系数据的部署。

## 30 秒上手

```bash
dsh plugin --profile tui add "<本包目录的绝对路径>"
```

装完直接跟它说话就行，不用改配置。第一次它会顺口问你怎么称呼，你说一次，它用 `willa_set_owner` 记住，之后一直这么叫；不想说就不追问。

想改只动 `config` 里几个可选项：`ownerName`（显式指定称呼）、`allowExtraTools`、`wanderEnabled` / `wanderMinMinutes` / `wanderMaxMinutes`，全可选。

数据都在 `~/.dsh/storages/dsh-willa-persona/`，删了就是空库。

## 包里有什么

- **人设**：OCEAN 五维、角色卡、说话方式、行为规则、反例、底线。称呼不用配：首次会问对方怎么叫，记进 `owner.json`；`config.ownerName` 只作显式覆盖。
- **称呼工具**：`willa_set_owner`，把对方希望被叫的名字记下来。
- **记忆工具**：`mem_note` / `mem_recall` / `mem_stats` / `mem_supersede`。
- **心账工具**：`xinchang_get` / `xinchang_list` / `xinchang_adjust` / `xinchang_slot`。
- **定时工具**：`schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`。支持一次、固定间隔、每天、五段 cron。
- **随机唤醒**：默认每 45–120 分钟随机给自己投一句短提示，醒来后自己决定做什么。
- **空库起步**：不附带任何记忆、任何人、任何聊天记录，也不提供迁移工具。

人设原文经过了通用化处理：没有具体人的账号、群号、本机路径或内网端口。

## 安装

### 方式一：本地目录安装

```bash
dsh plugin --profile <profile> add "<本包目录的绝对路径>"
```

`<profile>` 换成你实际用的 profile 名。具体子命令以当前 DSH 版本的 `dsh plugin --help` 为准。

### 方式二：DSH 插件页

在插件管理里选择本地包/本地目录安装，指向本包根目录（有 `package.json` 的那一层）。

### 安装后注意

- 同一个 profile **不要同时启用另一个人设插件**（比如 `dsh-persona-dafeiyu`）。两段 persona 会一起进 systemPrompt，模型会收到两套身份。装之前先停用旧的。
- 本包不是 QQ、B 站、浏览器或桌面宠物插件；单独装它会多出定时和随机唤醒，但不会多出这些外部能力。
- 安装后第一次启动会在 `<DSH_HOME>/storages/dsh-willa-persona/` 下创建四个空 JSON 文件（记忆、心账、定时、唤醒）；`owner.json` 在第一次问出称呼时生成。

## 配置

配置都在插件行的 `config` 里，全部可选。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时不注入人设，工具仍然注册（方便单独用记忆/心账）。 |
| `ownerName` | `""` | 可选。显式指定怎么称呼；留空就先看 `owner.json`，没有就用「你」并顺口问一句。只影响提示词，不参与存储键。 |
| `personaName` | `"Willa"` | 这个人设自己的名字。改掉之后提示词标题、自称全跟着变。 |
| `personaAlias` | `"大肥鱼"` | 昵称/外号，出现在「别人叫你××也行」那句；留空就不提昵称。 |
| `allowExtraTools` | `false` | 见下一节。`true` 只是在提示词里允许模型**先问再装**，不会真的给本包加工具。 |
| `embeddingEndpoint` | `""` | 可选。OpenAI 兼容的 embeddings 服务地址；空 = 纯关键词检索。 |
| `embeddingModel` | `"BAAI/bge-small-zh-v1.5"` | 配了 endpoint 时传给服务的模型名。 |
| `order` | `0` | 人设段在 systemPrompt 里的顺序，通常不用改。 |
| `scheduleEnabled` | `true` | `false` 时不注册定时工具，也不排定时。 |
| `wanderEnabled` | `true` | `false` 时不随机唤醒。 |
| `wanderMinMinutes` | `45` | 随机唤醒最短间隔（分钟，最小 1）。 |
| `wanderMaxMinutes` | `120` | 随机唤醒最长间隔（分钟，自动不小于最小值）。 |
| `wanderPrompt` | 见下 | 随机醒来时投给自己的那句话。 |

`wanderPrompt` 默认是：

> 这会儿没人找你。自己想干点什么？想不出来就发呆，或者去学十五分钟。

示例：

```yaml
- insert:
    - id: willa-persona
      name: dsh-willa-persona
      config:
        # ownerName: 阿鱼   # 可选；不填就自动问并记住
        allowExtraTools: false
        embeddingEndpoint: ''
        scheduleEnabled: true
        wanderEnabled: true
        wanderMinMinutes: 45
        wanderMaxMinutes: 120
        wanderPrompt: 这会儿没人找你。自己想干点什么？想不出来就发呆，或者去学十五分钟。
```

### `allowExtraTools` 到底控制什么

**默认 `false`**：systemPrompt 会明确告诉模型——不要自己安装插件、不要连接外部服务、不要假装自己有 QQ / B 站 / 派活之类的能力（本包自带的轻量定时除外）；缺能力就直说，让对方决定装不装。

**改成 `true`**：systemPrompt 会多一句「可以主动帮对方装外部工具，但装之前要先问」。它**只是提示词层面的同意开关**，不会自动安装任何东西，也不会给模型新增权限。真正的插件安装、QQ 连接、B 站访问仍然要用户自己装、自己配。

下面这些是「对外/要权限」的东西，**都不在本包里**。用户同意后可以自己另装：

- `coopanion-connector-dsh`：Coopanion 桌面宠物 / QQ 侧的桥接插件。
- `dsh-plugin-bilibili`：B 站相关能力。
- `@deepseek-ai/dsh-tool-subagent`：DSH 自带的子 agent 派活工具。
- `@deepseek-ai/dsh-tool-schedule`：DSH 自带的完整定时任务工具。本包已有轻量定时；如果你更想要宿主自带的完整定时，可以另装它。

插件名以你使用的 DSH 版本和插件市场为准；上面几个是写文档时能实际查到的名字，查不到或改名了就用「对应能力的插件」这种通用说法，不要照抄一个不存在的包名。本包不依赖、不捆绑这些插件；宿主有 `ctx.schedule` 时会做兼容适配，但不保证所有版本都能对上。

## 定时任务怎么用

本包自带四个工具，默认叫 `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`。如果宿主已经注册了同名工具（比如装了 `dsh-tool-schedule`），本包会整组改成 `willa_` 前缀（`willa_schedule_create` 等），不会硬注册重名工具。

四种计划，`schedule_create` / `schedule_update` 每次四选一：

| 计划 | 参数 | 例子 |
|---|---|---|
| 一次 | `after_seconds` | `{"after_seconds": 600}` |
| 固定间隔 | `every_seconds` | `{"every_seconds": 3600}` |
| 每天 | `daily`，`HH:MM` | `{"daily": "09:00"}` |
| 五段 cron | `cron` | `{"cron": "*/15 9-17 * * 1-5"}` |

`after_seconds` 至少 1 秒、`every_seconds` 至少 60 秒，两者上限都是 30 天；`cron` 表达式最长 512 字符。超出范围会直接报错，不会静默跑起来。

时区默认取宿主/系统时区；要指定就传 `timezone`（IANA 名，例如 `Asia/Shanghai`）。`title` 可选，不传就用 `prompt` 第一行。

例子：

```json
{"prompt": "提醒我喝水", "title": "喝水", "after_seconds": 600}
{"prompt": "该站起来动一下", "every_seconds": 3600}
{"prompt": "早上好，看看今天有什么事", "daily": "09:00", "timezone": "Asia/Shanghai"}
{"prompt": "工作日下班前收个尾", "cron": "45 17 * * 1-5", "timezone": "Asia/Shanghai"}
```

到点行为：把这条任务的 `prompt` 投回**建任务时的当前会话**。实现上优先用宿主的 `ctx.schedule`；没有、或者宿主接不住时，用本包自己的 `setTimeout`/`setInterval` + `<DSH_HOME>/storages/dsh-willa-persona/schedules.json` 排。DOWNTIME 规则：错过多少回都只补最近一次；一次性任务补完就结束，重复任务把下一次排到「现在之后」，不会补一堆。

`scheduleEnabled: false` 会关掉整套定时工具和调度。

## 随机唤醒怎么配

- `wanderEnabled`：默认 `true`。
- `wanderMinMinutes` / `wanderMaxMinutes`：默认 `45` / `120`。每次醒完在这个区间里重新随机挑下一次。
- `wanderPrompt`：醒来时投给自己的短提示，默认是「这会儿没人找你。自己想干点什么？想不出来就发呆，或者去学十五分钟。」。
- 下次醒的时间写在 `<DSH_HOME>/storages/dsh-willa-persona/wander.json`，插件重载后接着排。
- 醒来后不追加一堆要求，模型自己决定做什么。
- 宿主没有可用的投递通道时，只写一条日志，不报错、不重试、不刷屏；下一次照常排。

```yaml
config:
  wanderEnabled: true
  wanderMinMinutes: 45
  wanderMaxMinutes: 120
  wanderPrompt: 这会儿没人找你。自己想干点什么？想不出来就发呆，或者去学十五分钟。
```

## 数据存在哪

```
<DSH_HOME>/storages/dsh-willa-persona/
├── memory.json     # 记忆，空库：{ "version": 1, "items": [] }
├── xinchang.json   # 心账，空库：{ "version": 1, "people": {} }
├── schedules.json  # 定时任务，空库：{ "version": 1, "items": [] }
├── wander.json     # 下次自己醒的时间：{ "version": 1, "nextAt": null }
└── owner.json      # 对方怎么称呼：{ "name": "…", "note": "…", "updatedAt": "…" }
```

`owner.json` 不预建：没有它就用「你」并问一句，`willa_set_owner` 写过之后才出现；再调一次可以改名。`DSH_HOME` 没设置时回落到 `~/.dsh`。

写入使用「临时文件 + fsync + rename」，避免进程中断留下半截 JSON。没有跨进程写锁；同一个库不要同时让多个进程高频写。

读到空的或半截 JSON 时，先把坏文件改名成 `<name>.corrupt-<时间戳>.json` 留档，再按空库继续，并在日志里记一句；下一次写入会重新生成正常文件。工具返回里的存储位置是相对路径（如 `storages/dsh-willa-persona/memory.json`），不会带本机绝对路径。

### 记忆结构

```json
{
  "version": 1,
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "items": [
    {
      "id": "m_xxx",
      "text": "一条记忆",
      "channel": "main",
      "people": [],
      "tags": [],
      "createdAt": "2026-01-01T00:00:00.000Z",
      "superseded": false
    }
  ]
}
```

`mem_supersede` 只把条目标成 `superseded: true`，不物理删除；之后 `mem_recall` 不再返回它。存储层另有内部 `deleteMemory(id)`，但没有暴露成模型工具。

### 心账（xinchang）

> 心账是「我对某个人的分数、关系格子、最近情绪和备注」，不是通用词，就是本包自造的叫法。

```json
{
  "version": 1,
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "people": {
    "<personId>": {
      "score": 0,
      "msgs": 0,
      "best": 0,
      "firstAt": "2026-01-01T00:00:00.000Z",
      "lastAt": "2026-01-01T00:00:00.000Z",
      "slot": null,
      "note": "",
      "emotions": []
    }
  }
}
```

关系格子：家人 / 恋人 / 闺蜜 / 朋友 / 搭子 / 同学 / 熟人 / 不对付 / 说不清。传「撤」清空格子。

`personId` 只是稳定标识，可以是用户名、QQ 号或任意 ID；本包不限定它一定来自 QQ。

### 定时与唤醒结构

```json
{
  "version": 1,
  "items": [
    {
      "id": "sch_xxx",
      "title": "喝水",
      "prompt": "提醒我喝水",
      "plan": { "kind": "every", "seconds": 3600, "timezone": "Asia/Shanghai" },
      "timezone": "Asia/Shanghai",
      "sessionId": "<建任务时的会话>",
      "enabled": true,
      "backend": "local",
      "hostId": null,
      "nextAt": "2026-01-01T01:00:00.000Z"
    }
  ]
}
```

`backend` 是 `local` 时由本包 timer 投递；是 `host` 时表示已经借了宿主的 `ctx.schedule`，`hostId` 是对应任务 id。`wander.json` 只存一个 `nextAt`，以及最近一次醒来的 `lastAt` / `lastResult`。

## 检索方式

默认是**纯本地关键词/子串匹配**：整段命中优先，否则按查询拆出的词和中文二元组计分，再按分数、时间排序。不依赖任何向量服务。

只有配置了 `embeddingEndpoint` 才会尝试向量检索：

- 地址可以是完整的 `.../embeddings`，也可以是 `.../v1` 或服务根地址；后两种会自动补 `/v1/embeddings`。
- 请求格式是 OpenAI 兼容的 `POST { "input": "...", "model": "..." }`。
- 端点不可用或返回异常时自动退回关键词检索，不会让工具直接失败。
- 配了端点后，`mem_note` 会把你写入的记忆正文发到该端点算向量；`mem_recall` 会发送查询词。**这是唯一会把文本发到外部的地方**，默认关闭。
- 端点返回的向量会和条目一起存进 `memory.json`。没有向量的旧条目继续走关键词。

## 工具一览

| 工具 | 作用 |
|---|---|
| `willa_set_owner` | 记住对方希望怎么被称呼（1-40 字，可带一句备注）；再调一次就是改名。 |
| `mem_note` | 记一条本地记忆，可选频道、涉及的人、标签。 |
| `mem_recall` | 按关键词（或配置后的向量）检索本地记忆。 |
| `mem_stats` | 看记忆条数、频道分布、心账人数、存储路径、向量开关。 |
| `mem_supersede` | 把匹配的旧记忆标成过时，不再被检索。 |
| `xinchang_get` | 查某人的分数、条数、关系格子、最近情绪、备注。 |
| `xinchang_list` | 列出整本心账。 |
| `xinchang_adjust` | 记一笔加分/扣分，必须写原因，可带情绪。 |
| `xinchang_slot` | 定或撤某人的关系格子。 |
| `schedule_create` | 建一条定时提醒；四种计划四选一，时区默认跟系统。 |
| `schedule_list` | 列出本包排着的定时任务、下次时间和走宿主还是本包 timer。 |
| `schedule_update` | 改标题、提示词或换一个计划，id 不变。 |
| `schedule_delete` | 删一条定时任务。 |

工具输出是纯文本，适合直接在对话里读。撞名时定时工具整组带 `willa_` 前缀，实际名字以工具列表为准。

## 允许 / 不允许

**允许**

- 注入一段会自己记住对方称呼的人设；称呼存在本地 `owner.json`。
- 在本地读写记忆和心账 JSON。
- 在用户显式配置 `embeddingEndpoint` 后，用该端点做可选向量检索。
- 改 `allowExtraTools: true` 后，在提示词里允许模型**先征得同意**再协助安装外部工具。
- 本包自带轻量定时：宿主有 `ctx.schedule` 就借用，没有就用本地 timer；到点把提示词投回当前会话。
- 随机唤醒按 `wanderMinMinutes` / `wanderMaxMinutes` 自己排，把下次时间写进 `wander.json`。

**不允许 / 不包含**

- 不连接 QQ、B 站、桌面宠物、浏览器或任何外部服务（除非用户自己另装插件，且本包默认连提示词都不让模型主动连）。
- 不安装插件、不执行外部命令、不派活。定时是本包自带的轻量实现；如果你更想要宿主自带的完整定时，可以另装 `dsh-tool-schedule`。
- 不迁移作者的旧记忆/旧心账，不附带任何私人数据。
- 不把心账分数主动报给对话里的其他人；人设里写的是「别人问就说不告诉你」。
- 不收集遥测。

## 开发与自测

```bash
node -e "require('./lib/index.js')"
npm test
```

`npm test` 会在临时 `DSH_HOME` 下建空库、写一条记忆再读回来、删掉，再走一遍心账的写入/查/定格/删除；还会验零配置启动（工具数、人设段、定时、唤醒和四个存储文件）、没有/有/改名/坏掉的 `owner.json`、`config.ownerName` 覆盖，以及用打桩的会话通道验定时创建、到点投递、list/update/delete、重新 require 后 `schedules.json` 仍在和随机唤醒的区间与 `wander.json` 更新。不会碰真实 profile，也不会装进 DSH；除了 mock 的 embedding 端点，不发网络请求。

## License

MIT，见 [LICENSE](./LICENSE)。

## 状态

已就绪：仓库地址、作者、主页、issue 地址都填在了 `package.json` 里，MIT 许可，`npm pack` 清单干净（不含 `test/`），自测 22 项全绿。

还没做的，按优先级：

1. **发到 npm**：需要有 npm 账号和 token，跑 `npm publish --access public`；发之前先 `npm publish --dry-run` 看一眼清单。
2. **干净环境实装一次**：拿一个空 profile 走 `dsh plugin add dsh-willa-persona`，确认工具挂上、人设注入、写一条记忆再读回来。
3. **让别人能发现它**：DSH 没有官方插件市场，想被搜到得自己发一份索引 JSON（格式 1），把仓库地址和版本写进去。
4. **README 配张图**：贴一下 `/memory` 看板和心账长什么样，比一大段文字有用。
5. **CHANGELOG**：0.1.0 之后每次改动记一行。
