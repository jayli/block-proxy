package com.blockproxy.android.ui

import com.blockproxy.android.status.TunnelStatus

enum class SliderAction {
    None,
    StartFresh,
    RetryStart,
    Stop,
}

enum class SliderTrackTone {
    Neutral,
    Connecting,
    Retrying,
    Connected,
}

data class SliderRenderState(
    val isActive: Boolean,
    val trackTone: SliderTrackTone,
)

class SliderStateMachine {
    private enum class UserIntent {
        Reset,
        WantsConnected,
    }

    private enum class AttemptPhase {
        Idle,
        Starting,
        Failed,
        Connected,
    }

    private var intent = UserIntent.Reset
    private var attemptPhase = AttemptPhase.Idle
    private var pendingAction = SliderAction.None

    /**
     * Initialize the state machine based on an already-observed status.
     *
     * This handles the case where the app is restarted while the VPN service
     * is still running in the same process — [BlockProxyVpnService.statusStore]
     * retains the real status, but the slider machine is freshly created in
     * `Reset` state.  Calling this before the first render synchronizes the
     * slider position with the actual VPN status.
     */
    fun initWithStatus(status: TunnelStatus) {
        when (status) {
            TunnelStatus.Connected,
            TunnelStatus.SilentListening -> {
                intent = UserIntent.WantsConnected
                attemptPhase = AttemptPhase.Connected
            }
            TunnelStatus.Preparing,
            TunnelStatus.Connecting -> {
                intent = UserIntent.WantsConnected
                attemptPhase = AttemptPhase.Starting
            }
            TunnelStatus.Reconnecting -> {
                intent = UserIntent.WantsConnected
                attemptPhase = AttemptPhase.Failed
            }
            TunnelStatus.Error,
            TunnelStatus.AuthFailed,
            TunnelStatus.Occupied -> {
                intent = UserIntent.WantsConnected
                attemptPhase = AttemptPhase.Failed
            }
            TunnelStatus.Disconnected -> {
                // Default state — nothing to change
            }
        }
    }

    fun onUserSlideRight() {
        intent = UserIntent.WantsConnected
        attemptPhase = AttemptPhase.Starting
        pendingAction = SliderAction.StartFresh
    }

    fun onUserSlideLeft() {
        intent = UserIntent.Reset
        attemptPhase = AttemptPhase.Idle
        pendingAction = SliderAction.Stop
    }

    fun onStatusChanged(status: TunnelStatus) {
        if (intent == UserIntent.Reset) return
        when (status) {
            TunnelStatus.Preparing,
            TunnelStatus.Connecting -> attemptPhase = AttemptPhase.Starting
            TunnelStatus.Connected,
            TunnelStatus.SilentListening -> {
                attemptPhase = AttemptPhase.Connected
                pendingAction = SliderAction.None
            }
            TunnelStatus.Reconnecting,
            TunnelStatus.Error,
            TunnelStatus.AuthFailed,
            TunnelStatus.Occupied -> attemptPhase = AttemptPhase.Failed
            TunnelStatus.Disconnected -> {
                if (attemptPhase != AttemptPhase.Starting) {
                    attemptPhase = AttemptPhase.Failed
                }
            }
        }
    }

    fun consumePendingAction(): SliderAction {
        val action = pendingAction
        pendingAction = SliderAction.None
        return action
    }

    fun onRetryTick(status: TunnelStatus): SliderAction {
        if (intent != UserIntent.WantsConnected) return SliderAction.None
        if (attemptPhase == AttemptPhase.Starting) return SliderAction.None
        return if (status.shouldRetryStart()) SliderAction.RetryStart else SliderAction.None
    }

    fun render(status: TunnelStatus): SliderRenderState {
        if (intent == UserIntent.Reset) {
            return SliderRenderState(
                isActive = false,
                trackTone = SliderTrackTone.Neutral,
            )
        }

        return SliderRenderState(
            isActive = true,
            trackTone = when (attemptPhase) {
                AttemptPhase.Starting -> SliderTrackTone.Connecting
                AttemptPhase.Connected -> SliderTrackTone.Connected
                AttemptPhase.Failed -> SliderTrackTone.Retrying
                AttemptPhase.Idle -> when (status) {
                    TunnelStatus.Connected,
                    TunnelStatus.SilentListening -> SliderTrackTone.Connected
                    TunnelStatus.Preparing,
                    TunnelStatus.Connecting -> SliderTrackTone.Connecting
                    TunnelStatus.Reconnecting,
                    TunnelStatus.Disconnected,
                    TunnelStatus.Error,
                    TunnelStatus.AuthFailed,
                    TunnelStatus.Occupied -> SliderTrackTone.Retrying
                }
            },
        )
    }

    private fun TunnelStatus.shouldRetryStart(): Boolean {
        return when (this) {
            TunnelStatus.Connected,
            TunnelStatus.SilentListening,
            TunnelStatus.Preparing,
            TunnelStatus.Connecting,
            TunnelStatus.Reconnecting -> false
            TunnelStatus.Disconnected,
            TunnelStatus.Error,
            TunnelStatus.AuthFailed,
            TunnelStatus.Occupied -> true
        }
    }
}
