/**
 * dsh-willa 配置。
 *
 * 当前阶段**不依赖** `@deepseek-ai/schemastery`：本地 `link:` 装包时这个内部包经常
 * 解析不到，硬 import 会让整个插件加载失败。所以这里先用普通对象写默认值 + 浅合并，
 * 同时导出一个 standard-schema 形状的 `Config`（宿主/插件页只要求这个形状，不需要
 * schemastery 本身）。等真正打包发布时再切回：
 *
 *   import z from '@deepseek-ai/schemastery'        // peer ^3.18.4，optional
 *   export const Config = z.object({
 *     enablePersona: z.boolean().default(true),
 *     enableWilla: z.boolean().default(false),
 *     personaStore: z.string().default(''),
 *     ...
 *     qqToken: z.string().role('secret').default(''),
 *   })
 *
 * schema 字段与 `partner/plugin-merge-plan.md` 的 C.3 一一对应，全部拍平，不做嵌套。
 */

/**
 * C.3 的默认值表（顺序也保持一致，方便对照方案）。
 * 另外补上 D.1 逐条表里 C.3 漏掉的键：affinityMigrateFile / sessionKickoff /
 * wakeSessionsRoot / wakeWorkspaceTag / qzoneHttpUrl / qzoneToken。
 */
export const DEFAULTS = {
  enablePersona: true,
  enableWilla: false,
  personaStore: '',
  personaDefaultId: 'dafeiyu',
  willaDataDir: '',
  willaWorkspace: '',
  willaCompanionHome: '',
  affinityMigrateFile: '',
  qqHttpUrl: '',
  qqWsUrl: '',
  qqToken: '',
  qqSelfId: '',
  qqWatch: [],
  memoryOldVectors: '',
  memoryV2Vectors: '',
  memoryEmbedUrl: 'http://127.0.0.1:8767/v1/embeddings',
  memoryEmbedModel: 'BAAI/bge-small-zh-v1.5',
  workerDshBin: '',
  workerNodeBin: '',
  workerProfile: 'headless',
  workerEnvFile: '',
  workerPatchFile: '',
  qzoneEnabled: false,
  qzoneOnebotConfig: '',
  qzoneHttpUrl: '',
  qzoneToken: '',
  qzoneEveryMinutes: 10,
  wakeEnabled: false,
  wakeSessionId: '',
  // 本机 OneBot 没设 token 时，必须显式写 true 才允许 wake 启动（D.2 的「明确允许」）。
  wakeAllowEmptyToken: false,
  wakeSessionsRoot: '',
  wakeWorkspaceTag: '',
  sessionKickoff: '',
  wanderEnabled: false,
  wanderMinMinutes: 45,
  wanderMaxMinutes: 120,
  wanderQuietFrom: 0,
  wanderQuietTo: 9,
  wanderPrompt: '',
  aliveEnabled: true,
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 补默认值 + 旧键迁移。不抛错：坏值原样留着，由调用方按需判断。
 *
 * 旧配置迁移（见方案 C.3 末尾）：
 * - 顶层 `enabled:false` 同时关掉两半（旧 persona 的总开关）；
 * - 旧的嵌套开关 `wake.enabled` / `wander.enabled` / `qzone.enabled` / `alive.enabled`
 *   映射到拍平后的同名 `*Enabled` 键，旧键本身不写进 schema。
 */
export function resolveConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const out = { ...DEFAULTS, ...input }

  // 旧 persona / willa 的 `enabled` 只做迁移映射，不再作为配置键。
  if (input.enabled === false) {
    out.enablePersona = false
    out.enableWilla = false
  }

  for (const [legacyKey, enabledKey] of [
    ['wake', 'wakeEnabled'],
    ['wander', 'wanderEnabled'],
    ['qzone', 'qzoneEnabled'],
    ['alive', 'aliveEnabled'],
  ]) {
    const nested = input[legacyKey]
    if (isPlainObject(nested) && typeof nested.enabled === 'boolean' && input[enabledKey] === undefined) {
      out[enabledKey] = nested.enabled
    }
  }

  // 数组只接受字符串数组，清掉 undefined / 非字符串项。
  out.qqWatch = Array.isArray(out.qqWatch) ? out.qqWatch.filter((item) => typeof item === 'string') : []

  return out
}

/** 字段类型表：只校验 C.3 里的键；未知键（旧 prefix/suffix 等）原样透传。 */
const FIELD_TYPES = Object.fromEntries(
  Object.entries(DEFAULTS).map(([key, value]) => [key, Array.isArray(value) ? 'array' : typeof value]),
)

function validate(value) {
  const resolved = resolveConfig(value)
  if (value !== undefined && value !== null && !isPlainObject(value)) {
    return { issues: [{ message: 'config must be an object', path: [] }] }
  }

  const issues = []
  for (const [key, expected] of Object.entries(FIELD_TYPES)) {
    const actual = resolved[key]
    if (expected === 'array') {
      if (!Array.isArray(actual) || actual.some((item) => typeof item !== 'string')) {
        issues.push({ message: `${key} must be an array of strings`, path: [key] })
      }
      continue
    }
    if (typeof actual !== expected) {
      issues.push({ message: `${key} must be a ${expected}`, path: [key] })
      continue
    }
    if (expected === 'number' && !Number.isFinite(actual)) {
      issues.push({ message: `${key} must be a finite number`, path: [key] })
    }
  }

  return issues.length > 0 ? { issues } : { value: resolved }
}

/**
 * standard-schema 形状的配置描述。
 * 宿主只依赖 `~standard.validate`，不关心它是不是 schemastery 生成的。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-willa',
    validate,
  },
}
