// 渐进披露门（0.14.0 §4.1）：常驻 facade + agent 作用域掩蔽 + skill 目录条目。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  installCapabilityGate,
  CAPABILITY_TOOL_NAME,
  DEVICE_TOOLS,
  DEVICE_TOOL_GROUPS,
} from '../lib/capability-gate.js'

function harness() {
  const registered = []
  const skills = []
  const events = []
  const denies = []
  const scopedCtx = {
    tools: {
      restrict: (filter) => {
        denies.push(filter.deny)
        return () => { state.disposeCount += 1 }
      },
    },
  }
  const agent = {
    ctx: {
      inject: (_deps, callback) => {
        callback(scopedCtx)
        return { dispose: () => { state.disposeCount += 1 } }
      },
    },
  }
  const state = { disposeCount: 0, agent }
  const ctx = {
    tools: { register: (tool) => { registered.push(tool) } },
    get: (name) => (name === 'skills' ? { register: (skill) => { skills.push(skill) } } : undefined),
    on: (event, handler) => { events.push([event, handler]) },
    logger: { warn: () => {} },
  }
  return { ctx, registered, skills, events, state, denies }
}

test('facade 常驻注册且名字固定', () => {
  const h = harness()
  installCapabilityGate(h.ctx)
  assert.equal(h.registered.length, 1)
  assert.equal(h.registered[0].name, CAPABILITY_TOOL_NAME)
  assert.equal(DEVICE_TOOLS.includes(CAPABILITY_TOOL_NAME), false)
})

test('skill 目录登记三个能力组（发现 + 先调 facade 指引）', () => {
  const h = harness()
  installCapabilityGate(h.ctx)
  const names = h.skills.map((s) => s.name).sort()
  assert.deepEqual(names, ['android-ai-browser', 'android-phone-control', 'android-virtual-display'])
  for (const skill of h.skills) {
    assert.match(skill.content, new RegExp(CAPABILITY_TOOL_NAME))
  }
})

test('agent/created 时按组分别掩蔽；facade 调用后逐组解锁并如实回报', async () => {
  const h = harness()
  installCapabilityGate(h.ctx, () => ({ a11y: true, shizuku: false }))
  const handler = h.events.find(([event]) => event === 'agent/created')?.[1]
  assert.equal(typeof handler, 'function')
  handler({ agent: h.state.agent })
  const masked = h.denies.flat().sort()
  assert.deepEqual(masked, [...DEVICE_TOOLS].sort())
  assert.equal(h.denies.length, Object.keys(DEVICE_TOOL_GROUPS).length)
  // 只解锁 browser：phone / virtual-display 仍在锁内
  const one = await h.registered[0].execute({ group: 'browser' }, { agent: h.state.agent })
  assert.deepEqual(one.unlocked, ['browser'])
  assert.deepEqual([...one.locked].sort(), ['phone', 'virtual-display'])
  assert.deepEqual(one.channels, { a11y: true, shizuku: false })
  assert.match(one.text, /未就绪/)
  assert.equal(h.state.disposeCount, 1)
  // 再解锁 all：剩下两组解锁，locked 清空
  const rest = await h.registered[0].execute({ group: 'all' }, { agent: h.state.agent })
  assert.deepEqual([...rest.unlocked].sort(), ['phone', 'virtual-display'])
  assert.deepEqual(rest.locked, [])
})

test('skill 条目必须带 source（上游 SkillSummary 必填；缺了会在加载时抛错）', () => {
  const h = harness()
  installCapabilityGate(h.ctx)
  for (const skill of h.skills) {
    assert.equal(typeof skill.source, 'string')
    assert.ok(skill.source.length > 0)
    assert.equal(typeof skill.content, 'string')
  }
})

test('缺失 skills 服务或作用域注入时降级不抛（fail-open 到今天的可见性）', () => {
  const registered = []
  installCapabilityGate({ tools: { register: (tool) => { registered.push(tool) } } })
  assert.equal(registered.length, 1)
})
