#!/usr/bin/env node
// check-plugin-tests.mjs — 每个插件自带的 test/*.test.mjs 必须真实跑通（0.14.0 新增）。
//
// 为什么需要这个门禁：虚拟屏插件的 android_vdisplay_create/destroy 曾经**完全不可用**
// （服务方法被摘出服务对象裸调，this 丢失 → controlQueue undefined），而该插件**一个测试都没有**，
// 于是没有任何门禁发现它。这个缺口不是「某个测试漏了」，而是「没有任何机制要求插件有测试」。
//
// 判据（逐插件）：
//   1) 有 test/*.test.mjs → 必须通过，且有效通过数 > 0（全 skip = 假绿，exit 0 不算数）；
//   2) 没有 test 目录 → WARN 不拦（避免把「历史欠账」当阻塞项），但在输出里点名，让缺口可见。
//
// 真实执行插件自己的 test/*.test.mjs，不做静态提取。
import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const PLUGIN_DIR = join(ROOT, 'plugins')

const plugins = existsSync(PLUGIN_DIR)
  ? readdirSync(PLUGIN_DIR).filter((n) => existsSync(join(PLUGIN_DIR, n, 'package.json')))
  : []
if (plugins.length === 0) { console.error('CHECK-PLUGIN-TESTS FAILED：找不到任何插件'); process.exit(1) }

let ran = 0
let failed = 0
const noTests = []

for (const plugin of plugins.sort()) {
  const testDir = join(PLUGIN_DIR, plugin, 'test')
  if (!existsSync(testDir)) { noTests.push(plugin); continue }
  const files = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs') || f.endsWith('.test.ts')).map((f) => join(testDir, f))
  if (files.length === 0) { noTests.push(plugin); continue }
  ran += 1
  // 运行器按文件内容自动判定：本仓 6 个插件用 node:test，client/UI 侧用 vitest。
  // 写死任一个都会把另一种判成失败（首次跑本门禁即实测到该误报）。
  const { readFileSync } = await import('node:fs')
  // 扫**全文件**而非固定行窗口：注释头长度不定，只看前 N 行会把 import 挡在窗口外
  // （首次跑本门禁实测到：vdisplay 的 16 行注释把 node:test import 挤到第 17 行，检测漏判）。
  // 同时看所有测试文件：一个插件可能混用（任一文件用 node:test 即按 node:test 跑）。
  const usesNodeTest = files.some((f) => /from 'node:test'/.test(readFileSync(f, 'utf8')))
  const args = usesNodeTest
    ? ['--test', '--test-reporter=spec', ...files.map((f) => f.slice(join(PLUGIN_DIR, plugin).length + 1))]
    : ['vitest', 'run', ...files.map((f) => f.slice(join(PLUGIN_DIR, plugin).length + 1))]
  // 不用 shell:true——execPath 在 Windows 上含空格（'C:\Program Files\...'），shell 会把它拆断
  // （首次跑本门禁实测到该误报）。直接以 argv 形式 spawn，由内核处理路径。
  // vitest 的 --root 固定到插件目录，避免从上层配置解析导致 'No test suite found'。
  const spawnArgs = usesNodeTest
    ? args
    : ['vitest', 'run', '--root', join(PLUGIN_DIR, plugin), ...files.map((f) => f.slice(join(PLUGIN_DIR, plugin).length + 1))]
  const bin = usesNodeTest ? process.execPath : (process.platform === 'win32' ? 'npx.cmd' : 'npx')
  const r2 = spawnSync(bin, spawnArgs, { cwd: join(PLUGIN_DIR, plugin), encoding: 'utf8' })
  const out2 = (r2.stdout ?? '') + (r2.stderr ?? '')
  // 通过数：node:test spec 报 'ℹ pass N'；vitest 报 'Tests N passed'。两者都接受，任一为 0 判红。
  // 通过数：node:test spec 报 'ℹ pass N'；vitest 报 'Tests N passed'；Node 20 TAP 报 '# pass N'。
  const passN2 = Number((/^ℹ pass (\d+)/m.exec(out2) ?? /Tests\s+(\d+) passed/m.exec(out2) ?? /# pass (\d+)/m.exec(out2))?.[1] ?? '0')
  // 失败数：必须锚定字段本身，不能用裸 /(\d+) failed/ —— 它会命中 'cancelled 0' 之类无关行的
  // 相邻数字，或把 'ℹ fail 0' 里的 0 与别处的数字混起来（首次跑本门禁实测到该误判）。
  const failN2 = Number(/^ℹ fail (\d+)/m.exec(out2)?.[1] ?? /^\s*(\d+) failed/m.exec(out2)?.[1] ?? '0')
  if (r2.status !== 0 || failN2 !== 0) {
    failed += 1
    console.error('FAIL  ' + plugin + ' 的单测未通过（runner=' + (usesNodeTest ? 'node:test' : 'vitest') + '）')
    console.error(out2.split('\n').slice(-25).join('\n'))
  } else if (passN2 <= 0) {
    failed += 1
    console.error('FAIL  ' + plugin + ' 的单测未产生有效通过数（全 skip = 假绿）')
  } else {
    console.log('PASS  ' + plugin + '（' + files.length + ' 个文件 / ' + passN2 + ' 项通过，' + (usesNodeTest ? 'node:test' : 'vitest') + '）')
  }
}
if (noTests.length > 0) {
  console.log('WARN  以下插件没有 test/*.test.mjs（缺口可见，不阻塞）：' + noTests.join(', '))
}
if (failed > 0) {
  console.error('CHECK-PLUGIN-TESTS FAILED（' + failed + ' 个插件的单测有问题；已跑 ' + ran + ' 个）')
  process.exit(1)
}
console.log('CHECK-PLUGIN-TESTS PASSED（已跑 ' + ran + ' 个插件的单测'
  + (noTests.length > 0 ? '；' + noTests.length + ' 个插件暂无测试' : '') + '）')