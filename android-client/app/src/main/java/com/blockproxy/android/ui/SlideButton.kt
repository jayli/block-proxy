package com.blockproxy.android.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

@Composable
fun SlideButton(
    enabled: Boolean,
    isActive: Boolean,
    trackTone: SliderTrackTone,
    onActiveChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val position = remember { Animatable(if (isActive) 1f else 0f) }
    var trackWidth by remember { mutableFloatStateOf(1f) }

    val liveOnActiveChange = rememberUpdatedState(onActiveChange)

    LaunchedEffect(isActive) {
        when {
            !isActive -> position.animateTo(0f, tween(300))
            else -> position.animateTo(1f, tween(300))
        }
    }

    val trackColor = when {
        !enabled -> Color(0xFFCCCCCC)
        trackTone == SliderTrackTone.Connected -> Color(0xFF43A047)
        trackTone == SliderTrackTone.Connecting -> Color(0xFFEF6C00)
        trackTone == SliderTrackTone.Retrying -> Color(0xFFEF6C00)
        else -> Color(0xFFCCCCCC)
    }

    val iconTint = when {
        trackTone == SliderTrackTone.Connected -> Color(0xFF43A047)
        trackTone == SliderTrackTone.Connecting -> Color(0xFFEF6C00)
        trackTone == SliderTrackTone.Retrying -> Color(0xFFEF6C00)
        else -> Color(0xFF777777)
    }

    val displayText = when {
        !enabled -> "请先完成配置"
        trackTone == SliderTrackTone.Connected -> "已连接 · 左滑断开"
        trackTone == SliderTrackTone.Connecting -> "连接中..."
        trackTone == SliderTrackTone.Retrying -> "连接失败 · 重试中..."
        else -> "滑动以连接"
    }

    val textColor = when {
        trackTone == SliderTrackTone.Connected ||
            trackTone == SliderTrackTone.Connecting ||
            trackTone == SliderTrackTone.Retrying -> Color.White
        else -> Color(0xFF777777)
    }

    val density = LocalDensity.current
    val thumbSizeDp = 48.dp
    val thumbSizePx = with(density) { thumbSizeDp.toPx() }
    val trackPaddingDp = 4.dp
    val trackPaddingPx = with(density) { trackPaddingDp.toPx() }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(56.dp)
            .onSizeChanged { trackWidth = it.width.toFloat() }
            .clip(RoundedCornerShape(28.dp))
            .background(trackColor)
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectHorizontalDragGestures(
                    onDragEnd = {
                        scope.launch {
                            if (position.value > 0.5f) {
                                liveOnActiveChange.value(true)
                                position.animateTo(1f, tween(200))
                            } else {
                                liveOnActiveChange.value(false)
                                position.animateTo(0f, tween(200))
                            }
                        }
                    },
                    onHorizontalDrag = { _, dragAmount ->
                        scope.launch {
                            val travel = trackWidth - thumbSizePx - trackPaddingPx * 2
                            if (travel > 0) {
                                val delta = dragAmount / travel
                                position.snapTo(
                                    (position.value + delta).coerceIn(0f, 1f)
                                )
                            }
                        }
                    }
                )
            }
    ) {
        Text(
            text = displayText,
            modifier = Modifier.align(Alignment.Center),
            style = MaterialTheme.typography.labelLarge,
            color = textColor,
        )

        val travel = trackWidth - thumbSizePx - trackPaddingPx * 2
        Box(
            modifier = Modifier
                .align(Alignment.CenterStart)
                .offset {
                    IntOffset(
                        x = if (travel > 0) {
                            (trackPaddingPx + travel * position.value).roundToInt()
                        } else 0,
                        y = 0,
                    )
                }
                .size(thumbSizeDp)
                .shadow(4.dp, CircleShape)
                .clip(CircleShape)
                .background(Color.White),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = if (position.value > 0.5f) {
                    Icons.AutoMirrored.Filled.ArrowBack
                } else {
                    Icons.AutoMirrored.Filled.ArrowForward
                },
                contentDescription = null,
                tint = iconTint,
                modifier = Modifier.size(24.dp),
            )
        }
    }
}
