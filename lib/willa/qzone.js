/**
 * qzone.js —— QQ 空间评论监听（轮询）。
 *
 * 搬自旧 willa-dsh `lib/qzone.js`。SnowLuma 只把 QQ 消息推到 OneBot 的 WS，
 * 空间评论不推，所以这里每 N 分钟拉一遍自己的说说列表；评论数变了就查详情，
 * 把「别人的新评论」叫醒一次。
 *
 * 配置：
 *   - `qzoneOnebotConfig`：SnowLuma 的 onebot_*.json，读 networks.httpServers[0]；
 *   - 或直接 `qzoneHttpUrl` + `qzoneToken`（优先）；
 *   - 自己的 QQ 号走 `qqSelfId`（D.1 #13）。
 *
 * 状态：`dataDir(c)/qzone-watch.json`（D.1 #12/#13）——
 *   `{ posts: { tid: { count, seen: [key], since } } }`，tmp + rename 写入。
 *
 * 清理语义：轮询 timer 在 `scope.effect(...)` 里建，cleanup 清 interval；
 * 重载时不会两份轮询同时跑。
 *
 * 开关：`qzoneEnabled`，并且必须能解析出 HTTP 端点。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir, expandPath } from '../paths.js'
import { loggerFor } from './util.js'

/** 状态文件路径：`<willaDataDir>/qzone-watch.json`。 */
export function qzoneStatePath(c) {
  return join(dataDir(c), 'qzone-watch.json')
}

/**
 * 解析 OneBot HTTP 端点。先看显式的 qzoneHttpUrl + qzoneToken，再看 onebot 配置文件。
 * 返回 `{ base, token, selfId, source }`；解析不出来时 base 为空。
 */
export function resolveQzoneEndpoint(c) {
  const selfId = String(c.qqSelfId ?? '').trim()
  const httpUrl = String(c.qzoneHttpUrl ?? '')
    .trim()
    .replace(/\/+$/, '')
  const httpToken = String(c.qzoneToken ?? '').trim()
  if (httpUrl && httpToken) {
    return { base: httpUrl, token: httpToken, selfId, source: 'qzoneHttpUrl' }
  }

  const configFile = expandPath(c.qzoneOnebotConfig)
  if (configFile && existsSync(configFile)) {
    try {
      const cfg = JSON.parse(readFileSync(configFile, 'utf8'))
      const h = cfg?.networks?.httpServers?.[0]
      if (h && h.host && h.port) {
        const base = `http://${h.host}:${h.port}${String(h.path ?? '').replace(/\/+$/, '')}`
        return {
          base,
          token: String(h.accessToken ?? ''),
          selfId,
          source: 'qzoneOnebotConfig',
        }
      }
    } catch {
      /* 坏配置当没有，下面统一走「未配置」 */
    }
  }

  return { base: '', token: '', selfId, source: 'none' }
}

function makeCall(endpoint) {
  return async function call(action, params = {}) {
    if (!endpoint.base) throw new Error('QQ 空间接口未配置')
    const res = await fetch(`${endpoint.base}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20000),
    })
    const json = await res.json()
    if (json?.retcode !== 0) {
      throw new Error(`${action} 失败：retcode ${json?.retcode} ${json?.message ?? ''}`)
    }
    return json.data
  }
}

function keyOf(comment) {
  return `${comment.uin}:${comment.time}:${String(comment.content ?? '').slice(0, 24)}`
}

/**
 * 拉一次；返回新评论（第一次跑只建档，不叫人）。
 *
 * @param {{ call: Function, statePath: string, selfId?: string, log?: Function }} options
 */
export async function pollOnce({ call, statePath, selfId = '', log = () => {} }) {
  const state = (() => {
    if (!existsSync(statePath)) return { posts: {} }
    try {
      const j = JSON.parse(readFileSync(statePath, 'utf8'))
      if (!j.posts || typeof j.posts !== 'object') j.posts = {}
      return j
    } catch {
      return { posts: {} }
    }
  })()

  const list = await call('get_qzone_msg_list', { count: 10 })
  const posts = Array.isArray(list?.msglist) ? list.msglist : []
  const found = []

  for (const post of posts) {
    const tid = String(post.tid)
    const prev = state.posts[tid]
    const count = Number(post.comment_num ?? 0)
    if (!prev) {
      state.posts[tid] = { count, seen: [], since: Math.floor(Date.now() / 1000) }
      continue
    }
    if (count <= prev.count) {
      prev.count = Math.max(prev.count, count)
      continue
    }

    // 评论数涨了，查详情。
    let detail
    try {
      detail = await call('get_qzone_msg_detail', { tid, pos: 0, num: 50 })
    } catch (err) {
      log('查详情失败：' + (err?.message ?? String(err)))
      continue
    }

    const seen = new Set(prev.seen ?? [])
    const since = Number(prev.since ?? 0)
    for (const comment of detail?.comments ?? []) {
      const k = keyOf(comment)
      if (seen.has(k)) continue
      seen.add(k)
      if (selfId && Number(comment.uin) === Number(selfId)) continue
      // 建档那一刻之前的老评论不算新消息。
      if (Number(comment.time ?? 0) <= since) continue
      found.push({
        tid,
        post: String(detail?.content ?? ''),
        name: comment.name || String(comment.uin),
        uin: Number(comment.uin),
        content: String(comment.content ?? ''),
      })
    }
    prev.seen = [...seen].slice(-200)
    prev.count = count
    const newest = Math.max(since, ...(detail?.comments ?? []).map((c) => Number(c.time ?? 0)))
    prev.since = Number.isFinite(newest) ? newest : since
  }

  mkdirSync(dirname(statePath), { recursive: true })
  const tmp = statePath + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8')
  renameSync(tmp, statePath)
  return found
}

/**
 * 起轮询。返回 `{ stop(), poll() }`。
 *
 * @param {object} options
 * @param {(text: string) => Promise<any>} options.inject
 * @param {object} options.endpoint resolveQzoneEndpoint() 的返回值
 * @param {string} options.statePath
 * @param {number} [options.everyMinutes]
 * @param {(msg: string) => void} [options.log]
 */
export function startQzoneWatch({
  inject,
  endpoint,
  statePath,
  everyMinutes = 10,
  log = () => {},
}) {
  const everyMs = Math.max(1, Number(everyMinutes)) * 60_000
  const call = makeCall(endpoint)
  let timer = null
  let stopped = false
  let busy = false

  const tick = async () => {
    if (busy || stopped) return
    busy = true
    try {
      const news = await pollOnce({ call, statePath, selfId: endpoint.selfId, log })
      for (const item of news) {
        const line =
          `[QQ空间] ${item.name}(${item.uin}) 评论了你那条「${item.post.slice(0, 30)}」：` +
          `${item.content}（tid ${item.tid}，要回就用 comment_qzone）`
        await inject(line)
        log('空间新评论：' + item.name)
      }
    } catch (err) {
      log('轮询失败：' + (err?.message ?? String(err)))
    } finally {
      busy = false
    }
  }

  // 第一次先建个档，别把历史评论当新消息。
  void tick()
  timer = setInterval(tick, everyMs)
  timer.unref?.()

  return {
    stop() {
      stopped = true
      if (timer) clearInterval(timer)
    },
    poll: tick,
  }
}

/**
 * 挂 QQ 空间轮询。返回 `{ kind: 'qzone' }`，开关没开或端点不全返回 null。
 */
export function mountQzone(scope, c, tools) {
  if (c.qzoneEnabled !== true) return null
  const log = loggerFor(scope)
  const session = tools?.session
  if (!session) return null

  const endpoint = resolveQzoneEndpoint(c)
  if (!endpoint.base) {
    log?.warn?.(
      'qzone 未启动：需要 qzoneOnebotConfig，或 qzoneHttpUrl + qzoneToken。',
    )
    return null
  }
  if (!endpoint.selfId) {
    log?.warn?.('qzone：没有 qqSelfId，自己的评论可能被当成新评论。')
  }

  const statePath = qzoneStatePath(c)
  try {
    scope.effect(() => {
      const watcher = startQzoneWatch({
        endpoint,
        statePath,
        everyMinutes: c.qzoneEveryMinutes,
        log: (msg) => log?.info?.(msg),
        inject: (text) => session.inject(text),
      })
      return () => watcher.stop()
    })
  } catch (err) {
    log?.warn?.(`qzone 挂载失败：${err?.message ?? err}`)
    return null
  }

  log?.info?.(
    `qzone 已启动（${endpoint.source}，每 ${Number(c.qzoneEveryMinutes)} 分钟，状态 ${statePath}）`,
  )
  return { kind: 'qzone' }
}
