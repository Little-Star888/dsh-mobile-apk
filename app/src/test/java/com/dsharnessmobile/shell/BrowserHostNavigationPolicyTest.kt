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
}
