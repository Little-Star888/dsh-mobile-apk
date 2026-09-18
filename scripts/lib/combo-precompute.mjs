#!/usr/bin/env node
// combo-precompute.mjs — A3 combo 构建期预计算（性能方案 §5.2 P1-2，2026-09-14）。
//
// 背景（docs/ANDROID-RUNTIME-PERF-2026-09-12.md）：冷启动 88% 的墙钟耗在
// `@deepseek-ai/dsh-client-modules` 的 `compose()`——每次启动对 90 个客户端 bundle 全表重建
// combo 脚本与 source map（单次 1.8-3.1 s，启动期 9-14 次）。其中与 rev 无关、且对同一份
// bundle 字节恒定的部分是 `comboSource` 的 source 文本与 identity section map；本模块在构建期
// 把它们算一次写进快照 `home/.dsh/profiles/web/.combo-cache/`，引擎树补丁 combo-cache-A3 在
// 运行期按 sha256 查表直接取用（未命中/损坏一律回退现场生成，fail-open）。
//
// 与上游算法的字节等价由 scripts/patches/tests/combo-cache-a3.test.mjs 证明（同一 fixture
// 上「打过补丁的 buildCombo + 缓存」与「未打补丁的 buildCombo 现场生成」逐字节对比）。
//
// 缓存契约（与运行时补丁一致，勿单边演进）：
//   键   = sha256(client.js 原始字节)
//   值   = { id, source, lines, map }
//          source = comboSource() 的 source（去 sourceURL/sourceMappingURL 尾、保证尾换行；rev 无关）
//          lines  = newlineCount(source + ";\n")（运行时跳过逐字符计数）
//          map    = "<sha256>.map" 文件，内容为 JSON.stringify(identitySectionMap(source, fallbackSource))
//   清单 = client-combos.json（快照段）/ client-combos.inject.json（注入段，运行时按序合并）
//
// 用法：
//   node scripts/lib/combo-precompute.mjs --scan <dir> [--scan <dir>...] --out <cacheDir> [--manifest client-combos.json]
//   node scripts/lib/combo-precompute.mjs --client <lib/client.js> [--client ...] --out <cacheDir> [--manifest client-combos.inject.json]
// 退出码：0 = 成功（可 0 条目但必须显式声明需要）；1 = 输入无效/写盘失败；2 = 用法错误。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 上游 dsh-client-modules/lib/index.js 的同名常量（0.1.5-rc.1 实测拷贝）。 */
const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/
const SOURCE_URL_TRAILER = /(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/

/** Count generated lines; identical to the upstream `newlineCount`. */
export function newlineCount(value) {
  let count = 0
  for (const char of value) if (char === '\n') count += 1
  return count
}

/**
 * Strip the bundle's source map/source URL trailers and derive the fallback source path.
 * Byte-for-byte copy of the upstream `comboSource` with a bundle buffer input.
 * @param id - client package id (the loader entry name).
 * @param bundle - client.js bytes.
 * @returns the prepared source text and the identity map's source path.
 */
export function comboSource(id, bundle) {
  let source = bundle.toString('utf8')
  const sourceUrl = SOURCE_URL_TRAILER.exec(source)?.[1]
  source = source.replace(SOURCE_URL_TRAILER, '').replace(SOURCE_MAP_TRAILER, '')
  if (!source.endsWith('\n')) source += '\n'
  const fallbackSource = sourceUrl === undefined
    ? `/plugins/${id}/client.js`
    : /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/)/.test(sourceUrl) ? sourceUrl : `/${sourceUrl}`
  return { source, fallbackSource }
}

/** Map each generated line to the same line in a bundled JavaScript source (upstream `identitySectionMap`). */
export function identitySectionMap(source, sourceUrl) {
  const mappings = Array.from({ length: newlineCount(source) }, (_, index) => index === 0 ? 'AAAA' : 'AACA').join(';')
  return {
    version: 3,
    names: [],
    sources: [sourceUrl],
    sourcesContent: [source],
    mappings,
  }
}

/**
 * Build one cache entry for a client bundle.
 * @param id - client package id.
 * @param bundle - client.js bytes.
 * @returns sha256 key and the cached value fields (section JSON string included).
 */
export function comboCacheEntry(id, bundle) {
  const sha256 = createHash('sha256').update(bundle).digest('hex')
  const { source, fallbackSource } = comboSource(id, bundle)
  const lines = newlineCount(source + ';\n')
  const sectionJson = JSON.stringify(identitySectionMap(source, fallbackSource))
  return { sha256, id, source, lines, sectionJson }
}

/** Nearest package.json name above a lib/client.js path (the loader entry id). */
export function packageIdOf(clientPath) {
  const pkgPath = join(dirname(dirname(clientPath)), 'package.json')
  if (!existsSync(pkgPath)) throw new Error('combo-precompute: package.json 缺席: ' + pkgPath)
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (typeof pkg.name !== 'string' || pkg.name === '') throw new Error('combo-precompute: package.json 无 name: ' + pkgPath)
  return pkg.name
}

/**
 * Walk a directory for client bundles under any `lib` directory.
 * @param root - directory to scan.
 * @returns absolute client.js paths (sorted for determinism).
 */
export function walkClientBundles(root) {
  const out = []
  const visit = (dir) => {
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (name === '.git') continue
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) visit(full)
      else if (name === 'client.js' && basename(dir) === 'lib') out.push(full)
    }
  }
  visit(root)
  return out.sort()
}

/**
 * Precompute entries for a set of client bundles and write the cache (manifest + per-key map files).
 *
 * review C1 附带缺陷（2026-09-14）：旧实现对「本地有同级 `.map`」的 bundle 一律 skip，理由是
 * 「运行时走 live comboSectionMap 路径」——但**产物里根本没有这些 map**：快照侧 slim 全树删 .map，
 * 注入侧 inject-all.py 明确排除 .map（且 check-snapshot-secrets 把 @dsh-android 的 .js.map 当泄露）。
 * 于是本地被 skip、产物里却无 map → 运行时 record.sourceMap === undefined → 需要查缓存 → 覆盖门禁判红。
 * 现无条件为每条 bundle 生成条目（运行时自己的 `sourceMap !== undefined → 不走缓存` 判定保持不变，
 * 有 map 的环境下条目只是不被读取，无副作用）。
 *
 * @param options - clientPaths, outDir, manifest name, engine label.
 * @returns report { entries, manifestPath }.
 */
export function precomputeComboCache(options) {
  const { clientPaths, outDir, manifestName = 'client-combos.json', engine = '' } = options
  if (!Array.isArray(clientPaths)) throw new Error('combo-precompute: clientPaths 必填')
  mkdirSync(outDir, { recursive: true })
  const entries = {}
  for (const clientPath of clientPaths) {
    const id = packageIdOf(clientPath)
    const entry = comboCacheEntry(id, readFileSync(clientPath))
    if (entries[entry.sha256] !== undefined) {
      console.log('combo-precompute: duplicate sha256 for ' + id + ' (same bytes as ' + entries[entry.sha256].id + '), keeping first')
      continue
    }
    entries[entry.sha256] = { id, source: entry.source, lines: entry.lines, map: entry.sha256 + '.map' }
    writeFileSync(join(outDir, entry.sha256 + '.map'), entry.sectionJson + '\n')
  }
  const sorted = {}
  for (const key of Object.keys(entries).sort()) sorted[key] = entries[key]
  const manifest = {
    version: 1,
    generator: 'combo-precompute.mjs',
    ...(engine ? { engine } : {}),
    entries: sorted,
  }
  const manifestPath = join(outDir, manifestName)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return { entries: Object.keys(sorted).length, manifestPath }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const argv = process.argv.slice(2)
  const scans = []
  const clients = []
  let out = null
  let manifest = 'client-combos.json'
  let engine = ''
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--scan' && argv[i + 1]) { scans.push(argv[++i]); continue }
    if (argv[i] === '--client' && argv[i + 1]) { clients.push(argv[++i]); continue }
    if (argv[i] === '--out' && argv[i + 1]) { out = argv[++i]; continue }
    if (argv[i] === '--manifest' && argv[i + 1]) { manifest = argv[++i]; continue }
    if (argv[i] === '--engine' && argv[i + 1]) { engine = argv[++i]; continue }
    console.error('未知参数: ' + argv[i])
    process.exit(2)
  }
  if (out === null || (scans.length === 0 && clients.length === 0)) {
    console.error('用法: node scripts/lib/combo-precompute.mjs (--scan <dir> | --client <lib/client.js>)... --out <cacheDir> [--manifest <name>] [--engine <label>]')
    process.exit(2)
  }
  try {
    const found = [...scans.flatMap((root) => {
      if (!existsSync(root)) { console.error('combo-precompute: scan 目录缺席: ' + root); process.exit(1) }
      return walkClientBundles(root)
    }), ...clients]
    for (const clientPath of clients) {
      if (!existsSync(clientPath)) { console.error('combo-precompute: client 缺席: ' + clientPath); process.exit(1) }
    }
    const report = precomputeComboCache({ clientPaths: found, outDir: out, manifestName: manifest, engine })
    console.log('COMBO-PRECOMPUTE OK entries=' + report.entries + ' manifest=' + report.manifestPath)
  } catch (error) {
    console.error('COMBO-PRECOMPUTE FAILED: ' + (error?.stack ?? String(error)))
    process.exit(1)
  }
}
