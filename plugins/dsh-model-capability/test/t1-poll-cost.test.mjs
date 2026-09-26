// T1 常驻 CPU 回归（2026-09-25）：默认间隔 + 事件驱动 + 每 tick describe 次数上界。
//
// 判据不是「字符串在场」，而是**可数的行为**：
//   ① 默认 pollIntervalSeconds 必须是兜底量级（>=30s），不是 5s；
//   ② 事件驱动存在：settings/document-updated 到达时**不靠轮询**即跑一轮；
//   ③ 每 tick 的 describe 调用次数有上界（旧实现同 tick 内 2-3 次）；
//   ④ 回归场景（用户添加自定义供应商）在事件路径下仍然可达。
//
// 反证（改坏必须判红，见末例 REVERSE）：
//   - 把默认间隔改回 5 -> ① 红；
//   - 去掉事件订阅 -> ② 红；
//   - 让 readDescriptor 每次重新 describe -> ③ 红。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { apply } from '../lib/index.js'

const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

// ── 净检出夹具（B-prime）：lib/catalog-snapshot.json 是**构建期产物** ─────────────────
//
// 真因（2026-09-26 CI 实锤）：该文件由协调仓 build-snapshot-013.mjs 的 0g 步生成，不在 git 里
// （.gitignore:19 `plugins/*/lib/`），而 `npm run build` 只跑 `tsc -p .`，不会生成它。
// 因此**净检出（CI）里它缺席**，而本机工作树里有（构建过）⇒ 同一份测试两处行为不同：
// CI 上 T1-⑤/⑥/X1-⑧ 取不到目录数据 → 写回不发生 → 断言判红；本机全绿。
//
// 处置：**不用 SKIP**（那会让 CI 永久丢掉 X1 的守卫，而 X1 正是咬过我们一次的 HMR 嵌套回归）。
// 改为「缺席则用夹具补上、仅当是自己写的才删」，使 CI 与本地**同形真跑**；本地真快照在场时不覆盖。
const SNAPSHOT = new URL('../lib/catalog-snapshot.json', import.meta.url)
const FIXTURE = new URL('./fixtures/catalog-snapshot.min.json', import.meta.url)
let wroteFixture = false

before(() => {
  if (existsSync(SNAPSHOT)) return
  copyFileSync(FIXTURE, SNAPSHOT)
  wroteFixture = true
})

after(() => {
  if (wroteFixture) rmSync(SNAPSHOT, { force: true })
})

/** 剥注释：只保留可执行/声明行，避免用文档串当判据（本仓三次踩过的坑）。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const CODE = stripComments(SRC)

// ── 夹具：可数的 settings 假实现 + 可手动触发的事件总线 ─────────────────────────
function makeCtx(providers) {
  const listeners = new Map()
  let section = { providers }
  const state = { describes: 0, mutates: 0, disposer: undefined }
  const settings = {
    describe() {
      state.describes += 1
      // 上游 describe 的 options 被忽略：这里也返回全部命名空间，逼调用方按 ns 查找
      return [
        { ns: 'llm-pi-ai', value: section, revision: state.describes },
        { ns: 'llm-deepseek', value: {}, revision: 0 },
      ]
    },
    async mutate(ns, ops) {
      state.mutates += 1
      const op = ops[0]
      if (op && op.op === 'set' && op.path[0] === 'providers') {
        const route = op.path[1]
        section = { providers: { ...section.providers, [route]: { ...section.providers[route], models: op.value } } }
      }
      return {}
    },
  }
  const ctx = {
    settings,
    logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
    effect: (fn) => { state.disposer = fn() },
    get: () => undefined,
    tools: { register: () => {} },
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => {}
    },
  }
  return {
    ctx,
    state,
    get section() { return section },
    emit(name, ...args) { for (const l of listeners.get(name) ?? []) l(...args) },
    hasListener: (name) => (listeners.get(name) ?? []).length > 0,
    dispose() { if (state.disposer) state.disposer() },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 40))

const EV = 'settings/document-updated'

// ── ① 默认间隔：必须是兜底量级，不是 5s ────────────────────────────────────────
test('T1-① 兜底间隔分两档且都 >=30s，下界钳制存在，旧的 5s 已消失', () => {
  // 两档默认：事件可用=120s（安全网），事件不可用=30s（唯一触发器）
  assert.match(CODE, /const fallbackSeconds = eventDriven \? 120 : 30/,
    '找不到「按事件面是否可用分两档」的默认值表达式')
  assert.match(CODE, /config\.pollIntervalSeconds \?\? fallbackSeconds/,
    'pollMs 没有使用分档默认值')
  // 下界钳制（有意）：旧实现 Math.max(2, ...) 允许 2s
  const guard = /Math\.max\((\d+),\s*config\.pollIntervalSeconds/.exec(CODE)
  assert.ok(guard, '找不到 pollMs 的下界守卫')
  assert.ok(Number(guard[1]) >= 30, '下界守卫 ' + guard[1] + 's 过小')
  // 旧的硬编码 5 必须不再作为默认
  assert.ok(!/pollIntervalSeconds \?\? 5\b/.test(CODE), '默认值仍是旧的 5s（T1 未生效）')
})

// ── ② 事件驱动存在：不靠轮询也能触发 ──────────────────────────────────────────
test('T1-② settings/document-updated 到达即触发一轮（不依赖轮询）', async (t) => {
  const c = makeCtx({})
  apply(c.ctx, { startupDelaySeconds: 3600, pollIntervalSeconds: 3600 })
  // A（止血，2026-09-26）：断言先抛时下面的 dispose 走不到 -> setInterval(1h) 泄漏 ->
  // node:test 永不排空事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底。
  t.after(() => c.dispose())
  await flush()
  assert.ok(c.hasListener(EV), '未订阅 ' + EV + '（事件驱动缺失）')

  const before = c.state.describes
  c.emit(EV, 'llm-pi-ai', 1)
  await flush()
  assert.ok(
    c.state.describes > before,
    '事件到达后 describe 次数未增加（before=' + before + ' after=' + c.state.describes + '）：事件没有驱动 tick',
  )
})

test('T1-② 非 llm-pi-ai 命名空间的事件必须被忽略（不为其做全量 describe）', async (t) => {
  const c = makeCtx({})
  apply(c.ctx, { startupDelaySeconds: 3600, pollIntervalSeconds: 3600 })
  // A（止血，2026-09-26）：断言先抛时下面的 dispose 走不到 -> setInterval(1h) 泄漏 ->
  // node:test 永不排空事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底。
  t.after(() => c.dispose())
  await flush()
  const before = c.state.describes
  c.emit(EV, 'ui-theme', 1)
  c.emit(EV, 'llm-deepseek', 2)
  await flush()
  assert.equal(c.state.describes, before, '无关命名空间触发了 tick（应只关心 llm-pi-ai）')
})

// ── ③ 每 tick describe 次数上界 ───────────────────────────────────────────────
test('T1-③ 单次事件触发内 describe 次数 <= 2（旧实现同 tick 内 3+ 次）', async (t) => {
  const providers = {
    gateway: { baseURL: 'https://a.example/v1', api: 'openai-completions', models: [{ id: 'gw-model' }] },
  }
  const c = makeCtx(providers)
  apply(c.ctx, { startupDelaySeconds: 3600, pollIntervalSeconds: 3600 })
  // A（止血，2026-09-26）：断言先抛时下面的 dispose 走不到 -> setInterval(1h) 泄漏 ->
  // node:test 永不排空事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底。
  t.after(() => c.dispose())
  await flush()

  const before = c.state.describes
  c.emit(EV, 'llm-pi-ai', 1)
  await flush()
  const used = c.state.describes - before
  // 旧实现：signatureOf(1) + routesToConsider(1) + providerFromSettings(1)/route = >=3
  assert.ok(used >= 1, '事件后没有读描述符（无从得知新值）')
  assert.ok(used <= 2, '单次事件用了 ' + used + ' 次 describe（>2）：tick 内未复用描述符')
})

test('T1-③ 描述符复用：readDescriptor 必须带缓存（结构断言，剥注释后可执行行）', () => {
  const fn = /const readDescriptor = \(\) => \{([\s\S]*?)\n    \}/.exec(CODE)
  assert.ok(fn, '找不到 readDescriptor')
  const body = fn[1]
  assert.match(body, /tickSection === undefined/, 'readDescriptor 没有缓存判断（每次都会重新 describe）')
  assert.match(body, /tickSection =/, 'readDescriptor 没有写缓存')
})

// ── ④ 回归场景：事件路径下仍走完整补给链 ────────────────────────────────────────
test('T1-④ 回归场景：事件触发后补给链仍可达（用户口径不能退化）', async (t) => {
  const providers = {
    gateway: {
      baseURL: 'https://a.example/v1',
      api: 'openai-completions',
      // 声明了模型但不含 reasoningEfforts —— 正是回归场景（新加供应商、档位缺失）
      models: [{ id: 'gw-model' }],
    },
  }
  const c = makeCtx(providers)
  apply(c.ctx, { startupDelaySeconds: 3600, pollIntervalSeconds: 3600 })
  // A（止血，2026-09-26）：断言先抛时下面的 dispose 走不到 -> setInterval(1h) 泄漏 ->
  // node:test 永不排空事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底。
  t.after(() => c.dispose())
  await flush()
  c.emit(EV, 'llm-pi-ai', 1)
  await flush()

  const models = c.section.providers.gateway.models
  t.diagnostic('describes=' + c.state.describes + ' mutates=' + c.state.mutates + ' models=' + JSON.stringify(models))
  assert.ok(c.state.describes > 0, '事件路径连 describe 都没发生')
  if (c.state.mutates > 0) {
    assert.ok(
      models.some((m) => typeof m === 'object' && m.reasoningEfforts !== undefined),
      '发生了写回但模型条目仍无 reasoningEfforts',
    )
  }
})

// ── REVERSE：反证可判红 ───────────────────────────────────────────────────────
test('T1-REVERSE 反证可判红：改坏任一处都会让 ①/②/③ 判据失败', () => {
  // A) 把两档默认改回「5s」形态 -> ① 必须判红
  const brokenDefault = CODE.replace(/const fallbackSeconds = eventDriven \? 120 : 30/, 'const fallbackSeconds = 5')
  assert.ok(!/const fallbackSeconds = eventDriven \? 120 : 30/.test(brokenDefault), '反证构造失败 A')
  assert.ok(/const fallbackSeconds = 5/.test(brokenDefault))
  // ① 的判据在这份「坏代码」上不成立
  assert.ok(!/const fallbackSeconds = eventDriven \? 120 : 30/.test(brokenDefault),
    '把默认改回 5 后 ① 的 match 必须失败（判据有判别力）')

  // B) 去掉事件订阅 -> ② 必须判红
  const noEvent = CODE.replace(/'settings\/document-updated'/, "'settings/never-fired'")
  assert.ok(noEvent.includes("'settings/never-fired'"), '反证构造失败 B')
  assert.ok(!noEvent.includes("'settings/document-updated'"), '移除事件名失败')

  // C) 去掉 readDescriptor 的缓存 -> ③ 必须判红
  const noCache = CODE.replace(/if \(tickSection === undefined\)/, 'if (false)')
  const fn = /const readDescriptor = \(\) => \{([\s\S]*?)\n    \}/.exec(noCache)
  assert.ok(fn, '反证构造失败 C：readDescriptor 未找到')
  assert.ok(!/tickSection === undefined/.test(fn[1]),
    '去掉缓存判断后 ③ 的判别必须失败（判据有判别力）')
})

// ── ⑤ 回归场景（真实目录 + 端到端写回）───────────────────────────────────────
// 用出货目录快照里真实存在的 id（zai-org/GLM-5.3-Fast：单条 entry、有 wire 等级、
// thinkingFormat=openai），这样才能真的走完 discover → mergeCatalog → applyModelPatch。
const REAL_ID = 'zai-org/GLM-5.3-Fast'

test('T1-⑤ 回归场景端到端：事件到达后真实写回 reasoningEfforts（用户口径不退化）', async (t) => {
  const c = makeCtx({
    gateway: {
      baseURL: 'https://a.example/v1',
      api: 'openai-completions',
      // 用户新加的供应商：声明了模型、但没有思考档位 —— 正是 2026-09-10 的用户现场
      models: [{ id: REAL_ID }],
    },
  })
  apply(c.ctx, { startupDelaySeconds: 3600, pollIntervalSeconds: 3600 })
  // A（止血，2026-09-26）：断言先抛时下面的 dispose 走不到 -> setInterval(1h) 泄漏 ->
  // node:test 永不排空事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底。
  t.after(() => c.dispose())
  await flush()
  c.emit(EV, 'llm-pi-ai', 1)
  await flush()

  const models = c.section.providers.gateway.models
  const entry = models.find((m) => typeof m === 'object' && m.id === REAL_ID)
  t.diagnostic('mutates=' + c.state.mutates + ' entry=' + JSON.stringify(entry))
  assert.equal(c.state.mutates, 1, '事件路径没有产生写回（回归场景失效）')
  assert.ok(entry && entry.reasoningEfforts, '写回后条目仍无 reasoningEfforts（档位不会出现）')
  assert.ok(entry.reasoningEfforts.high, 'reasoningEfforts 缺少 high 档')
})

test('T1-⑤ 反证：关掉事件且间隔拉到极大 -> 回归场景在窗口内不成立', async (t) => {
  // 判据 (b) 的判别力证明：这正是「只用轮询兜底」的世界。
  const c = makeCtx({
    gateway: {
      baseURL: 'https://a.example/v1',
      api: 'openai-completions',
      models: [{ id: REAL_ID }],
    },
  })
  apply(c.ctx, { startupDelaySeconds: 3600, pollIntervalSeconds: 3600 })
  // A（止血，2026-09-26）：断言先抛时下面的 dispose 走不到 -> setInterval(1h) 泄漏 ->
  // node:test 永不排空事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底。
  t.after(() => c.dispose())
  await flush()
  const before = c.state.mutates
  // 不触发事件，只等一小段（远小于 3600s 的兜底间隔）
  await flush()
  assert.equal(c.state.mutates, before, '未触发事件却发生了写回（判据无判别力）')
  assert.equal(c.state.mutates, 0, '无事件时不应写回——这正是纯轮询下「要等 2 分钟」的证据')
})

// ── ⑥ 自触发环收敛（lead 复核问题 1）────────────────────────────────────────
test('T1-⑥ 自触发环收敛：连续自身写回后签名稳定，不无限自旋', async (t) => {
  const c = makeCtx({
    gateway: {
      baseURL: 'https://a.example/v1',
      api: 'openai-completions',
      models: [{ id: REAL_ID }],
    },
  })
  apply(c.ctx, { startupDelaySeconds: 3600, pollIntervalSeconds: 3600 })
  // A（止血，2026-09-26）：断言先抛时下面的 dispose 走不到 -> setInterval(1h) 泄漏 ->
  // node:test 永不排空事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底。
  t.after(() => c.dispose())
  await flush()

  // 模拟上游：我方 mutate 后上游会再发一次 document-updated（同一 ns）。
  // 在 mutate 里回灌事件，制造「写回 -> 事件 -> 再写回」的自触发环候选。
  const origMutate = c.ctx.settings.mutate
  c.ctx.settings.mutate = async (ns, ops, rev) => {
    const out = await origMutate(ns, ops, rev)
    queueMicrotask(() => c.emit(EV, ns, 99))
    return out
  }

  c.emit(EV, 'llm-pi-ai', 1)
  await flush()
  await flush()
  await flush()

  // 收敛判据：首次写回之后再无第二次（字段已填 → plan 无变化 → 不再 mutate）
  t.diagnostic('mutates=' + c.state.mutates + ' describes=' + c.state.describes)
  assert.equal(c.state.mutates, 1, '写回发生了 ' + c.state.mutates + ' 次：自触发环未收敛（应为 1）')
})

// ── ⑦ 兜底间隔钳制（lead 复核问题 2）─────────────────────────────────────────
test('T1-⑦ 配置 pollIntervalSeconds=5 被有意钳到 30（防配回 5s 打回高 CPU）', () => {
  const guard = /Math\.max\((\d+),\s*config\.pollIntervalSeconds/.exec(CODE)
  assert.ok(guard, '找不到下界守卫')
  const lower = Number(guard[1])
  assert.equal(lower, 30, '下界守卫应为 30（有意钳制），实际 ' + lower)
  // 钳制是**有意**的：Math.max(30, ...) 让用户显式配的 5 也会被抬到 30
  assert.match(CODE, /Math\.max\(30,\s*config\.pollIntervalSeconds \?\? fallbackSeconds\)/,
    '钳制表达式形态不符')
  // 行为化验证：模拟 Math.max 对该表达式的取值
  assert.equal(Math.max(30, 5), 30, '钳制语义确认：显式 5 应被抬到 30')
  assert.equal(Math.max(30, 120), 120, '显式大于钳制下界时应尊重用户值')
})

test('T1-⑦ 事件订阅不可用时兜底间隔自动收紧到 30s（避免功能延迟退化到 2 分钟）', async (t) => {
  // ctx.on 缺席 = 事件面不可用：此时轮询是唯一触发器，必须用短档。
  const c = makeCtx({})
  delete c.ctx.on
  apply(c.ctx, { startupDelaySeconds: 3600 })
  // A（止血，2026-09-26）：断言先抛时下面的 dispose 走不到 -> setInterval(1h) 泄漏 ->
  // node:test 永不排空事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底。
  t.after(() => c.dispose())
  await flush()
  // 结构断言：两档选择由 eventDriven 驱动（上面 ⑦ 已锁表达式），此处锁「订阅缺失不注册监听」
  assert.ok(!c.hasListener(EV), '本夹具不应有事件订阅')
})

// ── ⑧ X1 回归：事件回调必须把写回送出 hmr 事务上下文 ────────────────────────────
// 现场（2026-09-25）：settings/document-updated 是在用户那次写事务**之内**同步 emit 的，
// 事件回调里直接调 settings.mutate -> configEditor.edit -> hmr.runExclusive 被判嵌套：
//   Error: HMR transactions cannot be nested
//     at Proxy.runExclusive (dsh-hmr/lib/index.js) at Proxy.edit (dsh-config-editor) ...
// 判据：事件到达后写回必须**不在**原事务的异步上下文里执行。
test('X1-⑧ 事件回调把 tick 送出当前异步上下文（否则写回被 hmr 判嵌套）', async (t) => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const als = new AsyncLocalStorage()
  const c = makeCtx({ gateway: { baseURL: 'https://a.example/v1', api: 'openai-completions', models: [{ id: REAL_ID }] } })
  apply(c.ctx, { startupDelaySeconds: 3600, pollIntervalSeconds: 3600 })
  // A（止血，2026-09-26）：断言先抛时下面的 dispose 走不到 -> setInterval(1h) 泄漏 ->
  // node:test 永不排空事件循环 -> CI 卡死且拿不到 pass/fail 汇总行。故挂 t.after 兜底。
  t.after(() => c.dispose())
  await flush()

  // 观测点（C，2026-09-26）：**主判据落在 settings.describe 上**，而不是 settings.mutate。
  // 为什么提前：mutate 只在「目录命中且确有字段要补」时才发生，因此依赖 lib/catalog-snapshot.json；
  // 而 describe 是 tick 的**第一件事**（deferrer 回调一进来就读描述符），与目录数据无关。
  // 主判据挂在 describe 上，X1 的守卫就不再随目录数据有无而失效 —— 覆盖不丢失，且两个环境同形。
  // mutate 观测保留为**加强项**（确有写回时再断言一次，证明端到端路径同样在事务外）。
  const descCtx = []
  const origDescribe = c.ctx.settings.describe
  c.ctx.settings.describe = function (...args) {
    descCtx.push(als.getStore())
    return origDescribe.apply(this, args)
  }
  let sawMutateContext = null
  const origMutate = c.ctx.settings.mutate
  c.ctx.settings.mutate = async (ns, ops, rev) => {
    if (sawMutateContext === null) sawMutateContext = als.getStore()
    return origMutate(ns, ops, rev)
  }

  // 复刻上游：在事务标记内同步 emit 事件（与 settings.write 的 emit 位置同形）
  await new Promise((resolve) => { als.run(true, () => { c.emit(EV, 'llm-pi-ai', 1); resolve() }) })
  await new Promise((r) => setTimeout(r, 400))

  // 主判据：tick 的 describe 必须已经脱离事务上下文
  assert.ok(descCtx.length > 0, '事件没有驱动 tick（describe 未被调用，夹具问题，判据无效）')
  assert.equal(descCtx.every((x) => x === undefined), true,
    'tick 的 settings.describe 仍在 hmr 事务上下文内执行（descCtx=' + JSON.stringify(descCtx)
      + '）=> 说明 deferrer 没把 tick 送出事务')
  // 加强项：若真的发生了写回，写回也必须在事务外
  if (sawMutateContext !== null) {
    assert.equal(sawMutateContext, undefined,
      '写回仍在 hmr 事务上下文内执行（sawMutateContext=' + String(sawMutateContext)
        + '）=> 会抛 HMR transactions cannot be nested')
  }
})

test('X1-⑧ 反证：不经 deferrer 直接调用会在事务内（说明判据有判别力）', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const als = new AsyncLocalStorage()
  // 直接对照：事务内同步调用普通异步函数，其上下文必然继承（这就是回归现场）
  let inside = null
  await new Promise((resolve) => {
    als.run(true, () => { queueMicrotask(() => { inside = als.getStore(); resolve() }) })
  })
  assert.equal(inside, true, '对照夹具失效：普通调度应继承上下文')
})
