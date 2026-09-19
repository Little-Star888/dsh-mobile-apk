package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONObject

/**
 * sh* op：Shizuku 特权 shell 通道（0.14.0 §6 —— 替换退役的内置 adb）。
 *
 * 两条通道独立可用：本组 op 由 [ControlCarrier] 承载（随前台引擎服务起停），**不依赖无障碍服务**；
 * 引擎侧 `execAdbShell` / `execAdbLine` 经控制队列投递到这里，由 [ShizukuTransport] 在 shell
 * uid=2000 的 UserService 内执行。执行面复查屏幕范围（§6 末条：两条通道的执行点都要复查）。
 *
 * 两处调用方：
 * - `DeviceControlService.handle`：六面登记链按行首引号解析分支名，分支必须留在 handle 里，
 *   实现委托到本对象（scripts/check-control-ops.mjs 的 A 项）；
 * - `ControlCarrier`：无障碍关闭时的承载者（队列由前台引擎服务持有）。
 */
internal object ShellOps {

  /** 与引擎侧 `screen-scope.ts` 的 REAL_SCREEN_ADB_COMMAND 同规则（真实屏读写命令词）。 */
  private val REAL_SCREEN_COMMAND = Regex(
    "\\b(?:screencap|screenrecord|uiautomator|input\\s+(?:tap|swipe|roll|draganddrop|motionevent|text|keyevent)" +
      "|wm\\s+(?:size|density|overscan)|dumpsys\\s+(?:window|display|input)|am\\s+(?:start|start-activity|force-stop|kill)|monkey)\\b",
    RegexOption.IGNORE_CASE,
  )

  /**
   * 目标 display id 参数（块G F5）。与引擎侧 `adbCommandDisplayTokens` 的正则**逐字同源**：
   * `(?:^|[\s=])(?:-d|--display|--display-id)[\s=]+(\d+)`。
   * 取值保留**原样字符串**：块G F6 起 `-d` 也可能是超 `Long` 的 SurfaceFlinger token（见坑 147）。
   */
  private val DISPLAY_ID_ARG = Regex("""(?:^|[\s=])(?:-d|--display|--display-id)[\s=]+(\d+)""")

  /** SurfaceFlinger 的虚拟屏 token 行 / 其后的 name= 行（设备实测形态，见坑 147）。 */
  private val SF_DISPLAY_LINE = Regex("""Virtual Display\s+(\d+)""")
  private val SF_NAME_LINE = Regex("""\s*name="([^"]*)"""")
  private const val SF_NAME_PREFIX = "DSH "

  fun handle(context: Context, op: String, args: JSONObject): JSONObject = when (op) {
    "shExec" -> exec(context, args)
    "shPull" -> pull(context, args)
    "shPush" -> push(context, args)
    "shRemove" -> remove(context, args)
    else -> JSONObject()
      .put("__error", "未知特权 shell 操作 $op")
      .put("reason", "unknown-op")
      .put("op", op)
  }

  private fun exec(context: Context, args: JSONObject): JSONObject {
    val command = args.optString("command", "")
    if (command.isBlank()) return fail("shExec 缺少 command", "shell-empty")
    scopeDenied(context, command)?.let { return it }
    val result = ShizukuTransport.runShell(
      context,
      command,
      timeoutMs = args.optInt("timeoutMs", 20_000),
      capture = args.optBoolean("capture", false),
    )
    audit(context, "shExec", command, result.optBoolean("ok"))
    return result.put("op", "shExec").put("transport", "shizuku")
  }

  private fun pull(context: Context, args: JSONObject): JSONObject {
    val remote = args.optString("remote", "")
    val local = args.optString("local", "")
    if (remote.isBlank() || local.isBlank()) return fail("shPull 需要 remote 与 local", "shell-path-missing")
    val result = ShizukuTransport.pullFile(context, remote, local)
    audit(context, "shPull", "$remote -> $local", result.optBoolean("ok"))
    return result.put("op", "shPull").put("transport", "shizuku")
  }

  private fun push(context: Context, args: JSONObject): JSONObject {
    val local = args.optString("local", "")
    val remote = args.optString("remote", "")
    if (local.isBlank() || remote.isBlank()) return fail("shPush 需要 local 与 remote", "shell-path-missing")
    val result = ShizukuTransport.pushFile(context, local, remote)
    audit(context, "shPush", "$local -> $remote", result.optBoolean("ok"))
    return result.put("op", "shPush").put("transport", "shizuku")
  }

  private fun remove(context: Context, args: JSONObject): JSONObject {
    val remote = args.optString("remote", "")
    if (remote.isBlank()) return fail("shRemove 需要 remote", "shell-path-missing")
    val result = ShizukuTransport.removeRemote(context, remote)
    audit(context, "shRemove", remote, result.optBoolean("ok"))
    return result.put("op", "shRemove").put("transport", "shizuku")
  }

  /** §6：屏幕范围（virtual-only 栅栏）在本通道执行点复查——只做保守命令词匹配。 */
  private fun scopeDenied(context: Context, command: String): JSONObject? {
    if (ScreenScopePrefs.current(context) != ScreenScope.VIRTUAL_ONLY) return null
    if (!REAL_SCREEN_COMMAND.containsMatchIn(command)) return null
    // 块G F5（0.14.1）：目标屏是**已注册虚拟屏**的命令放行——`screencap -d <虚拟屏 id>` 读的是
    // 范围内的屏，与无参 `screencap`（读真实屏 0）根本不是一件事。
    //
    // 为什么壳侧必须有这一条（真缺陷，不是可选优化）：T3 已在引擎侧 `screen-scope.ts` 的
    // `realScreenAdbCommandDenied` 修了 F2，但本函数是同一正则的 **Kotlin 副本**——它在
    // **执行点**（Shizuku 通道真正下发命令前）复查。只修引擎侧 ⇒ 壳侧这条二次拦截，F2
    // 在 shell 路径上被完全抵消（引擎放行、壳侧仍拒），用户看到的仍是「范围允许 virtual-1
    // 却说不许访问真实屏」。两处必须同口径。
    //
    // 放宽面收敛在「显式且可与注册表核对的目标屏」上：无 -d、-d 0、-d 未知 id 一律保持拒绝
    // （fail-closed，不凭命令里的数字自证「这是虚拟屏」）——与引擎侧 `targetsRegisteredVirtualScreen`
    // 的三条判据逐条对应。
    if (targetsRegisteredVirtualScreen(context, command)) return null
    return JSONObject()
      .put("__error", "用户当前开放屏幕范围为 virtual-only，不允许经特权 shell 读取或操作真实屏幕" +
        "（screencap / input / uiautomator / wm / dumpsys / am / monkey）。请由用户在设置中修改范围后重试。")
      .put("reason", "screen-out-of-scope")
      .put("op", "shExec")
  }

  /**
   * 命令是否命中「真实屏读写命令词」面（[REAL_SCREEN_COMMAND] 的可测入口）。
   * 生产路径由 [scopeDenied] 内部调用，此处单独暴露只为让 JVM 单测锁住**命令词面不得缩水**
   * （缩水 = 直接放行真实屏，是范围门禁的自毁形态）。
   */
  internal fun commandTargetsRealScreen(command: String): Boolean = REAL_SCREEN_COMMAND.containsMatchIn(command)

  /**
   * 命令的显式目标屏是否**确为**一块已注册虚拟屏。两个 id 空间任一逐条命中即放行
   * （设备实测证明二者不相交，见 gotchas 147）：
   *
   * ① **DisplayManager displayId**（数值）：非 0 且能在 `VdisplayController` 注册表里反查到别名。
   * ② **SurfaceFlinger token**（十进制串，块G F6）：token **逐字**等于某块**已注册别名**虚拟屏的
   *    SF token。`screencap -d` 实际吃的就是这个 token——用 displayId 传必然 Status -2，
   *    故只认 displayId 会让「放行的值取不到图、能取到图的值被拒」。
   *
   * 为什么要两道各自核对（本函数是**执行点**复查，不是重复劳动）：引擎侧门禁可被其它调用方绕过，
   * 本处是 Shizuku 真正下发命令前的最后一道；T3 的 F2 与这里必须同口径，否则壳侧二次拦截会把
   * F2 完全抵消（这正是 F5 的由来）。
   *
   * 注册表/token 反查不可达/虚拟屏未注册 → 判否 → 拒绝（fail-closed：绝不凭命令里的数字自证）。
   *
   * token 全程按**字符串**处理：设备实测虚拟屏 token 形如 `11529215046816944610`，超出
   * `Int` 与 `Long` 值域，任何数值化都会失真（见坑 147）。
   *
   * @param context 用于 SF token 反查（经 Shizuku shell 通道读 SurfaceFlinger）；
   *   null 时（JVM 单测）等价于「反查不可达」→ 仅 displayId 路径可用。
   */
  internal fun targetsRegisteredVirtualScreen(context: Context?, command: String): Boolean {
    if (context == null) return false
    // 数据面各自解析，判据交给下面的纯函数（各自 fail-closed：拿不到即空集/恒 false）。
    return decideTargetsRegisteredVirtualScreen(
      command = command,
      ownsDisplayId = { id -> VdisplayController.aliasForDisplayId(id) != null },
      ownedSfTokens = sfTokensOfRegisteredDisplays(context),
    )
  }

  /**
   * 纯判据：命令的显式目标屏是否确为一块**已注册**虚拟屏（G-F5 放行分支的可测入口）。
   *
   * 为什么单独抽出来：放行分支此前**零测试覆盖**——所有 JVM 用例都传 `context = null`，
   * 而 `null` 恒走 fail-closed 路径（因此只测到了拒绝）。注册表的数据面
   * （`VdisplayController.aliasForDisplayId` / SF 反查）在 JVM 下不可注入（`Record` 持真实
   * `VirtualDisplay`/`ImageReader`），于是「合法目标屏必须放行」这条**在单测里根本无法表达**。
   * 抽成纯函数后，放行与拒绝两侧都能被钉死，且改坏放行逻辑即判红。
   *
   * 与引擎侧 `targetsRegisteredVirtualScreen(command, options)` 同构（同两条 id 空间、同 fail-closed）。
   *
   * @param ownsDisplayId displayId 空间：该 id 是否属于一块已注册虚拟屏（**不含 0**）
   * @param ownedSfTokens token 空间：已注册虚拟屏的 SF token 集合（已与产品别名配对）
   */
  internal fun decideTargetsRegisteredVirtualScreen(
    command: String,
    ownsDisplayId: (Int) -> Boolean,
    ownedSfTokens: Set<String>,
  ): Boolean {
    val tokens = commandDisplayTokens(command)
    if (tokens.isEmpty()) return false

    // ① DisplayManager displayId 空间（F2/F5 既有路径）：非 0 且确在注册表内。
    //    `id != 0` 是安全不变量——0 恒为真实屏，放行它等于范围门自毁。
    if (tokens.all { raw ->
        val id = raw.toIntOrNull()
        id != null && id != 0 && ownsDisplayId(id)
      }
    ) {
      return true
    }

    // ② SurfaceFlinger token 空间（F6）：逐字字符串比对，必须属于**已注册别名**的虚拟屏。
    if (ownedSfTokens.isEmpty()) return false
    return tokens.all { ownedSfTokens.contains(it) }
  }

  /**
   * 当前**已注册**虚拟屏的 SF token 集合（块G F6）。经 Shizuku shell 通道读
   * `dumpsys SurfaceFlinger`（收窄到 Virtual Display + name 两行），把 `name="DSH <alias>"`
   * 配对回产品别名，再与 `VdisplayController.activeAliases()` 求交——**只有配对别名仍注册**
   * 的 token 才有效（虚拟屏已销毁 → 其 token 立刻失效）。
   *
   * 必须**先 grep 收窄**：设备实测全量 `dumpsys SurfaceFlinger` 为 31,590 B，而虚拟屏段落在
   * 第 ~9,500 字节之后，超出 shell 通道的 inline 回传窗口 ⇒ 全量取回拿不到目标行、反查恒空。
   *
   * fail-closed：通道不可达/超时/输出为空/解析不出 → 空集（调用方据此拒绝）。
   */
  private fun sfTokensOfRegisteredDisplays(context: Context): Set<String> {
    val registered = VdisplayController.activeAliases()
    if (registered.isEmpty()) return emptySet()
    return try {
      val r = ShizukuTransport.runShell(
        context,
        "dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'",
        timeoutMs = 8_000,
      )
      if (!r.optBoolean("ok")) return emptySet()
      val stdout = r.optString("stdout", "")
      if (stdout.isBlank()) return emptySet()
      parseSfDisplayTokens(stdout).filter { it.first in registered }.map { it.second }.toSet()
    } catch (_: Throwable) {
      emptySet()
    }
  }

  /**
   * 纯函数：解析 `dumpsys SurfaceFlinger` 输出里的 `Virtual Display <token>` + 紧跟
   * `name="DSH <alias>"` 配对（与引擎侧 `screenTokensFromSfDump` 同规则）。
   *
   * 设备实测形态：
   * ```
   *     name="mumuscreen000"
   * Virtual Display 11529215046816944610
   *     name="DSH virtual-1"
   * ```
   * @return (alias, token) 列表；token 原样字符串
   */
  internal fun parseSfDisplayTokens(sfDump: String): List<Pair<String, String>> {
    val out = ArrayList<Pair<String, String>>()
    var pending: String? = null
    for (raw in sfDump.lines()) {
      val line = raw.trim()
      val tokenMatch = SF_DISPLAY_LINE.matchEntire(line)
      if (tokenMatch != null) {
        pending = tokenMatch.groupValues[1]
        continue
      }
      if (pending == null) continue
      val nameMatch = SF_NAME_LINE.matchEntire(raw)
      if (nameMatch == null) continue
      val displayName = nameMatch.groupValues[1]
      if (displayName.startsWith(SF_NAME_PREFIX)) {
        out.add(displayName.removePrefix(SF_NAME_PREFIX) to pending!!)
      }
      // 配对已消费（无论是否 DSH 屏）：防止把下一个 name= 错配到本 token 上。
      pending = null
    }
    return out
  }

  /**
   * 命令里的目标屏数字串（**保留原样，不数值化**）——token 超 `Int`/`Long` 值域，
   * 数值化即失真（见坑 147）。与引擎侧 `adbCommandDisplayTokens` 的取法一致。
   */
  internal fun commandDisplayTokens(command: String): List<String> =
    DISPLAY_ID_ARG.findAll(command).map { it.groupValues[1] }.toList()

  private fun audit(context: Context, op: String, detail: String, ok: Boolean) {
    val uid = ShizukuTransport.identity(context).optInt("uid", -1)
    ControlAudit.log(
      context,
      op,
      mapOf(
        "transport" to "shizuku",
        "uid" to uid,
        "op" to op,
        "detail" to detail.take(512),
        "ok" to ok,
      ),
    )
  }

  private fun fail(message: String, reason: String): JSONObject = JSONObject()
    .put("__error", message)
    .put("reason", reason)
}
