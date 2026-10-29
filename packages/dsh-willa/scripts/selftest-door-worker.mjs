#!/usr/bin/env node
/**
 * selftest-door-worker.mjs —— 两个「本机验过、移植进包」的功能的回归自检。
 *
 *   A. 门房校验：qq_send 不是当前门房就拒发（严格串行、fail-open、拒绝日志）。
 *   B. worker 回执：子进程 exit 写 <id>.done.json，并往门房注入一句话（只注入一次）。
 *
 * 只碰临时目录：不派真的 dsh（用假 bin）、不发 QQ、不改本机数据。
 *
 *   node scripts/selftest-door-worker.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.js'
import { createDoorGuard } from '../src/willa/qq.js'
import { createWorker, stripAnsi } from '../src/willa/worker.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-willa-selftest-'))

const failures = []
function step(label, fn) {
  try {
    const note = fn()
    console.log(`  ✓ ${label}${note ? `：${note}` : ''}`)
    return true
  } catch (err) {
    failures.push(label)
    console.log(`  ✗ ${label}：${err?.message ?? err}`)
    return false
  }
}
async function stepAsync(label, fn) {
  try {
    const note = await fn()
    console.log(`  ✓ ${label}${note ? `：${note}` : ''}`)
    return true
  } catch (err) {
    failures.push(label)
    console.log(`  ✗ ${label}：${err?.message ?? err}`)
    return false
  }
}

/** 跑 fn，顺手把 console.error 收起来（门房校验的 fail-open 只写 stderr）。 */
function captureStderr(fn) {
  const lines = []
  const original = console.error
  console.error = (...args) => lines.push(args.map(String).join(' '))
  try {
    return { result: fn(), lines }
  } catch (error) {
    return { error, lines }
  } finally {
    console.error = original
  }
}

const tmpCase = (name) => {
  const dir = path.join(tmp, 'door', name)
  fs.mkdirSync(dir, { recursive: true })
  return {
    dir,
    doorFile: path.join(dir, 'door-session.txt'),
    blockLog: path.join(dir, 'qq-send-blocked.log'),
  }
}
const execAs = (id) => ({ agent: { session: { id } } })

// ── A0. 插件入口（假 ctx + 假 exec，确认 exec 真的传到门房校验）──────────────
console.log('A0. 插件入口（假 ctx，apply 后调 qq_send）')

await stepAsync('0) apply 注册 qq_send：旧会话拒，当前门房放行到真发', async () => {
  const dataRoot = path.join(tmp, 'plugin-data')
  const wsRoot = path.join(tmp, 'plugin-ws')
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.mkdirSync(wsRoot, { recursive: true })
  // 文件里写的是旧门房；配置 wakeSessionId 是新门房 → 严格串行只认 wake
  fs.writeFileSync(path.join(dataRoot, 'door-session.txt'), 'session-file-door')

  const tools = new Map()
  const ctx = {
    tools: { register: (def) => tools.set(def.name, def) },
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    reflect: { get: () => undefined },
  }
  apply(ctx, {
    enablePersona: false,
    enableWilla: true,
    willaDataDir: dataRoot,
    willaWorkspace: wsRoot,
    // 端口 1 一定连不上：只验到「门房放行、真去发」这一步，不真发 QQ
    qqHttpUrl: 'http://127.0.0.1:1',
    qqToken: 'selftest-token',
    qqSelfId: '10001',
    wakeSessionId: 'session-wake-door',
  })
  const send = tools.get('qq_send')
  assert.ok(send, 'apply 后应有 qq_send')

  await assert.rejects(
    () =>
      send.execute(
        { target: 'private:10001', text: '不该发出去' },
        { agent: { session: { id: 'session-file-door' } } },
      ),
    /这个会话不是门房/,
    '文件里的旧门房不能靠文件绕过去',
  )

  const err = await send
    .execute(
      { target: 'private:10001', text: '会走到真发' },
      { agent: { session: { id: 'session-wake-door' } } },
    )
    .then(
      () => null,
      (error) => error,
    )
  assert.ok(err, '端口 1 连不上，应该抛错')
  assert.doesNotMatch(err.message, /这个会话不是门房/, '当前门房要放行到真发这一步')

  const blocked = fs.readFileSync(path.join(dataRoot, 'qq-send-blocked.log'), 'utf8')
  assert.match(blocked, /self=session-file-door/)
  assert.match(blocked, /source=wake\.sessionId/)
  return 'exec → qq_send → 门房校验 → 真发（网络失败），链路通'
})

// ── A. 门房校验 ───────────────────────────────────────────────────────────
console.log(`A. 门房校验（临时目录 ${tmp}）`)

step('1) 门房自己放行', () => {
  const p = tmpCase('self')
  fs.writeFileSync(p.doorFile, 'session-door-a')
  const guard = createDoorGuard(p)
  const { error, lines } = captureStderr(() =>
    guard(execAs('session-door-a'), 'session-door-a', 'private:10001'),
  )
  assert.equal(error, undefined, '门房自己不该被拒')
  assert.equal(lines.length, 0, '放行时不该往 stderr 写东西')
  assert.equal(fs.existsSync(p.blockLog), false, '放行时不该写拒绝日志')
  return 'self=door=session-door-a'
})

step('2) 旧会话拒（wake 已是新门房，文件还留着旧 id）', () => {
  const p = tmpCase('old')
  fs.writeFileSync(p.doorFile, 'session-door-old')
  const guard = createDoorGuard(p)
  const { error } = captureStderr(() =>
    guard(execAs('session-door-old'), 'session-door-new', 'group:20002'),
  )
  assert.ok(error, '旧会话必须被拒')
  assert.match(error.message, /这个会话不是门房/)
  assert.match(error.message, /session-door-new/)
  assert.match(error.message, /wake\.sessionId/)
  const line = fs.readFileSync(p.blockLog, 'utf8').trim()
  assert.match(line, /self=session-door-old/)
  assert.match(line, /target=group:20002/)
  assert.match(line, /door=session-door-new/)
  assert.match(line, /source=wake\.sessionId/)
  return '按 wake.sessionId 拒，拒绝日志 1 行'
})

step('3) wake 指向别人拒（文件写着自己也不算：不取并集）', () => {
  const p = tmpCase('wake-other')
  fs.writeFileSync(p.doorFile, 'session-me')
  const guard = createDoorGuard(p)
  const { error } = captureStderr(() =>
    guard(execAs('session-me'), 'session-other', 'private:10003'),
  )
  assert.ok(error, 'wake 指向别人时必须拒')
  assert.match(error.message, /session-other/)
  assert.match(error.message, /wake\.sessionId/)
  return '文件=self 也拒，证明严格串行'
})

step('4) wake 为空回退 door-session.txt', () => {
  const p = tmpCase('fallback')
  fs.writeFileSync(p.doorFile, 'session-me')
  const guard = createDoorGuard(p)
  for (const wake of ['', undefined, '   ']) {
    const { error, lines } = captureStderr(() => guard(execAs('session-me'), wake, 'private:10004'))
    assert.equal(error, undefined, `wake=${JSON.stringify(wake)} 时该回退文件放行`)
    assert.equal(lines.length, 0, '回退成功时不该写 stderr')
  }
  assert.equal(fs.existsSync(p.blockLog), false)
  return '三种空 wake 都回退到文件'
})

step('5) 拿不到 self 放行（fail-open）', () => {
  const p = tmpCase('no-self')
  fs.writeFileSync(p.doorFile, 'session-other')
  const guard = createDoorGuard(p)
  const cases = [undefined, {}, { agent: {} }, { agent: { session: {} } }]
  for (const exec of cases) {
    const { error, lines } = captureStderr(() => guard(exec, 'session-other', 'private:10005'))
    assert.equal(error, undefined, '拿不到 self 必须放行')
    assert.match(lines.join('\n'), /拿不到自己的 sessionId，放行/)
  }
  assert.equal(fs.existsSync(p.blockLog), false)
  return '4 种残缺 exec 都放行并打 stderr'
})

step('6) 两个口径都读不到也放行（fail-open）', () => {
  const p = tmpCase('no-door')
  // door 文件不存在 + wake 空
  const guard = createDoorGuard(p)
  const { error, lines } = captureStderr(() => guard(execAs('session-me'), '', 'private:10006'))
  assert.equal(error, undefined)
  assert.match(lines.join('\n'), /两个门房口径都读不到，放行/)
  return '文件缺失 + wake 空 → 放行'
})

step('7) 拒绝日志写不进去也照拒', () => {
  const p = tmpCase('log-fail')
  fs.writeFileSync(p.doorFile, 'session-other')
  const guard = createDoorGuard({
    doorFile: p.doorFile,
    blockLog: path.join(p.dir, '没有这个目录', 'qq-send-blocked.log'),
  })
  const { error, lines } = captureStderr(() =>
    guard(execAs('session-me'), 'session-other', 'private:10007'),
  )
  assert.ok(error, '日志写不进也必须拒')
  assert.match(error.message, /不是门房/)
  assert.match(lines.join('\n'), /拒绝日志写不进/)
  return '记账失败不影响拒绝'
})

// ── B. worker 回执 ────────────────────────────────────────────────────────
console.log('\nB. worker 回执（假 dsh bin，不碰真会话）')

const dataRoot = path.join(tmp, 'worker-data')
const fakeBin = path.join(tmp, 'fake-dsh.mjs')
fs.writeFileSync(
  fakeBin,
  [
    "import { writeSync } from 'node:fs'",
    "writeSync(1, '\\u001b[32mhello from fake worker\\u001b[0m\\n')",
    "writeSync(1, 'line two\\n')",
    "writeSync(1, 'line three\\n')",
    "process.exit(Number(process.env.FAKE_WORKER_EXIT || 0))",
    '',
  ].join('\n'),
  'utf8',
)

const injected = []
const fakeSession = {
  door: { id: 'session-door-test' },
  async inject(text, id) {
    injected.push({ text, id })
  },
}
const tools = new Map()
const scope = { tools: { register: (def) => tools.set(def.name, def) } }
const c = {
  willaDataDir: dataRoot,
  workerDshBin: fakeBin,
  workerNodeBin: process.execPath,
  workerProfile: 'headless',
  workerPatchFile: '',
  workerEnvFile: '',
}
const worker = createWorker(c, fakeSession)

async function waitFor(label, ready, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等超时：${label}`)
}

let workerReady = await stepAsync('0) 假 bin 就绪，注册 3 个 worker 工具', async () => {
  assert.equal(worker.enabled, true, '假 bin + 当前 node 应该 enabled')
  assert.equal(worker.register(scope), 3)
  assert.deepEqual([...tools.keys()].sort(), ['worker_list', 'worker_run', 'worker_status'])
  return `workers 目录 ${worker.dir}`
})

if (workerReady) {
  process.env.FAKE_WORKER_EXIT = '0'
  let firstId = ''
  let donePath = ''

  workerReady = await stepAsync('1) 派最小 worker，exit 后写 .done.json', async () => {
    const m = await tools.get('worker_run').execute({ task: '自验：写回执的最小 worker', cwd: tmp })
    firstId = m.workerId
    assert.ok(firstId, 'worker_run 要返回 id')
    await waitFor('第一次注入', () => injected.length >= 1)
    donePath = path.join(worker.dir, `${firstId}.done.json`)
    assert.ok(fs.existsSync(donePath), `done 文件要存在：${donePath}`)
    return `id=${firstId}`
  })

  if (workerReady) {
    step('2) done.json 字段齐、tail 去 ANSI', () => {
      const done = JSON.parse(fs.readFileSync(donePath, 'utf8'))
      for (const key of ['id', 'exitCode', 'signal', 'finishedAt', 'logPath', 'tail', 'task']) {
        assert.ok(Object.prototype.hasOwnProperty.call(done, key), `缺字段 ${key}`)
      }
      assert.equal(done.id, firstId)
      assert.equal(done.exitCode, 0)
      assert.equal(done.signal, null)
      assert.ok(!Number.isNaN(Date.parse(done.finishedAt)), 'finishedAt 要是能解析的时间')
      assert.equal(done.logPath, path.join(worker.dir, `${firstId}.log`))
      assert.ok(fs.existsSync(done.logPath), '日志文件要在')
      assert.ok(done.tail.includes('hello from fake worker'), 'tail 要有日志内容')
      assert.ok(!done.tail.includes('\u001b'), 'tail 不能带 ANSI 控制码')
      assert.equal(done.task, '自验：写回执的最小 worker')
      return `exitCode=0 signal=null tail=${done.tail.split('\n').length} 行`
    })

    step('3) 注入文案一次：[worker 回来了] + 退出码 + 日志 + worker_status', () => {
      assert.equal(injected.length, 1, '只该注入一次')
      const text = injected[0].text
      assert.match(text, /^\[worker 回来了\] /)
      assert.match(text, /退出码 0/)
      assert.match(text, /日志 .+\.log/)
      assert.match(text, /用 worker_status 抄结果/)
      return text.split('\n')[0]
    })

    await stepAsync('4) 重复 finish 不重复写、不重复注入', async () => {
      assert.equal(worker.finish(firstId, 0, null), null, 'FINISHED 闸要挡住')
      assert.equal(worker.finish(firstId, 0, null), null)
      // 宿主重启后的重放：内存 Set 里没有，但 done 文件已经在 → 直接 return null
      const replayId = `${firstId}-replay`
      fs.writeFileSync(path.join(worker.dir, `${replayId}.done.json`), '{"id":"replay"}')
      assert.equal(worker.finish(replayId, 0, null), null, 'done 文件闸要挡住')
      await new Promise((resolve) => setTimeout(resolve, 400))
      assert.equal(injected.length, 1, '重复 finish 后仍然只注入一次')
      return 'FINISHED + done 文件两道闸都挡住'
    })

    process.env.FAKE_WORKER_EXIT = '3'
    await stepAsync('5) 非 0 退出：[worker 出错了] 带 tail 最后 3 行', async () => {
      const m = await tools.get('worker_run').execute({ task: '自验：失败 worker', cwd: tmp })
      await waitFor('第二次注入', () => injected.length >= 2)
      const text = injected[1].text
      assert.match(text, /^\[worker 出错了\] /)
      assert.match(text, /退出码 3/)
      const tailLines = text.split('\n').slice(1)
      assert.equal(tailLines.length, 3, '出错时带 tail 最后 3 行')
      assert.ok(tailLines[0].includes('hello from fake worker'))
      assert.ok(tailLines[1].includes('line two'))
      assert.ok(tailLines[2].includes('line three'))
      const done = JSON.parse(
        fs.readFileSync(path.join(worker.dir, `${m.workerId}.done.json`), 'utf8'),
      )
      assert.equal(done.exitCode, 3)
      return `${m.workerId} → 退出码 3`
    })

    step('6) worker_list 不把 .done.json 当 worker', () => {
      const rows = worker.list()
      assert.equal(rows.length, 2, `应只列 2 个 worker，实际 ${rows.length}`)
      assert.ok(rows.every((row) => !String(row.id).includes('.done')))
      return rows.map((row) => row.id).join(', ')
    })
  }
  delete process.env.FAKE_WORKER_EXIT
}

step('7) stripAnsi 基础行为', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m plain'), 'red plain')
  return '控制码去干净'
})

// ── 收尾 ──────────────────────────────────────────────────────────────────
console.log('')
if (failures.length) {
  console.error(`selftest FAILED：${failures.length} 项没过`)
  for (const label of failures) console.error(`  - ${label}`)
  process.exitCode = 1
} else {
  console.log('selftest 全绿（插件入口 1 项 + 门房 7 例 + worker 回执 7 项）')
  // 只在全绿时清临时目录，失败留现场好查。
  if (tmp.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
