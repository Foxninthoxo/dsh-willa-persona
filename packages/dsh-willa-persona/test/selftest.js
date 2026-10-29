'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-willa-persona-test-'))
process.env.DSH_HOME = tmpHome

const storage = require('../lib/storage.js')
const plugin = require('../lib/index.js')
const wander = require('../lib/wander.js')

const results = []
function ok(label, detail = '') {
  results.push(`ok ${label}${detail ? `：${detail}` : ''}`)
}

function makeCtx(options = {}) {
  const sections = []
  const tools = []
  const ctx = {
    systemPrompt: {
      section(definition) {
        sections.push(definition)
        return () => {}
      },
      getSectionOrder() {
        return 0
      },
    },
    tools: {
      get(name) {
        if (typeof options.toolsGet === 'function') return options.toolsGet(name)
        return undefined
      },
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
    logger() {
      return { info() {}, warn() {} }
    },
  }
  if (options.scheduleService) {
    ctx.reflect = {
      get(name) {
        return name === 'schedule' ? options.scheduleService : undefined
      },
    }
  }
  return { ctx, sections, tools }
}

function makeFakeHost() {
  const records = new Map()
  const calls = []
  let serial = 0
  return {
    records,
    calls,
    async create(sessionId, request) {
      calls.push({ op: 'create', sessionId, request })
      serial += 1
      const record = {
        id: `host-${serial}`,
        title: request.title,
        prompt: request.prompt,
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        state: 'scheduled',
        deliveryMode: 'host',
      }
      records.set(record.id, record)
      return record
    },
    async list({ sessionId }) {
      calls.push({ op: 'list', sessionId })
      return [...records.values()]
    },
    async update(request) {
      calls.push({ op: 'update', request })
      const old = records.get(request.id)
      if (!old) return { id: request.id, updated: false, code: 'schedule_not_found' }
      const record = {
        ...old,
        title: request.title ?? old.title,
        prompt: request.prompt ?? old.prompt,
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      }
      records.set(record.id, record)
      return { record }
    },
    async delete(request) {
      calls.push({ op: 'delete', request })
      const deleted = records.delete(request.id)
      return { id: request.id, deleted }
    },
  }
}

async function main() {
  assert.equal(plugin.name, 'dsh-willa-persona')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.PERSONA_SECTION, 'willa:persona')
  const validated = plugin.Config['~standard'].validate({ ownerName: '阿测' })
  assert.equal(validated.value.ownerName, '阿测')
  assert.equal(validated.value.allowExtraTools, false)
  assert.equal(validated.value.scheduleEnabled, true)
  assert.equal(validated.value.wanderEnabled, true)
  ok('require lib/index.js', 'name / apply / section / Config 都对')

  const pkg = require('../package.json')
  if (pkg.repository) {
    // 仓库字段是发布前补的；补了就得是正经地址，不能再是占位符。
    // 单仓两包之后 repository 多了 directory，地址也可能写成 SSH。
    assert.match(
      pkg.repository.url,
      /^(?:git\+https:\/\/github\.com\/|git@github\.com:)[^/]+\/[^/]+\.git$/,
    )
    assert.equal(pkg.repository.directory, 'packages/dsh-willa-persona')
    assert.match(
      pkg.homepage,
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/main\/packages\/[^/]+$/,
    )
    assert.match(pkg.bugs.url, /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues$/)
    ok('package.json 仓库字段', 'repository（含 directory）/ homepage / bugs 已填且格式正确')
  } else {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
    assert.ok(readme.includes('发布前补 repository'))
    ok('package.json 占位字段', 'repository / homepage / bugs 已删，README 写明发布前补仓库')
  }

  const paths = storage.ensureStores()
  const ownerPath = storage.ownerPath()
  assert.ok(fs.existsSync(paths.memory))
  assert.ok(fs.existsSync(paths.xinchang))
  assert.ok(fs.existsSync(paths.schedules))
  assert.ok(fs.existsSync(paths.wander))
  assert.deepEqual(storage.loadMemory().items, [])
  assert.deepEqual(Object.keys(storage.loadXinchang().people), [])
  ok(
    '空库创建',
    `${path.relative(tmpHome, paths.memory)} + ${path.relative(tmpHome, paths.xinchang)} + 定时/唤醒空文件`,
  )

  // ------------------------------------------- 零配置 + 称呼自动化
  assert.equal(fs.existsSync(ownerPath), false)
  const barePrompt = plugin.buildSystemPrompt({})
  assert.equal(plugin.resolveOwner({}).known, false)
  assert.equal(plugin.resolveOwner({}).name, '你')
  assert.ok(barePrompt.includes('先用「你」'))
  assert.ok(barePrompt.includes('我该怎么叫'))
  assert.ok(barePrompt.includes('willa_set_owner'))
  assert.ok(!barePrompt.includes('主人'))
  ok('没有 owner.json', '人设用「你」，带「问怎么称呼」引导，不出现「主人」')

  const zeroCtx = makeCtx()
  const zeroRuntime = plugin.apply(zeroCtx.ctx, {})
  assert.equal(zeroCtx.sections.length, 1)
  assert.equal(zeroCtx.sections[0].name, 'willa:persona')
  const zeroToolNames = zeroCtx.tools.map((tool) => tool.name)
  assert.equal(zeroToolNames.length, 16)
  assert.ok(zeroToolNames.includes('willa_set_owner'))
  assert.ok(zeroToolNames.includes('schedule_create'))
  assert.ok(zeroRuntime.scheduler instanceof plugin.ScheduleEngine)
  assert.ok(zeroRuntime.wander instanceof plugin.WanderEngine)
  for (const file of [paths.memory, paths.xinchang, paths.schedules, paths.wander]) {
    assert.ok(fs.existsSync(file), `${file} 应自动建`)
  }
  const zeroPrompt = zeroCtx.sections[0].text()
  assert.ok(zeroPrompt.includes('# 人设：Willa'))
  assert.ok(zeroPrompt.includes('我该怎么叫'))
  ok('零配置启动', '16 个工具 + 人设段 + 定时 + 唤醒，存储文件自动建')

  const ownerTool = zeroCtx.tools.find((tool) => tool.name === 'willa_set_owner')
  const emptyOwner = await ownerTool.execute({ name: '' })
  assert.equal(emptyOwner.ok, false)
  assert.ok(emptyOwner.detail.includes('name'))
  const tooLongOwner = await ownerTool.execute({ name: 'x'.repeat(41) })
  assert.equal(tooLongOwner.ok, false)
  assert.ok(tooLongOwner.detail.includes('40'))
  const firstOwner = await ownerTool.execute({ name: '阿测' })
  assert.equal(firstOwner.ok, true)
  assert.equal(firstOwner.detail, '记住了，以后叫你 阿测')
  assert.ok(fs.existsSync(ownerPath))
  assert.equal(storage.loadOwner().name, '阿测')
  assert.ok(!zeroCtx.sections[0].text().includes('我该怎么叫'))
  assert.ok(zeroCtx.sections[0].text().includes('阿测'))

  const renamed = await ownerTool.execute({ name: '小测', note: '改名测试' })
  assert.equal(renamed.ok, true)
  assert.equal(storage.loadOwner().name, '小测')
  assert.equal(storage.loadOwner().note, '改名测试')
  assert.ok(zeroCtx.sections[0].text().includes('小测'))
  assert.ok(!zeroCtx.sections[0].text().includes('阿测'))

  assert.equal(plugin.resolveOwner({ ownerName: '配置名' }).from, 'config')
  const overridePrompt = plugin.buildSystemPrompt({ ownerName: '配置名' })
  assert.ok(overridePrompt.includes('配置名'))
  assert.ok(!overridePrompt.includes('小测'))
  assert.ok(!overridePrompt.includes('我该怎么叫'))
  ok('willa_set_owner', '生成 owner.json、人设换成新名字、再调改名；config.ownerName 覆盖存储')

  fs.writeFileSync(ownerPath, '{"name":')
  assert.equal(storage.loadOwner(), null)
  const ownerBackup = fs
    .readdirSync(path.dirname(ownerPath))
    .find((entry) => /^owner\.corrupt-.*\.json$/.test(entry))
  assert.ok(ownerBackup, 'owner.json 坏文件应被备份')
  const brokenPrompt = plugin.buildSystemPrompt({})
  assert.ok(brokenPrompt.includes('我该怎么叫'))
  assert.ok(!brokenPrompt.includes('小测'))
  fs.writeFileSync(ownerPath, 'null')
  assert.equal(storage.loadOwner(), null)
  assert.equal(fs.existsSync(ownerPath), false)
  zeroRuntime.stop()
  ok('坏 owner.json 兜底', '坏 JSON / JSON null 都先备份成 owner.corrupt-<时间戳>.json，再按没设置处理')

  // ---------------------------------------------------------- 坏 JSON 兜底
  fs.writeFileSync(paths.memory, '{"version":1,"items":[')
  fs.writeFileSync(paths.xinchang, 'not json at all')
  assert.deepEqual(storage.loadMemory().items, [])
  assert.deepEqual(Object.keys(storage.loadXinchang().people), [])
  const storeDir = path.dirname(paths.memory)
  const backupNames = fs.readdirSync(storeDir)
  const memoryBackup = backupNames.find((name) => /^memory\.corrupt-.*\.json$/.test(name))
  const xinchangBackup = backupNames.find((name) => /^xinchang\.corrupt-.*\.json$/.test(name))
  assert.ok(memoryBackup, 'memory.json 坏文件应被备份')
  assert.ok(xinchangBackup, 'xinchang.json 坏文件应被备份')
  assert.match(fs.readFileSync(path.join(storeDir, memoryBackup), 'utf8'), /items/)
  ok('坏 JSON 兜底', 'memory / xinchang 先备份成 .corrupt-<时间戳>.json，再按空库继续')

  // ------------------------------------------------------ 原型污染防护
  for (const badId of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(
      () => storage.adjustXinchang(badId, { delta: 9, reason: '原型污染测试' }),
      /personId/,
    )
  }
  assert.equal(Object.prototype.score, undefined)
  assert.equal(Object.prototype.msgs, undefined)
  assert.equal(({}).score, undefined)
  assert.equal(storage.deleteXinchang('__proto__'), false)
  assert.deepEqual(storage.listXinchang(), [])

  // 历史坏数据里直接带 __proto__ / constructor 键，也不能读进来。
  fs.writeFileSync(
    paths.xinchang,
    '{"version":1,"people":{"__proto__":{"score":9,"msgs":1},"constructor":{"score":8}}}',
  )
  assert.deepEqual(Object.keys(storage.loadXinchang().people), [])
  assert.equal(Object.prototype.score, undefined)
  ok('原型污染防护', '__proto__ / constructor / prototype 都被拒，Object.prototype 干净')

  // ------------------------------------------------------- 间隔上下限
  assert.throws(() => plugin.parsePlan({ every_seconds: 0.001 }), /every_seconds/)
  assert.throws(() => plugin.parsePlan({ every_seconds: 0 }), /every_seconds/)
  assert.throws(() => plugin.parsePlan({ every_seconds: -5 }), /every_seconds/)
  assert.throws(() => plugin.parsePlan({ every_seconds: 31 * 24 * 3600 }), /every_seconds/)
  assert.throws(() => plugin.parsePlan({ after_seconds: 0 }), /after_seconds/)
  assert.throws(() => plugin.parsePlan({ after_seconds: -1 }), /after_seconds/)
  assert.equal(plugin.parsePlan({ every_seconds: 60 }).seconds, 60)
  assert.throws(() => plugin.parsePlan({ cron: `0 0 ${'1,'.repeat(300)}* *` }), /cron/)
  const clampedConfig = plugin.normalizeConfig({ wanderMinMinutes: 0, wanderMaxMinutes: -5 })
  assert.ok(clampedConfig.wanderMinMinutes >= 1)
  assert.ok(clampedConfig.wanderMaxMinutes >= 1)
  assert.ok(plugin.normalizeConfig({ wanderMaxMinutes: 999999 }).wanderMaxMinutes <= 30 * 24 * 60)
  ok('定时间隔下限', '0.001 被拒；0/负数被拒；超 30 天被拒；cron 超长被拒；wander 分钟数限幅')

  const item = storage.addMemory({
    text: '测试记忆：小鱼干放在第二层抽屉',
    channel: 'selftest',
    people: ['u1'],
    tags: ['小鱼干', '位置'],
  })
  assert.equal(storage.loadMemory().items.length, 1)
  const hits = storage.recallMemory('小鱼干')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].item.id, item.id)
  assert.ok(hits[0].score > 0)
  const semantic = await storage.searchMemory('抽屉')
  assert.equal(semantic.hits[0].item.id, item.id)
  assert.equal(semantic.mode, 'keyword')
  assert.equal(storage.deleteMemory(item.id), true)
  assert.equal(storage.loadMemory().items.length, 0)
  ok('记忆写 / 读 / 删', '关键词与无端点检索都命中')

  const endpoint = 'https://example.invalid/v1'
  const oldFetch = global.fetch
  try {
    global.fetch = async (url, init) => {
      assert.equal(String(url), `${endpoint}/embeddings`)
      const body = JSON.parse(init.body)
      assert.equal(body.model, 'test-embed')
      return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 0, 0] }] }) }
    }
    const vectorItem = await storage.noteMemory(
      '向量测试：蓝色鲸鱼在海里',
      { channel: 'selftest' },
      { endpoint, model: 'test-embed' },
    )
    const vectorHits = await storage.searchMemory('鲸鱼', { k: 3 }, { endpoint, model: 'test-embed' })
    assert.equal(vectorHits.mode, 'vector')
    assert.equal(vectorHits.hits[0].item.id, vectorItem.item.id)
    assert.equal(storage.deleteMemory(vectorItem.item.id), true)
    ok('可选向量检索', 'mock 端点请求格式正确，空库仍可退回关键词')
  } finally {
    global.fetch = oldFetch
  }

  const adjusted = storage.adjustXinchang('u1', { delta: 1.5, reason: '帮了个忙', kind: 'happy' })
  assert.equal(adjusted.score, 1.5)
  assert.equal(storage.getXinchang('u1').msgs, 1)
  storage.setXinchangSlot('u1', '朋友')
  assert.equal(storage.getXinchang('u1').slot, '朋友')
  assert.equal(storage.listXinchang().length, 1)
  assert.equal(storage.deleteXinchang('u1'), true)
  assert.equal(storage.getXinchang('u1'), null)
  ok('心账写 / 查 / 定格 / 删', '分数、条数、格子都正确')

  const qqAdjusted = storage.adjustXinchang('qq=123456789', { delta: 1, reason: '前缀规范化', kind: 'happy' })
  assert.equal(qqAdjusted.personId, '123456789')
  assert.equal(storage.getXinchang('123456789').score, 1)
  assert.equal(storage.getXinchang('qq=123456789').personId, '123456789')
  assert.equal(storage.deleteXinchang('qq=123456789'), true)
  assert.equal(storage.getXinchang('123456789'), null)
  ok('心账 personId 归一', 'qq=123456789 / qq:123456789 都落到同一个 123456789')

  const mainCtx = makeCtx()
  const runtime = plugin.apply(mainCtx.ctx, {
    ownerName: '阿测',
    allowExtraTools: false,
    wanderEnabled: false,
  })
  assert.equal(mainCtx.sections.length, 1)
  assert.equal(mainCtx.sections[0].name, 'willa:persona')
  assert.equal(mainCtx.sections[0].interpolate, false)
  assert.equal(typeof mainCtx.sections[0].text, 'function')

  const prompt = mainCtx.sections[0].text()
  assert.ok(prompt.includes('阿测'))
  assert.ok(prompt.includes('OCEAN'))
  assert.ok(prompt.includes('反例'))
  assert.ok(prompt.includes('定时和自己醒'))
  assert.ok(prompt.includes('不要一次排一堆'))
  assert.ok(!/:\d{4}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|(?:^|\D)\d{9,11}(?:\D|$)/.test(prompt))
  const strictPrompt = plugin.buildSystemPrompt({ ownerName: '阿测', allowExtraTools: false })
  assert.ok(strictPrompt.includes('不要自己安装插件'))
  assert.ok(strictPrompt.includes('本包自带轻量定时'))
  const loosePrompt = plugin.buildSystemPrompt({ ownerName: '主人', allowExtraTools: true })
  assert.ok(loosePrompt.includes('可以主动帮主人装外部工具，但装之前要先问'))
  ok('systemPrompt 注入', `${prompt.length} 字，默认禁装 / 定时与唤醒文案都对`)

  const toolNames = mainCtx.tools.map((tool) => tool.name)
  const coreNames = [
    'mem_note',
    'mem_recall',
    'mem_stats',
    'mem_supersede',
    'xinchang_get',
    'xinchang_list',
    'xinchang_adjust',
    'xinchang_slot',
    'willa_set_owner',
  ]
  assert.deepEqual(toolNames.slice(0, 9), coreNames)
  // 定时四个 + 爱好三个：顺序可能变，按集合比，别写死位置
  const rest = toolNames.slice(9)
  assert.equal(rest.length, 7)
  for (const name of ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete']) {
    assert.ok(rest.includes(name), '缺定时工具：' + name)
  }
  for (const name of ['hobby_add', 'hobby_list', 'hobby_remove']) {
    assert.ok(rest.includes(name), '缺爱好工具：' + name)
  }
  for (const tool of mainCtx.tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.execute, 'function')
  }
  ok('工具注册', `${mainCtx.tools.length} 个，schema 与 execute 完整`)

  // -------------------------------------------- 工具层原型污染 / 路径脱敏
  const adjustTool = mainCtx.tools.find((tool) => tool.name === 'xinchang_adjust')
  const slotTool = mainCtx.tools.find((tool) => tool.name === 'xinchang_slot')
  const statsTool = mainCtx.tools.find((tool) => tool.name === 'mem_stats')
  const protoAdjusted = await adjustTool.execute({
    personId: '__proto__',
    delta: 9,
    reason: '原型污染测试',
  })
  assert.equal(protoAdjusted.ok, false)
  assert.ok(protoAdjusted.detail.includes('personId'))
  const protoSlot = await slotTool.execute({ personId: 'constructor', slot: '朋友' })
  assert.equal(protoSlot.ok, false)
  assert.equal(Object.prototype.score, undefined)
  ok('工具层原型污染防护', '__proto__ / constructor 只回人话错误，不写原型链')

  const statsOut = await statsTool.execute()
  assert.equal(statsOut.ok, true)
  assert.match(statsOut.detail, /storages\/dsh-willa-persona\/memory\.json/)
  assert.ok(!/[A-Za-z]:\\/.test(statsOut.detail), statsOut.detail)
  assert.ok(!statsOut.detail.includes(tmpHome))

  const badHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-willa-persona-bad-'))
  fs.mkdirSync(path.join(badHome, 'storages', 'dsh-willa-persona', 'memory.json'), {
    recursive: true,
  })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = badHome
  try {
    const badStats = await statsTool.execute()
    assert.equal(badStats.ok, false)
    assert.ok(!/[A-Za-z]:\\/.test(badStats.detail), badStats.detail)
    assert.ok(!badStats.detail.includes(badHome))
    assert.ok(!/\n\s+at\s/.test(badStats.detail))
  } finally {
    process.env.DSH_HOME = previousHome
    fs.rmSync(badHome, { recursive: true, force: true })
  }
  ok('工具输出 / 错误脱敏', 'mem_stats 只给相对路径；读失败只回原因，不带 C:\\ 或堆栈')

  // ------------------------------------------------------------ 定时任务
  const delivered = []
  mainCtx.ctx.reflect = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async resolveAgent(sessionId) {
            return {
              agent: {
                session: { id: sessionId },
                followup(message) {
                  delivered.push({ sessionId, message })
                },
              },
            }
          },
        }
      }
      if (name === 'sessions') return { async flush() { return true } }
      return undefined
    },
  }
  const createTool = mainCtx.tools.find((tool) => tool.name === 'schedule_create')
  const listTool = mainCtx.tools.find((tool) => tool.name === 'schedule_list')
  const updateTool = mainCtx.tools.find((tool) => tool.name === 'schedule_update')
  const deleteTool = mainCtx.tools.find((tool) => tool.name === 'schedule_delete')
  const exec = { agent: { session: { id: 'sess-selftest' } } }

  const tooFast = await createTool.execute({ prompt: '太密了', every_seconds: 0.001 }, exec)
  assert.equal(tooFast.ok, false)
  assert.match(tooFast.detail, /every_seconds/)
  assert.equal(runtime.scheduler.items.length, 0)

  const created = await createTool.execute(
    { prompt: '该喝水了', title: '喝水', after_seconds: 1 },
    exec,
  )
  assert.equal(created.ok, true)
  assert.equal(runtime.scheduler.items.length, 1)
  const firstId = runtime.scheduler.items[0].id

  await runtime.scheduler.tick(Date.now() + 5_000)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].sessionId, 'sess-selftest')
  assert.equal(delivered[0].message.role, 'user')
  assert.equal(delivered[0].message.content[0].text, '该喝水了')
  assert.equal(runtime.scheduler.items[0].enabled, false)

  const listed = await listTool.execute()
  assert.equal(listed.ok, true)
  assert.ok(listed.detail.includes(firstId))
  assert.ok(listed.detail.includes('喝水'))

  const updated = await updateTool.execute(
    { id: firstId, every_seconds: 60, prompt: '改成每分钟' },
    exec,
  )
  assert.equal(updated.ok, true)
  assert.ok(updated.detail.includes('每 1 分钟'))
  assert.equal(runtime.scheduler.items[0].plan.kind, 'every')
  assert.equal(runtime.scheduler.items[0].prompt, '改成每分钟')
  assert.equal(runtime.scheduler.items[0].enabled, true)

  const deleted = await deleteTool.execute({ id: firstId })
  assert.equal(deleted.ok, true)
  assert.equal(runtime.scheduler.items.length, 0)
  ok('定时创建 / 到点投递 / list / update / delete', 'after_seconds 到点投进打桩会话，四个工具都验过')

  const mathNow = Date.now()
  const dailyAt = plugin.nextOccurrence(
    { kind: 'daily', hour: 9, minute: 0, timezone: 'Asia/Shanghai' },
    mathNow,
  )
  assert.ok(dailyAt > mathNow)
  const dailyClock = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(dailyAt))
    .filter((part) => part.type !== 'literal')
    .reduce((out, part) => ({ ...out, [part.type]: part.value }), {})
  assert.equal(dailyClock.hour, '09')
  assert.equal(dailyClock.minute, '00')

  const cronAt = plugin.nextOccurrence(
    { kind: 'cron', expression: '*/15 9-17 * * 1-5', timezone: 'Asia/Shanghai' },
    mathNow,
  )
  assert.ok(cronAt > mathNow)
  const cronParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  })
    .formatToParts(new Date(cronAt))
    .filter((part) => part.type !== 'literal')
    .reduce((out, part) => ({ ...out, [part.type]: part.value }), {})
  assert.ok([0, 15, 30, 45].includes(Number(cronParts.minute)))
  assert.ok(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(cronParts.weekday))
  ok('日 / cron 时间计算', '时区、分钟步长和工作日都对')

  // ------------------------------------------------ 随机唤醒（区间 + 持久化）
  const fixed = Date.now()
  const woke = []
  const wanderEngine = new plugin.WanderEngine({
    config: { wanderEnabled: true, wanderPrompt: '醒醒，自己找点事做' },
    minMs: 1_000,
    maxMs: 1_000,
    now: () => fixed,
    deliver: async (sessionId, text) => {
      woke.push({ sessionId, text })
    },
    logger: { warn() {} },
  })
  assert.equal(plugin.chooseWanderDelay(1_000, 2_000, () => 0), 1_000)
  assert.equal(plugin.chooseWanderDelay(1_000, 2_000, () => 1), 2_000)
  assert.equal(plugin.chooseWanderDelay(1_000, 2_000, () => 0.5), 1_500)
  assert.equal(plugin.DEFAULT_WANDER_PROMPT, '这会儿没人找你。自己想干点什么？想不出来就发呆，或者去学十五分钟。')
  const wanderBefore = storage.loadWander()
  assert.equal(Date.parse(wanderBefore.nextAt) - fixed, 1_000)

  await wanderEngine.tick(fixed + 1_000)
  assert.equal(woke.length, 1)
  assert.ok(typeof woke[0].text === 'string' && woke[0].text.length > 0, '唤醒提示不能是空的')
  const wanderAfter = storage.loadWander()
  assert.equal(Date.parse(wanderAfter.nextAt) - (fixed + 1_000), 1_000)
  assert.equal(wanderAfter.lastResult, 'delivered')
  wanderEngine.stop()

  const safeEngine = new plugin.WanderEngine({
    config: { wanderEnabled: true },
    minMs: 1_000,
    maxMs: 1_000,
    now: () => fixed,
    deliver: async () => {
      throw new Error('没有投递通道')
    },
    logger: { warn() {} },
  })
  await safeEngine.tick(fixed + 1_000)
  assert.equal(storage.loadWander().lastResult, 'skipped')
  assert.ok(Date.parse(storage.loadWander().nextAt) > fixed)
  safeEngine.stop()
  ok('随机唤醒（区间 + wander.json）', '落在 [min,max]，醒完更新下次，没通道只记日志')

  // ------------------------------------------------------ 借宿主调度 / 重名
  const fakeHost = makeFakeHost()
  const hostCtx = makeCtx({ scheduleService: fakeHost })
  const hostRuntime = plugin.apply(hostCtx.ctx, {
    ownerName: '阿测',
    wanderEnabled: false,
  })
  const hostCreate = hostCtx.tools.find((tool) => tool.name === 'schedule_create')
  const hostList = hostCtx.tools.find((tool) => tool.name === 'schedule_list')
  const hostDelete = hostCtx.tools.find((tool) => tool.name === 'schedule_delete')
  const hostCreated = await hostCreate.execute(
    { prompt: '宿主通道', title: '宿主通道', after_seconds: 5 },
    { agent: { session: { id: 'sess-host' } } },
  )
  assert.equal(hostCreated.ok, true)
  assert.equal(hostRuntime.scheduler.items[0].backend, 'host')
  const hostCreateCall = fakeHost.calls.find((call) => call.op === 'create')
  assert.equal(hostCreateCall.sessionId, 'sess-host')
  assert.equal(hostCreateCall.request.after_seconds, 5)
  const hostListed = await hostList.execute()
  assert.ok(hostListed.detail.includes('借宿主调度'))
  await hostDelete.execute({ id: hostRuntime.scheduler.items[0].id })
  assert.equal(fakeHost.records.size, 0)
  assert.ok(fakeHost.calls.some((call) => call.op === 'delete'))
  hostRuntime.stop()

  const conflictCtx = makeCtx({ toolsGet: (toolName) => toolName === 'schedule_create' })
  const conflictRuntime = plugin.apply(conflictCtx.ctx, {
    ownerName: '阿测',
    wanderEnabled: false,
  })
  assert.equal(conflictRuntime.scheduleToolNames.create, 'willa_schedule_create')
  const conflictRest = conflictCtx.tools.slice(9).map((tool) => tool.name)
  for (const name of ['willa_schedule_create', 'willa_schedule_list', 'willa_schedule_update', 'willa_schedule_delete']) {
    assert.ok(conflictRest.includes(name), '撞名后应该改前缀：' + name)
  }
  for (const name of ['hobby_add', 'hobby_list', 'hobby_remove']) {
    assert.ok(conflictRest.includes(name), '爱好工具不该被撞名影响：' + name)
  }
  conflictRuntime.stop()
  ok('宿主调度适配 / 重名避让', '有 ctx.schedule 就借，撞名整组换 willa_ 前缀')

  // ------------------------------------------ 重启（重新 require）后还在
  const persistCreate = mainCtx.tools.find((tool) => tool.name === 'schedule_create')
  await persistCreate.execute(
    { prompt: '重启后还在', title: '重启后还在', after_seconds: 60 },
    exec,
  )
  const persistentId = runtime.scheduler.items[0].id
  const fileBefore = JSON.parse(fs.readFileSync(paths.schedules, 'utf8'))
  assert.ok(fileBefore.items.some((entry) => entry.id === persistentId))
  runtime.stop()

  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(__dirname, '..', 'lib') + path.sep)) delete require.cache[key]
  }
  const pluginAfterReload = require('../lib/index.js')
  assert.notEqual(pluginAfterReload, plugin)
  const reloadedCtx = makeCtx()
  const reloadedRuntime = pluginAfterReload.apply(reloadedCtx.ctx, {
    ownerName: '阿测',
    wanderEnabled: false,
  })
  const reloadedList = await reloadedRuntime.scheduler.list()
  assert.ok(reloadedList.some((entry) => entry.id === persistentId && entry.title === '重启后还在'))
  await reloadedRuntime.scheduler.remove(persistentId)
  reloadedRuntime.stop()
  ok('定时持久化（重新 require）', 'schedules.json 里的任务重载后还在')


  // ---- 爱好与随机唤醒加权（2026-10-27 加） ----
  {
    const hobbyStore = storage.listHobbies()
    assert.deepEqual(hobbyStore, [])

    const added = storage.addHobby('读《海底两万里》，一次读一章', '一条鱼看海里的故事')
    assert.equal(added.text, '读《海底两万里》，一次读一章')
    assert.equal(storage.addHobby('读《海底两万里》，一次读一章').id, added.id) // 同名不重复加
    const second = storage.addHobby('刷 B 站科技区，挑一个看完')
    assert.equal(storage.listHobbies().length, 2)
    const removed = storage.removeHobby(second.text)
    assert.equal(removed.text, '刷 B 站科技区，挑一个看完')
    assert.equal(storage.listHobbies().length, 1)
    assert.equal(storage.removeHobby('不存在的爱好'), null)
    ok('爱好存储：加 / 同名去重 / 删 / 不存在', '落盘到 storages/dsh-willa-persona/hobbies.json')

    // 权重归一化
    const w = wander.wanderWeights({ wanderWeightHobby: 1, wanderWeightTodo: 1, wanderWeightIdle: 2 })
    assert.ok(Math.abs(w.idle - 0.5) < 1e-9)
    assert.ok(Math.abs(w.hobby - 0.25) < 1e-9)
    const wBad = wander.wanderWeights({ wanderWeightHobby: 'x', wanderWeightTodo: -1 })
    assert.ok(Math.abs(wBad.hobby - 0.5) < 1e-9 && Math.abs(wBad.idle - 0.2) < 1e-9)
    ok('唤醒权重：归一化 / 非法值回落', '默认 0.5 / 0.3 / 0.2')

    // 200 次抽样看命中比例大致符合权重
    const hobbies = [{ text: '读书' }]
    const todos = [{ prompt: '把测试补完' }]
    let hobbyHit = 0
    let todoHit = 0
    const base = { wanderWeightHobby: 1, wanderWeightTodo: 1, wanderWeightIdle: 1, wanderPrompt: '原始那句' }
    for (let i = 0; i < 600; i += 1) {
      const text = wander.buildWanderPrompt(base, { hobbies, todos })
      if (text.includes('爱好') || text.includes('自己喜欢的') || text.includes('今天还没碰') || text.includes('闲着也是闲着')) hobbyHit += 1
      if (text.includes('推进') || text.includes('还挂着') || text.includes('瞄一眼')) todoHit += 1
    }
    assert.ok(hobbyHit > 120 && hobbyHit < 380, '爱好句命中比例异常：' + hobbyHit)
    assert.ok(todoHit > 60 && todoHit < 300, '待办句命中比例异常：' + todoHit)
    ok('随机唤醒按权重挑', '600 次抽样：爱好 ' + hobbyHit + ' 次、待办 ' + todoHit + ' 次')

    // 什么都没有时退回原始那句
    const empty = wander.buildWanderPrompt({ wanderPrompt: '原始那句' }, { hobbies: [], todos: [] })
    assert.ok(typeof empty === 'string' && empty.length > 0)
    ok('唤醒兜底', '没爱好没待办时也有话说（' + empty.slice(0, 16) + '…）')

    // 坏文件兜底
    fs.writeFileSync(storage.hobbiesPath(), '{ broken json', 'utf8')
    assert.deepEqual(storage.listHobbies(), [])
    const backups = fs.readdirSync(path.dirname(storage.hobbiesPath())).filter((f) => f.includes('corrupt'))
    assert.ok(backups.length >= 1)
    ok('爱好文件坏了能兜底', '备份成 ' + backups[0])
  }

  console.log(results.join('\n'))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})
