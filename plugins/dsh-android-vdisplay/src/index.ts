/**
 * 虚拟屏（Shizuku 特权通道）宿主半 — 0.14.0 迭代「虚拟屏」线 S1。
 *
 * 职责边界（与源文档 §6.2 架构 A 对齐）：
 *  - **本插件不承载像素**。画面唯一路径是壳侧原生 `SurfaceView` 的 Surface 直接作虚拟屏输出
 *    （源文档 §9.2：禁止把像素经引擎编码→传输→WebView 解码）；右侧栏 Tab 只承载开关/状态/控制。
 *  - 宿主半做两件事：① 注册只读状态端点 `GET /api/android/vdisplay/status`（右侧栏面板的数据源）；
 *    ② 注册 `android_vdisplay_status` 工具（模型面）；两者与桥面同源（`readVdSnapshot`）。
 *
 * `vd*` 的登记是本迭代**独立批次**，不得在本文件落地：新增 op 必须一次改齐六处
 * （壳侧 `DeviceControlService.handle` / `ControlProtocolV2.SUPPORTED_OPS` / 引擎 `ControlOp` /
 * `A11Y_OPS` / `ROUTE_OPS` / manage 工具面），并通过 `scripts/check-control-ops.mjs`（差集 = 0）。
 * 两条硬约束：① `vd*` 是特权面操作，**不得**进 `A11Y_OPS`（无障碍承载不了跨屏建屏/拉应用，
 * 与源文档 §8.2「browser* 不进 A11Y_OPS」同一条推理）；② 登记同批必须跑门禁，漏一处即工具不可达（坑 52）。
 *
 * 端点鉴权口径（坑 78 + review C12）：上游路由是「exact 表先于 prefix 表」，exact 路由挂在 `/api/...` 下会
 * **绕过**该前缀的 cookie 鉴权——本端点与 ADB 授权块的 `/api/android/privilege/status` 同口径
 * （均为 exact、无令牌），载荷不含机密（只有能力状态、错误码、引导文案、op 表与虚屏 id），
 * 并带**回环 Host/Origin 栅栏**（connection 服务优先，缺服务退化为回环白名单）。
 * 一旦将来要返回任何敏感值（路径、包名清单、像素），必须自带令牌或改走受鉴权的前缀路由。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readVdSnapshot, VD_STATUS_PATH, type VdOp, type VdisplayFace } from './status.js'

export { VD_OPS, VD_STATUS_PATH, mapStatusPayload, readVdSnapshot } from './status.js'
export type { VdOp, VdPanelState, VdSnapshot, VdState, VdStatusPayload, VdisplayFace } from './status.js'

export const name = '@dsh-android/dsh-android-vdisplay'

/**
 * 必需服务：`tools`（`ctx.tools.register` 是属性访问——坑 82 同形态：未声明 inject 时 cordis
 * 取属性直接抛 "cannot get property ... without inject"，整条 loader entry 失败 → 引擎启动即死）。
 * 可选服务（`webServer` / `androidPrivilege`）一律走 `ctx.get(...)`，缺失即降级（不阻塞 fiber）。
 */
/** The status endpoint is part of this tab's contract, so load only after the web server exists.
 * `androidPrivilege` remains late-bound because the bridge provider may load later. */
export const inject = ['tools', 'webServer'] as const

/** 浏览端面用的最小 res 契约（与 bridge 的 exact 路由同口径，不 import 跨包类型）。 */
interface WsReq {
  method?: string
  url?: string
  headers?: Record<string, string | string[] | undefined>
}
interface WsRes {
  statusCode?: number
  setHeader?(name: string, value: string): void
  end(body: string): void
}

/** 回环白名单（与 dsh-android-bridge/route-auth.js 的 FALLBACK_LOOPBACK_HOSTS 同源；跨包不 import 类型）。 */
const LOOPBACK_AUTHORITIES = ['127.0.0.1:3080', 'localhost:3080'] as const

/**
 * review C12：公开只读状态路由的回环栅栏——载荷只有元数据（不要求令牌），但必须拒绝
 * 非回环 Host 与跨站请求；connection 服务的 Host/Origin 判定（403）优先，异常一律 fail-closed。
 */
function publicRouteRejected(req: WsReq, connection?: { requestRejection?(r: unknown): 401 | 403 | undefined }): boolean {
  if (connection !== undefined) {
    try {
      return connection.requestRejection?.(req) === 403
    } catch {
      return true
    }
  }
  const headerOf = (name: string): string | undefined => {
    const v = req.headers?.[name]
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined
  }
  const host = headerOf('host')?.trim().toLowerCase()
  if (host === undefined || !LOOPBACK_AUTHORITIES.some((authority) => authority === host)) return true
  if (headerOf('sec-fetch-site')?.toLowerCase() === 'cross-site') return true
  const origin = headerOf('origin')
  if (origin !== undefined && origin !== '' && !LOOPBACK_AUTHORITIES.some((authority) => origin.toLowerCase() === 'http://' + authority)) {
    return true
  }
  return false
}

/** 只读 JSON 响应。 */
function sendJson(res: WsRes, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader?.('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * 宿主半入口：注册只读状态端点与状态工具。开关未接通前不注册任何特权 op、不改任何默认路径。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx: Context): void {
  const faceOf = (): VdisplayFace | undefined => ctx.get('androidPrivilege') as VdisplayFace | undefined

  ctx.tools.register(defineTool({
    name: 'android_vdisplay_status',
    description:
      '查询虚拟屏（Shizuku 特权通道）的能力与运行状态：开关、fail-closed 探测结果、可用 op 表、'
      + '错误码与补救指引。本工具只读、不改设备状态；返回 ok=false 时表示当前不可用（看 code/guidance），'
      + '此时仍可用真实屏控制。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          enabled: { type: 'boolean', required: true },
          state: { type: 'string', required: true },
          code: { type: 'string', required: true },
          guidance: { type: 'string', required: true },
          ops: { type: 'array', required: true, items: { type: 'string' } },
          transports: { type: 'array', items: { type: 'string' } },
          displayId: { type: 'integer' },
          selected: { type: 'string' },
          screens: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true },
                displayId: { type: 'integer', required: true },
                kind: { type: 'string', required: true },
                label: { type: 'string', required: true },
                state: { type: 'string', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                densityDpi: { type: 'integer', required: true },
                selectable: { type: 'boolean', required: true },
                reason: { type: 'string', required: true },
                viewerId: { type: 'string' },
              },
            },
          },
          text: { type: 'string' },
        },
      },
      render: (_args, v: Record<string, unknown>) => [{ type: 'text', text: String(v.guidance ?? '') }],
    },
    execute: async () => {
      const snap = readVdSnapshot(faceOf())
      return { ...snap, text: snap.ok ? snap.guidance : '虚拟屏不可用：' + snap.code + '。' + snap.guidance }
    },
  }))

  /** 会话键：生命周期 op 一律带归属会话，壳侧据此做单实例归属校验（0.14.0）。 */
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
   * AI 自主建屏：把 vd* 生命周期 op 经控制队列投递给壳侧（neverA11y 的壳桥 op 借队列投递）。
   * 失败一律结构化（ok:false + 稳定 code/guidance），从不静默，也不在工具层猜测壳侧状态。
   */
  const callVdOp = async (op: VdOp, timeoutMs: number, session?: string): Promise<Record<string, unknown>> => {
    // **必须以服务对象为接收者调用**（0.14.0 设备实锤：Agent 全工具扫描揪出）。
    //
    // 错误写法（曾存在）：先 const controlExec = faceOf()?.controlExec，再 controlExec(op, ...)。
    // 把方法从服务对象上摘下来原地调用会丢 this，于是 AndroidPrivilegeService.controlExec 内部的
    // this.controlQueue 变成 undefined.controlQueue，抛
    //   Cannot read properties of undefined (reading 'controlQueue')
    // 并被下面的 catch 包成 vdisplay-control-exception。现象：android_vdisplay_create/destroy 恒失败，
    // 而**壳侧桥直接调用同一 op 完全正常**——这正是区分「工具层缺陷」与「壳侧缺陷」的关键证据。
    //
    // 与客户端侧坑 108（@JavascriptInterface 方法不得裸调）同源：凡方法依赖 this，就不得摘出来裸调。
    const service = faceOf()
    if (service?.controlExec === undefined) {
      return {
        ok: false,
        code: 'vdisplay-control-unavailable',
        guidance: '引擎侧桥服务（androidPrivilege）未装配：无法经控制队列调用 ' + op + '。',
      }
    }
    try {
      const reply = await service.controlExec(op, session === undefined ? {} : { session }, timeoutMs)
      if (reply === null || typeof reply !== 'object' || reply.ok !== true) {
        const message = typeof reply?.error === 'string' && reply.error !== ''
          ? reply.error
          : op + ' 调用失败（控制队列未返回结果）。'
        return { ok: false, code: 'vdisplay-op-failed', guidance: message }
      }
      const data = (reply.data ?? {}) as Record<string, unknown>
      if (data.ok === false) {
        return {
          ok: false,
          code: typeof data.reason === 'string' && data.reason !== '' ? data.reason : 'vdisplay-op-rejected',
          guidance: typeof data.guidance === 'string' && data.guidance !== '' ? data.guidance : op + ' 被拒绝。',
        }
      }
      const out: Record<string, unknown> = {
        ok: true,
        code: 'vdisplay-ok',
        guidance: typeof data.guidance === 'string' ? data.guidance : '',
        state: typeof data.state === 'string' && data.state !== '' ? data.state : 'ready',
      }
      if (typeof data.displayId === 'number') out.displayId = data.displayId
      return out
    } catch (e) {
      return { ok: false, code: 'vdisplay-control-exception', guidance: '控制通道异常：' + String((e as Error).message) }
    }
  }

  /** 生命周期工具的输出 schema/渲染（两工具同形：ok + code + guidance + state + displayId?）。 */
  const lifecycleOutput = (verb: string) => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        code: { type: 'string', required: true },
        guidance: { type: 'string', required: true },
        state: { type: 'string' },
        displayId: { type: 'integer' },
      },
    },
    render: (_args: unknown, v: Record<string, unknown>) => [{
      type: 'text',
      text: verb + (v.ok === true ? '成功' : '失败')
        + '（code=' + String(v.code ?? '')
        + (typeof v.displayId === 'number' ? '，displayId=' + String(v.displayId) : '')
        + (typeof v.state === 'string' ? '，state=' + v.state : '')
        + '）：' + String(v.guidance ?? ''),
    }],
  })

  ctx.tools.register(defineTool({
    name: 'android_vdisplay_create',
    description:
      '创建（或复用已存在的）虚拟屏并让 AI 于其上工作。Shizuku 特权通道、幂等；成功后右侧栏自动露出'
      + '「虚拟屏」查看器，真实屏不受影响。失败时返回结构化 code/guidance（能力缺项、通道未就绪等），'
      + '此时请用 android_vdisplay_status 复核，不要假设屏幕已存在。',
    parameters: {},
    output: lifecycleOutput('虚拟屏创建') as never,
    execute: async (_args: unknown, exec: unknown) => callVdOp('vdCreate', 45_000, sessionOf(exec)) as never,
  }))

  ctx.tools.register(defineTool({
    name: 'android_vdisplay_destroy',
    description:
      '销毁当前虚拟屏及其上的任务（Shizuku 特权通道）。幂等：不存在时也返回成功形态；'
      + '调用前应确认虚拟屏上没有任何未保存的用户工作。',
    parameters: {},
    output: lifecycleOutput('虚拟屏销毁') as never,
    execute: async (_args: unknown, exec: unknown) => callVdOp('vdDestroy', 30_000, sessionOf(exec)) as never,
  }))

  // 右侧栏面板的数据源（只读；与工具面同源）。webServer 服务缺席时只告警：面板会走
  // "状态源不可达 → blocked"，不影响引擎启动，也不假装可用。
  // 可选服务一律走 ctx.get（不 inject）：属性访问 ctx.webServer 在未声明 inject 时会抛
  // cannot get property "webServer" without inject——与 tools 同一条 cordis 规则（坑 82）。
  const wsvc = ctx.get('webServer') as { register(r: unknown): void } | undefined
  if (!wsvc) {
    ctx.logger?.('dsh-android-vdisplay')?.warn?.('webServer 服务缺席——状态端点未注册（面板将显示 blocked）')
    return
  }
  const publicRouteConnection = (() => {
    try {
      return ctx.get('connection') as { requestRejection?(r: unknown): 401 | 403 | undefined } | undefined
    } catch {
      return undefined
    }
  })()
  wsvc.register({
    kind: 'exact',
    path: VD_STATUS_PATH,
    handler: async (req: WsReq, res: WsRes) => {
      if (req.method !== undefined && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, code: 'vdisplay-method-not-allowed' })
        return
      }
      // review C12：公开只读 ≠ 无栅栏——非回环 Host/跨站请求在读取任何状态前拒绝。
      if (publicRouteRejected(req, publicRouteConnection)) {
        res.statusCode = 403
        res.setHeader?.('cache-control', 'no-store')
        res.end('')
        return
      }
      sendJson(res, 200, readVdSnapshot(faceOf()))
    },
  })
}
