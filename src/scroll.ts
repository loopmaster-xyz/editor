import { batch, computed, effect, type Signal, signal, untracked } from '@preact/signals-core'
import type { Canvas } from './canvas.ts'
import { HORIZONTAL_SCROLLBAR_SIZE, VERTICAL_SCROLLBAR_SIZE } from './draw/scrollbar.ts'
import type { Gutter } from './gutter.ts'
import type { Header } from './header.ts'
import { signalify } from './lib/signalify.ts'
import type { Lines } from './lines.ts'
import type { Metrics } from './metrics.ts'
import type { Settings } from './settings.ts'

export const SCROLL_SMOOTH_KEYBOARD = 0.2
export const SCROLL_SMOOTH_SCROLLING = 0.4
export const SCROLL_SMOOTH_THRESHOLD = 0.1

export type Scroll = ReturnType<typeof createScroll>

export function createScroll(canvas: Canvas, lines: Lines, settings: Settings, gutter: Gutter, header: Signal<Header>,
  metrics: Metrics)
{
  const pos = signalify({ x: Infinity, y: Infinity })

  const targetX = signal(Infinity)
  const targetY = signal(Infinity)

  const smooth = signal(0.2)

  const update = () => {
    batch(() => {
      const { x, y } = pos
      if (x === Infinity) {
        if (targetX.value === Infinity) {
          return
        }
        pos.x = targetX.value
        pos.y = targetY.value
        return
      }
      const dx = targetX.value - x
      const dy = targetY.value - y
      const s = smooth.value
      pos.x = x + dx * s
      pos.y = y + dy * s
      if (Math.abs(dx) < SCROLL_SMOOTH_THRESHOLD && Math.abs(dy) < SCROLL_SMOOTH_THRESHOLD) {
        pos.x = targetX.value
        pos.y = targetY.value
      }
    })
  }

  const scrollWidth = computed(() => {
    if (settings.wordWrap) return 0
    const headerHeight = header.value?.height ?? 0
    const needsVertical =
      lines.totalHeight.value > canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
    const availableWidth = canvas.size.width.value - settings.paddingLeft - settings.paddingRight - gutter.width.value
      - (needsVertical ? VERTICAL_SCROLLBAR_SIZE : 0)
    return Math.min(0, -lines.totalWidth.value + availableWidth)
  })
  const scrollHeight = computed(() => {
    const headerHeight = header.value?.height ?? 0
    const needsVertical =
      lines.totalHeight.value > canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
    const availableWidth = canvas.size.width.value - settings.paddingLeft - settings.paddingRight - gutter.width.value
      - (needsVertical ? VERTICAL_SCROLLBAR_SIZE : 0)
    const needsHorizontal = !settings.wordWrap && lines.totalWidth.value > availableWidth
    const availableHeight = canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
      - (needsHorizontal ? HORIZONTAL_SCROLLBAR_SIZE : 0)
    return Math.min(0, -lines.totalHeight.value + availableHeight)
  })

  effect(() => {
    if (pos.x === Infinity || pos.y === Infinity) {
      metrics.visibleLines.value = { start: 0, end: 0 }
      return
    }
    const scrollY = pos.y
    const headerHeight = header.value?.height ?? 0
    const visibleTop = -headerHeight - settings.paddingTop
    const visibleBottom = canvas.size.height.value - settings.paddingTop
    const approxVisibleRange = typeof lines.getApproxVisibleLogicalRange === 'function'
      ? lines.getApproxVisibleLogicalRange(visibleTop, visibleBottom, scrollY)
      : null
    if (approxVisibleRange) {
      metrics.visibleLines.value = approxVisibleRange
      return
    }
    const visualLines = untracked(() => lines.getVisibleVisualLines(visibleTop, visibleBottom, scrollY))
    if (visualLines.length === 0) {
      metrics.visibleLines.value = { start: 0, end: 0 }
      return
    }

    let start: number | null = null
    let end: number | null = null

    for (let i = 0; i < visualLines.length; i++) {
      const line = visualLines[i]
      const logicalLine = line.logicalLine
      if (start === null) {
        start = logicalLine
      }
      end = logicalLine
    }
    if (start === null || end === null) {
      metrics.visibleLines.value = { start: 0, end: 0 }
      return
    }
    metrics.visibleLines.value = { start, end }
  })

  effect(() => {
    if (pos.x === Infinity || pos.y === Infinity) {
      return
    }

    const approxContentMetrics = typeof lines.getApproxContentMetrics === 'function'
      ? lines.getApproxContentMetrics()
      : null
    if (!approxContentMetrics) {
      return
    }

    const headerHeight = header.value?.height ?? 0
    const needsVertical = approxContentMetrics.totalHeight
      > canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
    const availableWidth = canvas.size.width.value - settings.paddingLeft - settings.paddingRight - gutter.width.value
      - (needsVertical ? VERTICAL_SCROLLBAR_SIZE : 0)
    const minScrollX = settings.wordWrap ? 0 : Math.min(0, -approxContentMetrics.totalWidth + availableWidth)

    const needsHorizontal = !settings.wordWrap && approxContentMetrics.totalWidth > availableWidth
    const availableHeight = canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
      - (needsHorizontal ? HORIZONTAL_SCROLLBAR_SIZE : 0)
    const minScrollY = Math.min(0, -approxContentMetrics.totalHeight + availableHeight)

    if (targetX.value < minScrollX) {
      targetX.value = minScrollX
    }
    if (targetX.value > 0) {
      targetX.value = 0
    }

    if (targetY.value < minScrollY) {
      targetY.value = minScrollY
    }
    if (targetY.value > 0) {
      targetY.value = 0
    }
  })

  return { pos, targetX, targetY, smooth, scrollWidth, scrollHeight, update }
}
