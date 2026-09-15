package com.dsharnessmobile.shell

import android.content.Context
import org.json.JSONObject

/**
 * vd* op 的统一分发：虚拟屏是 Shizuku 特权面，**不依赖无障碍服务**。
 *
 * 两处调用方：
 * - `DeviceControlService.handle`：六面登记链按行首引号解析分支名，分支必须留在 handle 里，
 *   实现委托到本对象（scripts/check-control-ops.mjs 的 A 项）；
 * - `ControlCarrier`：无障碍关闭时的承载者（队列由前台引擎服务持有）。
 */
internal object VdisplayOps {
  fun handle(context: Context, op: String, args: JSONObject): JSONObject = when (op) {
    "vdCreate" -> VdisplayController.create(context, args)
    "vdDestroy" -> VdisplayController.destroy(context, args)
    "vdLaunch" -> VdisplayController.launchSettingsProbe(context, args)
    "vdMoveTask" -> unsupported(op)
    "vdInfo" -> VdisplayController.status(context)
    else -> JSONObject()
      .put("__error", "未知虚拟屏操作 $op")
      .put("reason", "unknown-op")
      .put("op", op)
  }

  /** 已登记但壳侧尚未实现：fail-closed 的结构化拒绝（键位与旧 handle 实现逐字一致）。 */
  private fun unsupported(op: String): JSONObject = JSONObject()
    .put("__error", "暂不支持：$op（壳侧已登记、实现未落地——fail-closed 拒绝）")
    .put("reason", "unsupported")
    .put("op", op)
}
