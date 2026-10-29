#!/usr/bin/env node
/**
 * preflight.mjs —— 发布/切换前的一条命令自检。
 *
 * 依次跑：构建 → 冒烟 → 隐私扫描 → 打包清单核对。
 * 任何一步失败就停下并退出非 0，不需要人肉记顺序。
 *
 *   node scripts/preflight.mjs
 *   node scripts/preflight.mjs --skip-pack    # 不想生成 tarball 时
 *
 * 为什么要有它：合并这件事有四个「一忘就出事」的检查点（客户端 bundle 的 loader id、
 * 工具数与降级后的工具数、包名/QQ 号/token 泄露、files 白名单之外的东西混进包），
 * 分散在三个脚本里，靠人记早晚会漏。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const skipPack = process.argv.includes('--skip-pack')

function run(label, args, options = {}) {
  process.stdout.write(`\n=== ${label} ===\n`)
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    console.error(`\n✗ ${label} 失败（exit ${result.status}）`)
    process.exit(result.status ?? 1)
  }
  console.log(`✓ ${label}`)
}

run('构建', [path.join(here, 'build.mjs')])
run('冒烟', [path.join(here, 'smoke.mjs')])
run('隐私扫描', [path.join(here, 'privacy-check.mjs')])
run('客户端包壳与插件页元数据', [path.join(here, 'client-shape.mjs')])

if (!skipPack) {
  process.stdout.write('\n=== 打包清单 ===\n')
  // 直接调 npm 的 CLI 脚本：比 spawn('npm') 稳（Windows 上 npm 是 .cmd，
  // 不带 shell 起不来；带 shell 又会有 DEP0190 的参数拼接警告）。
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const pack = existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })
    : spawnSync('npm pack --dry-run --json', { cwd: root, encoding: 'utf8', shell: true })
  if (pack.status !== 0) {
    console.error('✗ npm pack --dry-run 失败')
    console.error(pack.stderr ?? '')
    process.exit(pack.status ?? 1)
  }
  let info
  try {
    info = JSON.parse(pack.stdout)
  } catch {
    console.error('✗ 解析 npm pack --json 输出失败：')
    console.error(pack.stdout?.slice(0, 500))
    process.exit(1)
  }
  const files = (info[0]?.files ?? []).map((f) => f.path)
  const bad = files.filter((f) => /^(src|private|docs|scripts)\//.test(f) || f.endsWith('.tgz'))
  console.log(`文件数 ${files.length}，体积 ${info[0]?.size ?? '?'} B`)
  for (const f of files) console.log(`  ${f}`)
  if (bad.length > 0) {
    console.error(`\n✗ 包里混进了不该发的东西：${bad.join(', ')}`)
    process.exit(1)
  }
  const must = ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg']
  const missing = must.filter((m) => !files.includes(m))
  if (missing.length > 0) {
    console.error(`\n✗ 包里缺必需文件：${missing.join(', ')}`)
    process.exit(1)
  }
  console.log('✓ 打包清单')
}

console.log('\npreflight 全绿')
