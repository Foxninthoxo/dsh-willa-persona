#!/usr/bin/env node
/**
 * 人设库一次性迁移：`storages/dsh-persona-dafeiyu/personas.json` → `storages/dsh-willa/personas.json`
 *
 * 为什么要这个脚本：合并后新包读的是自己的路径（`<DSH_HOME>/storages/dsh-willa/personas.json`），
 * 不自动搬旧库是刻意的（免得两个包同时写同一份）。第一次切换时跑一下就好。
 *
 * 用法：
 *   node scripts/migrate-persona-store.mjs            # 只打印计划（默认 dry-run）
 *   node scripts/migrate-persona-store.mjs --apply    # 真写；目标已存在就拒绝
 *   node scripts/migrate-persona-store.mjs --apply --force   # 覆盖（会先把目标备份成 .bak-<时间>）
 *
 * 规则：
 *   - 目标已存在 + 没有 --force → 不动，退出码 2（「已经迁过了，别双写」）。
 *   - 迁移只复制，**不删除旧文件**（回滚只要把 pack 换回旧包）。
 *   - 复制完做一次 JSON.parse 校验；坏了就把刚写的删掉、退出码 1。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const force = args.has('--force')

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const oldPath = path.join(home, 'storages', 'dsh-persona-dafeiyu', 'personas.json')
const newPath = path.join(home, 'storages', 'dsh-willa', 'personas.json')

function say(line) {
  console.log(line)
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  say(`DSH_HOME   = ${home}`)
  say(`旧库       = ${oldPath}  ${(await exists(oldPath)) ? '（存在）' : '（不存在）'}`)
  say(`新库       = ${newPath}  ${(await exists(newPath)) ? '（已存在）' : '（空）'}`)

  if (!(await exists(oldPath))) {
    say('没有旧库可迁，收工（新包会用它自己的默认人设库）。')
    return 0
  }

  const newExists = await exists(newPath)
  if (newExists && !force) {
    say('新库已经在了，不动它（要覆盖就加 --force，会先备份）。')
    return 2
  }

  const raw = await fs.readFile(oldPath, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    say(`旧库不是合法 JSON，停手：${err.message}`)
    return 1
  }
  const count = Array.isArray(parsed?.personas)
    ? parsed.personas.length
    : Array.isArray(parsed)
      ? parsed.length
      : Object.keys(parsed ?? {}).length
  say(`旧库里大约 ${count} 份人设（按结构估算）`)

  if (!apply) {
    say('')
    say('这是 dry-run。真要迁：加 --apply')
    return 0
  }

  await fs.mkdir(path.dirname(newPath), { recursive: true })
  if (newExists && force) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${newPath}.bak-${stamp}`
    await fs.copyFile(newPath, backup)
    say(`已备份原新库 → ${backup}`)
  }

  await fs.writeFile(newPath, raw, 'utf8')
  try {
    JSON.parse(await fs.readFile(newPath, 'utf8'))
  } catch (err) {
    await fs.rm(newPath, { force: true })
    say(`写进去的校验失败，已删除，原样保留旧库：${err.message}`)
    return 1
  }

  say(`迁好了：${newPath}`)
  say('旧库没删（回滚用）；旧包还在的话，别让两边同时写这一份。')
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`迁移失败：${err?.stack ?? err}`)
    process.exit(1)
  })
