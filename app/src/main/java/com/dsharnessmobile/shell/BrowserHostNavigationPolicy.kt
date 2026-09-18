package com.dsharnessmobile.shell

import java.net.URI

/** URL admission for the untrusted BrowserHost surface. */
internal object BrowserHostNavigationPolicy {
  /**
   * Normalize an address entered by the trusted workbench and reject local/trusted origins.
   * @return an http(s) or `about:blank` browser address, or null when the input is unsafe.
   */
  fun normalize(raw: String?): String? {
    val trimmed = raw?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    val candidate = if (trimmed.contains("://") || trimmed.startsWith("about:")) trimmed else "https://$trimmed"
    return try {
      val parsed = URI(candidate)
      val scheme = parsed.scheme?.lowercase()
      when {
        candidate == "about:blank" -> candidate
        scheme != "https" && scheme != "http" -> null
        parsed.host.isNullOrBlank() || parsed.userInfo != null || isLocalHost(parsed.host) -> null
        else -> parsed.toASCIIString()
      }
    } catch (_: Throwable) {
      null
    }
  }

  private fun isLocalHost(raw: String): Boolean {
    val host = raw.trim().lowercase().removePrefix("[").removeSuffix("]")
    if (host == "localhost" || host == "0.0.0.0" || host == "::1" || host == "0:0:0:0:0:0:0:1") return true
    if (host.startsWith("127.")) return true
    return host.startsWith("::ffff:127.")
  }
}
