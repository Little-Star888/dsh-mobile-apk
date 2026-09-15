package com.dsharnessmobile.shell

import android.content.Context

/**
 * User-owned model screen-access scope.
 *
 * This preference is deliberately native-owned: tool/model paths may read it for fail-closed
 * enforcement, but only the DSH settings UI invokes the bridge setter. Android display ids are not
 * stored here; stable product aliases express the user's permitted screen family.
 */
enum class ScreenScope(val wire: String) {
  VIRTUAL_ONLY("virtual-only"),
  REAL_ONLY("real-only"),
  ALL("all");

  /** Whether this user choice includes one stable product screen alias. */
  fun allows(screenId: String): Boolean = when (this) {
    VIRTUAL_ONLY -> screenId == ScreenTargets.VIRTUAL
    REAL_ONLY -> screenId == ScreenTargets.REAL
    ALL -> screenId == ScreenTargets.REAL || screenId == ScreenTargets.VIRTUAL
  }

  companion object {
    fun fromWire(value: String?): ScreenScope = entries.firstOrNull { it.wire == value } ?: VIRTUAL_ONLY
  }
}

/** Stable model-facing aliases. Only [REAL] has a fixed Android display id. */
object ScreenTargets {
  const val REAL = "real"
  const val VIRTUAL = "virtual-1"
  const val REAL_DISPLAY_ID = 0

  fun known(screenId: String): Boolean = screenId == REAL || screenId == VIRTUAL
}

/** Native source of truth for the screen scope selector. */
object ScreenScopePrefs {
  private const val PREFS = "dsh_screen_scope"
  private const val KEY_SCOPE = "scope"

  /** @return current normalized scope; absent/corrupt data fails closed to virtual-only. */
  fun current(context: Context): ScreenScope = ScreenScope.fromWire(
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SCOPE, null),
  )

  /** Store one user-selected wire value and return its normalized value. */
  fun set(context: Context, value: String?): ScreenScope {
    val scope = ScreenScope.fromWire(value)
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putString(KEY_SCOPE, scope.wire).apply()
    return scope
  }
}
