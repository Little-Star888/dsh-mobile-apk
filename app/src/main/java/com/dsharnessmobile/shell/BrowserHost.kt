package com.dsharnessmobile.shell

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.ScriptHandler
import androidx.webkit.UserAgentMetadata
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * A lazily-created untrusted browsing surface over the trusted DSH WebView.
 *
 * Browser pages never receive `androidBridge`. The trusted DSH sidebar reports its CSS stage rect
 * through its bridge; this owner maps that rect into the root FrameLayout and overlays only that
 * stage. Main-thread ownership keeps lifecycle, layout, and renderer callbacks serialized.
 *
 * 0.14.0 batch: the host now also carries the model-facing control surface. All page reads and
 * actions go through DOM/ARIA snapshot refs: a snapshot records `{tabId, pageGeneration, refs}`,
 * and every action re-validates the generation and the ref before it can dispatch input. Stale
 * refs and stale pages are rejected instead of guessed. Hit testing, touch dispatch, CDP bounds,
 * and screenshots share the same untransformed letterbox rectangle.
 */
internal class BrowserHost(
  private val activity: MainActivity,
  private val root: FrameLayout,
  private val dshWebView: WebView,
) {
  private data class StageBounds(
    val left: Double,
    val top: Double,
    val width: Double,
    val height: Double,
    val viewportWidth: Double,
    val viewportHeight: Double,
    val visible: Boolean,
  )
  private data class RequestedViewport(val id: String, val width: Int, val height: Int)

  companion object {
    /** 锚点标签页 id（首个页面恒定用它，保证旧调用与设备脚本的期望值不变）。 */
    const val TAB_ID = "tab-1"
    private const val ROOT_TAB_ID = TAB_ID
    private const val MAX_TABS = 8
    private const val SNAPSHOT_MAX_NODES = 400
    /** 无活动标签页时的只读占位（避免把“没有页面”误判成“有页面”） */
    private val ORPHAN_GENERATION = AtomicLong(0)
    private val ORPHAN_REFS = HashSet<String>()
  }

  /** 任取一个已存在标签页的排序快照，供 status()/listTabs 复用。 */
  private fun tabSummaries(): JSONArray {
    val out = JSONArray()
    for (tab in tabs.values) {
      out.put(JSONObject()
        .put("tabId", tab.id)
        .put("url", tab.url)
        .put("title", tab.title)
        .put("loadState", tab.loadState)
        .put("active", tab.id == activeTabId))
    }
    return out
  }

  /** 取用或新建一个标签页；id 为空时落在锚点页（单页签调用语义与改造前一致）。 */
  private fun ensureTab(id: String?): Tab {
    val wanted = id?.takeIf { it.isNotBlank() } ?: activeTabId ?: ROOT_TAB_ID
    tabs[wanted]?.let { return it }
    val created = Tab(wanted)
    tabs[wanted] = created
    if (activeTabId == null) activeTabId = wanted
    return created
  }

  private val main = Handler(Looper.getMainLooper())

  /**
   * 一个浏览器标签页的**全部页面级状态**（0.14.0 多页签）。
   *
   * 为什么要把这些字段从宿主搬进来：此前宿主只有一份 url/title/loadState/generation/refs，
   * 结构上只能有一个页面——但工具面早就承诺了 browser_list_tabs / browser_follow_tab /
   * browser_close_tab，模型因此「以为」能同时控多个网页（用户实测：开三个站点只有一页生效）。
   * 每个 tab 一份状态后，工具承诺与原生能力才对齐。
   */
  private inner class Tab(val id: String) {
    var view: WebView? = null
    var url = "about:blank"
    var title = ""
    var loadState = "idle"
    val generation = AtomicLong(0)
    /** 最近一次被接受的 snapshot 的 ref 集；动作只接受这些。 */
    val refs = HashSet<String>()
    var snapshotGeneration = -1L
    var scrollY = 0
    var scrollDirection = 0
    var pageWidth = 0
    var pageHeight = 0
    var pageDevicePixelRatio = 0.0
    var errorPageUrl: String? = null
  }

  /** 全部标签页，插入序即 UI 顺序；锚点固定为 [ROOT_TAB_ID]。 */
  private val tabs = LinkedHashMap<String, Tab>()
  private var activeTabId: String? = null
  private var nextTabSeq = 1
  private fun activeTab(): Tab? = activeTabId?.let { tabs[it] }
  private fun tabOrNull(id: String?): Tab? = id?.let { tabs[it] }

  /** 页面级字段一律代理到**活动标签页**：单页签时代码路径与改造前逐字等价。 */
  private var view: WebView?
    get() = activeTab()?.view
    set(value) { activeTab()?.view = value }

  private var requestedVisible = false
  private var stageVisible = false
  private var stageBounds: StageBounds? = null
  /** Device viewport is default; named presets letterbox inside the trusted stage without transforms. */
  private var requestedViewport: RequestedViewport? = null
  private var lastError = ""
  /** Identity profile currently applied to the untrusted WebView ('android-real' = real device UA). */
  private var identityId = "android-real"
  /** UA string for the current identity profile (empty = native Android UA). */
  private var identityUa = ""
  /** Document-start 脚本句柄（视口宽度 + 桌面身份覆盖）；null = 未注册。 */
  private var identityScriptHandler: ScriptHandler? = null
  /** 全部已注册的 document-start 脚本句柄（切换身份/分辨率时整体重注册）。 */
  private val docStartHandlers = mutableListOf<ScriptHandler>()
  /** recycleView 内部重建时抑制再次重建。 */
  private var recycling = false
  /** 当前已注入脚本的预设；预设变化需要重建脚本并重载页面。 */
  private var appliedViewport: RequestedViewport? = null
  /** 会话归属（0.14.0）：打开/导航时绑定发起会话；非归属会话的呈现与操作一律拒绝。 */
  private var ownerSessionId: String? = null
  /** 当前呈现面（侧栏）声明的会话；与归属不一致时原生层不显示（占用态由面板渲染）。 */
  private var viewerSessionId: String? = null

  private val title: String get() = activeTab()?.title ?: ""
  private val url: String get() = activeTab()?.url ?: "about:blank"
  private val loadState: String get() = activeTab()?.loadState ?: "idle"
  private val generation: AtomicLong get() = activeTab()?.generation ?: ORPHAN_GENERATION
  private val lastRefs: HashSet<String> get() = activeTab()?.refs ?: ORPHAN_REFS
  private var lastSnapshotGeneration: Long
    get() = activeTab()?.snapshotGeneration ?: -1L
    set(value) { activeTab()?.snapshotGeneration = value }
  private var pageWidth: Int
    get() = activeTab()?.pageWidth ?: 0
    set(value) { activeTab()?.pageWidth = value }
  private var pageHeight: Int
    get() = activeTab()?.pageHeight ?: 0
    set(value) { activeTab()?.pageHeight = value }
  private var pageDevicePixelRatio: Double
    get() = activeTab()?.pageDevicePixelRatio ?: 0.0
    set(value) { activeTab()?.pageDevicePixelRatio = value }
  private var scrollY: Int
    get() = activeTab()?.scrollY ?: 0
    set(value) { activeTab()?.scrollY = value }
  private var scrollDirection: Int
    get() = activeTab()?.scrollDirection ?: 0
    set(value) { activeTab()?.scrollDirection = value }
  private var errorPageUrl: String?
    get() = activeTab()?.errorPageUrl
    set(value) { activeTab()?.errorPageUrl = value }
  private val rootLayoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
    applyStageBounds()
  }

  init {
    root.addOnLayoutChangeListener(rootLayoutListener)
  }

  /** BrowserHost is ready once the owner has a root; no second WebView exists until show/open. */
  fun statusJson(): String = onMain { status().toString() } ?: unavailable("main-thread-timeout")

  /**
   * Show the browser workbench, creating the untrusted WebView on first use.
   * 0.14.0：入参兼容裸 URL（旧调用/设备脚本）与 JSON `{url?, session?}`（可信面板带会话）。
   */
  fun show(rawUrl: String?): String = onMain {
    val payload = showPayload(rawUrl)
    val target = normalizeUrl(payload.first)
    if (payload.first?.isNotEmpty() == true && target == null) {
      lastError = "unsupported-url"
      return@onMain rejected(lastError)
    }
    bindOwner(payload.second ?: viewerSessionId)?.let { return@onMain it.toString() }
    val browser = ensureView()
    requestedVisible = true
    if (target != null && target != url) browser.loadUrl(target)
    applyVisibility()
    status().toString()
  } ?: unavailable("main-thread-timeout")

  /** 解析 show 入参：裸 URL 或 `{url, session}`。 */
  private fun showPayload(raw: String?): Pair<String?, String?> {
    val text = raw?.trim().orEmpty()
    if (!text.startsWith("{")) return text.takeIf { it.isNotEmpty() } to null
    return try {
      val value = JSONObject(text)
      value.optString("url", "").takeIf { it.isNotBlank() } to
        value.optString("session", "").takeIf { it.isNotBlank() }
    } catch (_: Throwable) {
      null to null
    }
  }

  /** 绑定或校验会话归属；null = 放行，否则是结构化拒绝。 */
  private fun bindOwner(session: String?): JSONObject? {
    val incoming = session?.takeIf { it.isNotBlank() } ?: return null
    val current = ownerSessionId
    if (current == null) {
      ownerSessionId = incoming
      return null
    }
    if (current == incoming) return null
    return JSONObject().put("ok", false).put("reason", "browser-session-busy")
      .put("ownerSessionId", current)
      .put("guidance", "浏览器工作台正由另一个会话使用；请回到该会话，或由它关闭后重试。")
  }

  /** 归属校验（不含绑定）：非归属会话的操作一律拒绝；无归属或旧调用（不带会话）放行。 */
  private fun requireOwner(op: String, session: String?): JSONObject? {
    if (op == "browserCaps") return null
    val current = ownerSessionId ?: return null
    if (session == null || session == current) return null
    return JSONObject().put("ok", false).put("reason", "browser-session-busy").put("op", op)
      .put("ownerSessionId", current)
      .put("guidance", "浏览器工作台正由另一个会话使用；请回到该会话，或由它关闭后重试。")
  }

  /** Hide the browser surface without destroying its tab state. */
  fun hide(): String = onMain {
    requestedVisible = false
    applyVisibility()
    status().toString()
  } ?: unavailable("main-thread-timeout")

  /** Reload the current page only when a BrowserHost tab exists. */
  fun reload(): String = onMain {
    val browser = view
    if (browser == null) {
      lastError = "browser-not-created"
      return@onMain rejected(lastError)
    }
    browser.reload()
    status().toString()
  } ?: unavailable("main-thread-timeout")

  /** Navigate the existing workbench; accepts only non-local http(s) or about:blank. */
  fun navigate(rawUrl: String): String = onMain {
    val target = normalizeUrl(rawUrl)
    if (target == null) {
      lastError = "unsupported-url"
      return@onMain rejected(lastError)
    }
    val browser = ensureView()
    requestedVisible = true
    browser.loadUrl(target)
    applyVisibility()
    status().toString()
  } ?: unavailable("main-thread-timeout")

  /**
   * Update native overlay geometry from one trusted DSH sidebar stage.
   * @param raw JSON `{left,top,width,height,viewportWidth,viewportHeight,visible}` in CSS px.
   */
  fun setStageBounds(raw: String): String = onMain {
    try {
      val value = JSONObject(raw)
      value.optString("session", "").takeIf { it.isNotBlank() }?.let { viewerSessionId = it }
      stageBounds = StageBounds(
        left = value.optDouble("left", 0.0),
        top = value.optDouble("top", 0.0),
        width = value.optDouble("width", 0.0),
        height = value.optDouble("height", 0.0),
        viewportWidth = value.optDouble("viewportWidth", 0.0),
        viewportHeight = value.optDouble("viewportHeight", 0.0),
        visible = value.optBoolean("visible", false),
      )
      if (lastError == "invalid-stage-bounds") lastError = ""
      applyStageBounds()
      status().toString()
    } catch (_: Throwable) {
      lastError = "invalid-stage-bounds"
      rejected(lastError)
    }
  } ?: unavailable("main-thread-timeout")

  fun setViewport(raw: String): String = onMain {
    try {
      val value = JSONObject(raw)
      val id = value.optString("id", "").take(48)
      val width = value.optInt("width", 0)
      val height = value.optInt("height", 0)
      val next = if (id == "device") null else {
        if (width !in 240..3840 || height !in 240..3840) return@onMain rejected("invalid-viewport")
        RequestedViewport(id.ifBlank { "$width x $height" }, width, height)
      }
      val changed = next != appliedViewport
      requestedViewport = next
      if (changed && view != null) recycleView() else applyStageBounds()
      status().toString()
    } catch (_: Throwable) { rejected("invalid-viewport") }
  } ?: unavailable("main-thread-timeout")

  // ── model-facing control surface ──────────────────────────────────────────

  /**
   * Dispatch one registered shell control op. Called from the control queue thread; every WebView
   * touch/JS call is marshalled to the main thread with a bounded wait.
   */
  fun controlOp(op: String, args: JSONObject): JSONObject {
    val session = args.optString("session", "").takeIf { it.isNotBlank() } ?: viewerSessionId
    if (op == "browserShow" || op == "browserOpen") {
      bindOwner(session)?.let { return it }
    } else {
      requireOwner(op, session)?.let { return it }
    }
    // 多页签：browserOpen/list/follow/closeTab 都带可选 tabId；缺省落在当前活动页。
    // 兼容旧单页调用——不传 tabId 时行为与改造前逐字一致（锚点 tab-1）。
    when (op) {
    "browserCaps" -> return onMain { caps() } ?: controlTimeout()
    "browserState" -> return onMain { status() } ?: controlTimeout()
    "browserTabs" -> return onMain { listTabsOp() } ?: controlTimeout()
    "browserFollowTab" -> return onMain { followTabOp(args) } ?: controlTimeout()
    "browserCloseTab" -> return onMain { closeTabOp(args) } ?: controlTimeout()
    "browserShow" -> return controlJson(show(args.optString("url", null).takeIf { it.isNotBlank() }))
    "browserHide" -> return controlJson(hide())
    "browserClose" -> return controlJson(close())
    "browserOpen" -> return navigateOp(args)
    "browserViewport" -> return viewportOp(args)
    "browserSetUa" -> return identityOp(args)
    "browserJs" -> return browserJsOp(args)
    "browserInput" -> return inputOp(args)
    "browserShot" -> return shotOp(args)
    else -> return JSONObject().put("__error", "未知浏览器操作 $op").put("reason", "unknown-op")
    }
  }

  /**
   * 0.14.0：app 退后台时不暂停隔离 WebView——页面是 AI 的工作空间，收起/切后台仍须继续运行
   * （不暂停 JS 定时器）；Activity 销毁仍走 [destroy]。
   */
  fun onActivityPaused() {
    Unit
  }

  /** Resume only this isolated WebView after the owning Activity returns. */
  fun onActivityResumed() {
    onMain {
      view?.onResume()
      Unit
    }
  }

  /** Destroy the current page and its renderer; the workbench object stays reusable for a fresh open. */
  fun close(): String = onMain {
    disposeView()
    status().toString()
  } ?: unavailable("main-thread-timeout")

  /** Dispose the isolated renderer with the owning Activity. */
  fun destroy() {
    onMain {
      stageBounds = null
      root.removeOnLayoutChangeListener(rootLayoutListener)
      disposeView()
      Unit
    }
  }

  private fun disposeView() {
    requestedVisible = false
    stageVisible = false
    // 多页签：销毁**全部**页面与它们的 renderer（browserClose 的语义 = 关闭整个工作台）。
    for (tab in tabs.values) {
      synchronized(tab.refs) { tab.refs.clear() }
      tab.view?.let { browser ->
        root.removeView(browser)
        browser.destroy()
      }
      tab.view = null
      tab.snapshotGeneration = -1L
    }
    tabs.clear()
    activeTabId = null
    nextTabSeq = 1
    identityId = "android-real"
    identityUa = ""
    identityScriptHandler = null
    appliedViewport = null
    ownerSessionId = null
    viewerSessionId = null
    lastError = ""
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun ensureView(): WebView = ensureViewFor(ensureTab(null))

  /** 为指定标签页创建（或取用）它自己的隔离 WebView；一个 tab 一个 renderer。 */
  @SuppressLint("SetJavaScriptEnabled")
  private fun ensureViewFor(tab: Tab): WebView {
    activeTabId = tab.id
    val existing = tab.view
    if (existing != null) return existing
    val created = WebView(activity).apply {
      id = View.generateViewId()
      visibility = View.GONE
      setBackgroundColor(Color.TRANSPARENT)
      settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        @Suppress("DEPRECATION")
        allowFileAccessFromFileURLs = false
        @Suppress("DEPRECATION")
        allowUniversalAccessFromFileURLs = false
        javaScriptCanOpenWindowsAutomatically = false
        setSupportMultipleWindows(false)
        setGeolocationEnabled(false)
        mediaPlaybackRequiresUserGesture = true
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        cacheMode = WebSettings.LOAD_NO_CACHE
        // 分辨率预设 = CSS 视口：document-start 注入 `width=<cssW>`（见 applyDocumentStartScript）。
        loadWithOverviewMode = true
        useWideViewPort = true
        if (android.os.Build.VERSION.SDK_INT >= 26) safeBrowsingEnabled = true
        if (android.os.Build.VERSION.SDK_INT >= 29) {
          @Suppress("DEPRECATION")
          forceDark = WebSettings.FORCE_DARK_AUTO
        }
      }
      // 滚动观察（页面真实滚动位置，不注入任何脚本）：驱动可信面板的控件避让与横屏锁定。
      // 回调一律写**本 tab** 的状态（闭包捕获 tab），绝不写「当前活动页」——否则后台页的
      // 加载/滚动事件会把前台页的状态覆盖掉（多页签下的典型错乱）。
      setOnScrollChangeListener { _, _, y, _, oldY ->
        tab.scrollY = y
        val delta = y - oldY
        if (delta > 0) tab.scrollDirection = 1 else if (delta < 0) tab.scrollDirection = -1
      }
      webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
          if (isAllowedNavigation(request.url.toString())) return false
          lastError = "unsupported-url"
          return true
        }

        override fun onPageStarted(view: WebView, startedUrl: String, favicon: android.graphics.Bitmap?) {
          tab.generation.incrementAndGet()
          synchronized(tab.refs) { tab.refs.clear() }
          // 内置错误页（data:）不是新页面：保留失败 URL 与 loadState=error，供重试链接使用。
          if (startedUrl.startsWith("data:")) return
          tab.errorPageUrl = null
          tab.url = startedUrl
          tab.title = ""
          tab.loadState = "loading"
          lastError = ""
        }

        override fun onPageFinished(view: WebView, finishedUrl: String) {
          if (finishedUrl.startsWith("data:")) return
          tab.url = finishedUrl
          if (tab.loadState == "loading") tab.loadState = "loaded"
          measurePage(view, tab)
        }

        /**
         * 主帧网络类失败 → 浏览器风格错误页（标题 + 主机 + 原因 + ERR_* + 刷新），
         * 在隔离 WebView 内以 data 页呈现；重试链接是绝对 http(s) URL，不依赖任何桥。
         */
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
          if (!request.isForMainFrame) return
          val failing = request.url.toString()
          tab.errorPageUrl = failing
          tab.url = failing
          tab.loadState = "error"
          lastError = "load-error:" + error.errorCode
          val html = errorPageHtml(failing, error.errorCode, error.description?.toString() ?: "")
          view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
          lastError = if (detail.didCrash()) "renderer-crashed" else "renderer-killed"
          root.removeView(view)
          view.destroy()
          if (tab.view === view) tab.view = null
          synchronized(tab.refs) { tab.refs.clear() }
          return true
        }
      }
      webChromeClient = object : WebChromeClient() {
        override fun onReceivedTitle(view: WebView, pageTitle: String?) {
          tab.title = pageTitle ?: ""
        }
      }
    }
    root.addView(created, FrameLayout.LayoutParams(1, 1))
    tab.view = created
    applyIdentityToView(created)
    appliedViewport = requestedViewport
    applyStageBounds()
    return created
  }

  /** Recalculate the native overlay after either trusted bounds or the root geometry changes. */
  private fun applyStageBounds() {
    val bounds = stageBounds
    val cssWidth = bounds?.viewportWidth ?: 0.0
    val cssHeight = bounds?.viewportHeight ?: 0.0
    if (bounds == null || !bounds.visible || cssWidth <= 0.0 || cssHeight <= 0.0 ||
      bounds.width <= 1.0 || bounds.height <= 1.0 || root.width <= 0 || root.height <= 0 ||
      dshWebView.width <= 0 || dshWebView.height <= 0
    ) {
      stageVisible = false
      applyVisibility()
      return
    }
    val scaleX = dshWebView.width.toDouble() / cssWidth
    val scaleY = dshWebView.height.toDouble() / cssHeight
    val left = (bounds.left * scaleX).toInt().coerceIn(0, (root.width - 1).coerceAtLeast(0))
    val top = (bounds.top * scaleY).toInt().coerceIn(0, (root.height - 1).coerceAtLeast(0))
    val stageWidth = (bounds.width * scaleX).toInt().coerceIn(1, (root.width - left).coerceAtLeast(1))
    val stageHeight = (bounds.height * scaleY).toInt().coerceIn(1, (root.height - top).coerceAtLeast(1))
    val desired = requestedViewport
    // 分辨率预设 = CSS 视口（SPEC §1.2）：通过覆盖隔离 WebView 的 density 只缩放一次。
    //   fitScale     = min(stageW/(cssW*baseDensity), stageH/(cssH*baseDensity), 1)
    //   视口脚本注入 `width=<cssW>`（document-start），WebView 自动把该宽度适配到物理宽
    //   k = min(stageW/cssW, stageH/cssH, baseDensity)（每 CSS px 物理像素数，封顶原生 density）
    //   物理矩形 = cssW*k × cssH*k（居中 letterbox，不拉伸）
    //   ⇒ window.innerWidth == cssW、window.innerHeight == cssH、dpr == k
    // 分辨率变化由调用方注入脚本后重载；舞台变化只改 k/居中，不重载、不重建。
    val baseDensity = dshWebView.resources.displayMetrics.density.coerceAtLeast(0.5f)
    val pageCssWidth = desired?.width?.toDouble() ?: stageWidth.toDouble()
    val pageCssHeight = desired?.height?.toDouble() ?: stageHeight.toDouble()
    val factor = if (desired == null) 1.0 else minOf(
      stageWidth.toDouble() / pageCssWidth,
      stageHeight.toDouble() / pageCssHeight,
      baseDensity.toDouble(),
    ).coerceAtLeast(0.05)
    val width = if (desired == null) stageWidth else Math.round(pageCssWidth * factor).toInt()
    val height = if (desired == null) stageHeight else Math.round(pageCssHeight * factor).toInt()
    val positionedLeft = left + (stageWidth - width) / 2
    val positionedTop = top + (stageHeight - height) / 2
    view?.layoutParams = FrameLayout.LayoutParams(width.coerceAtLeast(1), height.coerceAtLeast(1)).apply {
      leftMargin = positionedLeft
      topMargin = positionedTop
    }
    stageVisible = true
    applyVisibility()
  }

  /** 读取页面自报视口（诊断 + 设备断言）；失败保留上一次值。 */
  private fun measurePage(browser: WebView, tab: Tab) {
    browser.evaluateJavascript(
      "(function(){return JSON.stringify({w:window.innerWidth||0,h:window.innerHeight||0,dpr:window.devicePixelRatio||0})})()",
    ) { raw ->
      val value = decodeJsObject(raw) ?: return@evaluateJavascript
      tab.pageWidth = value.optInt("w", tab.pageWidth)
      tab.pageHeight = value.optInt("h", tab.pageHeight)
      tab.pageDevicePixelRatio = value.optDouble("dpr", tab.pageDevicePixelRatio)
    }
  }

  private fun applyVisibility() {
    val foreignViewer = ownerSessionId != null && viewerSessionId != null && viewerSessionId != ownerSessionId
    view?.visibility = if (requestedVisible && stageVisible && !foreignViewer) View.VISIBLE else View.GONE
  }

  private fun status(): JSONObject {
    val density = dshWebView.resources.displayMetrics.density.coerceAtLeast(0.5f)
    return JSONObject()
      .put("ok", true)
      .put("available", true)
      .put("created", view != null)
      .put("visible", view?.visibility == View.VISIBLE)
      .put("url", url)
      .put("title", title)
      .put("loadState", loadState)
      .put("pageGeneration", generation.get())
      .put("canGoBack", view?.canGoBack() == true)
      .put("canGoForward", view?.canGoForward() == true)
      .put("identityId", identityId)
      .put("ownerSessionId", ownerSessionId ?: "")
      .put("scrollY", scrollY)
      .put("scrollDirection", scrollDirection)
      .put("atTop", scrollY <= 0)
      .put("viewportId", requestedViewport?.id ?: "device")
      .put("viewportWidth", requestedViewport?.width ?: (dshWebView.width / density).toInt())
      .put("viewportHeight", requestedViewport?.height ?: (dshWebView.height / density).toInt())
      .put("pageWidth", pageWidth)
      .put("pageHeight", pageHeight)
      .put("pageDevicePixelRatio", pageDevicePixelRatio)
      .put("tabId", activeTabId ?: "")
      .put("tabs", tabSummaries())
      .put("tabCount", tabs.size)
      .put("reason", lastError)
  }

  private fun rejected(reason: String): String = status().put("ok", false).put("reason", reason).toString()

  private fun unavailable(reason: String): String = JSONObject()
    .put("ok", false)
    .put("available", false)
    .put("created", false)
    .put("visible", false)
    .put("url", "about:blank")
    .put("title", "")
    .put("pageGeneration", generation.get())
    .put("canGoBack", false)
    .put("canGoForward", false)
    .put("reason", reason)
    .toString()

  /** Keep the browser surface away from the trusted loopback DSH origin and all local schemes. */
  private fun isAllowedNavigation(raw: String): Boolean = BrowserHostNavigationPolicy.normalize(raw) != null

  private fun normalizeUrl(raw: String?): String? = BrowserHostNavigationPolicy.normalize(raw)

  /** 浏览器风格错误页（无脚本、无桥；重试链接为绝对 http(s) URL）。 */
  private fun errorPageHtml(failedUrl: String, code: Int, description: String): String {
    val names = mapOf(
      -1 to "ERR_FAILED", -2 to "ERR_NAME_NOT_RESOLVED", -3 to "ERR_ABORTED",
      -4 to "ERR_AUTHENTICATION", -5 to "ERR_PROXY_AUTHENTICATION", -6 to "ERR_CONNECTION_REFUSED",
      -7 to "ERR_IO", -8 to "ERR_TIMED_OUT", -9 to "ERR_REDIRECT_LOOP", -10 to "ERR_UNSUPPORTED_SCHEME",
      -11 to "ERR_SSL_PROTOCOL_ERROR", -12 to "ERR_BAD_URL", -13 to "ERR_FILE_NOT_FOUND",
      -14 to "ERR_FILE_ACCESS_DENIED", -15 to "ERR_TOO_MANY_REQUESTS", -16 to "ERR_UNSAFE_RESOURCE",
    )
    val name = names[code] ?: "ERR_FAILED"
    val host = try { java.net.URI(failedUrl).host ?: failedUrl } catch (_: Throwable) { failedUrl }
    val reason = description.ifBlank { "无法访问该页面。" }
    fun esc(text: String): String = text
      .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
    return """
<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1b1b1f;color:#e8e8ea;font:16px/1.6 system-ui,sans-serif}
main{max-width:420px;padding:32px 24px}h1{font-size:22px;margin:0 0 12px}
p{margin:0 0 8px;color:#b9b9c0}code{color:#8f8f98;font-size:13px}
a{display:inline-block;margin-top:16px;padding:10px 20px;border-radius:8px;background:#3d6bff;color:#fff;text-decoration:none}
@media (prefers-color-scheme: light){body{background:#f5f5f7;color:#1b1b1f}p{color:#5f5f66}code{color:#8a8a92}}
</style></head><body><main>
<h1>嗯… 无法访问此页面</h1>
<p><strong>${esc(host)}</strong> ${esc(reason)}</p>
<p><code>${esc(name)}</code></p>
<a href="${esc(failedUrl)}">刷新</a>
</main></body></html>
    """.trimIndent()
  }

  // ── capability + navigation ops ───────────────────────────────────────────

  private fun caps(): JSONObject {
    val pkg = if (android.os.Build.VERSION.SDK_INT >= 26) WebView.getCurrentWebViewPackage() else null
    val versionText = pkg?.versionName ?: ""
    val major = Regex("(\\d+)\\.").find(versionText)?.groupValues?.get(1)?.toIntOrNull() ?: 0
    val metrics = dshWebView.resources.displayMetrics
    val documentStart = featureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    val uaCh = featureSupported(WebViewFeature.USER_AGENT_METADATA)
    return JSONObject()
      .put("ok", true)
      .put("available", true)
      .put("webviewMajor", major)
      .put("webviewVersion", versionText)
      .put("uaChAvailable", uaCh)
      .put("androidxWebkitCompiled", true)
      .put("androidxWebkitAvailable", documentStart || uaCh)
      .put("documentStartScript", documentStart)
      .put("densityOverrideSupported", false)
      .put("screenWidth", metrics.widthPixels)
      .put("screenHeight", metrics.heightPixels)
      .put("densityDpi", metrics.densityDpi)
      .put("rendererProcesses", 0)
      .put("browserWebViewAvailable", true)
      .put("cdpEnabled", false)
      .put("viewportId", requestedViewport?.id ?: "device")
      .put("surface", "browser")
  }

  /** androidx.webkit 能力门：WebView 包不支持该特性时返回 false（不抛）。 */
  private fun featureSupported(feature: String): Boolean = try {
    WebViewFeature.isFeatureSupported(feature)
  } catch (_: Throwable) {
    false
  }

  private fun navigateOp(args: JSONObject): JSONObject {
    val raw = args.optString("url", "")
    val target = normalizeUrl(raw)
      ?: return JSONObject().put("ok", false).put("reason", "unsupported-url")
        .put("guidance", "BrowserHost 只接受 http(s) 顶层导航；本机回环、file/content/data/javascript 一律拒绝。")
    val requestedTabId = args.optString("tabId", "").takeIf { it.isNotBlank() }
    val wantsNewTab = args.optBoolean("newTab", false)
    return onMain {
      // 0.14.0 多页签：tabId = **一次「任务」的标识**（见 notes）。三种落法：
      //   ① 传了 tabId 且该页不存在 → 新建并沿用该 id；已存在 → 切过去再导航（不静默改投）；
      //   ② 不带 tabId 但 newTab=true → 自动分配新页（browser_open 的默认语义：开一个网页）；
      //   ③ 都不带 → 当前活动页（旧单页调用逐字兼容）。
      if (wantsNewTab && requestedTabId == null) {
        if (tabs.size >= MAX_TABS) {
          return@onMain JSONObject().put("ok", false).put("reason", "tab-limit")
            .put("guidance", "同时打开的页面已达上限（$MAX_TABS）；先 browser_close_tab 关掉不再需要的页。")
            .put("tabs", tabSummaries())
        }
        var candidate: String
        do { candidate = "tab-" + nextTabSeq++ } while (tabs.containsKey(candidate))
        val created = ensureTab(candidate)
        activeTabId = created.id
        val browser = ensureViewFor(created)
        val before = created.generation.get()
        browser.loadUrl(target)
        applyVisibility()
        awaitNavigation(created, before)
        return@onMain status().put("ok", true).put("tabId", created.id)
      }
      val newTab = requestedTabId != null && !tabs.containsKey(requestedTabId)
      if (newTab && tabs.size >= MAX_TABS) {
        return@onMain JSONObject().put("ok", false).put("reason", "tab-limit")
          .put("guidance", "同时打开的页面已达上限（$MAX_TABS）；先 browser_close_tab 关掉不再需要的页。")
          .put("tabs", tabSummaries())
      }
      // 传了 tabId 但该页已存在 → 切过去再导航（不静默写到别的页）。
      val tab = if (requestedTabId != null) {
        val t = ensureTab(requestedTabId)
        activeTabId = t.id
        t
      } else {
        ensureTab(null)
      }
      val browser = ensureViewFor(tab)
      // 0.14.0：模型只导航、不置可见——可见性由侧栏呈现面决定（收起状态下的工作空间语义）。
      val before = tab.generation.get()
      browser.loadUrl(target)
      applyVisibility()
      awaitNavigation(tab, before)
      status().put("ok", true).put("tabId", tab.id)
    } ?: controlTimeout()
  }

  /**
   * 等一次导航「开始」（页代次前进），供 browser_open 返回**导航后**的状态。
   *
   * 为什么必须有：loadUrl() 立即返回，而 onPageStarted/onPageFinished 是异步回调——紧接着调
   * status() 读到的还是上一页（新页则是 about:blank + 代次 0）。设备实测：模型因此以为
   * 「导航还没完成」，甚至去猜「工具默认先开空白页」（Agent 原话），可能触发重复导航。
   *
   * 只等「代次前进」，**不等整页加载完**：慢站点不应拖住控制队列；上限 2.5s，超时按当前状态
   * 如实返回（loadState 仍为 loading，模型可自行决定要不要继续 browser_wait）。
   */
  private fun awaitNavigation(tab: Tab, before: Long) {
    val deadline = SystemClock.elapsedRealtime() + 2_500L
    while (SystemClock.elapsedRealtime() < deadline) {
      if (tab.generation.get() > before) return
      try { Thread.sleep(40) } catch (_: InterruptedException) { return }
    }
  }

  private fun viewportOp(args: JSONObject): JSONObject {
    val route = args.optString("route", "S2")
    val preset = args.optString("preset", "").take(48)
    if (preset == "device") {
      return onMain {
        val changed = requestedViewport != null
        requestedViewport = null
        if (changed && view != null) recycleView() else applyStageBounds()
        status().put("ok", true).put("route", route).put("width", 0).put("height", 0)
      } ?: controlTimeout()
    }
    val width = args.optInt("width", 0)
    val height = args.optInt("height", 0)
    if (width !in 240..3840 || height !in 240..3840) {
      return JSONObject().put("ok", false).put("reason", "invalid-viewport")
    }
    val id = preset.ifBlank { "$width x $height" }
    return onMain {
      val next = RequestedViewport(id, width, height)
      val changed = next != appliedViewport
      requestedViewport = next
      if (changed && view != null) recycleView() else applyStageBounds()
      status().put("ok", true).put("route", route).put("width", width).put("height", height)
    } ?: controlTimeout()
  }

  private fun identityOp(args: JSONObject): JSONObject = onMain { identityApply(args) } ?: controlTimeout()

  /** Apply one identity profile; shared by the control op and the trusted panel's PC/mobile toggle. */
  fun identity(raw: String): String = onMain {
    try { identityApply(JSONObject(raw)).toString() } catch (_: Throwable) { rejected("invalid-identity") }
  } ?: unavailable("main-thread-timeout")

  private fun identityApply(args: JSONObject): JSONObject {
    val profile = args.optString("profile", "android-real").take(32)
    val ua = args.optString("ua", "").take(512)
    view ?: return JSONObject().put("ok", false).put("reason", "browser-not-created")
      .put("guidance", "先打开浏览器页面再切换身份。")
    // PC / 手机切换 = 身份 + 该模式记忆分辨率 + 一次重载（SPEC §1.2）。
    val width = args.optInt("width", 0)
    val height = args.optInt("height", 0)
    val preset = args.optString("preset", "").take(48)
    if (width in 240..3840 && height in 240..3840) {
      requestedViewport = RequestedViewport(preset.ifBlank { "$width x $height" }, width, height)
    } else if (preset == "device") {
      requestedViewport = null
    }
    val nextUa = if (profile == "android-real" || ua.isBlank()) "" else ua
    val changed = profile != identityId || nextUa != identityUa || requestedViewport != appliedViewport
    identityId = profile
    identityUa = nextUa
    if (changed) {
      // document-start 脚本只在新建 WebView 时注册（当前实现无法可靠替换），故重建一次。
      recycleView()
    } else {
      applyStageBounds()
    }
    val reloaded = url != "about:blank"
    return identityResult(profile, identityScriptHandler != null, reloaded)
  }

  private fun identityResult(profile: String, scriptApplied: Boolean, reloaded: Boolean): JSONObject {
    val uaChApplied = featureSupported(WebViewFeature.USER_AGENT_METADATA) && profile != "android-real"
    return JSONObject().put("ok", true).put("profile", profile).put("applied", true)
      .put("uaChApplied", uaChApplied).put("scriptApplied", scriptApplied)
      .put("viewportId", requestedViewport?.id ?: "device").put("reloaded", reloaded)
      .put("degraded", if (uaChApplied) "" else
        "ua-ch-unavailable：本机 WebView 不支持 UA-CH 覆写；已应用 UA 串 + document-start 身份脚本（platform/触摸/屏幕，指纹可检出）。")
  }

  /** 组合 document-start 注入：视口宽度（预设生效时）+ 桌面身份覆盖；安卓档/无预设时对应段为空。 */
  private fun applyDocumentStartScript(browser: WebView) {
    docStartHandlers.forEach { it.remove() }
    docStartHandlers.clear()
    identityScriptHandler = null
    if (!featureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    val preset = requestedViewport
    if (preset != null) addDocStart(browser, viewportScript(preset.width))
    if (identityId != "android-real") identityScriptHandler = addDocStart(browser, IDENTITY_JS)
  }

  private fun addDocStart(browser: WebView, script: String): ScriptHandler? = try {
    WebViewCompat.addDocumentStartJavaScript(browser, script, setOf("*"))
  } catch (_: Throwable) {
    null
  }

  /**
   * 销毁并按当前预设/身份重建隔离 WebView 后重放 URL。
   * document-start 脚本无法可靠替换（旧脚本会继续生效），故视口或身份变化一律重建。
   */
  private fun recycleView() {
    val browser = view ?: return
    val reloadTarget = url.takeIf { it != "about:blank" }
    recycling = true
    try {
      // 重建当前**活动**标签页自己的 WebView；其它页不受影响（多页签）。
      val tab = activeTab()
      root.removeView(browser)
      browser.destroy()
      tab?.view = null
      tab?.let {
        synchronized(it.refs) { it.refs.clear() }
        it.snapshotGeneration = -1L
        it.loadState = "idle"
        val next = ensureViewFor(it)
        if (reloadTarget != null) next.loadUrl(reloadTarget)
      }
    } finally {
      recycling = false
    }
    applyVisibility()
  }

  /** 把当前身份（UA 串 / UA-CH / document-start 脚本）套用到指定 WebView，供每次创建与切换复用。 */
  private fun applyIdentityToView(browser: WebView) {
    browser.settings.userAgentString = if (identityId == "android-real" || identityUa.isBlank()) null else identityUa
    applyUserAgentMetadata(browser, identityId)
    applyDocumentStartScript(browser)
  }

  /** 视口注入脚本：在页面任何脚本之前把 viewport 固定为请求的 CSS 宽（document-start）。 */
  private fun viewportScript(width: Int): String = """
    (function(){
      var W = $width;
      var C = 'width=' + W + ', user-scalable=no';
      function fixViewport(){
        try {
          var metas = document.querySelectorAll('meta[name="viewport"]');
          if (metas.length > 0) {
            for (var i = 0; i < metas.length; i++) {
              if (metas[i].getAttribute('content') !== C) metas[i].setAttribute('content', C);
            }
            var head = document.head;
            if (head) {
              for (var j = 0; j < metas.length; j++) {
                if (metas[j].parentNode !== head) { head.insertBefore(metas[j], head.firstChild); break; }
              }
            }
            return true;
          }
          var target = document.head || document.documentElement;
          if (!target) return false;
          var m = document.createElement('meta');
          m.setAttribute('name', 'viewport');
          m.setAttribute('content', C);
          target.insertBefore(m, target.firstChild);
          return true;
        } catch (e) { return true; }
      }
      fixViewport();
      var o = new MutationObserver(function(){ fixViewport(); });
      o.observe(document, {childList: true, subtree: true});
      setTimeout(function(){ o.disconnect(); }, 3000);
    })()
  """.trimIndent()

  /** WebView >= 116 时同批设置 UA-CH（与 UA 串脱钩会让站点判定分裂）；本机不支持则如实返回 false。 */
  private fun applyUserAgentMetadata(browser: WebView, profile: String): Boolean {
    if (profile == "android-real" || !featureSupported(WebViewFeature.USER_AGENT_METADATA)) return false
    val versionText = WebView.getCurrentWebViewPackage()?.versionName ?: ""
    val major = Regex("(\\d+)\\.").find(versionText)?.groupValues?.get(1) ?: ""
    return try {
      val metadata = UserAgentMetadata.Builder()
        .setBrandVersionList(listOf(UserAgentMetadata.BrandVersion.Builder()
          .setBrand("Chromium").setMajorVersion(major).setFullVersion(versionText).build()))
        .setFullVersion(versionText)
        .setPlatform("Linux")
        .setPlatformVersion("")
        .setArchitecture("x86")
        .setModel("")
        .setMobile(false)
        .setBitness(64)
        .setWow64(false)
        .build()
      WebSettingsCompat.setUserAgentMetadata(browser.settings, metadata)
      true
    } catch (_: Throwable) {
      false
    }
  }

  // ── 多页签 ops（0.14.0：AI 用工具直接管多网页，UI 只是给人看的视图）────────

  /** 列出全部标签页 + 当前活动页。 */
  private fun listTabsOp(): JSONObject = JSONObject()
    .put("ok", true)
    .put("tabs", tabSummaries())
    .put("activeTabId", activeTabId ?: "")
    .put("tabCount", tabs.size)

  /** 切换活动标签页（不新建、不销毁）。 */
  private fun followTabOp(args: JSONObject): JSONObject {
    val id = args.optString("tabId", "")
    val tab = tabOrNull(id)
      ?: return JSONObject().put("ok", false).put("reason", "tab-not-found")
        .put("tabId", id)
        .put("tabs", tabSummaries())
    activeTabId = tab.id
    applyStageBounds()
    applyVisibility()
    return JSONObject().put("ok", true)
      .put("activeTabId", tab.id)
      .put("url", tab.url)
      .put("tabs", tabSummaries())
  }

  /**
   * 关闭指定标签页并同步销毁它的 WebView（一个 tab 一个 renderer —— 不关就是不销毁，
   * 这是「多页共存」与「省资源」的取舍点）。关掉活动页时自动切到相邻页。
   */
  private fun closeTabOp(args: JSONObject): JSONObject {
    val id = args.optString("tabId", "").ifBlank { activeTabId ?: "" }
    val tab = tabOrNull(id)
      ?: return JSONObject().put("ok", false).put("reason", "tab-not-found").put("tabId", id)
    // 最后一个页面：与 browserClose 等价（清空并保持宿主可复用），不残留半个状态。
    tab.view?.let { browser ->
      root.removeView(browser)
      browser.destroy()
    }
    tab.view = null
    tabs.remove(tab.id)
    if (tabs.isEmpty()) {
      nextTabSeq = 1
      activeTabId = null
      requestedVisible = false
      applyVisibility()
      return JSONObject().put("ok", true).put("closedTabId", tab.id)
        .put("activeTabId", "").put("tabs", JSONArray())
    }
    if (activeTabId == tab.id) {
      activeTabId = tabs.keys.firstOrNull()
      applyStageBounds()
    }
    applyVisibility()
    return JSONObject().put("ok", true)
      .put("closedTabId", tab.id)
      .put("activeTabId", activeTabId ?: "")
      .put("tabs", tabSummaries())
  }

  // ── DOM snapshot ref discipline ───────────────────────────────────────────

  private fun browserJsOp(args: JSONObject): JSONObject {
    val snapshotRequested = args.optBoolean("snapshot", false)
    if (snapshotRequested) return snapshotOp()
    val expr = args.optString("expr", "")
    if (expr.isBlank()) return JSONObject().put("ok", false).put("reason", "expr-required")
    if (expr.length > 60_000) return JSONObject().put("ok", false).put("reason", "expr-too-long")
    val startedGeneration = generation.get()
    return awaitMain(8_000) { done ->
      val browser = view
      if (browser == null) { done(rejectControl("browser-not-created")); return@awaitMain }
      browser.evaluateJavascript(expr, ValueCallback { raw ->
        val value = decodeJs(raw)
        done(JSONObject()
          .put("ok", true)
          .put("value", when (value) {
            null -> ""
            is String -> value
            else -> value.toString()
          })
          .put("pageGeneration", startedGeneration)
          .put("url", url))
      })
    }
  }

  private fun snapshotOp(): JSONObject {
    val startedGeneration = generation.get()
    return awaitMain(8_000) { done ->
      val browser = view
      if (browser == null) { done(rejectControl("browser-not-created")); return@awaitMain }
      browser.evaluateJavascript(SNAPSHOT_JS, ValueCallback { raw ->
        try {
          val payload = decodeJsObject(raw) ?: throw IllegalStateException("snapshot-unparsable")
          val nodes = payload.optJSONArray("nodes") ?: JSONArray()
          val refs = HashSet<String>()
          for (i in 0 until nodes.length()) {
            val ref = nodes.getJSONObject(i).optString("ref", "")
            if (ref.isNotEmpty()) refs.add(ref)
          }
          synchronized(lastRefs) {
            lastRefs.clear()
            lastRefs.addAll(refs)
          }
          lastSnapshotGeneration = startedGeneration
          val viewport = payload.optJSONObject("viewport") ?: JSONObject()
          val nodeCount = nodes.length()
          done(JSONObject()
            .put("ok", true)
            .put("tabId", TAB_ID)
            .put("surface", "browser")
            .put("pageGeneration", startedGeneration)
            .put("url", payload.optString("url", url))
            .put("title", payload.optString("title", title))
            .put("viewport", viewport)
            .put("nodes", nodes)
            .put("nodeCount", nodeCount)
            .put("truncated", payload.optBoolean("truncated", false)))
        } catch (t: Throwable) {
          done(rejectControl("snapshot-failed").put("detail", t.javaClass.simpleName + ": " + (t.message ?: "")))
        }
      })
    }
  }

  /** Validate `pageGeneration` + ref before any action; stale targets are never guessed. */
  private fun resolveRef(args: JSONObject): JSONObject? {
    val ref = args.optString("ref", "")
    if (ref.isEmpty()) return rejectControl("ref-required")
    if (!Regex("^bx\\d{1,5}$").matches(ref)) return rejectControl("invalid-ref")
    val pageGeneration = args.optLong("pageGeneration", -1L)
    if (lastSnapshotGeneration < 0L) return rejectControl("snapshot-required")
    if (pageGeneration != lastSnapshotGeneration || pageGeneration != generation.get()) {
      return rejectControl("stale-page-generation")
        .put("snapshotGeneration", lastSnapshotGeneration)
        .put("currentGeneration", generation.get())
    }
    val known = synchronized(lastRefs) { ref in lastRefs }
    if (!known) return rejectControl("stale-ref")
    return null
  }

  private fun inputOp(args: JSONObject): JSONObject {
    val kind = args.optString("kind", "")
    return when (kind) {
      "tap" -> tapOp(args)
      "text" -> textOp(args)
      "key" -> keyOp(args)
      else -> JSONObject().put("ok", false).put("reason", "unsupported-input-kind")
        .put("guidance", "支持 kind=tap|text|key；滚动/等待等请走 browserJs 的固定脚本。")
    }
  }

  private fun tapOp(args: JSONObject): JSONObject {
    resolveRef(args)?.let { return it }
    val ref = args.optString("ref")
    val script = RESOLVE_REF_JS.replace("__REF__", ref)
    return awaitMain(8_000) { done ->
      val browser = view
      if (browser == null) { done(rejectControl("browser-not-created")); return@awaitMain }
      browser.evaluateJavascript(script, ValueCallback { raw ->
        val payload = decodeJsObject(raw)
        if (payload == null || !payload.optBoolean("found")) {
          done(rejectControl("stale-ref").put("ref", ref))
          return@ValueCallback
        }
        if (payload.optBoolean("disabled", false)) {
          done(rejectControl("element-disabled").put("ref", ref))
          return@ValueCallback
        }
        val vw = payload.optDouble("vw", 0.0)
        val vh = payload.optDouble("vh", 0.0)
        if (vw <= 0.0 || vh <= 0.0 || browser.width <= 0 || browser.height <= 0) {
          done(rejectControl("viewport-unavailable"))
          return@ValueCallback
        }
        val viewX = (payload.optDouble("x") * browser.width / vw).toFloat()
        val viewY = (payload.optDouble("y") * browser.height / vh).toFloat()
        dispatchTap(browser, viewX, viewY)
        main.postDelayed({
          done(JSONObject()
            .put("ok", true)
            .put("ref", ref)
            .put("url", url)
            .put("pageGeneration", generation.get())
            .put("changed", generation.get() != lastSnapshotGeneration))
        }, 220)
      })
    }
  }

  private fun textOp(args: JSONObject): JSONObject {
    resolveRef(args)?.let { return it }
    val ref = args.optString("ref")
    val text = args.optString("text", "")
    val replace = args.optBoolean("replace", true)
    val script = TYPE_JS
      .replace("__REF__", ref)
      .replace("__REPLACE__", if (replace) "true" else "false")
      .replace("__TEXT__", jsString(text))
    return awaitMain(8_000) { done ->
      val browser = view
      if (browser == null) { done(rejectControl("browser-not-created")); return@awaitMain }
      browser.requestFocus()
      browser.evaluateJavascript(script, ValueCallback { raw ->
        val payload = decodeJsObject(raw)
        if (payload == null || !payload.optBoolean("found")) {
          done(rejectControl("stale-ref").put("ref", ref))
        } else {
          done(JSONObject()
            .put("ok", true)
            .put("ref", ref)
            .put("url", url)
            .put("value", payload.optString("value", ""))
            .put("pageGeneration", generation.get()))
        }
      })
    }
  }

  private fun keyOp(args: JSONObject): JSONObject {
    val rawKey = args.optString("key", "").trim()
    if (rawKey.isEmpty()) return JSONObject().put("ok", false).put("reason", "key-required")
    val keyCode = KEY_CODES[rawKey.lowercase()]
      ?: return if (rawKey.length == 1) {
        // Printable character: focus the last resolved field and insert text through the DOM.
        textOp(JSONObject()
          .put("ref", args.optString("ref", ""))
          .put("pageGeneration", args.optLong("pageGeneration", -1L))
          .put("text", rawKey)
          .put("replace", false))
      } else {
        JSONObject().put("ok", false).put("reason", "unsupported-key")
          .put("guidance", "支持 Enter/Tab/Escape/Backspace/Delete/方向键/PageUp/PageDown/Home/End，或单个可打印字符。")
      }
    return onMain {
      val browser = view
        ?: return@onMain JSONObject().put("ok", false).put("reason", "browser-not-created")
      browser.requestFocus()
      dispatchKey(browser, keyCode)
      status().put("ok", true).put("key", rawKey)
    } ?: controlTimeout()
  }

  private fun shotOp(args: JSONObject): JSONObject {
    val inline = args.optBoolean("inline", false)
    val browser = view ?: return JSONObject().put("ok", false).put("reason", "browser-not-created")
    var path = ""
    var width = 0
    var height = 0
    var bytes = 0L
    val captured = onMain {
      try {
        if (browser.width <= 0 || browser.height <= 0) return@onMain false
        val bitmap = Bitmap.createBitmap(browser.width, browser.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        browser.draw(canvas)
        val dir = File(File(activity.filesDir, "home/tmp"), "dsh-tmp").apply { mkdirs() }
        val file = File(dir, "browser-shot-${System.currentTimeMillis()}.png")
        FileOutputStream(file).use { out ->
          bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        }
        path = file.absolutePath
        width = bitmap.width
        height = bitmap.height
        bytes = file.length()
        bitmap.recycle()
        true
      } catch (t: Throwable) {
        lastError = "shot-failed:${t.javaClass.simpleName}"
        false
      }
    } ?: false
    if (!captured) {
      return JSONObject().put("ok", false).put("reason", lastError.ifBlank { "shot-failed" })
    }
    val out = JSONObject()
      .put("ok", true)
      .put("path", path)
      .put("bytes", bytes)
      .put("width", width)
      .put("height", height)
      .put("health", "ok")
    if (!inline) out.put("note", "截图落在应用私有目录的引擎可读路径；工具层读完即删。")
    return out
  }

  // ── async plumbing ────────────────────────────────────────────────────────

  /** Run a block on the main thread and wait for its callback to complete (bounded). */
  private fun awaitMain(timeoutMs: Long, block: (done: (JSONObject) -> Unit) -> Unit): JSONObject {
    val latch = CountDownLatch(1)
    val result = AtomicReference(controlTimeout())
    main.post {
      try {
        block { value ->
          result.set(value)
          latch.countDown()
        }
      } catch (t: Throwable) {
        result.set(rejectControl("browser-op-failed").put("detail", t.javaClass.simpleName + ": " + (t.message ?: "")))
        latch.countDown()
      }
    }
    return if (latch.await(timeoutMs, TimeUnit.MILLISECONDS)) result.get() else controlTimeout()
  }

  private fun controlTimeout(): JSONObject = JSONObject()
    .put("ok", false)
    .put("reason", "timeout")
    .put("guidance", "浏览器操作超时：页面可能繁忙或 WebView 未就绪。")

  private fun rejectControl(reason: String): JSONObject = JSONObject().put("ok", false).put("reason", reason)

  private fun controlJson(raw: String?): JSONObject = try {
    JSONObject(raw ?: "")
  } catch (_: Throwable) {
    JSONObject().put("ok", false).put("reason", "browser-host-offline")
  }

  private fun decodeJs(raw: String?): Any? {
    val text = raw ?: return null
    return try {
      JSONTokener(text).nextValue()
    } catch (_: Throwable) {
      null
    }
  }

  private fun decodeJsObject(raw: String?): JSONObject? = when (val value = decodeJs(raw)) {
    is JSONObject -> value
    is String -> try { JSONObject(value) } catch (_: Throwable) { null }
    else -> null
  }

  private fun dispatchTap(browser: WebView, x: Float, y: Float) {
    val downAt = SystemClock.uptimeMillis()
    val down = MotionEvent.obtain(downAt, downAt, MotionEvent.ACTION_DOWN, x, y, 0)
    val up = MotionEvent.obtain(downAt, downAt + 48, MotionEvent.ACTION_UP, x, y, 0)
    try {
      browser.dispatchTouchEvent(down)
      browser.dispatchTouchEvent(up)
    } finally {
      down.recycle()
      up.recycle()
    }
  }

  private fun dispatchKey(browser: WebView, keyCode: Int) {
    val downAt = SystemClock.uptimeMillis()
    browser.dispatchKeyEvent(KeyEvent(downAt, downAt, KeyEvent.ACTION_DOWN, keyCode, 0))
    browser.dispatchKeyEvent(KeyEvent(downAt, downAt + 32, KeyEvent.ACTION_UP, keyCode, 0))
  }

  private fun <T> onMain(block: () -> T): T? {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    var result: T? = null
    val latch = CountDownLatch(1)
    main.post {
      try {
        result = block()
      } finally {
        latch.countDown()
      }
    }
    return if (latch.await(2, TimeUnit.SECONDS)) result else null
  }

  /** 桌面身份脚本：只在 document-start 运行；不暴露桥、不改页面内容。 */
  private val IDENTITY_JS = """
    (function(){
      try {
        var N = Navigator.prototype;
        Object.defineProperty(N, 'platform', {get:function(){return 'Linux x86_64';}, configurable:true});
        Object.defineProperty(N, 'maxTouchPoints', {get:function(){return 0;}, configurable:true});
        Object.defineProperty(N, 'userAgentData', {get:function(){return undefined;}, configurable:true});
        Object.defineProperty(N, 'hardwareConcurrency', {get:function(){return 8;}, configurable:true});
      } catch (e) {}
      try { delete window.ontouchstart; } catch (e) {}
      try { delete Object.getPrototypeOf(window).ontouchstart; } catch (e) {}
      try {
        var S = Screen.prototype;
        Object.defineProperty(S, 'width', {get:function(){return 1920;}, configurable:true});
        Object.defineProperty(S, 'height', {get:function(){return 1080;}, configurable:true});
        Object.defineProperty(S, 'availWidth', {get:function(){return 1920;}, configurable:true});
        Object.defineProperty(S, 'availHeight', {get:function(){return 1080;}, configurable:true});
        Object.defineProperty(S, 'colorDepth', {get:function(){return 24;}, configurable:true});
        Object.defineProperty(S, 'pixelDepth', {get:function(){return 24;}, configurable:true});
      } catch (e) {}
    })()
  """.trimIndent()

  /** Fixed scripts run inside the untrusted page; they never expose a bridge and never mutate it. */
  private val SNAPSHOT_JS = """
    (function(){
      var MAX = $SNAPSHOT_MAX_NODES;
      var old = document.querySelectorAll('[data-dsh-bx]');
      for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-dsh-bx');
      var sel = 'a[href],button,input,select,textarea,[role],[onclick],[tabindex],[contenteditable="true"]';
      var all = document.querySelectorAll(sel);
      var nodes = [];
      for (var j = 0; j < all.length && nodes.length < MAX; j++) {
        var el = all[j];
        var r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        var style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        var tag = el.tagName;
        var role = el.getAttribute('role') || (tag === 'A' ? 'link' : tag === 'BUTTON' ? 'button' : tag === 'SELECT' ? 'combobox' : (tag === 'INPUT' || tag === 'TEXTAREA') ? ((el.type === 'submit' || el.type === 'button' || el.type === 'checkbox' || el.type === 'radio') ? el.type : 'textbox') : '');
        var name = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.innerText || el.value || '';
        name = String(name).replace(/\s+/g, ' ').trim();
        if (name.length > 120) name = name.slice(0, 120);
        var ref = 'bx' + (nodes.length + 1);
        el.setAttribute('data-dsh-bx', ref);
        var inView = r.bottom > 0 && r.top < (window.innerHeight || 0) && r.right > 0 && r.left < (window.innerWidth || 0);
        nodes.push({ref: ref, role: role, name: name, bounds: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], inView: inView, disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true')});
      }
      return JSON.stringify({url: location.href, title: document.title, viewport: {width: window.innerWidth, height: window.innerHeight, scale: 1}, nodes: nodes, truncated: all.length > MAX});
    })()
  """.trimIndent()

  private val RESOLVE_REF_JS = """
    (function(){
      var el = document.querySelector('[data-dsh-bx="__REF__"]');
      if (!el) return JSON.stringify({found: false});
      el.scrollIntoView({block: 'center', inline: 'center'});
      var r = el.getBoundingClientRect();
      return JSON.stringify({found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, vw: window.innerWidth || 1, vh: window.innerHeight || 1, disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'), inView: r.bottom > 0 && r.top < (window.innerHeight || 0) && r.right > 0 && r.left < (window.innerWidth || 0)});
    })()
  """.trimIndent()

  private val TYPE_JS = """
    (function(){
      var el = document.querySelector('[data-dsh-bx="__REF__"]');
      if (!el) return JSON.stringify({found: false});
      el.focus();
      if (__REPLACE__ && typeof el.select === 'function') { try { el.select(); } catch (e) {} }
      var inserted = false;
      try { inserted = document.execCommand('insertText', false, __TEXT__); } catch (e) { inserted = false; }
      if (!inserted) {
        if (el.isContentEditable) {
          inserted = true;
        } else {
          var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (setter && setter.set) setter.set.call(el, __TEXT__); else el.value = __TEXT__;
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
          inserted = true;
        }
      }
      var value = el.isContentEditable ? el.innerText : el.value;
      return JSON.stringify({found: true, inserted: inserted, value: String(value === null || value === undefined ? '' : value).slice(0, 200)});
    })()
  """.trimIndent()

  private val KEY_CODES = mapOf(
    "enter" to KeyEvent.KEYCODE_ENTER,
    "tab" to KeyEvent.KEYCODE_TAB,
    "escape" to KeyEvent.KEYCODE_ESCAPE,
    "esc" to KeyEvent.KEYCODE_ESCAPE,
    "backspace" to KeyEvent.KEYCODE_DEL,
    "delete" to KeyEvent.KEYCODE_FORWARD_DEL,
    "arrowup" to KeyEvent.KEYCODE_DPAD_UP,
    "up" to KeyEvent.KEYCODE_DPAD_UP,
    "arrowdown" to KeyEvent.KEYCODE_DPAD_DOWN,
    "down" to KeyEvent.KEYCODE_DPAD_DOWN,
    "arrowleft" to KeyEvent.KEYCODE_DPAD_LEFT,
    "left" to KeyEvent.KEYCODE_DPAD_LEFT,
    "arrowright" to KeyEvent.KEYCODE_DPAD_RIGHT,
    "right" to KeyEvent.KEYCODE_DPAD_RIGHT,
    "pageup" to KeyEvent.KEYCODE_PAGE_UP,
    "pagedown" to KeyEvent.KEYCODE_PAGE_DOWN,
    "home" to KeyEvent.KEYCODE_MOVE_HOME,
    "end" to KeyEvent.KEYCODE_MOVE_END,
    "space" to KeyEvent.KEYCODE_SPACE,
  )
}

/**
 * Process-wide handle for the Activity-owned BrowserHost instance.
 *
 * The accessibility control service carries the model-facing `browser*` ops in the existing queue,
 * but the untrusted WebView itself is owned by the Activity. The holder lets the service route an
 * op to the live instance without moving WebView ownership; absence is explicit, never guessed.
 */
internal object BrowserHostHolder {
  @Volatile
  var host: BrowserHost? = null

  /** Route one control op to the live BrowserHost; absent host is a structured fail-closed answer. */
  fun control(op: String, args: JSONObject): JSONObject {
    val current = host ?: return JSONObject()
      .put("__error", "浏览器工作台尚未创建：请先在右侧栏「AI 浏览器」中打开页面。")
      .put("reason", "browser-host-unavailable")
    return current.controlOp(op, args)
  }
}
