/**
 * affinity.js —— 好感账。
 *
 * 数据落在 `willaDataDir/affinity.json`（旧部署把 willaDataDir 指到 `workspace/private`
 * 就能直接读老账）。结构跟旧部署的 data/affinity.json 对齐，方便一次迁移；
 * 多出来的 `slot` 是「这人算我的什么人」，只有我能定。
 *
 * D.2：纯本地读写，后端缺什么都照常注册。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { companionHome, dataDir, expandPath } from '../paths.js'
import { fmtTs, textOutput } from './util.js'

export const SLOTS = ['家人', '恋人', '闺蜜', '朋友', '搭子', '同学', '熟人', '不对付', '说不清']
const KINDS = [
  'angry',
  'wronged',
  'hurt',
  'disgusted',
  'proud',
  'happy',
  'excited',
  'awkward',
  'tired',
  'upset',
]

/** 本地时间带 +08:00 偏移，跟老账的写法一致。 */
const now = () => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const hh = pad(Math.floor(Math.abs(off) / 60))
  const mm = pad(Math.abs(off) % 60)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${String(d.getMilliseconds()).padStart(3, '0')}${sign}${hh}:${mm}`
  )
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const round1 = (n) => Math.round(n * 10) / 10

function emptyStore() {
  return { version: 1, people: {}, migratedAt: null }
}

/** 老账路径：显式配置优先；没配但给了 willaCompanionHome 就按旧布局推。 */
function migrateFileFor(c) {
  const explicit = expandPath(c.affinityMigrateFile)
  if (explicit) return explicit
  const home = companionHome(c)
  return home ? join(home, 'data', 'affinity.json') : ''
}

export function createAffinity(c) {
  const STORE = join(dataDir(c), 'affinity.json')
  const MIGRATE_FILE = migrateFileFor(c)

  function load() {
    if (!existsSync(STORE)) return emptyStore()
    try {
      const raw = JSON.parse(readFileSync(STORE, 'utf8'))
      if (!raw || typeof raw !== 'object') return emptyStore()
      raw.people = raw.people && typeof raw.people === 'object' ? raw.people : {}
      return raw
    } catch {
      return emptyStore()
    }
  }

  function save(store) {
    mkdirSync(dirname(STORE), { recursive: true })
    const tmp = STORE + '.tmp'
    writeFileSync(tmp, JSON.stringify(store, null, 1), 'utf8')
    renameSync(tmp, STORE)
  }

  /** 情绪按半衰期衰减，跟老账一个算法。过期的直接清掉。 */
  function decay(person) {
    const t = Date.now()
    person.emotions = (person.emotions ?? [])
      .map((e) => {
        const peak = Date.parse(e.peakAt ?? now())
        const half = Number(e.halfLifeMs ?? 5_400_000)
        if (!Number.isFinite(peak) || !Number.isFinite(half) || half <= 0) return null
        const intensity = Number(e.intensity ?? 0) * Math.pow(0.5, (t - peak) / half)
        if (intensity < 0.02) return null
        return { ...e, intensity: round1(intensity) }
      })
      .filter(Boolean)
    return person.emotions
  }

  function ensurePerson(store, qq) {
    const id = String(qq)
    if (!store.people[id]) {
      store.people[id] = {
        score: 0,
        msgs: 0,
        best: 0,
        firstAt: now(),
        lastAt: now(),
        slot: null,
        note: '',
        emotions: [],
      }
    }
    return store.people[id]
  }

  function getPerson(qq) {
    const store = load()
    const p = store.people[String(qq)]
    if (!p) return null
    decay(p)
    return { qq: String(qq), ...p }
  }

  function adjust(qq, { delta = 0, reason = '', kind = null } = {}) {
    if (!reason.trim()) throw new Error('记一笔得写清为什么（reason 不能空）')
    const k = kind && KINDS.includes(kind) ? kind : null
    const store = load()
    const p = ensurePerson(store, qq)
    const d = Number(delta) || 0
    p.score = round1(clamp(p.score + d, -10, 10))
    p.best = Math.max(p.best ?? 0, p.score)
    p.msgs = (p.msgs ?? 0) + 1
    p.lastAt = now()
    p.note = `${d >= 0 ? '+' : ''}${d} ${reason}`.trim()
    if (k || d !== 0) {
      decay(p)
      // 气多久看交情：分越高，消得越快（高分的骂两句过会儿就淡，低分的记久一点）。
      // 这个时长只影响我自己，不告诉对方（2026-10-26 Fox 定的）。
      const factor = clamp(1.6 - p.score * 0.12, 0.25, 2.2)
      p.emotions.push({
        kind: k ?? (d >= 0 ? 'happy' : 'angry'),
        intensity: round1(clamp(Math.abs(d) || 0.3, 0.1, 1)),
        reason,
        peakAt: now(),
        halfLifeMs: Math.round(5_400_000 * factor),
      })
      p.emotions = p.emotions.slice(-12)
    }
    save(store)
    return { qq: String(qq), score: p.score, delta: d, note: p.note }
  }

  function setSlot(qq, slot) {
    const s = String(slot ?? '').trim()
    const store = load()
    const p = ensurePerson(store, qq)
    if (s === '撤' || s === '' || s === 'null') {
      p.slot = null
    } else {
      if (!SLOTS.includes(s)) throw new Error(`格子只能是：${SLOTS.join('／')}（或者「撤」）`)
      p.slot = s
    }
    p.lastAt = now()
    save(store)
    return { qq: String(qq), slot: p.slot }
  }

  function list() {
    const store = load()
    const rows = Object.entries(store.people).map(([qq, p]) => {
      decay(p)
      return {
        qq,
        score: p.score,
        slot: p.slot ?? '',
        msgs: p.msgs ?? 0,
        note: p.note ?? '',
        lastAt: p.lastAt ?? '',
      }
    })
    rows.sort((a, b) => b.score - a.score)
    return rows
  }

  /** 从旧部署那本老账搬一次；已经搬过的不重复搬。 */
  function migrateFrom(file = MIGRATE_FILE) {
    if (!file) {
      throw new Error('没配置老账路径（affinityMigrateFile，或旧部署的 willaCompanionHome）')
    }
    const store = load()
    if (store.migratedAt) return { migrated: 0, skipped: true }
    if (!existsSync(file)) throw new Error(`找不到老账：${file}`)
    const old = JSON.parse(readFileSync(file, 'utf8'))
    let n = 0
    for (const [qq, p] of Object.entries(old.people ?? {})) {
      const dst = ensurePerson(store, qq)
      dst.score = Number(p.score ?? 0)
      dst.msgs = Number(p.msgs ?? 0)
      dst.best = Number(p.best ?? dst.score)
      dst.firstAt = p.firstAt ?? dst.firstAt
      dst.lastAt = p.lastAt ?? dst.lastAt
      dst.note = p.note ?? ''
      dst.emotions = Array.isArray(p.emotions) ? p.emotions.slice(-12) : []
      n++
    }
    store.migratedAt = now()
    save(store)
    return { migrated: n, skipped: false }
  }

  function register(scope, { life } = {}) {
    scope.tools.register({
      name: 'affinity_get',
      description: '查一个人的好感账：分数、条数、我给 ta 定的关系格子、最近的情绪和备注。回话前先看一眼。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['qq'],
        properties: { qq: { type: 'string', description: '对方 QQ 号。' } },
      },
      output: textOutput(),
      async execute(args) {
        const p = getPerson(args.qq)
        if (!p) return { ok: true, detail: `没有 ${args.qq} 的账——还没打过交道。` }
        const emo = (p.emotions ?? [])
          .slice(-3)
          .map((e) => `${e.kind} ${e.intensity}：${e.reason}`)
          .join('；')
        const lines = [
          `QQ ${p.qq}：${p.score} 分${p.slot ? `（${p.slot}）` : ''}，${p.msgs} 条，最高 ${p.best}，最近 ${fmtTs(p.lastAt)}`,
          p.note ? `备注：${p.note}` : '',
          emo ? `还挂着的情绪：${emo}` : '',
        ]
        return { ok: true, detail: lines.filter(Boolean).join('\n') }
      },
    })

    scope.tools.register({
      name: 'affinity_adjust',
      description: '记一笔好感变动：加分/扣分，写清为什么。发生了值得记的事才记，不用每句都调。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['qq', 'reason'],
        properties: {
          qq: { type: 'string', description: '对方 QQ 号。' },
          delta: { type: 'number', description: '加减多少分，默认 0（只记情绪不动账）。' },
          reason: { type: 'string', description: '为什么，一句话。' },
          kind: {
            type: 'string',
            description:
              '情绪：angry / wronged / hurt / disgusted / proud / happy / excited / awkward / tired / upset。',
          },
        },
      },
      output: textOutput(),
      async execute(args) {
        const r = adjust(args.qq, {
          delta: args.delta ?? 0,
          reason: String(args.reason ?? ''),
          kind: args.kind,
        })
        // 被冒犯时，全局底色也沉一点——回别人的时候只是「心情有点烦」，
        // 但不带「对 TA」那一行，所以不算迁怒。2026-10-26 Fox 定的。
        const bad = ['angry', 'wronged', 'hurt', 'disgusted', 'upset'].includes(
          String(args.kind ?? ''),
        )
        if (bad || Number(r.delta) < 0) {
          try {
            life?.set({ mood: '有点烦' })
          } catch {}
        }
        return {
          ok: true,
          detail: `QQ ${r.qq} ${r.delta >= 0 ? '+' : ''}${r.delta} → ${r.score} 分（${r.note}）`,
        }
      },
    })

    scope.tools.register({
      name: 'affinity_slot',
      description:
        '给一个人定关系格子（家人／恋人／闺蜜／朋友／搭子／同学／熟人／不对付／说不清），传「撤」就撤掉。这一格只有我能定，不用急着填。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['qq', 'slot'],
        properties: {
          qq: { type: 'string', description: '对方 QQ 号。' },
          slot: { type: 'string', description: '格子；「撤」= 撤掉。' },
        },
      },
      output: textOutput(),
      async execute(args) {
        const r = setSlot(args.qq, args.slot)
        return {
          ok: true,
          detail: r.slot ? `QQ ${r.qq} 记成「${r.slot}」。` : `QQ ${r.qq} 的格子撤了。`,
        }
      },
    })

    scope.tools.register({
      name: 'affinity_list',
      description: '把好感账从头翻一遍：谁多少分、什么关系、最近怎么了。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput(),
      async execute() {
        const rows = list()
        if (!rows.length) return { ok: true, detail: '账本还是空的。' }
        const lines = rows.map(
          (r) =>
            `${r.qq}：${r.score} 分${r.slot ? `（${r.slot}）` : ''}，${r.msgs} 条，最近 ${fmtTs(r.lastAt)}${r.note ? ` —— ${r.note}` : ''}`,
        )
        return { ok: true, detail: lines.join('\n') }
      },
    })

    scope.tools.register({
      name: 'affinity_migrate',
      description: '把旧部署那本老账（data/affinity.json）搬进这边一次；搬过了不会重复搬。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput(),
      async execute() {
        const r = migrateFrom(MIGRATE_FILE)
        return {
          ok: true,
          detail: r.skipped
            ? '已经搬过了，没重搬。'
            : `搬进来 ${r.migrated} 个人；账本在 ${STORE}。`,
        }
      },
    })

    return 5
  }

  return {
    getPerson,
    adjust,
    setSlot,
    list,
    migrateFrom,
    register,
    storePath: STORE,
    migrateFile: MIGRATE_FILE,
  }
}
