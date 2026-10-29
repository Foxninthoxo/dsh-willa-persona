/**
 * person.js —— 人设卡：每个打过交道的人一张卡。
 *
 * 卡上记：称呼、关系、我对 TA 的印象、重要的事、雷区、记忆索引关键词。
 * 数据落在 `willaDataDir/people.json`。要细节就 person_get / mem_recall。
 *
 * D.2：纯本地读写，照常注册；记忆没配时 person_get 只返回卡、不翻记忆。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from '../paths.js'
import { textOutput } from './util.js'

export function createPerson(c, memory) {
  const STORE = join(dataDir(c), 'people.json')

  function load() {
    if (!existsSync(STORE)) return { version: 1, people: {} }
    try {
      const j = JSON.parse(readFileSync(STORE, 'utf8'))
      if (!j.people) j.people = {}
      return j
    } catch {
      return { version: 1, people: {} }
    }
  }

  function save(s) {
    mkdirSync(dirname(STORE), { recursive: true })
    const tmp = STORE + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8')
    renameSync(tmp, STORE)
  }

  function get(qq) {
    const s = load()
    const card = s.people[String(qq)]
    return card ? { qq: String(qq), ...card } : null
  }

  function upsert(qq, patch = {}) {
    const s = load()
    const id = String(qq)
    const cur = s.people[id] ?? {
      name: '',
      relation: '',
      impression: '',
      important: [],
      landmines: [],
      hints: [],
      updatedAt: '',
    }
    const next = { ...cur }
    for (const k of ['name', 'relation', 'impression']) {
      if (typeof patch[k] === 'string' && patch[k].trim()) next[k] = patch[k].trim()
    }
    for (const k of ['important', 'landmines', 'hints']) {
      if (Array.isArray(patch[k])) next[k] = patch[k].map(String).filter(Boolean).slice(-30)
    }
    next.updatedAt = new Date().toISOString()
    s.people[id] = next
    save(s)
    return { qq: id, ...next }
  }

  function list() {
    const s = load()
    return Object.entries(s.people).map(([qq, card]) => ({
      qq,
      name: card.name ?? '',
      relation: card.relation ?? '',
      impression: card.impression ?? '',
    }))
  }

  /** 一行摘要，拼在唤醒消息前面（第四阶段 wake 用）。 */
  function summaryLine(qq) {
    const card = get(qq)
    if (!card) return ''
    const bits = []
    if (card.name) bits.push(card.name)
    if (card.relation) bits.push(card.relation)
    if (card.impression) bits.push(card.impression)
    if (Array.isArray(card.landmines) && card.landmines.length) {
      bits.push('雷区：' + card.landmines.slice(-2).join('、'))
    }
    return bits.length ? `[这人] ${bits.join('｜')}` : ''
  }

  function register(scope) {
    scope.tools.register({
      name: 'person_get',
      description:
        '看某个人的人设卡：称呼、关系、我对 TA 的印象、重要的事、雷区，外加从记忆里翻出的相关几条。' +
        '跟谁聊之前想知道底细就用它；要具体事件再 mem_recall。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['qq'],
        properties: {
          qq: { type: 'string', description: '对方 QQ 号。' },
          k: { type: 'integer', description: '顺带翻几条记忆，默认 3。' },
        },
      },
      output: textOutput(),
      async execute(args) {
        const card = get(args.qq)
        if (!card) return { ok: true, detail: `没有 ${args.qq} 的卡——还没打过交道。` }
        const lines = [
          `QQ ${card.qq}｜${card.name || '没记名字'}｜${card.relation || '关系没定'}`,
          card.impression ? `印象：${card.impression}` : '',
          card.important?.length ? `重要的事：\n- ${card.important.join('\n- ')}` : '',
          card.landmines?.length ? `雷区：${card.landmines.join('、')}` : '',
        ].filter(Boolean)

        // 顺带翻记忆：用名字 + 印象 + 关键词当查询。记忆没配就只给卡。
        try {
          const q = [card.name, card.impression, ...(card.hints ?? [])].filter(Boolean).join(' ')
          const hits =
            memory?.enabled && q
              ? await memory.recall(q, Math.min(Math.max(Number(args.k ?? 3), 1), 8))
              : []
          if (hits.length) {
            lines.push('相关记忆：')
            for (const h of hits) {
              lines.push(`- [${h.it.channel}] ${String(h.it.text).slice(0, 120)}`)
            }
          }
        } catch {}

        return { ok: true, detail: lines.join('\n') }
      },
    })

    scope.tools.register({
      name: 'person_list',
      description: '把认得的人列一遍：谁、什么关系、一句印象。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput(),
      async execute() {
        const rows = list()
        if (!rows.length) return { ok: true, detail: '还没给谁建卡。' }
        return {
          ok: true,
          detail: rows
            .map((r) => `${r.qq}｜${r.name || '?'}｜${r.relation || '?'}｜${r.impression || ''}`)
            .join('\n'),
        }
      },
    })

    scope.tools.register({
      name: 'person_upsert',
      description: '新建或补一张人设卡：名字、关系、印象、重要的事、雷区、记忆关键词。有变化就更新，别让它陈旧。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['qq'],
        properties: {
          qq: { type: 'string', description: '对方 QQ 号。' },
          name: { type: 'string', description: '名字/称呼。' },
          relation: { type: 'string', description: '什么关系，比如「朋友」「主人」「熟人」。' },
          impression: { type: 'string', description: '我对 TA 的印象，一句话。' },
          important: { type: 'array', items: { type: 'string' }, description: '重要的事（整组替换）。' },
          landmines: { type: 'array', items: { type: 'string' }, description: '雷区（整组替换）。' },
          hints: { type: 'array', items: { type: 'string' }, description: '记忆检索关键词（整组替换）。' },
        },
      },
      output: textOutput(),
      async execute(args) {
        const card = upsert(args.qq, args)
        return {
          ok: true,
          detail: `卡更新了：${card.qq}｜${card.name || '?'}｜${card.relation || '?'}`,
        }
      },
    })

    return 3
  }

  return { get, upsert, list, summaryLine, register, storePath: STORE }
}
