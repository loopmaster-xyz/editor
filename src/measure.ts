import type { Caches } from './caches.ts'
import type { VisualToken } from './lines.ts'
import type { Settings } from './settings.ts'
import type { Token } from './token.ts'

const fontMetricsCache = new Map<string, { height: number; fontHeight: number }>()
const MAX_FONT_METRICS_CACHE_ENTRIES = 256

export function measureText(
  c: CanvasRenderingContext2D,
  settings: Settings,
  caches: Caches,
  token: Token,
) {
  const measureTextCache = caches.measureTextCache

  const { text, type } = token
  const {
    fontSize,
    fontFamilyName,
    theme: { [type]: { style, weight } },
  } = settings
  const font = `${weight === 'bold' ? 700 : 400} ${style} ${fontSize} '${fontFamilyName}', monospace`

  const cacheKey = `${text}\u0000${font}`
  if (measureTextCache.has(cacheKey)) {
    return measureTextCache.get(cacheKey)!
  }

  const prevFont = c.font
  if (prevFont !== font) c.font = font
  const width = c.measureText(text).width
  let metrics = fontMetricsCache.get(font)
  if (!metrics) {
    const heightMetrics = c.measureText('Mg')
    metrics = {
      height: Math.ceil(heightMetrics.actualBoundingBoxAscent + heightMetrics.actualBoundingBoxDescent),
      fontHeight: Math.ceil(heightMetrics.fontBoundingBoxAscent + heightMetrics.fontBoundingBoxDescent),
    }
    if (!fontMetricsCache.has(font) && fontMetricsCache.size >= MAX_FONT_METRICS_CACHE_ENTRIES) {
      const oldestKey = fontMetricsCache.keys().next().value
      if (typeof oldestKey === 'string') fontMetricsCache.delete(oldestKey)
    }
    fontMetricsCache.set(font, metrics)
  }
  if (prevFont !== font) c.font = prevFont

  const measured = { width, height: metrics.height, fontHeight: metrics.fontHeight }
  measureTextCache.set(cacheKey, measured)
  return measured
}

export function measureLine(
  c: CanvasRenderingContext2D,
  settings: Settings,
  caches: Caches,
  tokens: Token[],
) {
  let width = 0
  let height = 0
  for (const token of tokens) {
    const metrics = measureText(c, settings, caches, token)
    width += metrics.width
    height = Math.max(height, metrics.fontHeight)
  }
  return {
    width: Math.max(1, width),
    height: Math.ceil(Math.max(1, height)),
  }
}

export function measureVisualTokens(
  c: CanvasRenderingContext2D,
  settings: Settings,
  caches: Caches,
  visualTokens: VisualToken[],
) {
  let width = 0
  let height = 0
  for (const { token } of visualTokens) {
    const metrics = measureText(c, settings, caches, token)
    width += metrics.width
    height = Math.max(height, metrics.fontHeight)
  }
  return {
    width: Math.max(1, width),
    height: Math.ceil(Math.max(1, height)),
  }
}
