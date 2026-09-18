package com.dsharnessmobile.shell

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import rikka.shizuku.Shizuku
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * App-side lifecycle owner for the Shizuku UserService.
 *
 * The manager application remains the only authority that can grant Shizuku permission. This class
 * may request its standard confirmation from an explicit user action but never treats the request
 * as a grant. WebView/engine code gets no raw binder and no arbitrary shell surface.
 */
object ShizukuTransport {
  private const val TAG = "dsh-shizuku"
  private const val REQUEST_CODE_VDISPLAY = 0xD514
  private const val USER_SERVICE_TAG = "dsh-mobile-vdisplay-v1"
  /** 单次 latch 等待片（保持既有 4s 语义：到点先复用/汇报，不无限阻塞调用方）。 */
  private const val BIND_TIMEOUT_MS = 4_000L
  /**
   * 首次绑定允许等待的**总预算**（0.14.0 设备实锤修正）。
   *
   * 缺陷形态：`ensureBound()` 只 await 一片 4s 就返回，而 `Shizuku.bindUserService` 在真机/模拟器上
   * 实测要 5s 量级才回调 `onServiceConnected`。于是**同一条命令第一次必然报「通道失败」、第二次必然成功**——
   * 那不是「Shizuku 抖动」，是状态机时序的确定结果。设备会话实录里 agent 因此判定特权通道不可靠、
   * 转投 Termux 通道，又撞上该通道的环境缺陷，两个缺陷串联把整条链路打崩。
   *
   * 现在在预算内循环等待：绑定完成即返回，超预算才如实汇报「正在建立」并给出可重试建议。
   */
  private const val BIND_TOTAL_MS = 15_000L

  /** 「正在建立连接」的结构化 code（可重试语义，与「未绑定需排查」区分）。 */
  private const val CONNECTING_CODE = "shizuku-user-service-connecting"

  private val lock = Any()
  @Volatile private var service: ShizukuUserService? = null
  @Volatile private var binding = false
  @Volatile private var lastError = "shizuku-user-service-not-bound"
  @Volatile private var connectedAt = 0L
  private var bindLatch: CountDownLatch? = null

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, binder: IBinder) {
      service = ShizukuUserService.Stub.asInterface(binder)
      binding = false
      connectedAt = SystemClock.elapsedRealtime()
      lastError = if (binder.pingBinder()) "" else "shizuku-user-service-invalid-binder"
      bindLatch?.countDown()
      // 连接已建立，latch 使命完成：清空以便断连后重建。留着它会让下一次 ensureBound 的
      // await 立即返回、永远看不到新的等待窗口（本缺陷的根因形态）。
      bindLatch = null
      Log.i(TAG, "user service connected ${name.className}")
    }

    override fun onServiceDisconnected(name: ComponentName) {
      service = null
      binding = false
      lastError = "shizuku-user-service-disconnected"
      bindLatch?.countDown()
      // 断连后旧 latch 已经 countDown、语义作废；清掉它，下一次 ensureBound 才会新建并真正等待。
      // 复用已放行的 latch 会让 await 立即返回 → 又变成「第一次必失败」，正是本缺陷的成因。
      bindLatch = null
      Log.w(TAG, "user service disconnected ${name.className}")
    }
  }

  private fun args(context: Context): Shizuku.UserServiceArgs = Shizuku.UserServiceArgs(
    ComponentName(context.packageName, ShizukuUserServiceBridge::class.java.name),
  )
    .daemon(false)
    .tag(USER_SERVICE_TAG)
    .processNameSuffix("dsh-vdisplay")
    .debuggable(BuildConfig.DEBUG)
    .version(BuildConfig.VERSION_CODE)

  /** Stable JSON state suitable for the native bridge and VirtualDisplay controller. */
  fun status(context: Context): JSONObject {
    val out = JSONObject().put("installed", installed(context))
    val running = runCatching { Shizuku.pingBinder() }.getOrDefault(false)
    out.put("running", running)
    out.put("granted", false)
    out.put("bound", service?.asBinder()?.pingBinder() == true)
    out.put("userServiceAgeMs", if (connectedAt > 0L) SystemClock.elapsedRealtime() - connectedAt else -1)

    if (!out.optBoolean("installed")) {
      return out.put("ok", false).put("code", "shizuku-absent")
        .put("guidance", "未检测到 Shizuku；虚拟屏需要用户安装、启动并授权 Shizuku。")
    }
    if (!running) {
      return out.put("ok", false).put("code", "shizuku-not-running")
        .put("guidance", "Shizuku 已安装但服务未运行。非 root 设备可通过 USB/有线 ADB 或无线调试启动它；重启设备后需再次启动。")
    }

    val version = runCatching { Shizuku.getVersion() }.getOrDefault(-1)
    val uid = runCatching { Shizuku.getUid() }.getOrDefault(-1)
    out.put("version", version).put("uid", uid)
    if (version < 12) {
      return out.put("ok", false).put("code", "shizuku-prev11")
        .put("guidance", "Shizuku 版本过低，虚拟屏需要 v12 及以上的 UserService 支持。")
    }

    val granted = runCatching {
      Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    }.getOrDefault(false)
    out.put("granted", granted)
    if (!granted) {
      return out.put("ok", false).put("code", "shizuku-denied")
        .put("guidance", "尚未获得 Shizuku 授权。点击创建虚拟屏后会由 Shizuku 管理器显示用户确认；DSH 不会自行授予权限。")
    }
    if (service?.asBinder()?.pingBinder() != true) {
      return out.put("ok", false).put("code", lastError.ifBlank { "shizuku-user-service-not-bound" })
        .put("guidance", "Shizuku 已授权，正在建立 shell UserService；请稍候重试。")
    }
    return out.put("ok", true).put("code", "shizuku-ready")
      .put("guidance", "Shizuku shell UserService 已就绪（uid=$uid）。")
  }

  /**
   * 非阻塞「催一下」：已装 + 已运行 + 已授权但尚未绑定时，在后台发起一次 UserService 绑定。
   *
   * 为什么需要它（0.14.0 设备实锤缺陷）：status() 是**纯读**且不得阻塞（它在控制队列与 UI
   * 轮询路径上被高频调用，绝不能等 binder）。但设置页「刷新 Shizuku 状态」与面板的
   * vdisplayStatus 轮询走的正是 status()——此前唯一会发起绑定的是建屏路径的 ensureBound()，
   * 于是「用户已授权、Shizuku 在运行」的机器上，那条 UI 路径**无论刷新多少次都不会建连**，
   * 永远停在 shizuku-user-service-not-bound（用户实测「会一直卡在这」）。
   *
   * 这里把绑定动作与读取动作解耦：读路径只负责**触发**一次后台绑定并立即返回当前状态，
   * 真正的等待交给下一次轮询（2s）自然收敛。绑定成功后 status() 会如实报 ok=true。
   */
  fun kickBind(context: Context) {
    val app = context.applicationContext
    val current = status(app)
    if (!current.optBoolean("installed") || !current.optBoolean("running")) return
    if (!current.optBoolean("granted")) return
    if (current.optBoolean("bound")) return
    // 已有绑定在飞（binding=true）时不重复发起——Shizuku.bindUserService 幂等但没必要抖动。
    if (binding) return
    Thread({
      runCatching { ensureBound(app) }.onFailure {
        Log.w(TAG, "background bind failed: " + it.javaClass.simpleName + ": " + (it.message ?: ""))
      }
    }, "dsh-shizuku-kick").start()
  }

  /** Establish the UserService on an explicit user action. */
  fun ensureBound(context: Context): JSONObject {
    val before = status(context)
    if (!before.optBoolean("installed") || !before.optBoolean("running")) return before
    if (!before.optBoolean("granted")) {
      val requested = runCatching {
        if (!Shizuku.shouldShowRequestPermissionRationale()) Shizuku.requestPermission(REQUEST_CODE_VDISPLAY)
        true
      }.getOrDefault(false)
      return status(context)
        .put("requested", requested)
        .put("code", if (requested) "shizuku-permission-requested" else "shizuku-denied")
        .put("guidance", "已向 Shizuku 发起授权请求；请在其系统确认页批准后再次点击创建虚拟屏。")
    }
    if (service?.asBinder()?.pingBinder() == true) return status(context)

    val deadline = SystemClock.elapsedRealtime() + BIND_TOTAL_MS
    while (true) {
      val latch: CountDownLatch
      synchronized(lock) {
        if (service?.asBinder()?.pingBinder() == true) return status(context)
        latch = bindLatch ?: CountDownLatch(1).also { bindLatch = it }
        if (!binding) {
          binding = true
          lastError = CONNECTING_CODE
          try {
            Shizuku.bindUserService(args(context.applicationContext), connection)
          } catch (t: Throwable) {
            binding = false
            lastError = "shizuku-user-service-bind-failed:${t.javaClass.simpleName}"
            // 发起就抛异常：latch 永不会因回调而放行，必须换新的，否则后续调用会永远复用一个死 latch。
            bindLatch = null
            latch.countDown()
          }
        }
      }
      if (service?.asBinder()?.pingBinder() == true) return status(context)
      val remaining = deadline - SystemClock.elapsedRealtime()
      if (remaining <= 0L) break
      // 到点即复用当次结果，不把 4s 片拉长到整段预算——调用方的超时语义不变。
      latch.await(minOf(BIND_TIMEOUT_MS, remaining), TimeUnit.MILLISECONDS)
      if (service?.asBinder()?.pingBinder() == true) return status(context)
      if (!binding) {
        // 回调已发生但服务仍不可用（invalid-binder / disconnected）：不要继续等，如实汇报。
        break
      }
    }
    // 预算耗尽且仍在连接中：给出「可重试」而不是「去设置页排查」。区分这两者是本缺陷的核心。
    return if (binding) {
      status(context).put("code", CONNECTING_CODE).put("retryAfterMs", BIND_TIMEOUT_MS)
        .put("guidance", "Shizuku shell 通道正在建立（通常几秒内完成）；请稍候直接重试同一命令，无需去设置页排查。")
    } else {
      status(context)
    }
  }

  /** Native-only fixed argv execution. Never pass user/model-controlled shell text here. */
  fun runController(context: Context, argv: Array<String>): JSONObject {
    val ready = ensureBound(context)
    if (!ready.optBoolean("ok")) return ready
    val remote = service ?: return status(context)
      .put("ok", false).put("code", "shizuku-user-service-not-bound")
    return try {
      val result = remote.exec(argv, 8_000)
      JSONObject()
        .put("ok", result.getBoolean("ok"))
        .put("exitCode", result.getInt("exitCode"))
        .put("stdout", result.getString("stdout"))
        .put("error", result.getString("error"))
    } catch (t: Throwable) {
      status(context).put("ok", false).put("code", "shizuku-command-failed")
        .put("guidance", t.javaClass.simpleName + ": " + (t.message ?: ""))
    }
  }

  fun identity(context: Context): JSONObject {
    val ready = ensureBound(context)
    if (!ready.optBoolean("ok")) return ready
    return try {
      val remote = service ?: return JSONObject().put("ok", false).put("code", "shizuku-user-service-not-bound")
      JSONObject().put("ok", true).put("uid", remote.uid()).put("protocolVersion", remote.protocolVersion())
    } catch (t: Throwable) {
      JSONObject().put("ok", false).put("code", "shizuku-identity-failed")
        .put("guidance", t.javaClass.simpleName + ": " + (t.message ?: ""))
    }
  }

  // ── 0.14.0 特权 shell 通道（替换退役的内置 adb：execAdbShell / execAdbLine 的壳侧执行面） ──────

  /** 单次 shell 调用默认 / 上限超时（§6「放宽超时」；旧 adb 路径为 8s 级）。 */
  private const val SHELL_TIMEOUT_MS = 20_000
  private const val MAX_SHELL_TIMEOUT_MS = 120_000
  private const val PULL_CHUNK = 512 * 1024
  private const val MAX_TRANSFER_BYTES = 512L * 1024 * 1024
  private const val SHELL_PATH_PREFIX = "export PATH=/system/bin:/system/xbin:\$PATH; "

  /** v2 协议面就绪判定：返回 (service, refusal)——refusal 非空即结构化拒绝，调用方直接透传。 */
  private fun readyService(context: Context): Pair<ShizukuUserService?, JSONObject?> {
    val ready = ensureBound(context)
    if (!ready.optBoolean("ok")) return null to ready
    val remote = service
    if (remote == null || remote.asBinder()?.pingBinder() != true) {
      return null to status(context).put("ok", false).put("code", "shizuku-user-service-not-bound")
    }
    val pv = runCatching { remote.protocolVersion() }.getOrDefault(-1)
    if (pv < 2) {
      return null to JSONObject().put("ok", false).put("code", "shizuku-user-service-too-old")
        .put("protocolVersion", pv)
        .put("guidance", "Shizuku UserService 协议为 v$pv，本机需要 v2（0.14.0 大输出 / 文件取回面）；" +
          "在设置页「手机控制」重新连接 Shizuku 会重启 UserService（无需重装）。")
    }
    return remote to null
  }

  /**
   * 特权 shell 执行（uid 2000）：`sh -c <command>`，PATH 前置系统目录（F3 远端 PATH 污染修复同源）。
   * capture=true 时大输出落 shell 侧 spool 文件，只回报前 8 KiB 与文件坐标（filePath/size）。
   */
  fun runShell(context: Context, command: String, timeoutMs: Int = SHELL_TIMEOUT_MS, capture: Boolean = false): JSONObject {
    if (command.isBlank()) {
      return JSONObject().put("ok", false).put("code", "shell-empty").put("guidance", "空命令")
    }
    val (remote, refusal) = readyService(context)
    if (remote == null) return refusal ?: unavailableShell()
    val timeout = timeoutMs.coerceIn(1_000, MAX_SHELL_TIMEOUT_MS)
    val argv = arrayOf("sh", "-c", SHELL_PATH_PREFIX + command)
    return try {
      if (capture) {
        val b = remote.execCapture(argv, timeout, 8 * 1024)
        JSONObject()
          .put("ok", b.getBoolean("ok"))
          .put("exitCode", b.getInt("exitCode"))
          .put("stdout", String(b.getByteArray("inline") ?: ByteArray(0), Charsets.UTF_8))
          .put("size", b.getLong("size"))
          .put("truncated", b.getBoolean("truncated"))
          .put("filePath", b.getString("path") ?: "")
          .put("error", b.getString("error") ?: b.getString("readError") ?: "")
      } else {
        val b = remote.exec(argv, timeout)
        JSONObject()
          .put("ok", b.getBoolean("ok"))
          .put("exitCode", b.getInt("exitCode"))
          .put("stdout", b.getString("stdout") ?: "")
          .put("error", b.getString("error") ?: "")
      }
    } catch (t: Throwable) {
      shellFailure(t)
    }
  }

  /** 远端 → 应用私有目录（files/...）分块取回（pull 语义）。 */
  fun pullFile(context: Context, remote: String, local: String): JSONObject {
    val target = engineLocalFile(context, local)
      ?: return JSONObject().put("ok", false).put("code", "shell-path-denied")
        .put("guidance", "本地落点必须是应用私有目录内的路径（files/...）：$local")
    if (!remote.startsWith("/")) {
      return JSONObject().put("ok", false).put("code", "shell-path-denied")
        .put("guidance", "远端路径必须是绝对路径：$remote")
    }
    val (remoteSvc, refusal) = readyService(context)
    if (remoteSvc == null) return refusal ?: unavailableShell()
    return try {
      target.parentFile?.mkdirs()
      var offset = 0L
      java.io.FileOutputStream(target).use { sink ->
        while (true) {
          val chunk = remoteSvc.readChunk(remote, offset, PULL_CHUNK) ?: return shellFailure(
            IllegalStateException("远端不可读（不存在或权限不足）：$remote"),
          )
          if (chunk.isEmpty()) break
          sink.write(chunk)
          offset += chunk.size
          if (offset > MAX_TRANSFER_BYTES) {
            return JSONObject().put("ok", false).put("code", "shell-output-too-large")
              .put("guidance", "远端文件超过 ${MAX_TRANSFER_BYTES / (1024 * 1024)} MiB 上限：$remote")
          }
        }
      }
      JSONObject().put("ok", true).put("code", "shell-ok")
        .put("localPath", target.absolutePath).put("path", target.absolutePath).put("size", offset)
    } catch (t: Throwable) {
      shellFailure(t)
    }
  }

  /** 应用私有目录（files/...）→ 远端分块写入（push 语义）。 */
  fun pushFile(context: Context, local: String, remote: String): JSONObject {
    val source = engineLocalFile(context, local)
      ?: return JSONObject().put("ok", false).put("code", "shell-path-denied")
        .put("guidance", "本地来源必须是应用私有目录内的路径（files/...）：$local")
    if (!remote.startsWith("/")) {
      return JSONObject().put("ok", false).put("code", "shell-path-denied")
        .put("guidance", "远端路径必须是绝对路径：$remote")
    }
    if (!source.isFile) {
      return JSONObject().put("ok", false).put("code", "shell-path-denied")
        .put("guidance", "本地文件不存在：$local")
    }
    if (source.length() > MAX_TRANSFER_BYTES) {
      return JSONObject().put("ok", false).put("code", "shell-output-too-large")
        .put("guidance", "本地文件超过 ${MAX_TRANSFER_BYTES / (1024 * 1024)} MiB 上限：$local")
    }
    val (remoteSvc, refusal) = readyService(context)
    if (remoteSvc == null) return refusal ?: unavailableShell()
    return try {
      var offset = 0L
      java.io.FileInputStream(source).use { input ->
        val buf = ByteArray(PULL_CHUNK)
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          val slice = if (n == buf.size) buf else buf.copyOf(n)
          val r = remoteSvc.writeChunk(remote, slice, offset > 0)
          if (!r.getBoolean("ok")) {
            return JSONObject().put("ok", false).put("code", "shell-write-failed")
              .put("guidance", "${r.getString("error") ?: "远端写入失败"}（$remote）")
          }
          offset += n
        }
      }
      JSONObject().put("ok", true).put("code", "shell-ok")
        .put("remotePath", remote).put("path", remote).put("size", offset)
    } catch (t: Throwable) {
      shellFailure(t)
    }
  }

  /** 远端删除（rm -f 语义；幂等）。 */
  fun removeRemote(context: Context, remote: String): JSONObject {
    if (!remote.startsWith("/")) {
      return JSONObject().put("ok", false).put("code", "shell-path-denied")
        .put("guidance", "远端路径必须是绝对路径：$remote")
    }
    val (remoteSvc, refusal) = readyService(context)
    if (remoteSvc == null) return refusal ?: unavailableShell()
    return try {
      val r = remoteSvc.removePath(remote)
      JSONObject().put("ok", r.getBoolean("ok")).put("code", if (r.getBoolean("ok")) "shell-ok" else "shell-remove-failed")
        .put("guidance", r.getString("error") ?: "")
        .put("remotePath", remote)
    } catch (t: Throwable) {
      shellFailure(t)
    }
  }

  /** 引擎相对路径（`files/...`）→ 应用私有目录内的绝对文件；越界一律拒绝（fail-closed）。 */
  private fun engineLocalFile(context: Context, raw: String): java.io.File? {
    if (raw.isBlank()) return null
    val f = if (raw.startsWith("/")) java.io.File(raw) else java.io.File(context.dataDir, raw)
    val canon = runCatching { f.canonicalFile }.getOrNull() ?: return null
    val root = runCatching { context.filesDir.canonicalFile }.getOrNull() ?: return null
    val rootPath = root.path
    return canon.takeIf { it.path == rootPath || it.path.startsWith(rootPath + java.io.File.separator) }
  }

  private fun shellFailure(t: Throwable): JSONObject = JSONObject()
    .put("ok", false)
    .put("code", "shell-transport-failed")
    .put("guidance", "Shizuku shell 通道失败：" + t.javaClass.simpleName + ": " + (t.message ?: ""))

  private fun unavailableShell(): JSONObject = JSONObject()
    .put("ok", false).put("code", "shizuku-user-service-not-bound")
    .put("guidance", "Shizuku shell 通道未就绪；请在设置页「手机控制」查看状态与引导。")

  @Suppress("DEPRECATION")
  private fun installed(context: Context): Boolean = runCatching {
    context.packageManager.getPackageInfo("moe.shizuku.privileged.api", 0)
    true
  }.getOrDefault(false)
}

