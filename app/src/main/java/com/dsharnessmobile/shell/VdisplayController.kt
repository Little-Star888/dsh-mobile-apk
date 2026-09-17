package com.dsharnessmobile.shell

import android.content.Context
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.util.DisplayMetrics
import android.view.WindowManager
import android.util.Log
import android.view.Display
import android.view.Surface
import org.json.JSONArray
import org.json.JSONObject

/**
 * App-owned PUBLIC VirtualDisplay lifecycle with a live display registry.
 *
 * The display is created in the ordinary app process so its output surface remains app-owned. The
 * Shizuku UserService is still required before creation because it is the only supported transport
 * for later cross-display launch/input/task actions. No virtual alias ever maps to display 0.
 *
 * 0.14.0 batch: the controller now owns a realtime [screenRegistry] (DisplayManager truth plus
 * stable product aliases), a controller-owned [selectedAlias], and independent per-viewer bounds
 * records. A viewer Surface is never silently attached to two viewers: the first viewer that binds
 * a target owns it until it releases, and a second viewer gets `viewer-target-occupied`.
 */
object VdisplayController {
  private const val TAG = "dsh-vdisplay"
  private const val FLAG_PUBLIC = 1 shl 0
  private const val FLAG_OWN_CONTENT_ONLY = 1 shl 3
  private const val FLAG_SUPPORTS_TOUCH = 1 shl 6
  private const val FLAG_DESTROY_CONTENT_ON_REMOVAL = 1 shl 8
  private const val DEFAULT_WIDTH = 480
  private const val DEFAULT_HEIGHT = 800
  /** 本版上限 1 屏（0.14.0 用户拍板）；多屏设计保留（MAX 提高即可放开）。 */
  private const val MAX_VIRTUAL_DISPLAYS = 1
  private const val MIN_EDGE = 240
  private const val MAX_EDGE = 4096
  /** 随内容旋转：游戏等强制横屏应用在虚拟屏上真横屏运行（VIRTUAL_DISPLAY_FLAG_ROTATES_WITH_CONTENT）。 */
  private const val FLAG_ROTATES_WITH_CONTENT = 1 shl 7

  /** One owned VirtualDisplay plus its fallback output and viewer ownership. */
  private class Record(
    val alias: String,
    val display: VirtualDisplay,
    val reader: ImageReader,
    val thread: HandlerThread,
    val width: Int,
    val height: Int,
    val densityDpi: Int,
    var viewerId: String? = null,
    var viewerSurface: Surface? = null,
  )

  private val lock = Any()
  private val records = LinkedHashMap<String, Record>()
  private var nextAliasIndex = 1
  /** 会话归属（0.14.0）：建屏时绑定发起会话；非归属会话的生命周期操作一律拒绝。 */
  private var ownerSessionId: String? = null
  /** Controller-owned presentation target; only an owned virtual alias can be selected. */
  private var selectedAlias: String? = null
  /** Independent bounds record per viewer id (no shared global geometry). */
  private val viewerBounds = LinkedHashMap<String, JSONObject>()
  private var generation = 0L
  private var lastCode = "vdisplay-idle"
  private var lastGuidance = "虚拟屏尚未创建。"

  /** Android display id of one owned virtual display (VirtualDisplay.getDisplay().getDisplayId()). */
  private val Record.displayId: Int get() = this.display.display.displayId

  private fun ops(): JSONArray = JSONArray(listOf("vdCreate", "vdDestroy", "vdLaunch", "vdMoveTask", "vdInfo"))

  /** Owned record for one alias, or null. */
  private fun recordOf(alias: String?): Record? = synchronized(lock) {
    if (alias == null) return null
    records[alias]
  }

  /** Android display id for one owned virtual alias, or null when the alias is unknown/not owned. */
  fun displayIdForAlias(alias: String?): Int? = synchronized(lock) {
    if (alias == null) return null
    records[alias]?.displayId
  }

  /** Owned alias for one virtual Android display id, or null. Never maps display 0. */
  fun aliasForDisplayId(displayId: Int): String? = synchronized(lock) {
    if (displayId == Display.DEFAULT_DISPLAY) return null
    records.values.firstOrNull { it.displayId == displayId }?.alias
  }

  /** Owned virtual aliases ordered by allocation (the model-facing `virtual-N` set). */
  fun activeAliases(): List<String> = synchronized(lock) { records.keys.toList() }

  /**
   * 某虚拟屏的**内容尺寸**（虚拟屏自己的像素宽高）。
   *
   * 为什么宿主侧需要它：虚拟屏按等比例缩放创建（默认 0.5 → 约为真实屏的一半），其宽高比与
   * 侧栏舞台的宽高比**通常不同**（实测 360x640 对 434x682）。把 SurfaceView 直接撑满舞台会
   * 让内容只渲染在自己那部分、右侧/下方留出黑边（用户报「未自动拉伸适配」+「黑边」）。
   * 正确做法 = 按**内容宽高比**在舞台内等比放大并居中（letterbox 反向：能填满就填满，
   * 不拉伸变形）。
   */
  fun contentSizeForAlias(alias: String?): Pair<Int, Int>? = synchronized(lock) {
    val record = if (alias == null) null else records[alias]
    if (record == null) null else record.width to record.height
  }

  private fun selectedRecord(): Record? = synchronized(lock) { records[selectedAlias] }

  /**
   * Realtime display registry: every DisplayManager display with a stable product alias.
   *
   * `real` is the physical default display (id 0). Owned virtual displays get `virtual-N` aliases;
   * any other display (external/HDMI/overlay) gets `display-<id>`. Only owned virtual displays are
   * selectable presentation sources; the real screen is explicitly not mirrorable.
   */
  fun screens(context: Context): JSONArray {
    val manager = context.applicationContext.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    val aliasRecord = synchronized(lock) { records.values.toList() }
    val out = JSONArray()
    for (display in manager.displays) {
      val id = display.displayId
      val owned = aliasRecord.firstOrNull { it.displayId == id }
      val alias = when {
        id == Display.DEFAULT_DISPLAY -> "real"
        owned != null -> owned.alias
        else -> "display-$id"
      }
      val kind = when {
        id == Display.DEFAULT_DISPLAY -> "physical"
        owned != null -> "virtual"
        (display.flags and Display.FLAG_PRESENTATION) != 0 -> "presentation"
        else -> "unknown"
      }
      val selectable = owned != null
      val reason = when {
        id == Display.DEFAULT_DISPLAY -> "真实屏幕是用户前台画面，不允许镜像或作为查看器目标。"
        owned != null -> "DSH 创建的虚拟屏，可作为查看器目标。"
        else -> "非 DSH 创建的显示器没有受控输出 Surface，不能作为查看器目标。"
      }
      val metrics = DisplayMetrics()
      @Suppress("DEPRECATION")
      display.getRealMetrics(metrics)
      val viewerId = owned?.viewerId
      val state = runCatching { display.state }.getOrDefault(Display.STATE_UNKNOWN)
      out.put(
        JSONObject()
          .put("alias", alias)
          .put("displayId", id)
          .put("kind", kind)
          .put("label", if (id == Display.DEFAULT_DISPLAY) "真实屏幕" else "虚拟屏幕 " + alias.removePrefix("virtual-"))
          .put("state", when (state) {
            Display.STATE_ON -> "on"
            Display.STATE_OFF -> "off"
            Display.STATE_DOZE, Display.STATE_DOZE_SUSPEND -> "doze"
            else -> "unknown"
          })
          .put("width", metrics.widthPixels)
          .put("height", metrics.heightPixels)
          .put("densityDpi", metrics.densityDpi)
          .put("selectable", selectable)
          .put("reason", reason)
          .put("generation", synchronized(lock) { generation }),
      )
      if (viewerId != null) out.getJSONObject(out.length() - 1).put("viewerId", viewerId)
    }
    return out
  }

  /** Current public state for the Files-sidebar panel and controller responses. */
  fun status(context: Context): JSONObject {
    val appContext = context.applicationContext
    // 读路径解耦（0.14.0 缺陷修复）：设置页「刷新 Shizuku 状态」与面板轮询都走这里。
    // 若已授权但 UserService 尚未绑定，触发一次**后台**绑定并立即返回当前状态——下一次
    // 轮询（2s）即收敛为 ready。绝不在此阻塞等待（本函数在 UI/控制队列高频路径上）。
    ShizukuTransport.kickBind(appContext)
    val privileged = ShizukuTransport.status(appContext)
    val active = synchronized(lock) { records.values.toList() }
    val selected = synchronized(lock) { selectedAlias }
    val out = JSONObject()
      .put("enabled", true)
      .put("ops", ops())
      .put("transports", JSONArray(listOf("shizuku")))
      .put("generation", synchronized(lock) { generation })
      .put("screens", screens(context))
      .put("selected", selected ?: JSONObject.NULL)
      .put("ownerSessionId", ownerSessionId ?: "")
      .put("viewers", viewerStatus())
    val first = active.firstOrNull { it.alias == selected } ?: active.firstOrNull()
    if (first != null) {
      if (selected == null || records[selected] == null) {
        synchronized(lock) { selectedAlias = first.alias }
        out.put("selected", first.alias)
      }
      return out.put("ok", true).put("state", "active").put("code", "vdisplay-active")
        .put("displayId", first.displayId)
        .put("aliases", JSONArray(active.map { it.alias }))
        .put("guidance", "虚拟屏幕 ${first.alias.removePrefix("virtual-")} 已激活（Android displayId=${first.displayId}）。")
    }
    if (privileged.optBoolean("ok")) {
      return out.put("ok", true).put("state", "ready").put("code", "vdisplay-ready")
        .put("guidance", "Shizuku 已授权且 shell UserService 已就绪；可创建虚拟屏幕 1。")
    }
    return out.put("ok", false).put("state", "blocked")
      .put("code", privileged.optString("code", lastCode))
      .put("guidance", privileged.optString("guidance", lastGuidance))
  }

  /** Viewer ownership + independent bounds records, for the panel and for arbitration tests. */
  private fun viewerStatus(): JSONArray {
    val out = JSONArray()
    synchronized(lock) {
      for ((viewerId, bounds) in viewerBounds) {
        val owner = records.values.firstOrNull { it.viewerId == viewerId }
        out.put(
          JSONObject()
            .put("viewerId", viewerId)
            .put("target", owner?.alias ?: JSONObject.NULL)
            .put("presenting", owner != null && owner.viewerSurface != null)
            .put("bounds", bounds),
        )
      }
    }
    return out
  }

  /**
   * One Surface can only be owned by a single viewer at a time.
   *
   * The arbitration is a pure function so it can be unit-tested without an Android display:
   * a free target attaches, the same viewer may re-attach idempotently, and any other viewer is
   * refused with `viewer-target-occupied` instead of silently stealing or sharing the surface.
   */
  internal object ViewerArbitration {
    /** Verdict for one bind request. */
    enum class Verdict { ATTACH, OCCUPIED }

    /** @return ATTACH when [requestingViewerId] may own the target; OCCUPIED for a foreign owner. */
    fun decide(ownerViewerId: String?, requestingViewerId: String): Verdict =
      if (ownerViewerId == null || ownerViewerId == requestingViewerId) Verdict.ATTACH else Verdict.OCCUPIED
  }

  /** Create one non-mirrored public display on a user gesture or controller operation. */
  fun create(context: Context, args: JSONObject? = null): JSONObject {
    val appContext = context.applicationContext
    val session = args?.optString("session", "")?.takeIf { it.isNotBlank() }
    requireOwner("vdCreate", session)?.let { return it }
    // 幂等复用：归属会话再次 create 时直接返回现有屏（不报上限）。
    val existing = synchronized(lock) { records.size }
    if (existing > 0 && session != null && ownerSessionId == session) return status(appContext)
    val bound = ShizukuTransport.ensureBound(appContext)
    if (!bound.optBoolean("ok")) return status(appContext)
      .put("code", bound.optString("code", "shizuku-not-ready"))
      .put("guidance", bound.optString("guidance", "Shizuku 未就绪。"))

    if (existing >= MAX_VIRTUAL_DISPLAYS) {
      return status(appContext).put("ok", false).put("code", "vdisplay-limit")
        .put("guidance", "已达到本机虚拟屏上限（$MAX_VIRTUAL_DISPLAYS 块）；先销毁一块再创建。")
    }
    val real = DisplayMetrics()
    @Suppress("DEPRECATION")
    (appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(real)
    val scale = (args?.optDouble("scale", VdisplayPrefs.scale(appContext)) ?: VdisplayPrefs.scale(appContext))
      .coerceIn(0.4, 1.0)
    val width = (args?.optInt("width", 0) ?: 0).takeIf { it > 0 }?.coerceIn(MIN_EDGE, MAX_EDGE)
      ?: Math.round(real.widthPixels * scale).toInt().coerceIn(MIN_EDGE, MAX_EDGE)
    val height = (args?.optInt("height", 0) ?: 0).takeIf { it > 0 }?.coerceIn(MIN_EDGE, MAX_EDGE)
      ?: Math.round(real.heightPixels * scale).toInt().coerceIn(MIN_EDGE, MAX_EDGE)

    synchronized(lock) {
      var nextReader: ImageReader? = null
      var nextThread: HandlerThread? = null
      try {
        val dpi = (args?.optInt("densityDpi", 0) ?: 0).takeIf { it > 0 }?.coerceIn(120, 640)
          ?: Math.round(real.densityDpi * scale).toInt().coerceIn(120, 640)
        nextThread = HandlerThread("dsh-vdisplay-reader").also { it.start() }
        nextReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        nextReader.setOnImageAvailableListener({ source ->
          // This is not a pixel transport. Drain and close frames so the owned output surface stays
          // healthy while the visual viewer surface is attached separately.
          runCatching { source.acquireLatestImage()?.close() }
        }, Handler(nextThread.looper))
        val flags = FLAG_PUBLIC or FLAG_OWN_CONTENT_ONLY or FLAG_SUPPORTS_TOUCH or
          FLAG_DESTROY_CONTENT_ON_REMOVAL or FLAG_ROTATES_WITH_CONTENT
        val manager = appContext.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        val alias = "virtual-$nextAliasIndex"
        val created = manager.createVirtualDisplay(
          "DSH $alias",
          width,
          height,
          dpi,
          nextReader.surface,
          flags,
        ) ?: throw IllegalStateException("DisplayManager returned null VirtualDisplay")
        records[alias] = Record(alias, created, nextReader, nextThread, width, height, dpi)
        nextAliasIndex += 1
        if (selectedAlias == null) selectedAlias = alias
        if (ownerSessionId == null && session != null) ownerSessionId = session
        generation += 1
        lastCode = "vdisplay-active"
        lastGuidance = "$alias 已创建。"
        Log.i(TAG, "created alias=$alias displayId=${created.display.displayId} size=${width}x$height dpi=$dpi generation=$generation")
        return status(appContext)
      } catch (t: Throwable) {
        runCatching { nextReader?.close() }
        runCatching { nextThread?.quitSafely() }
        lastCode = if (t is SecurityException) "vd-denied-flags" else "vd-create-failed"
        lastGuidance = t.javaClass.simpleName + ": " + (t.message ?: "")
        Log.w(TAG, "create failed $lastGuidance")
        return status(appContext).put("code", lastCode).put("guidance", lastGuidance)
      }
    }
  }

  /** Explicitly remove one display; DESTROY_CONTENT_ON_REMOVAL prevents third-party task migration. */
  fun destroy(context: Context, args: JSONObject? = null): JSONObject = synchronized(lock) {
    val session = args?.optString("session", "")?.takeIf { it.isNotBlank() }
    requireOwner("vdDestroy", session)?.let { return it }
    val requested = args?.optString("target", "").orEmpty().ifBlank { selectedAlias }
    val alias = requested?.takeIf { records.containsKey(it) }
      ?: records.keys.firstOrNull()
      ?: return status(context.applicationContext)
    val record = records.remove(alias) ?: return status(context.applicationContext)
    runCatching { record.display.release() }
    runCatching { record.reader.close() }
    runCatching { record.thread.quitSafely() }
    record.viewerId?.let { viewerBounds.remove(it) }
    if (selectedAlias == alias) selectedAlias = records.keys.firstOrNull()
    if (records.isEmpty()) ownerSessionId = null
    generation += 1
    lastCode = "vdisplay-destroyed"
    lastGuidance = "$alias 已销毁；不会回退或迁移到真实屏幕。"
    Log.i(TAG, "destroyed alias=$alias generation=$generation remaining=${records.size}")
    status(context.applicationContext)
  }

  /**
   * Select the controller-owned presentation target. The real screen is not mirrorable and is
   * rejected with `screen-not-selectable`; an unknown alias is `screen-not-found`.
   */
  fun select(context: Context, alias: String?): JSONObject {
    val normalized = alias?.trim().orEmpty()
    val record = recordOf(normalized)
      ?: return status(context.applicationContext).put("ok", false)
        .put("code", if (normalized == ScreenTargets.REAL) "screen-not-selectable" else "screen-not-found")
        .put("guidance", if (normalized == ScreenTargets.REAL) {
          "真实屏幕不允许镜像，不能作为查看器目标。"
        } else {
          "没有名为 $normalized 的 DSH 虚拟屏；先创建虚拟屏。"
        })
    synchronized(lock) {
      selectedAlias = record.alias
      generation += 1
    }
    Log.i(TAG, "selected target=${record.alias}")
    return status(context.applicationContext)
  }

  /**
   * Attach one viewer Surface to a target with viewer arbitration.
   *
   * A display's output Surface can only be owned by one viewer at a time. A second viewer binding
   * the same target gets `viewer-target-occupied` instead of silently sharing/replacing the surface.
   */
  fun attachViewerSurface(context: Context, viewerId: String, alias: String?, surface: Surface): JSONObject {
    val id = viewerId.trim().ifBlank { "files-sidebar" }
    val requested = alias?.trim().orEmpty().ifBlank { synchronized(lock) { selectedAlias } }
    val record = recordOf(requested)
      ?: return status(context.applicationContext).put("ok", false)
        .put("code", if (requested == ScreenTargets.REAL) "screen-not-selectable" else "screen-not-found")
        .put("viewerId", id)
        .put("guidance", "既没有目标虚拟屏，也没有可回退的真实屏。先创建并选择虚拟屏。")
    synchronized(lock) {
      val owner = record.viewerId
      if (ViewerArbitration.decide(owner, id) == ViewerArbitration.Verdict.OCCUPIED) {
        return status(context.applicationContext).put("ok", false)
          .put("code", "viewer-target-occupied")
          .put("viewerId", id)
          .put("owner", owner)
          .put("target", record.alias)
          .put("guidance", "虚拟屏 ${record.alias} 正由查看器 $owner 显示；同一 Surface 不能同时挂到两个查看器。")
      }
      record.viewerId = id
      record.viewerSurface = surface
      selectedAlias = record.alias
      runCatching { record.display.setSurface(surface) }
      generation += 1
    }
    Log.i(TAG, "viewer=$id attached to ${record.alias} displayId=${record.displayId}")
    return status(context.applicationContext)
  }

  /** Release one viewer's ownership and fall back to the owned ImageReader output. */
  fun releaseViewerSurface(context: Context, viewerId: String, surface: Surface? = null): JSONObject {
    val id = viewerId.trim().ifBlank { "files-sidebar" }
    synchronized(lock) {
      for (record in records.values) {
        if (record.viewerId != id) continue
        if (surface != null && record.viewerSurface !== surface) continue
        record.viewerId = null
        record.viewerSurface = null
        runCatching { record.display.setSurface(record.reader.surface) }
      }
      generation += 1
    }
    Log.i(TAG, "viewer=$id released")
    return status(context.applicationContext)
  }

  /** Store one viewer's independent geometry record (diagnostics + multi-window arbitration). */
  fun setViewerBounds(viewerId: String, bounds: JSONObject) {
    val id = viewerId.trim().ifBlank { "files-sidebar" }
    synchronized(lock) { viewerBounds[id] = bounds }
  }

  /**
   * Fixed display-scoped input proof. A successful result means the shell UserService accepted a
   * low-level key injection targeted at the dynamic virtual display rather than display 0.
   */
  fun sendBackProbe(context: Context, args: JSONObject? = null): JSONObject {
    val target = args?.optString("target", "").orEmpty().ifBlank { null }
    val record = selectedRecord() ?: recordOf(target)
      ?: return status(context.applicationContext).put("ok", false).put("code", "screen-not-ready")
        .put("guidance", "虚拟屏幕尚未创建，无法测试跨屏输入。")
    val id = record.displayId
    val result = ShizukuTransport.runController(
      context.applicationContext,
      arrayOf("/system/bin/input", "-d", id.toString(), "keyevent", "4"),
    )
    val out = status(context.applicationContext)
    out.put("input", result)
    return if (result.optBoolean("ok")) {
      out.put("guidance", "Shizuku 已向 ${record.alias} 注入返回键（displayId=$id）；真实屏未作为回退目标。")
    } else {
      out.put("ok", false).put("code", "vd-input-failed")
        .put("guidance", "虚拟屏输入失败：" + result.optString("stdout", result.optString("guidance", "")))
    }
  }

  /**
   * Minimal fixed-action proof: launch Android Settings onto the selected virtual display through
   * the shell UserService. This command contains no model/user supplied shell text.
   */
  fun launchSettingsProbe(context: Context, args: JSONObject? = null): JSONObject {
    requireOwner("vdLaunch", args?.optString("session", "")?.takeIf { it.isNotBlank() })?.let { return it }
    val target = args?.optString("target", "").orEmpty().ifBlank { null }
    val record = selectedRecord() ?: recordOf(target)
      ?: return status(context.applicationContext).put("ok", false).put("code", "screen-not-ready")
        .put("guidance", "虚拟屏幕尚未创建，无法拉起测试应用。")
    val id = record.displayId
    val result = ShizukuTransport.runController(
      context.applicationContext,
      arrayOf("am", "start", "--display", id.toString(), "-a", "android.settings.SETTINGS"),
    )
    val out = status(context.applicationContext)
    out.put("launch", result)
    if (result.optBoolean("ok")) {
      out.put("guidance", "Android 设置已由 Shizuku 拉起到 ${record.alias}（displayId=$id）。")
    } else {
      out.put("ok", false).put("code", "vd-launch-failed")
        .put("guidance", "虚拟屏已创建，但 shell 拉起测试应用失败：" + result.optString("stdout", result.optString("guidance", "")))
    }
    return out
  }

  /** 归属校验（不含绑定）：非归属会话的生命周期操作一律拒绝；旧调用（不带会话）放行。 */
  private fun requireOwner(op: String, session: String?): JSONObject? {
    val current = ownerSessionId ?: return null
    if (session == null || session == current) return null
    return JSONObject().put("ok", false).put("code", "vdisplay-session-busy").put("op", op)
      .put("ownerSessionId", current)
      .put("guidance", "虚拟屏正由另一个会话使用；请回到该会话，或由用户在设置页强制销毁。")
  }

  /** 当前选中（或第一块）虚拟屏的分辨率；无屏返回 null（浮窗按此保持宽高比）。 */
  internal fun activeSize(): Pair<Int, Int>? = synchronized(lock) {
    val record = records[selectedAlias] ?: records.values.firstOrNull() ?: return null
    record.width to record.height
  }

  /** 设置页「强制销毁」：无视会话归属销毁全部虚拟屏（用户三连点确认后调用）。 */
  fun forceDestroy(context: Context): JSONObject = synchronized(lock) {
    val aliases = records.keys.toList()
    for (alias in aliases) {
      val record = records.remove(alias) ?: continue
      runCatching { record.display.release() }
      runCatching { record.reader.close() }
      runCatching { record.thread.quitSafely() }
      record.viewerId?.let { viewerBounds.remove(it) }
    }
    selectedAlias = null
    ownerSessionId = null
    generation += 1
    lastCode = "vdisplay-destroyed"
    lastGuidance = "已强制销毁全部虚拟屏（无归属限制）。"
    Log.i(TAG, "force-destroyed ${aliases.size} display(s) generation=$generation")
    status(context.applicationContext)
  }
}

/** 虚拟屏分辨率档位（0.5 / 0.75 / 1.0，默认 0.75；densityDpi 同比例缩放）与退后台浮窗开关。
 *  均由设置页「手机控制」写入。 */
internal object VdisplayPrefs {
  private const val PREFS = "dsh-vdisplay"
  private const val KEY_SCALE = "resolutionScale"
  private const val KEY_FLOAT = "floatEnabled"

  fun scale(context: Context): Double {
    val stored = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getFloat(KEY_SCALE, 0.75f)
    return stored.toDouble().coerceIn(0.4, 1.0)
  }

  fun setScale(context: Context, value: Double) {
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putFloat(KEY_SCALE, value.coerceIn(0.4, 1.0).toFloat()).apply()
  }

  fun floatEnabled(context: Context): Boolean =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getBoolean(KEY_FLOAT, true)

  fun setFloatEnabled(context: Context, enabled: Boolean) {
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putBoolean(KEY_FLOAT, enabled).apply()
  }
}
