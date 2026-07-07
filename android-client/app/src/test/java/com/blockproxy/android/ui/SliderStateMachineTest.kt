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
    fun `retry stops after user slides left`() {
        val machine = SliderStateMachine()
        machine.onUserSlideRight()
        machine.consumePendingAction()
        machine.onStatusChanged(TunnelStatus.Error)

        machine.onUserSlideLeft()
        machine.consumePendingAction()

        assertEquals(SliderAction.None, machine.onRetryTick(TunnelStatus.Error))
    }
}
