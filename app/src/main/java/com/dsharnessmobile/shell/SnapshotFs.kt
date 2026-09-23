package com.dsharnessmobile.shell

import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.attribute.BasicFileAttributes

/**
 * Symbolic-link-safe filesystem primitives shared by the snapshot transaction and
 * the legacy user-data recovery. Every helper here is deliberately NOFOLLOW: a
 * dangling link inside the runtime tree is ordinary upgrade residue and must never
 * be resolved into the live tree, and a recursive delete must never escape through
 * a link into user data.
 */
internal object SnapshotFs {

  /** Existence without following a symbolic link. */
  fun exists(file: File): Boolean = Files.exists(file.toPath(), NOFOLLOW_LINKS)

  /** True when [file] is a symbolic link, dangling or not. */
  fun isSymbolicLink(file: File): Boolean = Files.isSymbolicLink(file.toPath())

  /**
   * Deletes a file, directory or link without following links.
   *
   * 逐项容错（0.14.0 模拟器实锤）：**一个删不掉的条目曾让整个快照刷新永久卡死**。
   * 现象：模拟器异常掉线时解压中断，留下 `.snapshot-stage/home`；该目录的内部元数据损坏，
   * `ls` 看是空的、`rm -rf` 与 `rmdir` 都删不掉（\`Not a data message\` ／ \`Directory not empty\`）。
   * 而本方法是 refreshSnapshot 的第一步（清理上次残留），它一抛异常就：
   *   ① 本次刷新失败；② 回滚也走同一方法 → **回滚同样失败**（实测日志：
   *   \`snapshot refresh rollback failed; recovery marker retained\`）；
   *   ③ 残留永远存在 ⇒ **之后每次启动都失败**，用户只能清应用数据。
   *
   * 因此这里不能「遇到坏条目就整体失败」：能删的必须删掉，删不掉的**如实记下并继续**，
   * 由调用方决定是否致命。清理阶段的残余不影响后续解压到干净的 staging 目录——
   * 反过来，因一个残余就让整条升级链永久瘫痪，是远比残留更严重的问题。
   *
   * **容错契约的覆盖面（0.14.1 加固，issue #240 的剩余缺口）**：本方法同时是刷新的第一步
   * （`EngineManager` 清理残留）与回滚路径的公共原语（`SnapshotTransaction.rollbackEntry`），
   * 而此前这里只兜 `Exception`。issue #240 现场那个形状正是「`Error` 打穿整条链」：
   * `NoSuchMethodError`（`Stream.toList()` 在 API < 34 上的形态）是 `Error` 而非 `Exception`，
   * 它既绕过本方法的逐项容错，又绕过 `EngineManager` 紧随其后的「残渣改名挪开」兜底，
   * 一路打穿到刷新失败的 `catch (t: Throwable)` 去走回滚——而回滚走的是同一个原语。
   * 故判定交给 [isTolerableDeletionFailure]：**容忍 `Exception` + `LinkageError`，重抛 `VirtualMachineError`**。
   * 不写成裸 `catch (Throwable)` 是刻意的：`OutOfMemoryError` / `StackOverflowError` 在一个递归删除里
   * 被降级成「继续删」只会放大失败，那不是容错而是掩盖。
   *
   * @param onFailure 单条删除失败时的回调（收集诊断用）；不抛异常。签名收 `Throwable`——
   *   被上报的失败不再限于 `Exception`（见上）。**刻意放在最后一个参数**：本仓既有调用点
   *   一律写作 `deletePath(x) { f, e -> … }` 的尾随 lambda 形式（EngineManager 与各单测共 5 处），
   *   放在最后才能继续绑定到它、不逼着所有调用点改名传参。
   * @param listChildren 列目录的实现。默认即生产用法（`newDirectoryStream` + Kotlin stdlib 的
   *   `toList()`，**无 API 级别依赖**）。显式传参是为了让「列目录时抛 `Error`」这种场景能在
   *   JVM 单测里**行为对照**地判红，而不是只能靠静态扫描（本仓纪律：测试改为显式传参，
   *   生产面不留测试缝）。
   */
  fun deletePath(
    path: File,
    listChildren: (Path) -> List<Path> = { dir -> Files.newDirectoryStream(dir).use { it.toList() } },
    onFailure: (File, Throwable) -> Unit = { _, _ -> },
  ) {
    val nioPath = path.toPath()
    try {
      if (!Files.exists(nioPath, NOFOLLOW_LINKS)) return
      val attrs = Files.readAttributes(nioPath, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
      if (attrs.isDirectory) {
        // 目录项本身读取失败（元数据损坏）也由下面的兜底接住：记下并跳过，不中断整棵树。
        // 注意 `Files.newDirectoryStream` 而非 `Files.list`：后者返回的 Stream 是 Java 16 /
        // Android API 34 才有的面，在 API < 34 上列目录本身就抛 `NoSuchMethodError`
        // （0.14.1 P0 真机实锤，本方法历史上正是崩在这里）。
        for (child in listChildren(nioPath)) deletePath(child.toFile(), listChildren, onFailure)
      }
      Files.deleteIfExists(nioPath)
    } catch (t: Throwable) {
      // 非容忍类（VirtualMachineError / ThreadDeath / AssertionError …）必须原样抛出：
      // 把它们降级成「继续删」等于用一个更坏的失败掩盖当前失败。
      if (!isTolerableDeletionFailure(t)) throw t
      onFailure(path, t)
    }
  }

  /** Rename within one filesystem; falls back to a plain move when ATOMIC_MOVE is unsupported. */
  fun move(source: File, destination: File) {
    destination.parentFile?.let { Files.createDirectories(it.toPath()) }
    try {
      Files.move(source.toPath(), destination.toPath(), ATOMIC_MOVE)
    } catch (_: AtomicMoveNotSupportedException) {
      Files.move(source.toPath(), destination.toPath())
    }
  }

  /**
   * 目录字节数（**不跟随符号链接**：快照树里有大量指向同树的链，跟随会把体积算成几倍）。
   * 用于交换前的空间断言（审查 §7.2-F-4）。不可读的条目按 0 计（宁可低估也不抛）。
   */
  fun sizeOf(dir: File): Long {
    if (!exists(dir)) return 0L
    if (isSymbolicLink(dir)) return 0L
    if (dir.isFile) return dir.length()
    var total = 0L
    val children = dir.listFiles() ?: return 0L
    for (child in children) total += sizeOf(child)
    return total
  }

  fun createDirectories(dir: File) {
    Files.createDirectories(dir.toPath())
  }
}

/**
 * 删除路径的容错边界：哪些 `Throwable` 可以「记下并继续」，哪些必须原样抛出。
 *
 * 策略只声明一处，便于单测逐条钉住（`SnapshotFsTest`）。**不写成裸 `catch (Throwable)`**：
 *
 *  - `Exception` —— 既有的容错面（元数据损坏的目录、EACCES、并发删除等），保持原语义。
 *  - `LinkageError` —— 0.14.1 加固的核心。缺 API 的类错误全在这一支：
 *    `NoSuchMethodError`（`Stream.toList()` 在 API < 34 上）、`NoClassDefFoundError`、
 *    `IncompatibleClassChangeError`。issue #240 现场正是被这一类打穿整条刷新+回滚链。
 *  - `VirtualMachineError` —— **必须重抛**。`OutOfMemoryError` / `StackOverflowError` 出现在一个
 *    递归删除里时，「继续删下一个」只会让已经耗尽的资源继续被消耗，把一次可诊断的失败
 *    放大成一片静默的坏状态。同理 `ThreadDeath` / `AssertionError` 等其余 `Error` 也一律重抛：
 *    非 `LinkageError` 的 `Error` 表示 JVM 层已经不可信，不是「某个条目删不掉」。
 */
internal fun isTolerableDeletionFailure(t: Throwable): Boolean = when (t) {
  is VirtualMachineError -> false
  is Exception -> true
  is LinkageError -> true
  else -> false
}
