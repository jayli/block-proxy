package com.blockproxy.android.socks

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class DomainMappingStoreTest {

    // ── Basic put/get ───────────────────────────────────────────────────

    @Test
    fun `get unknown IP returns null`() {
        val store = DomainMappingStore()
        assertNull(store.get("1.2.3.4"))
    }

    @Test
    fun `put then get returns domain`() {
        val store = DomainMappingStore()
        store.put("198.18.0.5", "example.com")
        assertEquals("example.com", store.get("198.18.0.5"))
    }

    @Test
    fun `put multiple entries`() {
        val store = DomainMappingStore()
        store.put("198.18.0.1", "a.com")
        store.put("198.18.0.2", "b.com")
        store.put("198.18.0.3", "c.com")
        assertEquals("a.com", store.get("198.18.0.1"))
        assertEquals("b.com", store.get("198.18.0.2"))
        assertEquals("c.com", store.get("198.18.0.3"))
    }

    // ── Overwrite behavior ──────────────────────────────────────────────

    @Test
    fun `overwriting same IP updates domain`() {
        val store = DomainMappingStore()
        store.put("198.18.0.5", "old.com")
        store.put("198.18.0.5", "new.com")
        assertEquals("new.com", store.get("198.18.0.5"))
    }

    @Test
    fun `different IPs can map to same domain`() {
        val store = DomainMappingStore()
        store.put("198.18.0.1", "example.com")
        store.put("198.18.0.2", "example.com")
        assertEquals("example.com", store.get("198.18.0.1"))
        assertEquals("example.com", store.get("198.18.0.2"))
    }

    // ── clear ───────────────────────────────────────────────────────────

    @Test
    fun `clear removes all entries`() {
        val store = DomainMappingStore()
        store.put("198.18.0.1", "a.com")
        store.put("198.18.0.2", "b.com")
        store.clear()
        assertNull(store.get("198.18.0.1"))
        assertNull(store.get("198.18.0.2"))
    }

    @Test
    fun `clear on empty store is safe`() {
        val store = DomainMappingStore()
        store.clear() // should not throw
        assertNull(store.get("1.2.3.4"))
    }

    // ── Concurrent access ───────────────────────────────────────────────

    @Test
    fun `concurrent puts are thread-safe`() {
        val store = DomainMappingStore()
        val threadCount = 8
        val entriesPerThread = 100
        val executor = Executors.newFixedThreadPool(threadCount)
        val latch = CountDownLatch(threadCount)

        try {
            for (t in 0 until threadCount) {
                executor.submit {
                    try {
                        for (i in 0 until entriesPerThread) {
                            val ip = "198.18.${t}.${i}"
                            store.put(ip, "domain-${t}-${i}.com")
                        }
                    } finally {
                        latch.countDown()
                    }
                }
            }

            assertTrue("Timed out waiting for threads", latch.await(10, TimeUnit.SECONDS))

            // Verify all entries are retrievable
            for (t in 0 until threadCount) {
                for (i in 0 until entriesPerThread) {
                    val ip = "198.18.${t}.${i}"
                    assertEquals("domain-${t}-${i}.com", store.get(ip))
                }
            }
        } finally {
            executor.shutdown()
        }
    }

    @Test
    fun `concurrent reads during writes are safe`() {
        val store = DomainMappingStore()
        // Pre-populate
        for (i in 0 until 100) {
            store.put("10.0.0.$i", "host$i.com")
        }

        val executor = Executors.newFixedThreadPool(4)
        val latch = CountDownLatch(4)
        val errors = java.util.Collections.synchronizedList(mutableListOf<Throwable>())

        try {
            // 2 writer threads
            for (t in 0 until 2) {
                executor.submit {
                    try {
                        for (i in 0 until 100) {
                            store.put("10.0.${t}.$i", "w-${t}-${i}.com")
                        }
                    } catch (e: Throwable) {
                        errors.add(e)
                    } finally {
                        latch.countDown()
                    }
                }
            }
            // 2 reader threads
            for (t in 0 until 2) {
                executor.submit {
                    try {
                        for (i in 0 until 100) {
                            store.get("10.0.0.$i") // may return original or null
                        }
                    } catch (e: Throwable) {
                        errors.add(e)
                    } finally {
                        latch.countDown()
                    }
                }
            }

            assertTrue("Timed out", latch.await(10, TimeUnit.SECONDS))
            assertTrue("Errors during concurrent access: $errors", errors.isEmpty())
        } finally {
            executor.shutdown()
        }
    }
}
