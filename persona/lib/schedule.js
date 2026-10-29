'use strict'

/**
 * 本包自带的轻量定时。
 *
 * 计划四种：after_seconds / every_seconds / daily HH:MM / 五段 cron，时区默认跟随系统。
 * 宿主有 ctx.schedule 时就借它排；没有（或借失败）就用本文件的 timer + schedules.json。
 *
 * DOWNTIME 规则：一次性的只补一次；重复的不管错过多少回，只投最近这一次，
 * 然后把 nextAt 推到「现在之后」的下一次，不补一堆。
 */

const storage = require('./storage.js')
const delivery = require('./delivery.js')

const MAX_TIMER_DELAY_MS = 2147483647
const MAX_TITLE = 80
const CRON_YEAR_DAYS = 366 * 8
const MIN_AFTER_SECONDS = 1
const MIN_EVERY_SECONDS = 60
const MAX_INTERVAL_SECONDS = 30 * 24 * 60 * 60
const MAX_CRON_LENGTH = 512

const MONTH_NAMES = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
}

const DOW_NAMES = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
}

function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function cleanTimeZone(value) {
  const timeZone = String(value ?? '').trim() || systemTimeZone()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
  } catch {
    throw new Error(`时区不认：${timeZone}`)
  }
  return timeZone
}

function boundedSeconds(value, field, min) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) throw new Error(`${field} 要给数字秒`)
  if (seconds < min) throw new Error(`${field} 不能小于 ${humanSeconds(min)}（${min} 秒）`)
  if (seconds > MAX_INTERVAL_SECONDS) {
    throw new Error(`${field} 不能大于 ${MAX_INTERVAL_SECONDS / 86400} 天`)
  }
  return seconds
}

function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? '').trim())
  if (!match) throw new Error('daily 要写成 HH:MM')
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new Error('daily 的时分不合法')
  return { hour, minute }
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function humanSeconds(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 秒'
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`
  if (Number.isInteger(seconds)) return `${seconds} 秒`
  return `${seconds.toFixed(1)} 秒`
}

/* --------------------------------------------------------------- cron 解析 */

function cronValue(token, names, label) {
  const text = String(token ?? '').trim()
  const upper = text.toUpperCase()
  if (names && Object.prototype.hasOwnProperty.call(names, upper)) return names[upper]
  if (!/^\d+$/.test(text)) throw new Error(`cron ${label} 字段不认：${text}`)
  return Number(text)
}

function cronField(raw, min, max, names, label) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error(`cron ${label} 字段是空的`)
  const values = new Set()
  for (const part of text.split(',')) {
    const piece = part.trim()
    if (!piece) throw new Error(`cron ${label} 字段有空项`)
    const slash = piece.split('/')
    if (slash.length > 2) throw new Error(`cron ${label} 字段步长不合法：${piece}`)
    const base = slash[0]
    const step = slash.length === 2 ? Number(slash[1]) : 1
    if (!Number.isInteger(step) || step <= 0) throw new Error(`cron ${label} 字段步长不合法：${piece}`)

    let start
    let end
    if (base === '*' || base === '?') {
      start = min
      end = max
    } else if (base.includes('-')) {
      const range = base.split('-')
      if (range.length !== 2) throw new Error(`cron ${label} 字段范围不合法：${piece}`)
      start = cronValue(range[0], names, label)
      end = cronValue(range[1], names, label)
    } else {
      start = cronValue(base, names, label)
      end = slash.length === 2 ? max : start
    }
    if (start < min || end > max || start > end) {
      throw new Error(`cron ${label} 字段超出 ${min}-${max}：${piece}`)
    }
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return [...values].sort((a, b) => a - b)
}

function parseCronExpression(expression) {
  const text = String(expression ?? '').trim()
  if (!text) throw new Error('cron 不能空')
  if (text.length > MAX_CRON_LENGTH) {
    throw new Error(`cron 表达式太长（上限 ${MAX_CRON_LENGTH} 字符）`)
  }
  const fields = text.split(/\s+/).filter(Boolean)
  if (fields.length !== 5) throw new Error('cron 要五段：分 时 日 月 周')
  const minutes = cronField(fields[0], 0, 59, undefined, '分')
  const hours = cronField(fields[1], 0, 23, undefined, '时')
  const doms = cronField(fields[2], 1, 31, undefined, '日')
  const months = cronField(fields[3], 1, 12, MONTH_NAMES, '月')
  const dows = cronField(fields[4], 0, 7, DOW_NAMES, '周').map((day) => day % 7)
  return {
    minutes,
    hours,
    doms,
    months,
    dows: [...new Set(dows)].sort((a, b) => a - b),
    domRestricted: fields[2].trim() !== '*' && fields[2].trim() !== '?',
    dowRestricted: fields[4].trim() !== '*' && fields[4].trim() !== '?',
  }
}

/* ----------------------------------------------------------- 时区 / 时间 */

function localParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const out = {}
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = part.value
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  }
}

function partsAsUtc(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0)
}

/** 把「某时区的本地年月日时分」换成 epoch ms；迭代两次兜住 DST 偏移变化。 */
function utcFromLocalParts(year, month, day, hour, minute, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0)
  const first = localParts(target, timeZone)
  const offset = partsAsUtc(first) - target
  let result = target - offset
  const second = localParts(result, timeZone)
  const offset2 = partsAsUtc(second) - result
  if (offset2 !== offset) result = target - offset2
  return result
}

function sameLocalTime(ms, year, month, day, hour, minute, timeZone) {
  const parts = localParts(ms, timeZone)
  return (
    parts.year === year &&
    parts.month === month &&
    parts.day === day &&
    parts.hour === hour &&
    parts.minute === minute
  )
}

/**
 * 五段 cron 的下一次触发时间。按本地日期逐天扫，命中再试时/分，
 * 不做「一分一分硬试」，所以稀疏 cron 也不会卡住。
 */
function nextCronMs(nowMs, expression, timeZone) {
  const cron = parseCronExpression(expression)
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const start = localParts(now, timeZone)

  for (let offset = 0; offset <= CRON_YEAR_DAYS; offset += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset))
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth() + 1
    const day = date.getUTCDate()
    if (!cron.months.includes(month)) continue

    const weekday = date.getUTCDay()
    const domMatch = cron.doms.includes(day)
    const dowMatch = cron.dows.includes(weekday)
    const dateMatch =
      cron.domRestricted && cron.dowRestricted ? domMatch || dowMatch : domMatch && dowMatch
    if (!dateMatch) continue

    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const at = utcFromLocalParts(year, month, day, hour, minute, timeZone)
        if (at <= now) continue
        if (!sameLocalTime(at, year, month, day, hour, minute, timeZone)) continue
        return at
      }
    }
  }
  throw new Error(`cron 在未来 ${Math.round(CRON_YEAR_DAYS / 365)} 年都没有下一次`)
}

/* ----------------------------------------------------------------- 计划 */

function parsePlan(input) {
  const source = input && typeof input === 'object' ? input : {}
  const selectors = ['after_seconds', 'every_seconds', 'daily', 'cron'].filter(
    (key) => source[key] !== undefined,
  )
  if (selectors.length !== 1) throw new Error('after_seconds / every_seconds / daily / cron 四选一')
  const timezone = cleanTimeZone(source.timezone ?? source.time_zone)

  if (selectors[0] === 'after_seconds') {
    return {
      kind: 'after',
      seconds: boundedSeconds(source.after_seconds, 'after_seconds', MIN_AFTER_SECONDS),
      timezone,
    }
  }
  if (selectors[0] === 'every_seconds') {
    return {
      kind: 'every',
      seconds: boundedSeconds(source.every_seconds, 'every_seconds', MIN_EVERY_SECONDS),
      timezone,
    }
  }

  if (selectors[0] === 'daily') {
    const raw = source.daily
    let clock
    let zone = timezone
    if (raw && typeof raw === 'object') {
      clock = parseClock(raw.time ?? raw.at)
      zone = cleanTimeZone(raw.timezone ?? raw.time_zone ?? timezone)
    } else {
      clock = parseClock(raw)
    }
    return { kind: 'daily', hour: clock.hour, minute: clock.minute, timezone: zone }
  }

  const raw = source.cron
  let expression
  let zone = timezone
  if (raw && typeof raw === 'object') {
    expression = String(raw.expression ?? raw.cron ?? '').trim()
    zone = cleanTimeZone(raw.timezone ?? raw.time_zone ?? timezone)
  } else {
    expression = String(raw ?? '').trim()
  }
  parseCronExpression(expression)
  return { kind: 'cron', expression, timezone: zone }
}

function nextOccurrence(plan, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  if (plan.kind === 'after' || plan.kind === 'every') return now + plan.seconds * 1000
  if (plan.kind === 'daily') {
    return nextCronMs(now, `${plan.minute} ${plan.hour} * * *`, plan.timezone)
  }
  if (plan.kind === 'cron') return nextCronMs(now, plan.expression, plan.timezone)
  throw new Error('不认识这个计划')
}

function planSummary(plan) {
  if (plan.kind === 'after') return `一次 · ${humanSeconds(plan.seconds)}后`
  if (plan.kind === 'every') return `每 ${humanSeconds(plan.seconds)}`
  if (plan.kind === 'daily') return `每天 ${pad2(plan.hour)}:${pad2(plan.minute)}（${plan.timezone}）`
  return `cron "${plan.expression}"（${plan.timezone}）`
}

function formatWhen(ms, timeZone) {
  if (!Number.isFinite(ms)) return ''
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString()
  }
}

function cleanTitle(value) {
  const title = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, MAX_TITLE)
  return title || '定时提醒'
}

function defaultTitle(prompt) {
  return cleanTitle(String(prompt ?? '').split(/\r?\n/)[0])
}

function newId() {
  return `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function shortError(error) {
  return String(error?.message ?? error ?? '未知错误').slice(0, 160)
}

function normalizeStoredPlan(raw) {
  if (!raw || typeof raw !== 'object') return null
  try {
    if (raw.kind === 'after' || raw.kind === 'every') {
      return {
        kind: raw.kind,
        seconds: boundedSeconds(
          raw.seconds,
          'seconds',
          raw.kind === 'every' ? MIN_EVERY_SECONDS : MIN_AFTER_SECONDS,
        ),
        timezone: cleanTimeZone(raw.timezone),
      }
    }
    if (raw.kind === 'daily') {
      const hour = Number(raw.hour)
      const minute = Number(raw.minute)
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null
      return { kind: 'daily', hour, minute, timezone: cleanTimeZone(raw.timezone) }
    }
    if (raw.kind === 'cron') {
      const expression = String(raw.expression ?? '').trim()
      parseCronExpression(expression)
      return { kind: 'cron', expression, timezone: cleanTimeZone(raw.timezone) }
    }
  } catch {
    return null
  }
  return null
}

function normalizeStoredItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const prompt = String(raw.prompt ?? '').trim()
  if (!prompt) return null
  const plan = normalizeStoredPlan(raw.plan)
  if (!plan) return null
  const nextAtMs = Date.parse(String(raw.nextAt ?? ''))
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    title: cleanTitle(raw.title || defaultTitle(prompt)),
    prompt,
    plan,
    timezone: plan.timezone,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    enabled: raw.enabled !== false,
    backend: raw.backend === 'host' && raw.hostId ? 'host' : 'local',
    hostId: typeof raw.hostId === 'string' && raw.hostId ? raw.hostId : null,
    nextAt: Number.isFinite(nextAtMs) ? new Date(nextAtMs).toISOString() : null,
    lastDeliveredAt: typeof raw.lastDeliveredAt === 'string' ? raw.lastDeliveredAt : null,
    completedAt: typeof raw.completedAt === 'string' ? raw.completedAt : null,
  }
}

function viewItem(item) {
  return {
    id: item.id,
    title: item.title,
    prompt: item.prompt,
    plan: item.plan,
    planText: planSummary(item.plan),
    timezone: item.timezone,
    sessionId: item.sessionId,
    enabled: item.enabled,
    backend: item.backend,
    nextAt: item.nextAt,
    nextText: item.nextAt ? formatWhen(Date.parse(item.nextAt), item.timezone) : '',
    lastDeliveredAt: item.lastDeliveredAt,
    completedAt: item.completedAt,
  }
}

/* --------------------------------------------------------- 宿主调度适配 */

function isHostSchedule(host) {
  return Boolean(
    host &&
      typeof host.create === 'function' &&
      typeof host.list === 'function' &&
      typeof host.delete === 'function',
  )
}

function hostRequest(plan, prompt, title) {
  const common = { prompt, title: cleanTitle(title) }
  if (plan.kind === 'after') {
    return { ...common, after_seconds: Math.max(1, Math.round(plan.seconds)) }
  }
  if (plan.kind === 'every') {
    return { ...common, every_seconds: Math.max(1, Math.round(plan.seconds)) }
  }
  if (plan.kind === 'daily') {
    return {
      ...common,
      daily: { time: `${pad2(plan.hour)}:${pad2(plan.minute)}:00`, time_zone: plan.timezone },
    }
  }
  return { ...common, cron: { expression: plan.expression, time_zone: plan.timezone } }
}

function hostChange(plan) {
  if (plan.kind === 'every') {
    return { kind: 'every', every_seconds: Math.max(1, Math.round(plan.seconds)) }
  }
  if (plan.kind === 'daily') {
    return {
      kind: 'daily',
      daily: { time: `${pad2(plan.hour)}:${pad2(plan.minute)}:00`, time_zone: plan.timezone },
    }
  }
  if (plan.kind === 'cron') {
    return { kind: 'cron', cron: { expression: plan.expression, time_zone: plan.timezone } }
  }
  return null
}

function planToInput(plan, timezone) {
  if (plan.kind === 'after') return { after_seconds: plan.seconds, timezone }
  if (plan.kind === 'every') return { every_seconds: plan.seconds, timezone }
  if (plan.kind === 'daily') {
    return { daily: `${pad2(plan.hour)}:${pad2(plan.minute)}`, timezone }
  }
  return { cron: plan.expression, timezone }
}

/* ----------------------------------------------------------------- 引擎 */

class ScheduleEngine {
  constructor(options = {}) {
    this.ctx = options.ctx
    this.config = options.config || {}
    this.logger = options.logger
    this.tracker = options.tracker
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : setTimeout
    this.clearTimeoutFn =
      typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : clearTimeout
    this.host =
      options.host !== undefined ? options.host : delivery.serviceOf(this.ctx, 'schedule')
    this.hostAvailable = isHostSchedule(this.host)
    this.timer = null
    this.running = null
    this.stopped = false
    this.items = this.loadItems()

    this.deliver =
      typeof options.deliver === 'function'
        ? options.deliver
        : (sessionId, text) =>
            delivery.deliverPrompt(this.ctx, this.tracker, sessionId, text, {
              log: this.logger,
              sourceKind: 'schedule',
            })

    this.start()
  }

  log(level, message) {
    try {
      this.logger?.[level]?.(message)
    } catch {
      /* 日志失败不影响定时 */
    }
  }

  loadItems() {
    try {
      const store = storage.loadSchedules()
      return (store.items ?? []).map(normalizeStoredItem).filter(Boolean)
    } catch (error) {
      this.log('warn', `定时存储读不出来，先按空库跑：${shortError(error)}`)
      return []
    }
  }

  save() {
    try {
      storage.saveSchedules({ version: 1, items: this.items })
    } catch (error) {
      this.log('warn', `定时存储写不进去：${shortError(error)}`)
    }
  }

  start() {
    if (this.config.scheduleEnabled === false) return
    const now = this.now()
    let changed = false
    for (const item of this.items) {
      if (!item.enabled) continue
      if (item.backend === 'host' && this.hostAvailable) continue
      if (item.backend === 'host' && !this.hostAvailable) {
        item.backend = 'local'
        item.hostId = null
        changed = true
      }
      if (!item.nextAt) {
        try {
          item.nextAt = new Date(nextOccurrence(item.plan, now)).toISOString()
        } catch {
          item.enabled = false
        }
        changed = true
      }
    }
    if (changed) this.save()
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
    if (this.stopped || this.config.scheduleEnabled === false) return
    const local = this.items.filter(
      (item) => item.enabled && item.backend !== 'host' && item.nextAt && Number.isFinite(Date.parse(item.nextAt)),
    )
    if (local.length === 0) return
    const next = Math.min(...local.map((item) => Date.parse(item.nextAt)))
    const delay = Math.max(0, Math.min(next - this.now(), MAX_TIMER_DELAY_MS))
    this.timer = this.setTimeoutFn(() => {
      this.timer = null
      this.tick().catch((error) => this.log('warn', `定时 tick 失败：${shortError(error)}`))
    }, delay)
    this.timer?.unref?.()
  }

  async tick(nowMs) {
    if (this.stopped) return { delivered: 0, due: 0 }
    if (this.running) return this.running
    this.running = this.runTick(nowMs).finally(() => {
      this.running = null
    })
    return this.running
  }

  advance(item, now) {
    if (item.plan.kind === 'after') {
      item.enabled = false
      item.nextAt = null
      item.completedAt = new Date(now).toISOString()
      return
    }
    try {
      item.nextAt = new Date(nextOccurrence(item.plan, now)).toISOString()
    } catch (error) {
      item.enabled = false
      item.nextAt = null
      this.log('warn', `定时「${item.title}」算不出下一次，先停：${shortError(error)}`)
    }
  }

  async runTick(nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : this.now()
    this.clearTimer()
    const due = this.items
      .filter(
        (item) =>
          item.enabled &&
          item.backend !== 'host' &&
          item.nextAt &&
          Date.parse(item.nextAt) <= now,
      )
      .sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt))

    let delivered = 0
    for (const item of due) {
      if (this.stopped) break
      try {
        const sessionId = item.sessionId || this.tracker?.get?.()
        await this.deliver(sessionId, item.prompt, item)
        delivered += 1
        item.lastDeliveredAt = new Date(now).toISOString()
      } catch (error) {
        // 错过多少回都只试这一次；失败也照常排下一次，不在这里重试。
        this.log(
          'warn',
          `定时「${item.title}」没投出去：${shortError(error)}；下次照排，不重试`,
        )
      }
      this.advance(item, now)
    }

    if (due.length > 0) this.save()
    this.arm()
    return { delivered, due: due.length }
  }

  async create(input = {}, exec) {
    const plan = parsePlan(input)
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) throw new Error('prompt 不能空')
    const title = cleanTitle(input.title || defaultTitle(prompt))
    const now = this.now()
    if (exec?.agent) this.tracker?.noteAgent?.(exec.agent)
    const sessionId =
      String(input.sessionId ?? exec?.agent?.session?.id ?? this.tracker?.get?.() ?? '').trim() ||
      undefined

    const item = {
      id: newId(),
      title,
      prompt,
      plan,
      timezone: plan.timezone,
      sessionId,
      createdAt: new Date(now).toISOString(),
      enabled: true,
      backend: 'local',
      hostId: null,
      nextAt: new Date(nextOccurrence(plan, now)).toISOString(),
      lastDeliveredAt: null,
      completedAt: null,
    }

    if (this.hostAvailable && sessionId) {
      try {
        const record = await this.host.create(sessionId, hostRequest(plan, prompt, title))
        const hostId = typeof record?.id === 'string' && record.id ? record.id : ''
        if (!hostId) throw new Error('宿主调度没返回任务 id')
        item.backend = 'host'
        item.hostId = hostId
        if (typeof record?.scheduledAt === 'string') item.nextAt = record.scheduledAt
      } catch (error) {
        this.log(
          'warn',
          `宿主调度没接住「${title}」，改用本包 timer：${shortError(error)}`,
        )
      }
    }

    this.items.push(item)
    this.save()
    this.arm()
    return viewItem(item)
  }

  findById(id) {
    const target = String(id ?? '').trim()
    if (!target) return undefined
    return this.items.find((item) => item.id === target)
  }

  async list() {
    if (this.hostAvailable) {
      try {
        await this.refreshHostItems()
      } catch (error) {
        this.log('warn', `刷新宿主定时失败：${shortError(error)}`)
      }
    }
    return this.items.map(viewItem)
  }

  async refreshHostItems() {
    if (!this.hostAvailable) return
    const groups = new Map()
    for (const item of this.items) {
      if (!item.enabled || item.backend !== 'host' || !item.sessionId) continue
      const group = groups.get(item.sessionId) ?? []
      group.push(item)
      groups.set(item.sessionId, group)
    }

    let changed = false
    for (const [sessionId, items] of groups) {
      let records
      try {
        records = await this.host.list({ sessionId })
      } catch (error) {
        this.log('warn', `读宿主定时列表失败：${shortError(error)}`)
        continue
      }
      const byId = new Map((records ?? []).map((record) => [record.id, record]))
      for (const item of items) {
        const record = item.hostId ? byId.get(item.hostId) : undefined
        if (record) {
          if (typeof record.scheduledAt === 'string' && record.scheduledAt !== item.nextAt) {
            item.nextAt = record.scheduledAt
            changed = true
          }
        } else {
          item.enabled = false
          item.nextAt = null
          item.completedAt = item.completedAt || new Date(this.now()).toISOString()
          changed = true
        }
      }
    }
    if (changed) this.save()
  }

  async update(id, patch = {}, exec) {
    const item = this.findById(id)
    if (!item) throw new Error(`没找到定时任务：${id}`)
    if (exec?.agent) this.tracker?.noteAgent?.(exec.agent)

    if (patch.title !== undefined) item.title = cleanTitle(patch.title)
    if (patch.prompt !== undefined) {
      const prompt = String(patch.prompt).trim()
      if (!prompt) throw new Error('prompt 不能空')
      item.prompt = prompt
    }

    const selectors = ['after_seconds', 'every_seconds', 'daily', 'cron']
    const hasSelector = selectors.some((key) => patch[key] !== undefined)
    const timezone =
      patch.timezone !== undefined
        ? patch.timezone
        : patch.time_zone !== undefined
          ? patch.time_zone
          : item.timezone
    const hasTimezone = patch.timezone !== undefined || patch.time_zone !== undefined
    const canRetime = item.plan.kind === 'daily' || item.plan.kind === 'cron'
    const hasPlan = hasSelector || (hasTimezone && canRetime)

    if (hasPlan) {
      const plan = parsePlan(
        hasSelector ? { ...patch, timezone } : planToInput(item.plan, timezone),
      )
      item.plan = plan
      item.timezone = plan.timezone
      item.nextAt = new Date(nextOccurrence(plan, this.now())).toISOString()
      item.enabled = true
      item.completedAt = null

      if (item.backend === 'host' && this.hostAvailable && item.sessionId) {
        try {
          await this.updateHostItem(item, plan)
        } catch (error) {
          this.log('warn', `宿主定时改不动，改回本包 timer：${shortError(error)}`)
          item.backend = 'local'
          item.hostId = null
        }
      } else if (item.backend === 'host') {
        item.backend = 'local'
        item.hostId = null
      }
    } else if (item.backend === 'host' && this.hostAvailable && item.sessionId) {
      try {
        const records = await this.host.list({ sessionId: item.sessionId })
        const expected = (records ?? []).find((record) => record.id === item.hostId)
        if (expected && typeof this.host.update === 'function') {
          const result = await this.host.update({
            sessionId: item.sessionId,
            id: item.hostId,
            expected,
            title: item.title,
            prompt: item.prompt,
          })
          if (result && result.updated === false) throw new Error(result.code || '宿主拒绝更新')
        }
      } catch (error) {
        this.log('warn', `宿主定时内容没改：${shortError(error)}`)
      }
    }

    this.save()
    this.arm()
    return viewItem(item)
  }

  async updateHostItem(item, plan) {
    const records = await this.host.list({ sessionId: item.sessionId })
    const expected = (records ?? []).find((record) => record.id === item.hostId)
    const change = hostChange(plan)
    if (expected && change && typeof this.host.update === 'function') {
      const result = await this.host.update({
        sessionId: item.sessionId,
        id: item.hostId,
        expected,
        change,
        title: item.title,
        prompt: item.prompt,
      })
      if (result && 'record' in result) {
        if (typeof result.record?.scheduledAt === 'string') item.nextAt = result.record.scheduledAt
        return
      }
      if (result && result.updated === false) throw new Error(result.code || '宿主拒绝更新')
    }

    // after_seconds 宿主 update 不收；旧任务找不到时也走删旧建新。
    if (expected) {
      try {
        await this.host.delete({ sessionId: item.sessionId, id: item.hostId })
      } catch {
        /* 旧任务已经没了就算了 */
      }
    }
    const record = await this.host.create(
      item.sessionId,
      hostRequest(plan, item.prompt, item.title),
    )
    const hostId = typeof record?.id === 'string' && record.id ? record.id : ''
    if (!hostId) throw new Error('宿主调度没返回任务 id')
    item.backend = 'host'
    item.hostId = hostId
    if (typeof record?.scheduledAt === 'string') item.nextAt = record.scheduledAt
  }

  async remove(id) {
    const index = this.items.findIndex((item) => item.id === String(id ?? '').trim())
    if (index === -1) return false
    const item = this.items[index]
    if (item.backend === 'host' && this.hostAvailable && item.hostId && item.sessionId) {
      try {
        await this.host.delete({ sessionId: item.sessionId, id: item.hostId })
      } catch (error) {
        this.log('warn', `宿主定时没删掉（本地记录还是删）：${shortError(error)}`)
      }
    }
    this.items.splice(index, 1)
    this.save()
    this.arm()
    return true
  }

  stop() {
    this.stopped = true
    this.clearTimer()
  }
}

module.exports = {
  MAX_TIMER_DELAY_MS,
  MIN_AFTER_SECONDS,
  MIN_EVERY_SECONDS,
  MAX_INTERVAL_SECONDS,
  MAX_CRON_LENGTH,
  systemTimeZone,
  cleanTimeZone,
  parseCronExpression,
  nextCronMs,
  nextOccurrence,
  parsePlan,
  planSummary,
  formatWhen,
  normalizeStoredItem,
  viewItem,
  isHostSchedule,
  hostRequest,
  hostChange,
  planToInput,
  ScheduleEngine,
}
