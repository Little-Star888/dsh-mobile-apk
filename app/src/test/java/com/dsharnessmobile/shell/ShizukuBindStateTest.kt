package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * D7（0.14.1）Shizuku 绑定看门狗与文案三态的行为回归。
 *
 * 缺陷（设备实锤，Redmi K70E / 0.14.1-preview）：Shizuku 授权后 UI 永久停在「正在建立 shell UserService」。
 * 本体不是「建连慢」，而是**绑定闩没有任何超时**：复位点只有「同步抛异常」与「回调」两处，
 * Shizuku 侧既不抛也不回调时 `binding` 永久为 true → `kickBind` 的守卫从此关掉全部重试 →
 * 每轮只报「正在建立」。症状因此必然是「卡住」而非「失败」，且进程内不可自愈。
 *
 * 纯 JVM（无 Robolectric、不真连 Shizuku）：[ShizukuBindState] 与 [shizukuBindGuidance]
 * 都不触碰 Android 类，生产面也不留测试注入点（本仓纪律：测试改为显式传参）。
 *
 * 反证方式：把 `reapIfStale` 的阈值判定去掉（永远返回 false），下面
 * `aBindThatNeverCallbacksIsReapedAfterTheWatchdog` 与
 * `afterReapingTheSecondAttemptIsActuallyStarted` 必红——即本缺陷的形状。
 */
class ShizukuBindStateTest {

  private val watchdog = 20_000L

  // ── 看门狗：僵尸绑定必须被回收 ──────────────────────────────────────

  /** 核心反证：一次永不回调的 bind，必须在阈值后被复位（而不是永久闩死）。 */
  @Test
  fun aBindThatNeverCallbacksIsReapedAfterTheWatchdog() {
    val s = ShizukuBindState(watchdog)
    assertTrue("首次发起必须成功", s.beginAttempt(now = 1_000L))
    assertTrue("发起后 binding 必须为真（此时才配说「正在建立」）", s.binding)
    assertEquals(ShizukuBindCodes.CONNECTING, s.lastError)

    assertFalse("阈值内不得回收（否则会打断一次正常的慢绑定）", s.reapIfStale(1_000L + watchdog))
    assertTrue("binding 仍应在飞", s.binding)

    assertTrue("超过阈值必须回收僵尸绑定", s.reapIfStale(1_000L + watchdog + 1))
    assertFalse("回收后 binding 必须复位——否则 kickBind 的守卫会永久关掉重试", s.binding)
    assertEquals(
      "回收必须写入真实错误码（不是继续报 connecting）",
      ShizukuBindCodes.BIND_TIMEOUT,
      s.lastError,
    )
  }

  /** 反证 ②：回收之后，第二次调用必须**确实再次发起**绑定（次数可观测）。 */
  @Test
  fun afterReapingTheSecondAttemptIsActuallyStarted() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    // 僵尸在飞时不得重复发起（幂等，避免无谓抖动）
    assertFalse("僵尸在飞时 beginAttempt 必须拒绝", s.beginAttempt(1L))
    assertEquals(1, s.attempts)

    assertTrue(s.reapIfStale(watchdog + 1))
    assertTrue("回收后必须允许新的尝试——这正是本缺陷从「卡死」变成「可重试」的分界", s.beginAttempt(watchdog + 2))
    assertEquals("必须观察到第二次真实发起", 2, s.attempts)
    assertEquals(ShizukuBindCodes.CONNECTING, s.lastError)
  }

  /** 幂等：轮询路径每 2s 调一次，回收过后再调不得重复记账（否则日志与错误码会被反复改写）。 */
  @Test
  fun reapIsIdempotentOnThePollPath() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    assertTrue(s.reapIfStale(watchdog + 1))
    assertFalse("已回收后必须返回 false（否则每轮轮询都重复记日志）", s.reapIfStale(watchdog + 2))
    assertFalse(s.reapIfStale(watchdog + 999_999))
    assertEquals("重复回收不得改写错误码", ShizukuBindCodes.BIND_TIMEOUT, s.lastError)
  }

  /** 未在绑定中时，等待时长的哨兵是 -1 而不是 0（0 是合法等待值，用它冒充会把「未发起」读成「刚发起」）。 */
  @Test
  fun attemptAgeIsMinusOneWhenNotBinding() {
    val s = ShizukuBindState(watchdog)
    assertEquals(-1L, s.attemptAgeMs(123_456L))
    s.beginAttempt(10_000L)
    assertEquals(0L, s.attemptAgeMs(10_000L))
    assertEquals(2_500L, s.attemptAgeMs(12_500L))
    s.onDisconnected()
    assertEquals(-1L, s.attemptAgeMs(12_500L))
  }

  // ── 复位点：抛异常 / 无效 binder / 断连 ─────────────────────────────

  /** `bindUserService` 同步抛异常：必须复位，否则那个永不回调的闩会把后续调用全挡死。 */
  @Test
  fun onBindThrewResetsSoTheNextAttemptIsPossible() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    s.onBindThrew(ShizukuBindCodes.bindFailed(IllegalStateException("boom")))
    assertFalse(s.binding)
    assertEquals(
      "code 必须带上异常类型（现场可诊）",
      "shizuku-user-service-bind-failed:IllegalStateException",
      s.lastError,
    )
    assertTrue("抛异常后必须能立刻重试", s.beginAttempt(1L))
    assertEquals(2, s.attempts)
  }

  /** 回调了但 binder 无效：不得当成「连上」（与 status() 的 bound 判据同口径）。 */
  @Test
  fun onConnectedWithAnInvalidBinderIsNotTreatedAsBound() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    s.onConnected(binderValid = false)
    assertFalse("binder 无效时 binding 必须复位", s.binding)
    assertEquals(ShizukuBindCodes.INVALID_BINDER, s.lastError)

    val ok = ShizukuBindState(watchdog)
    ok.beginAttempt(0L)
    ok.onConnected(binderValid = true)
    assertFalse(ok.binding)
    assertEquals("连上后错误码必须清空（status() 据此回 ready）", "", ok.lastError)
  }

  @Test
  fun onDisconnectedResetsForReconnect() {
    val s = ShizukuBindState(watchdog)
    s.beginAttempt(0L)
    s.onConnected(binderValid = true)
    s.onDisconnected()
    assertFalse(s.binding)
    assertEquals(ShizukuBindCodes.DISCONNECTED, s.lastError)
    assertTrue("断连后必须能重建连接", s.beginAttempt(5L))
  }

  // ── 文案三态：不许用一句「正在建立」盖住三种状态 ────────────────────

  /** 不变量：「正在建立」这四个字**当且仅当** binding 为真时才允许出现。 */
  @Test
  fun theConnectingWordingRequiresABindActuallyInFlight() {
    val codes = listOf(
      ShizukuBindCodes.CONNECTING,
      ShizukuBindCodes.NOT_BOUND,
      ShizukuBindCodes.BIND_TIMEOUT,
      ShizukuBindCodes.INVALID_BINDER,
      ShizukuBindCodes.DISCONNECTED,
      "shizuku-user-service-bind-failed:IllegalStateException",
      "shizuku-something-new",
    )
    for (code in codes) {
      val text = shizukuBindGuidance(code, binding = false, ageMs = -1L, watchdogMs = watchdog)
      assertFalse(
        "无 bind 在飞时不得说「正在建立」（code=$code）——旧实现正是这样把失败盖成进行中的",
        text.contains("正在建立"),
      )
    }
    val live = shizukuBindGuidance(ShizukuBindCodes.CONNECTING, binding = true, ageMs = 3_000L, watchdogMs = watchdog)
    assertTrue("确有 bind 在飞时才说「正在建立」", live.contains("正在建立"))
  }

  /** 超时态必须给出「可立即重试」而不是「去设置页排查」，并把已等待时长写进文案。 */
  @Test
  fun theTimeoutGuidanceIsActionableNotAVagueFailure() {
    val text = shizukuBindGuidance(ShizukuBindCodes.BIND_TIMEOUT, binding = false, ageMs = -1L, watchdogMs = watchdog)
    assertTrue("必须点明超时", text.contains("超时"))
    assertTrue("必须给出可执行动作", text.contains("可直接重试"))
    assertTrue("必须写明判据时长（用户据此判断是不是真卡住）", text.contains("20s"))
    assertFalse("超时不是「去设置页」那类需要排查的状态", text.contains("查看状态与引导"))
  }

  /** 「尚未发起」与「正在建立」必须可区分：前者不该让用户干等。 */
  @Test
  fun notBoundIsDistinctFromConnecting() {
    val text = shizukuBindGuidance(ShizukuBindCodes.NOT_BOUND, binding = false, ageMs = -1L, watchdogMs = watchdog)
    assertTrue("必须点明尚未发起", text.contains("尚未发起"))
    assertFalse("尚未发起时不得让人干等", text.contains("正在建立"))
  }

  /** 进行中文案必须带已等待秒数（否则用户无法判断它到底在动还是冻住）。 */
  @Test
  fun theConnectingGuidanceReportsElapsedSeconds() {
    val text = shizukuBindGuidance(ShizukuBindCodes.CONNECTING, binding = true, ageMs = 7_400L, watchdogMs = watchdog)
    assertTrue("必须写出已等待秒数：$text", text.contains("已等待 7s"))
    assertTrue("必须写出上限：$text", text.contains("上限 20s"))
    assertTrue("必须明确「直接重试即可」，不得把瞬时态说成需要排查", text.contains("重试"))
  }

  /** 未知 code 必须有兜底文案（上游/壳侧新增 code 时不得静默空串）。 */
  @Test
  fun anUnknownCodeStillProducesGuidance() {
    val text = shizukuBindGuidance("shizuku-brand-new-code", binding = false, ageMs = -1L, watchdogMs = watchdog)
    assertTrue(text.isNotBlank())
    assertTrue("兜底文案必须带上 code（现场可诊）", text.contains("shizuku-brand-new-code"))
  }
}
