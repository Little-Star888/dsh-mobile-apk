// verify-webview-015.mjs — 追上游 0.1.5 适配的 WebView DOM 断言（0.13.7）
// 用法：node scripts/verify-webview-015.mjs <cdp-ws-url>
// 取 ws 地址：adb forward tcp:29225 localabstract:webview_devtools_remote_<app-pid>
//             node -e "fetch('http://127.0.0.1:29225/json/list').then(r=>r.json()).then(j=>console.log(j[0].webSocketDebuggerUrl))"
// 断言项对应 docs/UPSTREAM-0.1.5-ADAPT-2026-09-10.md §4 验收清单 1/3/8 的可在页内自证部分。
//
// 形态判据（2026-09-24 修）：本脚本一律按「页内实测 viewport」判形态，不按 --wide 形参。
// 页面自判手机形态的唯一真源是 dsh-client-ui-responsive/src/client/mobile/form-marker.ts:21
// MOBILE_FORM_MAX_WIDTH = 767（镜像上游 (max-width: 767px)，见同包 keyboard-boundary.ts:48）。
// 故 innerWidth <= 767 即手机形态。--wide 只当调用者意图提示打印，不再进入任何判据：
// 旧写法用它硬编码期望「不是手机形态」，而「16384 横屏」实测跑在 freeform 浮窗里只有
// 281x522 CSS px，页面**正确地**自判为手机形态，于是断言恒红且无产品含义
// （实测 viewport 才是唯一可证伪的读点）。
const [, , wsUrl] = process.argv
const wide = process.argv.includes('--wide')
if (!wsUrl) { console.error('用法: node verify-015.mjs <ws-url> [--wide]'); process.exit(2) }

/** 手机形态宽度阈值：与页面注入层 form-marker.ts 的 MOBILE_FORM_MAX_WIDTH 同值。 */
const MOBILE_FORM_MAX_WIDTH = 767

/**
 * 形态判据的唯一写法：每条表达式自己在页内重算 mobile = innerWidth <= 767，
 * 再断言「页面形态产物」与它一致。自算而不读模块级缓存，是为了让每条断言单独可证伪
 * （改坏哪一条，就只有那一条红，不会连带把后面的判据一起带偏）。
 * @param body - 已定义 mobile 的页内语句块，须 return 一个含 mobile 的读数对象。
 * @returns 包好同一 mobile 判据的页内表达式。
 */
const formExpr = (body) => '(() => { const mobile = window.innerWidth <= ' + MOBILE_FORM_MAX_WIDTH + '; ' + body + ' })()'

/**
 * 角标座位与展开键的页内读数：面板是否挂载、是否展开、corner 里有没有按钮。
 *
 * 上游 ui-sidebar-right/src/client/shell/ExpandButton.tsx:33-34 在 surface.layout.expanded
 * 为真时 return null，所以「按钮在不在」本身没有固定真值，不能当无条件断言。
 */
const CORNER_PROBE = "(() => { const c = document.querySelector('[data-conversation-header-corner]'); const p = document.querySelector('[data-sidebar-right-panel]'); return { corner: !!c, panel: !!p, open: !!(p && p.hasAttribute('data-sidebar-right-open')), button: !!(c && c.querySelector('button')) } })()"

const checks = [
  ['移动形态标记与实测 viewport 一致（判据取自页内 innerWidth，与 --wide 无关）',
    formExpr("const marked = document.documentElement.hasAttribute('data-dsh-mobile-form'); return { w: window.innerWidth, mobile, marked }"),
    (v) => !!v && typeof v.w === 'number' && v.marked === v.mobile],
  ['框架根已打标 [data-dsh-frame]', "!!document.querySelector('[data-dsh-frame]')", true],
  ['上游右栏列存在 [data-rightbar-col]', "!!document.querySelector('[data-rightbar-col]')", true],
  ['顶栏存在 [data-dsh-mobile-topbar]', "!!document.querySelector('[data-dsh-mobile-topbar]')", true],
  ['顶栏含侧栏开关按钮', "!!document.querySelector('[data-dsh-mobile-topbar] button')", true],
  ['左栏 position 与实测 viewport 形态一致（手机形态 fixed / 桌面形态非 fixed）',
    formExpr("const col = document.querySelector('[data-dsh-frame] > [class*=sidebarCol]'); return { w: window.innerWidth, mobile, position: col ? getComputedStyle(col).position : 'no-sidebar-col' }"),
    (v) => !!v && v.position !== 'no-sidebar-col' && (v.position === 'fixed') === v.mobile],
  ['拖拽手柄可见性与实测 viewport 形态一致（手机形态全 display:none；手柄缺席即红）',
    formExpr("const hs = [...document.querySelectorAll('[data-dsh-frame] [class*=handle]')]; return { w: window.innerWidth, mobile, count: hs.length, hidden: hs.length > 0 && hs.every(h => getComputedStyle(h).display === 'none') }"),
    (v) => !!v && v.count >= 1 && v.hidden === v.mobile],
  // 2026-09-24 基线实测（.deploy-tmp/0142-verify-1/probe-table.md）：corner 座位在竖屏 16416 与
  // 横屏 16384（freeform 浮窗 281x522）**都渲染**，故座位存在性两方向都判，不按 --wide 降级。
  // 判据与原「上游附件按钮未被遮蔽」同构：座位存在 + computed display !== none。
  // 不追加可见性判据：header 座位能否落在视口内由布局与滚动位置决定，它随交互漂移，
  // 判它就等于把噪点写进门禁；display:none 才是「被样式藏起来」这个真缺陷的信号。
  ['会话头部 corner 座位存在且未 display:none（两方向都判）',
    "(() => { const c = document.querySelector('[data-conversation-header-corner]'); return { present: !!c, display: c ? getComputedStyle(c).display : 'absent' } })()",
    (v) => !!v && v.present === true && v.display !== 'none' && v.display !== 'absent'],
  // 旧断言「corner 内 button 存在」之所以漂：上游 ExpandButton.tsx:33-34 在面板展开（含
  // surface 未建时的 false）之外 return null —— 有按钮即面板未展开，面板展开了按钮本就该消失。
  // 判互斥关系才有固定真值，且两方向都能非空证伪。面板未挂载时按钮同样缺席
  // （上游 RightbarSeat 在 surface 未建时返回 null 的读数由 CORNER_PROBE 的 panel 字段记下），
  // 前置 pinPanelStates() 会把本轮实测到的形态与观测序列写进它自己的结果行。
  ['右栏展开键存在性与面板展开态互斥（展开键存在 === 面板未展开）',
    CORNER_PROBE,
    (v) => !!v && v.corner === true && v.button === !v.open],
  ['我们的「在文件中打开」入口存在（两方向都判）', "!!document.querySelector('[aria-label=\"在文件中打开\"]')", true],
  ['桥 openPathChooser 已注入', "typeof window.androidBridge?.openPathChooser === 'function'", true],
  ['桥 downloadDebugLogs 已退役', "typeof window.androidBridge?.downloadDebugLogs === 'undefined'", true],
  ['桥 pickImage 已退役', "typeof window.androidBridge?.pickImage === 'undefined'", true],
  // 0.13.7fx-1：注入项整体退役（@ 文件回上游原生），这里断言它们都不再出现在菜单里
  ['菜单注入项已退役：引用本机文件 / 导出调试日志 / 上传图片（打开 add 菜单后）',
    "(async () => { const b = document.querySelector('[data-composer-card] button[aria-haspopup=\"listbox\"], [data-composer-card] button[aria-label*=\"添加\"]'); if (b) { b.click(); await new Promise(r => setTimeout(r, 250)); } const filePick = !!document.querySelector('[data-dsh-file-pick]'); const dbg = !!document.querySelector('[data-dsh-debug-log]'); const img = !!document.querySelector('[data-dsh-image-pick]'); document.body.click(); return { filePick, debugLog: dbg, imagePick: img }; })()",
    (v) => v && v.filePick === false && v.debugLog === false && v.imagePick === false],
  ['桥 pickFilePath 已退役（SAF 路径桥整链）', "typeof window.androidBridge?.pickFilePath === 'undefined'", true],
  // 原生 @ 菜单保持纯净：不许再有任何非 option 的注入按钮混进 [role=listbox]
  ['原生 @ 菜单无注入杂项（0.13.7fx-1 退役回归）',
    "(async () => { const ce = document.querySelector('[contenteditable=true]'); if (!ce) return 'no-composer'; ce.focus(); document.execCommand('insertText', false, '@'); await new Promise(r => setTimeout(r, 1500)); const m = document.querySelector('[data-trigger-menu]'); const strays = m ? [...m.querySelectorAll('button:not([role=option])')].map(e => (e.innerText || '').trim()).filter(Boolean) : []; const rows = m ? m.querySelectorAll('[role=option]').length : 0; document.execCommand('selectAll'); document.execCommand('delete'); return { menu: !!m, rows, strays }; })()",
    (v) => v === 'no-composer' || (v && (v.menu === false || (Array.isArray(v.strays) && v.strays.length === 0)))],
  // 陈旧选器修正（2026-09-24）：旧断言查 button[aria-label="添加附件"]，该字符串属**已退役**的
  // dsh-attachment-formats —— 0.1.7-rc.1 构建产物里 0 命中（实测 scripts/patches/tests/fixtures/
  // dsh-client-ui-conversation-0.1.7-rc.1/lib/client.js 全文件只有 "添加文件或调用指令"）。
  // 本代活体 label 是「添加文件或调用指令」（上游 ui-conversation/src/client/locales.ts:22
  // 'input.commands'，渲染点 skeleton/InputBar.tsx:423 aria-label），故改查活体 label，
  // 并保留原语义「存在且 display !== none」。这是换正确选器而非删断言：选器一改，遮蔽回归即可证伪。
  ['上游添加文件或调用指令按钮未被遮蔽（活体 label）',
    "(async () => { const btn = document.querySelector('button[aria-label=\"添加文件或调用指令\"]'); if (!btn) return 'absent'; return getComputedStyle(btn).display !== 'none'; })()",
    true],
  ['名册含 ui-layout 与 ui-responsive',
    "(window.__DSH_BOOT__?.entries ?? []).map(e => e.id).filter(id => id.includes('ui-layout') || id.includes('ui-responsive'))",
    (v) => Array.isArray(v) && v.length >= 2],
  // ── 0.13.7 追加：polyfill 活性 + 注入脚本可解析（2026-09-10 缺陷回归）──
  // 背景：POLYFILLS 片段曾用 join('') 装配，Set 片段结尾 `})()` 直接撞下一段 `if (` →
  // 整个 <script> 被解析器拒绝，页面 polyfill 全灭（表现为 "Iterator is not defined"），
  // 而抓 HTML 仍能看到片段文本（grep 类检查全绿）。下列断言按「页面里能不能用」判。
  ['polyfill: 全局 Iterator 可用（上游 0.1.5 客户端 import 期依赖）', "typeof Iterator !== 'undefined'", true],
  ['polyfill: Promise.withResolvers 可用（宿主 boot 就绪尾脚本依赖）', "typeof Promise.withResolvers === 'function'", true],
  ['polyfill: Object.groupBy 可用', "typeof Object.groupBy === 'function'", true],
  ['polyfill: Map.groupBy 可用', "typeof Map.groupBy === 'function'", true],
  ['polyfill: Array.fromAsync 可用', "typeof Array.fromAsync === 'function'", true],
  ['polyfill: Set.prototype.union 可用', "typeof Set.prototype.union === 'function'", true],
  ['polyfill: Set.prototype.isDisjointFrom 可用', "typeof Set.prototype.isDisjointFrom === 'function'", true],
  ['Iterator 迭代器助手可用（map/toArray 跑通）', "[1,2,3].values().map(v => v * 2).toArray().join(',')", '2,4,6'],
  ['页面内全部内联脚本可解析（装配语法回归）',
    "(() => { const bad = []; for (const s of document.querySelectorAll('script:not([src])')) { const body = s.textContent || ''; if (body.trim() === '') continue; try { new Function(body) } catch (e) { bad.push((body.slice(0, 48).replace(/\\s+/g, ' ')) + ' :: ' + e.message) } } return bad; })()",
    (v) => Array.isArray(v) && v.length === 0],
  ['documentpreview 客户端条目在场（曾被 Iterator 缺失打挂的包）',
    "(window.__DSH_BOOT__?.entries ?? []).map(e => e.id).filter(id => id.includes('documentpreview'))",
    (v) => Array.isArray(v) && v.length >= 1],
  // ── 0.14.0-preview 追加：系统返回层栈通道在场（计划 §5.1 IX-BG-01/14）──
  // 页面侧 BackStackSignal 暴露 window.__dshBack；层数/逐层类型全局是设备侧逐级返回断言的读点；
  // dshBackBridge 是壳侧同步缓存的 set/get 成对上行面（getBackAvailable 回读「层栈非空」缓存）。
  ['返回层栈入口 window.__dshBack 在场（函数）', "typeof window.__dshBack === 'function'", true],
  // 注意：层数/逐层类型只断言「类型在场」——不绑定初始值，因为本条之前的检查会打开 @ 菜单等层，
  // 层栈在读到时可能已非 0（判据是通道在场 + 层随交互变化，见后面两条交互断言）。
  ['返回层栈层数全局在场（数字）', "typeof window.__dshBackDepth === 'number'", true],
  ['返回层栈逐层类型全局在场（数组）', "Array.isArray(window.__dshBackKinds)", true],
  ['返回层栈上行桥 dshBackBridge 成对在场（set/get）',
    "typeof window.dshBackBridge?.setAvailable === 'function' && typeof window.dshBackBridge?.getBackAvailable === 'function'", true],
  // 判据：浮层必须被登记为层、且壳侧同步缓存为真（层数增减由下一条「消费」断言覆盖，避免点击幂等性带来的噪声）。
  // 形态差异只放一项：2026-09-24 两方向基线实测 —— 桌面分支没有 drawer（读数 kinds=["dialog","menu"]
  // depth=2 cached=true），手机分支有；而「点入口 → 注册成层 → 壳侧缓存为真 → 消费后层数下降」
  // 这条链两方向都成立。故只放弃 kinds.includes('drawer')，其余（depth/cached/数组在场）全判；
  // 分支取自页内实测 innerWidth，不取自 --wide（281x522 的 freeform 浮窗就是手机形态）。
  ['抽屉/浮层成为返回层且壳侧同步缓存为真（drawer 形态项仅实测手机形态判）',
    "(async () => { const sleep = (ms) => new Promise(r => setTimeout(r, ms)); const kinds = () => Array.isArray(window.__dshBackKinds) ? window.__dshBackKinds : []; const mobile = window.innerWidth <= " + MOBILE_FORM_MAX_WIDTH + "; if (mobile && !kinds().includes('drawer')) { const b = document.querySelector('[data-dsh-mobile-topbar] button'); if (!b) return 'no-topbar'; b.click(); await sleep(500); } return { mobile, depth: window.__dshBackDepth, kinds: kinds(), cached: window.dshBackBridge?.getBackAvailable?.() }; })()",
    (v) => v && v.depth >= 1 && v.cached === true && Array.isArray(v.kinds)
      && (v.mobile ? v.kinds.includes('drawer') : true)],
  ['层栈消费（__dshBack 弹出该层）→ 层数下降且壳侧缓存回读 false',
    "(async () => { const before = window.__dshBackDepth; const consumed = typeof window.__dshBack === 'function' ? window.__dshBack() : 'no-entry'; await new Promise(r => setTimeout(r, 400)); return { before, consumed, depth: window.__dshBackDepth, cached: window.dshBackBridge?.getBackAvailable?.() }; })()",
    (v) => v && v.consumed === true && v.before >= 1 && v.depth === v.before - 1 && v.cached === (v.depth > 0)],
  // ── 0.14.0-preview 追加：壳侧状态 getter 在场（计划 §4.3 ST-10/ST-11）──
  ['桥 getImmersiveMode 在场（ST-10 壳侧唯一真源）', "typeof window.androidBridge?.getImmersiveMode === 'function'", true],
  ['getImmersiveMode 返回布尔（回读壳侧偏好真值）', "typeof window.androidBridge?.getImmersiveMode?.() === 'boolean'", true],
]

const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
const results = []

/**
 * 把「面板展开态与 corner 展开键的互斥」先钉成实测形态，再交给断言判。
 *
 * 上游 ExpandButton.tsx:33-34 在 expanded 时 return null，所以按钮有无本身不是固定事实；
 * 这里不猜、不绑方向：读初态 → （有按钮时）点它展开 → 再读 → （展开态下）点收起键回到收起态 → 再读，
 * 每一步都记一份 {panel, open, button}，每次点击都记下它是否真的翻转了面板状态。
 * 返回的一行在下列条件全成立时才判绿：
 * (1) 至少观测到一次面板已挂载；(2) 至少观测到两次状态（含一次真实点击）；
 * (3) 每一次观测都满足 button === !open（收起与展开两个方向都成立）；
 * (4) 每一次点击都真的翻转了状态（点不动 = 用户开不了/收不掉面板，是真缺陷，不得静默放过）。
 * 面板未挂载（上游 RightbarSeat 在 surface 未建时返回 null，见 SidebarRight.tsx:433）时如实记账为
 * 未挂载，该形态下按钮必然缺席而互斥式恒真，故此处不判绿，避免「面板没起来」被读成通过。
 * @returns 与 checks 同构的一行 [是否通过, 标签, 读数]。
 */
async function pinPanelStates() {
  const observations = []
  const flips = []
  const observe = async () => {
    const value = await evaluate(CORNER_PROBE)
    observations.push(value)
    return value
  }
  const click = async (selector) => {
    await evaluate('(() => { const b = document.querySelector(' + JSON.stringify(selector) + '); if (b) b.click(); return !!b })()')
    await new Promise(r => setTimeout(r, 400))
  }
  const before = await observe()
  const mounted = !!before && before.panel === true
  if (mounted && before.button === true) {
    await click('[data-conversation-header-corner] button')
    const after = await observe()
    flips.push(!!after && after.open === true)
  }
  const last = observations[observations.length - 1]
  if (mounted && last && last.open === true) {
    await click('[data-sidebar-right-toggle]')
    const after = await observe()
    flips.push(!!after && after.open === false)
  }
  const agreed = observations.every(o => !!o && o.button === !o.open)
  const flipped = flips.length >= 1 && flips.every(Boolean)
  const sequence = observations.map(o => (o && o.open) ? 'expanded' : 'collapsed').join('->')
  const clicks = flips.length === 0 ? 'none' : flips.map(f => f ? 'flipped' : 'no-op').join(',')
  return [
    mounted && agreed && observations.length >= 2 && flipped,
    '面板状态固定：先钉形态再判互斥（mounted=' + mounted + '，序列 ' + sequence + '，点击 ' + clicks + '）',
    JSON.stringify(observations),
  ]
}

ws.onopen = async () => {
  const measured = await evaluate('({ width: window.innerWidth, height: window.innerHeight })')
  console.log('实测 viewport: ' + JSON.stringify(measured) + ' → 形态判据 mobile = ' + (measured && measured.width <= MOBILE_FORM_MAX_WIDTH))
  // 站点 3 的前置必须先于任何依赖面板状态的断言：它会把面板状态钉成一个确定的最终形态。
  results.push(await pinPanelStates())
  for (const [label, expression, expect] of checks) {
    const value = await evaluate(expression)
    const pass = typeof expect === 'function' ? expect(value) : value === expect
    results.push([pass, label, JSON.stringify(value)?.slice(0, 90)])
  }
  for (const [pass, label, value] of results) console.log((pass ? 'PASS ' : 'FAIL ') + label + '  → ' + value)
  const failed = results.filter(r => !r[0]).length
  console.log('\n' + (failed === 0 ? 'ALL PASS (' + results.length + ')' : 'FAILED ' + failed + '/' + results.length))
  ws.close()
  process.exit(failed === 0 ? 0 : 1)
}

function evaluate(expression) {
  return new Promise((resolve) => {
    const messageId = ++id
    pending.set(messageId, resolve)
    ws.send(JSON.stringify({ id: messageId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
}

ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const resolve = pending.get(message.id)
  if (!resolve) return
  pending.delete(message.id)
  if (message.result?.exceptionDetails) resolve('EXCEPTION: ' + JSON.stringify(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text).slice(0, 120))
  else resolve(message.result?.result?.value)
}
ws.onerror = (error) => { console.error('WS error: ' + (error?.message ?? 'unknown')); process.exit(1) }
setTimeout(() => { console.error('timeout'); process.exit(1) }, 60000)