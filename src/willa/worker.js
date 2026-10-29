/**
 * worker.js —— 把活丢给另一个 agent（dsh headless 一次性会话）。
 *
 * 门房（web 会话）只回 QQ；重活 spawn 一个独立进程去干，输出落到
 * `willaDataDir/workers/<id>.log`，干完把结果抄回来。
 *
 * 2026-10-29 Fox 要求：门房派完立刻回来，worker 干完主动把结果送回来
 * （之前门房在会话里等结果，回话延迟最高 745 秒）。
 * 所以这里在子进程 exit 时写 `<id>.done.json`，再回调 onFinish 让插件注入一句话。
 *
 * D.1：dsh bin / node bin / profile / patch / env 全走配置。
 * D.2：找不到 dsh bin 或 node bin 就不注册 worker_*（spawn 失败会留脏进程）。
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { dataDir, expandPath, workspaceDir } from '../paths.js'
import { loggerFor, textOutput } from './util.js'

const IS_WIN = process.platform === 'win32'
const JS_BIN = /\.(?:c|m)?js$/i
const SHIM_BIN = /\.(?:cmd|bat)$/i

/** 从 npm 的 .cmd shim 里抠出真正的 bin.js（不靠写死 AppData 路径）。 */
function binJsFromShim(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  const m = /"([^"]*node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js)"/i.exec(text)
  if (!m) return ''
  const raw = m[1]
  if (/^[a-z]:/i.test(raw)) return existsSync(raw) ? raw : ''
  const idx = raw.toLowerCase().indexOf('node_modules')
  if (idx < 0) return ''
  const full = join(dirname(file), raw.slice(idx))
  return existsSync(full) ? full : ''
}

/** 空 = 从 PATH 找 dsh。找到 shim 就继续找它指向的 bin.js。 */
function findOnPath() {
  const exts = IS_WIN ? ['.cmd', '.exe', '.ps1', ''] : ['']
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const full = join(dir, 'dsh' + ext)
      if (!existsSync(full)) continue
      if (SHIM_BIN.test(full)) {
        const js = binJsFromShim(full)
        if (js) return js
        continue
      }
      if (/\.ps1$/i.test(full)) continue
      return full
    }
  }
  return ''
}

function resolveDshBin(c) {
  const configured = expandPath(c.workerDshBin)
  if (configured) return existsSync(configured) ? configured : ''
  return findOnPath()
}

/** 去掉日志里的 ANSI 颜色码，done 文件和注入消息里别带控制字符。 */
export function stripAnsi(s) {
  return String(s ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

/** 日志最后 n 行（去 ANSI、去行尾空行）。 */
function tailOf(logPath, n = 20) {
  try {
    const raw = stripAnsi(readFileSync(logPath, 'utf8')).replace(/\r\n/g, '\n')
    const lines = raw.split('\n')
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    return lines.slice(-n).join('\n')
  } catch {
    return ''
  }
}

export function createWorker(c, session) {
  const DIR = join(dataDir(c), 'workers')
  const DSH_BIN = resolveDshBin(c)
  const NODE = expandPath(c.workerNodeBin) || process.execPath
  const PATCH = expandPath(c.workerPatchFile)
  const PROFILE = String(c.workerProfile || 'headless').trim() || 'headless'
  const enabled = Boolean(DSH_BIN && existsSync(NODE))

  const pad = (n) => String(n).padStart(2, '0')
  const stamp = () => {
    const d = new Date()
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  }

  // 2026-10-29 Fox 要求：同一个 id 只写一次 done、只注入一次。
  // FINISHED 管本进程内的重复 exit/close；done 文件管宿主重启后的重放。
  const FINISHED = new Set()
  // 派活时登记 { meta, onFinish }，exit 时取出来用，用完即删。
  const WAITING = new Map()

  function readMeta(id) {
    try {
      return JSON.parse(readFileSync(join(DIR, id + '.json'), 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * 子进程退出时收尾：写 <id>.done.json，然后回调派活时登记的 onFinish(done)。
   * 可被 exit 事件调用，也可以手动调；重复调用直接返回 null（不重写、不重注入）。
   * 被 kill（signal 非空）也要写 done，exitCode 记 null，别静默。
   */
  function finish(id, code, signal) {
    if (!id || FINISHED.has(id)) return null
    FINISHED.add(id)
    const donePath = join(DIR, id + '.done.json')
    // 宿主重启后老进程的 exit 可能再走一遍：done 已经在就什么都不做
    if (existsSync(donePath)) {
      WAITING.delete(id)
      return null
    }
    const wait = WAITING.get(id) ?? {}
    WAITING.delete(id)
    const meta = wait.meta ?? readMeta(id)
    const logPath = meta?.log ?? join(DIR, id + '.log')
    const done = {
      id,
      // signal 非空时 Node 给的 code 是 null；保留 null，注入文案里再写成 -1
      exitCode: typeof code === 'number' ? code : null,
      signal: signal ?? null,
      finishedAt: new Date().toISOString(),
      logPath,
      tail: tailOf(logPath, 20),
      task: String(meta?.task ?? '').slice(0, 120),
    }
    try {
      writeFileSync(donePath, JSON.stringify(done, null, 1), 'utf8')
    } catch (err) {
      // 写不了 done 也要继续尝试把结果送回去
      console.error(`[dsh-willa/worker] done 写不进去（${id}）：${err?.message ?? err}`)
    }
    if (typeof wait.onFinish === 'function') {
      try {
        const r = wait.onFinish(done)
        if (r && typeof r.then === 'function') {
          r.catch((err) => console.error(`[dsh-willa/worker] 结果回调失败（${id}）：${err?.message ?? err}`))
        }
      } catch (err) {
        // 注入失败只打 stderr，绝不影响别的工具
        console.error(`[dsh-willa/worker] 结果回调失败（${id}）：${err?.message ?? err}`)
      }
    }
    return done
  }

  /**
   * 往门房会话注入一句「worker 回来了 / 出错了」。门房每次现读（session_new 换过目标后，
   * 结果就送进新会话）；注入失败只打 stderr，绝不抛错、不影响其它工具。
   */
  async function notifyDone(done) {
    try {
      if (!done?.id) return
      const logRel = done.logPath || `workers\\${done.id}.log`
      const codeText = done.exitCode === null ? `-1（signal ${done.signal ?? '?'}）` : String(done.exitCode)
      const head = done.exitCode === 0 ? '[worker 回来了]' : '[worker 出错了]'
      let text = `${head} ${done.id} 退出码 ${codeText} · 日志 ${logRel} · 用 worker_status 抄结果`
      if (done.exitCode !== 0 && done.tail) {
        const last3 = String(done.tail)
          .split('\n')
          .filter((l) => l.trim())
          .slice(-3)
        if (last3.length) text += '\n' + last3.join('\n')
      }
      await session.inject(text)
    } catch (err) {
      // 门房会话不存在 / 拿不到 injector：只打 stderr，绝不抛错
      console.error(`[dsh-willa/worker] 结果送不回去（${done?.id ?? '?'}）：${err?.message ?? err}`)
    }
  }

  function apiKey() {
    const envFile = expandPath(c.workerEnvFile)
    if (!envFile) return ''
    try {
      const line = readFileSync(envFile, 'utf8')
        .split(/\r?\n/)
        .find((l) => /^\s*DEEPSEEK_API_KEY\s*=/.test(l))
      if (!line) return ''
      return line
        .split('=')
        .slice(1)
        .join('=')
        .trim()
        .replace(/^"|"$/g, '')
    } catch {
      return ''
    }
  }

  function run(task, opts = {}) {
    if (!enabled) throw new Error('worker 未配置（找不到 dsh bin 或 node bin）')
    const text = String(task ?? '').trim()
    if (!text) throw new Error('要干什么？task 不能空')
    const cwd = opts.cwd ? String(opts.cwd) : workspaceDir(c)
    if (!existsSync(cwd)) throw new Error(`工作目录不存在：${cwd}`)
    mkdirSync(DIR, { recursive: true })
    const id = stamp() + '-' + Math.random().toString(36).slice(2, 6)
    const log = join(DIR, id + '.log')
    const metaPath = join(DIR, id + '.json')
    const fd = openSync(log, 'a')
    // D.1 #22：进程环境变量优先，其次才读 workerEnvFile。
    const env = { ...process.env, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || apiKey() || '' }
    const argv = ['--profile', PROFILE]
    if (PATCH && existsSync(PATCH)) argv.push('--patch', PATCH)
    argv.push('headless', text)
    const useNode = JS_BIN.test(DSH_BIN)
    const child = spawn(useNode ? NODE : DSH_BIN, useNode ? [DSH_BIN, ...argv] : argv, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      shell: !useNode && SHIM_BIN.test(DSH_BIN),
    })
    child.unref()
    const meta = {
      id,
      task: text,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      cwd,
      log,
    }
    writeFileSync(metaPath, JSON.stringify(meta, null, 1), 'utf8')
    // 2026-10-29 Fox 要求：记住子进程句柄，不阻塞；退出时 finish() 写 done 再注入。
    WAITING.set(id, { child, meta, onFinish: typeof opts.onFinish === 'function' ? opts.onFinish : null })
    // 只挂 exit（'close' 对纯 fd stdio 不保证，且 finish 本身去重，二选一即可）
    child.once('exit', (code, signal) => finish(id, code, signal))
    child.once('error', (err) => {
      console.error(`[dsh-willa/worker] 起不来（${id}）：${err?.message ?? err}`)
      finish(id, -1, null)
    })
    return meta
  }

  function pidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  function status(id) {
    const metaPath = join(DIR, id + '.json')
    if (!existsSync(metaPath)) return null
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    const out = existsSync(meta.log) ? readFileSync(meta.log, 'utf8') : ''
    return {
      ...meta,
      running: pidAlive(meta.pid),
      bytes: out.length,
      tail: out.slice(-1500),
      lines: out.trim() ? out.trim().split(/\r?\n/).length : 0,
    }
  }

  function list() {
    if (!existsSync(DIR)) return []
    return readdirSync(DIR)
      // <id>.done.json 是退出回执，不是 worker 元数据，别列进去
      .filter((f) => f.endsWith('.json') && !f.endsWith('.done.json'))
      .map((f) => {
        const p = join(DIR, f)
        const meta = JSON.parse(readFileSync(p, 'utf8'))
        const st = existsSync(meta.log) ? statSync(meta.log) : { size: 0, mtime: new Date(0) }
        return {
          id: meta.id,
          task: meta.task,
          pid: meta.pid,
          running: pidAlive(meta.pid),
          startedAt: meta.startedAt,
          bytes: st.size,
        }
      })
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  }

  function register(scope) {
    if (!enabled) {
      loggerFor(scope)?.warn?.(
        `dsh-willa: worker 未配置（dsh bin=${DSH_BIN || '没找到'}，node bin=${NODE}），跳过 worker_run / worker_status / worker_list`,
      )
      return 0
    }

    scope.tools.register({
      name: 'worker_run',
      description:
        '把一件活丢给另一个 agent（独立进程，dsh headless 一次性会话）去干，立刻返回。' +
        '门房只负责回 QQ，长活都走这里；干完会用消息把结果送回门房，也可以 worker_status 抄结果。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['task'],
        properties: {
          task: { type: 'string', description: '要它干什么，写清楚，它看不到我们这边的对话。' },
          cwd: { type: 'string', description: '可选：在哪个目录干活，默认工作区。' },
        },
      },
      output: textOutput({ workerId: { type: 'string' } }),
      async execute(args) {
        // 2026-10-29 Fox 要求：传 onFinish 让 worker 退出时把结果送回来，这里不等
        const m = run(args.task, { cwd: args.cwd, onFinish: notifyDone })
        return {
          ok: true,
          detail: `派活了：${m.id}（pid ${m.pid}），日志 ${m.log}`,
          workerId: m.id,
        }
      },
    })

    scope.tools.register({
      name: 'worker_status',
      description: '看一个 worker 干完没有：还在跑吗、日志尾巴是什么。干完了就抄最后一版结果。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: 'worker_run 返回的 id。' } },
      },
      output: textOutput({ running: { type: 'boolean' } }),
      async execute(args) {
        const s = status(String(args.id))
        if (!s) return { ok: false, detail: `没有这个 worker：${args.id}`, running: false }
        const head = `${s.id}：${s.running ? '还在跑' : '已经结束'}（${s.bytes} 字节）\n`
        return { ok: true, detail: head + (s.tail || '（还没有输出）'), running: s.running }
      },
    })

    scope.tools.register({
      name: 'worker_list',
      description: '列一下派出去过的活：谁在跑、谁干完了。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput(),
      async execute() {
        const rows = list()
        if (!rows.length) return { ok: true, detail: '还没派过活。' }
        return {
          ok: true,
          detail: rows
            .map(
              (r) =>
                `${r.id} ${r.running ? '跑着' : '结束'} ${r.bytes}B ${String(r.task).slice(0, 40)}`,
            )
            .join('\n'),
        }
      },
    })

    return 3
  }

  return { enabled, run, status, list, finish, register, dir: DIR, dshBin: DSH_BIN, nodeBin: NODE }
}
