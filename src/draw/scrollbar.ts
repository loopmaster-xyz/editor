import type { Signal } from '@preact/signals-core'
import type { Canvas } from '../canvas.ts'
import type { Context } from '../context.ts'
import type { Gutter } from '../gutter.ts'
import type { Header } from '../header.ts'
import type { Lines } from '../lines.ts'
import type { Scroll } from '../scroll.ts'
import type { Settings } from '../settings.ts'

export const VERTICAL_SCROLLBAR_SIZE = 12
export const HORIZONTAL_SCROLLBAR_SIZE = 3
const SCROLLBAR_MIN_THUMB = 20
const SCROLLBAR_TRACK_COLOR = 'rgba(255, 255, 255, 0.05)'
const SCROLLBAR_THUMB_COLOR = 'rgba(255, 255, 255, 0.1)'
const SCROLLBAR_THUMB_HOVER_COLOR = 'rgba(255, 255, 255, 0.2)'

export interface ScrollbarHit {
  type: 'vertical' | 'horizontal' | null
  thumb: boolean
}

export function hitTestScrollbar(
  canvas: Canvas,
  scroll: Scroll,
  lines: Lines,
  settings: Settings,
  gutter: Gutter,
  header: Signal<Header>,
  x: number,
  y: number,
): ScrollbarHit {
  const width = canvas.size.width.value
  const height = canvas.size.height.value
  const totalWidth = lines.totalWidth.value
  const totalHeight = lines.totalHeight.value
  const scrollWidth = scroll.scrollWidth.value
  const scrollHeight = scroll.scrollHeight.value
  const scrollX = scroll.targetX.value
  const scrollY = scroll.targetY.value
  const headerHeight = header.value?.height ?? 0

  const availableHeight = height - headerHeight - settings.paddingTop - settings.paddingBottom
  const availableWidth = width - settings.paddingLeft - settings.paddingRight - gutter.width.value
  const needsVertical = totalHeight > availableHeight
  const needsHorizontal = !settings.wordWrap && totalWidth > availableWidth

  if (needsVertical) {
    const scrollbarX = width - VERTICAL_SCROLLBAR_SIZE
    if (x >= scrollbarX && x <= width && y >= headerHeight) {
      const trackHeight = height - headerHeight
      const thumbHeight = Math.max(SCROLLBAR_MIN_THUMB, (availableHeight / totalHeight) * trackHeight)
      const scrollRange = -scrollHeight
      const scrollRatio = scrollRange > 0 ? -scrollY / scrollRange : 0
      const thumbY = headerHeight + scrollRatio * (trackHeight - thumbHeight)
      const isThumb = y >= thumbY && y <= thumbY + thumbHeight
      return { type: 'vertical', thumb: isThumb }
    }
  }

  if (needsHorizontal) {
    const scrollbarY = height - HORIZONTAL_SCROLLBAR_SIZE
    if (y >= scrollbarY && y <= height) {
      const trackWidth = width - (needsVertical ? VERTICAL_SCROLLBAR_SIZE : 0)
      const thumbWidth = Math.max(SCROLLBAR_MIN_THUMB, (availableWidth / totalWidth) * trackWidth)
      const scrollRange = -scrollWidth
      const scrollRatio = scrollRange > 0 ? -scrollX / scrollRange : 0
      const thumbX = scrollRatio * (trackWidth - thumbWidth)
      const isThumb = x >= thumbX && x <= thumbX + thumbWidth
      return { type: 'horizontal', thumb: isThumb }
    }
  }

  return { type: null, thumb: false }
}

export function drawScrollbars(context: Context) {
  const { canvas, scroll, lines, settings, gutter, header } = context
  const { c } = canvas
  const width = canvas.size.width.value
  const height = canvas.size.height.value
  const totalWidth = lines.totalWidth.value
  const totalHeight = lines.totalHeight.value
  const scrollWidth = scroll.scrollWidth.value
  const scrollHeight = scroll.scrollHeight.value
  const scrollX = scroll.targetX.value
  const scrollY = scroll.targetY.value
  const headerHeight = header.value?.height ?? 0

  const availableHeight = height - headerHeight - settings.paddingTop - settings.paddingBottom
  const availableWidth = width - settings.paddingLeft - settings.paddingRight - gutter.width.value
  const needsVertical = totalHeight > availableHeight
  const needsHorizontal = !settings.wordWrap && totalWidth > availableWidth

  if (needsVertical) {
    const scrollbarX = width - VERTICAL_SCROLLBAR_SIZE
    const trackHeight = height - headerHeight

    c.strokeStyle = SCROLLBAR_TRACK_COLOR
    c.lineWidth = 1
    c.beginPath()
    c.moveTo(scrollbarX, headerHeight)
    c.lineTo(scrollbarX, height)
    c.stroke()

    const thumbHeight = Math.max(SCROLLBAR_MIN_THUMB, (availableHeight / totalHeight) * trackHeight)
    const scrollRange = -scrollHeight
    const scrollRatio = scrollRange > 0 ? -scrollY / scrollRange : 0
    const thumbY = headerHeight + scrollRatio * (trackHeight - thumbHeight)
    const isHovered = context.mouse.hovered.scrollbar === 'vertical'

    c.fillStyle = isHovered ? SCROLLBAR_THUMB_HOVER_COLOR : SCROLLBAR_THUMB_COLOR
    c.fillRect(scrollbarX, thumbY, VERTICAL_SCROLLBAR_SIZE, thumbHeight)
  }

  if (needsHorizontal) {
    const scrollbarY = height - HORIZONTAL_SCROLLBAR_SIZE
    const trackWidth = width - (needsVertical ? VERTICAL_SCROLLBAR_SIZE : 0)

    const thumbWidth = Math.max(SCROLLBAR_MIN_THUMB, (availableWidth / totalWidth) * trackWidth)
    const scrollRange = -scrollWidth
    const scrollRatio = scrollRange > 0 ? -scrollX / scrollRange : 0
    const thumbX = scrollRatio * (trackWidth - thumbWidth)
    const isHovered = context.mouse.hovered.scrollbar === 'horizontal'

    c.fillStyle = isHovered ? SCROLLBAR_THUMB_HOVER_COLOR : SCROLLBAR_THUMB_COLOR
    c.fillRect(thumbX, scrollbarY, thumbWidth, HORIZONTAL_SCROLLBAR_SIZE)
  }
}
