/**
 * willa 工具共用的纯函数：输出包装、时间格式、OneBot 消息段。
 *
 * 这里只放无状态的小工具；数据读写分别在各模块里，路径一律走 `../paths.js`。
 */

/** 工具输出渲染成一条文本（与旧 willa-dsh 完全一致）。 */
export const outText = (text) => [{ type: 'text', text }]

/**
 * 统一的文本输出 schema：`{ ok, detail, ...extra }`。
 * extra 里只加旧实现原本就有的字段，保证合并后调用方式不变。
 */
export function textOutput(extraProperties = {}) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'detail'],
      properties: {
        ok: { type: 'boolean' },
        detail: { type: 'string' },
        ...extraProperties,
      },
    },
    render: (_args, value) => outText(value.detail),
  }
}

export const pad2 = (n) => String(n).padStart(2, '0')

/** ISO / 时间戳 → "MM-DD HH:MM"；空或坏值给破折号。 */
export function fmtTs(iso) {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return '—'
  return `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`
}

/** alive 的到点时间；没有 dueAt 就写「不催」。 */
export function fmtDue(isoStr) {
  if (!isoStr) return '不催'
  return fmtTs(isoStr)
}

/** 解析 "group:<群号>" / "private:<QQ号>"。 */
export function parseTarget(target) {
  const m = /^\s*(group|private|群|私聊)\s*[:：]\s*(\d+)\s*$/.exec(String(target ?? ''))
  if (!m) throw new Error(`target 要写成 "group:<群号>" 或 "private:<QQ号>"，收到：${target}`)
  const kind = m[1] === 'group' || m[1] === '群' ? 'group' : 'private'
  return { kind, id: m[2] }
}

/** 把 OneBot 消息段拍平成一行字（图片、表情、@、引用都留个记号）。 */
export function segToText(segs) {
  if (typeof segs === 'string') return segs
  if (!Array.isArray(segs)) return ''
  const parts = []
  for (const s of segs) {
    const d = s?.data ?? {}
    switch (s?.type) {
      case 'text':
        parts.push(String(d.text ?? ''))
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'face':
        parts.push('[表情]')
        break
      case 'mface':
        parts.push('[表情包]')
        break
      case 'record':
        parts.push('[语音]')
        break
      case 'video':
        parts.push('[视频]')
        break
      case 'file':
        parts.push('[文件]')
        break
      case 'at':
        parts.push(`@${d.qq === 'all' ? '全体' : d.qq}`)
        break
      case 'reply':
        parts.push(`[引用 ${d.id}]`)
        break
      case 'json':
      case 'xml':
        parts.push('[卡片]')
        break
      default:
        parts.push(`[${s?.type ?? '未知'}]`)
    }
  }
  return parts.join('').trim()
}

/** 时间戳（秒）→ "今天 HH:MM" / "MM-DD HH:MM"。 */
export function fmtTime(sec) {
  const t = new Date(Number(sec) * 1000)
  const now = new Date()
  const hm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`
  const sameDay =
    t.getFullYear() === now.getFullYear() &&
    t.getMonth() === now.getMonth() &&
    t.getDate() === now.getDate()
  return sameDay ? hm : `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${hm}`
}

/** 拼 OneBot 消息段。 */
export function buildMessage(text, replyTo) {
  const segs = []
  if (replyTo) segs.push({ type: 'reply', data: { id: String(replyTo) } })
  segs.push({ type: 'text', data: { text: String(text) } })
  return segs
}

/** 插件日志器；拿不到就静默。 */
export function loggerFor(ctx) {
  try {
    if (typeof ctx?.logger === 'function') return ctx.logger('dsh-willa')
    return ctx?.logger
  } catch {
    return undefined
  }
}
