#!/usr/bin/env node
// probe-engine-anchors.mjs — 在「补丁施加前」的引擎产物上跑锚点命中矩阵
// 施加对象是 .deploy-tmp/anchor-probe-<引擎版>/root 下的 tgz 副本：仓库、stage、快照都不碰。
//
// 为什么需要它（0.14.2 两条实锤）：
//   1) 拿 stage 目录当探针根 = 拿上一次的陈旧解包现场当现状。本轮实测 stage 里仍是 0.1.2-rc.1
//      引擎树（构建的中间态并不总与登记表同版本），据此得出的「锚点命中」结论全是错的。
//   2) 补丁测试的夹具是写死版本的 0.1.5 副本，补丁在真树上全断而 16 个测试全绿。
// 本脚本的真值源 = engine-overlay.json 的 (包名, 版本) → .deploy-tmp/engine-overlay/ 里构建期
// 实际拉取过的 tgz。那批 tgz 就是 overlay 写进 stage 的字节，与快照内的引擎内容同源。
//
// 用法：
//   node scripts/probe-engine-anchors.mjs                 # 全量 engine 补丁命中矩阵
//   node scripts/probe-engine-anchors.mjs --only <id,..>  # 单条
//   node scripts/probe-engine-anchors.mjs --fixtures      # 顺带把纯净产物写成补丁测试夹具（随版）
//   node scripts/probe-engine-anchors.mjs --clean         # 只清探针根不重跑
// 退出码：0 = 全部命中（或已应用）；1 = 有锚点未命中；2 = 用法/前置（缓存缺失等）。
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const NM_PREFIX = 'usr/lib/node_modules/@deepseek-ai/dsh/'
const CACHE = join(ROOT, '.deploy-tmp', 'engine-overlay')

const args = process.argv.slice(2)
const badFlag = args.filter((a) => a.startsWith('-') && !['--only', '--clean', '--engine', '--fixtures'].includes(a))
if (badFlag.length) {
  console.error('未知参数: ' + badFlag.join(' ') + '\n用法: node scripts/probe-engine-anchors.mjs [--only id,..] [--engine <ver>] [--fixtures|--clean]')
  process.exit(2)
}
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : null
if (onlyIdx >= 0 && !args[onlyIdx + 1]) { console.error('--only 需要逗号分隔的补丁 id'); process.exit(2) }
const engineIdx = args.indexOf('--engine')
const wantEngine = engineIdx >= 0 ? args[engineIdx + 1] : null

const contract = JSON.parse(readFileSync(join(ROOT, 'scripts', 'contract.json'), 'utf8'))
const overlayPath = join(ROOT, 'scripts', 'snapshot-config', 'engine-overlay.json')
const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
if (wantEngine && wantEngine !== overlay.engineVersion) {
  console.error(`登记表引擎为 ${overlay.engineVersion}，与 --engine ${wantEngine} 不符。`
    + ' 追版要先跑 gen-engine-overlay.mjs --write 重钉登记表，探针不提供跨版本拼树。')
  process.exit(2)
}
const probeRoot = join(ROOT, '.deploy-tmp', `anchor-probe-${overlay.engineVersion}`, 'root')
if (args.includes('--clean')) {
  rmSync(probeRoot, { recursive: true, force: true })
  console.log(`已清探针根: ${probeRoot}`)
  process.exit(0)
}

// ── 引擎路径 → (tgz 内文件) 的归属表 ──
// rootPackage 的 lib/bin.js 落在引擎根；其余三包（packages/vendorTop/pins）落在顶层 node_modules；
// nested 落在宿主包的 node_modules。keepUnpublished 不从 tgz 覆盖（树内保留基座旧版），
// 所以命中矩阵对它无效——单独判红而不是静默跳过，避免「探针说 OK」被当成真话。
const owners = new Map() // 引擎相对目录 -> { name, version, keepUnpublished? }
owners.set('', { name: overlay.rootPackage.name, version: overlay.rootPackage.version })
for (const group of ['packages', 'vendorTop', 'pins']) {
  for (const [name, version] of Object.entries(overlay[group] ?? {})) owners.set(`node_modules/${name}`, { name, version })
}
for (const [host, children] of Object.entries(overlay.nested ?? {})) {
  for (const [name, version] of Object.entries(children)) {
    owners.set(`node_modules/${host}/node_modules/${name}`, { name, version })
  }
}
const keepNames = new Set((overlay.keepUnpublished ?? []).map((e) => String(e).replace(/ \(.+$/, '').trim()))

/** 目标相对路径 → 最深匹配的包归属（'usr/lib/.../<pkg>/lib/x.js' 里最长的那段目录）。 */
function ownerOf(rel) {
  const parts = rel.split('/')
  for (let i = parts.length - 2; i >= 0; i--) {
    const dir = parts.slice(0, i + 1).join('/')
    const own = owners.get(dir)
    if (own) return { own, inner: parts.slice(i + 1).join('/') }
  }
  // 引擎根包自己的文件（lib/bin.js 等）：不属于任何 node_modules 子目录
  if (!rel.startsWith('node_modules/')) {
    const root = owners.get('')
    if (root) return { own: root, inner: rel }
  }
  return null
}

const tgzName = (name, version) => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`

/** npm tgz = gzip + ustar（前缀 `package/`）。纯 node 解，不依赖外部 tar（MSYS 会咬，坑 166）。 */
function readTgzFile(tgzPath, innerRel) {
  const buf = gunzipSync(readFileSync(tgzPath))
  const want = 'package/' + innerRel
  for (let off = 0; off + 512 <= buf.length; off += 512) {
    const name = buf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '')
    if (!name) break
    const prefix = buf.subarray(off + 345, off + 345 + 155).toString('utf8').replace(/\0.*$/, '')
    const full = prefix ? `${prefix}/${name}` : name
    const size = parseInt(buf.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8)
    const type = buf.subarray(off + 156, off + 157).toString('utf8')
    if (full === want && (type === '0' || type === '\0' || type === '')) {
      return buf.subarray(off + 512, off + 512 + size)
    }
    off += Math.ceil(size / 512) * 512
  }
  return null
}

const registry = JSON.parse(readFileSync(join(ROOT, 'scripts', 'patches', 'registry.json'), 'utf8'))
const targets = registry.patches.filter((p) => (p.scope ?? 'vendor') === 'engine')
/* 退役条目（registry.retired[]）**不施加补丁**，但**必须继续供夹具**：
 * 退役的前提是「上游已原生满足它」，而这个前提会随上游再次漂移 ⇒ 守卫测试必须直接对上游真产物断言。
 * 此前退役（A3/A5/C3）直接从 patches 删条目，夹具随之停供、守卫测试跑不起来（0.14.2 rc.2 追版实锤）。 */
const retiredTargets = (registry.retired ?? []).filter((p) => (p.scope ?? 'vendor') === 'engine')
const materialized = new Map() // tgz 文件 -> 命中它的补丁数
const problems = []

for (const p of [...targets, ...retiredTargets]) {
  if (only && !only.includes(p.id)) continue
  if (!p.target.startsWith(NM_PREFIX)) {
    problems.push(`${p.id}: 目标不在引擎树内（${p.target}）——探针只覆盖 engine scope`)
    continue
  }
  const rel = p.target.slice(NM_PREFIX.length)
  const owner = ownerOf(rel)
  if (!owner) { problems.push(`${p.id}: 找不到 ${p.target} 的包归属（登记表漂移）`); continue }
  const { name, version } = owner.own
  const cacheFile = join(CACHE, tgzName(name, version))
  if (!existsSync(cacheFile)) {
    problems.push(`${p.id}: ${name}@${version} 的 tgz 不在缓存（${tgzName(name, version)}）`
      + '——先跑一次快照构建拉取 overlay，或本探针无法代表构建期真字节')
    continue
  }
  const key = `${tgzName(name, version)}::${owner.inner}`
  let bytes = materialized.get(key)?.bytes
  if (bytes === undefined) {
    bytes = readTgzFile(cacheFile, owner.inner)
    materialized.set(key, { bytes, target: p.target, name, version, inner: owner.inner })
  }
  if (!bytes) { problems.push(`${p.id}: tgz 内没有 ${owner.inner}（${name}@${version}）`); continue }
  const dest = join(probeRoot, p.target)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, bytes)
}

if (problems.length) {
  console.error('探针前置未满足（不跑命中矩阵，避免半张表被当成全表）:')
  for (const m of problems) console.error('  - ' + m)
  process.exit(2)
}

// ── 夹具随版（--fixtures）：补丁测试的输入必须是它声称的那个引擎版本 ──
// 0.14.2 的实锤：补丁在 rc.1 真树上断 9 条，而 16 个补丁测试全绿——因为它们的夹具是 0.1.5 的副本。
// 夹具与真产物同源（同一批 tgz 的原始字节），「夹具版本 == contract.baseline」由
// scripts/check-patch-fixtures.mjs 把守；合成夹具（手写最小复现）必须在 manifest 里显式声明，
// 沉默不再是选项。
if (args.includes('--fixtures')) {
  if (only) {
    console.error('--fixtures 不能与 --only 同用：部分夹具集比没有夹具更危险')
    process.exit(2)
  }
  const fixRoot = join(HERE, 'patches', 'tests', 'fixtures')
  const manifestPath = join(fixRoot, 'manifest.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { $comment: '补丁测试夹具台账。source=engine-tgz 的目录由 probe-engine-anchors.mjs --fixtures 从构建期同一批 tgz 写出（内容与快照引擎树逐字节同源）；source=synthetic 的是手写最小复现，必须写明为何不用真产物。check-patch-fixtures.mjs 把「engine-tgz 夹具版本 == contract.baseline」与「每个 fixtures/*-<ver> 目录都在本台账内」两条判红。', fixtures: {} }
  const written = []
  for (const rec of materialized.values()) {
    if (!rec.bytes) continue
    const short = rec.name === overlay.rootPackage.name ? 'dsh-root' : rec.name.replace(/^@[^/]+\//, '')
    const dir = `${short}-${overlay.engineVersion}`
    const dest = join(fixRoot, dir, rec.inner)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, rec.bytes)
    manifest.fixtures[dir] = { source: 'engine-tgz', engine: overlay.engineVersion, package: `${rec.name}@${rec.version}`, files: [...new Set([...(manifest.fixtures[dir]?.files ?? []), rec.inner])] }
    written.push(`${dir}/${rec.inner}`)
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`夹具已随版写出 ${written.length} 个文件：\n  ` + written.join('\n  '))
  console.log(`合成/历史夹具仍由 manifest 声明：${Object.keys(manifest.fixtures).filter((d) => manifest.fixtures[d].source !== 'engine-tgz').join(', ') || '（无）'}`)
}

for (const p of targets) {
  const rel = p.target.slice(NM_PREFIX.length)
  const owner = ownerOf(rel)
  if (owner && keepNames.has(owner.own.name)) {
    console.log(`  注意: ${p.id} 的目标包 ${owner.own.name} 在 keepUnpublished 内`
      + `（树内保留基座 ${owner.own.version}），本矩阵的「命中」不代表它随版对齐`)
  }
}

console.log(`探针根: ${probeRoot}`)
console.log(`引擎 ${overlay.engineVersion} / 复现 ${[...materialized.values()].filter((v) => v.bytes).length} 个产物文件`)
// 为什么跑 --apply 而不是 --check：apply-patches 的 check() 语义是「补丁已施加？」，
// 对纯净产物树 check 模式必然把每一条都报成「缺席」——那不是命中矩阵，是同义反复。
// 真矩阵只有施加才能得到：锚点在 → [ok] applied，锚点漂 → [fail] + 精确原因。
// 落笔对象是 .deploy-tmp 下的探针根（tgz 副本），仓库与 stage 都不碰。
const cli = [join(HERE, 'patches', 'apply-patches.mjs'), probeRoot, '--scope', 'engine', '--apply']
if (only) cli.push('--only', only.join(','))
const r = spawnSync(process.execPath, cli, { encoding: 'utf8' })
process.stdout.write(r.stdout ?? '')
process.stderr.write(r.stderr ?? '')
process.exit(r.status ?? 1)
