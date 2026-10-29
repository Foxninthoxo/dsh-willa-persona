/**
 * session.js —— 把一句话塞进 DSH 会话，以及「门房会话」的定位。
 *
 * 这里只搬 **工具需要的那一小块**（qq_wake_test / session_new）：
 *   ctx.sessionController.resolveAgent(sessionId) → agent.followup(...) → ctx.sessions.flush(...)
 *
 * 注意：OneBot WS 收消息、自动叫醒、wander 定时器属于第四阶段，本文件**不**起监听，
 * 相关 TODO 留在 `tools.js` 末尾和 `src/index.js` 的 mountWilla 里。
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import zlib from 'node:zlib'
import { dataDir, sessionsRoot, workspaceDir } from '../paths.js'
import { loggerFor } from './util.js'

const SESSION_FILE = 'session.v4.jsonl.zstd'
const QQ_MARK = '[QQ '

function readDoorFile(file) {
  try {
    const id = readFileSync(file, 'utf8').trim()
    return id || undefined
  } catch {
    return undefined
  }
}

export function createSession(ctx, c) {
  const root = sessionsRoot(c)
  // 旧实现按目录名里包含工作区名来认会话；这里不写死，默认取工作区目录名。
  const workspaceTag = String(c.wakeWorkspaceTag || basename(workspaceDir(c)) || '').trim()
  const doorFile = join(dataDir(c), 'door-session.txt')
  // 门房口径（严格串行）：内存这一份（配置的 wakeSessionId，或 session_new 换的）优先，
  // 它为空时才回退 door-session.txt（见 pinnedDoor()）。这里**不**把文件读进内存：
  // 否则文件换成新会话后内存还留着旧 id，qq_send 的门房校验会拿旧 id 放行。
  const door = { id: String(c.wakeSessionId ?? '').trim() || undefined }

  function pinnedDoor() {
    const id = door.id || readDoorFile(doorFile)
    if (!id) return undefined
    try {
      for (const dir of readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory() || !dir.name.includes(workspaceTag)) continue
        try {
          if (statSync(join(root, dir.name, id)).isDirectory()) return id
        } catch {
          /* 这个工作区里没有，继续找 */
        }
      }
    } catch {
      /* sessions 根不存在：当作没钉过 */
    }
    return undefined
  }

  /** 一个会话里第一句「人说的话」。headless 干活会话的种子话都以「headless 」开头。 */
  function firstUserText(folder) {
    let raw
    try {
      raw = readFileSync(join(folder, SESSION_FILE))
    } catch {
      return ''
    }
    let text = ''
    try {
      text =
        typeof zlib.zstdDecompressSync === 'function'
          ? zlib.zstdDecompressSync(raw).toString('utf8')
          : ''
    } catch {
      return ''
    }
    for (const line of text.split('\n')) {
      let j
      try {
        j = JSON.parse(line)
      } catch {
        continue
      }
      if (j?.type !== 'user/message') continue
      const t = j?.data?.content?.[0]?.text
      if (typeof t !== 'string') continue
      if (t.startsWith('<system-reminder>') || t.startsWith('Current runtime context')) continue
      return t
    }
    return ''
  }

  /** worker 派出去的活：dsh headless 的会话，别把门房的消息塞进干活的那边。 */
  function isWorkerSession(folder) {
    return /^headless[\s\u3000]/.test(firstUserText(folder))
  }

  /** 这个会话以前收过 QQ 吗——收过的才像门房。 */
  function hasQqHistory(folder) {
    try {
      const text = zlib.zstdDecompressSync(readFileSync(join(folder, SESSION_FILE))).toString('utf8')
      return text.includes(QQ_MARK)
    } catch {
      return false
    }
  }

  /** 我们那个工作区里该接 QQ 的会话：先剔掉 headless 干活的会话，再优先挑收过 QQ 的。 */
  function newestSessionId() {
    const pinned = pinnedDoor()
    if (pinned) return pinned
    const cands = []
    let folders = []
    try {
      folders = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.includes(workspaceTag))
        .map((d) => join(root, d.name))
    } catch {
      return undefined
    }
    for (const folder of folders) {
      let subs = []
      try {
        subs = readdirSync(folder, { withFileTypes: true }).filter(
          (s) => s.isDirectory() && s.name.startsWith('session-'),
        )
      } catch {
        continue
      }
      for (const s of subs) {
        const p = join(folder, s.name)
        let t = 0
        try {
          t = statSync(p).mtimeMs
        } catch {
          continue
        }
        cands.push({ t, id: s.name, folder: p })
      }
    }
    cands.sort((a, b) => b.t - a.t)
    const live = []
    for (const cand of cands) {
      if (live.length >= 12) break
      let worker = true
      try {
        worker = isWorkerSession(cand.folder)
      } catch {
        worker = true
      }
      if (worker) continue
      live.push(cand)
    }
    if (!live.length) return undefined
    for (const cand of live.slice(0, 5)) {
      if (hasQqHistory(cand.folder)) return cand.id
    }
    return live[0].id
  }

  /** 把一句话塞进某个会话，让它当成「人说的话」跑一轮。 */
  function createInjector() {
    let llm
    const loadLlm = () => (llm ??= import('@deepseek-ai/dsh-llm'))
    // 这两个服务不在插件的 inject 里（headless 那边没有 sessionController，
    // 声明成必需会让整个插件在 headless 不激活）。用 reflect.get 绕开 inject 要求。
    const svc = (name) => {
      const v = ctx.reflect?.get?.(name)
      if (!v) throw new Error(`拿不到服务 ${name}（这个 profile 里没有）`)
      return v
    }
    return async function inject(text, sessionId) {
      const id = sessionId || door.id || newestSessionId()
      if (!id) throw new Error('找不到会话：没有可用的 session id')
      const { createUserMessage } = await loadLlm()
      const resolved = await svc('sessionController').resolveAgent(id)
      if (resolved && 'error' in resolved) {
        throw new Error(`resolveAgent 失败：${resolved.error?.message ?? JSON.stringify(resolved.error)}`)
      }
      const agent = resolved.agent
      const realId = agent?.session?.id ?? agent?.sessionId ?? '?'
      loggerFor(ctx)?.debug?.(
        `inject: 请求=${id} 实际=${realId}${realId === id ? '' : ' ⚠️ 不一致'} 文本=${String(text).slice(0, 24)}`,
      )
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      agent.followup(message)
      await svc('sessions').flush(agent.session)
      return id
    }
  }

  const inject = createInjector()

  /** 记住门房会话（session_new 用），下次 inject 不传 id 就落这里。 */
  function remember(id) {
    door.id = id
    try {
      mkdirSync(dirname(doorFile), { recursive: true })
      writeFileSync(doorFile, String(id), 'utf8')
    } catch {
      /* 写不了指针也不影响本次会话切换 */
    }
  }

  return { door, inject, newestSessionId, remember }
}
