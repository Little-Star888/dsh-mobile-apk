import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * Android 设备能力工具组（0.14.0 §4.1 渐进披露）。
 *
 * 上游 skill 只能携带 instructions、不能挂工具，也没有 `skills/load` 事件（子代理核查结论，
 * 见 dsh/packages/skill/skill/src/index.ts:96-102 / tool-skill/src/index.ts:127-156）。可用的
 * 上游先例是 `tool-cordis` / `tool-subagent`：**常驻一个 facade 工具 + agent 作用域
 * `tools.restrict` 掩蔽目标工具组**，facade 调用时解除掩蔽，下一步装配即含全量定义
 * （dsh/packages/core/tools/src/index.ts:1061-1088 / :804-807；tool-subagent/src/index.ts:664-706）。
 */
export const DEVICE_TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  phone: [
    'android_screen_list',
    'android_screenshot',
    'android_ui_tree',
    'android_device_info',
    'android_act_input',
    'android_ui_dump',
    'android_ui_click',
    'android_ui_scroll',
    'android_ui_input',
    'android_web_dump',
    'android_env_prepare',
    'android_app_launch',
    'android_ui_global',
    'android_ui_detail',
    // 特权 shell 与授权状态同属「手机控制」面：不常驻，避免模型一提浏览器就先去摸 ADB/shell。
    'android_shell_exec',
    'android_termux_channel_exec',
    'android_privilege_status',
  ],
  browser: [
    'browser_open',
    'browser_navigate',
    'browser_snapshot',
    'browser_click',
    'browser_type',
    'browser_get_text',
    'browser_scroll',
    'browser_press',
    'browser_wait',
    'browser_back',
    'browser_forward',
    'browser_reload',
    'browser_list_tabs',
    'browser_close_tab',
    'browser_follow_tab',
    'browser_set_viewport',
    'browser_set_identity',
    'browser_screenshot',
    'android_browser_tier',
  ],
  'virtual-display': [
    'android_vdisplay_create',
    'android_vdisplay_destroy',
    'android_vdisplay_input',
    'android_vdisplay_status',
  ],
}

/** 全部受掩蔽的设备工具名（facade 自身不在其中）。 */
export const DEVICE_TOOLS: readonly string[] = Object.values(DEVICE_TOOL_GROUPS).flat()

/** 常驻 facade 工具名：模型先调它解锁能力组，工具面才出现。 */
export const CAPABILITY_TOOL_NAME = 'android_capabilities'

/** facade 的规范返回值（与 output.schema 一致）。 */
export interface CapabilityValue {
  ok: boolean
  unlocked: string[]
  groups: Array<{ group: string; tools: number }>
  text: string
}

/** 安装渐进披露所需的最小 ctx 面（便于单测注入桩）。 */
export interface CapabilityGateCtx {
  tools: { register(tool: unknown): unknown }
  get?(name: string): unknown
  on?(event: string, handler: (payload: { agent: unknown }) => void): unknown
  logger?: { warn?(message: string): void }
}

interface ScopedFiber {
  dispose(): unknown
}

/** 能力组对应的 skill 目录条目：只做发现与「先调 facade」指引，不携带工具。 */
const CAPABILITY_SKILLS: ReadonlyArray<{ name: string; description: string; source: string; content: string }> = [
  {
    name: 'android-phone-control',
    source: 'bundled',
    description:
      '通过无障碍与 Shizuku 双通道读取并操作 Android 屏幕：语义树、点按、输入、滚动、截屏、应用拉起、虚拟屏。'
      + '涉及「手机操作 / 打开 App / 点某按钮 / 看当前界面」的任务用本能力（先调用 android_capabilities 解锁）。',
    content: [
      '# 手机控制',
      '',
      '两条通道**独立可用**：无障碍（语义树 + ref 动作、中文输入、虚拟屏语义树）与 Shizuku 特权 shell',
      '（`android_shell_exec`；坐标/命令面；虚拟屏只能坐标）。任一通道可用即可完成同类动作；工具返回里',
      '`actionMode` 会标明是 `a11y` 还是 `coordinate`。',
      '',
      '## 先解锁',
      '设备工具默认不在工具列表里：先调用 `android_capabilities`（group=phone），下一步起可用。',
      '',
      '## 真实屏',
      '1. 取控件树：**无障碍开着**用 `android_ui_dump`；**无障碍关着（纯 Shizuku）**用 `android_ui_tree`——'
      + '两者返回同形节点清单（id / 类型 / 文本 / bounds / 可点可滚），都能按 ref 操作。',
      '2. `android_ui_click {ref}` / `android_ui_input {ref, text}` / `android_ui_scroll` / `android_act_input`。',
      '3. `android_screenshot` 看画面。ref 是同一次 dump 的代次句柄；界面变化后重新 dump，不要按旧 ref 猜点。',
      '',
      '## 虚拟屏',
      '1. `android_vdisplay_create` 建屏（编号 1..N，本版上限 1）。',
      '2. 以 `screenId: "virtual-1"` 调 `android_ui_dump` / `android_ui_click` 等；先 `android_app_launch` 把 App 拉到该屏。'
      + '虚拟屏上的**按键与文本**用 `android_vdisplay_input`（android_ui_input 只对可编辑节点生效）；'
      + '注意 `android_ui_tree` **读不到虚拟屏**（uiautomator 只 dump 默认屏）。',
      '3. 语义树需要无障碍；纯 Shizuku 下返回 `actionMode: "coordinate"`，只能坐标操作。',
      '',
      '## 屏幕范围',
      '真实屏 / 虚拟屏的可访问范围由用户在设置页控制（virtual-only / real-only / all）；越界是结构化拒绝，不会回退。',
    ].join('\n'),
  },
  {
    name: 'android-ai-browser',
    source: 'bundled',
    description:
      '用应用内 AI 浏览器（隔离 WebView 工作台）打开网页并观察/操作：快照、点按、输入、滚动、截图、PC/手机视口。'
      + '涉及「浏览器 / 网页 / 打开某个站点 / 查某网站」的任务用本能力（先调用 android_capabilities 解锁），不要用 ADB 或无障碍去操作真实屏上的浏览器。',
    content: [
      '# AI 浏览器（隔离 WebView 工作台）',
      '',
      '用途：在应用内一个隔离的 WebView 里打开 http(s) 网页，像浏览器一样观察与操作。它**不是** ADB 或无障碍通道。',
      '',
      '## 先解锁',
      '`browser_*` 工具默认不在工具列表里：先调用 `android_capabilities`（group=browser）。',
      '',
      '## 工作流',
      '1. `browser_open {url}` 打开；`browser_set_viewport` 改 CSS 视口（分辨率=网页看到的 innerWidth），`browser_set_identity` 切 PC/手机身份。',
      '2. `browser_snapshot` 取页面语义节点与 `ref`；再 `browser_click {ref}` / `browser_type {ref, text}` / `browser_press {key}`。',
      '3. `ref` 只在同一次 snapshot 的代次内有效；页面变化后重新 snapshot（过期 ref 会被拒绝）。',
      '4. `browser_screenshot` 看渲染结果；`browser_get_text {ref}` 读文本。',
      '',
      '## 约束',
      '- 只允许 http(s) 顶层导航；本机回环与 file/content/data 一律拒绝。',
      '- 模型调用只导航、不改变可见性；界面由用户在侧栏查看。页面保活（侧栏收起 / 切页不销毁）。',
      '- 不要用 `android_ui_dump` / `android_shell_exec` 去截屏或点真实屏里的浏览器 App：那与隔离浏览器工作台是两回事。',
    ].join('\n'),
  },
  {
    name: 'android-virtual-display',
    source: 'bundled',
    description: '创建/销毁虚拟屏（Shizuku 特权通道），让第三方 App 在独立屏幕运行，不挤占用户前台。需要先 android_capabilities 解锁。',
    content: [
      '# 虚拟屏',
      '',
      '- 设备工具默认不在工具列表里：先调用 `android_capabilities`（group=virtual-display）解锁。',
      '- `android_vdisplay_create` 建屏（编号 1..N，本版上限 1）；`android_vdisplay_destroy` 销毁；`android_vdisplay_status` 看状态与编号。',
      '- 型号参数跟随真机比例 + 档位缩放（原生 / 0.75 / 0.5），档位在设置页可配。',
      '- 虚拟屏随内容旋转；查看器与浮窗按内容比例呈现。',
      '- 语义树/ref 动作需要无障碍；纯 Shizuku 只能坐标（`actionMode: "coordinate"`）。',
    ].join('\n'),
  },
]

/**
 * 通道就绪度（facade 如实汇报，避免模型误判「没解锁」或盲目建屏）。
 *
 * `shizuku` 是**三态**（0.14.1 设备实测缺陷 A1）：`true` 就绪 / `false` 已实测未就绪 /
 * 缺席 = **尚未探测到**。壳侧 caps 只随控制 op 的回执抵达，冷启动首次询问必然缺席；
 * 旧实现把它折成 `false` 并渲染「未就绪（虚拟屏建屏需要它）」，模型据此放弃了一个**当时可用**的能力。
 * 纪律：**「未知」不得渲染成「未就绪」**，也不得阻止模型尝试（见 {@link shizukuLine}）。
 */
export interface ChannelFacts {
  a11y: boolean
  shizuku?: boolean
}

/**
 * Shizuku 通道的**三分文案**（A1 的判据面）。
 *
 * 「未知」这一支刻意给出可执行动作：直接调创建工具试一次——成功即证明通道可用，
 * 失败再据结构化 code 判断。旧文案让模型在真正尝试之前就自我否决。
 */
export function shizukuLine(ready: boolean | undefined): string {
  if (ready === true) return '就绪（shell 执行 / 原图截图 / 虚拟屏经 Shizuku UserService 承载）'
  if (ready === false) {
    return '未就绪（已实测：壳侧回执明确报告特权通道不可用；**虚拟屏建屏需要它**，'
      + '请让用户在设置页「手机控制」里连接 Shizuku）'
  }
  return '状态未知（壳侧尚未回执，本次补探也没拿到；**这不等于不可用**——不要据此判定虚拟屏不可用）。'
    + '直接调 android_vdisplay_create 试一次：成功即通道可用；失败再看它回的 code/guidance，'
    + '或用 android_privilege_status、设置页「手机控制」看实测状态'
}

/** 把 Android 设备能力组做成渐进披露：常驻 facade + agent 作用域掩蔽 + skill 目录条目。 */
export function installCapabilityGate(
  ctx: CapabilityGateCtx,
  channels: () => ChannelFacts | Promise<ChannelFacts> = () => ({ a11y: false }),
): void {
  const locks = new WeakMap<object, Map<string, ScopedFiber>>()
  const locksOf = (agent: unknown): Map<string, ScopedFiber> | undefined =>
    agent === null || agent === undefined ? undefined : locks.get(agent as object)

  const lockAgent = (agent: unknown): void => {
    if (agent === null || agent === undefined) return
    const scoped = (agent as { ctx?: { inject?: (deps: string[], cb: (c: unknown) => void) => ScopedFiber } }).ctx
    if (typeof scoped?.inject !== 'function') return
    let perAgent = locksOf(agent)
    if (perAgent === undefined) {
      perAgent = new Map()
      locks.set(agent as object, perAgent)
    }
    // 按组分别掩蔽（而不是一条 deny 全组）：facade 才能精确解锁并如实回报剩余状态。
    for (const [group, names] of Object.entries(DEVICE_TOOL_GROUPS)) {
      if (perAgent.has(group)) continue
      try {
        const fiber = scoped.inject(['tools'], (scopedCtx: unknown) => {
          const tools = (scopedCtx as { tools?: { restrict?: (filter: { deny: string[] }) => unknown } }).tools
          if (typeof tools?.restrict !== 'function') return
          tools.restrict({ deny: [...names] })
        })
        perAgent.set(group, fiber)
      } catch (error) {
        // 未知工具名（该组未注册）等 → 该组不掩蔽，保持今天的可见性（fail-open，不静默吞工具）。
        ctx.logger?.warn?.('capability gate: group lock skipped (' + group + '): ' + String((error as Error)?.message ?? error))
      }
    }
  }

  /** 解除请求组的掩蔽；返回本次解锁的组与仍未解锁的组。 */
  const unlock = (group: string, agent: unknown): { unlocked: string[]; locked: string[] } => {
    const requested = group === 'all' ? Object.keys(DEVICE_TOOL_GROUPS) : [group]
    const perAgent = locksOf(agent)
    const unlocked: string[] = []
    for (const name of requested) {
      if (DEVICE_TOOL_GROUPS[name] === undefined) continue
      const fiber = perAgent?.get(name)
      if (fiber === undefined) continue
      try {
        void fiber.dispose()
      } catch {
        /* 已解锁或宿主已释放 */
      }
      perAgent?.delete(name)
      unlocked.push(name)
    }
    const locked = Object.keys(DEVICE_TOOL_GROUPS).filter((name) => perAgent?.has(name) === true)
    return { unlocked, locked }
  }

  try {
    ctx.tools.register(capabilityTool(unlock, channels))
  } catch (error) {
    ctx.logger?.warn?.('capability gate: facade registration failed: ' + String((error as Error)?.message ?? error))
    return
  }

  const agents = ctx.get?.('agents') as { list?(): unknown[] } | undefined
  for (const agent of agents?.list?.() ?? []) lockAgent(agent)
  ctx.on?.('agent/created', ({ agent }) => { lockAgent(agent) })

  const skills = ctx.get?.('skills') as { register?(skill: unknown): unknown } | undefined
  for (const skill of CAPABILITY_SKILLS) {
    try {
      skills?.register?.(skill)
    } catch (error) {
      ctx.logger?.warn?.('capability gate: skill registration failed: ' + String((error as Error)?.message ?? error))
    }
  }
}


/**
 * 常驻 facade 工具：列出可用能力组并解锁本次会话的设备工具。
 * @param unlock - 解除调用方 agent 指定组的掩蔽；返回本次解锁与仍锁定的组。
 * @param channels - 无障碍 / Shizuku 就绪度，供模型判断能否建屏。
 */
export function capabilityTool(
  unlock: (group: string, agent: unknown) => { unlocked: string[]; locked: string[] },
  channels: () => ChannelFacts | Promise<ChannelFacts>,
) {
  return defineTool({
    name: CAPABILITY_TOOL_NAME,
    description:
      '解锁并列出本机的 Android 设备能力组（phone 手机控制 / browser AI 浏览器 / virtual-display 虚拟屏）。'
      + '对应工具默认不出现在工具列表中：先调用本工具，下一步起这些工具才可用。'
      + '涉及手机操作、App、浏览器、网页、虚拟屏的任务，先调本工具。',
    parameters: {
      group: { type: 'string', description: '要解锁的能力组：phone | browser | virtual-display | all（默认 all）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          unlocked: { type: 'array', required: true },
          locked: { type: 'array', required: true },
          groups: { type: 'array', required: true },
          channels: { type: 'object', required: true, additionalProperties: false, properties: { a11y: { type: 'boolean' }, shizuku: { type: 'boolean' } } },
          // 注：`channels.shizuku` 缺席即「尚未探测到」（三态，见 ChannelFacts）——不是 false。
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value: Record<string, unknown>) => [{ type: 'text', text: String(value.text ?? '') }],
    },
    execute: async ({ group = 'all' }: { group?: string }, exec: unknown) => {
      const agent = (exec as { agent?: unknown } | undefined)?.agent
      const { unlocked, locked } = unlock(typeof group === 'string' ? group : 'all', agent)
      let facts: ChannelFacts = { a11y: false }
      try {
        // 通道事实可能来自一次**补探**（A1：caps 缺席时引擎主动发一次 vdInfo），故此处可 await。
        facts = await channels()
      } catch {
        facts = { a11y: false }
      }
      const groups = Object.entries(DEVICE_TOOL_GROUPS).map(([name, tools]) => ({
        group: name,
        tools: tools.length,
        state: locked.includes(name) ? 'locked' : 'visible',
      }))
      const head = unlocked.length > 0
        ? `已解锁：${unlocked.join('、')}。对应工具将从下一步起出现在工具列表。`
        : locked.length === 0
          ? '全部能力组均已解锁，工具已可用。'
          : '请求的组此前已解锁（无需重复解锁）。'
      const stateLines = groups.map((g) => `- ${g.group}：${g.state === 'locked' ? '未解锁' : '可用'}（${g.tools} 个工具）`)
      const channelLines = [
        `- 无障碍通道：${facts.a11y ? '已开启（语义树 / ref 动作 / 虚拟屏语义树可用）' : '未开启（只能走 Shizuku 或坐标面）'}`,
        `- Shizuku 特权通道：${shizukuLine(facts.shizuku)}`,
      ]
      return {
        ok: true,
        unlocked,
        locked,
        groups,
        channels: facts,
        text: [head, '能力组：', ...stateLines, '通道：', ...channelLines,
          '用法：phone 取控件树用 android_ui_dump（无障碍开）或 android_ui_tree（无障碍关，两者同形），再 android_ui_click（ref）；'
          + 'browser 用 browser_open 后 browser_snapshot（ref）；虚拟屏用 android_vdisplay_create，再以 screenId="virtual-N" 调 phone 工具，'
          + '按键/文本用 android_vdisplay_input。',
        ].join('\n'),
      } as never
    },
  })
}
