import type { Caches } from './caches.ts'
import type { VisualToken } from './lines.ts'
import type { Settings } from './settings.ts'
import type { Token } from './token.ts'

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

  const cacheKey = `${text}${style}${weight}${fontSize}${fontFamilyName}`
  if (measureTextCache.has(cacheKey)) {
    return measureTextCache.get(cacheKey)!
  }

  c.save()

  c.font = `${weight === 'bold' ? 700 : 400} ${style} ${fontSize} '${fontFamilyName}', monospace`

  const width = c.measureText(text).width

  const heightMetrics = c.measureText('Mg')
  const height = Math.ceil(heightMetrics.actualBoundingBoxAscent + heightMetrics.actualBoundingBoxDescent)
  const fontHeight = Math.ceil(heightMetrics.fontBoundingBoxAscent + heightMetrics.fontBoundingBoxDescent)

  c.restore()

  measureTextCache.set(cacheKey, { width, height, fontHeight })
  return { width, height, fontHeight }
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
