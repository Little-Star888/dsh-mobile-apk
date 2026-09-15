// combo-lazy-a4.test.mjs — A4 补丁回归：compose() 延迟 + 去重（0.14.0 启动性能 P1-1）。
//
// 背景（docs/ANDROID-RUNTIME-PERF-2026-09-12.md §R1/§4.A4）：装配期每次 internal/plugin 事件都触发
// flush → compose() 对 90 条客户端 combo 全表重算（单次 1.8-3.1 s，启动期 9-14 次 = LISTEN 墙钟 88%）。
// A4 把首个图读者之前的所有 flush 收敛为「只标脏」，唯一一次全量 compose 发生在
// graph()/index-inject/bundle 路由首次读取时；图已存在后的运行期变更仍即时重算（行为不变）。
//
// 本测试：① 对只读 fixture 跑 apply-patches（幂等 + node --check + marker）；
// ② 抽出打过补丁的 ClientModuleRegistry 类，注入桩驱动：构造零 compose、boot 期多次 flush 仍零、
//    首个读者恰好一次；图已就绪后的 flush 即时重算一次；graph() 稳定对象复用。
//
// 用法：node scripts/patches/tests/combo-lazy-a4.test.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const FIXTURE = join(here, 'fixtures', 'dsh-client-modules-0.1.5-rc.1', 'lib', 'index.js')

const failures = []
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
function extractClass(source, signature) {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error('class not found: ' + signature)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 2)
    }
  }
  throw new Error('unbalanced braces for ' + signature)
}

const scratch = mkdtempSync(join(tmpdir(), 'a4-test-'))
try {
  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'))

  const apply = () => spawnSync(process.execPath,
    [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine', '--only', 'combo-lazy-A4'],
    { encoding: 'utf8' })
  const applied = apply()
  check('apply-patches exits 0', applied.status === 0, (applied.stderr || '').trim().split('\n').slice(-2).join(' '))
  const patched = readFileSync(target, 'utf8')
  check('marker 数 = 2（字段 + 构造函数）', (patched.match(/dsh-mobile combo lazy \(A4\)/g) || []).length === 2,
    'count=' + ((patched.match(/dsh-mobile combo lazy \(A4\)/g) || []).length))
  check('构造函数不再抢先 compose', !patched.includes('\t\tthis.composed = this.compose();\n\t\tconst failures = [];'))
  check('ensureComposed 在场', patched.includes('\tensureComposed() {'))
  const parse = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  check('patched file parses', parse.status === 0, (parse.stderr || '').split('\n')[0])

  apply()
  check('re-apply is idempotent', readFileSync(target, 'utf8') === patched)

  // ── 行为：抽出 ClientModuleRegistry 类，注入桩驱动 compose 计数 ──
  const classSrc = extractClass(patched, 'var ClientModuleRegistry = class extends Service {')
  const makeRegistry = () => {
    const handlers = {}
    const rows = []
    let composeCalls = 0
    const Service = class { constructor(ctx, name) { this.ctx = ctx; this.name = name } }
    const factory = new Function('Service', 'randomBytes', 'orderByModuleGraph', 'PARSER_PRELOAD_IDS',
      'partitionComboRecords', 'shortHash', 'bootInjections',
      classSrc + '\nreturn ClientModuleRegistry;')
    const Registry = factory(
      Service,
      () => ({ toString: () => 'dshmobile' }),
      (entries) => entries,
      [],
      () => [],
      () => 'rev',
      (graph) => { rows.push({ kind: 'global', name: '__DSH_BOOT__', value: graph.rev }); return [{ kind: 'global' }] },
    )
    const webServer = { register: () => () => {} }
    const ctx = {
      on: (ev, cb) => { handlers[ev] = cb },
      loader: { entries: () => [] },
      effect: (cb) => cb(),
      webServer,
      get: (name) => name === 'webServer' ? { effect: (cb) => cb(), webServer } : void 0,
      inject: () => {},
      logger: { warn: () => {}, error: () => {} },
    }
    const registry = new Registry(ctx)
    registry.compose = function (...args) {
      composeCalls += 1
      return Registry.prototype.compose.apply(this, args)
    }
    return { registry, handlers, rows, composeCalls: () => composeCalls }
  }

  // ① 构造零 compose；首个读者恰好一次；随后 graph() 复用同一对象
  {
    const ctx = makeRegistry()
    check('构造后零 compose（延迟生效）', ctx.composeCalls() === 0, 'calls=' + ctx.composeCalls())
    const g1 = ctx.registry.graph()
    check('首个读者触发一次 compose', ctx.composeCalls() === 1, 'calls=' + ctx.composeCalls())
    const g2 = ctx.registry.graph()
    check('后续读者零 compose 且返回同一对象', ctx.composeCalls() === 1 && g1 === g2, 'calls=' + ctx.composeCalls())
    const before = ctx.composeCalls()
    ctx.handlers['webserver/index-inject']([{ kind: 'script' }])
    check('index-inject 读取已就绪图（不再重复 compose）', ctx.composeCalls() === before && ctx.rows.length === 1,
      'calls=' + ctx.composeCalls())
  }

  // ② boot 期多次 flush 只标脏：首个读者前 compose 次数保持 0，首个读者后累计 = 1
  {
    const ctx = makeRegistry()
    ctx.registry.processOne = () => true
    const firePlugin = (name) => ctx.handlers['internal/plugin']({ entry: { options: { name } } })
    firePlugin('pkg-a')
    firePlugin('pkg-b')
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('boot 期 flush 不 compose（只标脏）', ctx.composeCalls() === 0, 'calls=' + ctx.composeCalls())
    ctx.registry.graph()
    check('boot 期多次表变更收敛为一次 compose', ctx.composeCalls() === 1, 'calls=' + ctx.composeCalls())
  }

  // ③ 图已就绪后的运行期变更：flush 即时重算一次并 notify（行为与上游一致）
  {
    const ctx = makeRegistry()
    ctx.registry.processOne = () => true
    const g1 = ctx.registry.graph()
    let notified = 0
    ctx.registry.onGraphChanged(() => { notified += 1 })
    ctx.registry.dirty.add('late-plugin')
    ctx.registry.flush((error) => { throw error })
    const g2 = ctx.registry.graph()
    check('运行期 flush 即时重算一次', ctx.composeCalls() === 2, 'calls=' + ctx.composeCalls())
    check('运行期重算触发 graphChanged 通知', notified === 1, 'notified=' + notified)
    check('重算产生新图对象', g1 !== g2)
    check('重算后再次读取零 compose', ctx.composeCalls() === 2 && ctx.registry.graph() === g2, 'calls=' + ctx.composeCalls())
  }

  // ④ 未知 id 的 rebuilt 不触发 compose（HMR 路径的早退分支保持）
  {
    const ctx = makeRegistry()
    const rev = ctx.registry.rebuilt('missing-package')
    check('rebuilt(未知 id) 返回 undefined 且零 compose', rev === undefined && ctx.composeCalls() === 0, 'calls=' + ctx.composeCalls())
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
