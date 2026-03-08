import { getLineCacheKey } from '../caches.ts'
import { type Context } from '../context.ts'
import type { VisualLine } from '../lines.ts'
import { measureVisualTokens } from '../measure.ts'
import { drawErrorSquiggles } from './squiggle.ts'
import { drawToken } from './token.ts'
import {
  calculateAboveHeightForLine,
  drawAboveWidgets,
  drawBeforeAfterWidgets,
  drawBelowWidgets,
  drawFullWidgets,
  drawInlayWidgets,
  drawOverlayWidgets,
  shouldBreakBottom,
} from './widget.ts'

function lowerBoundVisualLineBottomAtLeast(visualLines: VisualLine[], minBottomY: number): number {
  let low = 0
  let high = visualLines.length

  while (low < high) {
    const mid = (low + high) >> 1
    const line = visualLines[mid]
    if (line.y + line.height < minBottomY) {
      low = mid + 1
    }
    else {
      high = mid
    }
  }

  return low
}

function isBraceOrQuoteChar(char: string) {
  switch (char) {
    case '{':
    case '(':
    case '[':
    case '}':
    case ')':
    case ']':
    case '\'':
    case '"':
    case '`':
      return true
    default:
      return false
  }
}

export function drawLine(
  context: Context,
  line: VisualLine,
) {
  const { canvas, settings, caches } = context
  const { c, dpr } = canvas
  const { lineCanvasCache, lineCanvasCacheByLine } = caches

  const logicalLine = line.logicalLine
  const visualTokens = line.tokens
  const lineCacheKey = getLineCacheKey(context, visualTokens)

  let needsRedraw = false

  let lineCanvas = lineCanvasCacheByLine.get(logicalLine)
  const cachedLineCanvas = lineCanvasCache.get(lineCacheKey)

  if (cachedLineCanvas) {
    lineCanvas = cachedLineCanvas
    lineCanvas.lineCacheKey = lineCacheKey
    lineCanvasCacheByLine.set(logicalLine, lineCanvas)
  }
  else if (!lineCanvas) {
    needsRedraw = true
    const metrics = measureVisualTokens(c, settings, caches, visualTokens)
    const lineWidth = Math.max(metrics.width, line.width)

    const offscreenCanvas = new OffscreenCanvas(lineWidth * dpr.value, metrics.height * dpr.value)
    lineCanvas = {
      lineCacheKey,
      canvas: offscreenCanvas,
      c: offscreenCanvas.getContext('2d'),
    }
    lineCanvas.c.setTransform(dpr.value, 0, 0, dpr.value, 0, 0)
    lineCanvasCacheByLine.set(logicalLine, lineCanvas)
    lineCanvasCache.set(lineCacheKey, lineCanvas)
  }
  else if (lineCanvas.lineCacheKey !== lineCacheKey) {
    needsRedraw = true
    const metrics = measureVisualTokens(c, settings, caches, visualTokens)
    const lineWidth = Math.max(metrics.width, line.width)

    const { canvas: offscreenCanvas, c: offscreenContext } = lineCanvas
    const targetWidth = lineWidth * dpr.value
    const targetHeight = metrics.height * dpr.value
    const needsResize = offscreenCanvas.width !== targetWidth || offscreenCanvas.height !== targetHeight
    if (needsResize) {
      offscreenCanvas.width = targetWidth
      offscreenCanvas.height = targetHeight
    }

    offscreenContext.setTransform(dpr.value, 0, 0, dpr.value, 0, 0)
    if (!needsResize) {
      offscreenContext.clearRect(0, 0, targetWidth / dpr.value, targetHeight / dpr.value)
    }

    lineCanvasCache.delete(lineCanvas.lineCacheKey)
    lineCanvas.lineCacheKey = lineCacheKey
    lineCanvasCache.set(lineCacheKey, lineCanvas)
  }

  if (needsRedraw) {
    const { c } = lineCanvas
    const tokenLines = context.doc.tokenLines
    const logicalLineTokens = tokenLines[logicalLine] || []
    const blockColors = context.settings.ui.blockColors

    for (const visualToken of visualTokens) {
      const { token, x, logicalTokenIndex } = visualToken
      const logicalToken = logicalLineTokens[logicalTokenIndex]

      let colorOverride: string | undefined
      if (logicalToken && logicalToken.type !== 'comment' && token.type !== 'comment' && token.text.length === 1) {
        const char = token.text
        if (isBraceOrQuoteChar(char)) {
          const charIndex = logicalToken.text.indexOf(char)
          if (charIndex !== -1) {
            const depth = context.blocks.getBraceDepthForPosition(logicalLine, logicalTokenIndex, charIndex)
            if (depth !== null) {
              colorOverride = blockColors[depth % blockColors.length]
            }
            else {
              colorOverride = 'red'
            }
          }
        }
      }

      drawToken(c, context, token, x, 2, colorOverride)
    }
  }

  const aboveHeight = calculateAboveHeightForLine(context, line)
  const contentY = line.tokenOffset === 0 ? line.y : line.y + aboveHeight

  drawFullWidgets(context, line)
  drawAboveWidgets(context, line)
  drawOverlayWidgets(context, line)
  drawInlayWidgets(context, line)
  drawBeforeAfterWidgets(context, line)
  drawBelowWidgets(context, line)
  drawErrorSquiggles(context, line)

  c.drawImage(
    lineCanvas.canvas,
    0,
    contentY,
    lineCanvas.canvas.width / dpr.value,
    lineCanvas.canvas.height / dpr.value,
  )
}

export function drawLines(context: Context) {
  const visualLines = context.lines.visualLines.value
  if (visualLines.length === 0) return
  const { size: { height: { value: height } } } = context.canvas
  const { paddingTop } = context.settings
  const { y } = context.scroll.pos
  const headerHeight = context.header.value?.height ?? 0
  const visibleTop = -headerHeight - paddingTop
  const visibleBottom = height - paddingTop
  const startIndex = lowerBoundVisualLineBottomAtLeast(visualLines, visibleTop - y)
  if (startIndex >= visualLines.length) return

  for (let i = startIndex; i < visualLines.length; i++) {
    const line = visualLines[i]
    const lineY = line.y + y
    if (shouldBreakBottom(visualLines, line, lineY, visibleBottom, y)) break
    drawLine(context, line)
  }
}
