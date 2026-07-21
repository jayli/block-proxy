package com.blockproxy.android.tunnel

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ForwardAdmissionControllerTest {
    @Test
    fun `second forward waits until global permit is released`() = runTest {
        val controller = ForwardAdmissionController(maxActive = 1, maxActivePerTarget = 1)
        val firstEntered = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        var entered = 0

        val first = async {
            controller.withPermit("a.example.com", 443) {
                entered += 1
                firstEntered.complete(Unit)
                releaseFirst.await()
            }
        }
        firstEntered.await()

        val second = async {
            controller.withPermit("b.example.com", 443) {
                entered += 1
            }
        }
        runCurrent()

        assertFalse(second.isCompleted)
        assertEquals(1, entered)

        releaseFirst.complete(Unit)
        first.await()
        second.await()

        assertTrue(second.isCompleted)
        assertEquals(2, entered)
    }

    @Test
    fun `same target uses per-target permit even when global capacity remains`() = runTest {
        val controller = ForwardAdmissionController(maxActive = 4, maxActivePerTarget = 1)
        val firstEntered = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        var entered = 0

        val first = async {
            controller.withPermit("same.example.com", 443) {
                entered += 1
                firstEntered.complete(Unit)
                releaseFirst.await()
            }
        }
        firstEntered.await()

        val second = async {
            controller.withPermit("same.example.com", 443) {
                entered += 1
            }
        }
        runCurrent()

        assertFalse(second.isCompleted)
        assertEquals(1, entered)

        releaseFirst.complete(Unit)
        first.await()
        second.await()

        assertEquals(2, entered)
    }

    @Test
    fun `acquired permit blocks later sessions until released`() = runTest {
        val controller = ForwardAdmissionController(maxActive = 1, maxActivePerTarget = 1)
        val permit = controller.acquire("held.example.com", 443)
        var entered = false

        val waiting = async {
            controller.withPermit("other.example.com", 443) {
                entered = true
            }
        }
        runCurrent()

        assertFalse(waiting.isCompleted)
        assertFalse(entered)

        permit.release()
        waiting.await()

        assertTrue(entered)
    }
}
