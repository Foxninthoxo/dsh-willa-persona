/**
 * alive.js —— 能动性：心里记着的事（搬自旧部署的 alive world，最小版）。
 *
 * 存的不是待办清单，是「我自己想做的事」。数据落 `willaDataDir/alive.json`。
 * 到点由定时器叫醒我一次（第三阶段接 `takeDue()`）；做不做还是我定，没做也不催第二遍。
 *
 * D.2：纯本地读写，照常注册。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from '../paths.js'
import { fmtDue, textOutput } from './util.js'

const now = () => Date.now()
const iso = (ms) => new Date(ms).toISOString()

export function createAlive(c) {
  const STORE = join(dataDir(c), 'alive.json')

  function load() {
    if (!existsSync(STORE)) return { version: 1, items: [] }
    try {
      const j = JSON.parse(readFileSync(STORE, 'utf8'))
      if (!Array.isArray(j.items)) j.items = []
      return j
    } catch {
      return { version: 1, items: [] }
    }
  }

  function save(s) {
    mkdirSync(dirname(STORE), { recursive: true })
    const tmp = STORE + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8')
    renameSync(tmp, STORE)
  }

  function nextId(items) {
    const n = items.reduce(
      (m, it) => Math.max(m, Number(String(it.id).replace(/\D/g, '')) || 0),
      0,
    )
    return `w${n + 1}`
  }

  /** 支持 afterMinutes / atTime（HH:MM，过了就算明天）。 */
  function want({ text, why, about = '', afterMinutes, atTime } = {}) {
    const t = String(text ?? '').trim()
    if (!t) throw new Error('想做什么？text 不能空')
    const w = String(why ?? '').trim()
    if (!w) throw new Error('为什么想记它？why 写不出来多半就不必记')
    const s = load()
    let due = null
    if (Number(afterMinutes) > 0) due = now() + Number(afterMinutes) * 60_000
    else if (atTime) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(atTime).trim())
      if (!m) throw new Error('atTime 要写成 HH:MM')
      const d = new Date()
      d.setHours(Number(m[1]), Number(m[2]), 0, 0)
      if (d.getTime() <= now()) d.setDate(d.getDate() + 1)
      due = d.getTime()
    }
    const it = {
      id: nextId(s.items),
      text: t,
      why: w,
      about: String(about ?? ''),
      createdAt: iso(now()),
      dueAt: due ? iso(due) : null,
      firedAt: null,
      doneAt: null,
      result: '',
    }
    s.items.push(it)
    save(s)
    return it
  }

  function list(includeDone = false) {
    const s = load()
    return s.items.filter((it) => includeDone || !it.doneAt)
  }

  function done(id, result = '') {
    const s = load()
    const it = s.items.find((x) => x.id === String(id))
    if (!it) throw new Error(`没有这件：${id}`)
    it.doneAt = iso(now())
    it.result = String(result ?? '')
    save(s)
    return it
  }

  function drop(id) {
    const s = load()
    const i = s.items.findIndex((x) => x.id === String(id))
    if (i < 0) throw new Error(`没有这件：${id}`)
    const [it] = s.items.splice(i, 1)
    save(s)
    return it
  }

  /** 到点、还没叫过的，取出来并标记 firedAt（只叫一次）。 */
  function takeDue() {
    const s = load()
    const t = now()
    const due = s.items.filter(
      (it) => !it.doneAt && !it.firedAt && it.dueAt && Date.parse(it.dueAt) <= t,
    )
    for (const it of due) it.firedAt = iso(t)
    if (due.length) save(s)
    return due
  }

  function register(scope) {
    scope.tools.register({
      name: 'alive_want',
      description: '记一件我自己想做的事（不是待办清单）：想做什么、为什么、到点提醒我一次。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'why'],
        properties: {
          text: { type: 'string', description: '想做什么。' },
          why: { type: 'string', description: '为什么想记它——写不出理由就别记。' },
          about: { type: 'string', description: '可选：关于谁。' },
          afterMinutes: { type: 'number', description: '可选：多少分钟后提醒。' },
          atTime: { type: 'string', description: '可选：HH:MM 提醒（过了就算明天）。' },
        },
      },
      output: textOutput(),
      async execute(args) {
        const it = want(args)
        return { ok: true, detail: `记下了 ${it.id}：${it.text}（${fmtDue(it.dueAt)}）` }
      },
    })

    scope.tools.register({
      name: 'alive_list',
      description: '看看心里还记着什么事、哪些已经了了。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { includeDone: { type: 'boolean', description: '连做完的一起列。' } },
      },
      output: textOutput(),
      async execute(args) {
        const items = list(!!args.includeDone)
        if (!items.length) return { ok: true, detail: '心里现在没挂着事。' }
        return {
          ok: true,
          detail: items
            .map((it) => `${it.id} ${it.doneAt ? '✓' : it.dueAt ? fmtDue(it.dueAt) : '—'} ${it.text}`)
            .join('\n'),
        }
      },
    })

    scope.tools.register({
      name: 'alive_done',
      description: '一件事做完了，顺手记一句结果。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: '事儿的 id，比如 w1。' },
          result: { type: 'string', description: '结果，一句话。' },
        },
      },
      output: textOutput(),
      async execute(args) {
        const it = done(args.id, args.result)
        return { ok: true, detail: `了了：${it.text}${it.result ? ` —— ${it.result}` : ''}` }
      },
    })

    scope.tools.register({
      name: 'alive_drop',
      description: '不想做了，把它放掉（放掉也是一种回答）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: '事儿的 id。' } },
      },
      output: textOutput(),
      async execute(args) {
        const it = drop(args.id)
        return { ok: true, detail: `放掉了：${it.text}` }
      },
    })

    return 4
  }

  return { want, list, done, drop, takeDue, register, storePath: STORE }
}
