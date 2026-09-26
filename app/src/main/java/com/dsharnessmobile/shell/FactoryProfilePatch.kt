package com.dsharnessmobile.shell

/**
 * profile `cordis.patch.yml` 的工厂语义纠正（0.14.0-preview，apk #214）。
 *
 * 缺陷（已核实）：[SnapshotTransaction] 旧规则是「live 内容为基，追加 live 缺失的工厂块」
 * （0.13.8 #167 引入的 `profiles` 合并），live 里一旦存在与工厂同 id 的块，工厂**永不纠正**它。
 * 于是从「曾禁用 ui-layout」的旧版本升级上来的设备（<=0.13.6 的权威装配清单含
 * `- id: ui-layout / disabled: true`），live patch 永久保留该 disable → 上游 bundle 的
 * ui-layout 行（`dsh/packages/bundle/web-app/cordis.patch.yml:207`）被禁 → 根服务 `layout`
 * 不 activate → 13 条客户端插件全部 pending（截图现场）。干净安装不受影响（live 不存在时
 * `profiles` 走整树替换）。
 *
 * ## 0.14.2（D10）：合并粒度从「块」改为「条目」
 *
 * 旧实现把 `- insert:` 组当成**一个块**，并用「块内任意深度的 `id:` 行」当这个块的 id
 * （`blockIds` 的无限缩进匹配）。两个后果，都**零日志**：
 *
 * - **P-1 永不追加**：追加判据是「该块任一 id 已在 live 中」⇒ 只要 live 里**任何**块
 *   （包括某个 insert 组的子条目）含了工厂顶层块的 id，工厂那一块就被判「已存在」而不追加。
 *   实测最小用例：live 只含 `shell-termux` 时工厂组的 `host-web-compat` 静默不补齐。
 * - **P-2 误归属**：工厂对 id X 声明的 `disabled` 会被写进「包含 X 的块」的**首个** id 行之后。
 *   若 X 是某 insert 组的**非首个子条目**，改的是组首子项，目标子条目一字未动。
 *
 * 现在：**条目（entry）** 是唯一的定位与判定单位 ——
 * - 顶层条目 = 列 0 的 `- id: X`（或 `- insert:` 组）；
 * - insert 组的一层子条目 = 组内**最浅缩进**的 `- id: Y` 行（配置块内更深的 `id:` 不是条目，
 *   因此 `llm-pi-ai` 的 36 个模型 id 不再稀释块级判据）；
 * - 追加按条目判定：组内每个子条目各自按 id 决定是否追加，追加到 live 中该组的对应位置；
 * - `disabled` 纠正按条目定位：写在该 id **自己**那一条上（组内子项就写子项）。
 *
 * 「顶层非 insert 行行为保持不变」由条目级判据自然满足：顶层条目的 id 就是它自己的 id。
 *
 * ## 边界（保持不变）
 * - 工厂对某 id 显式声明 `disabled: <bool>` → 以工厂值为准；条目内其它用户内容不动；
 * - 退役行（[RETIRED_DISABLED_ROW_IDS]）→ 清掉残留的 `disabled: true`；该条目若只剩 id/注释则整条删除；
 * - 其它 live 独有条目（用户追加块、用户自建 profile 条目）**原样保留**；
 * - live 缺失的工厂条目照旧追加（#167 语义不变）；
 * - live 结构未知（非空、非空序列、且无任何条目 id）时不做追加，保守保 live；
 * - live 为显式空序列 `[]` 时按「空」处理并落工厂件（旧实现把它当「非空但无 id」→ 阻断全部追加）。
 *
 * ## 文本层 + 逐字节保真
 * 全文重建必须与输入逐字节相同（无改动即不重写文件），所以切块按**位置**逐行进行、
 * 未改动的片段一律 append 原文。
 */
internal object FactoryProfilePatch {

  /**
   * 退役行 id：工厂曾写入 `disabled: true`、当前权威清单已不再提及（= 应启用）的行。
   *
   * 取证与边界（#214）：
   * - `ui-layout`：上游 web-app bundle 真行（`@deepseek-ai/dsh-client-ui-layout`，见
   *   `dsh/packages/bundle/web-app/cordis.patch.yml:207`）；当前
   *   `scripts/profile-web.cordis.patch.yml:28-31` 明确写「ui-layout 不再禁用——它已成为布局
   *   服务中枢，禁用即会话与左栏同时不可用」。
   * - 不纳入 `bash-local`：上游 bundle 已无该行（`dsh/packages` 内只剩包名引用）——清残留是空操作，
   *   纳入只会在未来上游复活该行时静默启用它。
   * - **不纳入 `permission`**：上游 base bundle 仍有该行
   *   （`dsh/packages/bundle/base/cordis.patch.yml:229`，`@deepseek-ai/dsh-permission-presets`）；
   *   清掉 live 残留 disable 等于在我们尚未验证的情况下启用权限预设面，属行为变更——另行取证后再定。
   *
   * 维护约束：权威清单新增或移除 disable 行时本集合必须同步；
   * `FactoryProfilePatchTest.factoryPatchNeverDisablesRetiredRows` 对该断言做回归。
   */
  internal val RETIRED_DISABLED_ROW_IDS = setOf("ui-layout")

  /** 纠正结果：[text] 为纠正后全文，[changes] 为人类可读的改动说明（写日志/诊断）。 */
  internal class Result(val text: String, val changes: List<String>)

  /** 列 0 的列表项起始：`- `、裸 `-`（行尾）都算；tab 缩进**不算**（缩进的 `-` 是子条目）。 */
  private val TOP_ITEM = Regex("""^-(?:\s|$)""")

  /** 顶层条目 id 行。 */
  private val TOP_ID = Regex("""^- id:\s*(\S+)""")

  /** 顶层 insert 组行。 */
  private val TOP_INSERT = Regex("""^- insert:\s*$""")

  /** 组内条目 id 行（至少一个前导空白，故不会命中列 0 的顶层行）。 */
  private val CHILD_ID = Regex("""^(\s+)- id:\s*(\S+)""")

  /** 形如 `disabled: true|false` 的键行（含缩进捕获）。 */
  private val ENTRY_DISABLED = Regex("""^(\s*)disabled:\s*(true|false)\s*(#.*)?$""")

  /** 块内第一处 `disabled:` 的字面值（兼容既有外部调用点；无该键时 null）。 */
  private val DISABLED_LINE = Regex("""^(\s*)disabled:\s*(true|false)\s*(#.*)?$""", RegexOption.MULTILINE)

  /** 块内任意缩进的 `id:` 键行（用于裸 `-` 顶层项；捕获缩进与 id）。 */
  private val KEY_ID = Regex("""^(\s*)id:\s*(\S+)""")

  /** 形如「只剩 id」的行（纯 id 行不是动作）。 */
  private val PURE_ID_LINE = Regex("""^(?:-\s+)?id:\s*\S+$""")

  // ── 解析模型 ────────────────────────────────────────────────────────────────

  /**
   * 一个条目：顶层条目（顶层块首行的 `- id: X`）或 insert 组的一层子条目。
   *
   * @param id 条目 id（工厂与本文件都要求非空才会产生条目）。
   * @param indent 条目首行的前导空白（顶层条目为 ""，子条目为组内最浅缩进）。
   * @param startLine 条目在所属块内的起始行（0-based）。
   * @param endLine 条目在所属块内的结束行（半开；下一个同层条目/块尾）。
   */
  private class Entry(val id: String, val indent: String, val startLine: Int, val endLine: Int)

  /**
   * 一个顶层块：从块首行（含紧邻前导注释/空行）到下一个列 0 列表项之前。
   *
   * @param text 块原文（逐字节保真的基石）。
   * @param lines 块原文的行视图。
   * @param isInsert 块首行是否为 `- insert:`。
   * @param childIndent insert 组子条目的缩进（非组或空组为 ""）。
   * @param entries 块内的全部条目（顶层条目 0..1 个；insert 组为一层子条目）。
   */
  private class Block(
    val text: String,
    val lines: List<String>,
    val isInsert: Boolean,
    val childIndent: String,
    val entries: List<Entry>,
  )

  /** 单块纠正结果：[text] 为纠正后的块原文，[changes] 为说明，[droppedIds] 为被整条删除的条目 id。 */
  private class ReconcileResult(val text: String, val changes: List<String>, val droppedIds: Set<String>)

  /**
   * 合并（等价于旧的 `mergePatchYamlById`，另加工厂语义纠正）：
   * 先纠正，再按**条目**粒度追加 live 缺失的工厂条目。
   */
  internal fun merge(
    liveText: String,
    factoryText: String,
    retired: Set<String> = RETIRED_DISABLED_ROW_IDS,
  ): Result {
    // live 缺失 / 空白 / 显式空序列（`[]`）：工厂件原样落盘。
    if (liveText.isBlank() || isEmptySequence(liveText)) {
      return Result(factoryText, if (factoryText.isBlank()) emptyList() else listOf("live 为空：落工厂件"))
    }
    val changes = ArrayList<String>()
    val factoryBlocks = parseBlocks(factoryText)
    val factoryDisabled = LinkedHashMap<String, Boolean>()
    val factoryEntryIds = LinkedHashSet<String>()
    for (block in factoryBlocks) {
      for (entry in block.entries) {
        factoryEntryIds += entry.id
        val want = disabledOfEntry(block, entry)
        if (want != null && block.entries.size == 1) factoryDisabled[entry.id] = want
      }
    }

    val liveBlocks = parseBlocks(liveText)
    // 追加闸门取**live 文件原有的条目 id**（不是纠正之后的在场集）：退役行整条删除后
    // `present` 会变空，若拿它当闸门，#167 的「补齐工厂缺失条目」会被整体跳过（实测回归）。
    val liveEntryIds = LinkedHashSet<String>()
    for (block in liveBlocks) for (entry in block.entries) liveEntryIds += entry.id
    val resolved = ArrayList<String>(liveBlocks.size)
    val present = LinkedHashSet<String>(liveEntryIds)
    for (block in liveBlocks) {
      val r = reconcileBlock(block, factoryDisabled, factoryEntryIds, retired)
      resolved += r.text
      changes += r.changes
      for (entry in block.entries) if (entry.id !in r.droppedIds) present += entry.id
    }

    // 追加：逐**条目**判定（P-1 的修法）。insert 组内缺的子条目补进 live 的对应组；
    // live 完全不含该组任何子条目时整组追加（#167 旧语义）；顶层非 insert 块整块追加。
    val tail = StringBuilder()
    if (liveEntryIds.isNotEmpty()) {
      for (block in factoryBlocks) {
        if (block.entries.isEmpty()) continue
        if (!block.isInsert) {
          if (block.entries.any { it.id in present }) continue
          tail.append(block.text.trimEnd('\n')).append('\n')
          block.entries.forEach { present += it.id }
          continue
        }
        val missing = block.entries.filter { it.id !in present }
        if (missing.isEmpty()) continue
        val matched = block.entries.map { it.id }.filter { it in present }
        val target = if (matched.isEmpty()) -1 else pickHostBlock(resolved, liveBlocks, matched)
        if (target < 0) {
          // live 无该组任何子条目：整组追加（旧语义），并把组内 id 全部登记为在场。
          tail.append(block.text.trimEnd('\n')).append('\n')
          block.entries.forEach { present += it.id }
          continue
        }
        val hostIndent = liveBlocks[target].childIndent
        // 追加位置 = 工厂顺序里的原位：补进来的条目排在「工厂顺序中第一个已在场的后继兄弟」之前，
        // 没有后继就排在组尾。这样 0.14.2 的补齐不会把工厂的相对顺序打乱（insert 的顺序
        // 就是 loader 的装配顺序，重排虽不影响 id 覆盖，但会改变激活顺序）。
        val factoryOrder = block.entries.map { it.id }
        val additions = ArrayList<Pair<String?, String>>() // 锚点 id（null = 组尾） to 片段
        for (entry in missing) {
          val fragment = reindent(lineRange(block.lines, entry.startLine, entry.endLine), entry.indent, hostIndent)
          val selfIndex = factoryOrder.indexOf(entry.id)
          val anchor = factoryOrder.drop(selfIndex + 1).firstOrNull { it in present }
          additions += anchor to fragment
          changes += "追加条目: " + entry.id + "（补进 live 的 insert 组）"
          present += entry.id
        }
        resolved[target] = insertIntoGroup(resolved[target], additions)
      }
    }

    val sb = StringBuilder(liveText.length + 256)
    for (text in resolved) sb.append(text)
    var out = sb.toString()
    if (tail.isNotEmpty()) {
      val separator = if (out.endsWith("\n") || out.isEmpty()) "" else "\n"
      out += separator + tail
    }
    return Result(out, changes)
  }

  /**
   * 一次性迁移（启动期自愈，无需工厂参考）：只清退役行的 `disabled: true` 残留。
   * 用于已经被 #214 卡死的设备——它们可能不再触发快照刷新（指纹未变），
   * 因此不能只依赖 [merge]。只作用于 [retired] 内的 id，不新增任何 disable。
   * 粒度为**条目**：只动承载退役 id 的那一条，同组的其它子条目一字不动。
   */
  internal fun repairRetiredDisabledRows(
    liveText: String,
    retired: Set<String> = RETIRED_DISABLED_ROW_IDS,
  ): Result {
    if (liveText.isBlank() || retired.isEmpty()) return Result(liveText, emptyList())
    val changes = ArrayList<String>()
    val sb = StringBuilder(liveText.length)
    for (block in parseBlocks(liveText)) {
      var out: String? = null
      val hits = block.entries.filter { it.id in retired }
      if (hits.isNotEmpty()) {
        val replacements = HashMap<Int, String>()
        val drops = HashSet<Int>()
        for ((index, entry) in block.entries.withIndex()) {
          if (entry.id !in retired) continue
          val fragment = lineRange(block.lines, entry.startLine, entry.endLine)
          val cleaned = removeDisabledTrue(fragment, entry.indent.length + 2)
          if (cleaned == fragment) continue
          val stripped = dropIfActionless(cleaned)
          if (stripped != null) replacements[index] = stripped else drops += index
        }
        if (replacements.isNotEmpty() || drops.isNotEmpty()) {
          changes += "移除退役行的 disabled 残留: " + hits.joinToString(",") { it.id }
          out = rewriteBlock(block, replacements, drops)
        }
      }
      sb.append(out ?: block.text)
    }
    return Result(sb.toString(), changes)
  }

  // ── 块级工具（对外沿用） ────────────────────────────────────────────────────

  /**
   * 顶层 `- ` 列表块切分（含块前紧邻的注释/空行前导；非列表行归入下一个块的前导）。
   *
   * 按**位置**逐行切分而不是 `lineSequence() + '\n'`：后者对以换行结尾的文本会多出一个
   * 幻影空行（Kotlin split 保留尾随空串），使「块拼接」不等于原文——本函数现在承担全文
   * 重建（不再只用于追加），必须逐字节保真，否则无改动的文件也会被重写。
   *
   * 切分判据 = **列 0 的** `-`（后跟空白或行尾）。裸 `-` 是合法列表项；tab 缩进的 `- id:`
   * 属于组内子条目，不得被当成顶层项（旧判据只认 `- `，漏掉裸 `-`，会把两个块并成一个）。
   */
  internal fun topLevelBlocks(text: String): List<String> = parseBlocks(text).map { it.text }

  /**
   * 块内全部**条目** id（顶层条目 + insert 组一层子条目）。
   *
   * 0.14.2（D10）：不再用无限缩进匹配——配置块内的 `id:`（`llm-pi-ai` 的
   * 36 个模型 id、`llm-deepseek` 的模型表…）不是条目，把它们算进来会稀释派生判据：
   * 既让「块内只有 1 个 id」的 disabled 归属判断失效，也让追加判据把「配置里提过」当成「条目已在场」。
   */
  internal fun blockIds(block: String): List<String> = parseBlocks(block).flatMap { b -> b.entries.map { it.id } }

  /** 块内 `disabled:` 的字面值；无该键时 null。 */
  internal fun disabledValue(block: String): Boolean? =
    DISABLED_LINE.find(block)?.groupValues?.get(2)?.toBoolean()

  // ── 解析 ────────────────────────────────────────────────────────────────────

  /** 逐行切分（保留行尾换行；末行可无换行）。 */
  private fun splitLines(text: String): List<String> {
    val out = ArrayList<String>()
    var start = 0
    while (start < text.length) {
      val nl = text.indexOf('\n', start)
      if (nl < 0) {
        out += text.substring(start)
        break
      }
      out += text.substring(start, nl + 1)
      start = nl + 1
    }
    return out
  }

  private fun lineRange(lines: List<String>, from: Int, to: Int): String =
    if (from >= to) "" else lines.subList(from, to).joinToString("")

  /** 文本是否为显式空序列（`[]`，可带首尾空白）。 */
  private fun isEmptySequence(text: String): Boolean = text.trim() == "[]"

  /** 解析为块 + 条目。 */
  private fun parseBlocks(text: String): List<Block> {
    if (text.isEmpty()) return emptyList()
    val lines = splitLines(text)
    val blocks = ArrayList<Block>()
    var current = ArrayList<String>()
    for (line in lines) {
      if (TOP_ITEM.containsMatchIn(line)) {
        if (current.isNotEmpty()) {
          blocks += buildBlock(current)
          current = ArrayList()
        }
      }
      current += line
    }
    if (current.isNotEmpty()) blocks += buildBlock(current)
    return blocks
  }

  private fun buildBlock(lines: List<String>): Block {
    val text = lines.joinToString("")
    var head = -1
    for (index in lines.indices) if (TOP_ITEM.containsMatchIn(lines[index])) { head = index; break }
    if (head < 0) return Block(text, lines, false, "", emptyList())
    val isInsert = TOP_INSERT.containsMatchIn(lines[head])
    val entries = ArrayList<Entry>()
    var childIndent = ""
    if (isInsert) {
      // 一层子条目 = 组内**最浅缩进**的条目行；配置块内更深的 id 不属于条目。
      val candidates = ArrayList<Pair<Int, MatchResult>>()
      for (index in head + 1 until lines.size) {
        val m = CHILD_ID.find(lines[index]) ?: continue
        candidates += index to m
      }
      val minIndent = candidates.minOfOrNull { it.second.groupValues[1].length }
      if (minIndent != null && minIndent > 0) {
        val layer = candidates.filter { it.second.groupValues[1].length == minIndent }
        childIndent = layer[0].second.groupValues[1]
        for ((position, pair) in layer.withIndex()) {
          val end = if (position + 1 < layer.size) layer[position + 1].first else lines.size
          entries += Entry(pair.second.groupValues[2], childIndent, pair.first, end)
        }
      }
    } else {
      TOP_ID.find(lines[head])?.let { entries += Entry(it.groupValues[1], "", head, lines.size) }
      if (entries.isEmpty() && lines[head].trimEnd('\r').trim() == "-") {
        // 裸 `-` 顶层项（键在同一项的后续缩进行上）：取块内最浅缩进的 `id:` 行。
        var keyIndent: String? = null
        var keyId: String? = null
        for (index in head + 1 until lines.size) {
          val m = KEY_ID.find(lines[index]) ?: continue
          val width = m.groupValues[1].length
          if (width == 0) continue
          if (keyIndent == null || width < keyIndent.length) {
            keyIndent = m.groupValues[1]
            keyId = m.groupValues[2]
          }
        }
        if (keyIndent != null && keyId != null) entries += Entry(keyId, "", head, lines.size)
      }
    }
    return Block(text, lines, isInsert, childIndent, entries)
  }

  // ── 单块纠正 ────────────────────────────────────────────────────────────────

  private fun reconcileBlock(
    block: Block,
    factoryDisabled: Map<String, Boolean>,
    factoryEntryIds: Set<String>,
    retired: Set<String>,
  ): ReconcileResult {
    if (block.entries.isEmpty()) return ReconcileResult(block.text, emptyList(), emptySet())
    val replacements = HashMap<Int, String>()
    val drops = HashSet<Int>()
    val changes = ArrayList<String>()
    val droppedIds = HashSet<String>()
    for ((index, entry) in block.entries.withIndex()) {
      val fragment = lineRange(block.lines, entry.startLine, entry.endLine)
      val keyIndent = entry.indent.length + 2
      // 1) 工厂对同 id 有显式 disabled 语义：以工厂为准（条目内其它内容保留）。
      val want = factoryDisabled[entry.id]
      if (want != null) {
        if (disabledAtIndent(fragment, keyIndent) != want) {
          replacements[index] = setDisabledValue(fragment, entry.indent + "  ", want)
          changes += "disabled 标记按工厂语义纠正: " + entry.id + " -> " + want
        }
        continue
      }
      // 2) 退役行：工厂已不再提及该 id，清掉残留的 disabled: true（仅 true，不动用户显式 false）。
      if (entry.id in retired && entry.id !in factoryEntryIds) {
        val cleaned = removeDisabledTrue(fragment, keyIndent)
        if (cleaned != fragment) {
          changes += "移除退役行的 disabled 残留: " + entry.id
          val stripped = dropIfActionless(cleaned)
          if (stripped != null) {
            replacements[index] = stripped
          } else {
            drops += index
            droppedIds += entry.id
            changes += "删除只剩 id 的空块: " + entry.id
          }
        }
      }
    }
    if (replacements.isEmpty() && drops.isEmpty()) return ReconcileResult(block.text, emptyList(), emptySet())
    return ReconcileResult(rewriteBlock(block, replacements, drops), changes, droppedIds)
  }

  /** 按条目级替换重写块原文；未列出的片段一律 append 原文（逐字节保真）。 */
  private fun rewriteBlock(block: Block, replacements: Map<Int, String>, drops: Set<Int>): String {
    val sb = StringBuilder(block.text.length + 64)
    var line = 0
    for ((index, entry) in block.entries.withIndex()) {
      if (line < entry.startLine) {
        sb.append(lineRange(block.lines, line, entry.startLine))
        line = entry.startLine
      }
      if (index in drops) {
        // 整条删除：连同紧跟其后的空行一起吃掉，避免留下连续空行。
        var end = entry.endLine
        while (end < block.lines.size && block.lines[end].isBlank()) end++
        line = end
        continue
      }
      val replacement = replacements[index]
      if (replacement != null) sb.append(replacement)
      else sb.append(lineRange(block.lines, entry.startLine, entry.endLine))
      line = entry.endLine
    }
    if (line < block.lines.size) sb.append(lineRange(block.lines, line, block.lines.size))
    return sb.toString()
  }

  /** 条目自身层级的 `disabled` 值（缩进必须等于键缩进；配置块内更深的同名键不算）。 */
  private fun disabledAtIndent(fragment: String, keyIndent: Int): Boolean? {
    for (line in fragment.split("\n")) {
      val m = ENTRY_DISABLED.find(line.trimEnd('\r')) ?: continue
      if (m.groupValues[1].length == keyIndent) return m.groupValues[2].toBoolean()
    }
    return null
  }

  /** 条目内带 `disabled` 的工厂语义值（首处命中即返回）。 */
  private fun disabledOfEntry(block: Block, entry: Entry): Boolean? =
    disabledAtIndent(lineRange(block.lines, entry.startLine, entry.endLine), entry.indent.length + 2)

  /** 在条目片段内按工厂值改写/补写 `disabled:` 行（无该键则插到 id 行之后，缩进 = [keyIndent]）。 */
  private fun setDisabledValue(fragment: String, keyIndent: String, want: Boolean): String {
    val lines = fragment.split("\n").toMutableList()
    for ((index, raw) in lines.withIndex()) {
      val cr = raw.endsWith("\r")
      val line = if (cr) raw.dropLast(1) else raw
      val m = ENTRY_DISABLED.find(line) ?: continue
      if (m.groupValues[1].length != keyIndent.length) continue
      val eolMarker = if (cr) "\r" else ""
      lines[index] = keyIndent + "disabled: " + want + eolMarker
      return lines.joinToString("\n")
    }
    // 无该键：插到条目 id 行之后（顶层条目 = 块首 id 行；子条目 = 子条目 id 行）。
    for ((index, raw) in lines.withIndex()) {
      val cr = raw.endsWith("\r")
      val line = if (cr) raw.dropLast(1) else raw
      val isEntryIdLine = TOP_ID.containsMatchIn(line) || CHILD_ID.containsMatchIn(line)
      if (!isEntryIdLine) continue
      val crMarker = if (cr) "\r" else ""
      val head = lines.subList(0, index + 1).joinToString("\n")
      val rest = lines.subList(index + 1, lines.size).joinToString("\n")
      val inserted = keyIndent + "disabled: " + want + crMarker + "\n"
      return if (rest.isEmpty()) head + "\n" + inserted else head + "\n" + inserted + rest
    }
    return fragment
  }

  /**
   * 删除条目片段内**属于该条目自身层级**的 `disabled: true` 行（按 id 粒度，不越权到更深层级）。
   */
  private fun removeDisabledTrue(fragment: String, keyIndent: Int): String {
    val lines = fragment.split("\n")
    val kept = ArrayList<String>(lines.size)
    for (raw in lines) {
      val cr = raw.endsWith("\r")
      val line = if (cr) raw.dropLast(1) else raw
      val m = ENTRY_DISABLED.find(line)
      if (m != null && m.groupValues[1].length == keyIndent && m.groupValues[2] == "true") continue
      kept += raw
    }
    return kept.joinToString("\n")
  }

  /** 去掉 disabled 行后是否只剩 id/注释/空行（是则整条可删，避免留下无动作的 patch 条目）。 */
  private fun dropIfActionless(block: String): String? {
    val hasAction = block.lineSequence().any { line ->
      val t = line.trim()
      when {
        t.isEmpty() || t.startsWith("#") -> false
        // `- insert:` / `name:` 是动作（挂载/装配），不得因去 disable 而整条消失。
        t == "insert:" || t.startsWith("- insert:") -> true
        // 纯 id 行不是动作——退役行的典型形态就是「只有 id + disabled」。
        PURE_ID_LINE.containsMatchIn(t) -> false
        else -> true
      }
    }
    return if (hasAction) block else null
  }

  /**
   * 把条目片段按**锚点 id**插进 live 的 insert 组（锚点 = 其后应出现该新条目的已在场兄弟）；
   * 锚点为 null 时追加到组尾。锚点找不到（已被删/拼写不同）时退化为组尾，不丢内容。
   *
   * @param blockText live 中宿主 insert 组的原文。
   * @param additions 锚点 id（null = 组尾）到待插入片段（已按宿主缩进）。
   * @returns 插入后的块原文（原文其它片段逐字节保留）。
   */
  private fun insertIntoGroup(blockText: String, additions: List<Pair<String?, String>>): String {
    if (additions.isEmpty()) return blockText
    val block = parseBlocks(blockText).firstOrNull() ?: return blockText
    if (block.entries.isEmpty()) return blockText
    val beforeLine = HashMap<Int, StringBuilder>()
    val tail = StringBuilder()
    for ((anchor, fragment) in additions) {
      val target = if (anchor == null) null else block.entries.firstOrNull { it.id == anchor }
      if (target == null) tail.append(fragment) else beforeLine.getOrPut(target.startLine) { StringBuilder() }.append(fragment)
    }
    val sb = StringBuilder(blockText.length + 128)
    var line = 0
    for (entry in block.entries) {
      if (line < entry.startLine) {
        sb.append(lineRange(block.lines, line, entry.startLine))
        line = entry.startLine
      }
      beforeLine[entry.startLine]?.let { sb.append(it) }
      sb.append(lineRange(block.lines, entry.startLine, entry.endLine))
      line = entry.endLine
    }
    if (line < block.lines.size) sb.append(lineRange(block.lines, line, block.lines.size))
    sb.append(tail)
    return sb.toString()
  }

  /** 把 live 块索引按「包含最多 [matched] id」选出（平局取首个）；无命中返回 -1。 */
  private fun pickHostBlock(resolved: List<String>, liveBlocks: List<Block>, matched: List<String>): Int {
    var best = -1
    var bestHits = 0
    for (index in liveBlocks.indices) {
      val ids = blockIds(resolved[index]).toHashSet()
      val hits = matched.count { it in ids }
      if (hits > bestHits) {
        best = index
        bestHits = hits
      }
    }
    return best
  }

  /** 把工厂子条目片段从 [fromIndent] 重新缩进到 [toIndent]（仅前导缩进，内容原样）。 */
  private fun reindent(fragment: String, fromIndent: String, toIndent: String): String {
    if (fromIndent == toIndent || fromIndent.isEmpty()) return fragment
    return fragment.split("\n").joinToString("\n") { line ->
      if (line.isEmpty()) line else toIndent + line.removePrefix(fromIndent)
    }
  }
}
