/**
 * 路径统一出口。
 *
 * 方案 D.1 里最隐蔽的一颗雷：原 willa 用 `resolve(HERE, '..', '..')` 反推工作区，
 * 装进 `node_modules` 之后会落到 node_modules 里。这里所有路径都从 DSH_HOME /
 * 配置派生，不再从源码位置反推。
 *
 * 人设半侧用 `personaStorePathFor()`；willa 那半的 dataDir / workspace / sessions
 * 全部从这里派生（26 个工具与后续定时器都不再自己反推源码位置）。
 */
import os from 'node:os'
import path from 'node:path'

/** DSH 的家目录；与宿主一致，优先读环境变量。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** 展开 `~`，再把相对路径按 base 解析；空值返回空串。 */
export function expandPath(value, base = process.cwd()) {
  if (typeof value !== 'string' || value.trim().length === 0) return ''
  const text = value.trim()
  if (text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2))
  return path.resolve(base, text)
}

/** 插件的默认数据目录：`<DSH_HOME>/storages/dsh-willa`。 */
export function defaultDataDir() {
  return path.join(dshHome(), 'storages', 'dsh-willa')
}

/** willa 半侧的数据目录；`willaDataDir` 为空时用默认值。 */
export function dataDir(config = {}) {
  return expandPath(config.willaDataDir) || defaultDataDir()
}

/** 工作区目录；`willaWorkspace` 为空时退到 `<DSH_HOME>/workspace`（只作兜底）。 */
export function workspaceDir(config = {}) {
  return expandPath(config.willaWorkspace) || path.join(dshHome(), 'workspace')
}

/** 旧部署目录；空 = 不读旧配置、不做老数据迁移。 */
export function companionHome(config = {}) {
  return expandPath(config.willaCompanionHome)
}

/** 会话文件根目录；`wakeSessionsRoot` 为空时用 `<DSH_HOME>/sessions`。 */
export function sessionsRoot(config = {}) {
  return expandPath(config.wakeSessionsRoot) || path.join(dshHome(), 'sessions')
}

/** 人设库文件；`personaStore` 为空时用 `<dataDir>/personas.json`。 */
export function personaStorePathFor(config = {}) {
  return expandPath(config.personaStore) || path.join(dataDir(config), 'personas.json')
}
