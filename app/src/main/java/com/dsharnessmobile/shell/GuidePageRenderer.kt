package com.dsharnessmobile.shell

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.content.Intent
import android.os.Build
import android.os.Environment
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import java.io.File

/** 引导页（启动/测试界面）纯代码 UI：GuidePhase 状态机驱动视图渲染 + WebUI/引导页切换（自 MainActivity 拆出）。 */

internal enum class GuidePhase { Idle, Starting, Extracting, Updating, Recovering, Undoing, Error, Closed, Info }

// ── 状态副文案的仲裁（S1-2；顶层纯逻辑，JVM 可测）──────────────────────────
//
// 缺陷现场：五个来源（相位默认句 / 流程进度 / 旁路回执 / 下载提示 / 日志回执）各自直接写
// `chrome.statusHint.text`，彼此没有优先级——同一时刻显示哪一句取决于调用时序。
// 于是「正在更新运行时 686MB」会被一行旁路回执顶掉（设备实测：首启解压期间点「检查更新」）。

/** 副文案的来源与优先级（数字越大越"硬"，只有更高或同级能顶掉它）。 */
internal enum class HintSource(val priority: Int) {
  /** 相位驱动的文案（启动/解压/回滚…）。 */
  PHASE(30),

  /** 流程内进度/阶段（下载百分比、解压阶段名）。 */
  FLOW(20),

  /** 旁路动作的回执（检查更新结果、复制日志回执、探测中…）。 */
  SIDE(10),
}

/**
 * 是否接受这次写入。
 * @param current 当前文案的来源（null = 还没有人写过）。
 * @param currentSticky 当前文案是否**不可打断**（相位锁定期内写的才置位）。
 * @param incoming 本次写入的来源。
 *
 * 规则：不可打断的文案只能被**同级或更高**优先级顶掉（即另一条相位文案）；否则一律拒绝。
 * 非锁定期一切照常（后写者赢）——这样「点检查更新，然后它回报结果」这条正常路径不受影响。
 */
internal fun hintAccepted(current: HintSource?, currentSticky: Boolean, incoming: HintSource): Boolean =
  !currentSticky || incoming.priority >= (current?.priority ?: 0)

/**
 * 运行时解压后的**近似**总字节数（S1-4）：**文案与进度条唯一的同一口径来源**。
 *
 * 缺陷现场：副文案写死「约 700MB」，而进度行只显示「已写入 166 MB」——两个数字口径不同
 * （前者=解压后总量，后者=已解压量），用户无法把两者对上，也就无法判断「还要多久」。
 * 现在量纲统一为「已解压字节 / 该常量」，百分比与文案一起变。
 *
 * 为什么是近似值而不是归档里的精确 total：`refreshSnapshot(onProgress)` 给的 total 是
 * **压缩包字节数**，与 done（解压后字节数）不同量纲，直接相除会算出一个偏大且与文案矛盾的百分比
 * （旧注释已经写明这一点）。用常量则是「一个诚实的近似」：文案本来就写着「约」。
 */
internal const val RUNTIME_UNCOMPRESSED_APPROX_BYTES = 700L * 1024 * 1024

/**
 * 解压进度百分比（S1-4，纯函数 JVM 可测）。
 *
 * @return 0..99 的百分比；**上限刻意压在 99**（不知道精确总量时不得宣称 100%，那是「已完成」的意思）；
 *   [totalBytes] <= 0 时返回 -1 = 无法判定，调用方据此保持进度条的不确定态。
 */
internal fun runtimeProgressPercent(doneBytes: Long, totalBytes: Long = RUNTIME_UNCOMPRESSED_APPROX_BYTES): Int =
  if (totalBytes <= 0) -1 else ((doneBytes.coerceAtLeast(0) * 100) / totalBytes).toInt().coerceIn(0, 99)

/**
 * 自动回撤不可用时给用户看的一句话（S1-6，纯函数 JVM 可测）。
 *
 * 缺陷现场：`EngineStartFlow` 直接 `result.summary.take(120)` 当副文案，而 summary 是 UndoGate 的
 * **内部判定句**——「插件清单已变化但点名不出失败插件：不做整份回滚（避免连用户其它插件一起回退）」。
 * 用户既看不懂这是好事还是坏事，也读不出「我现在该做什么」。
 * 按可判定的关键词归类到五条用户口径；原始 summary 仍照旧落盘、可复制（诊断信息不丢）。
 */
internal fun undoUnavailableHint(summary: String): String = when {
  summary.contains("超时") -> "读取快照清单超时（状态未知，不等于没有快照）——稍后会自动重试；仍失败请打开控制台看 engine.log。"
  summary.contains("未部署") -> "急救工具未就绪，暂时无法自动回撤——重装应用可恢复该工具；期间请打开控制台排查。"
  summary.contains("无快照可回滚") -> "没有可用的回滚点（本次安装还没建立健康快照）——重启应用会自动重试启动。"
  summary.contains("点名不出") || summary.contains("不做整份回滚") ->
    "检测到插件清单有变化但定位不到具体是哪个插件，因此**没有**做整份回滚（以免连你自己装的插件一起回退）——请打开控制台检查插件。"
  else -> "自动回撤没能完成——请打开控制台查看 engine.log 后再试。"
}

internal class GuidePageRenderer(private val activity: MainActivity) {

  lateinit var chrome: GuideChrome
  private lateinit var engineStatus: TextView
  /** 引擎启动流写入解压进度（EngineStartFlow）。 */
  lateinit var progressText: TextView
  private lateinit var progressBar: ProgressBar
  private lateinit var crashBanner: TextView
  private lateinit var logSummary: TextView
  /** 测试界面三段式结构块：入场 stagger 动画按块依次淡入。 */
  private lateinit var brandBlock: View
  private lateinit var cardBlock: View
  private lateinit var actionBlock: View
  var lastGuidePhase: GuidePhase = GuidePhase.Idle
    private set
  private var statusPulse: ObjectAnimator? = null

  // —— S1-2：状态副文案的仲裁状态（唯一写入口 pushHint 维护） ——
  private var hintSource: HintSource? = null
  private var hintSticky = false

  /** S1-4：进度条是否处于确定档（相位切换时据此决定要不要打回不确定态）。 */
  private var progressDeterminate = false

  // —— APK 自更新（0.13.8 批 H）状态：仅手动触发、同一按钮二次确认 ——
  /** 已发现的新版（非空 = 按钮停在「下载并安装 vX」二次确认态，再点才开始下载）。 */
  private var apkPending: UpdateChecker.CheckResult.Available? = null
  /** 下载完成待安装的包（授权页返回后由 settlePendingInstall 续继）。 */
  private var apkReadyToInstall: File? = null
  private var apkBusy = false

  fun buildGuideView(): LinearLayout {
    chrome = buildGuideChrome(
      activity,
      GuideCallbacks(
        onStartEngine = {
          activity.engineFlow.engineRetryCount = 0 // 手动重试归零自动重试计数
          // 0.14.1 D2：同时清空**跨进程**的快照刷新失败账本。用户显式点「重试」就是要求
          // 「再试一次刷新」；不清账的话降级闸门会让他永远拿不到那次刷新，按钮就成了摆设。
          activity.engineManager.clearRefreshLedger()
          activity.startEngineFlow()
        },
        onOpenConsole = { activity.startActivity(Intent(activity, ConsoleActivity::class.java)) },
        onCheckUpdate = { onUpdateButton() },
        onGrantStorage = { activity.dirPickerController.requestStorageGrant() },
        onCopyLog = { copyGuideLog() },
      ),
    )
    engineStatus = chrome.engineStatus
    progressText = chrome.progressText
    progressBar = chrome.progressBar
    crashBanner = chrome.crashBanner
    logSummary = chrome.logSummary
    brandBlock = chrome.brandBlock
    cardBlock = chrome.cardBlock
    actionBlock = chrome.actionBlock
    chrome.versionLabel.text = "v" + BuildConfig.VERSION_NAME
    refreshGuideMeta()
    return chrome.root
  }

  /** 测试界面入场：品牌区/状态卡/操作区依次淡入上移。仅在界面从隐藏变为可见时播放。 */
  private fun animateGuideReveal() {
    val rise = 16 * activity.resources.displayMetrics.density
    val items = listOf(brandBlock, cardBlock, actionBlock)
    items.forEachIndexed { i, v ->
      v.animate().cancel()
      v.alpha = 0f
      v.translationY = rise
      v.animate()
        .alpha(1f).translationY(0f)
        .setStartDelay(i * 80L).setDuration(480L)
        .setInterpolator(DsUi.ease).start()
    }
  }

  fun applyGuidePhase(phase: GuidePhase, title: String, hint: String? = null) {
    lastGuidePhase = phase
    engineStatus.text = title
    val resolvedHint = hint ?: defaultHint(phase)
    // S1-2：相位文案走仲裁漏斗（不可打断相位期间，旁路回执不得顶掉它）。
    pushHint(resolvedHint, HintSource.PHASE, sticky = phaseLocked(phase))

    val busy = phase == GuidePhase.Starting ||
      phase == GuidePhase.Extracting ||
      phase == GuidePhase.Updating ||
      phase == GuidePhase.Recovering ||
      phase == GuidePhase.Undoing
    val lockPrimary = phase == GuidePhase.Starting ||
      phase == GuidePhase.Extracting ||
      phase == GuidePhase.Updating ||
      phase == GuidePhase.Undoing ||
      // S1-3：**自动恢复期间也必须锁**。旧实现在 Recovering 时让主按钮可点且写着「重试」，
      // 而此刻看门狗正在自动重试——用户点它只会打断正在进行的恢复，且手册里那句「重试」
      // 与自动流程在同一屏上互相打架（点了之后仍回到「正在自动恢复」）。
      phase == GuidePhase.Recovering
    chrome.primaryButton.isEnabled = !lockPrimary
    chrome.primaryButton.alpha = if (lockPrimary) 0.55f else 1f
    chrome.primaryButton.text = when (phase) {
      GuidePhase.Closed -> activity.getString(R.string.ds_restart)
      GuidePhase.Error -> activity.getString(R.string.ds_retry)
      GuidePhase.Recovering -> activity.getString(R.string.ds_recovering)
      GuidePhase.Starting, GuidePhase.Extracting -> activity.getString(R.string.ds_starting)
      GuidePhase.Updating -> activity.getString(R.string.ds_updating)
      GuidePhase.Undoing -> activity.getString(R.string.ds_undoing)
      GuidePhase.Idle, GuidePhase.Info -> activity.getString(R.string.ds_start_engine)
    }

    val showProgress = busy
    progressBar.visibility = if (showProgress) View.VISIBLE else View.GONE
    // S1-4：默认不确定态；流程拿到**同口径**的进度时（setDeterminateProgress）切确定态。
    if (!progressDeterminate) progressBar.isIndeterminate = true
    if (phase != GuidePhase.Extracting) progressText.visibility = View.GONE

    val dotColor = when (phase) {
      GuidePhase.Error, GuidePhase.Closed -> activity.getColor(R.color.ds_danger)
      GuidePhase.Updating, GuidePhase.Extracting -> activity.getColor(R.color.ds_warn)
      GuidePhase.Starting, GuidePhase.Recovering, GuidePhase.Undoing -> activity.getColor(R.color.ds_accent)
      // Info = 中性事实陈述（本版没有这项能力、无需处理），既不是故障（红）也不是进行中（黄）。
      GuidePhase.Idle, GuidePhase.Info -> activity.getColor(R.color.ds_text_tertiary)
    }
    chrome.statusDot.background = DsUi.oval(dotColor)
    setStatusPulse(busy)
    refreshGuideMeta()
  }

  /** 只更新副标题（不动相位/状态点/主按钮）。
   *
   *  用途：**不可打断的相位**（首启解压 / 启动 / 回滚）进行中，旁路动作（如「检查更新」）的结果
   *  不该抢占状态行——否则「正在更新运行时 686MB」会被一行「本版不提供在线更新」顶掉，
   *  用户以为解压被取消了（设备实测：首启解压期间点「检查更新」正是这个现象）。 */
  fun applyGuideHint(text: String) = pushHint(text, HintSource.SIDE)

  /** 流程内进度/阶段文案（优先级高于旁路回执、低于相位文案）。 */
  fun applyFlowHint(text: String) = pushHint(text, HintSource.FLOW)

  /**
   * 状态副文案的**唯一写入口**（S1-2）。
   *
   * 缺陷现场：全仓有 5 个来源直接写 `chrome.statusHint.text`（相位默认句、流程进度、旁路回执、
   * 下载提示、日志回执），彼此没有优先级——最终显示哪一句**取决于调用时序**（哪个线程先跑完）。
   * 表现是「同一时刻显示哪句话说不清」，而且不可打断的相位句会被旁路回执顶掉。
   * 修法：全部经此漏斗，按 [HintSource] 的优先级仲裁（见 [hintAccepted]）。
   */
  private fun pushHint(text: String, source: HintSource, sticky: Boolean = false) {
    if (!hintAccepted(hintSource, hintSticky, source)) return
    hintSource = source
    hintSticky = sticky
    chrome.statusHint.text = text
    chrome.statusHint.visibility = if (text.isBlank()) View.GONE else View.VISIBLE
  }

  /** 当前相位是否为**不可打断**（旁路动作只能写 hint，不得改相位）。 */
  fun phaseLocked(): Boolean = phaseLocked(lastGuidePhase)

  private fun phaseLocked(phase: GuidePhase): Boolean = phase == GuidePhase.Starting ||
    phase == GuidePhase.Extracting ||
    phase == GuidePhase.Undoing

  /** S1-4：进度条切确定档（流程知道同口径的 done/total 时调用；total<=0 回不确定态）。 */
  fun setDeterminateProgress(doneBytes: Long, totalBytes: Long) {
    val pct = runtimeProgressPercent(doneBytes, totalBytes)
    progressDeterminate = pct >= 0
    progressBar.isIndeterminate = pct < 0
    if (pct >= 0) progressBar.progress = pct
  }

  private fun defaultHint(phase: GuidePhase): String = when (phase) {
    GuidePhase.Starting -> "首次启动会解压内嵌运行时，请保持应用在前台。"
    // S1-4：句中的体量由**常量**渲染，不再是与进度条各自为政的字面量「约 700MB」。
    GuidePhase.Extracting -> extractHintBody()
    GuidePhase.Updating -> "下载并校验快照后会自动切换运行时。"
    GuidePhase.Recovering -> "看门狗正在拉起引擎，通常几秒内恢复。"
    GuidePhase.Undoing -> "正在把配置/插件回滚到最后良好快照（自动回撤）。"
    GuidePhase.Error -> "可打开控制台查看 engine.log，或点击重试。"
    GuidePhase.Closed -> "引擎已停止，不会自动恢复。"
    GuidePhase.Idle -> "引擎就绪后将进入 " + UserCopy.APP_NAME + "。首次使用需授予存储权限——导出文件与日志要写在公共目录。"
    GuidePhase.Info -> "运行时随安装包一起更新：安装新版 APK 即完成升级。"
  }

  /** 解压相位文案（体量与进度条同源；见 RUNTIME_UNCOMPRESSED_APPROX_BYTES）。 */
  private fun extractHintBody(): String =
    "正在写入内嵌 Termux 环境，约 " + (RUNTIME_UNCOMPRESSED_APPROX_BYTES / 1024 / 1024) +
      "MB，需数分钟，请勿关闭应用。"

  private fun setStatusPulse(on: Boolean) {
    if (on) {
      val anim = statusPulse ?: ObjectAnimator.ofFloat(chrome.statusDot, View.ALPHA, 1f, 0.28f).apply {
        duration = 900
        repeatMode = ValueAnimator.REVERSE
        repeatCount = ValueAnimator.INFINITE
        interpolator = DsUi.ease
        statusPulse = this
      }
      if (!anim.isStarted) anim.start()
    } else {
      statusPulse?.cancel()
      chrome.statusDot.alpha = 1f
    }
  }

  /** 取消状态点脉冲动画（onDestroy 兜底，自 MainActivity.onDestroy 迁入）。 */
  fun cancelPulse() {
    statusPulse?.cancel()
    statusPulse = null
  }

  fun refreshGuideMeta() {
    if (!::chrome.isInitialized) return
    val runtimeReady = try { activity.engineManager.engineReady } catch (_: Exception) { false }
    chrome.runtimeChip.text = if (runtimeReady) {
      activity.getString(R.string.ds_runtime_ready)
    } else {
      activity.getString(R.string.ds_runtime_pending)
    }
    // 0.14.1 用户反馈：chip 判据从「SDK 版本 或 isExternalStorageManager」改为
    // **公共目录供给的真实结果**（EngineManager 落盘的状态）。
    // 旧判据写的是 `SDK_INT < 30 || isExternalStorageManager()` → API<30 一律显示「存储已授权」，
    // 而那条路上既没有 All Files Access 这个权限模型、运行时 WRITE 也没在任何启动路径上请求过，
    // 于是**界面说正常、Documents/dshdata 却建不出来**，用户既看不到问题也没有授权入口。
    // 「尚未探测」同样不得显示为已就绪（坑 161 同族：状态与事实必须对齐）。
    val presentation = PublicRepoProvision.presentation(activity.engineManager.publicRepoStatus())
    val chip = chrome.storageChip
    when (presentation) {
      PublicRepoPresentation.READY -> {
        chip.text = activity.getString(R.string.ds_storage_granted)
        chip.contentDescription = activity.getString(R.string.ds_storage_granted_cd)
      }
      PublicRepoPresentation.PENDING -> {
        // S1-9：还没探过 —— 不劝授权、更不说就绪，只给一个「立刻探一次」的动作。
        chip.text = activity.getString(R.string.ds_storage_pending)
        chip.contentDescription = activity.getString(R.string.ds_storage_pending_cd)
      }
      PublicRepoPresentation.NEEDS_GRANT -> {
        chip.text = activity.getString(R.string.ds_storage_needed)
        chip.contentDescription = activity.getString(R.string.ds_storage_needed)
      }
      PublicRepoPresentation.WRITE_FAILED -> {
        // 授权看起来够却写不进去：不能只说「去授权」（用户授权了也没用），要说出是写入失败。
        // 具体原因落在那行供给记录里（EngineManager.publicRepoLastAttempt），并可复制反馈。
        chip.text = activity.getString(R.string.ds_storage_write_failed)
        chip.contentDescription = activity.getString(R.string.ds_storage_write_failed_cd)
      }
    }
    // S1-7/S1-8/S1-9：观感与动作都由状态决定（旧实现是固定观感 + 固定动作）。
    val action = storageChipAction(presentation)
    styleStorageChip(
      activity, chip,
      actionable = action != StorageChipAction.NONE,
      danger = presentation == PublicRepoPresentation.WRITE_FAILED,
    )
    chip.setOnClickListener(
      if (action == StorageChipAction.NONE) null
      else { _ -> runStorageChipAction(action) },
    )
  }

  /** 存储 chip 的状态相关动作（S1-8/S1-9）：不再一律弹授权页。 */
  private fun runStorageChipAction(action: StorageChipAction) {
    when (action) {
      StorageChipAction.NONE -> Unit
      StorageChipAction.PROBE_AGAIN -> {
        pushHint(activity.getString(R.string.ds_storage_probing), HintSource.SIDE)
        activity.provisionPublicRepoAndRefreshChip(PublicRepoProvision.TRIGGER_ON_RESUME)
      }
      StorageChipAction.REQUEST_GRANT -> activity.dirPickerController.requestStorageGrant()
      StorageChipAction.COPY_FAILURE_DETAIL -> {
        // 写入失败时用户唯一有用的一步：把失败原文拿走（去反馈/自行排查）。
        // 旧实现这一下走的是「请求授权」——授权本来就够，点了当然什么都不变。
        val detail = activity.engineManager.publicRepoLastAttempt()
        if (detail.isBlank()) {
          toast(activity.getString(R.string.ds_storage_no_detail))
        } else {
          activity.copyTextNative(detail)
          toast(activity.getString(R.string.ds_storage_detail_copied))
        }
      }
    }
  }

  /** 测试界面「检查更新」按钮：手动检查 APK 自更新（用户拍板：不自动检查）。
   *  同按钮三态 = 检查 → （发现新版）二次确认 → 下载安装；已有下载好的包则直接续继安装。 */
  private fun onUpdateButton() {
    if (apkBusy) return
    apkReadyToInstall?.let { continueInstall(); return }
    apkPending?.let { downloadAndInstall(it); return }
    checkApkUpdate()
  }

  private fun setUpdateButton(label: String, enabled: Boolean) {
    // 固定高按钮 + 长版本号（v0.13.7fx-1）会换行截断（device 实测）——单行 + 省略号
    chrome.updateButton.maxLines = 1
    chrome.updateButton.ellipsize = android.text.TextUtils.TruncateAt.END
    chrome.updateButton.text = label
    chrome.updateButton.isEnabled = enabled
    chrome.updateButton.alpha = if (enabled) 1f else 0.55f
  }

  private fun apkHint(msg: String) = pushHint(msg, HintSource.SIDE)

  private fun sizeText(bytes: Long): String =
    if (bytes <= 0) "" else "%.1f MB".format(bytes / 1048576.0)

  /** 手动检查（不自动检查）：失败如实报原因，且不阻断既有引擎快照更新检查。
   *  发现新版时不自动进入下载——由用户再点同一按钮二次确认（169MB 下载不做误触启动）。 */
  private fun checkApkUpdate() {
    apkBusy = true
    setUpdateButton(activity.getString(R.string.ds_apk_checking), enabled = false)
    Thread {
      val r = UpdateChecker.checkLatest()
      activity.runOnUiThread {
        if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
        apkBusy = false
        when (r) {
          is UpdateChecker.CheckResult.UpToDate -> {
            val v = "v" + UpdateChecker.currentVersion()
            setUpdateButton(activity.getString(R.string.ds_check_update), enabled = true)
            apkHint(activity.getString(R.string.ds_apk_latest, v))
            toast(activity.getString(R.string.ds_apk_latest, v))
            // 外层的壳已是最新 → 继续既有引擎快照检查（保持本按钮原有语义不失）
            activity.engineFlow.startUpdateCheck()
          }
          is UpdateChecker.CheckResult.Available -> {
            apkPending = r
            setUpdateButton(activity.getString(R.string.ds_apk_confirm, r.tag), enabled = true)
            apkHint(activity.getString(R.string.ds_apk_available, r.tag, "v" + UpdateChecker.currentVersion(), sizeText(r.sizeBytes)))
          }
          is UpdateChecker.CheckResult.Failed -> {
            setUpdateButton(activity.getString(R.string.ds_check_update), enabled = true)
            apkHint(r.reason)
            toast(r.reason)
            activity.engineFlow.startUpdateCheck()
          }
        }
      }
    }.start()
  }

  /** 二次确认后的下载：镜像链 + .tmp→rename 原子落盘（有 .sha256 资产则校验）；完成后自动拉起安装。 */
  private fun downloadAndInstall(r: UpdateChecker.CheckResult.Available) {
    apkBusy = true
    val dest = File(UpdateChecker.updatesDir(activity), r.name)
    setUpdateButton(activity.getString(R.string.ds_apk_downloading, 0), enabled = false)
    apkHint(activity.getString(R.string.ds_apk_download_hint, r.name, sizeText(r.sizeBytes)))
    Thread {
      var fail: String? = null
      var ok = false
      try {
        val expected = r.sha256Url?.let { UpdateChecker.downloadText(it) }
        // FX-209.E1（E-12 第二处）：缓存复用分支与新下载分支**共用同一份**产物校验。
        // 旧实现两边各写一套：缓存分支比 sizeBytes（有 sha 还校验 sha），下载分支只判
        // 「HTTP 200 且写盘成功」——同一份截断/半包产物在两条路径上判定相反。判定强度现在
        // 只由 verifyApkArtifact（ApkArtifactCheck.kt）决定，两分支用同形参数调用。
        fun artifactVerdict(): ApkArtifactVerdict = verifyApkArtifact(
          fileExists = dest.exists(),
          actualBytes = dest.length(),
          expectedBytes = r.sizeBytes,
          expectedSha256 = expected,
          sha256Matches = { UpdateChecker.verifySha256(dest, it) },
        )
        // 上次下载完成但未安装（授权中断/安装取消）→ 复用已验证的包，不重复拉 169MB
        if (artifactVerdict() is ApkArtifactVerdict.Accept) {
          ok = true
        } else {
          val used = UpdateChecker.download(r.apkUrl, dest) { pct ->
            activity.runOnUiThread {
              if (apkBusy && !activity.isFinishing && !activity.isDestroyed) {
                setUpdateButton(activity.getString(R.string.ds_apk_downloading, pct), enabled = false)
              }
            }
          }
          if (used == null) {
            fail = "下载失败：镜像链全部不可用（直连/GitHub 加速镜像均失败）"
          } else {
            when (val verdict = artifactVerdict()) {
              is ApkArtifactVerdict.Accept -> ok = true
              is ApkArtifactVerdict.Reject -> {
                dest.delete()
                fail = "下载失败：" + verdict.reason + "（文件已删除，请重试）"
              }
            }
          }
        }
      } catch (e: Exception) {
        fail = "下载失败：" + (e.message ?: e.javaClass.simpleName)
      }
      val result = fail
      activity.runOnUiThread {
        if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
        apkBusy = false
        if (ok) {
          apkReadyToInstall = dest
          continueInstall()
        } else {
          // 保持二次确认态：同一按钮变「重试下载并安装」，再点即重试
          setUpdateButton(activity.getString(R.string.ds_apk_retry, r.tag), enabled = true)
          apkHint(result ?: "下载失败")
          toast(result ?: "下载失败")
        }
      }
    }.start()
  }

  /** 已下载完成：权限不足先拉「安装未知应用」授权页（onResume 结算续继），否则直接唤起系统安装器。 */
  private fun continueInstall() {
    val apk = apkReadyToInstall ?: return
    if (!apk.exists()) {
      apkReadyToInstall = null
      setUpdateButton(activity.getString(R.string.ds_check_update), enabled = true)
      apkHint("安装包已不存在，请重新检查更新")
      return
    }
    if (!UpdateChecker.canInstall(activity)) {
      // P0-3：此前这里只改 hint，而按钮还停在「下载中 100%」且 `enabled=false`——文案让用户
      // 「再点按钮」而按钮收不到点击，唯一出路是杀应用重来（且内存里的 apkReadyToInstall 会丢）。
      // 现在把按钮复原成**可点**的「授权后继续安装」：onUpdateButton 见到 apkReadyToInstall 即走
      // continueInstall，所以「再点按钮」这句文案从此是事实。
      // S1-10：授权页**是否真的拉起**必须如实回报——旧实现两级 catch 都失败也不吭声，
      // 而 hint 已经写着「已打开授权页」（一句不保证为真的承诺）。
      val opened = UpdateChecker.requestInstallPermission(activity)
      if (opened) {
        apkHint(activity.getString(R.string.ds_apk_need_permission))
      } else {
        apkHint(activity.getString(R.string.ds_apk_permission_page_failed))
        toast(activity.getString(R.string.ds_apk_permission_page_failed))
      }
      setUpdateButton(activity.getString(R.string.ds_apk_grant_install), enabled = true)
      return
    }
    if (UpdateChecker.invokeInstaller(activity, apk)) {
      apkHint(activity.getString(R.string.ds_apk_installing))
      apkPending = null
      apkReadyToInstall = null
      setUpdateButton(activity.getString(R.string.ds_check_update), enabled = true)
    } else {
      setUpdateButton(activity.getString(R.string.ds_apk_retry_install), enabled = true)
      apkHint("安装器拉起失败，请再点按钮重试")
    }
  }

  /** 从「安装未知应用」授权页返回（MainActivity.onResume 调用）：已授权则自动续继安装。 */
  fun settlePendingInstall() {
    if (apkReadyToInstall == null || apkBusy) return
    if (UpdateChecker.canInstall(activity)) continueInstall()
    else {
      // 拒绝并返回：文案说清「还能怎么办」，按钮保持可点（P0-3）——用户可直接再点，或去授权页。
      apkHint(activity.getString(R.string.ds_apk_permission_denied))
      setUpdateButton(activity.getString(R.string.ds_apk_grant_install), enabled = true)
    }
  }

  private fun toast(msg: String) {
    android.widget.Toast.makeText(activity, msg, android.widget.Toast.LENGTH_LONG).show()
  }

  private fun copyGuideLog() {
    // 0.14.0（用户 2026-09-15）：一键复制当前代 engine.log 全文（不限大小）；绝不拼接
    // engine.log.1/.2——当前文件即「最近一次启动至今」，不会混入上一次启动。出口脱敏
    // 与展示同源（0.13.8 #184：令牌行不得进入外发文本）。
    val text = readEngineLogFull()
    // S1-1：日志不存在/读不出来时**必须回执**。旧实现在这里静默 return：用户点了「复制」，
    // 界面没有任何变化，粘出来也是空的——既不知道是不是自己没点中，也不知道下一步做什么。
    if (text.isNullOrBlank()) {
      val msg = activity.getString(R.string.ds_copy_log_empty)
      pushHint(msg, HintSource.SIDE)
      toast(msg)
      return
    }
    activity.copyTextNative(text)
    val ok = activity.getString(R.string.ds_log_copied)
    pushHint(ok, HintSource.SIDE)
    toast(ok)
  }

  /** 当前代 engine.log 全文（脱敏后）；缺失/不可读回退尾部摘要（同样脱敏）。 */
  private fun readEngineLogFull(): String? {
    val f = File(activity.filesDir, "engine.log")
    if (!f.exists()) return null
    val raw = try {
      f.readText(Charsets.UTF_8)
    } catch (_: Throwable) {
      tailEngineLog(400)
    }
    return EngineAuth.redact(raw)
  }

  fun showWeb() {
    activity.guideView.visibility = View.GONE
    activity.webView.visibility = View.VISIBLE
    // Preserve the existing WebView session across a liveness transition. Only
    // a documented engine-origin load error requires a fresh navigation.
    if (activity.enginePageFailed) {
      activity.enginePageFailed = false
      activity.webView.reload()
    }
  }

  /** 进入测试界面（引擎失败/未就绪回退）：状态 + 崩溃横幅 + engine.log 摘要。 */
  fun showGuide() {
    val becomingVisible = activity.guideView.visibility != View.VISIBLE
    activity.webView.visibility = View.GONE
    activity.guideView.visibility = View.VISIBLE
    if (becomingVisible) animateGuideReveal()
    val crash = activity.crashInfo
    if (crash != null) {
      crashBanner.visibility = View.VISIBLE
      crashBanner.text = "上次异常退出：$crash"
    } else {
      crashBanner.visibility = View.GONE
    }
    val tail = tailEngineLog(8)
    if (tail.isNotEmpty()) {
      logSummary.text = tail
      chrome.logSection.visibility = View.VISIBLE
    } else {
      chrome.logSection.visibility = View.GONE
    }
    refreshGuideMeta()
  }

  /** engine.log 尾部摘要（测试界面诊断用；缺失/不可读返回空）。
   *  展示出口脱敏（0.13.8 #184）：用户截图上报即外发，令牌行不得进入。 */
  private fun tailEngineLog(lines: Int): String {
    val f = File(activity.filesDir, "engine.log")
    if (!f.exists()) return ""
    return try {
      java.io.RandomAccessFile(f, "r").use { file ->
        val start = (file.length() - 16 * 1024).coerceAtLeast(0)
        file.seek(start)
        val bytes = ByteArray((file.length() - start).toInt())
        file.readFully(bytes)
        val tail = java.util.ArrayDeque<String>(lines)
        String(bytes, Charsets.UTF_8).lineSequence().forEach { line ->
          if (tail.size == lines) tail.removeFirst()
          tail.addLast(line)
        }
        EngineAuth.redact(tail.joinToString("\n"))
      }
    } catch (_: Exception) {
      ""
    }
  }
}
