#!/usr/bin/env node
/**
 * skill-usage.mjs —— 按真实使用决定哪些 skill 值得常驻。
 *
 * 扫 DSH 会话日志里的 `skill` 工具调用，统计每个 skill 被取用了几次、最后一次
 * 是什么时候；可选再并入一份 skill-lookup 的查询记录。常驻目录每轮都进上下文，
 * 没用的常驻就是白烧 token，所以按这张表把低频的挪出 `skills/`。
 *
 * 用法：
 *   node scripts/skill-usage.mjs
 *   node scripts/skill-usage.mjs --days 14 --json
 *   node scripts/skill-usage.mjs --events .skill-usage/events.jsonl
 *   node scripts/skill-usage.mjs --out ./tmp/FREQUENCY.md
 *   node scripts/skill-usage.mjs --skills ./skills --archive ./skills-archive
 *
 * 会话日志：<DSH_HOME>/sessions（默认 ~/.dsh/sessions），读
 * session.v4.jsonl.zstd；需要 Node 的 zlib 带 zstdDecompressSync（Node 22.15+）。
 * 默认把表写到 ./.skill-usage/FREQUENCY.md，目录不存在会建。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

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

function resolveFromCwd(value) {
  return path.resolve(cwd, value)
}

/** 给人看的路径：在工作目录里就给相对路径，统一用 /；否则给绝对路径。 */
function display(file) {
  const rel = path.relative(cwd, file)
  if (!rel) return '.'
  const inside = !rel.startsWith('..') && !path.isAbsolute(rel)
  return (inside ? rel : file).split(path.sep).join('/')
}

const HELP = `用法：node scripts/skill-usage.mjs [选项]

  --days <N>        统计最近 N 天（默认 14）
  --json            只把结果打到 stdout，不写文件
  --events <路径>   并入这个 skill-lookup 事件文件（JSONL）；不给就只统计 skill 工具调用
  --out <路径>      表写到哪（默认 ./.skill-usage/FREQUENCY.md）
  --skills <目录>   常驻 skill 根（默认 ./skills）
  --archive <目录>  归档 skill 根（默认 ./skills-archive）
  --off <目录>      额外扫的 skill 根（默认 ~/.agents/skills-off，不存在就跳过）
  -h, --help        看这段

输出列：skill / skill工具 / 查找命中 / 合计 / 最后一次 / 现在在哪。
没被用过的 skill 也在表里，合计显式写 0。`

function parseArgs(argv) {
  const opts = {
    days: 14,
    json: false,
    help: false,
    events: '',
    out: path.join(cwd, '.skill-usage', 'FREQUENCY.md'),
    skills: path.join(cwd, 'skills'),
    archive: path.join(cwd, 'skills-archive'),
    off: path.join(os.homedir(), '.agents', 'skills-off'),
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') {
      opts.json = true
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else if (arg === '--days') {
      const raw = takeValue(argv, i, arg)
      i++
      const days = Number(raw)
      if (!Number.isFinite(days) || days <= 0) fail(`--days 要给正数：${raw}`)
      opts.days = days
    } else if (arg === '--events') {
      opts.events = resolveFromCwd(takeValue(argv, i, arg))
      i++
    } else if (arg === '--out') {
      opts.out = resolveFromCwd(takeValue(argv, i, arg))
      i++
    } else if (arg === '--skills') {
      opts.skills = resolveFromCwd(takeValue(argv, i, arg))
      i++
    } else if (arg === '--archive') {
      opts.archive = resolveFromCwd(takeValue(argv, i, arg))
      i++
    } else if (arg === '--off') {
      opts.off = resolveFromCwd(takeValue(argv, i, arg))
      i++
    } else {
      fail(`不认识的参数：${arg}（用 --help 看用法）`)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log(HELP)
  process.exit(0)
}

const days = opts.days
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const sessionsRoot = path.join(home, 'sessions')
const cutoff = Date.now() - days * 24 * 3600 * 1000

/** DSH 自带的 skill：正常在 `~/.dsh/skills/` 下；有的随安装包发在 `<包>/assets/<name>/SKILL.md`。 */
const bundledNames = new Set()
let bundledReady = false

function scanBundledAssets(pkgsDir) {
  let pkgs
  try {
    pkgs = fs.readdirSync(pkgsDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const pkg of pkgs) {
    if (!pkg.isDirectory()) continue
    const assets = path.join(pkgsDir, pkg.name, 'assets')
    let dirs
    try {
      dirs = fs.readdirSync(assets, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirs) {
      if (d.isDirectory() && fs.existsSync(path.join(assets, d.name, 'SKILL.md'))) bundledNames.add(d.name)
    }
  }
}

function collectBundledNames() {
  if (bundledReady) return bundledNames
  bundledReady = true
  if (process.env.DSH_BUNDLED_SKILL_DIR) {
    let dirs = []
    try {
      dirs = fs.readdirSync(process.env.DSH_BUNDLED_SKILL_DIR, { withFileTypes: true })
    } catch {}
    for (const d of dirs) {
      if (d.isDirectory() && fs.existsSync(path.join(process.env.DSH_BUNDLED_SKILL_DIR, d.name, 'SKILL.md'))) bundledNames.add(d.name)
    }
  }
  // 安装布局：<DSH_HOME>/profiles/<p>/node_modules/<包>/node_modules/@deepseek-ai/*/assets/*/SKILL.md
  const profilesDir = path.join(home, 'profiles')
  let profiles = []
  try {
    profiles = fs.readdirSync(profilesDir, { withFileTypes: true })
  } catch {}
  for (const p of profiles) {
    if (!p.isDirectory()) continue
    const nm = path.join(profilesDir, p.name, 'node_modules')
    let tops = []
    try {
      tops = fs.readdirSync(nm, { withFileTypes: true })
    } catch {}
    for (const t of tops) {
      if (!t.isDirectory()) continue
      scanBundledAssets(path.join(nm, t.name, 'node_modules', '@deepseek-ai'))
    }
  }
  // 全局 npm 安装：%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai
  if (process.env.APPDATA) {
    scanBundledAssets(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  }
  return bundledNames
}

/** 常驻 = 在 skills/ 下（会进每轮目录）；archive/off = 不占目录；内置 = DSH 自带，不归我们挪。 */
function whereSkill(name) {
  if (fs.existsSync(path.join(opts.skills, name, 'SKILL.md'))) return '常驻'
  if (fs.existsSync(path.join(opts.archive, name, 'SKILL.md'))) return 'archive'
  if (fs.existsSync(path.join(opts.off, name, 'SKILL.md'))) return 'off'
  if (fs.existsSync(path.join(home, 'skills', name, 'SKILL.md'))) return '内置'
  if (collectBundledNames().has(name)) return '内置'
  return '不在了'
}

const usage = new Map()

/** source: 'tool' = skill 工具调用，'lookup' = skill-lookup 查找命中。 */
function record(name, at, source) {
  const cur = usage.get(name) ?? { toolCalls: 0, lookups: 0, last: 0 }
  if (source === 'lookup') cur.lookups++
  else cur.toolCalls++
  if (at > cur.last) cur.last = at
  usage.set(name, cur)
}

const files = []
function collect(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collect(p)
    else if (e.name === 'session.v4.jsonl.zstd') {
      let st
      try {
        st = fs.statSync(p)
      } catch {
        continue
      }
      if (st.mtimeMs >= cutoff) files.push({ p, at: st.mtimeMs })
    }
  }
}
collect(sessionsRoot)

const zstd = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : null
if (files.length > 0 && !zstd) {
  fail('坏了：当前 Node 的 zlib 没有 zstdDecompressSync（需要 Node 22.15+），读不了 DSH 会话日志')
}

for (const { p, at } of files) {
  let raw
  try {
    raw = zstd(fs.readFileSync(p)).toString('utf8')
  } catch {
    continue
  }
  for (const line of raw.split('\n')) {
    if (!line.includes('"tool/call"')) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    // 事件是 { type:'tool/call', data:{ turn, step, callId, name, arguments } }
    const d = o.data ?? o
    if (o.type !== 'tool/call' || d.name !== 'skill') continue
    let a = d.arguments
    if (typeof a === 'string') {
      try {
        a = JSON.parse(a)
      } catch {
        continue
      }
    }
    const name = a?.name
    if (typeof name === 'string' && name) record(name, at, 'tool')
  }
}

// 第二个来源（可选）：skill-lookup 的查找事件。
// 没给 --events 是「没启用」；给了但缺文件是「还没建」；有文件但 0 行是「正常 0」；
// 坏行单独报，不糊进 0。
const eventsFile = opts.events
const eventsRel = eventsFile ? display(eventsFile) : ''
let eventCount = 0
let eventLines = 0
const badEventLines = []
let lookupStatus = 'off' // off | missing | empty | ok | broken
let lookupNote = '没启用（没给 --events，只统计 skill 工具调用）'

if (eventsFile) {
  try {
    const raw = fs.readFileSync(eventsFile, 'utf8')
    const lines = raw.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim()
      if (!text) continue
      eventLines++
      let o
      try {
        o = JSON.parse(text)
      } catch (err) {
        badEventLines.push({ line: i + 1, message: err.message })
        continue
      }
      const ts = Number(o?.ts)
      if (!Number.isFinite(ts) || ts < cutoff) continue
      if (!Array.isArray(o.hits)) continue
      eventCount++
      const seen = new Set()
      for (const hit of o.hits) {
        if (typeof hit !== 'string' || !hit || seen.has(hit)) continue
        seen.add(hit)
        record(hit, ts, 'lookup')
      }
    }
    if (eventLines === 0) {
      lookupStatus = 'empty'
      lookupNote = '正常 0（文件在、还没记录过查询）'
    } else if (badEventLines.length === eventLines) {
      lookupStatus = 'broken'
      lookupNote = '坏了（文件在、0 条可用）'
    } else {
      lookupStatus = 'ok'
      lookupNote = `正常 ${eventCount} 条（最近 ${days} 天）`
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      lookupStatus = 'missing'
      lookupNote = `还没建（缺 ${eventsRel}）`
    } else {
      lookupStatus = 'broken'
      lookupNote = `坏了（读不出 ${eventsRel}：${err.message}）`
      console.error(`坏了：读不出 ${eventsRel}：${err.message}`)
    }
  }
}

// 坏行行号只进 stderr；stdout 只用一行汇总，免得糊。
for (const b of badEventLines) {
  console.error(`坏了：${eventsRel} 第 ${b.line} 行解析失败：${b.message}`)
}
const lookupLine = `查找命中：${lookupNote}`
const lookupEventsInfo = {
  status: lookupStatus,
  message: lookupNote,
  file: eventsFile ? eventsRel : null,
  lines: eventLines,
  badLines: badEventLines.map((b) => b.line),
}

// 几个根目录下所有「有 SKILL.md」的 skill。没被用过的也要露脸（合计显式 0），
// 否则表里看不见，就没法判断该不该挪。
const skillRoots = [opts.skills, opts.archive, opts.off]
const known = new Set()
for (const root of skillRoots) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    continue
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (fs.existsSync(path.join(root, e.name, 'SKILL.md'))) known.add(e.name)
  }
}
for (const name of known) {
  if (!usage.has(name)) usage.set(name, { toolCalls: 0, lookups: 0, last: 0 })
}

const rows = [...usage.entries()]
  .map(([name, u]) => ({
    name,
    toolCalls: u.toolCalls,
    lookups: u.lookups,
    calls: u.toolCalls + u.lookups,
    last: u.last ? new Date(u.last).toLocaleDateString('sv-SE') : '-',
    where: whereSkill(name),
  }))
  // 合计降序；合计相同常驻优先（要审的就是常驻）；再按名字。
  .sort(
    (a, b) =>
      b.calls - a.calls ||
      Number(b.where === '常驻') - Number(a.where === '常驻') ||
      a.name.localeCompare(b.name),
  )

if (opts.json) {
  console.log(JSON.stringify({
    days,
    scanned: files.length,
    events: eventCount,
    lookupEvents: lookupEventsInfo,
    rows,
  }, null, 2))
  process.exit(0)
}

const scannedLine = eventsFile
  ? `扫了 ${files.length} 个会话、${eventCount} 条查找事件（最近 ${days} 天）`
  : `扫了 ${files.length} 个会话（最近 ${days} 天，没并查找事件）`
console.log(scannedLine)
console.log(lookupLine)
if (badEventLines.length) console.log(`坏了：${badEventLines.length} 行解析失败（行号见 stderr）`)
console.log('skill                skill工具  查找命中  合计  最后一次    现在在哪')
for (const r of rows) {
  console.log(
    `${r.name.padEnd(20)}  ${String(r.toolCalls).padStart(4)}  ${String(r.lookups).padStart(6)}  ${String(r.calls).padStart(4)}  ${r.last}  ${r.where}`,
  )
}

// 落盘：人读的表（不给 --events 时「查找命中」恒为 0）
try {
  const lookupSourceLine = eventsFile
    ? `- **查找命中**：\`${eventsRel}\` 里每次关键词查询 / \`--path\` 的 hits；同一次查询里同名的只算一次，\`--all\` 不算使用。`
    : '- **查找命中**：没启用（没给 `--events`）；这一列恒为 0，只看 `skill` 工具那列。'
  const md = [
    '# skill 使用频率（自动生成，别手改）',
    '',
    eventsFile
      ? `统计窗口：最近 ${days} 天，扫了 ${files.length} 个会话 + ${eventCount} 条 skill-lookup 事件；查找命中：${lookupNote}${lookupStatus !== 'broken' && badEventLines.length ? `；坏了：${badEventLines.length} 行解析失败` : ''}。`
      : `统计窗口：最近 ${days} 天，扫了 ${files.length} 个会话；没并 skill-lookup 事件（没给 \`--events\`），只统计 \`skill\` 工具调用。`,
    '来源 = 会话日志里的 `skill` 工具调用 +（可选）skill-lookup 的查找命中。',
    '- **skill工具**：`<DSH_HOME>/sessions/**/session.v4.jsonl.zstd` 里 `type:\'tool/call\'` 且 `name:\'skill\'` 的调用。',
    lookupSourceLine,
    '合计 = 两个来源相加，按合计降序；合计相同时常驻排前面（要审的就是常驻），再按名字。',
    '没被用过的 skill 也在表里，合计显式写 0（「最后一次」记 -）。',
    `重跑：\`node scripts/skill-usage.mjs --days ${days}\``,
    '',
    `> 常驻 = \`${display(opts.skills)}/\`（每轮进目录）；archive = \`${display(opts.archive)}/\`；off = \`${display(opts.off)}/\`；内置 = DSH 自带（\`<DSH_HOME>/skills/\` 或随安装包放在 assets 里），不归我们挪。`,
    '> 内置的不参与「该不该挪进 archive」的判断：挪不挪归 DSH，不归我们。',
    '> 规则：只有**真用过、频率高**的才留在常驻；其余按需查表再读文件。',
    '',
    '| skill | skill工具 | 查找命中 | 合计 | 最后一次 | 现在在哪 |',
    '|---|---:|---:|---:|---|---|',
    ...rows.map((r) => `| ${r.name} | ${r.toolCalls} | ${r.lookups} | ${r.calls} | ${r.last} | ${r.where} |`),
    '',
  ].join('\n')
  fs.mkdirSync(path.dirname(opts.out), { recursive: true })
  fs.writeFileSync(opts.out, md)
  console.log(`\n写好了：${display(opts.out)}`)
} catch (err) {
  console.error('落盘失败：', err.message)
}
