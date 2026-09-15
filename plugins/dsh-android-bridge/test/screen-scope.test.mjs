import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  currentScreenScope,
  controlOpNeedsRealScreen,
  decideScreenAccess,
  normalizeScreenScope,
  parseScreenScopePrefsXml,
  realScreenAdbCommandDenied,
} from '../lib/screen-scope.js'

test('screen scope normalizes native preference values fail-closed', () => {
  assert.equal(normalizeScreenScope('virtual-only'), 'virtual-only')
  assert.equal(normalizeScreenScope('real-only'), 'real-only')
  assert.equal(normalizeScreenScope('all'), 'all')
  assert.equal(normalizeScreenScope('everything'), 'virtual-only')
  assert.equal(parseScreenScopePrefsXml('<map><string name="scope">real-only</string></map>'), 'real-only')
  assert.equal(parseScreenScopePrefsXml('<map/>'), 'virtual-only')
})

test('screen target decision never maps virtual-1 to display 0', () => {
  assert.deepEqual(decideScreenAccess('real-only', 'real'), {
    ok: true, screenId: 'real', displayId: 0, scope: 'real-only',
  })
  const virtual = decideScreenAccess('virtual-only', 'virtual-1')
  assert.equal(virtual.ok, false)
  if (!virtual.ok) assert.equal(virtual.reason, 'screen-not-ready')
  const blockedReal = decideScreenAccess('virtual-only', 'real')
  assert.equal(blockedReal.ok, false)
  if (!blockedReal.ok) assert.equal(blockedReal.reason, 'screen-out-of-scope')
})

// review C11 alias 契约：原生注册表解析出动态 displayId 后，virtual-1 才是可执行目标
// （绝不假设 displayId==1、绝不回退 0；非正数/非整数一律退回 not-ready）。
test('virtual-1 becomes executable only with a resolved native display id', () => {
  assert.deepEqual(decideScreenAccess('virtual-only', 'virtual-1', { virtualDisplayId: 7 }), {
    ok: true, screenId: 'virtual-1', displayId: 7, scope: 'virtual-only',
  })
  assert.deepEqual(decideScreenAccess('all', 'virtual-1', { virtualDisplayId: 3 }), {
    ok: true, screenId: 'virtual-1', displayId: 3, scope: 'all',
  })
  for (const bad of [0, -1, null, undefined, 1.5]) {
    const d = decideScreenAccess('virtual-only', 'virtual-1', { virtualDisplayId: bad })
    assert.equal(d.ok, false, 'displayId=' + String(bad))
    if (!d.ok) assert.equal(d.reason, 'screen-not-ready')
  }
  // 范围不含 virtual 时，即便解析出 displayId 也必须拒绝（范围优先）。
  const blocked = decideScreenAccess('real-only', 'virtual-1', { virtualDisplayId: 7 })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.equal(blocked.reason, 'screen-out-of-scope')
})

// review C11 执行点分类：真实屏内容/输入 op 必须被识别；元数据与 browser/vd op 不在列。
test('real-screen control ops are classified for execution-point scope checks', () => {
  for (const op of ['snapshot', 'click', 'longClick', 'setText', 'scroll', 'global', 'screenshot', 'nodeText', 'webSnapshot', 'webAction']) {
    assert.equal(controlOpNeedsRealScreen(op), true, op)
  }
  for (const op of ['state', 'vdInfo', 'vdCreate', 'browserShot', 'browserState', 'browserOpen']) {
    assert.equal(controlOpNeedsRealScreen(op), false, op)
  }
})

// review C11 raw shell 面：virtual-only 下 screencap/input/uiautomator 等命令在执行点拒绝，
// 只读元数据命令放行；real-only/all 不拦（真实屏本就在范围内）。
test('raw adb real-screen commands are denied outside the real-screen scope', () => {
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'screencap -p /sdcard/a.png'))
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'input tap 100 200'))
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'uiautomator dump /sdcard/x.xml'))
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'dumpsys window'))
  assert.ok(realScreenAdbCommandDenied('virtual-only', 'am start -n com.example/.Main'))
  assert.equal(realScreenAdbCommandDenied('virtual-only', 'getprop ro.product.model'), null)
  assert.equal(realScreenAdbCommandDenied('virtual-only', 'pm list packages'), null)
  assert.equal(realScreenAdbCommandDenied('virtual-only', 'ls /sdcard/Download'), null)
  assert.equal(realScreenAdbCommandDenied('real-only', 'screencap -p /sdcard/a.png'), null)
  assert.equal(realScreenAdbCommandDenied('all', 'input tap 1 1'), null)
})

test('test-only scope source cannot be overridden by an ordinary environment value', () => {
  assert.equal(currentScreenScope({ DSH_SCREEN_SCOPE: 'all' }), 'virtual-only')
  assert.equal(currentScreenScope({ DSH_SCREEN_SCOPE_TEST: '1', DSH_SCREEN_SCOPE: 'all' }), 'all')
})
