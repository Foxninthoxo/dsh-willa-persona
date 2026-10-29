/**
 * 构建：把源码复制到 `lib/`，保证 `package.json` 的 `main: lib/index.js` 与
 * `exports["./client"] -> lib/client.js` 在本地 `link:` / `file:` 安装时真的能跑。
 *
 * 2026-10-28 更新：**客户端 bundle 也一起产出了**。
 * 原因：`src/persona/client.js` 本身就是从 dsh-persona-dafeiyu 0.5.0 的
 * `lib/client.js`（已经打过包的 `window.__ModuleLoader__.load({...})` 形态）迁过来的，
 * 只把 loader id 换成了 `dsh-willa`、API 前缀换成 `/api/dsh-willa/`。
 * 也就是说它已经是成品，不需要再用 esbuild 重打一遍 —— 直接复制成 `lib/client.js` 即可。
 *
 * 什么时候真需要 esbuild：等 `src/persona/client.js` 改成手写 JSX 源、或者要
 * 真正 re-bundle（比如引第三方库）的时候。那时把下面的 CLIENT_FILES 那段换成
 * esbuild 调用（format=cjs，external react / react/jsx-runtime，外面套
 * `window.__ModuleLoader__.load({ id:'dsh-willa', factory:(require)=>{...} })`）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/** 服务端要复制的 src 文件；新增模块记得加到这里。 */
const SERVER_FILES = [
  'src/index.js',
  'src/config.js',
  'src/paths.js',
  'src/persona/index.js',
  'src/willa/tools.js',
  'src/willa/util.js',
  'src/willa/session.js',
  'src/willa/qq.js',
  'src/willa/memory.js',
  'src/willa/affinity.js',
  'src/willa/person.js',
  'src/willa/life.js',
  'src/willa/alive.js',
  'src/willa/alive-timer.js',
  'src/willa/wake.js',
  'src/willa/wander.js',
  'src/willa/qzone.js',
  'src/willa/worker.js',
]

/** 客户端：已经带 loader 包壳的成品，直接复制。 */
const CLIENT_FILES = [
  'src/persona/client.js',
]

for (const relative of SERVER_FILES) {
  const from = path.join(root, relative)
  const to = path.join(root, 'lib', relative.slice('src/'.length))
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
  console.log(`copied ${relative} -> ${path.relative(root, to)}`)
}

for (const relative of CLIENT_FILES) {
  const from = path.join(root, relative)
  const to = path.join(root, 'lib', 'client.js')
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
  console.log(`copied ${relative} -> ${path.relative(root, to)}`)
}

// 自检：客户端包壳里的 loader id 必须是包名，否则 DSH 加载后注册不上、设置页空白。
const clientOut = await fs.readFile(path.join(root, 'lib', 'client.js'), 'utf8')
if (!clientOut.includes('id: "dsh-willa"')) {
  console.error('build FAILED: lib/client.js 里的 __ModuleLoader__ id 不是 dsh-willa')
  process.exit(1)
}

console.log('build ok: lib/index.js (server) + lib/client.js (client bundle)')
