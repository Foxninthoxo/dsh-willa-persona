/**
 * memory.js —— 跨会话记忆。
 *
 * 不复制旧数据：`memoryOldVectors` / `memoryV2Vectors` 指哪读哪；新记的东西落
 * `willaDataDir/memory-notes.json`（自带向量），跟老账分开存，不写人家的文件。
 * embed 服务地址与模型名也全走配置。
 *
 * D.2：没配 embed（`memoryEmbedUrl` 为空）就不注册 mem_recall / mem_note；
 * mem_supersede / mem_stats 是纯本地读写，照常保留，mem_stats 显示「记忆未配置」。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { companionHome, dataDir, expandPath } from '../paths.js'
import { loggerFor, textOutput } from './util.js'

export function createMemory(c) {
  const OLD_VECTORS =
    expandPath(c.memoryOldVectors) ||
    (companionHome(c) ? join(companionHome(c), 'data', 'vector-memory.json') : '')
  const EXTRA = join(dataDir(c), 'memory-notes.json')
  const V2 = expandPath(c.memoryV2Vectors) || join(dataDir(c), 'memory-vectors-v2.json')
  const EMBED = String(c.memoryEmbedUrl ?? '').trim()
  const MODEL = String(c.memoryEmbedModel || 'BAAI/bge-small-zh-v1.5').trim()
  const enabled = Boolean(EMBED)

  let cache = { at: 0, items: null }

  const now = () => {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const off = -d.getTimezoneOffset()
    const sign = off >= 0 ? '+' : '-'
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
      `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
    )
  }

  async function embed(text) {
    if (!enabled) throw new Error('记忆未配置（memoryEmbedUrl 为空）')
    const res = await fetch(EMBED, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: String(text), model: MODEL }),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`embed 服务回 ${res.status}`)
    const json = await res.json()
    const v = json?.data?.[0]?.embedding
    if (!Array.isArray(v)) throw new Error('embed 返回格式不对')
    return v
  }

  function loadExtra() {
    if (!existsSync(EXTRA)) return []
    try {
      const j = JSON.parse(readFileSync(EXTRA, 'utf8'))
      return Array.isArray(j.items) ? j.items : []
    } catch {
      return []
    }
  }

  function saveExtra(items) {
    mkdirSync(dirname(EXTRA), { recursive: true })
    const tmp = EXTRA + '.tmp'
    writeFileSync(tmp, JSON.stringify({ items }, null, 0), 'utf8')
    renameSync(tmp, EXTRA)
  }

  /** 老账里的向量是 base64(int16 量化)，不是 float 数组。 */
  function decodeVec(v) {
    if (Array.isArray(v)) return Float32Array.from(v)
    if (v && typeof v === 'object' && Array.isArray(v.data)) return Float32Array.from(v.data)
    if (typeof v === 'string') {
      const b = Buffer.from(v, 'base64')
      const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      const i16 = new Int16Array(buf, 0, Math.floor(b.byteLength / 2))
      const f = new Float32Array(i16.length)
      for (let i = 0; i < i16.length; i++) f[i] = i16[i]
      return f
    }
    return null
  }

  function decodeF32b64(s) {
    const b = Buffer.from(s, 'base64')
    const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    return new Float32Array(buf, 0, Math.floor(b.byteLength / 4))
  }

  /** 老账里的 timestamp 有秒级数字、也有 ISO 字符串，统一成 ISO。 */
  function normTs(v) {
    if (v === null || v === undefined || v === '') return ''
    if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
      const n = Number(v)
      const ms = n > 1e12 ? n : n * 1000
      const d = new Date(ms)
      return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
    }
    return String(v)
  }

  /** 老账读一次缓一缓；文件变了才重读。v2 优先，其次旧向量。 */
  function loadOld() {
    try {
      if (V2 && existsSync(V2)) {
        const st2 = statSync(V2)
        if (cache.items && cache.at === st2.mtimeMs) return cache.items
        const j2 = JSON.parse(readFileSync(V2, 'utf8'))
        const items2 = (j2.items ?? []).map((it) => ({
          text: String(it.text),
          vector: decodeF32b64(it.vec),
          timestamp: normTs(it.timestamp),
          channel: it.channel,
        }))
        cache = { at: st2.mtimeMs, items: items2 }
        return items2
      }
      if (!OLD_VECTORS || !existsSync(OLD_VECTORS)) return cache.items ?? []
      const st = statSync(OLD_VECTORS)
      if (cache.items && cache.at === st.mtimeMs) return cache.items
      const raw = JSON.parse(readFileSync(OLD_VECTORS, 'utf8'))
      const items = []
      for (const [chan, arr] of Object.entries(raw.vectors ?? {})) {
        if (!Array.isArray(arr)) continue
        for (const it of arr) {
          if (!it?.text) continue
          const vec = decodeVec(it.vector)
          if (!vec || !vec.length) continue
          items.push({
            text: String(it.text),
            vector: vec,
            timestamp: normTs(it.timestamp),
            channel: chan,
          })
        }
      }
      cache = { at: st.mtimeMs, items }
      return items
    } catch {
      return cache.items ?? []
    }
  }

  function cosine(a, b) {
    let dot = 0
    let na = 0
    let nb = 0
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    if (!na || !nb) return 0
    return dot / Math.sqrt(na * nb)
  }

  async function recall(query, k = 6, channel = '', opts = {}) {
    const q = String(query ?? '').trim()
    if (!q) throw new Error('要查什么？给个 query')
    const qv = await embed(q)
    const person = opts.person ? String(opts.person) : ''
    const pool = [...loadOld(), ...loadExtra()]
      .filter((it) => (channel ? it.channel === channel : true))
      .filter((it) => !it.superseded)
      .filter((it) =>
        person ? (it.people ?? []).includes(person) || it.channel === person : true,
      )
    const nowMs = Date.now()
    const scored = pool.map((it) => {
      const base = cosine(qv, it.vector)
      // 新近度加成：30 天内接近 1，越老越低；最多加 0.08，不压过语义。
      const t = Date.parse(it.timestamp)
      const ageDays = Number.isFinite(t) ? (nowMs - t) / 86400_000 : 365
      const recency = Math.exp(-Math.max(0, ageDays) / 30)
      return { it, s: base + 0.08 * recency }
    })
    scored.sort((x, y) => y.s - x.s)
    return scored.slice(0, Math.min(Math.max(Number(k) || 6, 1), 20))
  }

  /**
   * 记一条。people 是这条涉及的人（QQ 号数组），tags 是关键词；
   * 都不给就只写正文——以后靠语义找。
   */
  async function note(text, channel = 'main', opts = {}) {
    const t = String(text ?? '').trim()
    if (!t) throw new Error('记什么？正文不能空')
    const v = await embed(t)
    const items = loadExtra()
    items.push({
      text: t,
      vector: v,
      timestamp: now(),
      channel: channel || 'main',
      people: Array.isArray(opts.people) ? opts.people.map(String) : [],
      tags: Array.isArray(opts.tags) ? opts.tags.map(String) : [],
      superseded: false,
      id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    })
    saveExtra(items.slice(-4000))
    return { count: items.length }
  }

  /** 把某条旧记忆标成过时（不删，只是不再返回）。 */
  function supersede(substr) {
    const s = String(substr ?? '').trim()
    if (!s) throw new Error('要标哪条？给一段原文')
    const items = loadExtra()
    let n = 0
    for (const it of items) {
      if (!it.superseded && String(it.text).includes(s)) {
        it.superseded = true
        n++
      }
    }
    if (n) saveExtra(items)
    return n
  }

  function stats() {
    const old = enabled ? loadOld() : []
    const by = {}
    for (const it of old) by[it.channel] = (by[it.channel] ?? 0) + 1
    return {
      configured: enabled,
      old: old.length,
      extra: loadExtra().length,
      byChannel: by,
      store: EXTRA,
    }
  }

  function register(scope) {
    if (enabled) {
      scope.tools.register({
        name: 'mem_recall',
        description:
          '翻老账：按语义在老记忆里找（旧向量 + 后来新记的），返回最像的几条。' +
          '想到以前聊过什么就用它，别凭空编。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: {
            query: { type: 'string', description: '要找什么。' },
            k: { type: 'integer', description: '要几条，默认 6，最多 20。' },
            channel: {
              type: 'string',
              description: '可选：只看某个频道，比如 10000、persona、bilibili-video。',
            },
            person: { type: 'string', description: '可选：只看跟某个人有关的（QQ 号）。' },
          },
        },
        output: textOutput(),
        async execute(args) {
          const hits = await recall(args.query, args.k ?? 6, args.channel ?? '', {
            person: args.person,
          })
          if (!hits.length) return { ok: true, detail: '没翻到。' }
          const fmtHit = (hit) => {
            const ts = hit.it.timestamp
              ? String(hit.it.timestamp).slice(0, 16).replace('T', ' ') + ' '
              : ''
            return `[${hit.it.channel}] ${hit.s.toFixed(2)} ${ts}${hit.it.text}`
          }
          return { ok: true, detail: hits.map(fmtHit).join('\n') }
        },
      })

      scope.tools.register({
        name: 'mem_note',
        description:
          '记一条新的长期记忆（带向量，落数据目录的 memory-notes.json）。有人说「记住这个」、或我自己觉得该记住的时候用。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: {
            text: { type: 'string', description: '要记的事，一句到几句。' },
            channel: { type: 'string', description: '可选：归到哪个频道，默认 main。' },
            people: {
              type: 'array',
              items: { type: 'string' },
              description: '可选：这条涉及谁（QQ 号数组），以后能按人筛。',
            },
            tags: { type: 'array', items: { type: 'string' }, description: '可选：关键词。' },
          },
        },
        output: textOutput(),
        async execute(args) {
          const r = await note(args.text, args.channel, {
            people: args.people,
            tags: args.tags,
          })
          return { ok: true, detail: `记下了，新账第 ${r.count} 条。` }
        },
      })
    } else {
      loggerFor(scope)?.warn?.(
        'dsh-willa: 记忆未配置（memoryEmbedUrl 为空），跳过 mem_recall / mem_note；mem_stats 保留',
      )
    }

    scope.tools.register({
      name: 'mem_supersede',
      description: '把一条过时的记忆标掉（不删，只是不再被检索到）。事实变了、旧说法不用再提的时候用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', description: '原文里的一段，能唯一定位那条就行。' } },
      },
      output: textOutput(),
      async execute(args) {
        const n = supersede(args.text)
        return { ok: true, detail: n ? `标了 ${n} 条过时。` : '没找到匹配的记忆。' }
      },
    })

    scope.tools.register({
      name: 'mem_stats',
      description: '看一眼记忆库什么情况：老账多少条、新记多少条、各频道多少。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput(),
      async execute() {
        const s = stats()
        if (!s.configured) {
          return {
            ok: true,
            detail: `记忆未配置（memoryEmbedUrl 为空）；mem_recall / mem_note 未启用，新记 ${s.extra} 条。`,
          }
        }
        const chans = Object.entries(s.byChannel)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k} ${v}`)
          .join('，')
        return {
          ok: true,
          detail: `老账 ${s.old} 条（${chans}）；新记 ${s.extra} 条，存在 ${s.store}。`,
        }
      },
    })

    return enabled ? 4 : 2
  }

  return {
    enabled,
    embed,
    recall,
    note,
    supersede,
    stats,
    register,
    store: EXTRA,
    oldVectors: OLD_VECTORS,
    v2Vectors: V2,
  }
}
