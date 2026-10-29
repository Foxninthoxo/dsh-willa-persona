#!/usr/bin/env node
/**
 * client-shape.mjs —— 检查客户端 bundle 的「壳」和插件页元数据。
 *
 * 为什么单独测这个：DSH 的约定是
 *   1. `lib/client.js` 必须是 `window.__ModuleLoader__.load({ id, factory })` 这种包壳；
 *   2. **id 必须等于包名**，否则 bundle 加载后注册不上、设置页空白（不报错，最难查）；
 *   3. `locale/*.json` 要有 `meta.title` / `meta.description`，`icon.svg` 要在 256 KiB 以内；
 *   4. bundle 里不能出现旧包名或旧 `/api/` 前缀。
 *
 * 这些都不是「跑起来才知道」的东西，能在提交前一条命令卡住，就别等浏览器白屏。
 *
 *   node scripts/client-shape.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const clientPath = path.join(root, 'lib', 'client.js')
const client = await fs.readFile(clientPath, 'utf8')

assert.ok(
  client.trimStart().startsWith('window.__ModuleLoader__.load({'),
  'lib/client.js 必须以 window.__ModuleLoader__.load({ 开头',
)
assert.ok(client.includes(`id: "${pkg.name}"`), `bundle 的 loader id 必须等于包名 ${pkg.name}`)
assert.ok(client.includes('factory:'), 'bundle 必须有 factory')
assert.ok(client.includes('return module.exports'), 'bundle 结尾要把 module.exports 交回去')
assert.ok(!client.includes('dsh-persona-dafeiyu'), 'bundle 里不许残留旧包名')
assert.ok(!client.includes('/api/dsh-persona'), 'bundle 里不许残留旧 API 前缀')
assert.ok(client.includes('/api/dsh-willa/'), 'bundle 里的 API 前缀应该是 /api/dsh-willa/')

for (const lang of ['zh', 'en']) {
  const raw = await fs.readFile(path.join(root, 'locale', `${lang}.json`), 'utf8')
  const meta = JSON.parse(raw)?.meta
  assert.ok(meta?.title, `locale/${lang}.json 缺 meta.title`)
  assert.ok(meta?.description, `locale/${lang}.json 缺 meta.description`)
}

// bundle 只许 require 宿主会提供的两个 react 入口；多出来的会在浏览器里 500。
const required = [...client.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
const allowedRequires = new Set(['react', 'react/jsx-runtime'])
const unknownRequires = [...new Set(required)].filter((name) => !allowedRequires.has(name))
assert.deepEqual(unknownRequires, [], `bundle 里有宿主不提供的 require：${unknownRequires.join(', ')}`)

// factory 之外不许碰 window/document（碰了会在模块加载阶段就抛，整页白屏）。
const head = client.slice(0, client.indexOf('factory:'))
assert.ok(!/\bdocument\./.test(head), 'factory 之前不许碰 document')
const iconPath = path.join(root, 'icon.svg')
const icon = await fs.readFile(iconPath, 'utf8')
const iconBytes = (await fs.stat(iconPath)).size
assert.ok(icon.includes('<svg'), 'icon.svg 不是 SVG')
assert.ok(iconBytes <= 256 * 1024, `icon.svg 超过 256 KiB（${iconBytes} B）`)

const exportsMap = pkg.exports ?? {}
assert.equal(exportsMap['./client'], './lib/client.js', 'exports["./client"] 要指向 lib/client.js')
assert.equal(exportsMap['./icon'], './icon.svg', 'exports["./icon"] 要指向 icon.svg')
assert.ok(exportsMap['./locale/*.json'], 'exports 要能解析 locale/*.json')
assert.equal(pkg.dsh?.bundle?.patch, 'cordis.patch.yml', 'dsh.bundle.patch 要指 cordis.patch.yml')
assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform 应该是 web')

console.log(
  `client-shape ok: ${pkg.name} — bundle ${(await fs.stat(clientPath)).size} B / icon ${iconBytes} B / locale zh+en`,
)
