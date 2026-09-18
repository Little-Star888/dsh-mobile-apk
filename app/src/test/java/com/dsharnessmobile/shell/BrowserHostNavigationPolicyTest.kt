package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BrowserHostNavigationPolicyTest {
  @Test
  fun normalizesOrdinaryHttpAddresses() {
    assertEquals("https://example.com", BrowserHostNavigationPolicy.normalize("example.com"))
    assertEquals("http://example.com/path", BrowserHostNavigationPolicy.normalize("http://example.com/path"))
    assertEquals("about:blank", BrowserHostNavigationPolicy.normalize("about:blank"))
  }

  @Test
  fun rejectsLocalTrustedAndNonHttpSchemes() {
    for (value in listOf(
      "http://127.0.0.1:3080/", "http://localhost:3080/", "http://0.0.0.0/",
      "http://[::1]/", "javascript:alert(1)", "file:///sdcard/a.txt", "content://provider/a", "data:text/html,x",
    )) {
      assertNull("must reject $value", BrowserHostNavigationPolicy.normalize(value))
    }
  }

  @Test
  fun rejectsMissingHostAndCredentialBearingAddresses() {
    assertNull(BrowserHostNavigationPolicy.normalize("https:///path"))
    assertNull(BrowserHostNavigationPolicy.normalize("https://user:pass@example.com/"))
    assertNull(BrowserHostNavigationPolicy.normalize(""))
  }

  /**
   * 中文等非 ASCII 查询串必须**按 UTF-8 百分号编码**成合法地址，且解码回原文。
   *
   * 用户实报（0.14.0）：用中文检索词搜索时返回的是**无关视频**——即查询词在某一层被改写/替换了。
   * 关键在于该层不得「静默丢字符」或「用平台默认字符集编码」：本仓储此前全部收发点都显式写
   * UTF-8（ControlPoller/MuxClient/FileIncoming 等），导航层也必须显式而非交给默认值。
   */
  @Test
  fun keepsNonAsciiQueryTextEncodedAndLossless() {
    val normalized = BrowserHostNavigationPolicy.normalize("https://example.com/s?q=影视飓风")
    assertEquals("https://example.com/s?q=%E5%BD%B1%E8%A7%86%E9%A3%93%E9%A3%8E", normalized)
    // 关键：解码回来必须与输入逐字节相同（有损替换会让模型搜到完全无关的结果）。
    val query = java.net.URI(normalized).rawQuery.removePrefix("q=")
    assertEquals("影视飓风", java.net.URLDecoder.decode(query, "UTF-8"))
  }
}
