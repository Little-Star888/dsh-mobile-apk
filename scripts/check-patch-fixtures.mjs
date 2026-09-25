#!/usr/bin/env node
// check-patch-fixtures.mjs — 补丁测试夹具随版门禁（0.14.2 T6）
//
// 真因（本轮实锤，不是假设）：0.1.7-rc.1 快照构建里 19 条引擎补丁断 9 条，而 `scripts/patches/tests/`
// 的 16 个补丁测试**全绿**——因为它们的夹具目录名写死着上一代（dsh-client-modules-0.1.5-rc.1）。
// 夹具与真产物不是同一代时，「补丁回归」这四个字没有任何含义：测试证明的是补丁对**旧字节**仍成立。
//
// 三条断言：
//   A 台账完备：fixtures/ 下每个目录都必须在 fixtures/manifest.json 里声明（沉默的目录 = 红）；
//   B 随版：source=engine-tgz 的目录版本必须 == contract.baseline，且 manifest 声明的文件真在场；
//     source=synthetic 的必须写明 reason（为什么不用真产物）；
//   C 禁写死：tests/*.test.mjs 里不得再出现内嵌版本号的夹具路径字面量（一律走 lib/fixture.mjs）。
//
// 用法：node scripts/check-patch-fixtures.mjs [--self-test]
// 退出码：0 = PASS；1 = FAIL。
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SELF_TEST = process.argv.includes('--self-test')

const fails = []
const check = (label, ok, detail) => {
  if (!ok) fails.push(label + (detail ? ' -> ' + detail : ''))
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
}

/** 对一棵 fixtures/tests 树跑三条断言，返回失败列表（--self-test 用临时树驱动反例）。 */
function audit(fixturesDir, testsDir, baseline) {
  const out = []
  const manifestPath = join(fixturesDir, 'manifest.json')
  if (!existsSync(manifestPath)) return ['夹具台账缺席: ' + manifestPath]
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = manifest.fixtures ?? {}
  // A 台账完备
  const dirs = readdirSync(fixturesDir).filter((d) => statSync(join(fixturesDir, d)).isDirectory())
  for (const d of dirs) if (!declared[d]) out.push(`夹具目录未在台账声明: ${d}`)
  // B 随版
  for (const [dir, meta] of Object.entries(declared)) {
    if (!existsSync(join(fixturesDir, dir))) { out.push(`台账声明的夹具目录缺席: ${dir}`); continue }
    if (meta.source === 'engine-tgz') {
      if (meta.engine !== baseline) out.push(`夹具未随版: ${dir} engine=${meta.engine} != contract.baseline=${baseline}`)
      if (!dir.endsWith('-' + meta.engine)) out.push(`夹具目录名与台账版本不符（改名没改台账）: ${dir} vs ${meta.engine}`)
      for (const f of meta.files ?? []) {
        if (!existsSync(join(fixturesDir, dir, f))) out.push(`夹具文件缺席: ${dir}/${f}`)
      }
    } else if (meta.source === 'synthetic') {
      if (!String(meta.reason ?? '').trim()) out.push(`合成夹具必须写明 reason（为什么不用真产物）: ${dir}`)
    } else if (meta.source === 'superseded') {
      // 上一代夹具：只允许作为「等删除」的登记项存在，任何测试再引用它就是假绿回归。
      if (!String(meta.reason ?? '').trim()) out.push(`代弃夹具必须写明 reason: ${dir}`)
      if (meta.engine === baseline) out.push(`代弃夹具的版本等于当前基线，应改为 engine-tgz 登记: ${dir}`)
      const ref = new RegExp(`['"]${dir.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]`)
      if (readdirSync(testsDir).filter((x) => x.endsWith('.test.mjs'))
        .some((f) => ref.test(readFileSync(join(testsDir, f), 'utf8')))) {
        out.push(`测试仍在引用代弃夹具（等于拿旧字节做回归）: ${dir}`)
      }
    } else out.push(`夹具 source 未知: ${dir} = ${meta.source}`)
  }
  // C 禁写死
  const hardcoded = /['"]fixtures['"],\s*['"][a-z0-9-]+-\d+\.\d+\.\d+[^'"]*['"]/
  for (const f of readdirSync(testsDir).filter((x) => x.endsWith('.test.mjs'))) {
    const text = readFileSync(join(testsDir, f), 'utf8')
    if (hardcoded.test(text)) out.push(`夹具路径写死版本（改走 tests/lib/fixture.mjs）: ${f}`)
  }
  return out
}

if (SELF_TEST) {
  // 反证：每条断言都必须能在被破坏时变红——否则门禁本身是假的。
  const base = mkdtempSync(join(tmpdir(), 'patch-fixtures-'))
  try {
    const mk = (name, mut) => {
      const fx = join(base, name, 'fixtures'); const ts = join(base, name, 'tests')
      mkdirSync(join(fx, 'dsh-demo-0.9.9-rc.1', 'lib'), { recursive: true })
      mkdirSync(ts, { recursive: true })
      writeFileSync(join(fx, 'dsh-demo-0.9.9-rc.1', 'lib', 'index.js'), '// fixture\n')
      writeFileSync(join(fx, 'manifest.json'), JSON.stringify({
        fixtures: { 'dsh-demo-0.9.9-rc.1': { source: 'engine-tgz', engine: '0.9.9-rc.1', files: ['lib/index.js'] } },
      }))
      writeFileSync(join(ts, 'demo.test.mjs'), "const FIXTURE = 'x'\n")
      mut({ fx, ts })
      return audit(fx, ts, '0.9.9-rc.1')
    }
    const cases = [
      { label: '反证：夹具未随版判红', want: true, run: ({ fx }) => {
        const m = JSON.parse(readFileSync(join(fx, 'manifest.json'), 'utf8'))
        m.fixtures['dsh-demo-0.9.9-rc.1'].engine = '0.9.8-rc.1'
        writeFileSync(join(fx, 'manifest.json'), JSON.stringify(m))
      } },
      { label: '反证：未声明目录判红', want: true, run: ({ fx }) => { mkdirSync(join(fx, 'dsh-orphan-0.9.9-rc.1'), { recursive: true }) } },
      { label: '反证：夹具文件缺席判红', want: true, run: ({ fx }) => { rmSync(join(fx, 'dsh-demo-0.9.9-rc.1', 'lib', 'index.js')) } },
      { label: '反证：合成夹具无 reason 判红', want: true, run: ({ fx }) => {
        const m = JSON.parse(readFileSync(join(fx, 'manifest.json'), 'utf8'))
        m.fixtures['dsh-demo-0.9.9-rc.1'] = { source: 'synthetic' }
        writeFileSync(join(fx, 'manifest.json'), JSON.stringify(m))
      } },
      { label: '反证：测试里写死夹具版本判红', want: true, run: ({ ts }) => {
        writeFileSync(join(ts, 'demo.test.mjs'), "const F = join(here, 'fixtures', 'dsh-demo-0.1.5-rc.1', 'lib', 'index.js')\n")
      } },
    ]
    let i = 0
    for (const c of cases) {
      i++
      const res = mk('case' + i, c.run)
      if (c.want) check(`反例 ${i} 被抓住（${c.label}）`, res.length > 0, res.join(' | ') || '没有判红，门禁失效')
    }
    const clean = mk('clean', () => {})
    check('对照组：合规树不判红', clean.length === 0, clean.join(' | '))
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  if (fails.length) { console.error(`SELF-TEST FAILED（${fails.length} 项）`); process.exit(1) }
  console.log('PATCH-FIXTURES SELF-TEST PASSED')
  process.exit(0)
}

const contract = JSON.parse(readFileSync(join(ROOT, 'scripts', 'contract.json'), 'utf8'))
const fixturesDir = join(ROOT, 'scripts', 'patches', 'tests', 'fixtures')
const testsDir = join(ROOT, 'scripts', 'patches', 'tests')
check('夹具台账在场', existsSync(join(fixturesDir, 'manifest.json')),
  '跑 node scripts/probe-engine-anchors.mjs --fixtures 生成')
if (!fails.length) {
  for (const m of audit(fixturesDir, testsDir, contract.baseline)) fails.push(m)
  check('夹具三条断言（台账完备 / 随版 / 禁写死）', fails.length === 0, fails.join(' | '))
}
if (fails.length) {
  console.error(`PATCH-FIXTURES CHECK FAILED（${fails.length} 项）`)
  process.exit(1)
}
console.log(`PATCH-FIXTURES CHECK PASSED（夹具代 ${contract.baseline}）`)
