import { signal, type Signal } from '@preact/signals-core'
import type { Canvas } from './canvas.ts'
import { hitTestScrollbar, VERTICAL_SCROLLBAR_SIZE } from './draw/scrollbar.ts'
import type { Gutter } from './gutter.ts'
import type { Header } from './header.ts'
import type { Lines } from './lines.ts'
import type { Scroll } from './scroll.ts'
import type { Settings } from './settings.ts'

export type Scrollbars = ReturnType<typeof createScrollbars>

export function createScrollbars(canvas: Canvas, scroll: Scroll, lines: Lines, settings: Settings, gutter: Gutter,
  header: Signal<Header>)
{
  const isDragging = signal(false)
  let dragType: 'vertical' | 'horizontal' | null = null
  let dragStartX = 0
  let dragStartY = 0
  let dragStartScrollX = 0
  let dragStartScrollY = 0

  const handleMouseMove = (x: number, y: number) => {
    if (!isDragging.value || !dragType) return

    const width = canvas.size.width.value
    const height = canvas.size.height.value
    const totalWidth = lines.totalWidth.value
    const totalHeight = lines.totalHeight.value

    const headerHeight = header.value?.height ?? 0
    const availableHeightForVertical = height - headerHeight - settings.paddingTop - settings.paddingBottom
    if (dragType === 'vertical') {
      const availableHeight = availableHeightForVertical
      const trackHeight = height - headerHeight
      const thumbHeight = Math.max(20, (availableHeight / totalHeight) * trackHeight)
      const dragDelta = y - dragStartY
      const trackLength = trackHeight - thumbHeight
      const scrollRange = -scroll.scrollHeight.value
      if (trackLength > 0 && scrollRange > 0) {
        const scrollRatio = dragDelta / trackLength
        scroll.targetY.value = dragStartScrollY - scrollRatio * scrollRange
      }
    }
    else if (dragType === 'horizontal') {
      const availableWidth = width - settings.paddingLeft - settings.paddingRight - gutter.width.value
      const needsVertical = totalHeight > availableHeightForVertical
      const trackWidth = width - (needsVertical ? VERTICAL_SCROLLBAR_SIZE : 0)
      const thumbWidth = Math.max(20, (availableWidth / totalWidth) * trackWidth)
      const dragDelta = x - dragStartX
      const trackLength = trackWidth - thumbWidth
      const scrollRange = -scroll.scrollWidth.value
      if (trackLength > 0 && scrollRange > 0) {
        const scrollRatio = dragDelta / trackLength
        scroll.targetX.value = dragStartScrollX - scrollRatio * scrollRange
      }
    }
  }

  const handleMouseDown = (x: number, y: number): boolean => {
    const headerHeight = header.value?.height ?? 0
    const hit = hitTestScrollbar(canvas, scroll, lines, settings, gutter, header, x, y)
    if (!hit.type) return false

    const width = canvas.size.width.value
    const height = canvas.size.height.value
    const totalWidth = lines.totalWidth.value
    const totalHeight = lines.totalHeight.value
    const scrollWidth = scroll.scrollWidth.value
    const scrollHeight = scroll.scrollHeight.value

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
        const availableHeight = height - headerHeight - settings.paddingTop - settings.paddingBottom
        const trackHeight = height - headerHeight
        const thumbHeight = Math.max(20, (availableHeight / totalHeight) * trackHeight)
        const trackLength = trackHeight - thumbHeight
        const scrollRange = -scrollHeight
        if (trackLength > 0 && scrollRange > 0) {
          const clickRatio = (y - headerHeight - thumbHeight / 2) / trackLength
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
        const availableHeight = height - headerHeight - settings.paddingTop - settings.paddingBottom
        const availableWidth = width - settings.paddingLeft - settings.paddingRight - gutter.width.value
        const needsVertical = totalHeight > availableHeight
        const trackWidth = width - (needsVertical ? VERTICAL_SCROLLBAR_SIZE : 0)
        const thumbWidth = Math.max(20, (availableWidth / totalWidth) * trackWidth)
        const trackLength = trackWidth - thumbWidth
        const scrollRange = -scrollWidth
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
