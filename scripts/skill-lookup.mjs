#!/usr/bin/env node
/**
 * skill-lookup.mjs —— 接活前先查有没有现成的 skill，常驻和搬走的都查。
 *
 * 常驻目录只放高频的（目录每轮都进上下文）；低频的挪去 skills-archive/，
 * 真要用时先按关键词查，命中就把那份 SKILL.md 读出来，连同需求一起派给 worker。
 *
 * 用法：
 *   node scripts/skill-lookup.mjs qq 桥
 *   node scripts/skill-lookup.mjs --all
 *   node scripts/skill-lookup.mjs --path qq-reply
 *   node scripts/skill-lookup.mjs qq --events .skill-usage/events.jsonl
 *
 * 默认扫 <cwd>/skills（常驻）、<cwd>/skills-archive（archive），再扫
 * ~/.agents/skills-off（只在存在时）。三根都能用参数改。
 *
 * 记账是可选的：给了 --events 才往那个文件追加一行
 *   {"ts":毫秒, "kind":"query"|"all"|"path", "query":"...", "hits":["name",...]}
 * `--all` 的 hits 恒为空（只算查看，不算使用）；写失败只打 stderr，不影响查询。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const cwd = process.cwd()

function fail(message) {
  console.error(message)
  process.exit(1)
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`${flag} 后面要给个值`)
  return value
}

const HELP = `用法：node scripts/skill-lookup.mjs <关键词...>
      node scripts/skill-lookup.mjs --all
      node scripts/skill-lookup.mjs --path <名字>

  --all             全列一遍（名字 + 一句话 + 位置）
  --path <名字>     只要这一份 SKILL.md 的路径
  --events <路径>   可选：把每次查询追加进这个 JSONL，给 skill-usage.mjs --events 用
  --skills <目录>   常驻根（默认 ./skills）
  --archive <目录>  归档根（默认 ./skills-archive）
  --off <目录>      第三根（默认 ~/.agents/skills-off，存在才扫）
  -h, --help        看这段

退出码：0 = 有命中 / 列表；2 = 关键词没命中；1 = 用法错误或 --path 没找到。`

function parseArgs(argv) {
  const opts = {
    help: false,
    all: false,
    pathOnly: '',
    hasPath: false,
    events: '',
    skills: path.join(cwd, 'skills'),
    archive: path.join(cwd, 'skills-archive'),
    off: path.join(os.homedir(), '.agents', 'skills-off'),
    query: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else if (arg === '--all') {
      opts.all = true
    } else if (arg === '--path') {
      opts.pathOnly = takeValue(argv, i, arg)
      opts.hasPath = true
      i++
    } else if (arg === '--events') {
      opts.events = path.resolve(cwd, takeValue(argv, i, arg))
      i++
    } else if (arg === '--skills') {
      opts.skills = path.resolve(cwd, takeValue(argv, i, arg))
      i++
    } else if (arg === '--archive') {
      opts.archive = path.resolve(cwd, takeValue(argv, i, arg))
      i++
    } else if (arg === '--off') {
      opts.off = path.resolve(cwd, takeValue(argv, i, arg))
      i++
    } else if (arg.startsWith('--')) {
      fail(`不认识的参数：${arg}（用 --help 看用法）`)
    } else {
      opts.query.push(arg)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log(HELP)
  process.exit(0)
}

const roots = [
  { dir: opts.skills, where: '常驻' },
  { dir: opts.archive, where: 'archive' },
]
if (fs.existsSync(opts.off)) roots.push({ dir: opts.off, where: 'off' })

function readSkill(dir) {
  const f = path.join(dir, 'SKILL.md')
  let text
  try {
    text = fs.readFileSync(f, 'utf8')
  } catch {
    return null
  }
  const dm = text.match(/^description:\s*(.+)$/m)
  const desc = dm ? dm[1].trim() : ''
  // 描述可能是多行折叠的，补一下后续缩进行
  const multiline = text.match(/^description:\s*[>|][-+]?\s*\n((?:\s{2,}.*\n)+)/m)
  return { dir, file: f, name: path.basename(dir), desc: multiline ? multiline[1].replace(/\s+/g, ' ').trim() : desc, text }
}

const all = []
for (const r of roots) {
  let entries = []
  try {
    entries = fs.readdirSync(r.dir, { withFileTypes: true })
  } catch {
    continue
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const s = readSkill(path.join(r.dir, e.name))
    if (s) all.push({ ...s, where: r.where })
  }
}

const WHERE_RANK = { 常驻: 0, archive: 1, off: 2 }

/** 记账；没给 --events 就什么都不做。任何失败吞掉，只在 stderr 提醒一句。 */
function logEvent(kind, query, hitNames) {
  if (!opts.events) return
  try {
    const hits = [...new Set(hitNames.filter((n) => typeof n === 'string' && n))]
    const line = JSON.stringify({ ts: Date.now(), kind, query: String(query ?? ''), hits })
    fs.mkdirSync(path.dirname(opts.events), { recursive: true })
    fs.appendFileSync(opts.events, line + '\n')
  } catch (err) {
    console.error(`记 skill 使用事件失败（不影响查询）：${err.message}`)
  }
}

if (opts.hasPath) {
  const want = opts.pathOnly
  const hit = all.find((s) => s.name === want)
  logEvent('path', want, hit ? [hit.name] : [])
  if (!hit) {
    console.error(`没有这个 skill：${want}`)
    process.exit(1)
  }
  console.log(hit.file)
  process.exit(0)
}

if (opts.all || opts.query.length === 0) {
  logEvent('all', '--all', [])
  for (const s of all.sort(
    (a, b) => (WHERE_RANK[a.where] ?? 9) - (WHERE_RANK[b.where] ?? 9) || a.name.localeCompare(b.name),
  )) {
    console.log(`[${s.where}] ${s.name} —— ${s.desc.slice(0, 90)}`)
  }
  process.exit(0)
}

const rawQuery = opts.query.join(' ')
const q = rawQuery.toLowerCase()
const hits = all.filter((s) => s.name.toLowerCase().includes(q) || s.desc.toLowerCase().includes(q) || s.text.toLowerCase().includes(q))
logEvent('query', rawQuery, hits.map((s) => s.name))
if (hits.length === 0) {
  console.log(`没找到跟「${rawQuery}」有关的 skill。先干活，干完值得留就写成一份。`)
  process.exit(2)
}
for (const s of hits) {
  console.log(`[${s.where}] ${s.name} —— ${s.desc.slice(0, 90)}`)
  console.log(`    ${s.file}`)
}
