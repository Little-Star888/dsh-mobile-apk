import { readFileSync } from 'node:fs'

/** User-owned, stable screen aliases exposed to model-facing Android tools. */
export type ScreenId = string
export type UserScreenScope = 'virtual-only' | 'real-only' | 'all'

export const DEFAULT_SCREEN_SCOPE: UserScreenScope = 'virtual-only'
export const REAL_SCREEN_ID = 'real'
export const VIRTUAL_SCREEN_ID = 'virtual-1'
export const REAL_DISPLAY_ID = 0

/** 规格 §2.1：壳侧分配 1..N 的 `virtual-N`；本版上限 1 屏。 */
const VIRTUAL_SCREEN_PATTERN = /^virtual-([1-9][0-9]{0,2})$/

/** `virtual-N` 编号；非虚拟别名返回 null。 */
export function virtualScreenOrdinal(screenId: string | undefined): number | null {
  const match = VIRTUAL_SCREEN_PATTERN.exec(screenId ?? '')
  return match === null ? null : Number(match[1])
}

export function isVirtualScreenId(screenId: string | undefined): boolean {
  return virtualScreenOrdinal(screenId) !== null
}

const SHELL_SCREEN_SCOPE_PREFS_DEFAULT = '/data/user/0/com.dsharnessmobile.shell/shared_prefs/dsh_screen_scope.xml'

/** Result returned before a tool reads pixels, a UI tree, or dispatches an input action. */
export type ScreenAccessDecision =
  | { ok: true; screenId: ScreenId; displayId: number; scope: UserScreenScope }
  | { ok: false; reason: 'screen-not-found' | 'screen-out-of-scope' | 'screen-not-ready'; guidance: string; scope: UserScreenScope; screenId: string }

/** review C11：调用方可提供原生注册表解析出的虚拟屏**动态** displayId（alias→id 回填）。 */
export interface ScreenAccessOptions {
  virtualDisplayId?: number | null
}

/**
 * a11y 承载的 op 逐一作用于**真实屏前台窗口**（观察或注入）——执行点范围复查的分类真源。
 * `state` 刻意不在列：它只回代次/失效标记（元数据），不含屏幕内容（U-3「连截图/读树都不得送入模型」指内容面）。
 * browser\* 操作隔离 BrowserHost（第二 WebView），vd\* 是虚拟屏管理/元数据——都不在此列。
 */
export const REAL_SCREEN_CONTROL_OPS: readonly string[] = [
  'snapshot', 'click', 'longClick', 'setText', 'scroll', 'global', 'screenshot', 'nodeText',
  'webSnapshot', 'webAction',
]

/** 该 op 是否读写真实屏内容（review C11：controlExec 执行点据此复查范围）。 */
export function controlOpNeedsRealScreen(op: string): boolean {
  return REAL_SCREEN_CONTROL_OPS.includes(op)
}

/**
 * ADB shell 面的真实屏读写命令（review C11：raw shell 是绕过页面的执行面，默认 virtual-only
 * 下 screencap/input/uiautomator 仍能读/操作真实屏——必须在执行点拒绝）。
 * 只做保守的**命令词**匹配：写面配置命令另有 looksDangerousAdb 黑名单兜底。
 */
const REAL_SCREEN_ADB_COMMAND =
  /\b(?:screencap|screenrecord|uiautomator|input\s+(?:tap|swipe|roll|draganddrop|motionevent|text|keyevent)|wm\s+(?:size|density|overscan)|dumpsys\s+(?:window|display|input)|am\s+(?:start|start-activity|force-stop|kill)|monkey)\b/i

/** @return 拒绝文案（范围不含 real 且命令命中真实屏读写面）；null = 放行。 */
export function realScreenAdbCommandDenied(scope: UserScreenScope, command: string): string | null {
  if (scope === 'all' || scope === 'real-only') return null
  if (!REAL_SCREEN_ADB_COMMAND.test(command)) return null
  return '用户当前开放屏幕范围为 virtual-only，不允许经 ADB 读取或操作真实屏幕（screencap/input/uiautomator 等）。请由用户在设置中修改范围后重试。'
}

/** Normalize only the three product settings values; corrupt data fails closed. */
export function normalizeScreenScope(value: unknown): UserScreenScope {
  return value === 'virtual-only' || value === 'real-only' || value === 'all' ? value : DEFAULT_SCREEN_SCOPE
}

/** Parse the native ScreenScopePrefs XML without allowing an engine plugin to write that preference. */
export function parseScreenScopePrefsXml(xml: string): UserScreenScope {
  const match = /<string\s+name="scope">([^<]*)<\/string>/.exec(xml)
  return normalizeScreenScope(match?.[1])
}

function scopePrefsPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.DSH_SCREEN_SCOPE_PREFS_PATH) return env.DSH_SCREEN_SCOPE_PREFS_PATH
  if (env.TERMUX__PREFIX && env.DSH_HOME) return SHELL_SCREEN_SCOPE_PREFS_DEFAULT
  return undefined
}

/**
 * Read the native preference afresh for each device operation. Test-only environment input is
 * intentionally gated, so a stale generic environment value cannot override the shell preference.
 */
export function currentScreenScope(env: NodeJS.ProcessEnv = process.env): UserScreenScope {
  if (env.DSH_SCREEN_SCOPE_TEST === '1' || env.DSH_SCREEN_SCOPE_TEST === 'true') {
    return normalizeScreenScope(env.DSH_SCREEN_SCOPE)
  }
  const path = scopePrefsPath(env)
  if (path === undefined) return DEFAULT_SCREEN_SCOPE
  try {
    return parseScreenScopePrefsXml(readFileSync(path, 'utf8'))
  } catch {
    return DEFAULT_SCREEN_SCOPE
  }
}

/**
 * Decide the executable physical/virtual-screen target for the user-owned scope.
 *
 * VirtualDisplay is deliberately not guessed from an Android numeric id: the alias must be resolved
 * through the native registry (`screens()` / `vdInfo`) and passed in via [ScreenAccessOptions].
 * Without a resolved id, before the display is ready every virtual request fails explicitly
 * (`screen-not-ready`) — never a silent fallback to display 0 (U-3).
 */
export function decideScreenAccess(
  scope: UserScreenScope,
  requested?: string,
  options: ScreenAccessOptions = {},
): ScreenAccessDecision {
  const screenId = requested === undefined || requested === '' ? REAL_SCREEN_ID : requested
  if (screenId !== REAL_SCREEN_ID && !isVirtualScreenId(screenId)) {
    return {
      ok: false,
      reason: 'screen-not-found',
      scope,
      screenId,
      guidance: `未知屏幕 ${screenId}；请先调用 android_screen_list，并使用 real 或 virtual-N。`,
    }
  }
  const inScope = scope === 'all' || (scope === 'real-only' && screenId === REAL_SCREEN_ID) || (scope === 'virtual-only' && isVirtualScreenId(screenId))
  if (!inScope) {
    return {
      ok: false,
      reason: 'screen-out-of-scope',
      scope,
      screenId,
      guidance: `用户当前开放屏幕范围为 ${scope}，不允许读取或操作 ${screenId}。请由用户在设置中修改范围。`,
    }
  }
  if (isVirtualScreenId(screenId)) {
    const resolved = options.virtualDisplayId
    if (typeof resolved === 'number' && Number.isInteger(resolved) && resolved > 0) {
      // review C11 alias 契约闭环：原生注册表给出的动态 displayId（绝不假设恒为 1、绝不回退 0）。
      return { ok: true, screenId, displayId: resolved, scope }
    }
    return {
      ok: false,
      reason: 'screen-not-ready',
      scope,
      screenId,
      guidance: `虚拟屏幕 ${screenId} 尚未就绪；系统绝不会把虚拟屏静默映射为真实屏幕 display 0。`,
    }
  }
  return { ok: true, screenId: REAL_SCREEN_ID, displayId: REAL_DISPLAY_ID, scope }
}
