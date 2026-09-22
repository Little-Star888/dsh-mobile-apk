#!/usr/bin/env node
// check-api-route-auth.mjs — 0.14.0 #222 mobile-owned route inventory gate.
//
// Upstream WebServer checks exact routes before prefix routes and then selects the longest prefix.
// A mobile route below /api therefore bypasses client-connection unless the registration itself
// authenticates the request. This gate discovers every shipped mobile `register({ kind, path })`
// candidate across plugin/vendor sources and requires an explicit policy row. Candidate discovery is
// deliberately fail-closed: comment/string lookalikes can make the gate reject, but cannot hide a
// route. Protected rows need a local guard marker; narrow public rows need a response marker and a
// reviewed rationale.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { TAR } from './lib/shell.mjs'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const policyPath = join(here, 'api-route-auth-policy.json')
const selfTest = process.argv.includes('--self-test')
const snapshotIndex = process.argv.indexOf('--snapshot')
const snapshotPath = snapshotIndex >= 0 ? process.argv[snapshotIndex + 1] : undefined
const failures = []

function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

function read(relativePath) {
  const absolutePath = join(root, relativePath)
  if (!existsSync(absolutePath)) {
    check('API 路由源文件在场: ' + relativePath, false)
    return ''
  }
  return readFileSync(absolutePath, 'utf8')
}

/**
 * Find route registration candidates without a brittle bounded-expression regex.
 *
 * `kind` and `path` are mandatory WebRoute fields and occur before a handler body in every
 * supported registration form. Scanning to the next registration (rather than a fixed character
 * window) keeps large handlers and field order from masking a candidate.
 */
function routeRegistrations(source) {
  const found = []
  const calls = [...source.matchAll(/\bregister\s*\(\s*\{/g)]
  for (let index = 0; index < calls.length; index += 1) {
    const start = calls[index].index
    const end = calls[index + 1]?.index ?? source.length
    const objectHead = source.slice(start, end)
    const kindMatch = /\bkind\s*:\s*(['"])(exact|prefix)\1/.exec(objectHead)
    const pathMatch = /\bpath\s*:\s*([^,\n}]+)/.exec(objectHead)
    const shorthandPath = /(?:^|[,\n])\s*path\s*(?:,|\n|})/.test(objectHead)
    if (kindMatch === null || (pathMatch === null && !shorthandPath)) continue
    const pathExpression = pathMatch?.[1].trim() ?? 'path'
    const literal = /^(['"])(\/api(?:\/[^'"]*)?)\1$/.exec(pathExpression)
    found.push({ kind: kindMatch[2], pathExpression, literalPath: literal?.[2], head: objectHead, index: start })
  }
  return found
}

function dynamicRoutePathLiterals(source) {
  const paths = []
  for (const match of source.matchAll(/for\s*\(\s*const\s*\[\s*path\s*,[\s\S]*?\]\s+of\s+\[([\s\S]*?)\]\s+as\s+const\s*\)/g)) {
    for (const literal of match[1].matchAll(/(['"])(\/api(?:\/[A-Za-z0-9._~-]+)*)\1/g)) paths.push(literal[2])
  }
  return paths
}

/** Files carrying product runtime route registrations; test/data/node_modules trees are excluded. */
const RUNTIME_ROOTS = [
  { dir: 'plugins', include: (path) => path.includes('/src/') },
  { dir: 'vendor', include: (path) => path.includes('/lib/') },
  { dir: 'dsh-host-web-compat', include: (path) => path.includes('/src/') || path.includes('/lib/') },
  { dir: 'dsh-shell-termux', include: (path) => path.includes('/src/') || path.includes('/lib/') },
]
const CODE_SUFFIX = /\.(?:[cm]?js|tsx?)$/

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const full = join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, files)
    else if (CODE_SUFFIX.test(name)) files.push(full)
  }
  return files
}

function discoveredRouteSources() {
  const result = new Map()
  for (const runtimeRoot of RUNTIME_ROOTS) {
    const absolute = join(root, runtimeRoot.dir)
    if (!existsSync(absolute)) continue
    for (const file of walk(absolute)) {
      const rel = relative(root, file).replace(/\\/g, '/')
      if (!runtimeRoot.include('/' + rel)) continue
      const registrations = routeRegistrations(readFileSync(file, 'utf8'))
      if (registrations.length > 0) result.set(rel, registrations)
    }
  }
  return result
}

let policy
try {
  policy = JSON.parse(readFileSync(policyPath, 'utf8'))
} catch (error) {
  console.error('CHECK-API-ROUTE-AUTH FAILED: policy parse error: ' + String(error?.message ?? error))
  process.exit(1)
}

const routes = Array.isArray(policy.routes) ? policy.routes : []
const registrations = Array.isArray(policy.routeRegistrations) ? policy.routeRegistrations : []
check('API 路由清单非空', routes.length > 0 && registrations.length > 0,
  'routes=' + routes.length + ' registrations=' + registrations.length)

const routeIds = new Set()
const routePaths = new Set()
for (const route of routes) {
  const id = typeof route.id === 'string' ? route.id : ''
  const path = typeof route.path === 'string' ? route.path : ''
  check('API 路由 id/path 合法: ' + (id || '<missing>'), id !== '' && path.startsWith('/api/'))
  check('API 路由 id 唯一: ' + (id || '<missing>'), !routeIds.has(id))
  check('API 路由 path 唯一: ' + (path || '<missing>'), !routePaths.has(path))
  routeIds.add(id)
  routePaths.add(path)

  const registrationSource = typeof route.registrationSource === 'string' ? route.registrationSource : ''
  const endpointSource = typeof route.endpointSource === 'string' ? route.endpointSource : ''
  const registration = typeof route.registration === 'string' ? route.registration : ''
  const registrationText = read(registrationSource)
  const endpointText = read(endpointSource)
  check(id + ' 注册表达式在场', registration !== '' && registrationText.includes(registration))
  check(id + ' endpoint 常量/字面量在场', endpointText.includes(path))

  if (route.access === 'protected') {
    const marker = typeof route.authMarker === 'string' ? route.authMarker : ''
    const callMarker = typeof route.authCallMarker === 'string' ? route.authCallMarker : ''
    // review §2.3（2026-09-14）收紧：guard 必须落在**该条注册的对象块内**。旧实现是文件级
    // includes——同文件里删掉某条 guard、只要别处还提一句 marker 就绿（已实测复现）。
    // 注册块在 registrationSource（register() 所在文件；endpointSource 可能是 client/contract 面）。
    // authMarker = 来源注释/函数名的文件级证据；authCallMarker = 注册块内的**调用形态**证据。
    const regs = routeRegistrations(registrationText)
    const hit = regs.find((r) => r.literalPath === path) ?? regs.find((r) => r.head.includes(registration))
    if (hit === undefined) {
      check(id + ' 受保护路由的 guard 在注册块内', false, '未在 ' + registrationSource + ' 定位到该注册的容器块')
    } else {
      check(id + ' 受保护路由的 guard 在注册块内',
        marker !== '' && callMarker !== '' && hit.head.includes(callMarker),
        (callMarker === '' ? '缺 authCallMarker 声明' : '调用形态不在注册块内: ' + callMarker))
    }
  } else if (route.access === 'public') {
    const marker = typeof route.publicResponseMarker === 'string' ? route.publicResponseMarker : ''
    const rationale = typeof route.rationale === 'string' ? route.rationale.trim() : ''
    check(id + ' 公开路由有窄响应 marker', marker !== '' && registrationText.includes(marker))
    check(id + ' 公开路由有审阅理由', rationale.length >= 30)
  } else {
    check(id + ' access 明确为 protected 或 public', false, String(route.access))
  }
}

const discovered = discoveredRouteSources()
const registrationSources = new Set()
for (const entry of registrations) {
  const sourcePath = typeof entry.source === 'string' ? entry.source : ''
  const expected = Number(entry.expected)
  const sourceRoutes = discovered.get(sourcePath) ?? []
  check('API 注册计数声明合法: ' + (sourcePath || '<missing>'), sourcePath !== '' && Number.isInteger(expected) && expected >= 0)
  check('API exact/prefix 注册数锁定: ' + sourcePath, sourceRoutes.length === expected,
    'expected=' + expected + ' actual=' + sourceRoutes.length)
  registrationSources.add(sourcePath)
}

const unlistedSources = [...discovered.keys()].filter((sourcePath) => !registrationSources.has(sourcePath)).sort()
const staleSources = [...registrationSources].filter((sourcePath) => !discovered.has(sourcePath)).sort()
check('所有 mobile-owned route registration source 均已登记', unlistedSources.length === 0,
  unlistedSources.join(', '))
check('route policy 无失效 registration source', staleSources.length === 0, staleSources.join(', '))

for (const route of routes) {
  check(route.id + ' 的 registration source 已锁定', registrationSources.has(route.registrationSource))
}

const unknownLiteralPaths = new Set()
for (const [sourcePath, sourceRoutes] of discovered) {
  for (const registration of sourceRoutes) {
    if (registration.literalPath !== undefined && registration.literalPath.startsWith('/api/') && !routePaths.has(registration.literalPath)) {
      unknownLiteralPaths.add(registration.literalPath)
    }
  }
  for (const path of dynamicRoutePathLiterals(read(sourcePath))) {
    if (!routePaths.has(path)) unknownLiteralPaths.add(path)
  }
}
check('所有直接字面量 /api 路由均已登记', unknownLiteralPaths.size === 0,
  [...unknownLiteralPaths].sort().join(', '))

// review §2.3（2026-09-14）：变量/展开/别名注册此前可整体逃逸（scanner 只认字面量 path）。现要求
// 每条非字面量 path 表达式在 policy.dynamicPathExpressions 显式声明并可核验：
//   resolvesTo        必须都是已登记 policy route；
//   literalEvidence   必须在该源文件里逐字出现（证明表达式确实解析到这些路径，且改动会踩爆门禁）。
const dynamicDecls = Array.isArray(policy.dynamicPathExpressions) ? policy.dynamicPathExpressions : []
const usedExpressions = new Set()
const unresolvedExpressions = []
for (const [sourcePath, sourceRoutes] of discovered) {
  for (const registration of sourceRoutes) {
    if (registration.literalPath !== undefined) continue
    const key = sourcePath + ' :: ' + registration.pathExpression
    usedExpressions.add(key)
    const decl = dynamicDecls.find((d) => d.source === sourcePath && d.expression === registration.pathExpression)
    if (decl === undefined) { unresolvedExpressions.push(key); continue }
    const srcText = read(sourcePath)
    const resolves = Array.isArray(decl.resolvesTo) ? decl.resolvesTo : []
    const badResolves = resolves.filter((p) => typeof p !== 'string' || !routePaths.has(p))
    const evidence = typeof decl.literalEvidence === 'string' ? decl.literalEvidence : ''
    const reason = typeof decl.reason === 'string' ? decl.reason.trim() : ''
    check('动态 path 表达式声明可核验: ' + key,
      resolves.length > 0 && badResolves.length === 0 && evidence !== '' && srcText.includes(evidence) && reason.length >= 20,
      '未登记 resolvesTo=[' + badResolves.join(', ') + ']；literalEvidence ' + (evidence === '' ? '缺' : (srcText.includes(evidence) ? '在场' : '不在源文件')) + '；reason ' + (reason.length >= 20 ? 'ok' : '过短/缺'))
  }
}
check('所有非字面量 path 表达式已声明（变量/展开注册不得逃逸）', unresolvedExpressions.length === 0,
  unresolvedExpressions.join('；'))
const staleExpressions = dynamicDecls
  .map((d) => String(d.source) + ' :: ' + String(d.expression))
  .filter((key) => !usedExpressions.has(key))
check('dynamicPathExpressions 无 stale 声明', staleExpressions.length === 0, staleExpressions.join('；'))

// Source/lib checks prove intent; this optional strict face proves the actual injected package files
// still contain the guards after snapshot assembly. Both shipped profiles are checked because a
// missing member in one profile otherwise manifests only as a device-side loader failure.
if (snapshotIndex >= 0 && snapshotPath === undefined) {
  check('--snapshot 参数完整', false, '缺少 tar 路径')
} else if (snapshotPath !== undefined) {
  check('post-injection route-auth snapshot 在场', existsSync(snapshotPath), snapshotPath)
  const artifactMarkers = [
    ['dsh-undo-savepoint/lib/index.js', 'dsh-mobile undo route auth (U1)'],
    ['dshmarketplace-plugin/lib/index.js', 'dsh-mobile marketplace route auth (U2)'],
    ['@dsh-android/dsh-android-bridge/lib/route-auth.js', 'authorizeMobileRoute'],
    ['@dsh-android/dsh-android-linux-env/lib/index.js', 'authorizeMobileRoute(req, authOptions())'],
    ['@dsh-android/dsh-android-file-open/lib/route-auth.js', 'authorizeMobileRoute'],
    ['@dsh-android/dsh-android-file-open/lib/index.js', "path: '/api/android/file-incoming/content'"],
    ['@dsh-android/dsh-android-browser/lib/index.js', 'if (connection !== undefined)'],
    ['@dsh-android/dsh-host-web-compat/lib/index.js', "const authorized = (req) => token !== ''"],
  ]
  if (existsSync(snapshotPath)) {
    for (const profile of ['web', 'headless']) {
      const entries = artifactMarkers.map(([relativePath, marker]) => ({
        relativePath,
        marker,
        tarPath: 'home/.dsh/profiles/' + profile + '/node_modules/' + relativePath,
      }))
      const result = spawnSync(TAR, ['-xOf', snapshotPath, ...entries.map((entry) => entry.tarPath)], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
      for (const entry of entries) {
        check('post-injection marker: ' + profile + '/' + entry.relativePath,
          result.status === 0 && result.stdout.includes(entry.marker),
          result.status === 0 ? 'marker missing: ' + entry.marker : String(result.stderr ?? '').trim().slice(0, 180))
      }
    }
  }
}

if (selfTest) {
  const longBody = 'x'.repeat(1024)
  const reordered = 'server.register({ path: "/api/self-test-unlisted", handler: () => ({ note: "' + longBody + '" }), kind: "exact" })'
  const commented = '/* server.register({ kind: "exact", path: "/api/commented-fake" }) */\nconst text = "server.register({ kind: \'prefix\', path: \'/api/string-fake\' })"'
  const reorderedRoutes = routeRegistrations(reordered)
  check('self-test: scanner handles path-before-kind and long handlers',
    reorderedRoutes.length === 1 && reorderedRoutes[0].kind === 'exact' && reorderedRoutes[0].literalPath === '/api/self-test-unlisted')
  check('self-test: comment/string-like candidate fails closed instead of hiding a route', routeRegistrations(commented).length === 2)
  check('self-test: unlisted source/path would be rejected',
    !registrationSources.has('plugins/new-runtime/src/index.ts') && !routePaths.has('/api/self-test-unlisted'))
}

if (failures.length > 0) {
  console.error('CHECK-API-ROUTE-AUTH FAILED (' + failures.length + '): ' + failures.join('; '))
  process.exit(1)
}
console.log('CHECK-API-ROUTE-AUTH PASSED (routes=' + routes.length + ', registrations=' + registrations.length + ', discovered=' + discovered.size + ', SKIP=0)')
