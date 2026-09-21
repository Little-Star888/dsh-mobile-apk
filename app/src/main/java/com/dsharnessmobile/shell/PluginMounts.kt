package com.dsharnessmobile.shell

import android.content.Context
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/**
 * 插件挂载清单（清单式回滚；2026-09-21 用户拍板的设计，取代此前「整份配置快照回滚」）。
 *
 * ## 为什么不做整份回滚
 *
 * 旧修法（`UndoGate` 的 known-good 快照）把整份 `profiles/web/cordis.patch.yml` 写回。用户实测口径的
 * 异议成立：**用户在「最后一次健康启动」之后装的插件会全部从装配里消失**——用一个坏插件换掉用户
 * 全部插件的状态，代价不可接受。挂载清单里我们的 `@dsh-android/<插件名>`、上游的 `@deepseek-ai/<插件名>`、
 * 市场装的 `dshmarketplace-plugin` 是**同形同级**的条目（设备实读确认），所以「按名字前缀区分」不可行。
 *
 * ## 两份清单（只有两份）
 *
 * - **硬清单**（[hardFile]）：**随版本走**——安装/升级那一刻（`.snapshot-fingerprint` 变化时）把当时
 *   patch 里的插件集合记为硬清单，此后**只增不减**。它是「我们自己插入的、肯定没问题、强制保留」的集合，
 *   外科修复**绝不**动它。
 * - **软清单**（[softFile]）：**启动后校验出来的当前可用状态**——只在「挂载清单有变化」且「本次启动
 *   被壳侧探活确认健康」时更新（清单没变直接跳过，不做无谓写入）。它用来回答一句话：
 *   **这次的故障是不是插件清单变化引起的**。
 *
 * ## 决策（在 `UndoGate.execute` 里，先于任何整份回滚）
 *
 * 1. 引擎日志点名了失败的 loader entry（`failed to import loader entry <id> (<包名>)`）→ 该插件不在硬清单
 *    ⇒ **只拔掉它**（删掉承载它的整块），其余条目一字不动；
 * 2. 拔不掉 / 点不出名字，但**挂载清单与软清单一致**（没变过）⇒ 故障与插件无关，才允许走 known-good
 *    整份回滚（此时回滚不会丢任何插件——清单没变）；
 * 3. 清单变了又点不出名字 ⇒ **不自动回滚**，写明理由交给用户（宁可不动，也不做一次会吞掉用户插件的写回）。
 *
 * 纯逻辑（[mountedNames] / [failedEntryOf] / [removeEntry] / [digest]）全部 JVM 可测，见 `PluginMountsTest`。
 */
object PluginMounts {

  /** 硬清单文件名（`files/` 下；指纹变化即重建，只增不减）。 */
  const val HARD_FILE = ".plugin-hard-manifest.json"

  /** 软清单文件名（`files/` 下；健康 + 清单变化才写）。 */
  const val SOFT_FILE = ".plugin-soft-manifest.json"

  /** 壳侧使用的 profile 名（与 `UndoGate` 传给急救 CLI 的 `DSH_UNDO_PROFILE` 同源）。 */
  const val PROFILE = "web"

  /** 挂载清单文件的相对路径（相对 `.dsh/`）。 */
  const val PATCH_REL = "profiles/$PROFILE/cordis.patch.yml"

  /** 日志里点名失败 loader entry 的两种形态（带括号包名 / 只有 id）。 */
  private val LOADER_FAIL_WITH_NAME = Regex("""failed to import loader entry\s+(\S+)\s+\(([^()]+)\)""")
  private val LOADER_FAIL_ID_ONLY = Regex("""failed to import loader entry\s+(\S+)""")

  /** `name: 'x'` / `name: x`（挂载条目的包名行）。 */
  private val NAME_LINE = Regex("""(?m)^\s*name:\s*['"]?([^'"\s][^'"]*?)['"]?\s*$""")

  /** 顶层条目起始行（`- insert:` / `- id: x` / `-`）。 */
  private val TOP_LEVEL = Regex("""^-\s.*|^-$""")

  fun hardFile(context: Context): File = File(context.filesDir, HARD_FILE)

  fun softFile(context: Context): File = File(context.filesDir, SOFT_FILE)

  /** 当前 profile 的挂载清单文件（引擎 home 下）。 */
  fun patchFile(engine: EngineManager): File = File(File(engine.homeDir, ".dsh"), PATCH_REL)

  /** 一次点名的失败条目：loader entry 的 id（`- id:`）与包名（`name:`），任一可为 null。 */
  data class FailedEntry(val id: String?, val name: String?)

  // ── 纯逻辑 ──────────────────────────────────────────────────────────────

  /**
   * 纯逻辑：挂载清单里出现的全部插件名（`name:` 值，剥掉引号）。
   *
   * 用 `name:` 行而不是解析 YAML：清单格式由我们与上游共同书写，设备实读的形状是固定的三层
   * （`- insert:` → `    - id:` → `      name:`），而引 YAML 解析器会引入一份与引擎不同版本的实现。
   * 判据取「名字集合」，因此即使将来多出字段也不影响本用途。
   */
  fun mountedNames(patchText: String): List<String> =
    NAME_LINE.findAll(patchText)
      .map { it.groupValues[1].trim().trim('\'', '"') }
      .filter { it.isNotEmpty() }
      .toList()

  /** 纯逻辑：内容指纹（sha256 十六进制）。 */
  fun digest(text: String): String {
    val md = MessageDigest.getInstance("SHA-256")
    return md.digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
  }

  /**
   * 纯逻辑：从引擎日志文本里点名失败的 loader entry。
   *
   * 认的是引擎自己的报错原文（设备实读）：
   * `failed to import loader entry dsh-bad-probe (@dsh-android/dsh-bad-probe): INJECTED-BAD-PLUGIN`
   * ——括号里是包名（能精确定位条目），没有括号时退化为只有 entry id（同样能定位 `- id:` 行）。
   */
  fun failedEntryOf(logText: String): FailedEntry? {
    LOADER_FAIL_WITH_NAME.find(logText)?.let {
      return FailedEntry(id = it.groupValues[1], name = it.groupValues[2].trim())
    }
    LOADER_FAIL_ID_ONLY.find(logText)?.let {
      return FailedEntry(id = it.groupValues[1], name = null)
    }
    return null
  }

  /**
   * 纯逻辑：删掉承载指定插件（按包名，退回按 entry id）的**整块**，返回新文本；无法唯一定位返回 null。
   *
   * 块边界：从该 `name:` 行向上找到最近的一条**顶层条目**（`- insert:` / `- id: x`，列 0 起），
   * 向下到下一个顶层条目之前。块内自带注释（缩进行）随之删除；块**之前**的说明注释（列 0 的 `#`）
   * 保留——那些注释属于其后紧邻的条目，误删会破坏下一块的文档。
   *
   * 为什么要按块删而不是删那一行：只删 `name:` 会留下悬空的 `- id:`，引擎仍然按那条装配去 import
   * （坏插件照旧被挂载），等于没拔。
   */
  fun removeEntry(patchText: String, name: String?, id: String?): String? {
    val wanted = listOfNotNull(name?.trim()?.trim('\'', '"'), id?.trim()).filter { it.isNotEmpty() }
    if (wanted.isEmpty()) return null
    val lines = patchText.split("\n").toMutableList()
    val hits = ArrayList<Int>()
    for (i in lines.indices) {
      val trimmed = lines[i].trim()
      if (trimmed.startsWith("name:")) {
        val v = trimmed.removePrefix("name:").trim().trim('\'', '"')
        if (wanted.contains(v)) hits.add(i)
      } else if (trimmed.startsWith("- id:")) {
        val v = trimmed.removePrefix("- id:").trim().trim('\'', '"')
        if (name == null && wanted.contains(v)) hits.add(i)
      }
    }
    if (hits.isEmpty()) return null
    var removed = 0
    // 从后往前删，索引不失效；同一块命中多次也只删一次（用已删区间去重）。
    for (hit in hits.sortedDescending()) {
      var start = hit
      while (start >= 0 && !TOP_LEVEL.matches(lines[start])) start--
      if (start < 0) return null // 找不到顶层起点：宁可不删，也不猜
      var end = start + 1
      while (end < lines.size && !TOP_LEVEL.matches(lines[end])) end++
      lines.subList(start, end).clear()
      removed++
    }
    if (removed == 0) return null
    return lines.joinToString("\n")
  }

  // ── 清单读写 ────────────────────────────────────────────────────────────

  /** 硬清单里的插件名（读不到/损坏返回空集：空集时外科修复会拒绝拔任何东西，fail-closed）。 */
  fun hardNames(context: Context): Set<String> = readNames(hardFile(context))

  /** 软清单里的插件名（无软清单返回 null——「从没确认过健康状态」与「确认过且为空」必须可区分）。 */
  fun softNames(context: Context): Set<String>? =
    softFile(context).takeIf { it.exists() }?.let { readNames(it) }

  /** 软清单记录的挂载清单指纹（无则 null）。 */
  fun softDigest(context: Context): String? =
    softFile(context).takeIf { it.exists() }?.let { f ->
      try { JSONObject(f.readText()).optString("digest", "").takeIf { it.isNotEmpty() } } catch (_: Throwable) { null }
    }

  private fun readNames(f: File): Set<String> {
    if (!f.exists()) return emptySet()
    return try {
      val arr = JSONObject(f.readText()).optJSONArray("names") ?: JSONArray()
      (0 until arr.length()).map { arr.optString(it, "") }.filter { it.isNotEmpty() }.toSet()
    } catch (_: Throwable) {
      emptySet()
    }
  }

  private fun writeNames(f: File, names: Collection<String>, fingerprint: String?, digest: String?, at: Long) {
    val o = JSONObject()
    o.put("names", JSONArray(names.sorted()))
    if (fingerprint != null) o.put("fingerprint", fingerprint)
    if (digest != null) o.put("digest", digest)
    o.put("at", at)
    f.writeText(o.toString())
  }

  /**
   * 硬清单维护：**安装指纹变化**（新装/升级）时，把当前清单里的插件并入硬清单（只增不减）。
   *
   * 取「并入」而不是「替换」：升级时 patch 里可能已经混着用户自装条目，而把用户条目误判成
   * 「可以拔」是危险方向——宁可少拔（保留原样、交给用户判断），不可错拔。返回值 = 是否发生了更新。
   */
  fun ensureHard(context: Context, patch: File, fingerprint: String?): Boolean {
    val fp = fingerprint ?: return false
    val stored = try { JSONObject(hardFile(context).readText()).optString("fingerprint", "") } catch (_: Throwable) { "" }
    if (stored == fp) return false
    val current = try { mountedNames(patch.readText()) } catch (_: Throwable) { emptyList() }
    val merged = (hardNames(context) + current).sorted()
    writeNames(hardFile(context), merged, fp, null, System.currentTimeMillis())
    return true
  }

  /**
   * 软清单维护：**只在挂载清单相对上次记录发生变化时**写入（没变化直接跳过）。
   *
   * 调用点必须是「壳侧探活确认健康」的那一拍——软清单的语义是「当前这份清单被证明可用」，
   * 在崩溃的启动上写它等于把坏状态记为良好（这正是旧修法踩过的坑）。
   */
  fun noteHealthy(context: Context, patch: File): Boolean {
    val text = try { patch.readText() } catch (_: Throwable) { return false }
    val d = digest(text)
    if (d == softDigest(context)) return false
    writeNames(softFile(context), mountedNames(text), null, d, System.currentTimeMillis())
    return true
  }

  /** 挂载清单是否与软清单一致（一致 = 这次的故障不是插件清单变化引起的）。 */
  fun mountUnchangedSinceHealthy(context: Context, patch: File): Boolean {
    val recorded = softDigest(context) ?: return false
    val text = try { patch.readText() } catch (_: Throwable) { return false }
    return digest(text) == recorded
  }

  /**
   * 外科修复：把点名失败的插件从装配里拔掉（删掉承载它的整块并写回）。
   *
   * @return true = 已拔掉并写回（调用方随后重启引擎）；false = 没有改动（点不出名字/块定位不到/写回失败）。
   */
  fun pull(context: Context, patch: File, failed: FailedEntry): Boolean {
    val text = try { patch.readText() } catch (_: Throwable) { return false }
    val next = removeEntry(text, failed.name, failed.id) ?: return false
    if (next == text) return false
    return try {
      patch.writeText(next)
      true
    } catch (_: Throwable) {
      false
    }
  }

  /** 引擎日志尾部 4KB（loader 失败原文只在这份日志里；与 `WatchdogV2` 同口径）。 */
  fun readEngineLogTail(context: Context, bytes: Int = 4096): String {
    return try {
      val f = File(context.filesDir, "engine.log")
      if (!f.exists()) return ""
      RandomAccessFile(f, "r").use { raf ->
        val len = raf.length()
        val off = (len - bytes).coerceAtLeast(0)
        raf.seek(off)
        val buf = ByteArray((len - off).toInt().coerceAtMost(bytes))
        val n = raf.read(buf)
        String(buf, 0, n.coerceAtLeast(0), Charsets.UTF_8)
      }
    } catch (_: Throwable) {
      ""
    }
  }
}
