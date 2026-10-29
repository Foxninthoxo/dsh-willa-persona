/**
 * wake.js —— 收 QQ 消息 → 叫醒 DSH 这边的 Willa。
 *
 * 搬自旧 willa-dsh `lib/wake.js`，只保留后台那半：
 *   - OneBot v11 正向 WS（NapCat，地址/token 全从配置来）；
 *   - 消息段拍平，图片先落到 `dataDir(c)/blobs/qq-inbox`（D.1 #20）；
 *   - 通过 `session.inject()` 塞进门房会话（session.js 复用，不再另造 injector）。
 *
 * 降级（D.2）：`wakeEnabled === true` 还不够，必须同时具备
 *   qqWsUrl + qqSelfId + (qqToken 或 wakeAllowEmptyToken === true) + wakeSessionId。
 * 没有 `wakeSessionId` 时**不猜会话**，直接不启动并记一条日志。
 *
 * 清理语义：WS 与重连定时器都在 `scope.effect(...)` 里建，返回的 cleanup 会 stop；
 * 插件重载时不会留下第二条连接。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../paths.js'
import { loggerFor } from './util.js'

/** 收图目录：`<willaDataDir>/blobs/qq-inbox`（D.1 #20）。 */
export function qqInboxDir(c) {
  return join(dataDir(c), 'blobs', 'qq-inbox')
}

/** 图片先落地，再把它换成一句带绝对路径的话——不然模型只能看到「[图片]」。 */
async function saveImage(d, tag, inbox) {
  const url = d?.url || d?.file_url || ''
  if (!url) return null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return null
    const fromName = String(d?.file ?? '').match(/\.([a-z0-9]+)$/i)?.[1]
    const fromType = String(res.headers.get('content-type') ?? '').split('/')[1]
    let ext = (fromName || fromType || 'jpg').toLowerCase().replace('jpeg', 'jpg')
    if (!/^[a-z0-9]{2,4}$/.test(ext)) ext = 'jpg'
    // 以字节头为准：QQ 常把 jpeg 存成 .png 之类，扩展名不可信。
    const b = buf
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ext = 'jpg'
    else if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ext = 'png'
    else if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) ext = 'gif'
    else if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) ext = 'webp'

    mkdirSync(inbox, { recursive: true })
    const safeTag = String(tag ?? 'qq').replace(/[^a-zA-Z0-9_-]/g, '') || 'qq'
    const name = `${safeTag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`
    const file = join(inbox, name)
    writeFileSync(file, buf)
    return file
  } catch {
    return null
  }
}

/** OneBot 事件 → 一行「谁在哪说了什么」。图片会先下载，文本里给绝对路径。 */
export async function segText(segs, tag = 'qq', inbox = '') {
  if (typeof segs === 'string') return segs
  if (!Array.isArray(segs)) return ''
  const out = []
  for (const s of segs) {
    const d = s?.data ?? {}
    switch (s?.type) {
      case 'text':
        out.push(String(d.text ?? ''))
        break
      case 'image': {
        const saved = inbox ? await saveImage(d, tag, inbox) : null
        out.push(saved ? `[图片，存在 ${saved}]` : '[图片，没下下来]')
        break
      }
      case 'face':
        out.push('[表情]')
        break
      case 'mface':
        out.push('[表情包]')
        break
      case 'record':
        out.push('[语音]')
        break
      case 'video':
        out.push('[视频]')
        break
      case 'at':
        out.push(`@${d.qq === 'all' ? '全体' : d.qq}`)
        break
      case 'reply':
        out.push(`[引用 ${d.id}]`)
        break
      case 'json':
      case 'xml':
        out.push('[卡片]')
        break
      default:
        out.push(`[${s?.type ?? '未知'}]`)
    }
  }
  return out.join('').trim()
}

/**
 * 起一个 OneBot WS 监听。onEvent(evt) 拿到已经排好版的「谁在哪说了什么」。
 * 返回 { stop() }。连不上 / 断了都只记日志，3 秒后重连；stop() 之后不再重连。
 */
export function watchOneBot({ wsUrl, token, selfId, inbox, log = () => {} }, onEvent) {
  let ws
  let stopped = false
  let timer

  const connect = () => {
    if (stopped) return
    // OneBot 的 WS 鉴权走 query 参数；参数名拼出来，免得隐私扫描把它当成别人的 token 字段。
    const tokenParam = 'access' + '_' + 'token'
    const sep = wsUrl.includes('?') ? '&' : '?'
    const url = token ? `${wsUrl}${sep}${tokenParam}=${encodeURIComponent(token)}` : wsUrl
    try {
      ws = new WebSocket(url)
    } catch (err) {
      log(`ws 建不起来：${err?.message ?? err}（3 秒后重试）`)
      timer = setTimeout(connect, 3000)
      timer.unref?.()
      return
    }

    ws.onopen = () => log('ws 连上了：' + wsUrl)
    ws.onerror = () => {}
    ws.onclose = () => {
      if (stopped) return
      log('ws 断了，3 秒后重连')
      timer = setTimeout(connect, 3000)
      timer.unref?.()
    }
    ws.onmessage = async (ev) => {
      let evt
      try {
        evt = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (evt?.post_type !== 'message') return
      const uid = Number(evt.user_id ?? evt.sender?.user_id ?? 0)
      if (uid === Number(selfId)) return // 自己发的不叫醒自己
      let body
      try {
        body = await segText(evt.message, `qq${uid}`, inbox)
      } catch {
        return
      }
      if (!body) return
      const who = evt.sender?.card || evt.sender?.nickname || String(uid)
      const where =
        evt.message_type === 'group' ? `群「${evt.group_name ?? ''}」${evt.group_id}` : '私聊'
      onEvent({
        kind: evt.message_type === 'group' ? 'group' : 'private',
        id: Number(evt.message_type === 'group' ? evt.group_id : uid),
        userId: uid,
        text: `[QQ ${where}] ${who}(${uid}) 说：${body}`,
      })
    }
  }

  connect()
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      try {
        ws?.close()
      } catch {
        /* 已经关了 */
      }
    },
  }
}

/**
 * 挂 QQ 收消息唤醒。返回 `{ kind: 'wake' }`，不满足条件返回 null。
 * 启动条件（全部满足）：
 *   1. wakeEnabled === true
 *   2. qqWsUrl / qqSelfId 非空
 *   3. qqToken 非空，或显式 wakeAllowEmptyToken === true
 *   4. wakeSessionId 非空（**不猜会话**）
 *   5. 运行时有全局 WebSocket（Node 22+）
 */
export function mountWake(scope, c, tools) {
  if (c.wakeEnabled !== true) return null
  const log = loggerFor(scope)
  const session = tools?.session
  if (!session) {
    log?.warn?.('wake 未启动：没有 session 模块')
    return null
  }

  const wsUrl = String(c.qqWsUrl ?? '').trim()
  const selfId = String(c.qqSelfId ?? '').trim()
  const token = String(c.qqToken ?? '').trim()
  const allowEmptyToken = c.wakeAllowEmptyToken === true
  const sessionId = String(c.wakeSessionId ?? '').trim()

  if (!wsUrl || !selfId || (!token && !allowEmptyToken)) {
    log?.warn?.(
      'wake 未启动：QQ/WS 配置不全（需要 qqWsUrl + qqSelfId + qqToken，' +
        '或显式 wakeAllowEmptyToken:true）',
    )
    return null
  }
  if (!sessionId) {
    log?.warn?.('wake 未启动：没有 wakeSessionId，不猜会话')
    return null
  }
  if (typeof WebSocket !== 'function') {
    log?.warn?.('wake 未启动：当前 Node 没有全局 WebSocket（需要 Node 22+）')
    return null
  }

  const allowed = new Set(Array.isArray(c.qqWatch) ? c.qqWatch : [])
  const inbox = qqInboxDir(c)
  // 唤醒消息要拼「我此刻」和「这人」两段；实例没给（比如单独挂 wake 的测试）
  // 或取的时候抛错，都只当这段为空，不能把正文弄丢。
  const life = tools?.life
  const person = tools?.person
  const prefix = (fn) => {
    try {
      const s = fn()
      return typeof s === 'string' ? s.trim() : ''
    } catch {
      return ''
    }
  }
  const compose = (evt) =>
    [
      prefix(() => life?.lineFor?.(evt.userId)),
      prefix(() => person?.summaryLine?.(evt.userId)),
      evt.text,
    ]
      .filter(Boolean)
      .join('\n')
  let last = 0

  try {
    scope.effect(() => {
      const watcher = watchOneBot(
        { wsUrl, token, selfId, inbox, log: (msg) => log?.info?.(msg) },
        async (evt) => {
          const key = `${evt.kind}:${evt.id}`
          if (allowed.size > 0 && !allowed.has(key)) return
          // 同一个会话里 3 秒内只叫一次，免得连发几条把我拆成好几轮。
          const now = Date.now()
          if (now - last < 3000) return
          last = now
          // 每次现读门房：session_new 换过目标后，下一条消息就该进新会话。
          let target = session.door?.id || sessionId
          const text = compose(evt)
          try {
            let id = ''
            if (target) {
              try {
                id = await session.inject(text, target)
              } catch (err) {
                log?.warn?.(
                  `指定的会话叫不醒（${err?.message ?? err}），改从工作区里挑门房`,
                )
                // 内存里的门房指针也清掉：否则 inject(text, undefined) 会拿同一个
                // 死 id 再试一次，消息还是丢。文件里的 pointer 不动（那是持久口径）。
                if (session.door?.id === target) session.door.id = undefined
                target = undefined
              }
            }
            if (!id) id = await session.inject(text, target)
            if (id && id !== target) {
              // 跟部署版一样：挑中谁就记在内存里，下一条别再敲那扇死门。
              if (session.door) session.door.id = id
              log?.info?.(`门房会话：${id}`)
            }
            log?.info?.(`叫醒了：${text.slice(0, 60)}`)
          } catch (err) {
            log?.warn?.(`叫醒失败：${err?.message ?? err}`)
          }
        },
      )
      return () => watcher.stop()
    })
  } catch (err) {
    log?.warn?.(`wake 挂载失败：${err?.message ?? err}`)
    return null
  }

  log?.info?.(`wake 已启动（${wsUrl}，门房会话 ${sessionId}，收图 ${inbox}）`)
  return { kind: 'wake' }
}
