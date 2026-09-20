#!/usr/bin/env node
// verify-auto-undo.mjs —— 自动回滚（UndoGate → 急救 CLI restore-last-good）的设备验收。
//
// 用户口径（2026-09-21）：「不能让有问题的回滚进入新版本。测试流程就是手动注入坏插件，重启引擎
// 看看有没有被清除」，并追加验收第二条：「要测试是不是能正常剔除坏插件**且不损坏我们自己注册的任何好插件**」。
//
// 判据四条（缺一条即不算通过）：
//  ① 回滚**真的执行了**（`files/undo-gate.log` 出现本轮新增的 `executed ok snapshot=…`，不是"armed"也不是"failed"）；
//  ② 坏插件**被剔除出装配**（`cordis.patch.yml` 回到基线：不再挂载注入的坏插件）；
//  ③ 引擎**恢复健康**（主机侧经 adb forward 探 3080，连接成功即活）；
//  ④ 我们自己的好插件**一个都没坏**（`profiles/web/node_modules/@dsh-android/**` 逐文件 sha256 与基线逐条相等）。
//  另外如实记录第五条：坏插件的**目录残留**是否还在（剔除装配 ≠ 删文件，两者必须分开说）。
//
// 为什么必须在设备上跑：回滚的触发链是「引擎死 → 看门狗连续失败 6 拍 → UndoGate 武装 → 15s 静默 →
// 急救 CLI」——四段全是设备侧的时序与进程事实，JVM 单测只能覆盖纯决策函数（`UndoGateDecisionTest`）。
//
// 用法：
//   node scripts/verify-auto-undo.mjs --serial 127.0.0.1:16416 [--timeout 240] [--keep] [--self-test]
//   --keep：不清理注入物（留现场给人看）；默认清理（删坏插件目录 + 还原 patch 文件）。
// 退出码：0 全绿 / 1 判红 / 2 前置不满足或证据不足（不得当通过）。
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const argv = process.argv.slice(2)
const argOf = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : undefined }
const has = (n) => argv.includes('--' + n)
const SERIAL = argOf('serial')
const TIMEOUT_S = Number(argOf('timeout') ?? 240)
const PKG = 'com.dsharnessmobile.shell'
const FILES = '/data/user/0/' + PKG + '/files'
const WEB = FILES + '/home/.dsh/profiles/web'
const NM = WEB + '/node_modules/@dsh-android'
const BAD_ID = 'dsh-bad-probe'
const BAD_DIR = NM + '/' + BAD_ID
const PATCH = WEB + '/cordis.patch.yml'
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const EVID = join(ROOT, '.deploy-tmp', 'auto-undo', STAMP)

// ── 纯逻辑（自检覆盖）──────────────────────────────────────────────────────

/** 解析 undo-gate.log：`dsh-undo-gate at=<ms> <kind> …`。kind 是第一个非时间字段。 */
export function parseUndoLog(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /dsh-undo-gate at=(\d+)\s+([^\s]+)(?:\s+([^\n]*))?$/.exec(line.trim())
    if (m === null) continue
    const rest = m[3] ?? ''
    out.push({
      at: Number(m[1]),
      kind: m[2],
      snapshot: /snapshot=(\S+)/.exec(rest)?.[1] ?? null,
      failures: Number(/failures=(\d+)/.exec(rest)?.[1] ?? -1),
      raw: line.trim(),
    })
  }
  return out
}

/**
 * 本轮是否**真的回滚成功**：基线之后必须出现 `executed ok`（带 snapshot）。
 * 否定判据：`armed`/`trigger` 只是过程；`executed failed` 是失败——三者都不得算通过。
 */
export function rollbackVerdict(logText, baselineCount) {
  const all = parseUndoLog(logText)
  const oks = all.filter((e) => e.kind === 'executed' && e.snapshot !== null)
  const failed = all.filter((e) => e.kind === 'executed' && e.snapshot === null)
  return { total: all.length, oks: oks.length, failed: failed.length, newOk: oks.length > baselineCount, last: oks[oks.length - 1] ?? null, failedEntries: failed }
}

/** 逐文件 sha256 清单文本（设备侧 `sha256sum` 输出）→ Map<相对路径, 哈希>。 */
export function manifestMap(text) {
  const map = new Map()
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim())
    if (m !== null) map.set(m[2].replace(/^\.\//, ''), m[1])
  }
  return map
}

/** 两份清单的差异（坏插件的目录树会整体计入 added/removed，故调用方需先排除它）。 */
export function manifestDiff(before, after) {
  const added = [], removed = [], changed = []
  for (const k of after.keys()) if (!before.has(k)) added.push(k)
  for (const [k, v] of before) {
    if (!after.has(k)) removed.push(k)
    else if (after.get(k) !== v) changed.push(k)
  }
  return { added, removed, changed, same: added.length === 0 && removed.length === 0 && changed.length === 0 }
}

/** patch 文件是否挂载了某个插件名（剔除装配的判据）。 */
export function patchMounts(text, name) {
  return new RegExp(`(^|\\s)'?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'?\\s*$`, 'm').test(text)
}

function selfTest() {
  let bad = 0, total = 0
  const expect = (n, c) => { total++; if (!c) { bad++; console.log('[SELFTEST-FAIL] ' + n) } else console.log('[SELFTEST-PASS] ' + n) }

  const log = [
    'dsh-undo-gate at=1000 armed failures=6 watchMs=15000',
    'dsh-undo-gate at=2000 trigger failures=9',
    'dsh-undo-gate at=2300 executed ok snapshot=20260920-235635-524b（auto，plugin-mounted）',
    'dsh-undo-gate at=5000 executed failed exitSummary=blob 缺失',
    'dsh-undo-gate at=6000 suppressed retry-window failures=6 lastUndoAt=2300',
  ].join('\n')
  const p = parseUndoLog(log)
  expect('解析：五条全收', p.length === 5)
  expect('解析：armed 与 executed 可区分', p[0].kind === 'armed' && p[2].kind === 'executed')
  expect('解析：ok 行带 snapshot id', String(p[2].snapshot).startsWith('20260920-235635-524b'))
  expect('解析：failed 行无 snapshot', p[3].snapshot === null && p[3].kind === 'executed')
  expect('解析：failures 取值', p[0].failures === 6 && p[1].failures === 9)

  const v = rollbackVerdict(log, 0)
  expect('判据：本轮新增 executed ok = 通过', v.newOk === true && v.oks === 1)
  expect('否定：只有 armed/trigger 不得算回滚', rollbackVerdict('dsh-undo-gate at=1 armed failures=6\ndsh-undo-gate at=2 trigger failures=9', 0).newOk === false)
  expect('否定：executed failed 不得算通过', rollbackVerdict('dsh-undo-gate at=3 executed failed exitSummary=x', 0).newOk === false)
  expect('否定：历史 ok（baseline 已含）不得算本轮', rollbackVerdict('dsh-undo-gate at=2 executed ok snapshot=s1', 1).newOk === false)

  const m1 = manifestMap('aa'.repeat(32) + '  ./lib/index.js\n' + 'bb'.repeat(32) + '  package.json\n')
  const m2 = manifestMap('aa'.repeat(32) + '  ./lib/index.js\n' + 'cc'.repeat(32) + '  package.json\n')
  expect('清单：解析两行', m1.size === 2 && m1.get('lib/index.js') === 'aa'.repeat(32))
  const d = manifestDiff(m1, m2)
  expect('差异：内容变更被抓到', d.changed.length === 1 && d.changed[0] === 'package.json' && d.same === false)
  expect('差异：全等为 same', manifestDiff(m1, m1).same === true)
  expect('差异：删除被抓到', manifestDiff(m1, manifestMap('aa'.repeat(32) + '  ./lib/index.js\n')).removed.length === 1)

  expect('装配：命中坏插件名', patchMounts("- insert:\n    - id: x\n      name: '@dsh-android/dsh-bad-probe'\n", '@dsh-android/dsh-bad-probe') === true)
  expect('装配：其他插件名不得误判', patchMounts("- insert:\n    - id: x\n      name: '@dsh-android/dsh-android-bridge'\n", '@dsh-android/dsh-bad-probe') === false)

  if (bad > 0) { console.log(`SELFTEST FAILED（${bad}/${total}）`); process.exit(1) }
  console.log(`SELFTEST PASSED（${total} 例，含 6 例否定判据）`)
  process.exit(0)
}

if (has('self-test')) selfTest()
if (!SERIAL) { console.error('缺 --serial（MuMu: 127.0.0.1:16416）'); process.exit(2) }

// ── 设备面 ────────────────────────────────────────────────────────────────

let patchBaseline = ''
const results = []
const record = (name, verdict, detail) => {
  results.push({ name, verdict, detail })
  console.log(`[${verdict}] ${name}${detail ? ' —— ' + detail : ''}`)
}

function adb(args, input) {
  const r = spawnSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, input, timeout: 120000 })
  return ((r.stdout ?? '') + (r.stderr ?? '')).replace(/\r/g, '')
}
const sh = (cmd) => adb(['shell', cmd])
const runAs = (cmd) => sh(`run-as ${PKG} sh -c "${cmd}"`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 引擎健康：host 侧经 adb forward 探 3080（401/200 都算活，连不上才算死）。
 *  用内置 fetch 而不是 spawn curl：Node 在 Windows 上不保证能解析 curl，探活失败会被误判成引擎死。 */
async function engineAlive() {
  adb(['forward', 'tcp:13080', 'tcp:3080'])
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch('http://127.0.0.1:13080/', { signal: ctrl.signal })
    clearTimeout(timer)
    return res.status > 0
  } catch {
    return false
  }
}

const ENGINE_PS = "ps -A -o PID,ARGS 2>/dev/null | grep 'dsh/lib/bin.js' | grep -v grep | awk '{print $1}'"

/**
 * P5 跨版本护栏：把「已知良好记录」的安装指纹篡改成**另一次安装**的指纹，然后重现坏插件故障。
 *
 * 期望：**不回滚**（探针出现 `aborted no-known-good-for-this-install` 且本轮没有新的 `executed ok`）。
 * 反面（旧实现）：CLI 的 restore-last-good 会把上一次安装/崩溃启动时的配置写回 ⇒ 新版本自带的
 * 补丁与挂载项被静默删掉，用户看到「升级后功能反而没了」，而且 APK 还是新的（新代码 + 旧配置混合态）。
 *
 * 注意顺序：先杀引擎再篡改——否则下一拍 HEALTHY 会把记录按当前指纹重写，篡改活不过 5 秒。
 */
async function crossVersionPhase() {
  const knownFile = `${FILES}/.undo-known-good`
  const before = rollbackVerdict(runAs(`cat ${FILES}/undo-gate.log 2>/dev/null`), 0)
  // 越过 30 分钟重试窗：P3 刚成功回滚过，UndoGate 的 RETRY_WINDOW_MS 会**闸掉**这一次尝试
  // （设备实测：不删这个标记则本轮既不回滚也不出现护栏记录，判据拿不到数）。
  runAs(`rm -f ${FILES}/.undo-auto-done`)
  const id = runAs(`head -n 1 ${knownFile}`).trim()
  const pid = sh(ENGINE_PS).trim().split('\n')[0]
  if (id === '' || pid === '') {
    record('P5 跨版本护栏', 'INCONCLUSIVE', `缺已知良好记录（id=${id || 'none'}）或引擎未运行，无法构造跨版本场景`)
    return
  }
  runAs(`kill -9 ${pid}`)
  adb(['shell', `run-as ${PKG} sh -c 'cat > ${knownFile}'`], id + '\n' + 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' + '\n')
  runAs(`mkdir -p ${BAD_DIR}/lib`)
  adb(['shell', `run-as ${PKG} sh -c 'cat > ${BAD_DIR}/package.json'`], JSON.stringify({ name: '@dsh-android/' + BAD_ID, version: '0.0.0', main: 'lib/index.js' }) + '\n')
  adb(['shell', `run-as ${PKG} sh -c 'cat > ${BAD_DIR}/lib/index.js'`], "throw new Error('INJECTED-BAD-PLUGIN')\n")
  adb(['shell', `run-as ${PKG} sh -c 'cat > ${PATCH}'`], patchBaseline.replace(/\n?$/, '\n') + `- insert:\n    - id: ${BAD_ID}\n      name: '@dsh-android/${BAD_ID}'\n`)
  const t0 = Date.now()
  let aborted = false
  let rolled = false
  while (Date.now() - t0 < TIMEOUT_S * 1000) {
    await sleep(5000)
    const log = runAs(`cat ${FILES}/undo-gate.log 2>/dev/null`)
    const r = rollbackVerdict(log, before.oks)
    rolled = r.newOk
    aborted = /aborted no-known-good-for-this-install/.test(log)
    if (rolled || aborted) break
  }
  const logText = runAs(`cat ${FILES}/undo-gate.log 2>/dev/null`)
  writeFileSync(join(EVID, 'undo-gate-cross-version.log'), logText)
  record('P5 跨版本护栏：拒绝把上一次安装的配置写回', aborted && !rolled ? 'PASS' : 'FAIL',
    aborted && !rolled ? `${Math.round((Date.now() - t0) / 1000)}s：探针出现 aborted no-known-good-for-this-install，且本轮零 executed ok`
      : (rolled ? '回滚照旧执行了（会把非本次安装的配置写回）' : '窗口内既没回滚也没见到护栏记录'))
  // 收尾：拆掉注入物并让引擎恢复（健康拍会把记录按当前指纹重写）
  runAs(`rm -rf ${BAD_DIR}`)
  adb(['shell', `run-as ${PKG} sh -c 'cat > ${PATCH}'`], patchBaseline)
  for (let i = 0; i < 60; i++) { if (await engineAlive()) break; await sleep(5000) }
  const backAlive = await engineAlive()
  record('P5 收尾：拆注入物后引擎恢复', backAlive ? 'PASS' : 'FAIL',
    backAlive ? '引擎 HTTP 可达（回滚被拒后引擎仍被看门狗重试并恢复）'
      : '拆掉注入物后引擎仍未恢复（查是否卡在 DEGRADED_LOG 无阶梯：EXECUTION-MAP K02 第 4 项）')
}

async function main() {
  mkdirSync(EVID, { recursive: true })
  console.log(`=== 自动回滚验收（serial=${SERIAL}，等待窗口 ${TIMEOUT_S}s）=== 证据 ${EVID}`)

  // ── P0 前置 ──
  const cliOk = runAs(`test -f ${FILES}/undo-emergency.mjs && echo yes`).includes('yes')
  const snaps = runAs(`ls ${FILES}/home/.dsh/undo-snapshots/auto/ 2>/dev/null | grep -c 2026`)
  if (!cliOk) { record('P0 急救 CLI 已部署', 'INCONCLUSIVE', `${FILES}/undo-emergency.mjs 不存在`); return finish() }
  record('P0 急救 CLI 已部署', 'PASS', 'files/undo-emergency.mjs')
  if (Number(snaps) < 1) { record('P0 有可回滚快照', 'INCONCLUSIVE', `auto 快照数=${snaps}`); return finish() }
  record('P0 有可回滚快照', 'PASS', `auto 快照数=${snaps}`)
  const alive0 = await engineAlive()
  if (!alive0) { record('P0 引擎当前健康（基线）', 'INCONCLUSIVE', '引擎不健康时无法归因是本轮注入造成的'); return finish() }
  record('P0 引擎当前健康（基线）', 'PASS', 'host→tcp:3080 有响应（401=需鉴权，算活）')

  const patchSha0 = runAs(`sha256sum ${PATCH}`).trim().split(/\s+/)[0]
  const man0 = manifestMap(runAs(`cd ${NM} && find . -type f | sort | xargs sha256sum`))
  const log0 = runAs(`cat ${FILES}/undo-gate.log 2>/dev/null`)
  const roll0 = rollbackVerdict(log0, 0)
  const pid0 = sh(ENGINE_PS).trim().split('\n')[0]
  writeFileSync(join(EVID, 'baseline.json'), JSON.stringify({ patchSha0, pluginFiles: man0.size, rollbackOks: roll0.oks, enginePid: pid0 }, null, 2))
  console.log(`基线：patch=${String(patchSha0).slice(0, 12)} 插件文件=${man0.size} 历史回滚成功=${roll0.oks} 引擎 pid=${pid0}`)

  // ── P1 注入坏插件（代码 + 装配两处，模拟「用户装了个坏插件」）──
  const badPkg = JSON.stringify({ name: '@dsh-android/' + BAD_ID, version: '0.0.0', main: 'lib/index.js' })
  const badJs = "throw new Error('INJECTED-BAD-PLUGIN: this plugin must never load')\n"
  runAs(`mkdir -p ${BAD_DIR}/lib`)
  adb(['shell', `run-as ${PKG} sh -c 'cat > ${BAD_DIR}/package.json'`], badPkg + '\n')
  adb(['shell', `run-as ${PKG} sh -c 'cat > ${BAD_DIR}/lib/index.js'`], badJs)
  const entry = `- insert:\n    - id: ${BAD_ID}\n      name: '@dsh-android/${BAD_ID}'\n`
  // 注入前把 patch **整文件**备份：还原时原样写回，不做按行裁剪——设备实测过：按行裁剪会把
  // 上一相位残留的 `- insert:` 与本次追加粘成一行、写坏 YAML，于是「引擎起不来」的真因变成
  // 测试工具自己弄坏的配置（取证彻底失去意义）。
  patchBaseline = runAs(`cat ${PATCH}`)
  writeFileSync(join(EVID, 'patch-baseline.yml'), patchBaseline)
  adb(['shell', `run-as ${PKG} sh -c 'cat > ${PATCH}'`], patchBaseline.replace(/\n?$/, '\n') + entry)
  const patchText1 = runAs(`cat ${PATCH}`)
  const injected = patchMounts(patchText1, '@dsh-android/' + BAD_ID) && runAs(`test -f ${BAD_DIR}/lib/index.js && echo yes`).includes('yes')
  record('P1 坏插件已注入（代码 + 装配）', injected ? 'PASS' : 'INCONCLUSIVE', injected ? `${BAD_DIR} + cordis.patch.yml 追加挂载项` : '注入失败')
  if (!injected) return finish()
  writeFileSync(join(EVID, 'patch-after-inject.yml'), patchText1)

  // ── P2 重启引擎（杀引擎进程，看门狗负责再拉起 → 起不来即累计失败）──
  const killed = sh(ENGINE_PS).trim().split('\n')[0]
  runAs(`kill -9 ${killed}`)
  await sleep(3000)
  const pidNow = sh(ENGINE_PS).trim().split('\n')[0]
  record('P2 引擎已重启（旧进程被杀）', pidNow !== killed ? 'PASS' : 'INCONCLUSIVE', `pid ${killed} -> ${pidNow || '无（看门狗将拉起）'}`)

  // ── P3 等自动回滚 ──
  const t0 = Date.now()
  let roll = rollbackVerdict(runAs(`cat ${FILES}/undo-gate.log 2>/dev/null`), roll0.oks)
  let alive = false
  while (Date.now() - t0 < TIMEOUT_S * 1000) {
    await sleep(5000)
    roll = rollbackVerdict(runAs(`cat ${FILES}/undo-gate.log 2>/dev/null`), roll0.oks)
    if (roll.newOk) { alive = await engineAlive(); if (alive) break }
  }
  const logText = runAs(`cat ${FILES}/undo-gate.log 2>/dev/null`)
  writeFileSync(join(EVID, 'undo-gate.log'), logText)
  const elapsed = Math.round((Date.now() - t0) / 1000)
  if (roll.newOk) {
    record('P3 自动回滚已执行', 'PASS', `${elapsed}s 内新增 executed ok snapshot=${roll.last?.snapshot ?? '?'}`)
  } else {
    record('P3 自动回滚已执行', 'FAIL',
      `${elapsed}s 内没有新增 executed ok（本轮 failed=${roll.failed - roll0.failed}）——回滚没被触发或执行失败`)
  }
  if (!alive) alive = await engineAlive()
  record('P3 引擎恢复健康', alive ? 'PASS' : 'FAIL', alive ? 'host→tcp:3080 有响应' : '回滚后引擎仍不可达')

  // ── P4 剔除坏插件 + 好插件零损坏 ──
  const patchText2 = runAs(`cat ${PATCH}`)
  writeFileSync(join(EVID, 'patch-after-rollback.yml'), patchText2)
  const patchSha2 = runAs(`sha256sum ${PATCH}`).trim().split(/\s+/)[0]
  const mountsBad = patchMounts(patchText2, '@dsh-android/' + BAD_ID)
  record('P4 坏插件已剔除出装配', !mountsBad ? 'PASS' : 'FAIL',
    !mountsBad ? `cordis.patch.yml 不再挂载 ${BAD_ID}（sha ${String(patchSha0).slice(0, 12)} -> ${String(patchSha2).slice(0, 12)}）` : '坏插件仍被 cordis.patch.yml 挂载')

  const man1 = manifestMap(runAs(`cd ${NM} && find . -type f | sort | xargs sha256sum`))
  const diff = manifestDiff(man0, man1)
  // 坏插件自己的目录树整体计入差异，先剔除它本身再判「好插件是否被损坏」。
  const badPrefix = `${BAD_ID}/`
  const goodAdded = diff.added.filter((k) => !k.startsWith(badPrefix))
  const goodRemoved = diff.removed.filter((k) => !k.startsWith(badPrefix))
  const goodChanged = diff.changed.filter((k) => !k.startsWith(badPrefix))
  const goodIntact = goodAdded.length === 0 && goodRemoved.length === 0 && goodChanged.length === 0
  writeFileSync(join(EVID, 'manifest-diff.json'), JSON.stringify({ added: goodAdded, removed: goodRemoved, changed: goodChanged, badResidueFiles: diff.added.filter((k) => k.startsWith(badPrefix)).length + diff.changed.filter((k) => k.startsWith(badPrefix)).length }, null, 2))
  record('P4 我方好插件零损坏（逐文件 sha256）', goodIntact ? 'PASS' : 'FAIL',
    goodIntact ? `@dsh-android/** 共 ${man0.size} 个文件逐一相等`
      : `增 ${goodAdded.length} / 删 ${goodRemoved.length} / 改 ${goodChanged.length}：${[...goodAdded, ...goodRemoved, ...goodChanged].slice(0, 4).join(', ')}`)

  const residue = runAs(`test -d ${BAD_DIR} && echo yes`).includes('yes')
  record('P4 记录：坏插件目录残留', residue ? 'INCONCLUSIVE' : 'PASS',
    residue ? `${BAD_DIR} 仍在磁盘上（剔除的是装配，不是文件）——须由清理或下次快照刷新带走` : '目录已不在')

  // ── P5 跨版本护栏（用户追问②）：「新版本改动不能因为救旧插件被回退掉」──
  if (has('cross-version')) await crossVersionPhase()

  if (!has('keep')) {
    runAs(`rm -rf ${BAD_DIR}`)
    if (String(patchSha2) !== String(patchSha0)) {
      // 回滚没还原 patch 时手工还原（整文件写回基线；不做按行裁剪）
      adb(['shell', `run-as ${PKG} sh -c 'cat > ${PATCH}'`], patchBaseline)
      const shaNow = runAs(`sha256sum ${PATCH}`).trim().split(/\s+/)[0]
      record('清理：patch 文件已还原', String(shaNow) === String(patchSha0) ? 'PASS' : 'FAIL',
        String(shaNow) === String(patchSha0) ? `sha ${String(shaNow).slice(0, 12)} 与基线一致` : `仍不一致：${String(shaNow).slice(0, 12)} vs ${String(patchSha0).slice(0, 12)}`)
    }
  }
  return finish()
}

function finish() {
  writeFileSync(join(EVID, 'results.json'), JSON.stringify(results, null, 2))
  const fail = results.filter((r) => r.verdict === 'FAIL').length
  const inc = results.filter((r) => r.verdict === 'INCONCLUSIVE').length
  console.log(`=== 汇总：PASS=${results.length - fail - inc} FAIL=${fail} INCONCLUSIVE=${inc} ===`)
  process.exit(fail > 0 ? 1 : inc > 0 ? 2 : 0)
}

await main()
