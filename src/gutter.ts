import { computed, effect } from '@preact/signals-core'
import type { Blocks } from './blocks.ts'
import type { Caches } from './caches.ts'
import type { Canvas } from './canvas.ts'
import type { Doc } from './doc.ts'
import type { Lines, VisualLine } from './lines.ts'
import { measureText } from './measure.ts'
import type { Metrics } from './metrics.ts'
import type { Settings } from './settings.ts'

export type Gutter = ReturnType<typeof createGutter>

export function createGutter(
  doc: Doc,
  canvas: Canvas,
  metrics: Metrics,
  settings: Settings,
  caches: Caches,
  blocks: Blocks,
  lines: Lines,
) {
  const COLLAPSE_TOGGLE_SIZE = 12
  const RIGHT_MARGIN = 4
  const NUMBER_BUTTON_GAP = 8
  const rightReserved = COLLAPSE_TOGGLE_SIZE + RIGHT_MARGIN + NUMBER_BUTTON_GAP

  const width = computed(() => {
    if (!settings.showGutter) return 0
    const codeLines = doc.lines
    const maxLineNumber = codeLines.length
    const minDigits = 10 ** settings.minGutterDigits - 1
    const effectiveMax = Math.max(maxLineNumber, minDigits)
    const maxLineNumberText = effectiveMax.toString()
    const token = { type: 'text' as const, text: maxLineNumberText }
    const metrics = measureText(canvas.c, settings, caches, token)
    return settings.paddingLeft + metrics.width + rightReserved
  })

  effect(() => {
    metrics.gutterWidth.value = width.value
  })

  const lineNumberMap = computed(() => {
    if (!lines) return new Map<number, VisualLine[]>()
    const visualLines = lines.visualLines.value
    const map = new Map<number, VisualLine[]>()
    for (const visualLine of visualLines) {
      const logicalLine = visualLine.logicalLine
      if (!map.has(logicalLine)) {
        map.set(logicalLine, [])
      }
      map.get(logicalLine)!.push(visualLine)
    }
    return map
  })

  const blockStarts = computed(() => blocks.blockStarts.value)

  const lineNumberMetrics = computed(() => {
    const codeLines = doc.lines
    const metrics = new Map<number, { width: number; text: string; x: number }>()
    const gutterWidth = width.value
    const numbersRightEdge = gutterWidth - rightReserved

    for (let i = 0; i < codeLines.length; i++) {
      const lineNumber = (i + 1).toString()
      const token = { type: 'text' as const, text: lineNumber }
      const measure = measureText(canvas.c, settings, caches, token)
      const x = numbersRightEdge - measure.width
      metrics.set(i, { width: measure.width, text: lineNumber, x })
    }
    return metrics
  })

  return {
    width,
    lineNumberMap,
    blockStarts: blockStarts,
    lineNumberMetrics,
  }
}
