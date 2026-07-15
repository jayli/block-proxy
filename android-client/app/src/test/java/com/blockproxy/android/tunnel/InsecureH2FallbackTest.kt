package com.blockproxy.android.tunnel

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InsecureH2FallbackTest {
    @Test
    fun fallsBackOnlyForCronetCertificateErrorsWhenAllowInsecureIsEnabled() {
        val certError = RuntimeException(
            "Exception in BidirectionalStream: net::ERR_CERT_COMMON_NAME_INVALID, ErrorCode=11"
        )

        assertTrue(InsecureH2Fallback.shouldFallback(allowInsecure = true, certError))
        assertFalse(InsecureH2Fallback.shouldFallback(allowInsecure = false, certError))
    }

    @Test
    fun doesNotFallbackForNonCertificateErrors() {
        val networkError = RuntimeException(
            "Exception in BidirectionalStream: net::ERR_CONNECTION_TIMED_OUT"
        )

        assertFalse(InsecureH2Fallback.shouldFallback(allowInsecure = true, networkError))
    }
}
