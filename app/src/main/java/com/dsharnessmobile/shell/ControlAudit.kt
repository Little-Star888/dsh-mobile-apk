package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 授权审计（原生侧写面，与 dsh-android-bridge 插件同路径同格式：
 * files/audit/audit.ndjson 换行分隔 JSON；ts=ISO8601 UTC + action + tool + args + result，
 * 不含任何凭据/配对码值）。
 *
 * 0.14.0：随内置 adb 退役从 AdbState 迁出（原 AdbAudit，含 transport/uid/op 字段）。
 */
object ControlAudit {

  private val TS = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
  }

  fun log(context: Context, action: String, args: Map<String, Any?>) {
    try {
      val dir = File(context.filesDir, "audit")
      dir.mkdirs()
      val f = File(dir, "audit.ndjson")
      val entry = JSONObject()
        .put("ts", TS.format(Date()))
        .put("action", action)
        .put("tool", "shell-native")
        .put("args", JSONObject(args as Map<*, *>))
        .put("result", "ok")
      f.appendText(entry.toString() + "\n")
    } catch (_: Throwable) {
      /* 审计失败不阻断授权（隐私优先，静默放弃） */
    }
  }
}
