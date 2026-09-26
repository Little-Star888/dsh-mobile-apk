/**
 * 九键条的**落点与布局接线**（自有注入层，不动上游任何文件）。
 *
 * ## 为什么是 DOM 注入而不是 slot
 *
 * 上游把侧边栏面板做成**一个 key 一个 slot 条目**（sidebar.right.pane.tab 是 keyed，
 * ui-sidebar-right/src/client/index.ts:190），且**没有任何 pane 底部槽**（0.14.2 方案 §1 枚举：
 * 该域只有 pane.tab / pane.tab.title / tab.menu.item / tab.guide / tab.guide.entry）。
 * 想加「终端 tab 内、终端下方」的一排键，slot 面做不到：同 key 再注册会**顶掉**终端的 body。
 *
 * 因此采用**受管 DOM 注入**：把键条作为 [data-sidebar-terminal]（上游 .root）的**最后一个子元素**
 * 插入。这一步同时白拿「不遮挡」的硬约束：
 *   - 上游 .root 是 display:flex; flex-direction:column; height:100%; min-height:0；
 *   - 上游 .screen 是 flex:1; min-height:0（terminal.module.css）；
 *   - 键条自己 flex:none。
 *   => 终端底边不超过键条顶边 是**布局不变量**，不是靠调数值凑出来的（防形态 B）。
 *
 * ## 为什么需要 MutationObserver
 *
 * .root 的 React 子节点列表会随状态变化（status / error / empty 分支增删），React 重建子列表时
 * 可能把我们手动插入的节点摘掉。因此注入是**幂等 + 自愈**的：观察 .root 的子列表，发现键条不在
 * 末尾就重新挂回。这与本插件既有的 watchStageVisibility（同仓 client/index.ts）是同一套
 * 「DOM 是外部真源、用观察者收敛」的做法。
 *
 * ## 三条不遮挡不等式怎么落地（判据 §3.6）
 *
 *   1. terminal.bottom <= keybar.top   -- 由「键条在流内、是 .root 最后一个 flex:none 子项」保证；
 *   2. keybar.bottom   <= imeTop       -- 由键条的 padding-bottom = IME inset 保证；
 *   3. terminal.bottom <= imeTop       -- 由 (1)+(2) 传递保证。
 *
 * 本模拟器壳侧 IME 高度**恒为 0**（0.14.2 方案 §2.4 实测），所以必须自行兜 visualViewport：
 * 同时监听 resize **与** scroll（keyboard-boundary.ts 的既有结论：只监听 resize 会漏掉
 * offsetTop 变化）。
 */

/** 上游终端根节点的选择器（布局宿主；键条与让开 IME 的留白都挂在它上面）。 */
export const TERMINAL_ROOT_SELECTOR = '[data-sidebar-terminal]'
/** 键条的 DOM 标记（CDP 断言与自愈观察都用它定位）。 */
export const KEYBAR_ATTR = 'data-terminal-keybar'
/** 提示面的 DOM 标记（不支持组合 / 唤起失败）。 */
export const KEYBAR_NOTICE_ATTR = 'data-terminal-keybar-notice'
/** 键条 CSS 注入的一次性 style 元素 id。 */
export const KEYBAR_STYLE_ID = 'dsh-terminal-keybar-style'
/** 键条的 CSS 变量名（底部留白，由 JS 写入）。 */
export const KEYBAR_INSET_VAR = '--dsh-terminal-keybar-inset'

/**
 * 计算键条需要承担的**底部留白**（纯函数，可单测）。
 *
 * 取四条来源的最大值，与 composer-insets.css.ts 同源口径：
 *  - safeAreaBottom：env(safe-area-inset-bottom)（调用方从计算样式读，读不到给 0）；
 *  - shellSystemBottom：壳侧 --dsh-android-system-bottom（手势/导航条高度）；
 *  - shellImeBottom：壳侧 --dsh-android-ime-bottom（软键盘高度）；
 *  - visualViewport 收缩量：布局视口高 - 视觉视口高。
 *
 * 为什么要对 IME 取 max：壳侧推送在本模拟器恒 0（实测），只信它会得到 0，从而出现形态 A/C；
 * 而 visualViewport 是浏览器自己算的，键盘弹出时 height 会真的变小。两者取大即「谁更保守听谁的」。
 *
 * @param input - 四条原始读数（像素；未知给 0）。
 * @returns 底部留白像素（非负）。
 */
export function computeBottomInset(input: {
  readonly safeAreaBottom: number
  readonly shellSystemBottom: number
  readonly shellImeBottom: number
  readonly visualViewportHeight: number
  readonly layoutViewportHeight: number
}): number {
  const finite = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)
  const safe = finite(input.safeAreaBottom)
  const system = finite(input.shellSystemBottom)
  const imeFromShell = finite(input.shellImeBottom)
  // visualViewport 收缩量 = 布局视口高 - 视觉视口高；为负（放大）时按 0。
  const imeFromViewport = Math.max(0, finite(input.layoutViewportHeight) - finite(input.visualViewportHeight))
  return Math.max(safe, system, imeFromShell, imeFromViewport)
}

/** 一个矩形（视口坐标，与 getBoundingClientRect 同基准）。 */
export interface Rect {
  readonly top: number
  readonly bottom: number
}

/** 遮挡违例。 */
export interface OcclusionViolation {
  readonly rule: 1 | 2 | 3
  readonly detail: string
}

/** 三条不遮挡不等式的输入。 */
export interface OcclusionInput {
  readonly terminal: Rect
  readonly keybar: Rect
  readonly imeTop: number
}

/**
 * 判定三条不遮挡不等式（纯函数，供 CDP 层断言复用，见判据 §3.6）。
 *
 * 反证（测试覆盖）：任一条单独越界都必须被抓到；三者全好时返回空数组。
 *
 * @param rects - 终端可视底边 / 键条顶底边 / IME 顶边（视口坐标）。
 * @param epsilon - 浮点容忍（默认 0.5px；子像素舍入不应判红）。
 * @returns 违例列表，空 = 三条全部成立。
 */
export function checkOcclusion(rects: OcclusionInput, epsilon = 0.5): readonly OcclusionViolation[] {
  const violations: OcclusionViolation[] = []
  if (rects.terminal.bottom > rects.keybar.top + epsilon) {
    violations.push({ rule: 1, detail: 'terminal.bottom=' + rects.terminal.bottom + ' > keybar.top=' + rects.keybar.top })
  }
  if (rects.keybar.bottom > rects.imeTop + epsilon) {
    violations.push({ rule: 2, detail: 'keybar.bottom=' + rects.keybar.bottom + ' > imeTop=' + rects.imeTop })
  }
  if (rects.terminal.bottom > rects.imeTop + epsilon) {
    violations.push({ rule: 3, detail: 'terminal.bottom=' + rects.terminal.bottom + ' > imeTop=' + rects.imeTop })
  }
  return violations
}

/**
 * 键条样式。**底部留白是唯一的动态量**，由 JS 写 KEYBAR_INSET_VAR 驱动；
 * 其余是静态布局（流内、flex:none、横向均分九键）。
 *
 * 硬约束映射（0.14.2 真机缺陷实修后）：
 *  - flex:none                    -> 键条不参与伸缩，占据自己的高度（不叠加，防形态 B）；
 *  - 根节点 padding-bottom:inset   -> 键条底边让开 IME/手势条（防形态 A）；
 *  - display:flex + 子项 flex:1 1 0 -> 九键均分（方案 §2.5 的「均分收缩」，不换两行）。
 *
 * ## 为什么让开的空白由**终端根节点**承担，而不由键条自己承担（真机缺陷实修）
 *
 * 缺陷现场：键盘弹出时，键条在真机上被撑成一整片灰（用户原话「拉伸过度了」）。
 * 真因是让开键盘的那块空间此前由**键条自己的 padding-bottom** 承担，而 background 与
 * border-top 挂在同一个元素上 —— 于是「留给键盘的空白」被涂成了键条底色。设备读数
 * （1260x2800，dpr 3.5 = 360x800 CSS）：键条应有高 52 CSS，实测绘制高约 214 CSS。
 *
 * 活体实测（把 --dsh-android-ime-bottom 从 0 调到 298）：键条绘制高 53 -> 351（一比一增长），
 * 按钮高恒 40；同时 keybar.bottom(800) > imeTop(502) —— 键条画到键盘底下去了（rule 2 违例）。
 *
 * 修法：把 inset 挪到**键条的祖先**（终端根节点的 padding-bottom）。padding 属于承载者自己的
 * 盒子，而根节点**没有背景**（上游 terminal.module.css 的 .root 无 background），于是那块空白
 * 露出页面底色，键条自身恒为 40+6+6=52。
 * 为什么不给键条自己改 margin-bottom：提示面（KEYBAR_NOTICE_ATTR）是键条的**后继兄弟**，
 * 键条的 margin 会把提示面一起推到底部（等于让 IME 盖住提示）；由根节点承担 padding 时，
 * 提示面仍在键盘之上。根节点是 height:100% + box-sizing:border-box，故 padding-bottom 只压缩
 * 内容盒（.screen 是 flex:1，随之变矮），不改变根节点自身占位 —— rule 1/2/3 三条同时成立。
 */
export const KEYBAR_CSS: string = [
  // 让开 IME / 手势条：由**终端根节点**承担（它无背景，故露出页面底色而非键条底色）。
  TERMINAL_ROOT_SELECTOR, '{padding-bottom:var(', KEYBAR_INSET_VAR, ',0px)}',
  '[', KEYBAR_ATTR, ']{display:flex;flex:none;flex-direction:row;align-items:stretch;gap:4px;',
  'padding:6px 8px;',
  'box-sizing:border-box;border-top:1px solid var(--dsw-alias-border-l4);',
  // 0.14.2 rc.2 追版实修：此处原用一个上游 ui-theme 里**不存在**的 bg 令牌（死 token 门禁实测报出），
  // 不存在的令牌会让整条声明失效 -> 深色主题下白底白字。现取上游现存的 bg-layer-2（与下方 button 同源）。
  // 注：本注释刻意不写回那个已删令牌的字面量——该门禁扫的是全文引用，写进注释同样判红。
  'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
  '[', KEYBAR_ATTR, '] button{flex:1 1 0;min-width:0;min-height:40px;padding:0 2px;',
  'border:1px solid var(--dsw-alias-border-l4);border-radius:8px;',
  'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);',
  'font:var(--dsw-font-markdown-small);white-space:nowrap;overflow:hidden}',
  '[', KEYBAR_ATTR, '] button[data-latched="true"]{border-color:var(--dsw-alias-brand-primary);',
  'color:var(--dsw-alias-brand-primary)}',
  '[', KEYBAR_NOTICE_ATTR, ']{flex:none;margin:0;padding:4px 8px;',
  'font:var(--dsw-font-markdown-small);color:var(--dsw-alias-label-secondary);',
  'background:var(--dsw-alias-bg-layer-2);border-top:1px solid var(--dsw-alias-border-l4)}',
].join('')
