// combo-cache-a3.test.mjs — A3 补丁回归：combo 构建期缓存查表 == 现场生成（0.14.0 启动性能 P1-2）。
//
// 契约（三处同源）：scripts/lib/combo-precompute.mjs（构建期写）/ apply-patches.mjs combo-cache-A3
// （运行期读）/ scripts/check-combo-cache.mjs（覆盖门禁）。本测试证明「读缓存命中的 buildCombo 输出」
// 与「未打补丁的现场生成」在 script/sourceMap/rev/url 上逐字节一致，并证明三类 fail-open：
//   A. 缓存目录缺席（state=absent）→ 现场生成，输出一致；
//   B. client.js 被篡改（sha 不命中）→ 现场生成，输出一致；
//   C. entry 的 id 与记录不符 → 现场生成，输出一致。
//
// 用法：node scripts/patches/tests/combo-cache-a3.test.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { comboCacheEntry } from '../../lib/combo-precompute.mjs'
import { versionedFixture } from './lib/fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'
const FIXTURE = versionedFixture('dsh-client-modules', 'lib', 'index.js')

const failures = []
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
function extractFunction(source, signature) {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error('function not found: ' + signature)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces for ' + signature)
}
function extractConsts(source) {
  const wanted = ['SOURCE_MAP_TRAILER', 'SOURCE_URL_TRAILER', 'HASH_REVISION_LENGTH']
  const out = []
  for (const name of wanted) {
    const m = source.match(new RegExp('const ' + name + ' = [^\\n]+'))
    if (!m) throw new Error('const not found: ' + name)
    out.push(m[0])
  }
  return out.join('\n')
}
function extractA3Block(source) {
  const start = source.indexOf('/* dsh-mobile combo cache (A3)')
  if (start < 0) throw new Error('A3 helper block not found')
  const report = extractFunction(source, 'function dshMobileComboCacheReport() {')
  const end = source.indexOf(report) + report.length
  return source.slice(start, end)
}
/** Build a harness exposing buildCombo for one source text. */
function buildHarness(source, withA3) {
  const parts = [
    extractConsts(source),
    extractFunction(source, 'function framedHash(domain, parts) {'),
    extractFunction(source, 'function comboUrl(ids, rev, sourceMap = false) {'),
    extractFunction(source, 'function comboSource(record) {'),
    extractFunction(source, 'function comboScript(input, sourceMapUrl) {'),
    extractFunction(source, 'function newlineCount(value) {'),
    extractFunction(source, 'function comboSectionMap(record) {'),
    extractFunction(source, 'function identitySectionMap(source, sourceUrl) {'),
    extractFunction(source, 'function buildCombo(records, revision) {'),
  ]
  if (withA3) parts.push(extractA3Block(source))
  const factory = new Function('createHash', 'readFileSync', 'existsSync', 'join', 'process', 'console',
    parts.join('\n') + '\nreturn { buildCombo, dshMobileComboCacheLoad: typeof dshMobileComboCacheLoad === "function" ? dshMobileComboCacheLoad : void 0 };')
  return factory(createHash, readFileSync, existsSync, join, process,
    { log: () => {}, warn: () => {}, error: () => {} })
}

const scratch = mkdtempSync(join(tmpdir(), 'a3-test-'))
try {
  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  const fixtureText = readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n')
  writeFileSync(target, fixtureText)

  // 只读 fixture 未打补丁：作为「现场生成」的基线（构造前先固化文本）
  const liveHarness = buildHarness(fixtureText, false)

  const apply = () => spawnSync(process.execPath,
    [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine', '--only', 'combo-lazy-A4,combo-cache-A3'],
    { encoding: 'utf8' })
  const applied = apply()
  check('apply-patches exits 0（A4 + A3）', applied.status === 0, (applied.stderr || '').trim().split('\n').slice(-2).join(' '))
  const patched = readFileSync(target, 'utf8')
  check('A3 marker 三处在场', patched.includes('dsh-mobile combo cache (A3)')
    && patched.includes('dsh-mobile combo cache hit (A3)')
    && patched.includes('dsh-mobile combo cache report (A3)'))
  const parse = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  check('patched file parses', parse.status === 0, (parse.stderr || '').split('\n')[0])
  apply()
  check('re-apply is idempotent', readFileSync(target, 'utf8') === patched)
  const patchedHarness = buildHarness(patched, true)

  // ── 夹具：带真实 trailer 的 client.js（覆盖 comboSource 的剥离与 fallbackSource 推导）──
  const pkgDir = join(scratch, 'demo-pkg')
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'demo-pkg', version: '1.0.0' }))
  const bundleText = [
    'window.__ModuleLoader__.load({ id: "demo-pkg", factory: function (require) {',
    '\tvar x = require("react");',
    '\treturn function () { return x.createElement("div", null, "hello combo"); };',
    '} });',
    '//# sourceMappingURL=client.js.map',
    '',
  ].join('\n')
  const clientPath = join(pkgDir, 'lib', 'client.js')
  writeFileSync(clientPath, bundleText)
  const bundle = readFileSync(clientPath)
  const record = { entry: { id: 'demo-pkg', rev: 'rev000000001' }, bundle, meta: { clientPath } }

  // 构建期缓存（同一份字节）
  const cacheDir = join(scratch, '.combo-cache')
  mkdirSync(cacheDir, { recursive: true })
  const entry = comboCacheEntry('demo-pkg', bundle)
  writeFileSync(join(cacheDir, 'client-combos.json'), JSON.stringify({
    version: 1,
    generator: 'combo-precompute.mjs',
    entries: { [entry.sha256]: { id: 'demo-pkg', source: entry.source, lines: entry.lines, map: entry.sha256 + '.map' } },
  }, null, 2) + '\n')
  writeFileSync(join(cacheDir, entry.sha256 + '.map'), entry.sectionJson + '\n')

  const eq = (a, b) => Buffer.compare(a, b) === 0
  const live = liveHarness.buildCombo([record], record.entry.rev)

  // A. 命中：设 DSH_COMBO_CACHE 后查表
  process.env.DSH_COMBO_CACHE = cacheDir
  const cached = patchedHarness.buildCombo([record], record.entry.rev)
  check('A3 命中：script 逐字节一致', eq(live.script, cached.script), 'len ' + live.script.length + ' vs ' + cached.script.length)
  check('A3 命中：sourceMap 逐字节一致', eq(live.sourceMap, cached.sourceMap), 'len ' + live.sourceMap.length + ' vs ' + cached.sourceMap.length)
  check('A3 命中：rev/url/sourceMapUrl 一致',
    live.rev === cached.rev && live.url === cached.url && live.sourceMapUrl === cached.sourceMapUrl)

  // B. 缓存目录缺席（env 指向不存在的目录）：fail-open → 现场生成（缓存按进程实例加载，必须新开 harness）
  process.env.DSH_COMBO_CACHE = join(scratch, 'no-such-cache')
  const absent = buildHarness(patched, true).buildCombo([record], record.entry.rev)
  check('A3 缓存缺席：fail-open 输出与现场一致', eq(live.script, absent.script) && eq(live.sourceMap, absent.sourceMap))

  // C. client.js 被篡改：sha 不命中 → 现场生成（P-AC-05）
  process.env.DSH_COMBO_CACHE = cacheDir
  const tamperedBundle = Buffer.from(bundleText.replace('hello combo', 'hello tampered'))
  const tampered = patchedHarness.buildCombo([{ ...record, bundle: tamperedBundle }], record.entry.rev)
  const liveTampered = liveHarness.buildCombo([{ ...record, bundle: tamperedBundle }], record.entry.rev)
  check('A3 篡改 client.js：sha 不命中 → 现场生成且输出一致',
    eq(liveTampered.script, tampered.script) && eq(liveTampered.sourceMap, tampered.sourceMap))

  // D. id 不符：条目在场但记录 id 不同 → 现场生成
  const otherId = patchedHarness.buildCombo([{ ...record, entry: { id: 'other-pkg', rev: 'rev000000001' } }], record.entry.rev)
  const liveOtherId = liveHarness.buildCombo([{ ...record, entry: { id: 'other-pkg', rev: 'rev000000001' } }], record.entry.rev)
  check('A3 id 不符：回退现场生成且输出一致',
    eq(liveOtherId.script, otherId.script) && eq(liveOtherId.sourceMap, otherId.sourceMap))

  // E. 批路径（revision 省略 → framedHash 全量哈希）也逐字节一致
  const liveBatch = liveHarness.buildCombo([record], undefined)
  const cachedBatch = patchedHarness.buildCombo([record], undefined)
  check('A3 命中：批路径（无 revision）拼接与哈希一致',
    eq(liveBatch.script, cachedBatch.script) && eq(liveBatch.sourceMap, cachedBatch.sourceMap) && liveBatch.rev === cachedBatch.rev)

  // F. 缺省 DSH_HOME + env 覆盖语义：无 DSH_COMBO_CACHE 时回落到 $DSH_HOME/profiles/web/.combo-cache
  delete process.env.DSH_COMBO_CACHE
  process.env.DSH_HOME = join(scratch, 'home')
  const homePatched = buildHarness(patched, true)
  const homeFallback = homePatched.buildCombo([record], record.entry.rev)
  check('A3 无 env 覆盖：$DSH_HOME 派生路径缺席时 fail-open', eq(live.script, homeFallback.script) && eq(live.sourceMap, homeFallback.sourceMap))
} finally {
  rmSync(scratch, { recursive: true, force: true })
  delete process.env.DSH_COMBO_CACHE
  delete process.env.DSH_HOME
}

console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
