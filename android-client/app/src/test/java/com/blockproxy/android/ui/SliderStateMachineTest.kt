package com.blockproxy.android.ui

import com.blockproxy.android.status.TunnelStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SliderStateMachineTest {

    @Test
    fun `initial state is reset and renders left grey`() {
        val machine = SliderStateMachine()

        val render = machine.render(TunnelStatus.Error)

        assertFalse(render.isActive)
        assertEquals(SliderTrackTone.Neutral, render.trackTone)
        assertEquals(SliderAction.None, machine.consumePendingAction())
    }

    @Test
    fun `sliding left resets errors stops vpn and moves left`() {
        val machine = SliderStateMachine()
        machine.onUserSlideRight()
        machine.onStatusChanged(TunnelStatus.Error)

        machine.onUserSlideLeft()

        val render = machine.render(TunnelStatus.Error)
        assertFalse(render.isActive)
        assertEquals(SliderTrackTone.Neutral, render.trackTone)
        assertEquals(SliderAction.Stop, machine.consumePendingAction())
        assertEquals(SliderAction.None, machine.onRetryTick(TunnelStatus.Error))
    }

    @Test
    fun `sliding right always starts a fresh connection`() {
        val machine = SliderStateMachine()
        machine.onStatusChanged(TunnelStatus.AuthFailed)

        machine.onUserSlideRight()

        val render = machine.render(TunnelStatus.AuthFailed)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Connecting, render.trackTone)
        assertEquals(SliderAction.StartFresh, machine.consumePendingAction())
    }

    @Test
    fun `sliding right from disconnected renders connecting before first status update`() {
        val machine = SliderStateMachine()

        machine.onUserSlideRight()

        val render = machine.render(TunnelStatus.Disconnected)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Connecting, render.trackTone)
    }

    @Test
    fun `connected while active renders right green`() {
        val machine = SliderStateMachine()
        machine.onUserSlideRight()
        machine.consumePendingAction()

        machine.onStatusChanged(TunnelStatus.Connected)

        val render = machine.render(TunnelStatus.Connected)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Connected, render.trackTone)
        assertEquals(SliderAction.None, machine.consumePendingAction())
    }

    @Test
    fun `failure while active renders orange and retry tick requests retry`() {
        val machine = SliderStateMachine()
        machine.onUserSlideRight()
        machine.consumePendingAction()

        machine.onStatusChanged(TunnelStatus.Error)

        val render = machine.render(TunnelStatus.Error)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Retrying, render.trackTone)
        assertEquals(SliderAction.RetryStart, machine.onRetryTick(TunnelStatus.Error))
    }

    @Test
    fun `disconnected while active is treated as retryable failure`() {
        val machine = SliderStateMachine()
        machine.onUserSlideRight()
        machine.consumePendingAction()
        machine.onStatusChanged(TunnelStatus.Connected)

        machine.onStatusChanged(TunnelStatus.Disconnected)

        val render = machine.render(TunnelStatus.Disconnected)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Retrying, render.trackTone)
        assertEquals(SliderAction.RetryStart, machine.onRetryTick(TunnelStatus.Disconnected))
    }

    @Test
    fun `reconnecting while active renders orange without outer restart`() {
        val machine = SliderStateMachine()
        machine.onUserSlideRight()
        machine.consumePendingAction()

        machine.onStatusChanged(TunnelStatus.Reconnecting)

        val render = machine.render(TunnelStatus.Reconnecting)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Retrying, render.trackTone)
        assertEquals(SliderAction.None, machine.onRetryTick(TunnelStatus.Reconnecting))
    }

    @Test
    fun `silent listening while active renders connected without outer restart`() {
        val machine = SliderStateMachine()
        machine.onUserSlideRight()
        machine.consumePendingAction()

        machine.onStatusChanged(TunnelStatus.SilentListening)

        val render = machine.render(TunnelStatus.SilentListening)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Connected, render.trackTone)
        assertEquals(SliderAction.None, machine.onRetryTick(TunnelStatus.SilentListening))
    }

    @Test
    fun `retry stops after user slides left`() {
        val machine = SliderStateMachine()
        machine.onUserSlideRight()
        machine.consumePendingAction()
        machine.onStatusChanged(TunnelStatus.Error)

        machine.onUserSlideLeft()
        machine.consumePendingAction()

        assertEquals(SliderAction.None, machine.onRetryTick(TunnelStatus.Error))
    }

    // ── initWithStatus tests ─────────────────────────────────────────

    @Test
    fun `initWithStatus Connected renders right green`() {
        val machine = SliderStateMachine()

        machine.initWithStatus(TunnelStatus.Connected)

        val render = machine.render(TunnelStatus.Connected)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Connected, render.trackTone)
    }

    @Test
    fun `initWithStatus Preparing renders right orange`() {
        val machine = SliderStateMachine()

        machine.initWithStatus(TunnelStatus.Preparing)

        val render = machine.render(TunnelStatus.Preparing)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Connecting, render.trackTone)
    }

    @Test
    fun `initWithStatus Connecting renders right orange`() {
        val machine = SliderStateMachine()

        machine.initWithStatus(TunnelStatus.Connecting)

        val render = machine.render(TunnelStatus.Connecting)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Connecting, render.trackTone)
    }

    @Test
    fun `initWithStatus Reconnecting renders right orange retry`() {
        val machine = SliderStateMachine()

        machine.initWithStatus(TunnelStatus.Reconnecting)

        val render = machine.render(TunnelStatus.Reconnecting)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Retrying, render.trackTone)
    }

    @Test
    fun `initWithStatus Error renders right orange retry`() {
        val machine = SliderStateMachine()

        machine.initWithStatus(TunnelStatus.Error)

        val render = machine.render(TunnelStatus.Error)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Retrying, render.trackTone)
        assertEquals(SliderAction.RetryStart, machine.onRetryTick(TunnelStatus.Error))
    }

    @Test
    fun `initWithStatus Disconnected stays left grey`() {
        val machine = SliderStateMachine()

        machine.initWithStatus(TunnelStatus.Disconnected)

        val render = machine.render(TunnelStatus.Disconnected)
        assertFalse(render.isActive)
        assertEquals(SliderTrackTone.Neutral, render.trackTone)
    }

    @Test
    fun `initWithStatus Connected then slide left stops and moves left`() {
        val machine = SliderStateMachine()
        machine.initWithStatus(TunnelStatus.Connected)

        machine.onUserSlideLeft()

        val render = machine.render(TunnelStatus.Connected)
        assertFalse(render.isActive)
        assertEquals(SliderTrackTone.Neutral, render.trackTone)
        assertEquals(SliderAction.Stop, machine.consumePendingAction())
    }

    @Test
    fun `initWithStatus Connected then onStatusChanged Disconnected enters retry`() {
        val machine = SliderStateMachine()
        machine.initWithStatus(TunnelStatus.Connected)

        machine.onStatusChanged(TunnelStatus.Disconnected)

        val render = machine.render(TunnelStatus.Disconnected)
        assertTrue(render.isActive)
        assertEquals(SliderTrackTone.Retrying, render.trackTone)
        assertEquals(SliderAction.RetryStart, machine.onRetryTick(TunnelStatus.Disconnected))
    }
}
