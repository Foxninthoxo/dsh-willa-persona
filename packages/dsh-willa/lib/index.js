/**
 * dsh-willa — 人设库 + 可选 QQ / 记忆 / 状态工具（合并包）。
 *
 * 合并方案见 `partner/plugin-merge-plan.md`。本文件是唯一入口，按 C.4 做**条件挂载**：
 * 两个核心服务走静态 `inject`（原因见下面 inject 的注释）；可选的 webServer 仍
 * 由 persona 模块按需 `ctx.inject`，没有它只少设置页接口。
 *
 * 第二阶段（已完成）：
 *  - 骨架 + config/paths 已就位；
 *  - 人设半侧从旧人设包 0.5.0 迁到 `src/persona/`（MIT，保留原声明，见 NOTICE）；
 *  - willa 那半迁到 `src/willa/`：26 个工具按 D.2 条件注册；`enableWilla` 默认仍 false。
 *
 * 第三阶段（本次）：
 *  - alive 定时器 / OneBot WS 收消息唤醒 / wander 随机自醒 / qzone 轮询全部迁入；
 *  - 每个后台都在 `scope.effect(...)` 里建并返回 cleanup，插件重载不叠加；
 *  - 开关与降级见各模块文件头：aliveEnabled / wakeEnabled / wanderEnabled / qzoneEnabled。
 */
import { Config, resolveConfig } from './config.js'
import { personaStorePathFor } from './paths.js'
import * as persona from './persona/index.js'
import { mountAliveTimer } from './willa/alive-timer.js'
import { mountQzone } from './willa/qzone.js'
import { mountWillaTools } from './willa/tools.js'
import { mountWake } from './willa/wake.js'
import { mountWander } from './willa/wander.js'

export { Config }

/** Cordis 插件名 = 包名；cordis.patch.yml 的 name 必须与它一致。 */
export const name = 'dsh-willa'

/**
 * 静态依赖这两个「核心服务」：`tools`（工具注册表）和 `systemPrompt`（人设段落）。
 *
 * 2026-10-29 真挂载验证纠正了方案 C.4 的一个假设：`inject = []` + apply 里
 * `ctx.inject(['tools'], cb)` 的动态写法，**apply 会跑、工具也注册了（探测能数到
 * 22 个），但 headless 第一轮请求的工具表里一个都没有** —— agent 在插件加载后立刻
 * 组装首轮，动态 inject 的回调晚一拍。两个老包（willa-dsh / 旧人设包）
 * 都是静态 inject + apply 里同步注册，实测可用；这里跟它们保持一致。
 *
 * 代价：没有 tools / systemPrompt 的极简 profile 里整个插件不会激活。DSH 的 base、
 * web、headless 都带这两个服务，所以正常 profile 不受影响；两块各自的开关仍然由
 * enablePersona / enableWilla 控制。可选服务（如 webServer）仍由 persona 模块内部
 * 动态 inject。
 */
export const inject = ['tools', 'systemPrompt']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] 原始配置，缺省全部走 DEFAULTS。
 */
export function apply(ctx, config = {}) {
  const c = resolveConfig(config)

  // 两个核心服务由静态 `inject` 保证；这里只按开关挂，缺服务时给一句日志、不抛。
  // **必须同步挂**：headless 会在插件加载后立刻组装第一轮请求，推到微任务就赶不上。
  if (c.enablePersona) {
    if (!ctx.systemPrompt) log(ctx)?.warn?.('dsh-willa: 没有 systemPrompt 服务，人设半侧跳过')
    else mountPersona(ctx, c)
  }

  if (c.enableWilla) {
    if (!ctx.tools) log(ctx)?.warn?.('dsh-willa: 没有 tools 服务，willa 半侧跳过')
    else mountWilla(ctx, c)
  }
}

/** 把拍平配置翻译成人设模块认识的旧字段（enabled/prefix/suffix/personaFile/order）。 */
function personaConfigOf(c) {
  return {
    enabled: c.enablePersona !== false,
    prefix: typeof c.prefix === 'string' ? c.prefix : '',
    suffix: typeof c.suffix === 'string' ? c.suffix : '',
    personaFile: typeof c.personaFile === 'string' ? c.personaFile : '',
    order: typeof c.order === 'number' ? c.order : undefined,
  }
}

/** 挂人设：提示词段落 + 设置页接口都在 persona.apply 里。 */
function mountPersona(scope, c) {
  // `personaStore` 为空时走 <DSH_HOME>/storages/dsh-willa/personas.json。
  persona.setPersonaStorePath(personaStorePathFor(c))
  persona.apply(scope, personaConfigOf(c))
  log(scope)?.info?.(`dsh-willa: 人设半侧已挂载（store=${personaStorePathFor(c)}）`)
}

// ── willa 半侧 ─────────────────────────────────────────────────────────
// 工具 + 四个后台。后台的开关与降级都在各自模块里判断，这里只负责按顺序挂，
// 每个 mount 用 `scope.effect(...)` 包住自己的定时器 / WS，重载时由 scope 负责清理。

function mountWilla(scope, c) {
  const tools = mountWillaTools(scope, c)
  const started = []
  const mounts = [
    ['alive-timer', mountAliveTimer],
    ['wake', mountWake],
    ['wander', mountWander],
    ['qzone', mountQzone],
  ]

  for (const [label, mount] of mounts) {
    let handle = null
    try {
      handle = mount(scope, c, tools)
    } catch (err) {
      log(scope)?.warn?.(`dsh-willa: ${label} 挂载失败：${err?.message ?? err}`)
      continue
    }
    if (handle?.kind) started.push(handle.kind)
  }

  log(scope)?.info?.(
    `dsh-willa: willa 半侧已挂载（${tools.count} 个工具；后台：${started.join(',') || '无'}）`,
  )
  return { count: tools.count, started }
}

function log(ctx) {
  try {
    if (typeof ctx.logger === 'function') return ctx.logger('dsh-willa')
    return ctx.logger
  } catch {
    return undefined
  }
}
