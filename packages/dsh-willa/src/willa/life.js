/**
 * life.js —— 我此刻的状态：心情、精力、在忙什么。
 *
 * 不是待办、不是记忆：是「现在」的那一层。数据落 `willaDataDir/life.json`。
 * 状态会拼在每条唤醒消息前面（第四阶段 wake 用）。
 *
 * D.2：纯本地读写，照常注册。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from '../paths.js'
import { textOutput } from './util.js'

const MOODS = ['挺放松的', '有点困', '有点烦', '来劲了', '懒懒的', '平静', '心里有点堵', '开心']
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

export function createLife(c, affinity) {
  const STORE = join(dataDir(c), 'life.json')

  function load() {
    if (!existsSync(STORE)) {
      return { mood: '挺放松的', energy: 0.85, doing: '发呆', updatedAt: new Date().toISOString() }
    }
    try {
      const j = JSON.parse(readFileSync(STORE, 'utf8'))
      return {
        mood: typeof j.mood === 'string' ? j.mood : '挺放松的',
        energy: Number(j.energy ?? 0.85),
        doing: typeof j.doing === 'string' ? j.doing : '发呆',
        updatedAt: j.updatedAt ?? new Date().toISOString(),
      }
    } catch {
      return { mood: '挺放松的', energy: 0.85, doing: '发呆', updatedAt: new Date().toISOString() }
    }
  }

  function save(s) {
    mkdirSync(dirname(STORE), { recursive: true })
    const tmp = STORE + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 1), 'utf8')
    renameSync(tmp, STORE)
  }

  /**
   * 没被叫醒的时间算「歇着」：精力往回涨，夜里涨得更多。
   * 2026-10-27 改：以前只降不升，久了就永远吊在 5%；现在歇够了会回血，封顶 95%。
   * 干重活掉精力靠 life_set 手动压，不靠这里自动扣。
   */
  function drift(s) {
    const last = Date.parse(s.updatedAt)
    if (!Number.isFinite(last)) return s
    const hours = (Date.now() - last) / 3600_000
    if (hours < 0.15) return s
    // 每 15 分钟算一档：白天一档 +8%，夜里一档 +18%，够睡一觉就满了
    const steps = Math.min(16, Math.floor(hours * 4))
    const hour = new Date().getHours()
    const night = hour >= 0 && hour < 8
    const recover = (night ? 0.18 : 0.08) + Math.random() * 0.03
    for (let i = 0; i < steps; i++) {
      s.energy = clamp(s.energy + recover, 0.05, 1)
      if (Math.random() < 0.1) {
        if (s.energy > 0.7 && Math.random() < 0.6) s.mood = '挺放松的'
        else s.mood = MOODS[Math.floor(Math.random() * MOODS.length)]
      }
    }
    s.updatedAt = new Date().toISOString()
    return s
  }

  function now() {
    const s = drift(load())
    save(s)
    return s
  }

  function set({ mood, energy, doing } = {}) {
    const s = now()
    if (typeof mood === 'string' && mood.trim()) s.mood = mood.trim()
    if (energy !== undefined && Number.isFinite(Number(energy))) s.energy = clamp(Number(energy), 0, 1)
    if (typeof doing === 'string' && doing.trim()) s.doing = doing.trim()
    s.updatedAt = new Date().toISOString()
    save(s)
    return s
  }

  /** 一行状态，拼在唤醒消息前面用。 */
  function line() {
    const s = now()
    const pct = Math.round(s.energy * 100)
    return `[我此刻] 心情：${s.mood}；精力：${pct}%；正在：${s.doing}`
  }

  /**
   * 跟某个人说话时的状态：全局底色 + 对这个人的情绪余温。
   * 情绪是记在具体人身上的，不迁怒——回 A 和回 B 可以两个脸色。
   */
  function lineFor(qq) {
    const base = line()
    if (!qq) return base
    try {
      const p = affinity?.getPerson(String(qq))
      const emo = (p?.emotions ?? []).filter((e) => Number(e.intensity) > 0.05)
      if (!emo.length) return base
      const top = emo.reduce((a, b) => (Number(a.intensity) >= Number(b.intensity) ? a : b))
      return `${base}；对 TA：${top.kind} ${Number(top.intensity).toFixed(1)}（${String(top.reason ?? '').slice(0, 30)}）`
    } catch {
      return base
    }
  }

  function register(scope) {
    scope.tools.register({
      name: 'life_now',
      description: '看一眼我此刻的状态：心情、精力、正在做什么。回话前想知道自己是什么调子就用它。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput(),
      async execute() {
        const s = now()
        return {
          ok: true,
          detail: `心情：${s.mood}；精力：${Math.round(s.energy * 100)}%；正在：${s.doing}`,
        }
      },
    })

    scope.tools.register({
      name: 'life_set',
      description: '改我此刻的状态：心情 / 精力（0-1）/ 正在做什么。发生值得记的事、或换了个处境的时候用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mood: { type: 'string', description: '心情，一句话，比如「有点烦」「来劲了」。' },
          energy: { type: 'number', description: '精力 0-1。' },
          doing: { type: 'string', description: '正在做什么。' },
        },
      },
      output: textOutput(),
      async execute(args) {
        const s = set(args)
        return {
          ok: true,
          detail: `现在心情：${s.mood}；精力 ${Math.round(s.energy * 100)}%；正在：${s.doing}`,
        }
      },
    })

    return 2
  }

  return { now, set, line, lineFor, register, storePath: STORE }
}
