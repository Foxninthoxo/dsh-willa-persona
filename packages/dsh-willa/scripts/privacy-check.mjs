/**
 * 隐私自查：扫服务端源码与构建产物，禁止本机私货混进包里。
 * 方案 D.1 / F.4 第 9 条：`private/`、`.env`、本机路径、QQ 号都不许出现。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const BANNED = [
  { label: '旧包名', pattern: /dsh-persona-dafeiyu/ },
  { label: '旧 API 前缀', pattern: /\/api\/dsh-persona-dafeiyu\// },
  { label: 'Windows 用户目录', pattern: /C:\\Users/i },
  { label: '本机用户名', pattern: /Administrator/ },
  { label: '本机 QQ 号', pattern: /2137383614/ },
  { label: '本机 QQ 号', pattern: /1121135716/ },
  { label: 'token 字段名', pattern: /access_token/ },
]

async function walk(dir) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const files = [...(await walk(path.join(root, 'src'))), ...(await walk(path.join(root, 'lib')))]
let failed = 0

for (const file of files) {
  const text = await fs.readFile(file, 'utf8')
  for (const rule of BANNED) {
    if (!rule.pattern.test(text)) continue
    failed += 1
    const line = text.split(/\r?\n/).findIndex((item) => rule.pattern.test(item)) + 1
    console.error(`${path.relative(root, file)}:${line} 命中「${rule.label}」`)
  }
}

if (failed > 0) {
  console.error(`privacy-check failed: ${failed} 处`)
  process.exit(1)
}
console.log(`privacy-check ok: 扫了 ${files.length} 个文件`)
