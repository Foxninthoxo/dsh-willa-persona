/**
 * alive-timer.js —— 每分钟看一眼「心里记着的事」有没有到点。
 *
 * 搬自旧 willa-dsh `lib/index.js` 的 alive 定时器段（每 60 秒 takeDue → inject）。
 * 数据仍由 `alive.js` 管（`dataDir(c)/alive.json`），这里只负责叫醒。
 *
 * 清理语义：定时器包在 `scope.effect(() => { ...; return () => clearInterval(t) })` 里。
 * 插件重载时旧 scope 被 dispose，cleanup 一定会跑到，不会两份定时器叠着叫。
 *
 * 开关：`aliveEnabled`（默认 true）。
 */
import { loggerFor } from './util.js'

/** 提醒检查间隔：60 秒（旧实现同值）。 */
export const ALIVE_TICK_MS = 60_000

/**
 * @param {object} scope cordis scope（已经 inject 过 tools）
 * @param {object} c 解析后的配置
 * @param {{ alive?: object, session?: object }} tools mountWillaTools() 的返回值
 * @returns {{ kind: string } | null} 没挂就返回 null
 */
export function mountAliveTimer(scope, c, tools) {
  if (c.aliveEnabled !== true) return null
  const alive = tools?.alive
  const session = tools?.session
  if (!alive || !session) return null

  const log = loggerFor(scope)

  scope.effect(() => {
    const timer = setInterval(async () => {
      let due = []
      try {
        due = alive.takeDue()
      } catch (err) {
        log?.warn?.(`alive 检查失败：${err?.message ?? err}`)
        return
      }
      if (!Array.isArray(due) || due.length === 0) return

      for (const it of due) {
        const line =
          `你自己记着的事到点了：${it.text}（当时为什么记它：${it.why}）。` +
          '做不做还是你定；不想做就 alive_drop 放掉。'
        try {
          await session.inject(line)
          log?.info?.(`alive 叫醒：${it.id}`)
        } catch (err) {
          log?.warn?.(`alive 叫醒失败（${it.id}）：${err?.message ?? err}`)
        }
      }
    }, ALIVE_TICK_MS)
    // 定时器不该拦住进程退出（headless 一次性会话尤其明显）。
    timer.unref?.()
    return () => clearInterval(timer)
  })

  log?.info?.('alive 定时器已启动（每 60 秒检查一次）')
  return { kind: 'alive' }
}
