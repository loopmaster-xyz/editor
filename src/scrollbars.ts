import { signal, type Signal } from '@preact/signals-core'
import type { Canvas } from './canvas.ts'
import {
  getVerticalScrollbarMetrics,
  getVerticalScrollbarSize,
  hitTestScrollbar,
  HORIZONTAL_SCROLLBAR_SIZE,
} from './draw/scrollbar.ts'
import type { Doc } from './doc.ts'
import type { Gutter } from './gutter.ts'
import type { Header } from './header.ts'
import type { Lines } from './lines.ts'
import type { Scroll } from './scroll.ts'
import type { Settings } from './settings.ts'

export type Scrollbars = ReturnType<typeof createScrollbars>
const SCROLLBAR_MIN_THUMB = 20

export function createScrollbars(canvas: Canvas, scroll: Scroll, lines: Lines, settings: Settings, gutter: Gutter,
  doc: Doc,
  header: Signal<Header>)
{
  const isDragging = signal(false)
  let dragType: 'vertical' | 'horizontal' | null = null
  let dragStartX = 0
  let dragStartY = 0
  let dragStartScrollX = 0
  let dragStartScrollY = 0

  const getLayout = () => {
    const width = canvas.size.width.value
    const height = canvas.size.height.value
    const totalWidth = lines.totalWidth.value
    const totalHeight = lines.totalHeight.value
    const scrollWidth = scroll.scrollWidth.value
    const scrollHeight = scroll.scrollHeight.value
    const headerHeight = header.value?.height ?? 0
    const availableHeightForVertical = height - headerHeight - settings.paddingTop - settings.paddingBottom
    const availableWidth = width - settings.paddingLeft - settings.paddingRight - gutter.width.value
    const verticalScrollbarSize = getVerticalScrollbarSize(settings)
    const needsVertical = settings.showMinimap || totalHeight > availableHeightForVertical
    const availableWidthForHorizontal = availableWidth - (needsVertical ? verticalScrollbarSize : 0)
    const needsHorizontal = !settings.wordWrap && totalWidth > availableWidthForHorizontal
    const availableHeight = availableHeightForVertical - (needsHorizontal ? HORIZONTAL_SCROLLBAR_SIZE : 0)

    return {
      width,
      height,
      totalWidth,
      totalHeight,
      scrollWidth,
      scrollHeight,
      headerHeight,
      availableWidth,
      availableWidthForHorizontal,
      availableHeight,
      verticalScrollbarSize,
      needsVertical,
    }
  }

  const getHorizontalThumbMetrics = (layout: ReturnType<typeof getLayout>) => {
    const trackWidth = layout.width - (layout.needsVertical ? layout.verticalScrollbarSize : 0)
    const thumbWidthUnclamped = Math.max(SCROLLBAR_MIN_THUMB, (layout.availableWidthForHorizontal / layout.totalWidth)
      * trackWidth)
    const thumbWidth = Math.min(trackWidth, thumbWidthUnclamped)
    return { trackWidth, thumbWidth }
  }

  const getVerticalMetricsAtScrollY = (scrollY: number) => getVerticalScrollbarMetrics(
    canvas,
    scroll,
    lines,
    settings,
    gutter,
    header,
    doc.lines.length,
    scrollY,
  )

  const getRenderedThumbOffsetAtScrollY = (scrollY: number) => {
    const metrics = getVerticalMetricsAtScrollY(scrollY)
    return metrics ? metrics.thumbY - metrics.thumbTrackY : 0
  }

  const getMinimapScrollOffsetFromRenderedThumbOffset = (
    thumbOffset: number,
    verticalMetrics: NonNullable<ReturnType<typeof getVerticalScrollbarMetrics>>,
  ): number => {
    const fullScrollRange = Math.max(0, -verticalMetrics.scrollHeight)
    if (fullScrollRange <= 0) return 0

    const maxThumbOffset = getRenderedThumbOffsetAtScrollY(-fullScrollRange)
    const clampedTarget = Math.max(0, Math.min(maxThumbOffset, thumbOffset))

    let low = 0
    let high = fullScrollRange

    for (let i = 0; i < 18; i++) {
      const mid = (low + high) / 2
      const midThumbOffset = getRenderedThumbOffsetAtScrollY(-mid)
      if (midThumbOffset < clampedTarget) low = mid
      else high = mid
    }

    const lowThumbOffset = getRenderedThumbOffsetAtScrollY(-low)
    const highThumbOffset = getRenderedThumbOffsetAtScrollY(-high)
    return Math.abs(lowThumbOffset - clampedTarget) <= Math.abs(highThumbOffset - clampedTarget) ? low : high
  }

  const getScrollOffsetFromThumbOffset = (thumbOffset: number, verticalMetrics: NonNullable<ReturnType<
    typeof getVerticalScrollbarMetrics
  >>): number => {
    const fullScrollRange = Math.max(0, -verticalMetrics.scrollHeight)
    if (fullScrollRange <= 0) return 0
    const clampedThumbOffset = Math.max(0, Math.min(verticalMetrics.trackLength, thumbOffset))

    if (verticalMetrics.isMinimap) {
      return getMinimapScrollOffsetFromRenderedThumbOffset(clampedThumbOffset, verticalMetrics)
    }

    if (verticalMetrics.contentScrollRange <= 0 && verticalMetrics.overscrollScrollRange > 0) {
      if (verticalMetrics.overscrollTrackLength <= 0) return 0
      return (clampedThumbOffset / verticalMetrics.overscrollTrackLength) * verticalMetrics.overscrollScrollRange
    }

    if (verticalMetrics.overscrollScrollRange > 0 && clampedThumbOffset > verticalMetrics.contentTrackLength) {
      if (verticalMetrics.overscrollTrackLength <= 0) return verticalMetrics.contentScrollRange
      const overscrollThumbOffset = clampedThumbOffset - verticalMetrics.contentTrackLength
      const overscrollRatio = overscrollThumbOffset / verticalMetrics.overscrollTrackLength
      return verticalMetrics.contentScrollRange + overscrollRatio * verticalMetrics.overscrollScrollRange
    }

    if (verticalMetrics.contentTrackLength <= 0) return 0
    return (clampedThumbOffset / verticalMetrics.contentTrackLength) * verticalMetrics.contentScrollRange
  }

  const getThumbOffsetFromScrollY = (scrollY: number, verticalMetrics: NonNullable<ReturnType<
    typeof getVerticalScrollbarMetrics
  >>): number => {
    const fullScrollRange = Math.max(0, -verticalMetrics.scrollHeight)
    const scrollOffset = Math.max(0, Math.min(fullScrollRange, -scrollY))

    if (verticalMetrics.isMinimap) {
      return getRenderedThumbOffsetAtScrollY(-scrollOffset)
    }

    if (verticalMetrics.contentScrollRange <= 0 && verticalMetrics.overscrollScrollRange > 0) {
      if (verticalMetrics.overscrollScrollRange <= 0) return 0
      return (scrollOffset / verticalMetrics.overscrollScrollRange) * verticalMetrics.overscrollTrackLength
    }

    if (verticalMetrics.overscrollScrollRange > 0 && verticalMetrics.contentScrollRange > 0
      && scrollOffset > verticalMetrics.contentScrollRange)
    {
      const overscrollOffset = scrollOffset - verticalMetrics.contentScrollRange
      const overscrollRatio = verticalMetrics.overscrollScrollRange > 0
        ? overscrollOffset / verticalMetrics.overscrollScrollRange
        : 0
      return verticalMetrics.contentTrackLength + overscrollRatio * verticalMetrics.overscrollTrackLength
    }

    if (verticalMetrics.contentScrollRange <= 0) return 0
    return (scrollOffset / verticalMetrics.contentScrollRange) * verticalMetrics.contentTrackLength
  }

  const handleMouseMove = (x: number, y: number) => {
    if (!isDragging.value || !dragType) return

    const layout = getLayout()
    if (dragType === 'vertical') {
      const verticalMetrics = getVerticalScrollbarMetrics(
        canvas,
        scroll,
        lines,
        settings,
        gutter,
        header,
        doc.lines.length,
      )
      if (verticalMetrics) {
        const dragDelta = y - dragStartY
        const dragStartMetrics = getVerticalScrollbarMetrics(
          canvas,
          scroll,
          lines,
          settings,
          gutter,
          header,
          doc.lines.length,
          dragStartScrollY,
        )
        const dragStartThumbOffset = dragStartMetrics
          ? dragStartMetrics.thumbY - dragStartMetrics.thumbTrackY
          : getThumbOffsetFromScrollY(dragStartScrollY, verticalMetrics)
        const nextThumbOffset = dragStartThumbOffset + dragDelta
        const nextScrollOffset = getScrollOffsetFromThumbOffset(nextThumbOffset, verticalMetrics)
        const nextScrollY = Math.max(layout.scrollHeight, Math.min(0, -nextScrollOffset))
        scroll.targetY.value = nextScrollY
      }
    }
    else if (dragType === 'horizontal') {
      const { trackWidth, thumbWidth } = getHorizontalThumbMetrics(layout)
      const dragDelta = x - dragStartX
      const trackLength = trackWidth - thumbWidth
      const scrollRange = -layout.scrollWidth
      if (trackLength > 0 && scrollRange > 0) {
        const scrollRatio = dragDelta / trackLength
        const nextScrollX = Math.max(layout.scrollWidth, Math.min(0, dragStartScrollX - scrollRatio * scrollRange))
        scroll.targetX.value = nextScrollX
      }
    }
  }

  const handleMouseDown = (x: number, y: number): boolean => {
    const hit = hitTestScrollbar(canvas, scroll, lines, settings, gutter, header, x, y, doc.lines.length)
    if (!hit.type) return false

    const layout = getLayout()
    const liveScrollY = scroll.pos.y === Infinity ? scroll.targetY.value : scroll.pos.y

    if (hit.type && hit.thumb) {
      isDragging.value = true
      dragType = hit.type
      dragStartX = x
      dragStartY = y
      dragStartScrollX = scroll.targetX.value
      dragStartScrollY = liveScrollY
      return true
    }
    else if (hit.type && !hit.thumb) {
      if (hit.type === 'vertical') {
        const verticalMetrics = getVerticalScrollbarMetrics(
          canvas,
          scroll,
          lines,
          settings,
          gutter,
          header,
          doc.lines.length,
          liveScrollY,
        )
        if (verticalMetrics) {
          const thumbTopOffset = y - verticalMetrics.thumbTrackY - verticalMetrics.thumbHeight / 2
          const nextScrollOffset = getScrollOffsetFromThumbOffset(thumbTopOffset, verticalMetrics)
          const newScrollY = Math.max(layout.scrollHeight, Math.min(0, -nextScrollOffset))
          const clampedThumbTopOffset = Math.max(0, Math.min(verticalMetrics.trackLength, thumbTopOffset))
          const thumbCenterY = verticalMetrics.thumbTrackY + clampedThumbTopOffset + verticalMetrics.thumbHeight / 2
          scroll.targetY.value = newScrollY
          isDragging.value = true
          dragType = 'vertical'
          dragStartX = x
          dragStartY = thumbCenterY
          dragStartScrollX = scroll.targetX.value
          dragStartScrollY = newScrollY
          return true
        }
      }
      else if (hit.type === 'horizontal') {
        const { trackWidth, thumbWidth } = getHorizontalThumbMetrics(layout)
        const trackLength = trackWidth - thumbWidth
        const scrollRange = -layout.scrollWidth
        if (trackLength > 0 && scrollRange > 0) {
          const clickRatio = (x - thumbWidth / 2) / trackLength
          const clampedRatio = Math.max(0, Math.min(1, clickRatio))
          const newScrollX = -clampedRatio * scrollRange
          const thumbCenterX = clampedRatio * trackLength + thumbWidth / 2
          scroll.targetX.value = newScrollX
          isDragging.value = true
          dragType = 'horizontal'
          dragStartX = thumbCenterX
          dragStartY = y
          dragStartScrollX = newScrollX
          dragStartScrollY = scroll.targetY.value
          return true
        }
      }
    }

    return false
  }

  const handleMouseUp = (x: number, y: number) => {
    if (!isDragging.value) return null

    isDragging.value = false
    dragType = null
    const hit = hitTestScrollbar(canvas, scroll, lines, settings, gutter, header, x, y, doc.lines.length)
    return hit.type
  }

  return {
    isDragging,
    handleMouseMove,
    handleMouseDown,
    handleMouseUp,
  }
}
