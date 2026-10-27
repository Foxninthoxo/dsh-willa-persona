'use strict'

/**
 * 把一句话投进 DSH 会话。
 *
 * 优先走宿主自己的路：
 *   ctx.sessionController.resolveAgent(sessionId)
 *     → agent.followup(createUserMessage(...))
 *     → ctx.sessions.flush(agent.session)
 *
 * 这条路和 dsh-schedule / willa-dsh 的唤醒口一致。没有这些服务时只抛一个
 * 短错误，由调用方记日志；不重试、不轮询、不刷屏。
 */

const fs = require('node:fs')
const path = require('node:path')
const storage = require('./storage.js')

function serviceOf(ctx, name) {
  try {
    if (typeof ctx?.reflect?.get === 'function') {
      const value = ctx.reflect.get(name)
      if (value) return value
    }
  } catch {
    /* 这个 profile 没有 reflect，继续试 ctx.get */
  }
  try {
    if (typeof ctx?.get === 'function') {
      const value = ctx.get(name)
      if (value) return value
    }
  } catch {
    /* 没有这个服务 */
  }
  return undefined
}

/**
 * 记住最近一个顶层会话。定时工具被调用时也会顺手记一次。
 * 子 agent 的会话不记，免得随机唤醒把话塞进干活的那边。
 */
function createSessionTracker(ctx, log) {
  let lastSessionId = null
  let dispose = null
  let disposed = false

  const remember = (sessionId) => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id) lastSessionId = id
    return id
  }

  const noteAgent = (agent) => {
    const header = agent?.session?.header
    if (header?.origin === 'subagent' || Number(header?.delegationDepth) > 0) return ''
    return remember(agent?.session?.id)
  }

  if (typeof ctx?.on === 'function') {
    const handler = (session) => {
      try {
        const header = session?.header ?? {}
        if (header.origin === 'subagent') return
        if (Number(header.delegationDepth) > 0) return
        remember(session?.id)
      } catch {
        /* 单个会话读不出来不影响别的 */
      }
    }
    try {
      dispose = ctx.on('session/created', handler, { global: true })
    } catch {
      try {
        dispose = ctx.on('session/created', handler)
      } catch {
        /* 宿主没有这个事件就算了 */
      }
    }
  }

  return {
    remember,
    noteAgent,
    get: () => lastSessionId,
    dispose() {
      if (disposed) return
      disposed = true
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 卸载时关不掉也不报 */
      }
    },
  }
}

/**
 * 没记到会话时的兜底：找 <DSH_HOME>/sessions 下最近写过的 session 目录。
 * 只看时间，不解压日志；宁可找不到，也不在这里做重活。
 */
function findRecentSessionId() {
  const root = path.join(storage.dshHome(), 'sessions')
  const found = []

  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!/^session.*\.jsonl(?:\.zstd)?$/i.test(entry.name)) continue
      try {
        const stat = fs.statSync(full)
        const id = path.basename(dir)
        if (id) found.push({ id, mtime: stat.mtimeMs })
      } catch {
        /* 文件刚被删掉 */
      }
    }
  }

  walk(root, 0)
  if (found.length === 0) return undefined
  found.sort((a, b) => b.mtime - a.mtime)
  return found[0].id
}

let llmModule

async function buildUserMessage(text, sourceKind) {
  try {
    llmModule ??= await import('@deepseek-ai/dsh-llm')
    if (typeof llmModule?.createUserMessage === 'function') {
      return llmModule.createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: sourceKind },
      })
    }
  } catch {
    /* 本地目录安装时经常解析不到 dsh-llm，下面手搓一个同形对象 */
  }
  return {
    id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: sourceKind },
  }
}

/**
 * 投一条提示。成功返回 session id；失败抛短错误，不重试。
 * @param {object} ctx 宿主 context
 * @param {{get:Function, remember:Function}|undefined} tracker 会话追踪器
 * @param {string|undefined} sessionId 指定会话；空则用追踪到的
 * @param {string} text 提示正文
 * @param {{sourceKind?: string, log?: object}} options 来源和日志
 */
async function deliverPrompt(ctx, tracker, sessionId, text, options = {}) {
  const id = String(sessionId ?? '').trim() || tracker?.get?.() || findRecentSessionId()
  if (!id) throw new Error('找不到可投递的会话')

  const controller = serviceOf(ctx, 'sessionController')
  if (!controller || typeof controller.resolveAgent !== 'function') {
    throw new Error('宿主没有 sessionController，投不进去')
  }

  const resolved = await controller.resolveAgent(id)
  if (resolved && resolved.error) {
    throw new Error(`resolveAgent 失败：${resolved.error.message ?? '未知错误'}`)
  }
  const agent = resolved?.agent
  if (!agent || typeof agent.followup !== 'function') {
    throw new Error('resolveAgent 没给出可用的 agent')
  }

  const message = await buildUserMessage(String(text ?? ''), options.sourceKind || 'schedule')
  agent.followup(message)

  const sessions = serviceOf(ctx, 'sessions')
  if (!sessions || typeof sessions.flush !== 'function') {
    throw new Error('宿主没有 sessions.flush，消息没落盘')
  }
  const flushed = await sessions.flush(agent.session)
  if (flushed === false) throw new Error('会话持久化没有确认')

  tracker?.remember?.(id)
  return id
}

function deliveryAvailable(ctx) {
  const controller = serviceOf(ctx, 'sessionController')
  const sessions = serviceOf(ctx, 'sessions')
  return Boolean(controller && typeof controller.resolveAgent === 'function' && sessions && typeof sessions.flush === 'function')
}

module.exports = {
  serviceOf,
  createSessionTracker,
  findRecentSessionId,
  deliverPrompt,
  deliveryAvailable,
}
