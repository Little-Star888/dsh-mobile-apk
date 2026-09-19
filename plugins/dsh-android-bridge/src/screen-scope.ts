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
  /**
   * 块G F2：壳侧虚拟屏注册表当前登记的 displayId 集合（raw shell 命令的显式 `-d <id>` 核对用）。
   * 缺席/不可达 → 视为空集（fail-closed：不凭命令里的数字自证目标屏属虚拟屏）。
   */
  virtualDisplayIds?: readonly number[] | ReadonlySet<number>
  /**
   * 块G F6：**SurfaceFlinger token** ↔ 产品别名的配对（`screencap -d` 实际吃的 id 空间）。
   *
   * 为什么需要它：`screencap -d <DisplayManager displayId>` 对虚拟屏**必然失败**
   * （设备实测 Status -2），只有传 SF token 才出图；而 SF token 既不在 `virtualDisplayIds` 里、
   * 又超出 2^53/2^63 无法数值化。故必须并存这条字符串映射。
   * 同时必须给 [virtualAliases]——**只有配对别名确属已注册虚拟屏的 token 才可放行**，
   * 真实屏的 SF token 一律拒绝。
   */
  sfVirtualDisplays?: readonly { alias: string; token: string }[]
  /** 当前已注册的虚拟屏**别名**集合（与 sfVirtualDisplays 联合使用，缺一即 fail-closed）。 */
  virtualAliases?: readonly string[] | ReadonlySet<string>
}

/**
 * a11y 承载的、**按设计作用于设备屏内容**的 op——执行点范围复查的分类真源。
 *
 * 0.14.1 块G（F4）口径更正：本常量是**按 op 名**的分类，回答「这个 op 通常是否读写某块设备屏
 * 的内容」，**不是**「这一次调用作用于真实屏」。后者必须由 `args.screenId` 经注册表解析出的
 * **目标屏**判定（见 index.ts 的 controlExec 执行点与 decideScreenAccess）。把前者当成后者，
 * 在 virtual-only + 已建虚拟屏时必然误判，并产出「范围允许 virtual-1 却说不许访问真实屏」的
 * 自相矛盾报文（用户实报；该报文逐字来自 index.ts 执行点的硬编码文案）。
 *
 * 两类刻意不在列：
 *   - `state`：只回代次/失效标记（元数据），不含屏幕内容（U-3 约束的是内容面）；
 *   - `webSnapshot` / `webAction`：目标是**壳自有 WebView**（DSH 自己的 Web UI），不带也不认
 *     `screenId`，与设备屏无关。按 op 名归为「设备屏内容 op」会让 `android_web_dump` 在
 *     virtual-only 下被整体误拒（块G F4b 同源论断：过度拦截与「范围门禁自相矛盾」是同一类缺陷）。
 * browser\* 操作隔离 BrowserHost（第二 WebView），vd\* 是虚拟屏管理/元数据——都不在此列。
 */
export const REAL_SCREEN_CONTROL_OPS: readonly string[] = [
  'snapshot', 'click', 'longClick', 'setText', 'scroll', 'global', 'screenshot', 'nodeText',
]

/** 该 op 是否读写**设备屏**内容（review C11：controlExec 执行点据此复查范围）。 */
export function controlOpNeedsRealScreen(op: string): boolean {
  return REAL_SCREEN_CONTROL_OPS.includes(op)
}

/**
 * ADB shell 命令里显式指定的目标 display id（`-d <id>` / `--display <id>` / `--display-id <id>`）。
 *
 * 用途（块G F2）：raw shell 面的范围复查不能只做**命令词**匹配——`screencap -d 47` 读的是
 * 虚拟屏 47，与无参 `screencap`（读真实屏 0）根本不是一件事；同罪拒绝会让「用户只给
 * virtual-only」也永远读不到自己的虚拟屏。提取目标 id 后交由调用方与壳侧注册表核对。
 * @returns 命令中出现的 display id；空数组 = 命令没有可核对的目标屏（调用方必须 fail-closed）。
 */
export function adbCommandDisplayIds(command: string): number[] {
  const ids: number[] = []
  for (const m of command.matchAll(/(?:^|[\s=])(?:-d|--display|--display-id)[\s=]+(\d+)/g)) {
    const id = Number(m[1])
    if (Number.isInteger(id)) ids.push(id)
  }
  return ids
}

/**
 * 块G F6：同上的目标屏参数，但**保留原始十进制串、不做数值化**。
 *
 * 为什么必须另立一个字符串版：`screencap -d` 吃的是 **SurfaceFlinger display token**，
 * 设备实测虚拟屏形如 `11529215046816944610`——它 **> 2^53**（JS Number 安全整数上界）
 * 且 **> 2^63-1**（Kotlin Long 上界）。任何数值化都会把它变成 `...944000`（末位失真），
 * 于是「设备上能出图的 token」与「命令里写的 token」不再相等，判定与取图必然错位。
 * （主屏 token `4619827820427265280` 同样 > 2^53。）
 *
 * 因此：**比对一律按字符串逐字**，本函数是全链路唯一的取值口。
 * @returns 命令中出现的目标屏数字串（原样，未数值化）；空数组 = 无可核对目标屏。
 */
export function adbCommandDisplayTokens(command: string): string[] {
  const out: string[] = []
  for (const m of command.matchAll(/(?:^|[\s=])(?:-d|--display|--display-id)[\s=]+(\d+)/g)) {
    out.push(m[1])
  }
  return out
}

/**
 * ADB shell 面的真实屏读写命令（review C11：raw shell 是绕过页面的执行面，默认 virtual-only
 * 下 screencap/input/uiautomator 仍能读/操作真实屏——必须在执行点拒绝）。
 * 只做保守的**命令词**匹配：写面配置命令另有 looksDangerousAdb 黑名单兜底。
 */
const REAL_SCREEN_ADB_COMMAND =
  /\b(?:screencap|screenrecord|uiautomator|input\s+(?:tap|swipe|roll|draganddrop|motionevent|text|keyevent)|wm\s+(?:size|density|overscan)|dumpsys\s+(?:window|display|input)|am\s+(?:start|start-activity|force-stop|kill)|monkey)\b/i

/**
 * 块G F2 + F6：命令的**显式目标屏**是否确为一块已注册虚拟屏。
 *
 * 判据随 F6 放宽为「两个 id 空间任一命中」（设备实测证明二者不相交，见 [screenTokensFromSfDump]）：
 *  ① **DisplayManager displayId**（数值）：命令里出现了该 id、非 0、且在各虚拟屏 id 集合里；
 *  ② **SurfaceFlinger token**（十进制串）：命令里出现了该 token、且它**属于某块已注册虚拟屏**——
 *     即该 token 出现在壳侧 `dumpsys SurfaceFlinger` 的虚拟屏枚举里，**且**其配对
 *     `name="DSH <alias>"` 的别名是当前已注册虚拟屏别名之一。
 *
 * 两条都要求**逐个**目标都命中（命令带多个 `-d` 时不得只放行其中一个）。
 * 注册表/token 集合缺席或不可达 → 对应判据视为不命中 → 拒绝（fail-closed：绝不凭命令里的
 * 数字自证「这是虚拟屏」，也绝不放行真实屏的 token）。
 */
function targetsRegisteredVirtualScreen(command: string, options: ScreenAccessOptions): boolean {
  const tokens = adbCommandDisplayTokens(command)
  if (tokens.length === 0) return false

  // ① DisplayManager displayId 空间（F2 既有路径，保持不变）。
  const knownIds = options.virtualDisplayIds
  const idSet = knownIds === undefined
    ? null
    : (knownIds instanceof Set ? knownIds : new Set<number>(knownIds))
  const allByDisplayId = idSet !== null && tokens.every((raw) => {
    const id = Number(raw)
    return Number.isInteger(id) && id !== REAL_DISPLAY_ID && idSet.has(id)
  })
  if (allByDisplayId) return true

  // ② SurfaceFlinger token 空间（F6 新增）：token 必须属于某块**已注册别名**的虚拟屏。
  const sf = options.sfVirtualDisplays
  const aliases = options.virtualAliases
  if (sf === undefined || aliases === undefined) return false
  const aliasSet = aliases instanceof Set ? aliases : new Set<string>(aliases)
  if (sf.length === 0 || aliasSet.size === 0) return false
  const ownedTokens = new Set(
    sf.filter((e) => aliasSet.has(e.alias)).map((e) => e.token),
  )
  if (ownedTokens.size === 0) return false
  // 逐字字符串比对（token 超 2^53/2^63，任何数值化都会失真——见 adbCommandDisplayTokens）。
  return tokens.every((raw) => ownedTokens.has(raw))
}

/**
 * 块G F6：解析 `dumpsys SurfaceFlinger` 输出里的**虚拟屏 token ↔ 产品别名**配对。
 *
 * 输入取自受支持的抽取命令（输出很小，避免全文超壳侧 16 KiB 上限）：
 * ```
 * dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'
 * ```
 * 设备实测（MuMu x86_64 模拟器 / Android 15 / API 35）逐字形态：
 * ```
 *     name="mumuscreen000"
 * Virtual Display 11529215046816944610
 *     name="DSH virtual-1"
 * ```
 * 该命令**不被** [REAL_SCREEN_ADB_COMMAND] 命中（后者只认 `dumpsys (window|display|input)`），
 * 故本次改动**不扩大 shell 命令词面**——它只让范围判定能核对 SF token，不是放宽执行面。
 *
 * 纯函数：无 IO、无全局态，可离线单测。token 全程按字符串（见 [adbCommandDisplayTokens]）。
 */
export function screenTokensFromSfDump(sfDump: string): Array<{ alias: string; token: string }> {
  const out: Array<{ alias: string; token: string }> = []
  let pending: string | null = null
  for (const rawLine of String(sfDump ?? '').split(/\r?\n/)) {
    const tokenLine = /^Virtual Display\s+(\d+)\s*$/.exec(rawLine.trim())
    if (tokenLine !== null) {
      pending = tokenLine[1]
      continue
    }
    if (pending === null) continue
    const nameLine = /^\s*name="([^"]*)"\s*$/.exec(rawLine)
    if (nameLine === null) continue
    const displayName = nameLine[1]
    // 壳侧 createVirtualDisplay 用 "DSH <alias>" 命名（VdisplayController.create）。
    if (displayName.startsWith('DSH ')) out.push({ alias: displayName.slice('DSH '.length), token: pending })
    // 配对已消费（无论是否 DSH 屏）：防止把下一个 name= 错配到本 token 上。
    pending = null
  }
  return out
}

/** @return 拒绝文案（范围不含 real 且命令命中真实屏读写面）；null = 放行。 */
export function realScreenAdbCommandDenied(
  scope: UserScreenScope,
  command: string,
  options: ScreenAccessOptions = {},
): string | null {
  if (scope === 'all' || scope === 'real-only') return null
  if (!REAL_SCREEN_ADB_COMMAND.test(command)) return null
  // 块G F2：目标屏是**已注册虚拟屏**的命令放行（screencap -d <虚拟屏 id> 读的是范围内的屏）。
  // 放宽面收敛在「显式且可与注册表核对的目标屏」上：无 -d、-d 0、-d 未知 id 一律保持拒绝。
  if (targetsRegisteredVirtualScreen(command, options)) return null
  return '用户当前开放屏幕范围为 virtual-only，不允许读取或操作真实屏内容'
    + '（screencap/screenrecord/uiautomator/input/wm/dumpsys window|display|input/am start/monkey）。'
    + '命令里显式指定的目标屏若确为**已注册虚拟屏**（DisplayManager displayId 或该屏的 '
    + 'SurfaceFlinger token）即可放行；本条命令的目标屏未能与壳侧注册表核对上，故拒绝。'
    + '请确认虚拟屏仍在活跃状态（android_vdisplay_create / vdInfo），或由用户在设置中修改范围后重试。'
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
