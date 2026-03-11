import { batch, computed, effect, type Signal, signal, untracked } from '@preact/signals-core'
import type { Canvas } from './canvas.ts'
import { getVerticalScrollbarSize, HORIZONTAL_SCROLLBAR_SIZE } from './draw/scrollbar.ts'
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

function clampScrollAxis(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

export function createScroll(canvas: Canvas, lines: Lines, settings: Settings, gutter: Gutter, header: Signal<Header>,
  metrics: Metrics)
{
  const pos = signalify({ x: Infinity, y: Infinity })

  const targetX = signal(Infinity)
  const targetY = signal(Infinity)

  const smooth = signal(0.2)

  const clampScrollOffsets = () => {
    const minX = scrollWidth.value
    const minY = scrollHeight.value

    if (Number.isFinite(targetX.value)) {
      targetX.value = clampScrollAxis(targetX.value, minX, 0)
    }
    if (Number.isFinite(targetY.value)) {
      targetY.value = clampScrollAxis(targetY.value, minY, 0)
    }

    if (Number.isFinite(pos.x)) {
      pos.x = clampScrollAxis(pos.x, minX, 0)
    }
    if (Number.isFinite(pos.y)) {
      pos.y = clampScrollAxis(pos.y, minY, 0)
    }
  }

  const update = () => {
    batch(() => {
      clampScrollOffsets()
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
      clampScrollOffsets()
    })
  }

  const scrollWidth = computed(() => {
    if (settings.wordWrap) return 0
    const headerHeight = header.value?.height ?? 0
    const verticalScrollbarSize = getVerticalScrollbarSize(settings)
    const needsVertical =
      settings.showMinimap
      || lines.totalHeight.value > canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
    const availableWidth = canvas.size.width.value - settings.paddingLeft - settings.paddingRight - gutter.width.value
      - (needsVertical ? verticalScrollbarSize : 0)
    return Math.min(0, -lines.totalWidth.value + availableWidth)
  })
  const scrollHeight = computed(() => {
    const headerHeight = header.value?.height ?? 0
    const verticalScrollbarSize = getVerticalScrollbarSize(settings)
    const needsVertical =
      settings.showMinimap
      || lines.totalHeight.value > canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
    const availableWidth = canvas.size.width.value - settings.paddingLeft - settings.paddingRight - gutter.width.value
      - (needsVertical ? verticalScrollbarSize : 0)
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
    // Keep target and live position strictly inside current scroll bounds.
    scrollWidth.value
    scrollHeight.value
    targetX.value
    targetY.value
    pos.x
    pos.y
    batch(() => {
      clampScrollOffsets()
    })
  })

  return { pos, targetX, targetY, smooth, scrollWidth, scrollHeight, update }
}
