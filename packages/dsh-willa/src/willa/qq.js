/**
 * qq.js —— QQ 这条线：发消息、查状态、读记录、唤醒自检。
 *
 * 后端是 NapCat 的 OneBot HTTP。地址与 token 只从配置来：
 *   qqHttpUrl / qqToken / qqSelfId
 * 旧部署的 config.json 只在显式给了 `willaCompanionHome` 时作为兜底读取，
 * 不再把本机路径写死。
 *
 * D.2：地址或 token 缺一个就不注册 qq_* 四个工具（发送有外部副作用，宁可不出现）。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { companionHome, dataDir } from '../paths.js'
import {
  buildMessage,
  fmtTime,
  loggerFor,
  parseTarget,
  segToText,
  textOutput,
} from './util.js'

/** 旧部署的 config.json 里 worlds.qq 段；只有配了 willaCompanionHome 才读。 */
function companionQq(c) {
  const home = companionHome(c)
  if (!home) return {}
  const file = join(home, 'config.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))?.worlds?.qq ?? {}
  } catch {
    return {}
  }
}

/** 解析 QQ 后端配置；QQ 工具是否注册只看这里的 enabled。 */
export function resolveQq(c) {
  const fallback = companionQq(c)
  const base = String(c.qqHttpUrl || fallback.httpUrl || '')
    .trim()
    .replace(/\/+$/, '')
  const token = String(c.qqToken || fallback.token || '').trim()
  const selfId = String(c.qqSelfId || '').trim()
  return { base, token, selfId, enabled: Boolean(base && token) }
}

// 2026-10-29 Fox 要求：换会话之后，旧门房会话不能再发 QQ。
// DSH 会把 ToolRunContext 作为 execute 的第二个参数传给工具（exec），里面有
// exec.agent.session.id；证据见 dsh-tools 的 tool.execute(exec.arguments, exec)。
// 门房口径（严格串行，不取并集）：内存里的门房 id（session_new 会当场改它）有值就只认它
// → 否则回退 `dataDir/door-session.txt`。取并集的话，session_new 只换了内存、文件还留着
// 旧 id 时，老会话靠旧文件照样能发，等于没防住。
// 安全边界：拿不到自己的 sessionId / 两个口径都读不到 → 一律放行（fail-open），
// 只在 stderr 打一句，绝不能把自己锁死。
export const SESSION_ID_RE = /^session-[0-9a-z][0-9a-z-]*$/i

/**
 * 造一个门房守卫：绑定 door 文件与拒绝日志（路径由调用方按 paths.js 给）。
 * @param {{ doorFile: string, blockLog: string }} where
 * @returns {(exec: object|undefined, wakeId: string|undefined, target: string) => void}
 */
export function createDoorGuard({ doorFile, blockLog }) {
  /** 读 door-session.txt：返回 { ok, id, why }，读不到/空/格式不对都算不 ok。 */
  function doorFileId() {
    try {
      const raw = readFileSync(doorFile, 'utf8').replace(/^\uFEFF/, '').trim()
      if (!raw) return { ok: false, id: '', why: 'door-session.txt 是空的' }
      if (!SESSION_ID_RE.test(raw)) {
        return { ok: false, id: '', why: `door-session.txt 格式不对：${raw.slice(0, 80)}` }
      }
      return { ok: true, id: raw }
    } catch (err) {
      return { ok: false, id: '', why: `读不到 door-session.txt：${err?.message ?? err}` }
    }
  }

  /**
   * 发 QQ 前核对「我是不是当前门房」。
   * @param {object|undefined} exec 工具执行上下文（ToolRunContext）
   * @param {string|undefined} wakeId 内存里的门房会话 id（session_new 会当场改它）
   * @param {string} target 这次要发的目标，只用来记账
   */
  return function assertCurrentDoor(exec, wakeId, target) {
    // 记账只占一行：target 里的换行拍平，免得一次拒绝写出好几行
    const at = String(target ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200) || '(未给)'
    let self = ''
    try {
      self = String(exec?.agent?.session?.id ?? '').trim()
    } catch {
      self = ''
    }
    if (!self) {
      console.error(`[dsh-willa/door-guard] 拿不到自己的 sessionId，放行（fail-open）：${at}`)
      return
    }

    const wake = String(wakeId ?? '').trim()
    const wakeOk = Boolean(wake) && SESSION_ID_RE.test(wake)
    const file = doorFileId()

    // 严格串行：内存里有值就只认它（它是换会话时立刻变的那一份），没有才回退到文件。
    let door = ''
    let source = ''
    if (wakeOk) {
      door = wake
      source = 'wake.sessionId'
    } else if (file.ok) {
      door = file.id
      source = 'door-session.txt'
    }
    if (!door) {
      console.error(`[dsh-willa/door-guard] 两个门房口径都读不到，放行（fail-open）：${at}`)
      return
    }
    if (self === door) return

    const line = `${new Date().toISOString()} self=${self} target=${at} door=${door} source=${source}\n`
    try {
      appendFileSync(blockLog, line)
    } catch (err) {
      // 日志写不进去也要拒绝，别因为记账失败把门放开了
      console.error(`[dsh-willa/door-guard] 拒绝日志写不进：${err?.message ?? err}`)
    }
    throw new Error(`这个会话不是门房（当前门房 ${door}，按 ${source} 判的），不发 QQ`)
  }
}

export function createQq(c, session) {
  const q = resolveQq(c)
  // 门房文件与拒绝日志都跟着 dataDir 走，不写死本机路径。
  const doorGuard = createDoorGuard({
    doorFile: join(dataDir(c), 'door-session.txt'),
    blockLog: join(dataDir(c), 'qq-send-blocked.log'),
  })

  /** 调一个 NapCat 扩展/OneBot 动作。token 走 Authorization 头，不拼进 URL。 */
  async function call(action, params = {}, timeoutMs = 15000) {
    if (!q.enabled) throw new Error('QQ 未配置（qqHttpUrl / qqToken）')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${q.base}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${q.token}`,
        },
        body: JSON.stringify(params),
        signal: ctrl.signal,
      })
      const text = await res.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`NapCat 返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
      }
      if (json.status === 'failed' || (json.retcode !== undefined && json.retcode !== 0)) {
        throw new Error(
          `NapCat 拒绝：${json.message ?? json.wording ?? JSON.stringify(json).slice(0, 200)}`,
        )
      }
      return json.data
    } finally {
      clearTimeout(timer)
    }
  }

  function register(scope) {
    if (!q.enabled) {
      loggerFor(scope)?.warn?.(
        'dsh-willa: QQ 未配置（qqHttpUrl / qqToken 至少缺一个），跳过 qq_send / qq_status / qq_read / qq_wake_test',
      )
      return 0
    }

    const who = q.selfId ? `Willa 自己的 QQ（${q.selfId}）` : 'Willa 自己的 QQ'

    // ---------------------------------------------------------------- qq_send
    scope.tools.register({
      name: 'qq_send',
      description:
        `用 ${who} 发一条消息。target 写 "group:<群号>" 或 "private:<QQ号>"；` +
        '想引用回复某条消息就给 reply_to（那条消息的 id）。这是真的发出去，收不回。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'text'],
        properties: {
          target: { type: 'string', description: '"group:<群号>" 或 "private:<QQ号>"。' },
          text: { type: 'string', description: '正文。别发空字符串。' },
          reply_to: { type: 'string', description: '可选：要引用回复的消息 id。' },
        },
      },
      output: textOutput({ messageId: { type: 'string' } }),
      async execute(args, exec) {
        // 2026-10-29 Fox 要求：先核对门房，不是当前门房就拒绝，并记一行 qq-send-blocked.log
        doorGuard(exec, session?.door?.id, String(args?.target ?? ''))
        const text = String(args.text ?? '')
        if (!text.trim()) throw new Error('正文不能为空')
        const { kind, id } = parseTarget(args.target)
        const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
        const key = kind === 'group' ? 'group_id' : 'user_id'
        const data = await call(action, {
          [key]: Number(id),
          message: buildMessage(text, args.reply_to),
        })
        const messageId = data?.message_id !== undefined ? String(data.message_id) : undefined
        const where = kind === 'group' ? `群 ${id}` : `私聊 ${id}`
        return {
          ok: true,
          detail: `已发到${where}${messageId ? `（消息 id ${messageId}）` : ''}。`,
          messageId,
        }
      },
    })

    // -------------------------------------------------------------- qq_status
    scope.tools.register({
      name: 'qq_status',
      description: '看 QQ 这条线通不通：NapCat 在不在、登录的是哪个号、自己叫什么。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput({ userId: { type: 'string' }, nickname: { type: 'string' } }),
      async execute() {
        const me = await call('get_login_info')
        const userId = String(me?.user_id ?? '')
        const nickname = String(me?.nickname ?? '')
        return {
          ok: true,
          detail: `NapCat 在线，登录的是 ${nickname}（${userId}）。`,
          userId,
          nickname,
        }
      },
    })

    // ---------------------------------------------------------------- qq_read
    scope.tools.register({
      name: 'qq_read',
      description:
        '读一段 QQ 聊天记录（最近的消息，新的在后）。target 写 "group:<群号>" 或 "private:<QQ号>"，' +
        'count 是要读几条（默认 20）。返回每行形如 "#消息id [时间] 昵称(QQ号): 正文"。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['target'],
        properties: {
          target: { type: 'string', description: '"group:<群号>" 或 "private:<QQ号>"。' },
          count: { type: 'integer', description: '读几条，默认 20，最多 50。' },
        },
      },
      output: textOutput({ count: { type: 'integer' } }),
      async execute(args) {
        const { kind, id } = parseTarget(args.target)
        const count = Math.min(Math.max(Number(args.count ?? 20) || 20, 1), 50)
        const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history'
        const key = kind === 'group' ? 'group_id' : 'user_id'
        const data = await call(action, { [key]: Number(id), count })
        const list = Array.isArray(data?.messages) ? data.messages : []
        if (!list.length) {
          return {
            ok: true,
            detail: `没有读到消息（${kind === 'group' ? '群' : '私聊'} ${id}）。`,
            count: 0,
          }
        }
        const lines = list.slice(-count).map((m) => {
          const name = m?.sender?.card || m?.sender?.nickname || String(m?.user_id ?? '?')
          const body = segToText(m?.message) || String(m?.raw_message ?? '')
          return `#${m?.message_id} [${fmtTime(m?.time)}] ${name}(${m?.user_id}): ${body}`
        })
        return { ok: true, detail: lines.join('\n'), count: lines.length }
      },
    })

    // ------------------------------------------------------ qq_wake_test
    // 手动验一遍「往会话里塞一句话」这条路通不通（不碰 QQ）。
    scope.tools.register({
      name: 'qq_wake_test',
      description:
        '调试用：往当前会话里塞一句合成的话，看唤醒通道通不通。会真的触发我自己跑一轮，别乱调。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: '要塞进去的那句话。' },
        },
      },
      output: textOutput({ sessionId: { type: 'string' } }),
      async execute(args) {
        const id = await session.inject(String(args.text ?? '（空）'))
        return { ok: true, detail: `已塞进会话 ${id}。`, sessionId: id }
      },
    })

    return 4
  }

  return { ...q, call, register }
}
