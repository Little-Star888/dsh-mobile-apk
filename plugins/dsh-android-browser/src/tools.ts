/**
 * dsh-android-browser 工具面：把 BROWSER_TOOLS 契约逐条落到壳侧 `browser*` 控制 op。
 *
 * 纪律（方案 §4.2 / 验收 §4.5）：
 *  - **ref + pageGeneration 双校验**：snapshot 得到 `{tabId,pageGeneration,refs}` 后，动作工具必须带上
 *    同代 ref；原生侧还会再验一次 generation 与当前页代次。旧 ref / 跨页 ref 一律拒绝，不猜测点击。
 *  - **URL 准入门在原生 BrowserHost**（只允许非本地 http(s)/about:blank）；本层不复制准入逻辑，
 *    但会把拒绝原因原样透传给模型。
 *  - 单一工位（一个 BrowserHost，一个标签页）：多标签工具如实返回单标签事实，不假装支持。
 *  - 每个动作写审计（经 bridge 服务的 audit 面；缺失时静默降级，审计不是主流程门禁）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AsyncLocalStorage } from 'node:async_hooks'
import { BROWSER_OPS, BROWSER_TOOLS, IDENTITY_PROFILES, VIEWPORT_PRESETS } from './contract.js'
import type { ControlFace } from './facts.js'

/** 浏览器工具需要的控制面（bridge 服务；browser* 由控制队列承载）。 */
export interface BrowserControlFace extends ControlFace {
  gateFor?(session?: unknown): { ok: true; via?: string } | { ok: false; guidance: string }
  audit?(action: string, detail: Record<string, unknown>, ok: boolean): void
}

type Payload = Record<string, unknown>
type CallResult = { ok: true; data: Payload } | { ok: false; error: string; guidance?: string }

interface SnapshotMemory {
  tabId: string
  pageGeneration: number
  refs: Set<string>
}

/** 最近一次成功 snapshot 的 ref 集（单工位；动作工具据此附带 generation）。 */
let lastSnapshot: SnapshotMemory | undefined

/** 清除浏览器记忆（open/navigate 换页、测试隔离）。 */
export function resetBrowserMemory(): void {
  lastSnapshot = undefined
}

/**
 * 输出 schema 构造器。
 *
 * defineTool 的 schema 形参要求字面量方言（ParameterPropertySpec）；这里集中构造后以 `as never`
 * 交给调用点（与 manage 工具面 `as never` 的既有形态同族）。运行期结构由引擎整值校验与
 * check-tool-output-schema 门禁核对——类型断言不改变运行期契约。
 */
function objectSchema(properties: Record<string, unknown>): never {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      error: { type: 'string' },
      guidance: { type: 'string' },
      ...properties,
    },
  } as never
}

const SNAPSHOT_NODE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ref: { type: 'string' },
    role: { type: 'string' },
    name: { type: 'string' },
    bounds: { type: 'array' },
    inView: { type: 'boolean' },
    disabled: { type: 'boolean' },
  },
}

export function browserTools(face: () => BrowserControlFace | undefined): unknown[] {
  /** 会话键：控制 op 一律带归属会话，壳侧据此做单实例归属校验（0.14.0）。 */
  const sessionScope = new AsyncLocalStorage<string>()

  const sessionOf = (exec: unknown): string | undefined => {
    const session = (exec as { agent?: { session?: unknown } } | undefined)?.agent?.session
    if (typeof session === 'string' && session !== '') return session
    if (session !== null && session !== undefined && typeof session === 'object') {
      const id = (session as { id?: unknown }).id
      if (typeof id === 'string' && id !== '') return id
    }
    return undefined
  }

  /**
   * 工具面统一包裹（2026-09-15）：
   * - 失败渲染兜底：拒绝/失败对象（denied(...)）此前仍被 render 渲染，字段取不到就输出 undefined，
   *   snapshot 的 render 还会在 undefined 上抛错——真实 error/guidance 被吞掉；现 ok:false 一律渲染原文；
   * - 会话注入：execute 期间把归属会话放进作用域，`call` 自动附加到控制 op 参数上（壳侧归属校验）。
   */
  const withFailureText = (tool: unknown): unknown => {
    const definition = tool as {
      output?: { render?: unknown }
      execute?: (args: unknown, exec: unknown) => unknown
    }
    const originalExecute = definition.execute
    const wrapped = (() => {
      const output = definition.output
      if (output === undefined || typeof output.render !== 'function') return tool
      const original = output.render as (args: unknown, v: Record<string, unknown>) => unknown
      return {
        ...(tool as Record<string, unknown>),
        output: {
          ...(output as Record<string, unknown>),
          render: (args: unknown, v: Record<string, unknown>) => {
            if (v !== null && typeof v === 'object' && v.ok === false) {
              const error = typeof v.error === 'string' && v.error !== '' ? v.error : 'tool-failed'
              const guidance = typeof v.guidance === 'string' && v.guidance !== '' ? '（' + v.guidance + '）' : ''
              return [{ type: 'text', text: '失败：' + error + guidance }]
            }
            return original(args, v)
          },
        },
      }
    })()
    if (typeof originalExecute !== 'function') return wrapped
    return {
      ...(wrapped as Record<string, unknown>),
      execute: (args: unknown, exec: unknown) => {
        const session = sessionOf(exec)
        return session === undefined
          ? originalExecute(args, exec)
          : sessionScope.run(session, () => originalExecute(args, exec))
      },
    }
  }

  const call = async (op: string, args: Payload, timeoutMs = 15_000): Promise<CallResult> => {
    const session = sessionScope.getStore()
    const payload: Payload = session === undefined ? args : { ...args, session }
    const control = face()
    if (control?.controlExec === undefined) {
      return { ok: false, error: 'bridge-unavailable', guidance: '引擎侧桥服务（androidPrivilege）未装配，无法调用浏览器控制通道。' }
    }
    try {
      const reply = await control.controlExec(op, payload, timeoutMs)
      if (reply === null || typeof reply !== 'object' || (reply as { ok?: unknown }).ok !== true) {
        const message = (reply as { error?: unknown } | null)?.error
        return { ok: false, error: typeof message === 'string' && message !== '' ? message : 'control-failed' }
      }
      const data = ((reply as { data?: unknown }).data ?? {}) as Payload
      if (data.ok === false) {
        return {
          ok: false,
          error: typeof data.reason === 'string' ? data.reason : 'op-rejected',
          ...(typeof data.guidance === 'string' ? { guidance: data.guidance } : {}),
        }
      }
      return { ok: true, data }
    } catch (e) {
      return { ok: false, error: 'control-exception: ' + String((e as Error).message) }
    }
  }

  const gate = (exec: unknown): { ok: true } | { ok: false; guidance: string } => {
    const control = face()
    if (control?.gateFor === undefined) return { ok: true }
    const result = control.gateFor((exec as { agent?: { session?: unknown } } | undefined)?.agent?.session)
    return result.ok ? { ok: true } : { ok: false, guidance: result.guidance }
  }

  const audit = (tool: string, args: Payload, ok: boolean): void => {
    try { face()?.audit?.(tool, { tool, args }, ok) } catch { /* 审计缺失不阻塞 */ }
  }

  const parseJsJson = (value: unknown): Payload | undefined => {
    if (typeof value !== 'string') return undefined
    try {
      const parsed = JSON.parse(value)
      return parsed !== null && typeof parsed === 'object' ? (parsed as Payload) : undefined
    } catch {
      return undefined
    }
  }

  const denied = (result: { ok: false; error: string; guidance?: string }, extra: Payload = {}): Payload => ({
    ok: false,
    error: result.error,
    ...(result.guidance === undefined ? {} : { guidance: result.guidance }),
    ...extra,
  })

  const stateOf = async (): Promise<Payload> => {
    const result = await call(BROWSER_OPS.state, {}, 6_000)
    return result.ok ? result.data : {}
  }

  const pageGenerationOf = (data: Payload): number => {
    const value = data.pageGeneration
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  const requireSnapshot = (): SnapshotMemory | undefined => lastSnapshot

  const tools: unknown[] = [
    defineTool({
      name: BROWSER_TOOLS.open,
      description:
        '打开侧栏 AI 浏览器并导航到一个 http(s) 地址（本地回环/file/content/data/javascript 一律拒绝）。'
        + '可选先应用视口档（viewport）与身份档（identity）。返回页面代次，后续 snapshot/click 以它为准。',
      parameters: {
        url: { type: 'string', required: true, description: '要打开的 http(s) 地址' },
        viewport: { type: 'string', description: '视口档 id（见 browser_set_viewport 的预设表）' },
        identity: { type: 'string', description: '身份档 id：android-real | linux-desktop | windows-desktop' },
      },
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          title: { type: 'string' },
          loadState: { type: 'string' },
          pageGeneration: { type: 'number' },
          appliedViewport: { type: 'string' },
          appliedIdentity: { type: 'string' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: '浏览器已打开 ' + String(v.url) + '（代次 ' + String(v.pageGeneration) + '）' }],
      },
      execute: async ({ url, viewport, identity }: { url: string; viewport?: string; identity?: string }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        audit(BROWSER_TOOLS.open, { url, viewport, identity }, true)
        let appliedViewport: string | undefined
        if (typeof viewport === 'string' && viewport !== '') {
          const preset = VIEWPORT_PRESETS.find((p) => p.id === viewport)
          const result = await call(BROWSER_OPS.viewport, { preset: viewport, route: 'S2', width: preset?.width ?? 0, height: preset?.height ?? 0 }, 8_000)
          if (!result.ok) return denied(result) as never
          appliedViewport = viewport
        }
        let appliedIdentity: string | undefined
        if (typeof identity === 'string' && identity !== '') {
          const profile = IDENTITY_PROFILES.find((p) => p.id === identity)
          if (profile === undefined) return { ok: false, error: 'unknown-identity' } as never
          const result = await call(BROWSER_OPS.setUa, { profile: profile.id, ua: profile.ua, platform: profile.platform, mobile: profile.mobile }, 8_000)
          if (!result.ok) return denied(result) as never
          appliedIdentity = profile.id
        }
        const opened = await call(BROWSER_OPS.open, { url }, 20_000)
        if (!opened.ok) return denied(opened) as never
        resetBrowserMemory()
        const state = await stateOf()
        return {
          ok: true,
          url: typeof state.url === 'string' ? state.url : url,
          title: typeof state.title === 'string' ? state.title : '',
          loadState: typeof state.loadState === 'string' ? state.loadState : 'navigating',
          pageGeneration: pageGenerationOf({ ...opened.data, ...state }),
          ...(appliedViewport === undefined ? {} : { appliedViewport }),
          ...(appliedIdentity === undefined ? {} : { appliedIdentity }),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.snapshot,
      description:
        '对当前浏览器页面建立结构化 DOM/ARIA 快照：返回标签、页面代次、视口与可交互节点列表（ref/role/name/bounds/inView）。'
        + '后续 click/type 必须使用本快照的 ref，并会校验页面代次；页面已变化时旧 ref 一律拒绝。',
      parameters: {
        delta: { type: 'boolean', description: '保留参数：当前实现总是返回完整快照（单工位页面通常很小）' },
      },
      output: {
        schema: objectSchema({
          tabId: { type: 'string' },
          pageGeneration: { type: 'number' },
          surface: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          viewport: { type: 'object', additionalProperties: true },
          nodes: { type: 'array', items: SNAPSHOT_NODE_SCHEMA },
          truncated: { type: 'boolean' },
        }),
        render: (_args, v: Record<string, unknown>) => {
          const nodes = Array.isArray(v.nodes) ? v.nodes : []
          return [
            { type: 'text', text: '快照 ' + String(nodes.length) + ' 个可交互节点（' + String(v.url) + '，代次 ' + String(v.pageGeneration) + '）' },
          ]
        },
      },
      execute: async (_args, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const result = await call(BROWSER_OPS.js, { snapshot: true }, 15_000)
        if (!result.ok) return denied(result) as never
        const nodes = Array.isArray(result.data.nodes) ? (result.data.nodes as Payload[]) : []
        const refs = new Set<string>()
        for (const node of nodes) if (typeof node.ref === 'string') refs.add(node.ref)
        const tabId = typeof result.data.tabId === 'string' ? result.data.tabId : 'tab-1'
        const pageGeneration = pageGenerationOf(result.data)
        lastSnapshot = { tabId, pageGeneration, refs }
        return {
          ok: true,
          tabId,
          pageGeneration,
          surface: typeof result.data.surface === 'string' ? result.data.surface : 'browser',
          url: typeof result.data.url === 'string' ? result.data.url : '',
          title: typeof result.data.title === 'string' ? result.data.title : '',
          viewport: (result.data.viewport ?? {}) as Payload,
          nodes,
          truncated: result.data.truncated === true,
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.click,
      description: '点击最近一次 snapshot 的 ref 指向的元素。必须与快照同页面代次；旧 ref/旧代次返回 stale-error，不做猜测性点击。',
      parameters: { ref: { type: 'string', required: true, description: '快照中的 ref（形如 bx12）' } },
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          changed: { type: 'boolean' },
          pageGeneration: { type: 'number' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: '已点击（' + String(v.url) + '）' }],
      },
      execute: async ({ ref }: { ref: string }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const memory = requireSnapshot()
        if (memory === undefined) {
          return { ok: false, error: 'snapshot-required', guidance: '先调用 browser_snapshot 拿到 ref，再点击；不猜测坐标。' } as never
        }
        audit(BROWSER_TOOLS.click, { ref }, true)
        const result = await call(BROWSER_OPS.input, { kind: 'tap', ref, pageGeneration: memory.pageGeneration }, 15_000)
        if (!result.ok) return denied(result) as never
        const state = await stateOf()
        return {
          ok: true,
          url: typeof state.url === 'string' ? state.url : '',
          changed: result.data.changed === true,
          pageGeneration: pageGenerationOf({ ...state, ...result.data }),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.type,
      description: '向最近一次 snapshot 的 ref 元素输入文本（默认替换原内容）。与 click 同一套 ref/代次校验。',
      parameters: {
        ref: { type: 'string', required: true, description: '快照中的 ref' },
        text: { type: 'string', required: true, description: '要输入的文本' },
        replace: { type: 'boolean', description: 'true（默认）替换原值；false 追加' },
      },
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          value: { type: 'string' },
          pageGeneration: { type: 'number' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: '已输入文本（当前值 ' + String(v.value).slice(0, 40) + '）' }],
      },
      execute: async ({ ref, text, replace }: { ref: string; text: string; replace?: boolean }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const memory = requireSnapshot()
        if (memory === undefined) {
          return { ok: false, error: 'snapshot-required', guidance: '先调用 browser_snapshot 拿到 ref，再输入。' } as never
        }
        audit(BROWSER_TOOLS.type, { ref, length: text.length }, true)
        const result = await call(BROWSER_OPS.input, {
          kind: 'text', ref, text, replace: replace !== false, pageGeneration: memory.pageGeneration,
        }, 15_000)
        if (!result.ok) return denied(result) as never
        return {
          ok: true,
          url: typeof result.data.url === 'string' ? result.data.url : '',
          value: typeof result.data.value === 'string' ? result.data.value : '',
          pageGeneration: pageGenerationOf(result.data),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.press,
      description: '发送按键：Enter/Tab/Escape/Backspace/Delete/方向键/PageUp/PageDown/Home/End，或单个可打印字符（插入聚焦元素）。',
      parameters: { key: { type: 'string', required: true, description: '按键名或单个字符' } },
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          canGoBack: { type: 'boolean' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: '已发送按键（' + String(v.url) + '）' }],
      },
      execute: async ({ key }: { key: string }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        audit(BROWSER_TOOLS.press, { key }, true)
        const result = await call(BROWSER_OPS.input, { kind: 'key', key }, 10_000)
        if (!result.ok) return denied(result) as never
        const state = await stateOf()
        return {
          ok: true,
          url: typeof state.url === 'string' ? state.url : '',
          canGoBack: state.canGoBack === true,
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.scroll,
      description: '滚动当前页面。返回滚动后的 scrollY 与是否到底；不改变页面代次。',
      parameters: {
        direction: { type: 'string', required: true, description: 'up | down | left | right' },
        amount: { type: 'number', description: '像素量（默认 600）' },
      },
      output: {
        schema: objectSchema({
          scrollY: { type: 'number' },
          atEnd: { type: 'boolean' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: 'scrollY=' + String(v.scrollY) + (v.atEnd === true ? '（已到底）' : '') }],
      },
      execute: async ({ direction, amount }: { direction: string; amount?: number }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const step = typeof amount === 'number' && Number.isFinite(amount) ? Math.max(1, Math.min(4000, Math.abs(amount))) : 600
        const dx = direction === 'left' ? -step : direction === 'right' ? step : 0
        const dy = direction === 'up' ? -step : direction === 'down' ? step : 0
        const expression = 'window.scrollBy(' + dx + ',' + dy + ');JSON.stringify({scrollY:window.scrollY,atEnd:(window.scrollY+(window.innerHeight||0))>=(document.documentElement.scrollHeight-2)})'
        const result = await call(BROWSER_OPS.js, { expr: expression }, 10_000)
        if (!result.ok) return denied(result) as never
        const payload = parseJsJson(result.data.value) ?? {}
        return { ok: true, scrollY: typeof payload.scrollY === 'number' ? payload.scrollY : 0, atEnd: payload.atEnd === true } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.getText,
      description: '读取当前页面的可见文本（可指定 CSS 像素矩形区域，取该点元素文本）。默认整页文本，超过 20000 字符截断。',
      parameters: {
        region: {
          type: 'object', additionalProperties: true,
          description: '{x,y,w,h}（CSS 像素；取区域中心元素的文本）',
        },
      },
      output: {
        schema: objectSchema({
          sourceUrl: { type: 'string' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: String(v.text).slice(0, 4000) }],
      },
      execute: async ({ region }: { region?: { x?: number; y?: number; w?: number; h?: number } }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const hasRegion = region !== undefined && typeof region.x === 'number' && typeof region.y === 'number'
        const cx = hasRegion ? Number(region!.x) + (typeof region!.w === 'number' ? Number(region!.w) / 2 : 0) : 0
        const cy = hasRegion ? Number(region!.y) + (typeof region!.h === 'number' ? Number(region!.h) / 2 : 0) : 0
        const expression = hasRegion
          ? '(function(){var el=document.elementFromPoint(' + cx + ',' + cy + ');var t=el?el.innerText:\'\';return JSON.stringify({text:String(t).slice(0,20000),url:location.href});})()'
          : '(function(){var body=document.body;var t=body?body.innerText:\'\';return JSON.stringify({text:String(t).slice(0,20000),url:location.href});})()'
        const result = await call(BROWSER_OPS.js, { expr: expression }, 10_000)
        if (!result.ok) return denied(result) as never
        const payload = parseJsJson(result.data.value) ?? {}
        const text = typeof payload.text === 'string' ? payload.text : ''
        return {
          ok: true,
          sourceUrl: typeof payload.url === 'string' ? payload.url : '',
          text,
          truncated: text.length >= 20000,
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.wait,
      description: '等待页面条件：选择器出现（selector），或页面文本/地址稳定（stable，默认）。有超时上限，超时返回 ok=false + 原因。',
      parameters: {
        selector: { type: 'string', description: 'CSS 选择器；不传则等待页面稳定' },
        stable: { type: 'boolean', description: 'true 时等待文本长度与地址不再变化' },
        timeoutMs: { type: 'number', description: '超时（默认 8000，最大 20000）' },
      },
      output: {
        schema: objectSchema({
          waited: { type: 'number' },
          reason: { type: 'string' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: '等待结束：' + String(v.reason) + '（' + String(v.waited) + 'ms）' }],
      },
      execute: async ({ selector, stable, timeoutMs }: { selector?: string; stable?: boolean; timeoutMs?: number }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const budget = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? Math.max(500, Math.min(20_000, timeoutMs)) : 8_000
        const started = Date.now()
        const wantStable = stable !== false && (selector === undefined || selector === '')
        let previous = ''
        let stableHits = 0
        while (Date.now() - started < budget) {
          if (!wantStable && selector !== undefined && selector !== '') {
            const expression = '(function(){return JSON.stringify({ready:!!document.querySelector(' + JSON.stringify(selector) + '),readyState:document.readyState,url:location.href});})()'
            const result = await call(BROWSER_OPS.js, { expr: expression }, 6_000)
            if (result.ok) {
              const payload = parseJsJson(result.data.value) ?? {}
              if (payload.ready === true) return { ok: true, waited: Date.now() - started, reason: 'selector-present' } as never
            }
          } else {
            const expression = '(function(){var b=document.body;return JSON.stringify({url:location.href,len:(b?b.innerText:\'\').length,readyState:document.readyState});})()'
            const result = await call(BROWSER_OPS.js, { expr: expression }, 6_000)
            if (result.ok) {
              const payload = parseJsJson(result.data.value) ?? {}
              const signature = String(payload.url ?? '') + '#' + String(payload.len ?? '') + '#' + String(payload.readyState ?? '')
              if (signature === previous && payload.readyState === 'complete') stableHits += 1
              else stableHits = 0
              previous = signature
              if (stableHits >= 2) return { ok: true, waited: Date.now() - started, reason: 'page-stable' } as never
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
        return { ok: false, waited: Date.now() - started, reason: wantStable ? 'stable-timeout' : 'selector-timeout' } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.navigate,
      description: '把当前浏览器工位导航到新的 http(s) 地址（沿用同一 WebView，与 browser_open 的准入规则一致）。',
      parameters: { url: { type: 'string', required: true, description: '要导航到的 http(s) 地址' } },
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          title: { type: 'string' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: '已导航 ' + String(v.url) }],
      },
      execute: async ({ url }: { url: string }, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        audit(BROWSER_TOOLS.navigate, { url }, true)
        const result = await call(BROWSER_OPS.open, { url }, 20_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        const state = await stateOf()
        return {
          ok: true,
          url: typeof state.url === 'string' ? state.url : url,
          title: typeof state.title === 'string' ? state.title : '',
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.back,
      description: '浏览器历史后退（仅能在准入过的页面间移动）。返回新地址与是否还能后退。',
      parameters: {},
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          canGoBack: { type: 'boolean' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: '已后退（' + String(v.url) + '）' }],
      },
      execute: async (_args, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const result = await call(BROWSER_OPS.js, { expr: 'history.back();JSON.stringify({ok:true})' }, 10_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        await new Promise((resolve) => setTimeout(resolve, 400))
        const state = await stateOf()
        return { ok: true, url: typeof state.url === 'string' ? state.url : '', canGoBack: state.canGoBack === true } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.forward,
      description: '浏览器历史前进（仅能在准入过的页面间移动）。返回新地址与是否还能前进。',
      parameters: {},
      output: {
        schema: objectSchema({
          url: { type: 'string' },
          canGoForward: { type: 'boolean' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: '已前进（' + String(v.url) + '）' }],
      },
      execute: async (_args, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const result = await call(BROWSER_OPS.js, { expr: 'history.forward();JSON.stringify({ok:true})' }, 10_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        await new Promise((resolve) => setTimeout(resolve, 400))
        const state = await stateOf()
        return { ok: true, url: typeof state.url === 'string' ? state.url : '', canGoForward: state.canGoForward === true } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.reload,
      description: '重新加载当前页面；页面代次会递增，旧快照 ref 随即失效。',
      parameters: {},
      output: {
        schema: objectSchema({ url: { type: 'string' } }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: '已请求重载（' + String(v.url) + '）' }],
      },
      execute: async (_args, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const result = await call(BROWSER_OPS.js, { expr: 'location.reload();JSON.stringify({ok:true})' }, 10_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        const state = await stateOf()
        return { ok: true, url: typeof state.url === 'string' ? state.url : '' } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.listTabs,
      description: '列出浏览器工位的标签页。当前工位只有一个标签页（单 WebView），如实返回；不假装多标签。',
      parameters: {},
      output: {
        schema: objectSchema({
          tabs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          activeTabId: { type: 'string' },
        }),
        render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: String((v.tabs as unknown[]).length) + ' 个标签页（活动 ' + String(v.activeTabId) + '）' }],
      },
      execute: async (_args, exec) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const state = await stateOf()
        const tabs = Array.isArray(state.tabs) ? (state.tabs as Payload[]) : [{
          tabId: typeof state.tabId === 'string' ? state.tabId : 'tab-1',
          url: typeof state.url === 'string' ? state.url : 'about:blank',
          title: typeof state.title === 'string' ? state.title : '',
          active: true,
        }]
        const activeTabId = typeof state.tabId === 'string' ? state.tabId : 'tab-1'
        return { ok: true, tabs, activeTabId } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.followTab,
      description: '切换到指定标签页。单工位实现只接受当前活动标签；其它 tabId 明确失败，不静默改投。',
      parameters: { tabId: { type: 'string', required: true, description: '标签 id（当前实现只有 tab-1）' } },
      output: {
        schema: objectSchema({
          activeTabId: { type: 'string' },
          url: { type: 'string' },
        }),
        render: (_args: unknown, v: Record<string, unknown>) => [{ type: 'text', text: '已切到 ' + String(v.activeTabId) }],
      },
      execute: async ({ tabId }: { tabId: string }, exec: unknown) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const state = await stateOf()
        const activeTabId = typeof state.tabId === 'string' ? state.tabId : 'tab-1'
        if (tabId !== activeTabId) {
          return { ok: false, error: 'tab-not-found', guidance: '当前工位只有 ' + activeTabId + '；多标签能力未实现，不静默改投。' } as never
        }
        const shown = await call(BROWSER_OPS.show, {}, 8_000)
        if (!shown.ok) return denied(shown) as never
        return { ok: true, activeTabId, url: typeof state.url === 'string' ? state.url : '' } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.closeTab,
      description: '关闭浏览器工作台：销毁当前页面（不保留页面状态；再次打开是空白工作台）。'
        + '单工位实现只有 tab-1；AI 需要时重新 browser_open 即可。',
      parameters: { tabId: { type: 'string', required: true, description: '标签 id（当前实现只有 tab-1）' } },
      output: {
        schema: objectSchema({
          closed: { type: 'boolean' },
          retained: { type: 'boolean' },
        }),
        render: (_args: unknown) => [{ type: 'text', text: '浏览器页面已关闭（已销毁）' }],
      },
      execute: async ({ tabId }: { tabId: string }, exec: unknown) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const state = await stateOf()
        const activeTabId = typeof state.tabId === 'string' ? state.tabId : 'tab-1'
        if (tabId !== activeTabId) {
          return { ok: false, error: 'tab-not-found', guidance: '当前工位只有 ' + activeTabId + '。' } as never
        }
        const closed = await call(BROWSER_OPS.close, {}, 8_000)
        if (!closed.ok) return denied(closed) as never
        resetBrowserMemory()
        return { ok: true, closed: true, retained: false } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.setIdentity,
      description: '切换浏览器身份档（android-real 默认真实身份 / linux-desktop / windows-desktop）。'
        + '身份切换后重新加载当前页面并递增页面代次；本机未编入 UA-CH 覆写，只改 UA 串（返回 degraded 说明）。'
        + '不承诺规避反爬或站点风控。',
      parameters: { profile: { type: 'string', required: true, description: '身份档 id' } },
      output: {
        schema: objectSchema({
          profile: { type: 'string' },
          uaChApplied: { type: 'boolean' },
          degraded: { type: 'string' },
        }),
        render: (_args: unknown, v: Record<string, unknown>) => [{ type: 'text', text: '身份档 ' + String(v.profile) + (v.uaChApplied === true ? '' : '（UA 串模式）') }],
      },
      execute: async ({ profile }: { profile: string }, exec: unknown) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const selected = IDENTITY_PROFILES.find((p) => p.id === profile)
        if (selected === undefined) {
          return { ok: false, error: 'unknown-identity', guidance: '可用身份：' + IDENTITY_PROFILES.map((p) => p.id).join(', ') } as never
        }
        audit(BROWSER_TOOLS.setIdentity, { profile }, true)
        const result = await call(BROWSER_OPS.setUa, {
          profile: selected.id, ua: selected.ua, platform: selected.platform, mobile: selected.mobile,
        }, 10_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        return {
          ok: true,
          profile: selected.id,
          uaChApplied: result.data.uaChApplied === true,
          ...(typeof result.data.degraded === 'string' ? { degraded: result.data.degraded } : {}),
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.setViewport,
      description: '切换浏览器呈现分辨率（letterbox 到舞台内，不做坐标缩放）。档位表见 panelStatus.viewportPresets；'
        + 'device = 跟随工位实际尺寸。切换后建议重新 snapshot（布局变化可能改变 ref 位置）。',
      parameters: {
        preset: { type: 'string', required: true, description: '视口档 id（device / phone-portrait / tablet / …）' },
        fit: { type: 'string', description: 'fit（默认，等比缩入舞台）| one-to-one（1:1，超出裁掉）' },
      },
      output: {
        schema: objectSchema({
          preset: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          route: { type: 'string' },
        }),
        render: (_args: unknown, v: Record<string, unknown>) => [{ type: 'text', text: '视口 ' + String(v.preset) + '（' + String(v.width) + '×' + String(v.height) + '）' }],
      },
      execute: async ({ preset, fit }: { preset: string; fit?: string }, exec: unknown) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        const selected = VIEWPORT_PRESETS.find((p) => p.id === preset || (preset === 'follow-screen' && p.id === 'device'))
        if (selected === undefined) {
          return { ok: false, error: 'unknown-viewport', guidance: '可用视口：' + VIEWPORT_PRESETS.map((p) => p.id).join(', ') } as never
        }
        audit(BROWSER_TOOLS.setViewport, { preset, fit }, true)
        const result = await call(BROWSER_OPS.viewport, {
          preset: selected.id, route: 'S2', width: selected.width, height: selected.height,
        }, 10_000)
        if (!result.ok) return denied(result) as never
        resetBrowserMemory()
        return {
          ok: true,
          preset: selected.id,
          width: typeof result.data.width === 'number' ? result.data.width : selected.width,
          height: typeof result.data.height === 'number' ? result.data.height : selected.height,
          route: typeof result.data.route === 'string' ? result.data.route : 'S2',
        } as never
      },
    }),
    defineTool({
      name: BROWSER_TOOLS.screenshot,
      description: '对浏览器工位实际画面矩形截图（不包含舞台留黑）。返回引擎可读的私有路径与字节数；截图落在应用私有目录，工具层读完即删。',
      parameters: { inline: { type: 'boolean', description: '保留参数；当前返回路径而不内联像素（避免大图进上下文）' } },
      output: {
        schema: objectSchema({
          path: { type: 'string' },
          bytes: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          health: { type: 'string' },
        }),
        render: (_args: unknown, v: Record<string, unknown>) => [{ type: 'text', text: '截图已保存：' + String(v.path) }],
      },
      execute: async ({ inline }: { inline?: boolean }, exec: unknown) => {
        const session = gate(exec)
        if (!session.ok) return { ok: false, error: 'session-not-full-access', guidance: session.guidance } as never
        audit(BROWSER_TOOLS.screenshot, { inline: inline === true }, true)
        const result = await call(BROWSER_OPS.shot, { inline: inline === true }, 15_000)
        if (!result.ok) return denied(result) as never
        return {
          ok: true,
          path: typeof result.data.path === 'string' ? result.data.path : '',
          bytes: typeof result.data.bytes === 'number' ? result.data.bytes : 0,
          width: typeof result.data.width === 'number' ? result.data.width : 0,
          height: typeof result.data.height === 'number' ? result.data.height : 0,
          health: typeof result.data.health === 'string' ? result.data.health : 'ok',
        } as never
      },
    }),
  ]

  // 档位工具（android_browser_tier）由 index.ts 注册（依赖 index 的 tier 报告）；这里只补动作工具面。
  return tools.map(withFailureText)
}
