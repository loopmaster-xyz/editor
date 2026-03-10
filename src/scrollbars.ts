import { signal, type Signal } from '@preact/signals-core'
import type { Canvas } from './canvas.ts'
import { getVerticalScrollbarSize, hitTestScrollbar, HORIZONTAL_SCROLLBAR_SIZE } from './draw/scrollbar.ts'
import type { Gutter } from './gutter.ts'
import type { Header } from './header.ts'
import type { Lines } from './lines.ts'
import type { Scroll } from './scroll.ts'
import type { Settings } from './settings.ts'

export type Scrollbars = ReturnType<typeof createScrollbars>
const SCROLLBAR_MIN_THUMB = 20

export function createScrollbars(canvas: Canvas, scroll: Scroll, lines: Lines, settings: Settings, gutter: Gutter,
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

  const getVerticalThumbMetrics = (layout: ReturnType<typeof getLayout>) => {
    const trackHeight = layout.height - layout.headerHeight
    const thumbHeightUnclamped = Math.max(SCROLLBAR_MIN_THUMB, (layout.availableHeight / layout.totalHeight)
      * trackHeight)
    const thumbHeight = Math.min(trackHeight, thumbHeightUnclamped)
    return { trackHeight, thumbHeight }
  }

  const getHorizontalThumbMetrics = (layout: ReturnType<typeof getLayout>) => {
    const trackWidth = layout.width - (layout.needsVertical ? layout.verticalScrollbarSize : 0)
    const thumbWidthUnclamped = Math.max(SCROLLBAR_MIN_THUMB, (layout.availableWidthForHorizontal / layout.totalWidth)
      * trackWidth)
    const thumbWidth = Math.min(trackWidth, thumbWidthUnclamped)
    return { trackWidth, thumbWidth }
  }

  const handleMouseMove = (x: number, y: number) => {
    if (!isDragging.value || !dragType) return

    const layout = getLayout()
    if (dragType === 'vertical') {
      const { trackHeight, thumbHeight } = getVerticalThumbMetrics(layout)
      const dragDelta = y - dragStartY
      const trackLength = trackHeight - thumbHeight
      const scrollRange = -layout.scrollHeight
      if (trackLength > 0 && scrollRange > 0) {
        const scrollRatio = dragDelta / trackLength
        scroll.targetY.value = dragStartScrollY - scrollRatio * scrollRange
      }
    }
    else if (dragType === 'horizontal') {
      const { trackWidth, thumbWidth } = getHorizontalThumbMetrics(layout)
      const dragDelta = x - dragStartX
      const trackLength = trackWidth - thumbWidth
      const scrollRange = -layout.scrollWidth
      if (trackLength > 0 && scrollRange > 0) {
        const scrollRatio = dragDelta / trackLength
        scroll.targetX.value = dragStartScrollX - scrollRatio * scrollRange
      }
    }
  }

  const handleMouseDown = (x: number, y: number): boolean => {
    const hit = hitTestScrollbar(canvas, scroll, lines, settings, gutter, header, x, y)
    if (!hit.type) return false

    const layout = getLayout()

    if (hit.type && hit.thumb) {
      isDragging.value = true
      dragType = hit.type
      dragStartX = x
      dragStartY = y
      dragStartScrollX = scroll.targetX.value
      dragStartScrollY = scroll.targetY.value
      return true
    }
    else if (hit.type && !hit.thumb) {
      if (hit.type === 'vertical') {
        const { trackHeight, thumbHeight } = getVerticalThumbMetrics(layout)
        const trackLength = trackHeight - thumbHeight
        const scrollRange = -layout.scrollHeight
        if (trackLength > 0 && scrollRange > 0) {
          const clickRatio = (y - layout.headerHeight - thumbHeight / 2) / trackLength
          const newScrollY = -Math.max(0, Math.min(1, clickRatio)) * scrollRange
          scroll.targetY.value = newScrollY
          isDragging.value = true
          dragType = 'vertical'
          dragStartX = x
          dragStartY = y
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
          const newScrollX = -Math.max(0, Math.min(1, clickRatio)) * scrollRange
          scroll.targetX.value = newScrollX
          isDragging.value = true
          dragType = 'horizontal'
          dragStartX = x
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
    const hit = hitTestScrollbar(canvas, scroll, lines, settings, gutter, header, x, y)
    return hit.type
  }

  return {
    isDragging,
    handleMouseMove,
    handleMouseDown,
    handleMouseUp,
  }
}
