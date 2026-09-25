// check-contract.mjs — adapter-layer contract point check (core M1.4 adapter chain check).
// Consumes scripts/contract.json; any broken point → non-zero exit + report.
// 用法：node scripts/check-contract.mjs [--require]
//         [--self-test]                        反证夹具：13 例「故意造反例必判红」自证（只读临时副本，不动仓库文件）
//         [--runtime <ver>]                    只用于反证：把目标运行时装成下一版，验 §7 会不会判红
//         [--capture-slots --accept-slot-diff <理由>] / [--capture-rows --accept-row-diff <理由>]
//                                              换树后重新登记 §4c / §8 的上游面集合（改范围必须给理由，不给即红）
//         [--contract <file>] [--profile <file>] 仅 --self-test 用的输入改道缝
// review C6（2026-09-14）：本门禁此前未接任何链（存在但从不执行 = 假防线）；现接进聚合入口与两条构建链。
// 上游 `dsh/` 只读 checkout 与基线 `node_modules` 都是**本机产物**（gitignore，CI/自包含树不在场）：
// 对应小节以 SKIP 计数并打印汇总；`--require`（发布链）下任何 SKIP 即失败——发布环境必须齐全。
// --runtime 只用于反证（把目标运行时装成下一版，验 §7 会不会判红），不参与任何默认判据。
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
/**
 * --contract / --profile 只为 `--self-test` 的反证夹具留缝（把改坏的登记表/装配清单指到临时副本），
 * 正式链一律不传 ⇒ 反证不靠「改仓库文件再改回来」（半途被杀就留下一棵脏树）。
 */
const flagValue = (name) => { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? '') : null }
const CONTRACT_PATH = resolve(flagValue('--contract') ?? join(root, 'scripts/contract.json'))
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'))
const PROFILE_PATCH_PATH = resolve(flagValue('--profile') ?? join(root, 'scripts', 'profile-web.cordis.patch.yml'))
const DOC_PATH = resolve(flagValue('--doc') ?? join(root, 'docs', 'UPSTREAM-CONTRACT.md'))
const issues = []
const REQUIRE = argv.includes('--require')
let skipped = 0
const ok = (msg) => console.log('  OK  ' + msg)
const fail = (msg) => { issues.push(msg); console.log('  FAIL ' + msg) }
const skip = (msg) => {
  skipped += 1
  if (REQUIRE) issues.push('SKIP: ' + msg)
  console.log('  SKIP(#' + skipped + ')  ' + msg + (REQUIRE ? ' —— --require 档不得 SKIP' : ''))
}

/* --self-test：新加的每一条判据都要「故意造反例必判红」的自证（AGENTS 反证要求）。
 * 反例走临时副本（--contract / --profile），不改仓库文件——半途被杀也不会留下一棵脏树。 */
if (argv.includes('--self-test')) runContractSelfTest()

function dtsFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...dtsFiles(p))
    else if (p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/**
 * 上游树身份（G-9）。§1/§3/§4b/§4c 全部直接读 `dsh/packages/**` 工作树，但此前**没有任何门禁记录
 * 读的是哪一棵树**：本轮实测该树停在 `dsh-v0.1.5-rc.1-9-gaa8262ec09`（比 tag 多 9 个提交），
 * 而根包 `version` 在两次发布之间不 bump ⇒ 只看 package.json 分不清「正好在 tag 上」和「漂在 tag 之后」。
 * 登记 upstream{tag,describe,commit,rootVersion} 后，切树/漏切都会判红，而不是换一棵树继续全绿。
 */
const upstreamDir = join(root, contract.upstreamRepo)
function gitInUpstream(args) {
  try {
    return execFileSync('git', ['-C', upstreamDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}
/** 上游树实际身份；树不在场（CI/自包含构建）时返回 null，由调用方 SKIP。 */
function upstreamIdentity() {
  const pkgPath = join(upstreamDir, 'package.json')
  if (!existsSync(pkgPath)) return null
  const describe = gitInUpstream(['describe', '--tags'])
  const commit = gitInUpstream(['rev-parse', 'HEAD'])
  return { rootVersion: JSON.parse(readFileSync(pkgPath, 'utf8')).version, describe, commit }
}

console.log('== 0. 上游树身份（上游面判据读的是哪一棵树；G-9） ==')
const up = contract.upstream
if (up === undefined) {
  fail('contract.json 缺 upstream{tag,describe,commit,rootVersion}：上游面判据（§1/§3/§4b/§4c）没有树身份锚定，任何一棵树都能绿')
} else {
  const id = upstreamIdentity()
  if (id === null) skip('上游树 ' + contract.upstreamRepo + '/package.json 不在场 —— 上游树身份未执行')
  else {
    if (id.rootVersion !== contract.baseline) {
      fail('上游树根包 version=' + id.rootVersion + ' ≠ contract.baseline=' + contract.baseline
        + '：§1/§3/§4b 正在拿一棵别的版本的树当基线判（追版时先切树再改 baseline，两步必须同时发生）')
    } else ok('上游树根包 version == baseline（' + id.rootVersion + '）')
    if (up.rootVersion !== contract.baseline) fail('contract.upstream.rootVersion=' + up.rootVersion + ' ≠ contract.baseline=' + contract.baseline + '（登记表内部自相矛盾）')
    if (id.commit === null || id.describe === null) {
      skip('git 不可读（不是 checkout 或 git 不在 PATH）—— 无法核对上游树 commit/describe')
    } else {
      if (id.commit !== up.commit) fail('上游树 HEAD=' + id.commit + ' ≠ 登记 commit=' + up.commit + '（登记来自 ' + up.describe + '，现在读的是 ' + id.describe + '）——请复核是否切了树；确需换树就同步改 contract.upstream 并复核 §1/§3/§4b 结论')
      else ok('上游树 HEAD == 登记 commit（' + id.describe + '）')
      if (id.describe !== up.describe) fail('上游树 describe=' + id.describe + ' ≠ 登记 describe=' + up.describe + '（同一 commit 也不代表同一判据范围：tag 之后多出的提交同样在树里）')
      else ok('上游树 describe == 登记（' + up.describe + '）')
    }
  }
}

console.log('== 1. bundle 行引用 ==')
const upstreamPackages = join(root, contract.upstreamRepo, 'packages')
if (!existsSync(upstreamPackages)) {
  skip('上游树 ' + contract.upstreamRepo + '/packages 不在场（只读 checkout；CI/自包含树不含）——bundle 行引用未执行')
} else {
  for (const row of contract.rows) {
    const patchFile = join(upstreamPackages, 'bundle', row.bundle, 'cordis.patch.yml')
    if (!existsSync(patchFile)) { fail('bundle patch 缺失: ' + patchFile); continue }
    const text = readFileSync(patchFile, 'utf8')
    const hit = text.split('\n').find(l => l.trim() === '- id: ' + row.id)
    if (hit === undefined) fail('行 ' + row.id + ' 在上游 ' + row.bundle + ' bundle 中不存在（patch 静默失效风险）')
    else ok('行 ' + row.id + ' @ ' + row.bundle + ' 存在')
  }
}

console.log('== 2. 插入行包存在（仓库 + 构建产物） ==')
for (const ins of contract.inserted) {
  const repo = join(root, ins.repo)
  if (!existsSync(join(repo, 'package.json'))) fail('仓库缺失: ' + ins.repo)
  else ok('仓库 ' + ins.repo + ' 存在')
  const built = existsSync(join(repo, 'lib/index.js')) || existsSync(join(repo, 'lib/client.js'))
  if (!built) fail(ins.repo + ' 未构建（lib/ 缺失）')
  else ok(ins.repo + ' lib/ 已构建')
}

console.log('== 3. 继承符号（基线 node_modules 类型面） ==')
const baseline = join(root, contract.symbols[0].repo, 'node_modules/@deepseek-ai')
if (!existsSync(baseline)) {
  skip('基线 node_modules 不在场（' + contract.symbols[0].repo + '/node_modules，先 npm install）——继承符号未执行')
} else {
  for (const sym of contract.symbols) {
    const typesDir = join(baseline, sym.pkg, 'lib/types')
    if (!existsSync(typesDir)) { fail('基线缺失 ' + sym.pkg + '/lib/types（先 npm install）'); continue }
    const found = dtsFiles(typesDir).some(f => readFileSync(f, 'utf8').includes(sym.symbol))
    if (found) ok(sym.pkg + ': ' + sym.symbol)
    else fail(sym.pkg + ': 符号 ' + sym.symbol + ' 不在基线类型面（继承面断裂）')
  }
}

// 0.2.0 起注入层不再替换上游框架：它组合进上游的座位，绝不注册 'root'。
console.log('== 4. 客户端槽位声明（组合面，非框架替换） ==')
const slotText = readFileSync(join(root, contract.clientSlots.repo, 'src/client/index.ts'), 'utf8')
for (const slot of contract.clientSlots.slots) {
  if (slotText.includes("'" + slot + "'")) ok('槽位 ' + slot + ' 已组合')
  else fail('槽位 ' + slot + ' 未组合')
}
if (contract.clientSlots.ownRoot === false) {
  if (/name:\s*'root'/.test(slotText)) fail("注入层注册了 'root' 槽（框架替换回归）")
  else ok("未注册 'root' 槽（上游 ui-layout 持有框架）")
}
if (contract.clientSlots.enabledRow !== undefined) {
  const patchText = readFileSync(join(root, 'scripts/profile-web.cordis.patch.yml'), 'utf8')
  const disabled = new RegExp('- id:\\s*' + contract.clientSlots.enabledRow + '\\s*\\n\\s*disabled:\\s*true').test(patchText)
  if (disabled) fail('profile patch 禁用了 ' + contract.clientSlots.enabledRow + '（0.1.5 起为布局服务中枢，禁用即会话与左栏同时失效）')
  else ok('profile patch 保留 ' + contract.clientSlots.enabledRow + ' 启用')
}

// 槽位**声明面**（0.14.1 §1.1b 决策 1 第 3 项）：上面的 §4 只断言「我们注册了哪些槽」，
// 全是**我方源码里挑字符串**——上游把槽删掉/改 kind/改 scope 时它照样绿（文本还在我方文件里）。
// 这是「注入层在升级后静默失效」的真实盲区，本段用**上游声明源**做结构性判据：
//   · 从上游该槽的声明文件里定位声明块（单行 `'x': { ... }` 或多行 `'x': {\n ... \n}` 两种形态）；
//   · 断言 kind / scope 与 contract.json 记录的实测值一致（kind=keyed/list/single，scope=root/session）。
// 判红理由分两类且文案分开：槽**消失**（升级删槽）与 kind/scope **漂移**（语义变更）是不同事故。
if (Array.isArray(contract.clientSlots.declarations) && contract.clientSlots.declarations.length > 0) {
  console.log('== 4b. 槽位声明面（上游 kind/scope 与实测值一致；防升级静默失效） ==')
  for (const d of contract.clientSlots.declarations) {
    const declFile = join(root, contract.upstreamRepo, d.file)
    if (!existsSync(declFile)) {
      skip('上游声明文件不在场: ' + d.file + '（只读 checkout；CI/自包含树不含）——槽 ' + d.slot + ' 未执行')
      continue
    }
    const text = readFileSync(declFile, 'utf8')
    const key = "'" + d.slot + "'"
    const at = text.indexOf(key)
    if (at < 0) {
      fail('槽 ' + d.slot + ' 在上游声明源里消失（' + d.file + '）：注入层注册将静默落空')
      continue
    }
    // 声明块 = 键之后到首个 `}` 为止（单行与多行两种写法都覆盖；槽值内无嵌套对象字面量）。
    const rest = text.slice(at + key.length)
    const braceOpen = rest.indexOf('{')
    const braceClose = rest.indexOf('}')
    if (braceOpen < 0 || braceClose < braceOpen) {
      fail('槽 ' + d.slot + ' 的声明块无法解析（' + d.file + '）——上游写法变更，需人工核对')
      continue
    }
    const block = rest.slice(braceOpen, braceClose + 1)
    const kind = (/\bkind\s*:\s*'([a-z]+)'/.exec(block) ?? [, null])[1]
    const scope = (/\bscope\s*:\s*'([a-z]+)'/.exec(block) ?? [, null])[1]
    if (kind === null || scope === null) {
      fail('槽 ' + d.slot + ' 声明缺 kind/scope（' + d.file + ' 实测 kind=' + kind + ' scope=' + scope + '）')
      continue
    }
    const kindOk = kind === d.kind
    const scopeOk = scope === d.scope
    if (kindOk && scopeOk) {
      ok('槽 ' + d.slot + ' 声明面 == 实测（kind=' + d.kind + ' scope=' + d.scope + '）')
    } else {
      fail('槽 ' + d.slot + ' 声明漂移：实测 kind=' + kind + ' scope=' + scope
        + '，登记期望 kind=' + d.kind + ' scope=' + d.scope
        + '（kind 变更 = 并列/覆盖语义变了；scope 变更 = 注册作用域变了。改了上游就同步改 contract.json 并复核注入层注册面）')
    }
  }
}

/**
 * 上游生产槽位声明枚举（G-1 的反向半）。§4b 只遍历「我们登记的 5 条」，所以上游**新长出来**的槽
 * 永远不会被看见——rc.1 相对 0.1.5 就多了一个 `shell.leading`（14 文件命中 / 0.1.5 零命中），
 * 账本对它一无所知。这里改成「上游声明全集 == 已登记全集」的集合等值判据：多一条即红（要判一次），
 * 少一条也即红（上游删槽 = 我们的注册静默落空）。
 * @returns slot → {kind, scope, file}，上游树不在场时返回 null。
 */
function scanUpstreamSlots() {
  const clientDir = join(root, contract.upstreamRepo, 'packages', 'client')
  if (!existsSync(clientDir)) return null
  const files = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'tests' && entry.name !== '__tests__') walk(p)
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) files.push(p)
    }
  }
  walk(clientDir)
  const rootRel = root.replaceAll('\\', '/')
  const toRel = (f) => f.replaceAll('\\', '/').slice(rootRel.length + 1)
  /* 只认生产声明面：packages/client/<pkg>/src/**，且排除测试目录与 *.test.ts(x)——上游测试夹具里
   * 造了一批假槽名（test.list / dynamic.a / spec.single …），混进来会让登记集与真实槽位面无关。 */
  const upRe = contract.upstreamRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const isProdDecl = (p) => new RegExp('^' + upRe + '/packages/client/[^/]+/src/').test(p)
    && !/\/(?:tests?|__tests__)\//.test(p) && !/\.(test|spec)\.tsx?$/.test(p)
  /* 上游两种写法：单行 `'x': { kind: 'list'; scope: 'root' }` 与跨行（type 字面量里无分隔符），
   * 故 kind/scope 之间只要求空白。 */
  const re = /'([a-z][a-zA-Z0-9._-]*(?:\.[a-zA-Z0-9._-]+)+)'\s*:\s*\{\s*kind\s*:\s*'([a-z]+)'\s*;?\s*scope\s*:\s*'([a-z]+)'/g
  const found = new Map()
  for (const abs of files) {
    const f = toRel(abs)
    if (!isProdDecl(f)) continue
    const text = readFileSync(abs, 'utf8')
    let m
    re.lastIndex = 0
    while ((m = re.exec(text)) !== null) {
      if (!found.has(m[1])) found.set(m[1], { slot: m[1], kind: m[2], scope: m[3], file: f })
    }
  }
  return found
}

const CAPTURE_SLOTS = argv.includes('--capture-slots')
const slotReasonIdx = argv.indexOf('--accept-slot-diff')
const slotReason = slotReasonIdx >= 0 ? String(argv[slotReasonIdx + 1] ?? '') : ''

console.log('== 4c. 上游槽位全集（反向断言：上游新长出的槽必须判一次） ==')
{
  const universe = scanUpstreamSlots()
  if (universe === null) skip('上游树不在场 —— 槽位全集反向断言未执行')
  else if (universe.size === 0) fail('上游槽位枚举为空（树在场但一条没命中）—— 枚举范围/声明形态与判据假设不符，拒绝按空集继续判（这正是上一轮用 grep 误判 YAML 的那类事故）')
  else {
    const id = upstreamIdentity()
    const treeStamp = id === null ? 'unknown' : (id.describe ?? id.commit ?? 'unknown')
    let recorded = contract.clientSlots.upstreamUniverse
    if (recorded === undefined && !CAPTURE_SLOTS) {
      fail('contract.json 缺 clientSlots.upstreamUniverse：跑 `node scripts/check-contract.mjs --capture-slots --accept-slot-diff "<首次登记的理由>"` 生成')
    } else {
      const fresh = [...universe.values()].sort((a, b) => (a.slot < b.slot ? -1 : 1))
      const oldNames = new Map((recorded?.entries ?? []).map(e => [e.slot, e]))
      const added = fresh.filter(e => !oldNames.has(e.slot))
      const removed = [...oldNames.keys()].filter(s => !universe.has(s))
      const drifted = fresh.filter(e => oldNames.has(e.slot)
        && (oldNames.get(e.slot).kind !== e.kind || oldNames.get(e.slot).scope !== e.scope))
      if (CAPTURE_SLOTS) {
        if (added.length + removed.length + drifted.length > 0 && !slotReason.trim()) {
          fail('--capture-slots 会改判据范围（新增 ' + added.length + ' / 消失 ' + removed.length + ' / 漂移 ' + drifted.length + '），必须带 --accept-slot-diff "<理由>"')
        } else {
          contract.clientSlots.upstreamUniverse = {
            $comment: 'G-1 反向判据的登记集：上游**声明面**槽位全集（见 scanUpstreamSlots 的枚举范围），不是「上游一共有多少座位」的哲学断言——它只负责让「新长出来/被删掉」两类漂移判红。追版换树后必须重新 --capture-slots 并逐条判定新增项。',
            scanScope: 'packages/client/<pkg>/src/**（排除 tests/__tests__ 与 *.test.tsx）里的 `\'slot\': { kind: …; scope: … }`',
            capturedFrom: treeStamp,
            capturedReason: slotReason || (recorded?.capturedReason ?? '首次登记'),
            total: fresh.length,
            entries: fresh.map(e => ({ slot: e.slot, kind: e.kind, scope: e.scope, file: e.file })),
          }
          writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n')
          ok('--capture-slots 已登记 ' + fresh.length + ' 条上游槽位（树 ' + treeStamp + '，理由：' + contract.clientSlots.upstreamUniverse.capturedReason + '）'
            + (added.length + removed.length + drifted.length > 0
              ? '；本次范围变化：新增 ' + added.map(e => e.slot).join(',') + ' / 消失 ' + removed.join(',') + ' / 漂移 ' + drifted.map(e => e.slot).join(',')
              : ''))
        }
      } else if (recorded !== undefined) {
        if (recorded.capturedFrom !== treeStamp && treeStamp !== 'unknown') {
          fail('槽位全集登记自 ' + recorded.capturedFrom + '，当前上游树是 ' + treeStamp
            + '：换树后必须重跑 --capture-slots（否则 §4c 在拿旧集合判新树）')
        }
        if (added.length > 0) {
          fail('上游长出未登记的槽（' + added.length + ' 条）: ' + added.map(e => e.slot + '[' + e.kind + '/' + e.scope + ']').join(', ')
            + ' —— 每条要么显式判定不消费、要么登记消费面；判完再 --capture-slots --accept-slot-diff "<这一版判了什么>"')
        }
        if (removed.length > 0) {
          fail('上游删除了已登记的槽: ' + removed.join(', ')
            + ' —— 我们若仍注册它即静默落空（消费面判据 §4b 会单独报 kind/scope，这里先报「槽没了」）')
        }
        if (drifted.length > 0) {
          fail('上游槽 kind/scope 漂移: ' + drifted.map(e => e.slot + ' 登记=' + oldNames.get(e.slot).kind + '/' + oldNames.get(e.slot).scope + ' 现=' + e.kind + '/' + e.scope).join('; '))
        }
        if (added.length + removed.length + drifted.length === 0 && recorded.capturedFrom === treeStamp) {
          ok('上游槽位全集 == 登记（' + recorded.total + ' 条，树 ' + treeStamp + '；我们消费 ' + contract.clientSlots.declarations.length + ' 条）')
        }
      }
    }
  }
}

console.log('== 5. 环境契约键 ==')
const envText = readFileSync(join(root, contract.envContract.repo, 'src/index.ts'), 'utf8')
for (const key of contract.envContract.keys) {
  if (envText.includes(key)) ok('环境键 ' + key + ' 注入')
  else fail('环境键 ' + key + ' 未注入')
}

console.log('== 6. 版本钉（package.json vs contract.json；覆盖面 = scripts/plugin-dirs.json） ==')
// 覆盖清单（0.13.8-b ST-06 / F-ENV-05）：注入集单一常量的每个包都必须登记进 contract.inserted，
// 否则「peer 版本钉」对它们没有覆盖面（契约少登记一个包 = 该包的钉永远不被检查）。
const pluginManifest = JSON.parse(readFileSync(join(root, 'scripts', 'plugin-dirs.json'), 'utf8'))
const insertedRepos = new Set(contract.inserted.map(i => i.repo))
const uncovered = pluginManifest.dirs.filter(d => !insertedRepos.has(d))
if (uncovered.length > 0) fail('注入集未登记进 contract.inserted（版本钉无覆盖面）: ' + uncovered.join(', '))
else ok('注入集 ' + pluginManifest.dirs.length + ' 个包全部登记在 contract.inserted')

// 版本钉两面（devDependencies + peerDependencies）都要钉：只看 dev 会漏掉「发布面钉旧版」。
// 说明符允许 ^/~ 前缀（区间语义仍指向同一版本），其余严格等值。
const norm = (spec) => String(spec).replace(/^[\^~]/, '')
const expectedPin = (dep) => dep === '@deepseek-ai/cordis' ? contract.cordis
  : dep === '@deepseek-ai/schemastery' ? contract.schemastery
  : contract.baseline // @deepseek-ai/dsh-*
const isPinnedDep = (dep) => dep.startsWith('@deepseek-ai/dsh-')
  || dep === '@deepseek-ai/cordis' || dep === '@deepseek-ai/schemastery'
const deviations = (repo) => {
  const pkg = JSON.parse(readFileSync(join(root, repo, 'package.json'), 'utf8'))
  const out = new Set()
  for (const [dep, spec] of Object.entries({ ...(pkg.peerDependencies ?? {}), ...(pkg.devDependencies ?? {}) })) {
    if (!isPinnedDep(dep)) continue
    if (norm(spec) !== norm(expectedPin(dep))) out.add(dep + '@' + norm(spec))
  }
  return out
}
// 未对齐的显式声明（scripts/contract-pin-gaps.json）：§8.4 要求先对齐基线再扩门禁，
// 声明期内在场 = 红-able；对齐后条目变 stale 也会红，必须删除。
const gapsPath = join(root, 'scripts', 'contract-pin-gaps.json')
const pinGaps = existsSync(gapsPath) ? (JSON.parse(readFileSync(gapsPath, 'utf8')).gaps ?? []) : []
for (const ins of contract.inserted) {
  if (!existsSync(join(root, ins.repo, 'package.json'))) continue // 仓库缺失已在第 2 节报过
  const actual = [...deviations(ins.repo)].sort()
  const gap = pinGaps.find(g => g.repo === ins.repo)
  if (gap === undefined) {
    if (actual.length > 0) {
      fail(ins.repo + ': 版本钉偏离且未声明: ' + actual.join(', ')
        + '（基线 ' + contract.baseline + ' / cordis ' + contract.cordis + ' / schemastery ' + contract.schemastery + '）')
    } else ok(ins.repo + ': 版本钉 == 基线/cordis/schemastery')
    continue
  }
  if (!gap.reason || !String(gap.reason).trim()) { fail(ins.repo + ': contract-pin-gaps 条目缺 reason'); continue }
  const accepted = [...new Set(gap.accepted ?? [])].sort()
  const undeclared = actual.filter(d => !accepted.includes(d))
  const stale = accepted.filter(d => !actual.includes(d))
  if (undeclared.length > 0 || stale.length > 0) {
    fail(ins.repo + ': 声明与事实不符（未声明偏离: [' + undeclared.join(', ') + ']；已对齐却仍声明: [' + stale.join(', ') + ']）')
  } else ok(ins.repo + ': 版本钉偏离已显式声明（' + accepted.length + ' 项，基线 ' + contract.baseline + '）')
}
for (const g of pinGaps) {
  if (!contract.inserted.some(i => i.repo === g.repo)) {
    fail('contract-pin-gaps 声明了未登记进 contract.inserted 的仓库: ' + g.repo)
  }
}
ok('版本钉检查完成')

/**
 * §7 运行期兼容门禁（0.14.2 追版 N-1；AGENTS 铁律的「发版闸门」前置）。
 *
 * 上游从 0.1.7 起在 boot 期按 `package.json.peerDependencies` 判插件兼容性，不满足就**把整行置
 * disabled 并只在 stderr 打一行**（`packages/boot/app-boot/src/plugin-compatibility.ts:61-88`
 * + `compatibility-preflight.ts`）：进程照起、页面照开，只有我们的 shell 执行栅栏与响应式客户端
 * UI 双双缺席。本门禁把**同一个算法**在构建前跑一遍——判据必须与运行时逐字同构，否则门禁绿而设备丢插件。
 *
 * 运行时版本取自安装闭包（`engine-overlay.json` 的 `@deepseek-ai/dsh-app-boot`），**不是**
 * contract.baseline：设备上跑的是 overlay 说的那个版本，两者一旦不同步，说谎的是登记表 ⇒ 判红。
 */
console.log('== 7. 运行期兼容门禁（复刻上游 boot 期 peer 判定；不匹配即静默禁用） ==')

/** 解析与运行时同一个 semver：优先仓内/快照/全局引擎自带的副本（判据必须与设备侧同构）。 */
function resolveSemver() {
  const candidates = [
    join(root, 'node_modules', 'semver'),
    join(root, 'dsh', 'node_modules', 'semver'),
    join(root, '.deploy-tmp', 'snapshot-013', 'x86_64', 'stage', 'root', 'usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'semver'),
    join(root, '.deploy-tmp', 'snapshot-013', 'arm64', 'stage', 'root', 'usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'semver'),
  ]
  for (const repo of pluginManifest.dirs) candidates.push(join(root, repo, 'node_modules', 'semver'))
  for (const dir of candidates) {
    if (!existsSync(join(dir, 'package.json'))) continue
    try {
      const req = createRequire(join(dir, 'noop.js'))
      const mod = req(join(dir, 'index.js'))
      if (typeof mod?.satisfies === 'function') {
        return { satisfies: mod.satisfies, origin: dir.slice(root.length + 1).replaceAll('\\', '/'), version: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version }
      }
    } catch { /* 副本不可用：继续找下一个候选 */ }
  }
  try {
    const req = createRequire(join(root, 'check-contract.mjs'))
    const mod = req('semver')
    if (typeof mod?.satisfies === 'function') return { satisfies: mod.satisfies, origin: 'bare semver', version: '(未记)' }
  } catch { /* 未安装 */ }
  return null
}

const overlayPath = join(root, 'scripts', 'snapshot-config', 'engine-overlay.json')
const runtimeOverrideIdx = argv.indexOf('--runtime')
const runtimeOverride = runtimeOverrideIdx >= 0 ? String(argv[runtimeOverrideIdx + 1] ?? '') : null
const semverImpl = resolveSemver()

if (!existsSync(overlayPath) || !existsSync(PROFILE_PATCH_PATH) || semverImpl === null) {
  const missing = [
    existsSync(overlayPath) ? null : 'engine-overlay.json',
    existsSync(PROFILE_PATCH_PATH) ? null : 'profile-web.cordis.patch.yml',
    semverImpl === null ? 'semver（设备侧 app-boot 用的同一个库）' : null,
  ].filter(Boolean)
  skip('运行期兼容门禁缺输入: ' + missing.join(' + ')
    + (semverImpl === null ? ' —— 取用面：快照 stage 的 @deepseek-ai/dsh/node_modules/semver（跑过 build-snapshot 即在）、任一插件的 node_modules/semver，或 contract.json 同层 npm 安装；本门禁只在拿不到时 SKIP，拿到即必判' : ''))
} else {
  const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
  const runtimePinned = overlay.packages['@deepseek-ai/dsh-app-boot']
  const runtime = runtimeOverride ?? runtimePinned
  if (runtime === undefined) fail('engine-overlay.json 里没有 @deepseek-ai/dsh-app-boot 钉 —— 运行时版本无从确定')
  else {
    if (runtimeOverride !== null) console.log('  NOTE  --runtime=' + runtimeOverride + ' 是**反证用覆盖**（不是设备事实）：把目标运行时装成下一版，验本门禁会不会判红')
    if (runtimePinned !== overlay.engineVersion) fail('overlay.engineVersion=' + overlay.engineVersion + ' ≠ packages[@deepseek-ai/dsh-app-boot]=' + runtimePinned + '（登记表内部不自洽）')
    if (runtimeOverride === null && runtimePinned !== contract.baseline) {
      fail('安装闭包运行时 ' + runtimePinned + ' ≠ contract.baseline ' + contract.baseline
        + '：§1/§3/§4 的上游面判据在拿 baseline 那棵树判、设备却跑 ' + runtimePinned + '（追版两步没走完：切树 + 抬登记表）')
    } else if (runtimeOverride === null) ok('运行时版本 == baseline == overlay app-boot 钉（' + runtimePinned + '）')
    console.log('  INFO  semver 取用: ' + semverImpl.origin + '（v' + semverImpl.version + '，与设备侧 app-boot 用的同一实现）')

    let ourMountRows
    try { ourMountRows = parseCordisRows(readFileSync(PROFILE_PATCH_PATH, 'utf8'), '本机 profile-web.cordis.patch.yml') } catch (e) { fail(String(e.message ?? e)) }
    if (ourMountRows !== undefined) {
      const mounts = {
        inserts: ourMountRows.filter(r => r.inInsert),
        disabled: ourMountRows.filter(r => !r.inInsert && r.disabled).map(r => r.id),
      }
      ok('profile patch 解析: ' + mounts.inserts.length + ' 条 insert + ' + mounts.disabled.length + ' 条 disabled')
      const nameToRepo = new Map()
      for (const dir of [...pluginManifest.dirs, ...pluginManifest.externals]) {
        const pkgPath = join(root, dir, 'package.json')
        if (!existsSync(pkgPath)) continue
        nameToRepo.set(JSON.parse(readFileSync(pkgPath, 'utf8')).name, dir)
      }
      const mountNames = new Set(mounts.inserts.map(r => r.name))
      const ghostMounted = [...mountNames].filter(n => !n.startsWith('@deepseek-ai/') && !nameToRepo.has(n))
      if (ghostMounted.length > 0) fail('profile patch 挂了仓库里不存在的包（注入链会带一个空壳）: ' + ghostMounted.join(', '))
      const registeredNotMounted = contract.inserted.map(i => i.pkg).filter(n => !mountNames.has(n))
      if (registeredNotMounted.length > 0) fail('contract.inserted 登记但 profile patch 不挂载（幽灵登记）: ' + registeredNotMounted.join(', '))
      if (ghostMounted.length === 0 && registeredNotMounted.length === 0) ok('insert 行 ↔ 仓库/登记表 双向一致（' + mountNames.size + ' 条）')

      const compat = contract.runtimeCompat ?? {}
      const noPeerAdjudicated = new Map((compat.noPeerRows ?? []).map(r => [r.rowId, r]))
      const exemptions = compat.exemptions ?? []
      let judged = 0
      let rejected = 0
      for (const row of mounts.inserts) {
        if (row.name.startsWith('@deepseek-ai/')) {
          const pinned = overlay.packages[row.name]
          if (pinned === undefined) fail('insert 行 ' + row.id + ' 引用的引擎包 ' + row.name + ' 不在安装闭包（挂载静默失败）')
          else if (pinned !== runtimePinned) fail('insert 行 ' + row.id + ' 的 ' + row.name + '@' + pinned + ' ≠ 运行时 ' + runtimePinned + '（跨版混挂：上游 peer 门禁会拒）')
          else { judged += 1; ok('insert ' + row.id + ': 引擎包 ' + row.name + '@' + pinned + ' 与运行时同版') }
          continue
        }
        const repo = nameToRepo.get(row.name)
        if (repo === undefined) continue // 上面已按幽灵判红
        const pkg = JSON.parse(readFileSync(join(root, repo, 'package.json'), 'utf8'))
        const peers = pkg.peerDependencies
        if (peers === undefined || Object.keys(peers).length === 0
          || !Object.keys(peers).some(n => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'))) {
          /* 上游算法在这里是 fail-open（plugin-compatibility.ts:68「无 peerDependencies 键即放行」）
           * ⇒ 门禁反过来要求显式判定：不声明 peer 的行走的是「上游不管」而不是「验过兼容」。 */
          const adjud = noPeerAdjudicated.get(row.id)
          if (adjud === undefined) fail('insert ' + row.id + '（' + row.name + '）没有任何 @deepseek-ai/dsh* peer —— 上游按 fail-open 放行，但那是"没判"不是"兼容"：请在 contract.runtimeCompat.noPeerRows 登记判定与理由')
          else if (!adjud.why || !String(adjud.why).trim()) fail('noPeerRows[' + row.id + '] 缺 why')
          else { judged += 1; ok('insert ' + row.id + ': 无 dsh peer，已显式判定（' + adjud.why + '）') }
          continue
        }
        const bad = {}
        for (const [name, range] of Object.entries(peers)) {
          if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
          if (typeof range !== 'string') { fail('insert ' + row.id + ' 的 peerDependencies[' + name + '] 不是字符串（上游会 throw，整个清单读不出）'); continue }
          const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtime : range
          if (requirement.trim() === '' || !semverImpl.satisfies(runtime, requirement, { includePrerelease: true })) bad[name] = range
        }
        if (Object.keys(bad).length === 0) { judged += 1; ok('insert ' + row.id + '（' + pkg.name + '@' + pkg.version + '）peer 全部满足运行时 ' + runtime); continue }
        const key = pkg.name + '@' + pkg.version
        const grant = exemptions.find(e => e.key === key && e.runtime === runtime)
        if (grant !== undefined && grant.why) {
          judged += 1
          fail('insert ' + row.id + ' 走了精确豁免（' + key + ' on ' + runtime + '）：设备侧 compatibility.json 会放行，但豁免按「插件版本 × 运行时版本」精确匹配，任一变动即重新判红 —— 本版不允许带着它发布，请抬 peer')
          rejected += 1
          continue
        }
        rejected += 1
        fail('insert ' + row.id + '（' + key + '）在运行时 ' + runtime + ' 会被**静默禁用**：不满足的 peer = '
          + JSON.stringify(bad) + ' —— 症状是设备上功能面消失而进程照常起（stderr 只有一行 disabling profile plugin row）。'
          + '处置：把这些 peer 抬到 ' + runtime + '（不是留兼容性豁免），或按上游 `dsh plugin allow-version` 显式登记进 contract.runtimeCompat.exemptions 并说明为什么本版必须留。')
      }
      console.log('  INFO  运行期兼容判定：' + judged + ' 条过、' + rejected + ' 条会被禁用（insert 共 ' + mounts.inserts.length + ' 条），semver 语义 = includePrerelease:true')
    }
  }
}

/**
 * cordis patch 文件的行解析（§7 与 §8 共用一份，避免「我们的文件按固定缩进解析、上游的文件按另一套
 * 正则解析」这种双标——上一轮的教训正是拿 grep 猜 YAML 序列成员）。
 * 归属规则用**缩进**：`- id:` 之后的同块属性必须比该 `-` 更缩进；`- insert:` 之下的行才是插行。
 * @returns 每行 {id, name, disabled, inInsert}
 * @throws 形态与假设不符时抛出（调用方判红）——绝不按空集合继续。
 */
function parseCordisRows(text, label) {
  const lines = String(text).split(/\r?\n/)
  const rows = []
  let cur = null
  let insertDepth = null
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const ind = raw.length - raw.trimStart().length
    const ins = /^(\s*)- insert:\s*$/.exec(raw)
    if (ins !== null) { insertDepth = ins[1].length; cur = null; continue }
    if (insertDepth !== null && ind <= insertDepth) insertDepth = null
    const idm = /^(\s*)- id:\s*(\S+)\s*$/.exec(raw)
    if (idm !== null) {
      cur = { id: idm[2], name: null, disabled: false, indent: idm[1].length, inInsert: insertDepth !== null }
      rows.push(cur)
      continue
    }
    if (cur === null) continue
    if (ind <= cur.indent) { cur = null; continue }
    const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw)
    if (kv === null) continue
    if (kv[1] === 'name' && cur.name === null) cur.name = kv[2].trim().replace(/^['"]|['"]$/g, '')
    else if (kv[1] === 'disabled') cur.disabled = /^true\b/.test(kv[2].trim())
  }
  const unnamed = rows.filter(r => r.inInsert && r.name === null)
  if (unnamed.length > 0) throw new Error(label + ': insert 行缺 name（形态与判据假设不符，需人工核对）: ' + unnamed.map(r => r.id).join(', '))
  if (rows.length === 0) throw new Error(label + ': 解析结果为空——拒绝按空集继续判')
  return rows
}

/** 上游 bundle（base + web-app）出现的全部行 id；任一 bundle 不在场即返回 null（由调用方 SKIP）。 */
function scanUpstreamRows() {
  const out = new Map()
  for (const bundle of ['base', 'web-app']) {
    const p = join(root, contract.upstreamRepo, 'packages', 'bundle', bundle, 'cordis.patch.yml')
    if (!existsSync(p)) return null
    let rows
    try { rows = parseCordisRows(readFileSync(p, 'utf8'), '上游 ' + bundle + ' bundle') }
    catch (e) { fail(String(e.message ?? e)); continue }
    for (const r of rows) if (!out.has(r.id)) out.set(r.id, { key: r.id, name: r.name ?? '', upstreamDisabled: r.disabled, bundle })
  }
  return out
}

const CAPTURE_ROWS = argv.includes('--capture-rows')
const rowReasonIdx = argv.indexOf('--accept-row-diff')
const rowReason = rowReasonIdx >= 0 ? String(argv[rowReasonIdx + 1] ?? '') : ''

console.log('== 8. 上游行面不变量（G-4：我们禁用的行必须还在；上游新增行必须判一次） ==')
{
  const upRows = scanUpstreamRows()
  if (upRows === null) skip('上游 bundle patch 不在场 —— 行面不变量未执行')
  else if (upRows.size === 0) fail('上游行枚举为空——解析器与上游形态不符，拒绝按空集继续判')
  else if (!existsSync(PROFILE_PATCH_PATH)) skip('profile patch 不在场 —— 行面不变量未执行')
  else {
    let ourRows
    try { ourRows = parseCordisRows(readFileSync(PROFILE_PATCH_PATH, 'utf8'), '本机 profile-web.cordis.patch.yml') }
    catch (e) { fail(String(e.message ?? e)) }
    if (ourRows !== undefined) {
      /* (a) 每个 `disabled: true` 的目标必须在上游存在。判红理由要说清「静默」在哪：
       * 我们禁用一条上游已改名/已删除的行 = 这行 YAML 变成无害的空指向，而上游那条真行**照常挂载**
       * —— 0.14.1 的 client-hmr 与 rc.1 的 hmr/dsh-hmr 换名就是这个形态。 */
      const ourDisabled = ourRows.filter(r => !r.inInsert && r.disabled)
      const ghost = ourDisabled.filter(r => !upRows.has(r.id))
      if (ourDisabled.length === 0) fail('profile patch 解析出 0 条 disabled 顶层行——与现网形态不符（实测应为 6 条），判红不放行')
      else if (ghost.length > 0) {
        fail('profile patch 禁用了上游不存在的行（禁用即空指向，上游那条真行照常挂载）: '
          + ghost.map(r => r.id).join(', ') + ' —— 上游改名/删除时必然出现；请核对新行 id 后改 profile，别删了这条 YAML 当没事发生')
      } else ok('profile patch 的 ' + ourDisabled.length + ' 条 disabled 目标全部在上游存在（base+web-app 共 ' + upRows.size + ' 个行 id）')
      const alreadyUp = ourDisabled.filter(r => upRows.has(r.id) && upRows.get(r.id).upstreamDisabled)
      if (alreadyUp.length > 0) {
        console.log('  NOTE  其中 ' + alreadyUp.length + ' 条上游自己就带 disabled: true（我们的禁用是二次声明，无害但冗余）: '
          + alreadyUp.map(r => r.id).join(', '))
      }
      /* (b) 上游行全集 == 登记集：新增行必须判一次（挂 or 禁），删除行必须看见。 */
      const id = upstreamIdentity()
      const treeStamp = id === null ? 'unknown' : (id.describe ?? id.commit ?? 'unknown')
      const fresh = [...upRows.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
      let recorded = contract.upstreamRows
      const cmpOf = (rec) => {
        const old = new Map(rec.entries.map(e => [e.key, e]))
        return {
          old,
          added: fresh.filter(f => !old.has(f.key)),
          removed: [...old.keys()].filter(k => !upRows.has(k)),
          drifted: fresh.filter(f => old.has(f.key) && (old.get(f.key).name !== f.name || old.get(f.key).bundle !== f.bundle)),
        }
      }
      if (recorded === undefined && !CAPTURE_ROWS) {
        fail('contract.json 缺 upstreamRows：跑 `node scripts/check-contract.mjs --capture-rows --accept-row-diff "<理由>"` 生成')
      } else if (CAPTURE_ROWS) {
        if (recorded !== undefined) {
          const c = cmpOf(recorded)
          if (c.added.length + c.removed.length + c.drifted.length > 0 && !rowReason.trim()) {
            fail('--capture-rows 会改判据范围（新增 ' + c.added.length + ' / 消失 ' + c.removed.length + ' / 漂移 ' + c.drifted.length + '），必须带 --accept-row-diff "<这一版判了什么>"')
          } else {
            contract.upstreamRows = {
              $comment: 'G-4 判据的登记集：上游 base + web-app 两个 bundle 的全部行 id（含我们未挂载的）。新增行必须逐条判「挂载 / 明确不挂」后重新登记——0.14.2 追版时 `mcp-resources` 这类新行走的就是这里。',
              capturedFrom: treeStamp, capturedReason: rowReason || '首次登记', total: fresh.length, entries: fresh,
            }
            writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n')
            ok('--capture-rows 已登记 ' + fresh.length + ' 条上游行 id（树 ' + treeStamp + '）')
          }
        } else {
          contract.upstreamRows = {
            $comment: 'G-4 判据的登记集：上游 base + web-app 两个 bundle 的全部行 id（含我们未挂载的）。新增行必须逐条判「挂载 / 明确不挂」后重新登记。',
            capturedFrom: treeStamp, capturedReason: rowReason || '首次登记', total: fresh.length, entries: fresh,
          }
          writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n')
          ok('--capture-rows 已登记 ' + fresh.length + ' 条上游行 id（树 ' + treeStamp + '）')
        }
      } else {
        if (recorded.capturedFrom !== treeStamp && treeStamp !== 'unknown') {
          fail('上游行集登记自 ' + recorded.capturedFrom + '，当前上游树是 ' + treeStamp + '：换树后必须重跑 --capture-rows')
        } else {
          const c = cmpOf(recorded)
          if (c.added.length > 0) {
            fail('上游新增未判定的行（' + c.added.length + ' 条）: '
              + c.added.map(e => e.key + '(' + e.name + '@' + e.bundle + (ourRows.some(r => r.id === e.key) ? ', 我们已挂/已禁' : '') + ')').join(', ')
              + ' —— 每条都要判「挂载还是禁用」；默认不判 = 上游往移动设备上塞了一个我们没审过的面（G-2 的 mcp-resources 就是这个形态）')
          }
          if (c.removed.length > 0) fail('上游删除了已登记的行: ' + c.removed.join(', ') + '（我们若仍引用它即空指向）')
          if (c.drifted.length > 0) fail('上游行的包名/bundle 归属漂移: ' + c.drifted.map(e => e.key + ' 登记=' + c.old.get(e.key).name + '@' + c.old.get(e.key).bundle + ' 现=' + e.name + '@' + e.bundle).join('; '))
          if (c.added.length + c.removed.length + c.drifted.length === 0) {
            ok('上游行全集 == 登记（' + recorded.total + ' 条，树 ' + treeStamp + '）')
          }
        }
      }
    }
  }
}

console.log('== 9. 人读契约文档与登记表同源（G-8：它会误导开工） ==')
{
  /* docs/UPSTREAM-CONTRACT.md 历史上把清单复述了一遍，然后三次追版没人同步：基线停在 0.1.0-rc.6、
   * 禁用行名单里留着早已启用的 ui-layout、继承面写着上游已删的 runArgv/startArgv。
   * 现在它是「只讲语义」的文档，但仍会误导 ⇒ 至少把它与登记表的可锚定字段钉死：基线字样 + 非权威源声明。 */
  const docPath = DOC_PATH
  if (!existsSync(docPath)) skip('docs/UPSTREAM-CONTRACT.md 不在场（apk 自包含树合法缺席）—— 文档同源性未执行')
  else {
    const doc = readFileSync(docPath, 'utf8')
    if (!doc.includes(contract.baseline)) {
      fail(rel(docPath) + ' 不含当前基线 ' + contract.baseline
        + '：文档里的版本/成员名是上一基线的（正是它把开工的人带错路的那次）。抬 baseline 时同批改文档。')
    } else ok('文档基线字样 == contract.baseline（' + contract.baseline + '）')
    if (!/非权威源/.test(doc) || !/contract\.json/.test(doc)) {
      fail(rel(docPath) + ' 必须显式声明「权威源是 scripts/contract.json」——它读起来像权威源时，漂移比缺席更危险')
    } else ok('文档已声明自己非权威源并指向 contract.json')
  }
}

if (skipped > 0) console.log('SKIP=' + skipped)
if (issues.length > 0) {
  console.error('')
  console.error('CONTRACT FAIL (' + issues.length + '):')
  for (const i of issues) console.error('  - ' + i)
  process.exit(1)
}
console.log('')
console.log('CONTRACT PASS（SKIP=' + skipped + '）')

/**
 * 反证夹具：每条新判据配一个「改坏必须判红」的用例。
 * 每个用例把改坏的登记表/装配清单写进临时目录，用 --contract / --profile 指给子进程 ⇒
 * 仓库文件全程不动（`--capture-*` 也不会被触发，因为子进程不带捕获档）。
 */
function runContractSelfTest() {
  const gateFile = fileURLToPath(import.meta.url)
  const pristineContract = JSON.parse(readFileSync(join(root, 'scripts', 'contract.json'), 'utf8'))
  const pristineProfile = readFileSync(join(root, 'scripts', 'profile-web.cordis.patch.yml'), 'utf8')
  const pristineDoc = existsSync(join(root, 'docs', 'UPSTREAM-CONTRACT.md'))
    ? readFileSync(join(root, 'docs', 'UPSTREAM-CONTRACT.md'), 'utf8') : null
  const scratch = mkdtempSync(join(tmpdir(), 'contract-selftest-'))
  const dropSlot = (c) => { c.clientSlots.upstreamUniverse.entries = c.clientSlots.upstreamUniverse.entries.filter(e => e.slot !== 'shell.overlay') }
  const fakeSlot = (c) => { c.clientSlots.upstreamUniverse.entries.push({ slot: 'zzz.selftest.not.upstream', kind: 'list', scope: 'root', file: 'nowhere' }) }
  const cases = [
    { label: '对照组：现状登记表必须全绿', expect: null },
    { label: '§0 树身份判红：登记的 commit 不是树上的 commit', mutate: c => { c.upstream.commit = 'aa00000000000000000000000000000000000000' }, expect: /≠ 登记 commit/ },
    { label: '§4b 声明面判红：把某槽登记的 kind 改成单值', mutate: c => { c.clientSlots.declarations[0].kind = 'single' }, expect: /声明漂移/ },
    { label: '§4c 反向判红：登记集漏一条（上游实有 = 未登记的槽）', mutate: dropSlot, expect: /上游长出未登记的槽/ },
    { label: '§4c 反向判红：登记集多一条（上游已无 = 静默落空）', mutate: fakeSlot, expect: /上游删除了已登记的槽/ },
    { label: '§4c 反向判红：登记的 kind 与上游声明不一致', mutate: c => { c.clientSlots.upstreamUniverse.entries.find(e => e.slot === 'settings.section').kind = 'chain' }, expect: /kind\/scope 漂移/ },
    { label: '§4c 树身份判红：登记集来自另一棵树', mutate: c => { c.clientSlots.upstreamUniverse.capturedFrom = 'dsh-v0.0.0-selftest' }, expect: /槽位全集登记自 dsh-v0\.0\.0-selftest/ },
    { label: '§8 行面判红：禁用了一条上游不存在的行（改名/删除形态）', profile: t => t.replace('- id: client-hmr', '- id: client-hmr-upstream-renamed'), expect: /禁用了上游不存在的行/ },
    { label: '§8 行面判红：上游行登记集多一条', mutate: c => { c.upstreamRows.entries.push({ key: 'zzz-selftest-row', name: '@dsh-android/nope', upstreamDisabled: false, bundle: 'base' }) }, expect: /上游删除了已登记的行/ },
    { label: '§8 行面判红：上游行登记集漏一条', mutate: c => { c.upstreamRows.entries = c.upstreamRows.entries.filter(e => e.key !== 'timer') }, expect: /上游新增未判定的行/ },
    { label: '§7 幽灵插行判红：profile 挂了一个仓库里不存在的包', profile: t => t.replace("'@dsh-android/dsh-host-web-compat'", "'@dsh-android/dsh-nope'"), expect: /profile patch 挂了仓库里不存在的包/ },
    { label: '§7 fail-open 判红：抹掉无 peer 行的显式判定', mutate: c => { c.runtimeCompat.noPeerRows = [] }, expect: /没有任何 @deepseek-ai\/dsh\* peer/ },
    /* 反证要钉在「未来的运行时」上没有意义（抬版后它就变成现状）；这里装一个任何 peer
     * 都不可能满足的版本，判据必须逐行判红——这才与追版进度无关。 */
    { label: '§7 静默禁用判红：运行时装成不可满足的 0.0.1-rc.1（每行 peer 都必须被拒）', extra: ['--runtime', '0.0.1-rc.1'], expect: /会被\*\*静默禁用\*\*/ },
    { label: '§9 文档同源判红：文档里的基线字样被抹掉', doc: t => t.split(contract.baseline).join('0.0.0-stale'), expect: /不含当前基线/ },
    { label: '§9 文档同源判红：文档删掉「非权威源」声明（漂移比缺席更危险的那种）', doc: t => t.replace(/非权威源/g, '参考'), expect: /必须显式声明/ },
  ]
  let bad = 0
  let inertCount = 0
  /* 用例属于哪一节由 label 前缀决定（§7 需要安装闭包+semver；§0/§4/§8 需要上游 checkout）。
   * 反例落不红有两种原因必须分开：判据失灵（真事故） vs 本布局压根没跑那段判据
   * ——apk 自包含树没有 dsh/ checkout，若把「没跑」报成 PASS，镜像侧的 SELFTEST PASS 就是在
   * 替一节没执行的代码背书，所以这里如实报 N/A 并单独计数。 */
  const NA_REASONS = {
    compat: /运行期兼容门禁缺输入/,
    tree: /上游树 |上游声明文件不在场|上游 bundle patch 不在场|槽位全集反向断言未执行|行面不变量未执行|上游树身份未执行/,
    doc: /文档同源性未执行/,
  }
  const needKind = (label) => label.startsWith('§7') ? 'compat'
    : label.startsWith('§9') ? 'doc' : /^§[048]/.test(label) ? 'tree' : null
  for (const [i, kase] of cases.entries()) {
    const c = structuredClone(pristineContract)
    if (kase.mutate !== undefined) kase.mutate(c)
    const cPath = join(scratch, 'contract-' + i + '.json')
    const pPath = join(scratch, 'profile-' + i + '.yml')
    writeFileSync(cPath, JSON.stringify(c, null, 2) + '\n')
    writeFileSync(pPath, kase.profile === undefined ? pristineProfile : kase.profile(pristineProfile))
    const dPath = kase.doc === undefined || pristineDoc === null ? null : join(scratch, 'doc-' + i + '.md')
    if (dPath !== null) writeFileSync(dPath, kase.doc(pristineDoc))
    const r = spawnSync(process.execPath,
      [gateFile, '--contract', cPath, '--profile', pPath, ...(dPath === null ? [] : ['--doc', dPath]), ...(kase.extra ?? [])],
      { encoding: 'utf8' })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    const firstFail = (out.split(/\r?\n/).find(l => /^\s+FAIL/.test(l)) ?? '').trim()
    /* expect === null 的对照组要求「红不许出现」；其余用例要求「必须红，且红在本判据上」——
     * 只判 exitCode 会被别处的红蒙对，所以这里匹配的是判据文案。 */
    const kind = needKind(kase.label)
    const inert = kase.expect !== null && r.status === 0 && kind !== null && NA_REASONS[kind].test(out)
    const hit = inert ? true
      : kase.expect === null ? (r.status === 0 && !/^\s+FAIL/m.test(out)) : (r.status !== 0 && kase.expect.test(out))
    console.log((inert ? 'N/A   ' : hit ? 'PASS  ' : 'FAIL  ') + kase.label
      + (inert ? ' -> 本布局未执行该段判据（缺上游 checkout / 安装闭包输入），此例不计自证'
        : hit ? '' : ' -> exit=' + r.status + (kase.expect === null ? '（对照组出现红）' : '；首条红: ' + firstFail.slice(0, 130))))
    if (!hit) bad += 1
    if (inert) inertCount += 1
  }
  rmSync(scratch, { recursive: true, force: true })
  console.log(bad === 0
    ? '\nCONTRACT SELFTEST PASS（判红自证 ' + (cases.length - inertCount) + ' 例全中'
      + (inertCount > 0 ? '；另 ' + inertCount + ' 例本布局未执行，未计自证' : '') + '）'
    : '\nCONTRACT SELFTEST FAILED ' + bad + '/' + cases.length)
  process.exit(bad === 0 ? 0 : 1)
}
