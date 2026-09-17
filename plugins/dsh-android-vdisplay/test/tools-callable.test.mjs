// 虚拟屏工具的**可调用性**回归（离线，node:test；与其余插件单测同一形态）。
//
// 为什么需要这个文件：本插件的 android_vdisplay_create/destroy 曾经**完全不可用**，
// 而该插件此前**一个测试都没有**，没有任何门禁发现它。缺陷是「把服务方法从服务对象上摘下来裸调」：
//   const controlExec = faceOf()?.controlExec;  await controlExec(op, ...)
// 方法内的 this.controlQueue 遂成 undefined.controlQueue，抛
//   Cannot read properties of undefined (reading 'controlQueue')
// 被 catch 包成 code=vdisplay-control-exception。
//
// 该缺陷的恶劣之处：
//   1) 两个工具在**正常使用路径里不会被触发**（要先建屏才会用到），只有「逐个工具点一遍」的
//      全量扫描才会暴露；
//   2) 壳侧桥直接调用同一个 op **完全正常**——只看壳侧会误判成「没问题」。
//
// 夹具是**严格接收者校验**的：服务方法必须挂在对象上被调用；一旦被摘出来裸调，夹具即抛错。
// 已用「把修复改回裸调」做过反证：本测试会精确复现上面那句原始报错并变红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/**
 * 「方法依赖 this」的服务夹具（真实 AndroidPrivilegeService.controlExec 依赖 this.controlQueue）。
 * 任何把它方法摘出来裸调的写法都会在这里抛错——这正是要拦住的形态。
 */
function strictFace() {
  const calls = []
  const face = {
    controlQueue: {
      enqueue: async (op) => ({ ok: true, data: { ok: true, state: 'active', displayId: 42, guidance: op + ' ok' } }),
    },
    async controlExec(op, args, timeoutMs) {
      // 与生产实现同构：先读 this.controlQueue。this 丢失时就是设备上那句真实报错。
      const queue = this.controlQueue
      if (queue === undefined) {
        throw new TypeError("Cannot read properties of undefined (reading 'controlQueue')")
      }
      calls.push({ op, args, timeoutMs })
      return queue.enqueue(op)
    },
  }
  return { face, calls }
}

/** 用桩 ctx 跑 apply()，收集注册的工具。 */
function loadTools(face) {
  const registered = []
  const ctx = {
    logger: () => ({ warn() {}, debug() {}, info() {}, error() {} }),
    tools: { register: (t) => registered.push(t) },
    get: (name) => (name === 'androidPrivilege' ? face : undefined),
    effect: (cb) => { try { return cb?.() } catch { return undefined } },
    on: () => {},
    slots: { inject: () => () => {}, register: () => () => {} },
  }
  apply(ctx)
  return registered
}

const LOST_RECEIVER = /Cannot read propert(?:y|ies) of (?:undefined|null) \(reading '/

test('android_vdisplay_create 必须走通，且不得出现接收者丢失', async () => {
  const { face, calls } = strictFace()
  const tools = loadTools(face)
  const create = tools.find((t) => t.name === 'android_vdisplay_create')
  assert.ok(create, 'android_vdisplay_create 必须注册')
  const value = await create.execute({}, { agent: { session: 't' } })
  const text = JSON.stringify(value ?? {})
  assert.doesNotMatch(text, LOST_RECEIVER, '返回值含「服务方法接收者丢失」错误（应写成 svc.method(...)）: ' + text)
  assert.doesNotMatch(text, /is not a function/, '返回值含 is not a function: ' + text)
  assert.ok(calls.length > 0, '必须真的经控制队列调用到壳侧')
  assert.equal(value.ok, true, '服务在场时必须成功: ' + text)
  assert.equal(value.displayId, 42)
})

test('android_vdisplay_destroy 同样必须走通（同一缺陷类）', async () => {
  const { face, calls } = strictFace()
  const tools = loadTools(face)
  const destroy = tools.find((t) => t.name === 'android_vdisplay_destroy')
  assert.ok(destroy, 'android_vdisplay_destroy 必须注册')
  const value = await destroy.execute({}, { agent: { session: 't' } })
  assert.doesNotMatch(JSON.stringify(value ?? {}), LOST_RECEIVER)
  assert.ok(calls.length > 0)
})

test('服务缺席时给结构化拒绝（不抛异常、不静默）', async () => {
  const tools = loadTools(undefined)
  const create = tools.find((t) => t.name === 'android_vdisplay_create')
  const value = await create.execute({}, { agent: { session: 't' } })
  assert.equal(value.ok, false)
  assert.equal(value.code, 'vdisplay-control-unavailable')
  assert.equal(typeof value.guidance, 'string')
})
