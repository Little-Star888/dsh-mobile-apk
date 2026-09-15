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
    return JSONObject()
      .put("__error", "用户当前开放屏幕范围为 virtual-only，不允许经特权 shell 读取或操作真实屏幕" +
        "（screencap / input / uiautomator / wm / dumpsys / am / monkey）。请由用户在设置中修改范围后重试。")
      .put("reason", "screen-out-of-scope")
      .put("op", "shExec")
  }

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
