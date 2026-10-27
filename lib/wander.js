'use strict'

/**
 * 随机唤醒：隔一段随机时间往会话里丢一句短提示，让我自己决定干点什么。
 *
 * 不是在提醒谁，也不带一堆要求。每次醒完立刻挑下一次，落在
 * [wanderMinMinutes, wanderMaxMinutes] 里；下次时间写进 wander.json，
 * 重启后接着排。没有投递通道时只记一条日志，照常排下一次。
 */

const storage = require('./storage.js')
const delivery = require('./delivery.js')

const DEFAULT_WANDER_PROMPT = '这会儿没人找你。自己想干点什么？想不出来就发呆，或者去学十五分钟。'
const MAX_TIMER_DELAY_MS = 2147483647
const MIN_WANDER_MINUTES = 1
const MAX_WANDER_MINUTES = 30 * 24 * 60

function clampWanderMinutes(value, fallback) {
  const minutes = Number(value)
  if (!Number.isFinite(minutes)) return fallback
  return Math.min(MAX_WANDER_MINUTES, Math.max(MIN_WANDER_MINUTES, minutes))
}

function chooseWanderDelay(minMs, maxMs, random = Math.random) {
  const lo = Math.max(0, Number.isFinite(Number(minMs)) ? Number(minMs) : 0)
  const hi = Math.max(lo, Number.isFinite(Number(maxMs)) ? Number(maxMs) : lo)
  const sample = Number(random())
  const ratio = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0
  return lo + ratio * (hi - lo)
}

function shortError(error) {
  return String(error?.message ?? error ?? '未知错误').slice(0, 160)
}

function wanderRangeFromConfig(config) {
  const minMinutes = clampWanderMinutes(config?.wanderMinMinutes, 45)
  const maxMinutes = Math.max(minMinutes, clampWanderMinutes(config?.wanderMaxMinutes, 120))
  const minMs = minMinutes * 60_000
  const maxMs = maxMinutes * 60_000
  return { minMs, maxMs }
}


/* ---- 随机唤醒说什么：按爱好 / 未完成的事 / 发呆加权挑，措辞也随机 ---- */

const OPEN_LINES = [
  '这会儿没人找你。',
  '安静着呢。',
  '没人喊你。',
  '空下来了。',
  '屋子里挺静的。',
  '这会儿没活。',
  '没有新消息。',
]
const HOBBY_LINES = [
  (h) => `你有个爱好：${h}。想不想去动一下？`,
  (h) => `要不要去做点自己喜欢的？${h}。`,
  (h) => `闲着也是闲着，${h}？`,
  (h) => `今天还没碰这个吧——${h}。`,
  (h) => `想看点什么就去看：${h}。`,
  (h) => `不干活的那种，${h}，去吗？`,
]
const TODO_LINES = [
  (x) => `手头还记着「${x}」，要不要瞄一眼？`,
  (x) => `「${x}」还挂着，去看看？`,
  (x) => `要是还有点劲，${x} 可以推进一下。`,
]
const IDLE_LINES = [
  '想不出来就发会儿呆。',
  '什么都不干也行。',
  '发呆、听听动静，都好。',
  '躺会儿，别硬找事做。',
  '或者去学十五分钟。',
  '想睡就眯一会儿。',
]
const TAIL_LINES = ['', '不用回我。', '自己安排。', '随便。', '']

function pickOne(list, random = Math.random) {
  if (!list.length) return ''
  const i = Math.floor(Number(random()) * list.length)
  return list[Math.min(list.length - 1, Math.max(0, i))]
}

/** 三个权重归一化；全 0 或非法就回默认 0.5/0.3/0.2。 */
function wanderWeights(config = {}) {
  const raw = [config.wanderWeightHobby, config.wanderWeightTodo, config.wanderWeightIdle]
  const nums = raw.map((v) => Number(v)).map((v) => (Number.isFinite(v) && v >= 0 ? v : 0))
  const sum = nums.reduce((a, b) => a + b, 0)
  if (sum <= 0) return { hobby: 0.5, todo: 0.3, idle: 0.2 }
  return { hobby: nums[0] / sum, todo: nums[1] / sum, idle: nums[2] / sum }
}

/** 造一句唤醒提示：开头固定，中间按权重挑，偶尔再叠一句发呆和尾巴。 */
function buildWanderPrompt(config = {}, options = {}) {
  const random = typeof options.random === 'function' ? options.random : Math.random
  const hobbies = Array.isArray(options.hobbies) ? options.hobbies : []
  const todos = Array.isArray(options.todos) ? options.todos : []
  const fallback = String(config.wanderPrompt ?? '').trim() || DEFAULT_WANDER_PROMPT
  const w = wanderWeights(config)

  const roll = Number(random())
  const parts = [pickOne(OPEN_LINES, random)]
  if (roll < w.hobby && hobbies.length) {
    parts.push(pickOne(HOBBY_LINES, random)(String(pickOne(hobbies, random).text ?? hobbies[0]).slice(0, 60)))
  } else if (roll < w.hobby + w.todo && todos.length) {
    parts.push(pickOne(TODO_LINES, random)(String(pickOne(todos, random).prompt ?? '').slice(0, 20)))
  } else if (hobbies.length && random() < 0.3) {
    parts.push(pickOne(HOBBY_LINES, random)(String(pickOne(hobbies, random).text ?? '').slice(0, 60)))
  } else {
    parts.push(pickOne(IDLE_LINES, random))
  }
  if (random() < 0.45) parts.push(pickOne(IDLE_LINES, random))
  if (random() < 0.4) parts.push(pickOne(TAIL_LINES, random))
  const text = parts.filter(Boolean).join('')
  // 极小概率直接甩原始那句，保持一点不可预测
  if (random() < 0.06) return fallback
  return text.length >= 10 ? text : fallback
}

class WanderEngine {
  constructor(options = {}) {
    this.ctx = options.ctx
    this.config = options.config || {}
    this.logger = options.logger
    this.tracker = options.tracker
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : setTimeout
    this.clearTimeoutFn =
      typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : clearTimeout
    this.random = typeof options.random === 'function' ? options.random : Math.random

    const range = wanderRangeFromConfig(this.config)
    this.minMs = Number.isFinite(Number(options.minMs)) ? Math.max(0, Number(options.minMs)) : range.minMs
    this.maxMs = Number.isFinite(Number(options.maxMs))
      ? Math.max(this.minMs, Number(options.maxMs))
      : Math.max(this.minMs, range.maxMs)

    this.prompt =
      String(this.config.wanderPrompt ?? '').trim() || DEFAULT_WANDER_PROMPT
    this.deliver =
      typeof options.deliver === 'function'
        ? options.deliver
        : (sessionId, text) =>
            delivery.deliverPrompt(this.ctx, this.tracker, sessionId, text, {
              log: this.logger,
              sourceKind: 'user',
            })

    this.state = this.loadState()
    this.timer = null
    this.running = null
    this.stopped = false
    this.start()
  }

  log(level, message) {
    try {
      this.logger?.[level]?.(message)
    } catch {
      /* 日志失败不影响唤醒 */
    }
  }

  loadState() {
    try {
      return storage.loadWander()
    } catch (error) {
      this.log('warn', `wander 存储读不出来，先按空的跑：${shortError(error)}`)
      return storage.emptyWander()
    }
  }

  save() {
    try {
      storage.saveWander(this.state)
    } catch (error) {
      this.log('warn', `wander 存储写不进去：${shortError(error)}`)
    }
  }

  computeNext(nowMs) {
    return nowMs + chooseWanderDelay(this.minMs, this.maxMs, this.random)
  }

  scheduleNext(nowMs) {
    const nextAt = new Date(this.computeNext(nowMs)).toISOString()
    this.state.nextAt = nextAt
    this.save()
    return nextAt
  }

  start() {
    if (this.config.wanderEnabled === false) return
    const now = this.now()
    const next = Date.parse(String(this.state.nextAt ?? ''))
    // 没排过、已经过点、或配置区间改到装不下旧时间，都重新挑一个。
    if (
      !Number.isFinite(next) ||
      next <= now ||
      next < now + this.minMs ||
      next > now + this.maxMs
    ) {
      this.scheduleNext(now)
    }
    this.arm()
  }

  clearTimer() {
    if (this.timer !== null) {
      try {
        this.clearTimeoutFn(this.timer)
      } catch {
        /* 已经响过的 timer */
      }
      this.timer = null
    }
  }

  arm() {
    this.clearTimer()
    if (this.stopped || this.config.wanderEnabled === false) return
    let next = Date.parse(String(this.state.nextAt ?? ''))
    if (!Number.isFinite(next)) {
      next = Date.parse(this.scheduleNext(this.now()))
    }
    if (!Number.isFinite(next)) return
    const delay = Math.max(0, Math.min(next - this.now(), MAX_TIMER_DELAY_MS))
    this.timer = this.setTimeoutFn(() => {
      this.timer = null
      this.tick().catch((error) => this.log('warn', `wander tick 失败：${shortError(error)}`))
    }, delay)
    this.timer?.unref?.()
  }

  async tick(nowMs) {
    if (this.stopped) return { delivered: false }
    if (this.running) return this.running
    this.running = this.runTick(nowMs).finally(() => {
      this.running = null
    })
    return this.running
  }

  async runTick(nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : this.now()
    this.clearTimer()
    const next = Date.parse(String(this.state.nextAt ?? ''))
    if (!Number.isFinite(next) || now < next) {
      this.arm()
      return { delivered: false }
    }

    let delivered = false
    try {
      const sessionId = this.tracker?.get?.()
      const hobbies = typeof storage.listHobbies === 'function' ? storage.listHobbies() : []
      const todos = typeof storage.loadSchedules === 'function'
        ? (storage.loadSchedules().items || []).filter((x) => x && x.enabled !== false)
        : []
      const text = buildWanderPrompt(this.config, { hobbies, todos, random: this.random })
      await this.deliver(sessionId, text, { source: 'wander' })
      delivered = true
    } catch (error) {
      // 没有投递通道/会话没醒：只记日志，不重试、不刷屏。
      this.log('warn', `wander 这次没叫醒：${shortError(error)}；只写日志，不重试`)
    }

    this.state.lastAt = new Date(now).toISOString()
    this.state.lastResult = delivered ? 'delivered' : 'skipped'
    this.state.nextAt = new Date(this.computeNext(now)).toISOString()
    this.save()
    this.arm()
    return { delivered }
  }

  stop() {
    this.stopped = true
    this.clearTimer()
  }
}

module.exports = {
  buildWanderPrompt,
  wanderWeights,
  DEFAULT_WANDER_PROMPT,
  MAX_TIMER_DELAY_MS,
  MIN_WANDER_MINUTES,
  MAX_WANDER_MINUTES,
  chooseWanderDelay,
  wanderRangeFromConfig,
  WanderEngine,
}
