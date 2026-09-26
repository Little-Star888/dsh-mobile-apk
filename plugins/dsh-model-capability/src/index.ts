/**
 * dsh-model-capability — host-side capability discovery for user-declared provider
 * routes (issues #122 / #125: a custom provider has no selectable reasoning effort).
 *
 * Sources, in strict order — a capability that no source states stays absent:
 *   1. `endpoint-descriptor` — a passive GET of metadata the endpoint itself returns;
 *   2. `vendor-descriptor`  — explicit capability schemas (OpenRouter / Google / Ollama);
 *   3. `engine-catalog`     — exact model-id lookup in the pi-ai vendor catalogs the
 *      engine ships (a vendor *declaration*, never a name heuristic);
 *   4. `active-probe`       — only with explicit approval, and only after a negative
 *      control proves the endpoint actually validates the effort field.
 *
 * Write-back is opt-in per call (or by the startup pass) and field-level: it only
 * fills missing model-level fields and never overwrites a value the user declared.
 */
import { readFileSync, appendFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DIALECT_COMPAT_KEYS,
  THINKING_LEVELS,
  probePassive,
  probeReasoningEfforts,
  type FetchLike,
  type ModelCapabilities,
  type ProbeReport,
  type ReasoningEfforts,
} from './capability-probe.js'
import { hasCapabilities, lookupCatalog, type CatalogSnapshot } from './catalog-lookup.js'
import { providerFromSettings, type SettingsLike } from './settings-config.js'
import { applyModelPatch, createStampStore, type ModelPatch, type SettingsWriteLike } from './settings-writer.js'
import { capabilitySignature } from './signature.js'

export const name = 'dsh-model-capability'

/** `settings` is the write-back seam; `tools` registers the discovery tools. */
export const inject = ['tools', 'settings'] as const

export {
  THINKING_LEVELS,
  probePassive,
  probeReasoningEfforts,
  parseDescriptor,
  parseOllamaShow,
  effortsFrom,
} from './capability-probe.js'
export type {
  ActiveProbeResult,
  ModelCapabilities,
  ProbeReport,
  ProviderConfig,
  ReasoningEfforts,
  ThinkingLevel,
} from './capability-probe.js'
export { providerFromSettings } from './settings-config.js'
export type { SettingsLike } from './settings-config.js'
export { lookupCatalog, effortsOf, hasCapabilities } from './catalog-lookup.js'
export type { CatalogEntry, CatalogMatch, CatalogSnapshot } from './catalog-lookup.js'
export { planModelPatch, applyModelPatch } from './settings-writer.js'
export type { ModelPatch, PlanResult, WriteResult } from './settings-writer.js'

export interface PluginConfig {
  /** Fill missing model capabilities automatically on startup (default true). */
  autoApply?: boolean
  /** Seconds to wait after startup before the automatic pass (default 8). */
  startupDelaySeconds?: number
  /**
   * Fallback safety-net poll interval in seconds (default 120), used only when the
   * event-driven trigger below is unavailable. The trigger path is
   * `settings/document-updated`, so this is a backstop rather than the primary
   * mechanism — see the auto-apply comment in `apply()` for the measured reason it
   * cannot be 5s.
   */
  pollIntervalSeconds?: number
  /** Restrict the automatic pass to these routes (default: every declared route). */
  routes?: string[]
}

interface CredentialsLike {
  resolve(ref: unknown): Promise<{ value?: string } | undefined>
}

interface CtxLike {
  settings?: SettingsLike & SettingsWriteLike
  logger?: (name: string) => { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void }
  effect?: (fn: () => () => void) => void
  /** cordis 服务查询：未提供的服务返回 undefined（不要直接读 ctx.<service>——未 inject 会抛）。 */
  get?: (name: string) => unknown
  tools: { register(tool: unknown): void }
}

/** 可选服务读取：未声明 inject 时直接读属性会抛（cordis 4 实测），统一走 ctx.get。 */
function optionalService<T>(ctx: unknown, name: string): T | undefined {
  try {
    const getter = (ctx as { get?: (n: string) => unknown }).get
    if (typeof getter !== 'function') return undefined
    return getter.call(ctx, name) as T | undefined
  } catch {
    return undefined
  }
}

let cachedSnapshot: CatalogSnapshot | undefined
let snapshotTried = false

/**
 * 诊断轨迹（DSH_MODEL_CAPABILITY_TRACE=0 可关）：追加到 $DSH_HOME/model-capability.log。
 * 引擎 stdout（engine.log）轮转很快、只留极短尾部，自动补给的静默失败在真机上无法定位——
 * 这条文件轨迹是现场排障的唯一可靠面（不含任何凭据）。
 */
function diag(message: string): void {
  if (process.env.DSH_MODEL_CAPABILITY_TRACE === '0') return
  try {
    const home = process.env.DSH_HOME ?? '/data/user/0/com.dsharnessmobile.shell/files/home/.dsh'
    appendFileSync(`${home}/model-capability.log`, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 诊断失败不影响主流程
  }
}

/** Loads the build-time catalog snapshot shipped beside this module. */
export function loadCatalogSnapshot(): CatalogSnapshot | undefined {
  if (snapshotTried) return cachedSnapshot
  snapshotTried = true
  try {
    cachedSnapshot = JSON.parse(readFileSync(new URL('./catalog-snapshot.json', import.meta.url), 'utf8')) as CatalogSnapshot
  } catch {
    cachedSnapshot = undefined
  }
  return cachedSnapshot
}

/**
 * Keep only the wire-dialect compat keys, and only when the catalog actually
 * declares a thinking format — a partial dialect (e.g. only maxTokensField)
 * would still let pi-ai fall back to a detected default (issue #134).
 * @param compat - unanimous compat map from the catalog lookup.
 * @returns the dialect keys to write, or undefined when the dialect is unknown.
 */
export function pickDialect(compat: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!compat || compat.thinkingFormat === undefined) return undefined
  const out: Record<string, unknown> = {}
  for (const key of DIALECT_COMPAT_KEYS) {
    const value = compat[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Injects catalog-derived capabilities into a probe report and recomputes unknowns. */export function mergeCatalog(
  report: ProbeReport,
  declared: string[],
  snapshot: CatalogSnapshot | undefined,
  api: string | undefined,
): ProbeReport {
  const byId = new Map<string, ModelCapabilities>(report.models.map((model) => [model.id, model]))
  for (const id of declared) {
    if (!byId.has(id)) {
      const fresh: ModelCapabilities = { id, sources: {} }
      byId.set(id, fresh)
      report.models.push(fresh)
    }
  }
  for (const model of byId.values()) {
    const match = lookupCatalog(snapshot, model.id, api)
    if (match.providers.length > 0) report.notes.push(`${model.id}: 引擎目录命中 ${match.providers.join('/')}`)
    for (const conflict of match.conflicts) report.notes.push(`${model.id}: ${conflict}`)
    const capabilities = match.capabilities
    // 方言优先（issue #134）：reasoningEfforts 只有在「pi-ai 知道该模型的方言」时才写。
    // 目录里同名模型来自多个厂商、thinkingFormat 冲突或缺失时，pi-ai 会按探测默认
    // （未知 baseURL → openai）序列化 reasoning_effort，真实网关可能直接 400。
    const dialect = pickDialect(capabilities.compat)
    if (dialect && !model.compat) {
      model.compat = dialect
    }
    if (capabilities.reasoningEfforts && !model.reasoningEfforts) {
      if (dialect) {
        model.reasoningEfforts = capabilities.reasoningEfforts
        model.sources.reasoningEfforts = 'engine-catalog'
      } else {
        report.notes.push(
          `${model.id}: 目录未给出统一 thinkingFormat（方言不明）——跳过 reasoningEfforts 写入，`
          + '避免按错误方言发送推理等级导致请求被拒；如需档位请在设置里显式声明 compat.thinkingFormat',
        )
      }
    }
    if (capabilities.input && !model.input) {
      model.input = capabilities.input
      model.sources.input = 'engine-catalog'
    }
    if (capabilities.contextWindow && !model.contextWindow) {
      model.contextWindow = capabilities.contextWindow
      model.sources.contextWindow = 'engine-catalog'
    }
    if (capabilities.maxTokens && !model.maxTokens) {
      model.maxTokens = capabilities.maxTokens
      model.sources.maxTokens = 'engine-catalog'
    }
  }
  report.models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  report.unknown = declared.filter((id) => {
    const found = byId.get(id)
    return !found || Object.keys(found.sources).length === 0
  })
  return report
}

function summarize(report: ProbeReport): string {
  const lines = [`提供商路由 ${report.route}：抓取 ${report.fetched.length} 个端点，识别 ${report.models.length} 个模型`]
  for (const model of report.models) {
    const parts: string[] = []
    if (model.input) parts.push('模态 ' + model.input.join('/'))
    if (model.contextWindow) parts.push('上下文 ' + model.contextWindow)
    if (model.maxTokens) parts.push('输出上限 ' + model.maxTokens)
    if (model.reasoningEfforts) parts.push('推理等级 ' + Object.keys(model.reasoningEfforts).join('/'))
    const sources = Object.entries(model.sources).map(([key, source]) => `${key}<-${source}`).join(' ')
    lines.push(`- ${model.id}: ${parts.length > 0 ? parts.join('，') : '未声明任何能力'}${sources ? ' [' + sources + ']' : ''}`)
  }
  if (report.unknown.length > 0) lines.push(`未获得能力元数据：${report.unknown.join(', ')}`)
  for (const note of report.notes) lines.push('注：' + note)
  return lines.join('\n')
}

/** Turns a report into field-level patches, keeping each field's provenance. */
export function patchesFrom(report: ProbeReport): ModelPatch[] {
  const patches: ModelPatch[] = []
  for (const model of report.models) {
    const patch: ModelPatch = { id: model.id }
    let any = false
    if (model.reasoningEfforts) { patch.reasoningEfforts = model.reasoningEfforts; any = true }
    if (model.compat) { patch.compat = model.compat; any = true }
    if (model.input) { patch.input = model.input; any = true }
    if (model.contextWindow) { patch.contextWindow = model.contextWindow; any = true }
    if (model.maxTokens) { patch.maxTokens = model.maxTokens; any = true }
    if (any) {
      const sources = Object.values(model.sources)
      patch.source = [...new Set(sources)].join('+')
      patches.push(patch)
    }
  }
  return patches
}

export function apply(ctx: Context, config: PluginConfig = {}) {
  const c = ctx as unknown as CtxLike
  const settings = c.settings
  const log = c.logger?.('dsh-model-capability')
  // diag() 落在 $DSH_HOME/model-capability.log：引擎 stdout 轮转太快，写回被拒的真因只有这里留得住。
  const logWithTrace = log === undefined ? undefined : { ...log, trace: diag }
  const snapshot = loadCatalogSnapshot()
  diag(`apply(): settings=${settings ? 'yes' : 'no'} catalog=${snapshot ? `${snapshot.source} models=${String(snapshot.modelCount ?? 0)}` : 'absent'} autoApply=${String(config.autoApply)} startupDelay=${String(config.startupDelaySeconds ?? 8)}`)
  if (snapshot) log?.info?.(`catalog snapshot: ${snapshot.source} / ${String(snapshot.modelCount ?? 0)} models`)
  else log?.info?.('catalog snapshot absent — engine-catalog stage disabled')

  /** Resolves the route's API key: explicit settings value first, then the credential ref. */
  async function resolveConfig(route: string, sectionOverride?: unknown) {
    const config = providerFromSettings(settings, route, sectionOverride)
    if (!config) return undefined
    const credentials = optionalService<CredentialsLike>(ctx, 'credentials')
    if (!config.apiKey && config.apiKeyEnv && credentials) {
      try {
        const resolved = await credentials.resolve(config.apiKeyEnv)
        if (resolved?.value) config.apiKey = resolved.value
      } catch {
        // 凭据不可读不阻断被动探测（有些端点 /models 免鉴权）
      }
    }
    return config
  }

  async function discover(
    route: string,
    options: { active?: boolean; confirm?: boolean; levels?: string[]; offline?: boolean } = {},
    sectionOverride?: unknown,
  ) {
    const providerConfig = await resolveConfig(route, sectionOverride)
    if (!providerConfig) {
      diag(`discover(${route}): providerFromSettings 返回 undefined（路由或 baseURL 不在 llm-pi-ai 里）`)
      return undefined
    }
    diag(`discover(${route}): baseURL=${providerConfig.baseURL} api=${providerConfig.api ?? '-'} models=${JSON.stringify(providerConfig.models ?? [])} apiKey=${providerConfig.apiKey ? 'yes' : 'no'}`)
    const fetchImpl = globalThis.fetch as unknown as FetchLike
    const report = options.offline
      ? { route, fetched: [], models: [], unknown: [...(providerConfig.models ?? [])], notes: [] } as ProbeReport
      : await probePassive(providerConfig, { fetchImpl })
    mergeCatalog(report, providerConfig.models ?? [], snapshot, providerConfig.api)
    if (options.active) {
      if (!options.confirm) {
        report.notes.push('active=true 但缺少 confirm=true（主动探测会消耗额度，需用户明确批准）——本次仅做被动发现')
      } else {
        const levels = options.levels && options.levels.length > 0 ? options.levels : ['low', 'medium', 'high']
        const url = providerConfig.baseURL.replace(/\/+$/, '') + '/chat/completions'
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          ...(providerConfig.apiKey ? { authorization: `Bearer ${providerConfig.apiKey}` } : {}),
          ...(providerConfig.headers ?? {}),
        }
        // 负控（决策 D7）：端点若连无效值都接受，则「接受某个等级」不构成证据。
        const control = await probeReasoningEfforts({
          url, headers, levels: ['__dsh_invalid__'], fetchImpl, timeoutMs: 15_000,
          body: (level) => ({ model: report.models[0]?.id ?? '', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, reasoning_effort: level }),
        })
        const validates = control.rejected.length > 0
        if (!validates) {
          report.notes.push('负控失败：端点接受无效 reasoning_effort 值 → 接受性探测不可信，本次不据此写入等级（只保留被动/目录结论）')
        } else {
          for (const model of report.models) {
            if (model.reasoningEfforts) continue
            const result = await probeReasoningEfforts({
              url, headers, levels, fetchImpl,
              body: (level) => ({ model: model.id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, reasoning_effort: level }),
            })
            if (result.efforts) {
              model.reasoningEfforts = result.efforts
              model.sources.reasoningEfforts = 'active-probe'
            }
            if (result.rejected.length > 0) report.notes.push(`${model.id}: 端点拒绝的等级 ${result.rejected.map((r) => r.level).join(', ')}`)
            for (const item of result.inconclusive) report.notes.push(`${model.id}: 等级 ${item.level} 结果不确定（${item.reason}）`)
          }
        }
      }
    }
    return { providerConfig, report }
  }

  const probeTool = defineTool({
    name: 'model_capability_probe',
    description:
      'Discover capability metadata for a user-declared provider route: passive endpoint descriptors first, vendor schemas second, then an exact model-id lookup in the vendor catalogs the engine ships. ' +
      'Never infers capabilities from URLs or model names; unknown stays unknown. ' +
      'Active probes (which spend quota) run only when active=true and confirm=true, and are discarded when a negative control shows the endpoint does not validate the field. ' +
      'Set apply=true to write the discovered model-level capabilities back into settings (missing fields only).',
    parameters: {
      provider: { type: 'string', required: true, description: 'llm-pi-ai provider route id, e.g. "my-gateway"' },
      active: { type: 'boolean', description: 'Also run active reasoning-effort probes (default false)' },
      confirm: { type: 'boolean', description: 'Explicit user approval for active probes (required when active=true)' },
      levels: { type: 'array', items: { type: 'string' }, description: 'Candidate effort words for active probes (default low/medium/high)' },
      apply: { type: 'boolean', description: 'Write discovered capabilities back to settings (missing fields only)' },
      offline: { type: 'boolean', description: 'Skip network entirely and use only the engine catalog (default false)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          report: { type: 'object', additionalProperties: true },
          applied: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value: Record<string, unknown>) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    execute: async (args: { provider: string; active?: boolean; confirm?: boolean; levels?: string[]; apply?: boolean; offline?: boolean }) => {
      const found = await discover(args.provider, args)
      if (!found) {
        return { ok: false, text: `未在 llm-pi-ai 设置中找到提供商路由「${args.provider}」或其 baseURL——请先在设置页填写自定义提供商。`, report: {} } as never
      }
      const { report } = found
      let applied: Record<string, unknown> | undefined
      if (args.apply) {
        const result = await applyModelPatch(settings, args.provider, patchesFrom(report), logWithTrace)
        applied = result as unknown as Record<string, unknown>
        report.notes.push(result.wrote
          ? `已写回 ${result.changes.length} 项：${result.changes.join('；')}`
          : `未写回（${result.reason}）${result.changes.length > 0 ? '：' + result.changes.join('；') : ''}`)
      }
      return { ok: true, text: summarize(report), report, applied } as never
    },
  })

  const applyTool = defineTool({
    name: 'model_capability_apply',
    description:
      'Discover (engine catalog + passive endpoint metadata) and write back missing model-level capabilities for one user-declared provider route. ' +
      'Only fills fields the route does not declare; never overwrites a user value and never writes a provider-wide setting. ' +
      'Does not spend quota unless active=true and confirm=true.',
    parameters: {
      provider: { type: 'string', required: true, description: 'llm-pi-ai provider route id' },
      active: { type: 'boolean', description: 'Also run active reasoning-effort probes (default false)' },
      confirm: { type: 'boolean', description: 'Explicit approval for active probes' },
      offline: { type: 'boolean', description: 'Use only the engine catalog (default true for apply)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          applied: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value: Record<string, unknown>) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    execute: async (args: { provider: string; active?: boolean; confirm?: boolean; offline?: boolean }) => {
      const found = await discover(args.provider, { ...args, offline: args.offline ?? true })
      if (!found) {
        return { ok: false, text: `未找到提供商路由「${args.provider}」。` } as never
      }
      const result = await applyModelPatch(settings, args.provider, patchesFrom(found.report), logWithTrace)
      const lines = [summarize(found.report)]
      lines.push(result.wrote
        ? `已写回：${result.changes.join('；')}`
        : `未写回（${result.reason}）`)
      if (result.skipped.length > 0) lines.push(`跳过：${result.skipped.join('；')}`)
      return { ok: true, text: lines.join('\n'), applied: result as unknown as Record<string, unknown> } as never
    },
  })

  ctx.tools.register(probeTool)
  ctx.tools.register(applyTool)
  log?.info?.('model_capability_probe / model_capability_apply registered')

  // 自动补给（决策 D5，对齐 model-sync 的启动轮）：延迟一轮，只做目录 + 被动，
  // 只写「缺失且无歧义」的字段；失败静默落日志。
  //
  // 回归场景（2026-09-10 用户口径）：用户在设置页「添加自定义供应商」后，
  // 不重启、不手改 settings.yaml，思考档位就应出现。
  //
  // 【T1 常驻 CPU（2026-09-25）】旧实现用「每 5 秒全量 describe 取签名」实现该回归，
  // 实测代价是常驻 24-26% CPU（4 次 --cpu-prof：w3 24% / w4 26% / c3 25% / c4 24%，
  // 证据 .deploy-tmp/boot-attribution/REPORT.md §5）。真因不在本插件的循环，
  // 而在 describe 的实现：settings 服务没有「只读自有命名空间」的轻量路径，
  // 每次 describe 都走 configEditor.configuration() → 对**全 profile 每个 entry**
  // 重做 inherited() = flatten(composeEntries(全量层 patch)) + structuredClone。
  // 单次 describe 实测 300-1500 ms inclusive（w3 七次调用合计 4218 ms）。
  // **所以「把 poll 从 5s 调到 30s」只是把同样的全量重算摊薄，不改变单次成本**；
  // 真正要减的是**describe 的调用次数**。三条并行手段：
  //   ① 事件驱动：上游在「raw 段变化」时 emit settings/document-updated（出货
  //      dsh-settings/lib/index.js:521-547 bumpRevision → emitDocumentUpdated，
  //      经 ctx.events 共享总线派发）。这是**唯一能同时做到「即时」与「零轮询」**的路子。
  //   ② 兜底轮询：默认 120s（从 5s 提高两个量级），只在上游事件面不可用时兜底。
  //   ③ 每次 tick 只读一次描述符并在内部复用（旧实现同一 tick 内 describe 2-3 次：
  //      signatureOf + routesToConsider + 每个 route 的 providerFromSettings）。
  //
  // 为什么用事件而不是「只保留轮询但调大间隔」：调大间隔会把「用户添加供应商 → 档位出现」
  // 的延迟从秒级拉到分钟级，等于用功能退化换 CPU；而事件正是「设置变了」的权威信号，
  // 既不轮询也不延迟。事件的**数据面**（为什么事件够用、以及与 settings.watch 的关系）
  // 见下方 subscribeSettingsEvents 的注释。
  if (config.autoApply !== false && settings) {
    const delayMs = Math.max(0, config.startupDelaySeconds ?? 8) * 1000
    let signature = ''
    /** 是否已建立签名基线：未建立时首轮直接跑，省掉一次无意义的比较读。 */
    let baselineSet = false
    /** 本 tick 内共享的描述符：避免同一 tick 对 llm-pi-ai 重复 describe。 */
    let tickSection: unknown
    /** 事件已触发但本轮尚未消费时置真：tick 看到它即跑一轮，保证「先到的事件不丢」。 */
    let eventPending = false
    /** effect 是否已停止（deferrer 的回调在事务外跑，需自行判断存活）。 */
    const stoppedRef = { value: false }

    /**
     * 读一次 llm-pi-ai 描述符，并在**本 tick 内**复用给 routesToConsider / signatureOf /
     * providerFromSettings / applyModelPatch。这是 T1 的第三条手段：旧实现在同一 tick 里
     * describe 2-3 次，每次都付一次全量 configuration() + structuredClone。
     * @returns 描述符，读失败时 undefined（调用方按「无路由」处理）。
     */
    const readDescriptor = () => {
      if (tickSection === undefined) {
        try {
          tickSection = settings.describe({ namespaces: ['llm-pi-ai'] }).find((d) => d.ns === 'llm-pi-ai')
        } catch {
          tickSection = null
        }
      }
      return tickSection === null ? undefined : tickSection as { ns: string; value: unknown; revision: number } | undefined
    }

    const routesToConsider = (): string[] => {
      // describe(options) 的 options 被实现忽略 → 必须按 ns 查找（不能用 [0]）
      const section = readDescriptor()?.value as { providers?: Record<string, unknown> } | undefined
      return config.routes ?? Object.keys(section?.providers ?? {})
    }

    /**
     * 能力补给触发签名（0.14.0-preview / ST-03）：**值敏感**——含路由级键（baseURL/api 等）的规范化值
     * 与模型级能力字段的值，结构增删同样改变签名。旧实现只记「字段有无」，换网关/手改配置不触发重跑。
     * 见 src/signature.ts 与计划文档 §4.2 ST-03。
     */
    const signatureOf = (): string => {
      try {
        return capabilitySignature(readDescriptor()?.value, config.routes)
      } catch {
        return ''
      }
    }

    /** 来源戳：记录「该字段现在的值是我方写下的」，使新发现的值可刷新我方旧写入（用户手写值无戳）。 */
    const stamps = createStampStore()

    const runAutoPass = async () => {
      const routes = routesToConsider()
      diag(`runAutoPass: routes=${JSON.stringify(routes)}`)
      const descriptor = readDescriptor()
      for (const route of routes) {
        try {
          const found = await discover(route, { offline: true }, descriptor?.value)
          if (!found) continue
          diag(`runAutoPass(${route}): models=${found.report.models.length} efforts=${JSON.stringify(found.report.models.map((m) => [m.id, m.reasoningEfforts ?? null]))}`)
          const patches = patchesFrom(found.report).filter((patch) => patch.reasoningEfforts !== undefined)
          diag(`runAutoPass(${route}): patches=${patches.length}`)
          if (patches.length === 0) continue
          const result = await applyModelPatch(settings, route, patches, logWithTrace, stamps, descriptor)
          diag(`runAutoPass(${route}): wrote=${result.wrote} reason=${result.reason} changes=${JSON.stringify(result.changes)}`)
          if (result.wrote) log?.info?.(`auto-apply ${route}: ${result.changes.join('；')}`)
        } catch (error) {
          diag(`runAutoPass(${route}) failed: ${(error as Error)?.message ?? String(error)}`)
          log?.warn?.(`auto-apply ${route} failed: ${(error as Error)?.message ?? String(error)}`)
        }
      }
    }

    /**
     * 一轮补给检查。`force` 为真时跳过签名短路（事件已经告诉我们「设置变了」，
     * 不必再花一次 describe 去重新求签名——这正是省 CPU 的关键：事件路径下每轮
     * 只 describe 一次，轮询路径才需要「先签名后决定」的两次读）。
     * @param force - 事件驱动路径为 true。
     */
    // 轮询 tick 与事件 tick 可能并发；两者共用 tickSection（每 tick 的描述符缓存），
    // 交叠会互相清掉对方的缓存并多做一次全量 describe。用一个在跑标志串行化：
    // 跑动期间到达的请求只置 rerun，由当前这轮结束后补跑（不丢事件、不并发）。
    let ticking = false
    let rerun = false

    const tick = async (force = false) => {
      if (ticking) {
        rerun = true
        return
      }
      ticking = true
      try {
        do {
          rerun = false
          tickSection = undefined
          eventPending = false
          // 首轮（baseline 尚未建立）必须直接跑，不做「先取签名再比较」——
          // signature 初值是空串，比较必然不等，那次 describe 是纯浪费
          // （离线实测：启动轮 2 次 describe 里正好有 1 次是它）。
          if (!force && baselineSet) {
            const next = signatureOf()
            diag(`tick: signature=${next.slice(0, 120)} changed=${next !== signature}`)
            if (next === signature) break
          } else {
            diag(force ? 'tick: event-driven (settings/document-updated)' : 'tick: first pass (baseline)')
          }
          await runAutoPass()
          // 写回会改变签名，刷新一次基线避免下一轮重复执行
          tickSection = undefined
          signature = signatureOf()
          baselineSet = true
          // 跑动期间设置又变了 → 再跑一轮（事件只来自真实写入，不会自旋）
          if (eventPending) rerun = true
          force = true
        } while (rerun)
      } finally {
        ticking = false
      }
    }

    /**
     * 把回调送出当前异步上下文（X1 修复，2026-09-25）。
     *
     * 为什么必须送出：hmr 用 `AsyncLocalStorage` 标记「事务执行中」
     * （dsh-hmr/src/index.ts:130 `executing`，:140 嵌套即抛
     * `HMR transactions cannot be nested`）。`settings/document-updated` 是在**用户那次
     * 写事务之内**同步 emit 的（出货 settings 的 write → configEditor.edit → hmr.runExclusive），
     * 所以事件回调里再调 `settings.mutate` → `configEditor.edit` → 又一次 `runExclusive` 就被拒。
     *
     * 关键：**在事务内新调度的普通调度器会继承该上下文**——setTimeout / setImmediate /
     * queueMicrotask / process.nextTick / Promise.then 全部继承（离线实测，
     * `.deploy-tmp/fix-b1/als-escape.mjs`）。只有**在事务外预建**的 async 资源不会继承：
     * 预建 MessageChannel 的 onmessage 落在干净上下文（`.deploy-tmp/fix-b1/als3.mjs`，ESCAPED）。
     * 因此这里在 effect 装配时（彼时不在任何事务内）预建通道，事件到来时只 postMessage。
     * @returns 送出函数与释放函数。
     */
    const createDeferrer = () => {
      if (typeof MessageChannel === 'function') {
        const channel = new MessageChannel()
        let queued: (() => void) | undefined
        channel.port1.onmessage = () => {
          const run = queued
          queued = undefined
          run?.()
        }
        // 不让诊断通道拖住进程退出（Android 上尤其重要）
        ;(channel.port1 as unknown as { unref?: () => void }).unref?.()
        ;(channel.port2 as unknown as { unref?: () => void }).unref?.()
        return {
          defer: (fn: () => void) => { queued = fn; channel.port2.postMessage(0) },
          dispose: () => { queued = undefined; channel.port1.close(); channel.port2.close() },
        }
      }
      // 兜底：预建 promise 链（continuation 在事务外注册，同样不继承上下文）
      // 判据同 als3.mjs 的 premade-gate：第二跳仍为 ESCAPED。
      let wake: (() => void) | undefined
      let pending: (() => void) | undefined
      let closed = false
      const arm = (): Promise<void> => new Promise<void>((resolve) => { wake = resolve })
      let gate = arm()
      void (async () => {
        for (;;) {
          await gate
          if (closed) return
          gate = arm()
          const run = pending
          pending = undefined
          run?.()
        }
      })()
      return {
        defer: (fn: () => void) => { pending = fn; wake?.() },
        dispose: () => { closed = true; pending = undefined; wake?.() },
      }
    }

    /**
     * 订阅「设置文档变化」事件作为主触发器。
     *
     * 依据（出货 0.14.1 `dsh-settings/lib/index.js:515-547`）：该服务在**raw 段**变化时
     * bumpRevision → emitDocumentUpdated('settings/document-updated', ns, revision)，
     * 经共享的 `ctx.events` 总线 emit 派发；同一总线对所有插件可见（cordis Context
     * 只在 root 构造一个 EventsService，见 vendor/cordis/src/context.ts:80）。
     * 因此本插件不需要 `settings.watch`（那是「自有命名空间」的接口，见
     * `register()` 返回的 scope.watch；llm-pi-ai 归 llm-pi-ai 插件所有，我们不是它的 owner），
     * 也不需要轮询：事件本身就是「用户改了配置」的权威信号。
     *
     * 事件只带 (ns, revision)，不带值——所以回调里仍然要读一次描述符。这次读是**必要的**
     * 而不是浪费：没有它无从知道新值；而它每「一次真实用户修改」只发生一次，
     * 不再是「每 5 秒一次」。
     * @param deferrer - 把 tick 送出当前 HMR 事务的通道（见 createDeferrer）。
     */
    const subscribeSettingsEvents = (deferrer: { defer: (fn: () => void) => void }) => {
      const on = (ctx as unknown as {
        on?: (name: string, listener: (...args: unknown[]) => void) => () => void
      }).on
      if (typeof on !== 'function') {
        diag('settings/document-updated 不可订阅（ctx.on 缺席）→ 退化为轮询兜底')
        return undefined
      }
      try {
        return on.call(ctx, 'settings/document-updated', (...args: unknown[]) => {
          const ns = String(args[0] ?? '')
          if (ns !== 'llm-pi-ai') return
          diag(`settings/document-updated ns=${ns} rev=${String(args[1])}`)
          // 落一个「有变化待消费」标记：tick 在跑则它会在本轮结束后补跑，
          // 没在跑则这次调用直接跑。两种情况下事件都不会被丢掉。
          eventPending = true
          // 必须经 deferrer 送出事务上下文，否则 tick 内的 settings.mutate 会被 hmr 拒绝（X1）。
          deferrer.defer(() => { if (!stoppedRef.value) void tick(true) })
        })
      } catch (error) {
        diag(`settings/document-updated 订阅失败（${(error as Error)?.message ?? String(error)}）→ 退化为轮询兜底`)
        return undefined
      }
    }

    c.effect?.(() => {
      let stopped = false
      stoppedRef.value = false
      diag('auto-apply effect armed')
      // deferrer 必须在**事务外**预建：它的 async 资源不能带上 hmr 的事务上下文，
      // 否则事件回调里触发的写回仍会被 hmr 判为嵌套（见 createDeferrer）。
      const deferrer = createDeferrer()
      // 先订阅再决定轮询间隔：事件可用时轮询只是「怕漏事件」的安全网，可以很稀；
      // 事件不可用时轮询就是**唯一**触发器，稀到 120s 会把「添加供应商 → 档位出现」
      // 的延迟从秒级退化到 2 分钟（功能退化）。因此间隔按事件面是否可用分两档取：
      //   事件可用   -> 默认 120s（安全网；常态下永不触发）
      //   事件不可用 -> 默认 30s （唯一触发器；把延迟与 CPU 折中）
      // 两档都用 Math.max(30, ...) 钳下界：用户显式配 5s 会被钳到 30，
      // 这是**有意**的，防止把 poll 配回过 5s 又打回 24-26% 常驻 CPU（见上方成本注释）。
      const unsubscribe = subscribeSettingsEvents(deferrer)
      const eventDriven = unsubscribe !== undefined
      const fallbackSeconds = eventDriven ? 120 : 30
      const pollMs = Math.max(30, config.pollIntervalSeconds ?? fallbackSeconds) * 1000
      diag(`poll interval=${String(pollMs / 1000)}s eventDriven=${String(eventDriven)}`)
      // 启动轮与轮询轮也可能落在别的 hmr 事务里（例如启动期 profile 重载），
      // 同样经 deferrer 送出，保证任何一路触发都能写回成功。
      const startTimer = setTimeout(() => { if (!stopped) deferrer.defer(() => { if (!stopped) void tick() }) }, delayMs)
      const interval = setInterval(() => { if (!stopped) deferrer.defer(() => { if (!stopped) void tick() }) }, pollMs)
      return () => {
        stopped = true
        stoppedRef.value = true
        clearTimeout(startTimer)
        clearInterval(interval)
        unsubscribe?.()
        deferrer.dispose()
      }
    })
  } else {
    diag(`auto-apply 未启用（autoApply=${String(config.autoApply)} settings=${settings ? 'yes' : 'no'}）`)
  }
}
