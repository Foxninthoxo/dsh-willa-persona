/**
 * wander.js —— 随机把自己叫醒，去做点自己想做的事。
 *
 * 搬自旧 willa-dsh `lib/wander.js`。不是提醒、不是待办：隔一段随机时间
 * （默认 45–120 分钟）往会话里塞一句话，让我自己决定干点什么。夜里（默认 0–9 点）
 * 不响，攒到白天第一下。
 *
 * 所有数据路径都走 `paths.js`：
 *   - 爱好：`dataDir/hobbies.json`，退到 `workspaceDir/private/hobbies.json`
 *   - 挂着的事：`dataDir/alive.json`（和 alive.js 同一份）
 *
 * 清理语义：整个 setTimeout 链在 `scope.effect(...)` 里启动，cleanup 调 `stop()`，
 * 重载时旧链被 clearTimeout，不会两条一起醒。
 *
 * 开关：`wanderEnabled`。
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { dataDir, workspaceDir } from '../paths.js'
import { loggerFor } from './util.js'

function loadHobbies(files) {
  for (const file of files) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(j.items)) return j.items.filter((x) => x && x.text)
    } catch {
      /* 换下一个候选 */
    }
  }
  return []
}

function loadOpenTodos(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return (j.items || []).filter((x) => x && !x.doneAt && x.text)
  } catch {
    return []
  }
}

/** 随机唤醒时说什么：按权重挑一条，措辞也随机，不要每次都一个腔调。 */
const OPEN = [
  '这会儿没人找你。',
  '安静着呢。',
  '没人喊你。',
  '空下来了。',
  '屋子里挺静的。',
  '这会儿没活。',
  '没有新消息。',
]
const HOBBY = [
  (h) => `你有个爱好：${h}。想不想去动一下？`,
  (h) => `要不要去做点自己喜欢的？${h}。`,
  (h) => `闲着也是闲着，${h}？`,
  (h) => `今天还没碰这个吧——${h}。`,
  (h) => `想看点什么就去看：${h}。`,
  (h) => `不干活的那种，${h}，去吗？`,
]
const TODO = [
  (x) => `手头还记着「${x}」，要不要瞄一眼？`,
  (x) => `有个事没完：「${x}」。想动就动，不想动就放着。`,
  (x) => `「${x}」还挂着，去看看？`,
  (x) => `要是还有点劲，${x} 可以推进一下。`,
]
const IDLE = [
  '想不出来就发会儿呆。',
  '什么都不干也行。',
  '发呆、听听动静，都好。',
  '躺会儿，别硬找事做。',
  '或者去学十五分钟。',
  '想睡就眯一会儿。',
]
const TAIL = ['', '不用回我。', '自己安排。', '随便。', '']

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** 随机挑一句；`fallback` 是用户配的保底话术。 */
export function pickPrompt(fallback, files = {}) {
  const hobbies = loadHobbies(files.hobbies ?? [])
  const todos = loadOpenTodos(files.alive ?? '')
  const parts = [pick(OPEN)]

  const roll = Math.random()
  if (roll < 0.5 && hobbies.length) {
    parts.push(pick(HOBBY)(String(pick(hobbies).text)))
  } else if (roll < 0.8 && todos.length) {
    parts.push(pick(TODO)(String(pick(todos).text).slice(0, 40)))
  } else if (hobbies.length && Math.random() < 0.3) {
    parts.push(pick(HOBBY)(String(pick(hobbies).text)))
  } else {
    parts.push(pick(IDLE))
  }

  if (Math.random() < 0.45) parts.push(pick(IDLE))
  if (Math.random() < 0.4) parts.push(pick(TAIL))

  const text = parts.filter(Boolean).join('')
  if (Math.random() < 0.06) return fallback
  return text.length >= 10 ? text : parts.concat(pick(IDLE)).filter(Boolean).join('')
}

/**
 * 起一条随机唤醒链。返回 `{ stop() }`。
 *
 * @param {object} options
 * @param {(text: string) => Promise<any>} options.inject 往会话塞一句话
 * @param {(msg: string) => void} [options.log]
 * @param {object} [options.config] minMinutes / maxMinutes / quietFrom / quietTo / prompt
 * @param {{ hobbies?: string[], alive?: string }} [options.files]
 */
export function startWander({ inject, log = () => {}, config = {}, files = {} }) {
  const minMs = Math.max(5, Number(config.minMinutes ?? 45)) * 60_000
  const maxMs = Math.max(minMs, Number(config.maxMinutes ?? 120) * 60_000)
  const quietFrom = Number(config.quietFrom ?? 0)
  const quietTo = Number(config.quietTo ?? 9)
  const prompt =
    config.prompt ||
    '这会儿没人找你。你自己想干点什么？想不出来就发会儿呆，或者去学十五分钟。'

  let timer = null
  let stopped = false

  const inQuiet = () => {
    const h = new Date().getHours()
    if (quietFrom === quietTo) return false
    return quietFrom < quietTo ? h >= quietFrom && h < quietTo : h >= quietFrom || h < quietTo
  }

  const nextDelay = () => {
    if (!inQuiet()) return minMs + Math.random() * (maxMs - minMs)
    // 静默时段：算到静默结束那一刻（加一点随机）。
    const now = new Date()
    const end = new Date(now)
    end.setHours(quietTo, 0, 0, 0)
    if (end <= now) end.setDate(end.getDate() + 1)
    return end.getTime() - now.getTime() + Math.random() * 5 * 60_000
  }

  const arm = () => {
    if (stopped) return
    const delay = nextDelay()
    const at = new Date(Date.now() + delay)
    log(
      `下次自己醒：${at.toLocaleString('zh-CN', { hour12: false })}（${Math.round(delay / 60000)} 分钟后）`,
    )
    timer = setTimeout(async () => {
      if (stopped) return
      try {
        await inject(pickPrompt(prompt, files))
        log('自己把自己叫醒了')
      } catch (err) {
        log('叫醒失败：' + (err?.message ?? String(err)))
      }
      arm()
    }, delay)
    timer.unref?.()
  }

  arm()
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

/**
 * 挂随机自唤醒。返回 `{ kind: 'wander' }`，开关没开返回 null。
 *
 * @param {object} scope cordis scope
 * @param {object} c 解析后的配置
 * @param {{ session?: object }} tools mountWillaTools() 的返回值
 */
export function mountWander(scope, c, tools) {
  if (c.wanderEnabled !== true) return null
  const session = tools?.session
  if (!session) return null
  const log = loggerFor(scope)
  const files = {
    hobbies: [join(dataDir(c), 'hobbies.json'), join(workspaceDir(c), 'private', 'hobbies.json')],
    alive: join(dataDir(c), 'alive.json'),
  }

  scope.effect(() => {
    const w = startWander({
      config: {
        minMinutes: c.wanderMinMinutes,
        maxMinutes: c.wanderMaxMinutes,
        quietFrom: c.wanderQuietFrom,
        quietTo: c.wanderQuietTo,
        prompt: c.wanderPrompt,
      },
      files,
      log: (msg) => log?.info?.(msg),
      inject: (text) => session.inject(text),
    })
    return () => w.stop()
  })

  log?.info?.(
    `wander 已启动（${Number(c.wanderMinMinutes)}–${Number(c.wanderMaxMinutes)} 分钟，` +
      `静默 ${Number(c.wanderQuietFrom)}–${Number(c.wanderQuietTo)} 点）`,
  )
  return { kind: 'wander' }
}
