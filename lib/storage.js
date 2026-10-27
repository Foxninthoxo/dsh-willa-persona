'use strict'

/**
 * 本地 JSON 存储：记忆 + 心账 + 称呼 + 定时与唤醒。
 *
 * 目录按 DSH 约定落在 `<DSH_HOME>/storages/dsh-willa-persona/`，
 * 空库起步，不读取、不迁移任何外部数据。写入用临时文件 + fsync + rename，
 * 避免进程中途退出留下半截 JSON。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const STORAGE_DIR_NAME = 'dsh-willa-persona'
const MEMORY_FILE = 'memory.json'
const XINCHANG_FILE = 'xinchang.json'
const SCHEDULES_FILE = 'schedules.json'
const WANDER_FILE = 'wander.json'
const OWNER_FILE = 'owner.json'
const MAX_MEMORY_ITEMS = 5000
const MAX_MEMORY_TEXT = 20000
const MAX_PERSON_ID = 128
const MAX_OWNER_NAME = 40
const MAX_OWNER_NOTE = 500
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const SLOTS = Object.freeze(['家人', '恋人', '闺蜜', '朋友', '搭子', '同学', '熟人', '不对付', '说不清'])
const EMOTION_KINDS = Object.freeze([
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
])

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

function storageDir() {
  return path.join(dshHome(), 'storages', STORAGE_DIR_NAME)
}

function memoryPath() {
  return path.join(storageDir(), MEMORY_FILE)
}

function xinchangPath() {
  return path.join(storageDir(), XINCHANG_FILE)
}

function schedulesPath() {
  return path.join(storageDir(), SCHEDULES_FILE)
}

function wanderPath() {
  return path.join(storageDir(), WANDER_FILE)
}

function ownerPath() {
  return path.join(storageDir(), OWNER_FILE)
}

function nowIso() {
  return new Date().toISOString()
}

function round1(n) {
  return Math.round(n * 10) / 10
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 用户可控字符串当对象键时一律先过这里。 */
function isDangerousKey(key) {
  return DANGEROUS_KEYS.has(String(key))
}

/** 只写 own property，不触发 __proto__ setter，也不落进原型链。 */
function putOwn(target, key, value) {
  Object.defineProperty(target, String(key), {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
  return value
}

function getOwn(target, key) {
  const name = String(key)
  if (isDangerousKey(name)) return undefined
  return Object.hasOwn(target, name) ? target[name] : undefined
}

function personKey(personId, field) {
  const id = String(personId ?? '').trim()
  if (!id) throw new Error(`${field} 要给个 personId`)
  if (id.length > MAX_PERSON_ID) throw new Error(`personId 太长（上限 ${MAX_PERSON_ID} 字）`)
  if (isDangerousKey(id)) throw new Error('personId 不能用 __proto__ / constructor / prototype')
  return id
}

/**
 * 给模型看的存储位置：相对 DSH_HOME，统一用 /。
 * 绝不把本机绝对路径写进工具输出或错误。
 */
function displayPath(file) {
  const abs = String(file ?? '')
  const home = dshHome()
  const rel = path.relative(home, abs)
  const safeRel = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(abs)
  return safeRel.split(path.sep).join('/')
}

function warnLog(message) {
  try {
    console.warn(`[dsh-willa-persona] ${message}`)
  } catch {
    /* 没有 console 也不能因为日志挂掉 */
  }
}

/** 坏文件先改名留档，返回备份路径；改名失败返回 null。 */
function backupCorrupt(file) {
  const dir = path.dirname(file)
  const base = path.basename(file).replace(/\.json$/i, '')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(dir, `${base}.corrupt-${stamp}.json`)
  try {
    fs.renameSync(file, target)
    return target
  } catch (error) {
    warnLog(`坏文件备份不了（${displayPath(file)}）：${String(error?.message ?? error).slice(0, 120)}`)
    return null
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}.tmp`
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 临时文件可能根本没建出来 */
    }
    throw error
  }
}

function readJson(file) {
  if (!fs.existsSync(file)) return null
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    const reason = String(error?.code ?? error?.message ?? '读取失败').slice(0, 80)
    throw new Error(`存储文件读不出来：${displayPath(file)}（${reason}）`)
  }
  if (!raw.trim()) {
    const backup = backupCorrupt(file)
    warnLog(`存储文件是空的，已备份为 ${backup ? displayPath(backup) : '（备份失败）'}，按空库继续：${displayPath(file)}`)
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    const backup = backupCorrupt(file)
    warnLog(`存储文件不是合法 JSON，已备份为 ${backup ? displayPath(backup) : '（备份失败）'}，按空库继续：${displayPath(file)}`)
    return null
  }
}

/* ------------------------------------------------------------------ 记忆 */

function emptyMemory() {
  return { version: 1, updatedAt: null, items: [] }
}

function normalizeMemoryItem(item) {
  if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim()) return null
  const embedding = Array.isArray(item.embedding)
    ? item.embedding.map(Number).filter((n) => Number.isFinite(n))
    : undefined
  return {
    id: typeof item.id === 'string' && item.id ? item.id : newId('m'),
    text: item.text,
    channel: typeof item.channel === 'string' && item.channel ? item.channel : 'main',
    people: Array.isArray(item.people) ? item.people.map(String) : [],
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    createdAt: typeof item.createdAt === 'string' && item.createdAt ? item.createdAt : nowIso(),
    superseded: item.superseded === true,
    ...(embedding && embedding.length > 0 ? { embedding } : {}),
  }
}

function normalizeMemory(raw) {
  const store = emptyMemory()
  if (!raw || typeof raw !== 'object') return store
  if (Number.isFinite(Number(raw.version))) store.version = Number(raw.version)
  if (typeof raw.updatedAt === 'string' && raw.updatedAt) store.updatedAt = raw.updatedAt
  if (Array.isArray(raw.items)) {
    store.items = raw.items.map(normalizeMemoryItem).filter(Boolean)
  }
  return store
}

function loadMemory() {
  return normalizeMemory(readJson(memoryPath()))
}

function saveMemory(store) {
  const next = normalizeMemory(store)
  next.updatedAt = nowIso()
  atomicWriteJson(memoryPath(), next)
  return next
}

function addMemory(input = {}) {
  const text = String(input.text ?? '').trim()
  if (!text) throw new Error('记什么？正文不能空')
  if (text.length > MAX_MEMORY_TEXT) throw new Error(`正文太长（上限 ${MAX_MEMORY_TEXT} 字）`)

  const embedding = Array.isArray(input.embedding)
    ? input.embedding.map(Number).filter((n) => Number.isFinite(n))
    : undefined

  const item = {
    id: newId('m'),
    text,
    channel: typeof input.channel === 'string' && input.channel.trim() ? input.channel.trim() : 'main',
    people: Array.isArray(input.people) ? input.people.map(String) : [],
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    createdAt: nowIso(),
    superseded: false,
    ...(embedding && embedding.length > 0 ? { embedding } : {}),
  }

  const store = loadMemory()
  store.items.push(item)
  if (store.items.length > MAX_MEMORY_ITEMS) {
    // 超上限时先丢最老的过时条目，再丢最老的普通条目。
    const over = store.items.length - MAX_MEMORY_ITEMS
    const stale = store.items.filter((it) => it.superseded).slice(0, over)
    if (stale.length > 0) {
      const staleIds = new Set(stale.map((it) => it.id))
      store.items = store.items.filter((it) => !staleIds.has(it.id))
    }
    if (store.items.length > MAX_MEMORY_ITEMS) {
      store.items = store.items.slice(-MAX_MEMORY_ITEMS)
    }
  }
  saveMemory(store)
  return item
}

function deleteMemory(id) {
  const target = String(id ?? '')
  if (!target) return false
  const store = loadMemory()
  const before = store.items.length
  store.items = store.items.filter((it) => it.id !== target)
  if (store.items.length === before) return false
  saveMemory(store)
  return true
}

function searchTerms(query) {
  const q = String(query ?? '').toLowerCase()
  const terms = new Set([q])
  for (const term of q.split(/[\s,，。;；:：?？!！、/|()（）[\]【】"'“”‘’]+/)) {
    if (term) terms.add(term)
  }
  const cjk = q.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < cjk.length - 1; i += 1) terms.add(cjk.slice(i, i + 2))
  return [...terms].filter(Boolean)
}

function keywordScore(item, query, terms = searchTerms(query)) {
  const haystack = [item.text, item.channel, (item.tags ?? []).join(' '), (item.people ?? []).join(' ')]
    .join(' ')
    .toLowerCase()
  const q = String(query ?? '').toLowerCase()
  if (q && haystack.includes(q)) return 1
  let hits = 0
  for (const term of terms) {
    if (term && haystack.includes(term)) hits += 1
  }
  return Math.min(0.9, hits / Math.max(1, terms.length))
}

function passesFilter(item, channel, personId) {
  if (channel && item.channel !== channel) return false
  if (personId) {
    const hitPerson = (item.people ?? []).includes(personId)
    const hitChannel = item.channel === personId
    if (!hitPerson && !hitChannel) return false
  }
  return true
}

function recallMemory(query, options = {}) {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('要查什么？给个 query')
  const k = Math.min(20, Math.max(1, Number(options.k) || 6))
  const channel = String(options.channel ?? '').trim()
  const personId = String(options.personId ?? '').trim()
  const terms = searchTerms(q)
  const hits = []

  for (const item of loadMemory().items) {
    if (item.superseded) continue
    if (!passesFilter(item, channel, personId)) continue
    const score = keywordScore(item, q, terms)
    if (score <= 0) continue
    hits.push({ item, score, mode: 'keyword' })
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return String(b.item.createdAt).localeCompare(String(a.item.createdAt))
  })
  return hits.slice(0, k)
}

function supersedeMemory(text) {
  const needle = String(text ?? '').trim()
  if (!needle) throw new Error('要标哪条？给一段原文')
  const store = loadMemory()
  let changed = 0
  for (const item of store.items) {
    if (!item.superseded && item.text.includes(needle)) {
      item.superseded = true
      changed += 1
    }
  }
  if (changed > 0) saveMemory(store)
  return changed
}

function memoryStats() {
  const store = loadMemory()
  // 频道名来自模型输入，同样不能落进普通对象下标。
  const byChannel = Object.create(null)
  let active = 0
  let superseded = 0
  let withEmbedding = 0
  for (const item of store.items) {
    byChannel[item.channel] = (byChannel[item.channel] ?? 0) + 1
    if (item.superseded) superseded += 1
    else active += 1
    if (Array.isArray(item.embedding) && item.embedding.length > 0) withEmbedding += 1
  }
  return {
    total: store.items.length,
    active,
    superseded,
    withEmbedding,
    byChannel,
    updatedAt: store.updatedAt,
    store: displayPath(memoryPath()),
  }
}

/* ------------------------------------------------------- 可选向量检索 */

function embeddingsUrl(endpoint) {
  const raw = String(endpoint ?? '').trim()
  if (!raw) return ''
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('embeddingEndpoint 不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('embeddingEndpoint 只支持 http/https')
  }
  const base = url.href.replace(/\/+$/, '')
  if (/\/embeddings$/i.test(base)) return base
  if (/\/v1$/i.test(base)) return `${base}/embeddings`
  return `${base}/v1/embeddings`
}

async function embedText(endpoint, model, text, signal) {
  const url = embeddingsUrl(endpoint)
  if (!url) throw new Error('没有配置 embeddingEndpoint')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  const onAbort = () => controller.abort()
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: String(text), model: String(model || '') }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`embedding 服务返回 HTTP ${response.status}`)
    const json = await response.json()
    const vector = json?.data?.[0]?.embedding
    if (!Array.isArray(vector) || vector.length === 0) throw new Error('embedding 返回格式不对')
    const numbers = vector.map(Number).filter((n) => Number.isFinite(n))
    if (numbers.length === 0) throw new Error('embedding 返回空向量')
    return numbers
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / Math.sqrt(na * nb)
}

async function noteMemory(text, options = {}, embedConfig = {}) {
  let embedding
  let warning = ''
  if (embedConfig.endpoint) {
    try {
      embedding = await embedText(embedConfig.endpoint, embedConfig.model, text, embedConfig.signal)
    } catch {
      warning = '向量暂不可用，已只存文本'
    }
  }
  const item = addMemory({ ...options, text, embedding })
  return { item, warning }
}

async function searchMemory(query, options = {}, embedConfig = {}) {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('要查什么？给个 query')
  const k = Math.min(20, Math.max(1, Number(options.k) || 6))
  const channel = String(options.channel ?? '').trim()
  const personId = String(options.personId ?? '').trim()

  if (!embedConfig.endpoint) {
    return { hits: recallMemory(q, { k, channel, personId }), mode: 'keyword' }
  }

  let queryVector
  try {
    queryVector = await embedText(embedConfig.endpoint, embedConfig.model, q, embedConfig.signal)
  } catch {
    return { hits: recallMemory(q, { k, channel, personId }), mode: 'keyword-fallback' }
  }

  const terms = searchTerms(q)
  const hits = []
  for (const item of loadMemory().items) {
    if (item.superseded) continue
    if (!passesFilter(item, channel, personId)) continue
    let score = 0
    if (Array.isArray(item.embedding) && item.embedding.length > 0) {
      score = Math.max(0, cosine(queryVector, item.embedding))
      if (score < 0.25) score = keywordScore(item, q, terms) * 0.5
    } else {
      score = keywordScore(item, q, terms) * 0.9
    }
    if (score > 0) hits.push({ item, score, mode: 'vector' })
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return String(b.item.createdAt).localeCompare(String(a.item.createdAt))
  })
  const top = hits.slice(0, k)
  if (top.length === 0) return { hits: recallMemory(q, { k, channel, personId }), mode: 'keyword-fallback' }
  return { hits: top, mode: 'vector' }
}

/* ------------------------------------------------------------------ 心账 */

function emptyXinchang() {
  // 用无原型对象：personId 是用户可控字符串，不能让它摸到 Object.prototype。
  return { version: 1, updatedAt: null, people: Object.create(null) }
}

function normalizePerson(person) {
  if (!person || typeof person !== 'object') return null
  return {
    score: Number.isFinite(Number(person.score)) ? Number(person.score) : 0,
    msgs: Number.isFinite(Number(person.msgs)) ? Math.max(0, Math.floor(Number(person.msgs))) : 0,
    best: Number.isFinite(Number(person.best)) ? Number(person.best) : 0,
    firstAt: typeof person.firstAt === 'string' && person.firstAt ? person.firstAt : nowIso(),
    lastAt: typeof person.lastAt === 'string' && person.lastAt ? person.lastAt : nowIso(),
    slot: typeof person.slot === 'string' && person.slot ? person.slot : null,
    note: typeof person.note === 'string' ? person.note : '',
    emotions: Array.isArray(person.emotions) ? person.emotions.filter((e) => e && typeof e === 'object') : [],
  }
}

function normalizeXinchang(raw) {
  const store = emptyXinchang()
  if (!raw || typeof raw !== 'object') return store
  if (Number.isFinite(Number(raw.version))) store.version = Number(raw.version)
  if (typeof raw.updatedAt === 'string' && raw.updatedAt) store.updatedAt = raw.updatedAt
  if (raw.people && typeof raw.people === 'object' && !Array.isArray(raw.people)) {
    for (const [id, person] of Object.entries(raw.people)) {
      // 历史坏数据里若带 __proto__ / constructor，直接跳过。
      if (isDangerousKey(id)) continue
      const normalized = normalizePerson(person)
      if (normalized) putOwn(store.people, String(id), normalized)
    }
  }
  return store
}

function loadXinchang() {
  return normalizeXinchang(readJson(xinchangPath()))
}

function saveXinchang(store) {
  const next = normalizeXinchang(store)
  next.updatedAt = nowIso()
  atomicWriteJson(xinchangPath(), next)
  return next
}

function ensurePerson(store, personId) {
  const id = personKey(personId, '记谁的账')
  const existing = getOwn(store.people, id)
  if (!existing) {
    return putOwn(store.people, id, {
      score: 0,
      msgs: 0,
      best: 0,
      firstAt: nowIso(),
      lastAt: nowIso(),
      slot: null,
      note: '',
      emotions: [],
    })
  }
  return existing
}

function decayPerson(person) {
  const now = Date.now()
  person.emotions = (person.emotions ?? [])
    .map((emotion) => {
      const peak = Date.parse(emotion.peakAt ?? nowIso())
      const halfLifeMs = Number(emotion.halfLifeMs ?? 5_400_000)
      if (!Number.isFinite(peak) || !Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return null
      const intensity = Number(emotion.intensity ?? 0) * Math.pow(0.5, (now - peak) / halfLifeMs)
      if (intensity < 0.02) return null
      return { ...emotion, intensity: round1(intensity) }
    })
    .filter(Boolean)
  return person.emotions
}

function getXinchang(personId) {
  const id = personKey(personId, '要看谁的账')
  const person = getOwn(loadXinchang().people, id)
  if (!person) return null
  decayPerson(person)
  return { personId: id, ...person }
}

function adjustXinchang(personId, options = {}) {
  const id = personKey(personId, '记谁的账')
  const reason = String(options.reason ?? '').trim()
  if (!reason) throw new Error('记一笔得写清为什么（reason 不能空）')
  if (reason.length > 500) throw new Error('reason 太长（上限 500 字）')

  const delta = Number.isFinite(Number(options.delta)) ? Number(options.delta) : 0
  const kind = EMOTION_KINDS.includes(options.kind) ? options.kind : null
  const store = loadXinchang()
  const person = ensurePerson(store, id)

  person.score = round1(clamp(person.score + delta, -10, 10))
  person.best = Math.max(person.best ?? 0, person.score)
  person.msgs = (person.msgs ?? 0) + 1
  person.lastAt = nowIso()
  person.note = `${delta >= 0 ? '+' : ''}${delta} ${reason}`.trim()

  if (kind || delta !== 0) {
    decayPerson(person)
    // 气多久看交情：分越高，消得越快；这个时长只影响自己，不告诉对方。
    const factor = clamp(1.6 - person.score * 0.12, 0.25, 2.2)
    person.emotions.push({
      kind: kind ?? (delta >= 0 ? 'happy' : 'angry'),
      intensity: round1(clamp(Math.abs(delta) || 0.3, 0.1, 1)),
      reason,
      peakAt: nowIso(),
      halfLifeMs: Math.round(5_400_000 * factor),
    })
    person.emotions = person.emotions.slice(-12)
  }

  saveXinchang(store)
  return { personId: id, score: person.score, delta, note: person.note }
}

function setXinchangSlot(personId, slot) {
  const id = personKey(personId, '给谁定格子')
  const value = String(slot ?? '').trim()
  if (value !== '撤' && value !== '' && value !== 'null' && !SLOTS.includes(value)) {
    throw new Error(`格子只能是：${SLOTS.join('／')}（或者「撤」）`)
  }
  const store = loadXinchang()
  const person = ensurePerson(store, id)
  person.slot = value === '撤' || value === '' || value === 'null' ? null : value
  person.lastAt = nowIso()
  saveXinchang(store)
  return { personId: id, slot: person.slot }
}

function listXinchang() {
  const store = loadXinchang()
  const rows = Object.entries(store.people).map(([personId, person]) => {
    decayPerson(person)
    return {
      personId,
      score: person.score,
      slot: person.slot ?? '',
      msgs: person.msgs ?? 0,
      note: person.note ?? '',
      lastAt: person.lastAt ?? '',
    }
  })
  rows.sort((a, b) => b.score - a.score)
  return rows
}

function deleteXinchang(personId) {
  const id = String(personId ?? '').trim()
  if (!id || isDangerousKey(id)) return false
  const store = loadXinchang()
  if (!Object.hasOwn(store.people, id)) return false
  delete store.people[id]
  saveXinchang(store)
  return true
}

function xinchangStats() {
  const store = loadXinchang()
  return { people: Object.keys(store.people).length, updatedAt: store.updatedAt, store: displayPath(xinchangPath()) }
}

/* ------------------------------------------------------------ 对方怎么称呼 */

function cleanOwnerText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeOwner(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.name !== 'string') return null
  const name = cleanOwnerText(raw.name).slice(0, MAX_OWNER_NAME)
  if (!name) return null
  const note = typeof raw.note === 'string' ? cleanOwnerText(raw.note).slice(0, MAX_OWNER_NOTE) : ''
  return {
    name,
    note,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : null,
  }
}

/**
 * 读对方的名字。没有 owner.json 就返回 null（人设里用「你」）。
 * 坏 JSON 由 readJson 备份；合法 JSON 但结构不对的也备份，再当没有。
 */
function loadOwner() {
  const file = ownerPath()
  const existed = fs.existsSync(file)
  const raw = readJson(file)
  if (raw === null) {
    // 文件本来在、读回来却是 null：内容就是 JSON null，同样留档再当没有。
    if (existed && fs.existsSync(file)) {
      const backup = backupCorrupt(file)
      warnLog(
        `owner.json 不是有效对象，已备份为 ${backup ? displayPath(backup) : '（备份失败）'}，按未设置处理：${displayPath(file)}`,
      )
    }
    return null
  }
  const owner = normalizeOwner(raw)
  if (owner) return owner
  const backup = backupCorrupt(file)
  warnLog(
    `owner.json 结构不对，已备份为 ${backup ? displayPath(backup) : '（备份失败）'}，按未设置处理：${displayPath(file)}`,
  )
  return null
}

/** 记下对方怎么称呼。name 1-40 字，note 可选。 */
function setOwner(name, note) {
  const value = cleanOwnerText(name)
  if (!value) throw new Error('怎么称呼？name 不能空')
  if (value.length > MAX_OWNER_NAME) throw new Error(`name 太长（上限 ${MAX_OWNER_NAME} 字）`)
  if (note !== undefined && note !== null && typeof note !== 'string') {
    throw new Error('note 要给一句话')
  }
  const owner = {
    name: value,
    note: cleanOwnerText(note).slice(0, MAX_OWNER_NOTE),
    updatedAt: nowIso(),
  }
  atomicWriteJson(ownerPath(), owner)
  return owner
}

/* -------------------------------------------------------------- 定时 / 醒 */

function emptySchedules() {
  return { version: 1, updatedAt: null, items: [] }
}

function loadSchedules() {
  const raw = readJson(schedulesPath())
  if (!raw || typeof raw !== 'object') return emptySchedules()
  return {
    version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    items: Array.isArray(raw.items) ? raw.items : [],
  }
}

function saveSchedules(store) {
  const next = {
    version: 1,
    updatedAt: nowIso(),
    items: Array.isArray(store?.items) ? store.items : [],
  }
  atomicWriteJson(schedulesPath(), next)
  return next
}

function emptyWander() {
  return { version: 1, updatedAt: null, nextAt: null, lastAt: null, lastResult: null }
}

function loadWander() {
  const raw = readJson(wanderPath())
  if (!raw || typeof raw !== 'object') return emptyWander()
  return {
    version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    nextAt: typeof raw.nextAt === 'string' ? raw.nextAt : null,
    lastAt: typeof raw.lastAt === 'string' ? raw.lastAt : null,
    lastResult: typeof raw.lastResult === 'string' ? raw.lastResult : null,
  }
}

function saveWander(store) {
  const next = {
    version: 1,
    updatedAt: nowIso(),
    nextAt: typeof store?.nextAt === 'string' ? store.nextAt : null,
    lastAt: typeof store?.lastAt === 'string' ? store.lastAt : null,
    lastResult: typeof store?.lastResult === 'string' ? store.lastResult : null,
  }
  atomicWriteJson(wanderPath(), next)
  return next
}

/* ------------------------------------------------------------------ 建库 */

function ensureStores() {
  fs.mkdirSync(storageDir(), { recursive: true })
  if (!fs.existsSync(memoryPath())) atomicWriteJson(memoryPath(), emptyMemory())
  if (!fs.existsSync(xinchangPath())) atomicWriteJson(xinchangPath(), emptyXinchang())
  if (!fs.existsSync(schedulesPath())) atomicWriteJson(schedulesPath(), emptySchedules())
  if (!fs.existsSync(wanderPath())) atomicWriteJson(wanderPath(), emptyWander())
  // owner.json 不预建：没有它才会问对方怎么称呼。
  return {
    memory: memoryPath(),
    xinchang: xinchangPath(),
    schedules: schedulesPath(),
    wander: wanderPath(),
  }
}

module.exports = {
  STORAGE_DIR_NAME,
  SLOTS,
  EMOTION_KINDS,
  MAX_OWNER_NAME,
  MAX_OWNER_NOTE,
  dshHome,
  storageDir,
  memoryPath,
  xinchangPath,
  schedulesPath,
  wanderPath,
  ownerPath,
  ensureStores,
  emptyMemory,
  loadMemory,
  saveMemory,
  addMemory,
  deleteMemory,
  recallMemory,
  noteMemory,
  searchMemory,
  supersedeMemory,
  memoryStats,
  embeddingsUrl,
  emptyXinchang,
  loadXinchang,
  saveXinchang,
  getXinchang,
  adjustXinchang,
  setXinchangSlot,
  listXinchang,
  deleteXinchang,
  xinchangStats,
  loadOwner,
  setOwner,
  emptySchedules,
  loadSchedules,
  saveSchedules,
  emptyWander,
  loadWander,
  saveWander,
}
