/**
 * tools.js —— willa 那半的 26 个工具注册入口。
 *
 * 每个模块自己负责「后端可用就注册、不可用就不注册」（D.2）；这里只按顺序
 * 建实例、调 register，并把注册个数报给入口日志。
 *
 * 26 个工具的分布：
 *   qq.js        4  qq_send / qq_status / qq_read / qq_wake_test
 *   affinity.js  5  affinity_get / adjust / slot / list / migrate
 *   memory.js    4  mem_recall / note / supersede / stats（后两个本地常驻）
 *   worker.js    3  worker_run / status / list
 *   alive.js     4  alive_want / list / done / drop
 *   life.js      2  life_now / life_set
 *   person.js    3  person_get / list / upsert
 *   tools.js     1  session_new
 *
 * 定时器 / OneBot WS / wander / qzone 轮询由入口在工具挂完之后另行挂载：
 *   alive-timer.js  aliveEnabled
 *   wake.js         wakeEnabled + QQ/WS 配置 + wakeSessionId
 *   wander.js       wanderEnabled
 *   qzone.js        qzoneEnabled + 空间接口配置
 */
import { workspaceDir } from '../paths.js'
import { createAlive } from './alive.js'
import { createAffinity } from './affinity.js'
import { createLife } from './life.js'
import { createMemory } from './memory.js'
import { createPerson } from './person.js'
import { createQq } from './qq.js'
import { createSession } from './session.js'
import { createWorker } from './worker.js'
import { loggerFor, textOutput } from './util.js'

export function mountWillaTools(scope, c) {
  const session = createSession(scope, c)
  const qq = createQq(c, session)
  const affinity = createAffinity(c)
  const life = createLife(c, affinity)
  const memory = createMemory(c)
  const person = createPerson(c, memory)
  const alive = createAlive(c)
  const worker = createWorker(c, session)

  const groups = [qq, affinity, memory, person, life, alive, worker]
  let count = 0
  for (const group of groups) count += Number(group.register(scope)) || 0
  count += registerSessionNew(scope, c, session)

  loggerFor(scope)?.info?.(`dsh-willa: willa 工具已挂载 ${count} 个（26 个里按后端配置裁剪）`)
  return { count, session, qq, affinity, memory, person, life, alive, worker }
}

/** 第 26 个：换会话（宿主服务在调用时再取，不同 profile 服务不同）。 */
function registerSessionNew(scope, c, session) {
  scope.tools.register({
    name: 'session_new',
    description:
      '开一个新的 DSH 会话并把门房切过去（以后 QQ 消息进新会话，旧会话不再收）。' +
      '长上下文把自己拖慢的时候用；新会话会收到一条开工提示。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kickoff: { type: 'string', description: '可选：给新会话的开场白，不写就用默认的开机清单。' },
      },
    },
    output: textOutput({ sessionId: { type: 'string' } }),
    async execute(args) {
      const got = (name) => {
        try {
          return scope.reflect?.get?.(name)
        } catch {
          return undefined
        }
      }
      const agents = got('agents')
      const sc = got('sessionController')
      const sessions = got('sessions')
      const tried = []
      let created = null
      const cwd = workspaceDir(c)

      try {
        if (agents?.createSession) {
          tried.push('agents.createSession')
          created = await agents.createSession({ cwd })
        }
      } catch (err) {
        tried.push('agents.createSession ERR ' + (err?.message ?? err))
      }
      if (!created) {
        try {
          if (typeof sc?.create === 'function') {
            tried.push('sessionController.create')
            created = await sc.create({ cwd })
          }
        } catch (err) {
          tried.push('sessionController.create ERR ' + (err?.message ?? err))
        }
      }
      if (!created) {
        try {
          if (typeof sessions?.create === 'function') {
            tried.push('sessions.create')
            created = await sessions.create({ cwd })
          }
        } catch (err) {
          tried.push('sessions.create ERR ' + (err?.message ?? err))
        }
      }

      const id =
        created?.agent?.session?.id ??
        created?.session?.id ??
        created?.sessionId ??
        (typeof created === 'string' ? created : undefined)

      if (!id) {
        const names = ['agents', 'sessionController', 'sessions']
          .map((n) => {
            const v = got(n)
            return `${n}=${v ? Object.keys(v).slice(0, 10).join('/') : '无'}`
          })
          .join('；')
        return {
          ok: false,
          detail: `开不了。试过：${tried.join(' | ') || '无'}。服务：${names}`,
        }
      }

      session.remember(id)
      const kick =
        String(args.kickoff ?? '').trim() ||
        String(c.sessionKickoff ?? '').trim() ||
        '（新会话开工）先看工作区的 CONSTITUTION.md / INDEX.md / 待办交接，确认记忆和手头的事，再开工。'
      try {
        await session.inject(kick, id)
      } catch (err) {
        return {
          ok: true,
          detail: `新会话 ${id}（${tried.join('|')}），门房切过去了，开场白没塞进去：${err?.message ?? err}`,
          sessionId: id,
        }
      }
      return {
        ok: true,
        detail: `新会话 ${id}（${tried.join('|')}），门房切过去，开工消息已塞。`,
        sessionId: id,
      }
    },
  })
  return 1
}

// ── 后台那半 ───────────────────────────────────────────────────────────
// 工具注册到这里就完了。四个后台（alive 定时器 / QQ 收消息 / wander / qzone）
// 由 `src/index.js` 的 mountWilla 在工具挂完之后调对应模块的 mount*()；
// 每个 mount 自己判断开关与降级，并用 scope.effect 管住定时器/WS 的清理。
