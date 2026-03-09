import { computed, effect } from '@preact/signals-core'
import type { Blocks } from './blocks.ts'
import type { Caches } from './caches.ts'
import type { Canvas } from './canvas.ts'
import type { Doc } from './doc.ts'
import type { Lines } from './lines.ts'
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
  _lines: Lines,
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

  const blockStarts = computed(() => blocks.blockStarts.value)
  const digitWidth = computed(() => {
    const token = { type: 'text' as const, text: '0' }
    return measureText(canvas.c, settings, caches, token).width
  })

  const getLineNumberMetric = (logicalLine: number): { text: string; x: number } => {
    const text = (logicalLine + 1).toString()
    const numbersRightEdge = width.value - rightReserved
    return { text, x: numbersRightEdge - digitWidth.value * text.length }
  }

  return {
    width,
    blockStarts: blockStarts,
    getLineNumberMetric,
  }
}
