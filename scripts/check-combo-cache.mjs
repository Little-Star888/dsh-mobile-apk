#!/usr/bin/env node
// check-combo-cache.mjs — A3 combo 缓存覆盖门禁（0.14.0 启动性能 P1-2）。
//
// 背景：运行时补丁 combo-cache-A3 按 sha256(client.js) 查构建期缓存；缓存是**机会性**的
// （miss 即回退现场生成，fail-open）。门禁保证「随快照出厂的每一条 bundle 都有可用条目」，
// 否则回退会静默吃掉全部收益而无人知（假绿）。契约三处同源：scripts/lib/combo-precompute.mjs
// （写）/ apply-patches.mjs combo-cache-A3（读）/ 本门禁（覆盖）。
//
// 断言：
//   A. 缓存契约在场：home/.dsh/profiles/web/.combo-cache/ 至少一份清单（client-combos.json =
//      快照段；client-combos.inject.json = 注入段增量，运行时按序合并）；
//   B. 每条 `*/lib/client.js`：
//      - 无同级 `.map`：sha256 必须命中清单，entry.id == 邻近 package.json 的 name，map 文件在场；
//      - 有同级 `.map`：豁免（运行时不走 identity 路径，走 comboSectionMap 现场生成）。
//
// 用法：node scripts/check-combo-cache.mjs --stage <stageRoot>
//       node scripts/check-combo-cache.mjs <snapshot.tar.xz>
//       node scripts/check-combo-cache.mjs --self-test
// 退出码：0 = 通过；1 = 覆盖缺口；2 = 用法或输入不可读。
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, posix } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { precomputeComboCache, walkClientBundles } from './lib/combo-precompute.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const CACHE_REL = 'home/.dsh/profiles/web/.combo-cache'
const MANIFESTS = ['client-combos.json', 'client-combos.inject.json']

// --self-test：自包含两向验证（临时 stage，不碰仓库）：覆盖齐全 → 0；篡改 bundle → 1。
if (argv.includes('--self-test')) {
  const tmp = mkdtempSync(join(tmpdir(), 'combo-cache-self-'))
  try {
    const stage = join(tmp, 'stage')
    const pkgDir = join(stage, 'usr/lib/node_modules/@deepseek-ai/demo-pkg')
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/demo-pkg', version: '1.0.0' }))
    const clientPath = join(pkgDir, 'lib', 'client.js')
    writeFileSync(clientPath, 'window.__ModuleLoader__.load({ id: "demo-pkg", factory: () => {} });\n')
    const report = precomputeComboCache({ clientPaths: [clientPath], outDir: join(stage, CACHE_REL), manifestName: 'client-combos.json', engine: 'self-test' })
    const cleanRun = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stage', stage], { encoding: 'utf8' })
    writeFileSync(clientPath, readFileSync(clientPath, 'utf8') + '// tampered\n')
    const dirtyRun = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stage', stage], { encoding: 'utf8' })
    const ok = report.entries === 1 && cleanRun.status === 0 && dirtyRun.status === 1 && dirtyRun.stdout.includes('sha256')
    console.log((ok ? 'COMBO-CACHE SELF-TEST PASSED' : 'COMBO-CACHE SELF-TEST FAILED')
      + '（覆盖齐全 exit=' + cleanRun.status + ' 期望 0；篡改后 exit=' + dirtyRun.status + ' 期望 1；entries=' + report.entries + '）')
    if (!ok) console.log((cleanRun.stdout + cleanRun.stderr + dirtyRun.stdout + dirtyRun.stderr).slice(0, 600))
    process.exit(ok ? 0 : 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const stage = argOf('stage')
const tar = argv.find((a) => !a.startsWith('--') && a !== stage)
if ((!stage && !tar) || (stage && !existsSync(stage)) || (tar && !existsSync(tar))) {
  console.error('用法: node scripts/check-combo-cache.mjs --stage <stageRoot> | <snapshot.tar.xz> | --self-test')
  process.exit(2)
}

const failures = []
let checked = 0
let exempt = 0
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

// ── 输入抽象：stage 树直接走文件系统；tar 产物选择性解出（两批，避开 Windows 命令行长度上限）──
let root = stage
let listing = null
let tmpRoot = null
if (tar) {
  let members
  try {
    members = execFileSync('tar', ['-tf', tar], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
      .split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/'))
  } catch (e) {
    console.error('CHECK-COMBO-CACHE FAILED：tar 不可读（' + e.message + '）')
    process.exit(2)
  }
  listing = new Set(members)
  const bundles = members.filter((m) => m.endsWith('/client.js'))
  if (bundles.length === 0) {
    console.error('CHECK-COMBO-CACHE FAILED：tar 内无 */lib/client.js（路径布局变更？）')
    process.exit(1)
  }
  tmpRoot = mkdtempSync(join(tmpdir(), 'combo-cache-tar-'))
  const extract = (list, label) => {
    if (list.length === 0) return
    try {
      execFileSync('tar', ['-xf', tar, '-C', tmpRoot, ...list], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
    } catch (e) {
      console.error('CHECK-COMBO-CACHE FAILED：tar 选择性解出失败（' + label + '：' + e.message + '）')
      rmSync(tmpRoot, { recursive: true, force: true })
      process.exit(2)
    }
  }
  extract([...bundles, ...MANIFESTS.map((n) => CACHE_REL + '/' + n).filter((n) => listing.has(n))], 'client bundles')
  // tar 成员路径是 POSIX 形态；Windows 上 join() 会转成反斜杠 → 必须用 posix 拼包名路径，
  // 否则 listing.has() 恒 false（包名读成 undefined，entry.id 核对整体失效——本机实测的假红形态）。
  const pkgJsons = [...new Set(bundles.map((m) => posix.join(posix.dirname(posix.dirname(m)), 'package.json')))]
    .filter((m) => listing.has(m))
  extract(pkgJsons, 'package manifests')
  root = tmpRoot
}

try {
  const bundlePaths = walkClientBundles(root)
  if (bundlePaths.length === 0) {
    console.error('CHECK-COMBO-CACHE FAILED：未找到任何 lib/client.js（快照布局变更或输入不完整）')
    process.exit(1)
  }
  const cacheDir = join(root, CACHE_REL)
  const manifests = MANIFESTS.filter((name) => existsSync(join(cacheDir, name)))
  check('缓存清单在场（' + (manifests.join(' + ') || '无') + '）', manifests.length > 0,
    '缺 ' + CACHE_REL + '/{client-combos.json,client-combos.inject.json}')
  const merged = new Map()
  for (const name of manifests) {
    try {
      const manifest = JSON.parse(readFileSync(join(cacheDir, name), 'utf8'))
      const entries = manifest !== null && typeof manifest === 'object' ? manifest.entries : undefined
      if (entries === null || typeof entries !== 'object') throw new Error('entries 缺失')
      let added = 0
      for (const [key, value] of Object.entries(entries)) {
        if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('键不是 sha256: ' + key)
        if (value === null || typeof value !== 'object' || typeof value.id !== 'string'
          || typeof value.source !== 'string' || typeof value.lines !== 'number' || typeof value.map !== 'string') {
          throw new Error('条目字段非法: ' + key)
        }
        merged.set(key, value)
        added += 1
      }
      console.log('      ' + name + '：' + added + ' 条')
    } catch (e) {
      check('清单可解析且字段合法: ' + name, false, e.message)
    }
  }
  check('合并后条目非空（' + merged.size + ' 条）', merged.size > 0)

  const mapPresent = (rel) => listing !== null ? listing.has(rel) : existsSync(join(root, rel))
  const cacheHas = (name) => listing !== null ? listing.has(CACHE_REL + '/' + name) : existsSync(join(cacheDir, name))
  const missingSha = []
  const idMismatch = []
  const missingMap = []
  for (const clientPath of bundlePaths) {
    checked += 1
    const rel = relative(root, clientPath).replace(/\\/g, '/')
    if (mapPresent(rel + '.map')) { exempt += 1; continue }
    const sha = createHash('sha256').update(readFileSync(clientPath)).digest('hex')
    const entry = merged.get(sha)
    if (entry === undefined) { missingSha.push(rel); continue }
    const pkgPath = join(root, posix.join(posix.dirname(posix.dirname(rel)), 'package.json'))
    const id = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')).name : undefined
    if (entry.id !== id) idMismatch.push(rel + '（清单 ' + entry.id + ' != 包 ' + id + '）')
    if (!cacheHas(entry.map)) missingMap.push(rel + ' -> ' + entry.map)
  }
  check('全部客户端 bundle 有缓存条目（sha256 命中）', missingSha.length === 0,
    '未覆盖 ' + missingSha.length + ' 条: ' + missingSha.slice(0, 5).join(', '))
  check('entry.id 与包名一致', idMismatch.length === 0, idMismatch.slice(0, 3).join('；'))
  check('map 文件在场', missingMap.length === 0, missingMap.slice(0, 3).join('；'))
  console.log('      bundle=' + checked + '（豁免 .map ' + exempt + '）/ 缓存条目=' + merged.size)
} finally {
  if (tmpRoot !== null) rmSync(tmpRoot, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('CHECK-COMBO-CACHE FAILED（' + failures.length + ' 项，bundle=' + checked + '，豁免=' + exempt + '）：' + failures.slice(0, 5).join('；'))
  process.exit(1)
}
console.log('CHECK-COMBO-CACHE PASSED（' + checked + ' 条 bundle 覆盖' + (exempt > 0 ? '，' + exempt + ' 条 .map 豁免' : '') + '）')
