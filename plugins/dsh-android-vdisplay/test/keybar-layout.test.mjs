// 九键条：**布局几何纯函数**的回归（离线，node:test）。
//
// 这个文件守的是「不遮挡」硬约束（用户原话，不是建议）：三条不等式
//   terminal.bottom <= keybar.top / keybar.bottom <= imeTop / terminal.bottom <= imeTop
// 必须能被机器判定，且**任一条单独越界都要判红**（反证组）。
//
// 同时守「流内、不叠加」这条实现纪律：键条 CSS 必须是 flex:none，且**不得**出现
// position:fixed / absolute（那正是方案 §0.4 的形态 B：键条盖住终端最后一行）。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KEYBAR_ATTR,
  KEYBAR_CSS,
  KEYBAR_INSET_VAR,
  KEYBAR_NOTICE_ATTR,
  KEYBAR_STYLE_ID,
  TERMINAL_ROOT_SELECTOR,
  checkOcclusion,
  computeBottomInset,
} from '../src/keybar/layout.ts'

const rect = (top, bottom) => ({ top, bottom })

test('底部留白：取四源最大值（safe-area / 壳侧系统条 / 壳侧 IME / visualViewport 收缩）', () => {
  const base = { safeAreaBottom: 0, shellSystemBottom: 0, shellImeBottom: 0, visualViewportHeight: 800, layoutViewportHeight: 800 }
  assert.equal(computeBottomInset(base), 0)

  // 安全区单独生效
  assert.equal(computeBottomInset({ ...base, safeAreaBottom: 34 }), 34)
  // 壳侧系统条单独生效
  assert.equal(computeBottomInset({ ...base, shellSystemBottom: 48 }), 48)
  // 壳侧 IME 单独生效
  assert.equal(computeBottomInset({ ...base, shellImeBottom: 300 }), 300)
  // visualViewport 收缩单独生效（这正是本模拟器壳侧恒 0 时唯一能救回来的通道）
  assert.equal(computeBottomInset({ ...base, visualViewportHeight: 500 }), 300)
  // 四源并存时取最大
  assert.equal(computeBottomInset({
    safeAreaBottom: 34, shellSystemBottom: 48, shellImeBottom: 300, visualViewportHeight: 400, layoutViewportHeight: 800,
  }), 400)
})

test('底部留白：异常输入一律归 0，绝不产生负值或 NaN', () => {
  const z = { safeAreaBottom: 0, shellSystemBottom: 0, shellImeBottom: 0, visualViewportHeight: 0, layoutViewportHeight: 0 }
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -50]) {
    assert.equal(computeBottomInset({ ...z, shellImeBottom: bad }), 0, '壳侧 IME=' + String(bad))
    assert.equal(computeBottomInset({ ...z, safeAreaBottom: bad }), 0, '安全区=' + String(bad))
  }
  // 视觉视口比布局视口**大**（页面缩放）时收缩量按 0，不得变成负留白。
  assert.equal(computeBottomInset({ ...z, visualViewportHeight: 1000, layoutViewportHeight: 800 }), 0)
  // NaN 参与 max 会污染结果，必须已被 finite() 拦掉。
  assert.equal(Number.isFinite(computeBottomInset({ ...z, visualViewportHeight: Number.NaN, layoutViewportHeight: Number.NaN })), true)
})

test('三条不等式全好时零违例（含恰好相切）', () => {
  const good = { terminal: rect(0, 700), keybar: rect(700, 760), imeTop: 760 }
  assert.deepEqual(checkOcclusion(good), [])

  // 恰好相切（浮点相等）也不得判红。
  const tangent = { terminal: rect(0, 700), keybar: rect(700, 760), imeTop: 760 }
  assert.deepEqual(checkOcclusion(tangent), [])

  // 子像素舍入（0.4px 重叠）在默认 epsilon 内不判红。
  assert.deepEqual(checkOcclusion({ terminal: rect(0, 700.4), keybar: rect(700, 760), imeTop: 760 }), [])
})

test('反证：三条不等式**各自单独**越界都必须判红（缺一条就等于没守）', () => {
  // 规则 1：键条盖住终端最后一行（形态 B）——其余两条故意保持良好。
  const rule1 = checkOcclusion({ terminal: rect(0, 720), keybar: rect(700, 760), imeTop: 900 })
  assert.deepEqual(rule1.map((v) => v.rule), [1])
  assert.match(rule1[0].detail, /terminal\.bottom/)

  // 规则 2：键条被 IME 盖住（形态 A）——终端仍高于键条，规则 1 不触发。
  const rule2 = checkOcclusion({ terminal: rect(0, 700), keybar: rect(700, 780), imeTop: 760 })
  assert.deepEqual(rule2.map((v) => v.rule), [2])

  // 规则 3：终端被 IME 盖住（形态 C）——键条本身没事，但终端越了 IME。
  const rule3 = checkOcclusion({ terminal: rect(0, 780), keybar: rect(700, 760), imeTop: 760 })
  assert.deepEqual(rule3.map((v) => v.rule).sort(), [1, 3])

  // 三条同时越界：三条都要报出来（不得短路成一条）。
  const all = checkOcclusion({ terminal: rect(0, 900), keybar: rect(800, 950), imeTop: 760 })
  assert.deepEqual(all.map((v) => v.rule).sort(), [1, 2, 3])
})

test('反证：epsilon 不会把真实违例吃掉（越界必须远大于容忍）', () => {
  // 1px 越界：默认 epsilon=0.5 时判红；显式放宽到 2 则不判红 —— 证明 epsilon 是唯一开关。
  const onePx = { terminal: rect(0, 701), keybar: rect(700, 760), imeTop: 900 }
  assert.deepEqual(checkOcclusion(onePx).map((v) => v.rule), [1])
  assert.deepEqual(checkOcclusion(onePx, 2), [])
})

test('键条 CSS：必须在文档流内（flex:none），且**禁止** fixed/absolute 叠加', () => {
  assert.ok(KEYBAR_CSS.includes('flex:none'), '键条必须 flex:none 才不参与伸缩')
  // 形态 B 的唯一防线：不得出现定位叠加。
  assert.equal(/position\s*:\s*(fixed|absolute)/u.test(KEYBAR_CSS), false,
    '键条不得 fixed/absolute 叠加到终端上（形态 B）')
  // 九键均分（方案 §2.5 均分收缩，不换两行）。
  assert.ok(KEYBAR_CSS.includes('flex:1 1 0'), '九键应均分收缩')
  assert.equal(/flex-wrap\s*:\s*wrap/u.test(KEYBAR_CSS), false, '不得换行（用户口径「九键一屏」）')
  // 底部留白由 CSS 变量驱动（不是写死像素）。
  assert.ok(KEYBAR_CSS.includes(KEYBAR_INSET_VAR), '底部留白必须由 ' + KEYBAR_INSET_VAR + ' 驱动')
})

test('选择器与标记：CDP 断言用得到，且不得与上游既有标记冲突', () => {
  assert.equal(KEYBAR_ATTR, 'data-terminal-keybar')
  assert.equal(KEYBAR_NOTICE_ATTR, 'data-terminal-keybar-notice')
  assert.equal(TERMINAL_ROOT_SELECTOR, '[data-sidebar-terminal]')
  assert.equal(KEYBAR_STYLE_ID, 'dsh-terminal-keybar-style')
  // 我们的标记必须是 data- 前缀新属性，不得复用上游的 data-sidebar-terminal（那会自愈循环）。
  assert.notEqual(KEYBAR_ATTR, 'data-sidebar-terminal')
})

test('源码门禁：接线层不得把键位序列写在布局模块里', () => {
  const path = fileURLToPath(new URL('../src/keybar/layout.ts', import.meta.url))
  const source = readFileSync(path, 'utf8')
  for (const sequence of ['\\u001b[A', '\\u001bOA', '\\u0003']) {
    assert.equal(source.includes(sequence), false, '布局模块不得含键位序列: ' + sequence)
  }
})

// ── 0.14.2 真机缺陷实修：让开的留白不得画成键条底色 ─────────────────────────────
//
// 缺陷现场（用户原话「拉伸过度了」）：键盘弹出时键条在真机被撑成一整片灰。
// 设备读数（1260x2800，dpr 3.5 = 360x800 CSS）：键条应有高 52 CSS，实测绘制高约 214 CSS；
// 活体实测把 --dsh-android-ime-bottom 从 0 调到 298，键条绘制高 53 -> 351（一比一增长）。
//
// 真因：让开键盘的留白此前由**键条自己的 padding-bottom** 承担，而 background/border-top
// 挂在同一元素上 —— 「留给键盘的空白」被涂成键条底色。
//
// 修法：留白改由**终端根节点**的 padding-bottom 承担（根节点无背景 -> 露出页面底色）。

test('反证：让开的留白**不得**由键条自己的 padding 承担（真机灰板缺陷的形态）', () => {
  // 键条规则块里不得再出现 padding-bottom 引用留白变量 —— 那正是被涂成一大片灰的写法。
  const barRule = KEYBAR_CSS.slice(KEYBAR_CSS.indexOf(KEYBAR_ATTR + ']{'), KEYBAR_CSS.indexOf('] button'))
  assert.equal(
    /padding-bottom[^;}]*'?\s*,?\s*KEYBAR_INSET_VAR/u.test(barRule) ||
      barRule.includes('calc(6px + var(' + KEYBAR_INSET_VAR),
    false,
    '键条不得用 padding-bottom 承担留白（会把自己的底色涂满让开区，真机灰板）',
  )
  // 更强的一条：键条规则块里不得出现 KEYBAR_INSET_VAR 本身。
  assert.equal(
    barRule.includes(KEYBAR_INSET_VAR), false,
    '留白变量必须由终端根节点消费，不得出现在键条自己的规则块里',
  )
})

test('让开的留白由终端根节点的 padding-bottom 承担（根节点无背景 -> 露页面底色）', () => {
  const expected = TERMINAL_ROOT_SELECTOR + '{padding-bottom:var(' + KEYBAR_INSET_VAR + ',0px)}'
  assert.ok(
    KEYBAR_CSS.includes(expected),
    '必须由根节点承担留白，实际 CSS 片段: ' + KEYBAR_CSS.slice(0, 120),
  )
  // 键条自身只有静态的 6px 上下内边距（40 按钮 + 6 + 6 = 52），不含动态量。
  assert.ok(
    KEYBAR_CSS.includes('[', KEYBAR_ATTR, ']{display:flex;flex:none;flex-direction:row;align-items:stretch;gap:4px;', 'padding:6px 8px;'),
    '键条本体的内边距必须是静态 6px 8px（不含 inset）',
  )
})
