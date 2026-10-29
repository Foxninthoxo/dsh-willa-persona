/**
 * 冒烟测试：不启动 DSH，只 import 构建产物，用一个假 ctx 走条件挂载。
 *
 * 覆盖：
 *  1. 入口形状 / config 默认值 / 人设半侧的按需 inject（第一阶段已有）；
 *  2. willa 后端全配时 26 个工具一个不少，参数 schema 与旧 willa-dsh 对齐；
 *  3. D.2 降级：QQ 没配、embed 没配、worker 没配时该少注册哪些，本地工具照常；
 *  4. 第三阶段后台：四个开关全开时 alive / wake / wander / qzone 都挂上，
 *     全关时一个都不挂，dispose 后假 timer 计数归零，没 wakeSessionId 时 wake 不启也不抛。
 *
 * 这不是完整验收；完整验收是真装进临时 profile 跑 `dsh --dump-config` 和一次最小会话。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mod = await import('../lib/index.js')

assert.equal(mod.name, 'dsh-willa', 'name 必须是包名')
// 2026-10-29 实测纠正：静态 inject 这两个核心服务是必须的。
// 用 `inject=[]` + 动态 ctx.inject 的写法，headless 下工具注册会晚一拍、模型看不到（工具其实注册了）。
assert.deepEqual([...mod.inject].sort(), ['systemPrompt', 'tools'], '静态依赖 systemPrompt + tools 两个核心服务')
assert.equal(typeof mod.apply, 'function', 'apply 必须是函数')
assert.ok(mod.Config && mod.Config['~standard'], 'Config 必须是 standard-schema 形状')

const { resolveConfig, DEFAULTS } = await import('../lib/config.js')
const defaults = resolveConfig({})
assert.equal(defaults.enablePersona, true)
assert.equal(defaults.enableWilla, false)
assert.equal(defaults.wakeEnabled, false)
assert.equal(defaults.aliveEnabled, true)
assert.equal(resolveConfig({ enabled: false }).enablePersona, false)
assert.equal(resolveConfig({ wake: { enabled: true } }).wakeEnabled, true)
assert.deepEqual(resolveConfig({ qqWatch: [1, 'x'] }).qqWatch, ['x'])
assert.ok(Object.keys(DEFAULTS).length >= 36, 'C.3 + D.1 的字段应全部在默认值表里')
for (const key of [
  'affinityMigrateFile',
  'sessionKickoff',
  'wakeSessionsRoot',
  'wakeWorkspaceTag',
  'qzoneHttpUrl',
  'qzoneToken',
]) {
  assert.ok(key in DEFAULTS, `D.1 补的配置键应存在：${key}`)
}

/** 最小的 cordis ctx 替身：只实现 apply 用到的 inject / effect / logger / 服务。 */
function makeCtx() {
  const injected = []
  const registered = []
  const toolMap = new Map()
  const logs = []
  const disposers = []
  const logger = () => ({
    info(msg) {
      logs.push(`info ${msg}`)
    },
    warn(msg) {
      logs.push(`warn ${msg}`)
    },
    debug(msg) {
      logs.push(`debug ${msg}`)
    },
  })
  // 2026-10-29：核心服务（systemPrompt/tools）走静态 inject + 同步挂，
  // 所以服务直接挂在基础 ctx 上；`inject` 只用来模拟可选服务（webServer）的按需注入。
  const base = {
    logger,
    reflect: { get() {} },
    on() {},
    effect(fn) {
      const dispose = fn()
      const cleanup = typeof dispose === 'function' ? dispose : () => {}
      disposers.push(cleanup)
      return cleanup
    },
    systemPrompt: {
      section(definition) {
        registered.push(`prompt:${definition.name}`)
        return {}
      },
    },
    webServer: {
      register(definition) {
        registered.push(`route:${definition.path}`)
        return {}
      },
    },
    tools: {
      register(definition) {
        assert.ok(definition?.name, 'tool 必须有 name')
        assert.ok(!toolMap.has(definition.name), `tool 重复注册：${definition.name}`)
        toolMap.set(definition.name, definition)
        registered.push(`tool:${definition.name}`)
        return () => {}
      },
    },
  }
  const inject = (deps, callback) => {
    injected.push(deps.join(','))
    callback(base)
  }
  // eslint-disable-next-line no-unused-vars
  base.inject = inject
  /** 模拟插件重载 / profile 关闭：按注册顺序倒着跑 effect 的 cleanup。 */
  const dispose = () => {
    while (disposers.length > 0) {
      const cleanup = disposers.pop()
      try {
        cleanup()
      } catch {
        /* 清理失败不该影响其余断言 */
      }
    }
  }
  return { ctx: base, injected, registered, toolMap, logs, dispose }
}

/**
 * 数「后台挂了几份」用的假运行时：
 *  - 包一层全局 setInterval / setTimeout，活跃句柄记在 Set 里，dispose 后应归零；
 *  - 用假 WebSocket 顶掉真的，wake 挂载时不真去连 QQ。
 * `counts()` 只反映通过这层包装建出来的句柄，正好用来验「重载不叠加」。
 */
function installFakeRuntime() {
  const real = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    WebSocket: globalThis.WebSocket,
  }
  const intervals = new Set()
  const timeouts = new Set()
  const sockets = new Set()

  globalThis.setInterval = (...args) => {
    const handle = real.setInterval(...args)
    intervals.add(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => {
    intervals.delete(handle)
    return real.clearInterval(handle)
  }
  globalThis.setTimeout = (...args) => {
    const handle = real.setTimeout(...args)
    timeouts.add(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    timeouts.delete(handle)
    return real.clearTimeout(handle)
  }
  globalThis.WebSocket = class FakeWebSocket {
    constructor(url) {
      this.url = String(url)
      this.readyState = 0
      sockets.add(this)
    }

    close() {
      this.readyState = 3
      sockets.delete(this)
    }

    send() {}
  }

  const counts = () => ({
    intervals: intervals.size,
    timeouts: timeouts.size,
    sockets: sockets.size,
  })

  const restore = () => {
    for (const handle of intervals) real.clearInterval(handle)
    for (const handle of timeouts) real.clearTimeout(handle)
    for (const socket of sockets) socket.close()
    intervals.clear()
    timeouts.clear()
    sockets.clear()
    globalThis.setInterval = real.setInterval
    globalThis.clearInterval = real.clearInterval
    globalThis.setTimeout = real.setTimeout
    globalThis.clearTimeout = real.clearTimeout
    globalThis.WebSocket = real.WebSocket
  }

  return { counts, restore }
}

// 默认：只挂人设（systemPrompt），并且人设模块自己再挂 webServer 的三条路由。
{
  const { ctx, injected, registered } = makeCtx()
  mod.apply(ctx, {})
  // 2026-10-29：核心服务（tools/systemPrompt）改成静态 inject + 同步挂，不再走动态 inject；
  // 只剩可选服务 webServer 由人设模块自己按需 inject。
  assert.deepEqual(injected, ['webServer'], '人设模块只按需 inject webServer')
  assert.ok(registered.includes('prompt:dafeiyu:persona'), '人设段落应被注册')
  assert.ok(registered.includes('route:/api/dsh-willa/status'), 'status 路由应被注册')
  assert.ok(registered.includes('route:/api/dsh-willa/mutate'), 'mutate 路由应被注册')
  assert.ok(registered.includes('route:/api/dsh-willa/persona'), 'persona 路由应被注册')
  assert.deepEqual([...registered].filter((x) => x.startsWith('tool:')), [], '默认不开 willa 工具')
}

// 关人设：什么都不挂。
{
  const { ctx, injected, registered } = makeCtx()
  mod.apply(ctx, { enablePersona: false })
  assert.deepEqual(injected, [], 'enablePersona:false 时不应 inject 任何服务')
  assert.deepEqual(registered, [])
}

// 26 个工具的参数 schema（required / properties 名字）与旧 willa-dsh 一致。
const EXPECTED = {
  qq_send: { required: ['target', 'text'], properties: ['target', 'text', 'reply_to'] },
  qq_status: { required: [], properties: [] },
  qq_read: { required: ['target'], properties: ['target', 'count'] },
  qq_wake_test: { required: ['text'], properties: ['text'] },
  affinity_get: { required: ['qq'], properties: ['qq'] },
  affinity_adjust: { required: ['qq', 'reason'], properties: ['qq', 'delta', 'reason', 'kind'] },
  affinity_slot: { required: ['qq', 'slot'], properties: ['qq', 'slot'] },
  affinity_list: { required: [], properties: [] },
  affinity_migrate: { required: [], properties: [] },
  mem_recall: { required: ['query'], properties: ['query', 'k', 'channel', 'person'] },
  mem_note: { required: ['text'], properties: ['text', 'channel', 'people', 'tags'] },
  mem_supersede: { required: ['text'], properties: ['text'] },
  mem_stats: { required: [], properties: [] },
  worker_run: { required: ['task'], properties: ['task', 'cwd'] },
  worker_status: { required: ['id'], properties: ['id'] },
  worker_list: { required: [], properties: [] },
  alive_want: {
    required: ['text', 'why'],
    properties: ['text', 'why', 'about', 'afterMinutes', 'atTime'],
  },
  alive_list: { required: [], properties: ['includeDone'] },
  alive_done: { required: ['id'], properties: ['id', 'result'] },
  alive_drop: { required: ['id'], properties: ['id'] },
  life_now: { required: [], properties: [] },
  life_set: { required: [], properties: ['mood', 'energy', 'doing'] },
  person_get: { required: ['qq'], properties: ['qq', 'k'] },
  person_list: { required: [], properties: [] },
  person_upsert: {
    required: ['qq'],
    properties: ['qq', 'name', 'relation', 'impression', 'important', 'landmines', 'hints'],
  },
  session_new: { required: [], properties: ['kickoff'] },
}

function assertToolSet(toolMap, expectedNames, label) {
  assert.deepEqual(
    [...toolMap.keys()].sort(),
    [...expectedNames].sort(),
    `${label}：工具集合不对`,
  )
  for (const name of expectedNames) {
    const def = toolMap.get(name)
    const expected = EXPECTED[name]
    assert.ok(expected, `测试漏写 ${name} 的 schema`)
    assert.equal(typeof def.execute, 'function', `${name} 缺 execute`)
    assert.ok(def.output?.schema, `${name} 缺 output.schema`)
    assert.equal(typeof def.output.render, 'function', `${name} 缺 output.render`)
    assert.deepEqual(def.parameters.required ?? [], expected.required, `${name} 的 required 变了`)
    assert.deepEqual(
      Object.keys(def.parameters.properties ?? {}),
      expected.properties,
      `${name} 的参数名变了`,
    )
    assert.deepEqual(
      def.output.schema.required,
      ['ok', 'detail'],
      `${name} 的输出至少要有 ok / detail`,
    )
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-willa-smoke-'))
const fakeDsh = path.join(tmp, 'fake-dsh.js')
const missingDsh = path.join(tmp, 'missing-dsh.js')
await fs.writeFile(fakeDsh, '// fake dsh bin for smoke test\n', 'utf8')

const baseWilla = {
  enablePersona: false,
  enableWilla: true,
  willaDataDir: path.join(tmp, 'data'),
  willaWorkspace: path.join(tmp, 'ws'),
  wakeSessionsRoot: path.join(tmp, 'sessions'),
}

try {
  // 全配：26 个。
  {
    const { ctx, injected, toolMap, dispose } = makeCtx()
    mod.apply(ctx, {
      ...baseWilla,
      qqHttpUrl: 'http://127.0.0.1:39999',
      qqToken: 'smoke-token',
      qqSelfId: '10000',
      memoryEmbedUrl: 'http://127.0.0.1:39998/v1/embeddings',
      memoryEmbedModel: 'smoke-model',
      workerDshBin: fakeDsh,
      workerNodeBin: process.execPath,
      workerProfile: 'headless',
    })
    assert.deepEqual(injected, [], '开 willa 时不再动态 inject tools（静态依赖 + 同步挂）')
    assert.equal(toolMap.size, 26, `全配时应注册 26 个工具，实际 ${toolMap.size}`)
    assertToolSet(toolMap, Object.keys(EXPECTED), '全配')
    dispose()
  }

  // QQ 没配：qq_* 四个不注册，其余 22 个照常。
  {
    const { ctx, toolMap, dispose } = makeCtx()
    mod.apply(ctx, {
      ...baseWilla,
      memoryEmbedUrl: 'http://127.0.0.1:39998/v1/embeddings',
      workerDshBin: fakeDsh,
      workerNodeBin: process.execPath,
    })
    const names = Object.keys(EXPECTED).filter((n) => !n.startsWith('qq_'))
    assert.equal(toolMap.size, 22, `无 QQ 时应注册 22 个，实际 ${toolMap.size}`)
    assertToolSet(toolMap, names, '无 QQ')
    dispose()
  }

  // embed 没配：mem_recall / mem_note 不注册，mem_stats 保留并显示「记忆未配置」。
  {
    const { ctx, toolMap, dispose } = makeCtx()
    mod.apply(ctx, {
      ...baseWilla,
      qqHttpUrl: 'http://127.0.0.1:39999',
      qqToken: 'smoke-token',
      qqSelfId: '10000',
      memoryEmbedUrl: '',
      workerDshBin: fakeDsh,
      workerNodeBin: process.execPath,
    })
    const names = Object.keys(EXPECTED).filter(
      (n) => n !== 'mem_recall' && n !== 'mem_note',
    )
    assert.equal(toolMap.size, 24, `无 embed 时应注册 24 个，实际 ${toolMap.size}`)
    assertToolSet(toolMap, names, '无 embed')
    assert.ok(toolMap.has('mem_stats'), 'mem_stats 必须保留')
    assert.ok(toolMap.has('mem_supersede'), 'mem_supersede 是本地读写，必须保留')
    const value = await toolMap.get('mem_stats').execute({})
    assert.match(value.detail, /记忆未配置/, 'mem_stats 应显示「记忆未配置」')
    dispose()
  }

  // worker 没配：worker_* 三个不注册，其余 23 个照常。
  {
    const { ctx, toolMap, dispose } = makeCtx()
    mod.apply(ctx, {
      ...baseWilla,
      qqHttpUrl: 'http://127.0.0.1:39999',
      qqToken: 'smoke-token',
      qqSelfId: '10000',
      memoryEmbedUrl: 'http://127.0.0.1:39998/v1/embeddings',
      workerDshBin: missingDsh,
      workerNodeBin: process.execPath,
    })
    const names = Object.keys(EXPECTED).filter((n) => !n.startsWith('worker_'))
    assert.equal(toolMap.size, 23, `无 worker 时应注册 23 个，实际 ${toolMap.size}`)
    assertToolSet(toolMap, names, '无 worker')
    dispose()
  }

  // 纯本地：QQ / embed / worker 都没有，affinity + person + life + alive + session 照常。
  {
    const { ctx, toolMap, dispose } = makeCtx()
    mod.apply(ctx, {
      ...baseWilla,
      workerDshBin: missingDsh,
      memoryEmbedUrl: '',
    })
    const local = [
      'affinity_get',
      'affinity_adjust',
      'affinity_slot',
      'affinity_list',
      'affinity_migrate',
      'mem_supersede',
      'mem_stats',
      'person_get',
      'person_list',
      'person_upsert',
      'life_now',
      'life_set',
      'alive_want',
      'alive_list',
      'alive_done',
      'alive_drop',
      'session_new',
    ]
    assert.equal(toolMap.size, 17, `纯本地应注册 17 个，实际 ${toolMap.size}`)
    assertToolSet(toolMap, local, '纯本地')
    for (const name of ['qq_send', 'qq_read', 'mem_recall', 'mem_note', 'worker_run']) {
      assert.ok(!toolMap.has(name), `${name} 在缺后端时不应注册`)
    }
    dispose()
  }

  // ── 第三阶段：四个后台的挂载 / 清理 / 降级 ──────────────────────────
  {
    const fake = installFakeRuntime()
    try {
      const backgroundOn = {
        ...baseWilla,
        qqHttpUrl: 'http://127.0.0.1:39999',
        qqToken: 'smoke-token',
        qqSelfId: '10000',
        qqWsUrl: 'ws://127.0.0.1:39999',
        qqWatch: [],
        wakeEnabled: true,
        wakeSessionId: 'session-smoke-door',
        wanderEnabled: true,
        wanderMinMinutes: 5,
        wanderMaxMinutes: 5,
        wanderQuietFrom: 0,
        wanderQuietTo: 0,
        qzoneEnabled: true,
        qzoneHttpUrl: 'http://127.0.0.1:39997',
        qzoneToken: 'smoke-token',
        qzoneEveryMinutes: 10,
        aliveEnabled: true,
        memoryEmbedUrl: '',
        workerDshBin: missingDsh,
      }

      // (a) 四种开关全开：alive / wake / wander / qzone 都应挂上。
      const first = makeCtx()
      mod.apply(first.ctx, backgroundOn)
      let counts = fake.counts()
      assert.equal(counts.intervals, 2, 'alive + qzone 应各有一个 interval')
      assert.equal(counts.timeouts, 1, 'wander 应有一个 setTimeout')
      assert.equal(counts.sockets, 1, 'wake 应有一条 WebSocket')
      for (const text of ['alive 定时器已启动', 'wake 已启动', 'wander 已启动', 'qzone 已启动']) {
        assert.ok(
          first.logs.some((line) => line.includes(text)),
          `四种全开时应记一条启动日志：${text}`,
        )
      }

      // 模拟「插件重载前又 apply 了一次」：四类各两份。
      const second = makeCtx()
      mod.apply(second.ctx, backgroundOn)
      counts = fake.counts()
      assert.deepEqual(
        counts,
        { intervals: 4, timeouts: 2, sockets: 2 },
        '挂两次应有且只有两份后台',
      )

      // (c) dispose 一份 → 只剩另一份，证明 cleanup 真的清掉了，不是叠着。
      first.dispose()
      counts = fake.counts()
      assert.deepEqual(
        counts,
        { intervals: 2, timeouts: 1, sockets: 1 },
        'dispose 一份后应只剩一份后台',
      )
      second.dispose()
      assert.deepEqual(
        fake.counts(),
        { intervals: 0, timeouts: 0, sockets: 0 },
        'dispose 后定时器 / 重连 / WS 应清零',
      )

      // (b) 全关：一个后台都不挂。
      const off = makeCtx()
      mod.apply(off.ctx, {
        ...baseWilla,
        aliveEnabled: false,
        wakeEnabled: false,
        wanderEnabled: false,
        qzoneEnabled: false,
        memoryEmbedUrl: '',
        workerDshBin: missingDsh,
      })
      assert.deepEqual(
        fake.counts(),
        { intervals: 0, timeouts: 0, sockets: 0 },
        '全关时不应挂任何后台',
      )
      assert.ok(
        !off.logs.some((line) => /(已启动)/.test(line) && /(alive|wake|wander|qzone)/.test(line)),
        '全关时不应有后台启动日志',
      )
      off.dispose()

      // (d) 没 wakeSessionId：wake 不启、不猜会话、不抛错，并留一条日志。
      const noDoor = makeCtx()
      assert.doesNotThrow(() => {
        mod.apply(noDoor.ctx, {
          ...backgroundOn,
          aliveEnabled: false,
          wanderEnabled: false,
          qzoneEnabled: false,
          wakeSessionId: '',
        })
      }, '缺 wakeSessionId 时 apply 不应抛错')
      assert.equal(fake.counts().sockets, 0, '缺 wakeSessionId 时不应建 WS')
      assert.ok(
        noDoor.logs.some((line) => line.includes('wakeSessionId')),
        '缺 wakeSessionId 时应记一条日志',
      )
      noDoor.dispose()

      // 空 token：默认不启；显式 wakeAllowEmptyToken:true 才启。
      const emptyTokenBlocked = makeCtx()
      mod.apply(emptyTokenBlocked.ctx, {
        ...backgroundOn,
        aliveEnabled: false,
        wanderEnabled: false,
        qzoneEnabled: false,
        qqToken: '',
      })
      assert.equal(fake.counts().sockets, 0, '空 token 且未显式允许时不应建 WS')
      emptyTokenBlocked.dispose()

      const emptyTokenAllowed = makeCtx()
      mod.apply(emptyTokenAllowed.ctx, {
        ...backgroundOn,
        aliveEnabled: false,
        wanderEnabled: false,
        qzoneEnabled: false,
        qqToken: '',
        wakeAllowEmptyToken: true,
      })
      assert.equal(fake.counts().sockets, 1, '显式允许空 token 时应建 WS')
      emptyTokenAllowed.dispose()
      assert.deepEqual(
        fake.counts(),
        { intervals: 0, timeouts: 0, sockets: 0 },
        '所有后台测完后应清零',
      )
    } finally {
      fake.restore()
    }
  }

  console.log(
    `smoke ok: ${mod.name}, ${Object.keys(DEFAULTS).length} config keys, ` +
      `26 tools full / 22 no-qq / 24 no-embed / 23 no-worker / 17 local-only; ` +
      `background 4-on / 0-off / dispose-zero / wake-no-session`,
  )
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}
