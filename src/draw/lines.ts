import { getLineCacheKey } from '../caches.ts'
import { type Context } from '../context.ts'
import { ligatures } from '../ligature.ts'
import type { VisualLine } from '../lines.ts'
import { measureVisualTokens } from '../measure.ts'
import type { Token } from '../token.ts'
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
} from './widget.ts'

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

const lastKnownBraceDepthByToken = new WeakMap<Token, Map<number, number>>()
const lastKnownBraceDepthBySignature = new Map<string, number>()
const MAX_BRACE_DEPTH_SIGNATURES = 20000
const braceNullTraceLastLogAt = new Map<string, number>()
const BRACE_NULL_TRACE_THROTTLE_MS = 150
const lineHasBraceCandidatesCache = new WeakMap<VisualLine, boolean>()
const lineHasLigatureCandidatesCache = new WeakMap<VisualLine, boolean>()
const IS_CHROME = navigator.userAgent.includes('Chrome')
const RUN_CONTIGUOUS_EPSILON = 0.001
const SCROLL_DIRECT_THRESHOLD_PX = 10

function isOffscreen2DContext(
  c: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
): c is OffscreenCanvasRenderingContext2D {
  return typeof OffscreenCanvas !== 'undefined' && c.canvas instanceof OffscreenCanvas
}

function getLastKnownBraceDepth(token: Token, charOffset: number): number | null {
  const perChar = lastKnownBraceDepthByToken.get(token)
  if (!perChar) return null
  const depth = perChar.get(charOffset)
  return depth === undefined ? null : depth
}

function setLastKnownBraceDepth(token: Token, charOffset: number, depth: number) {
  let perChar = lastKnownBraceDepthByToken.get(token)
  if (!perChar) {
    perChar = new Map<number, number>()
    lastKnownBraceDepthByToken.set(token, perChar)
  }
  perChar.set(charOffset, depth)
}

function clearLastKnownBraceDepth(token: Token, charOffset: number) {
  const perChar = lastKnownBraceDepthByToken.get(token)
  if (!perChar) return
  perChar.delete(charOffset)
  if (perChar.size === 0) lastKnownBraceDepthByToken.delete(token)
}

function makeBraceDepthSignature(lineText: string, column: number, char: string): string {
  return `${lineText}\u0000${column}\u0000${char}`
}

function getLastKnownBraceDepthBySignature(signature: string): number | null {
  const depth = lastKnownBraceDepthBySignature.get(signature)
  return depth === undefined ? null : depth
}

function setLastKnownBraceDepthBySignature(signature: string, depth: number) {
  if (!lastKnownBraceDepthBySignature.has(signature)
    && lastKnownBraceDepthBySignature.size >= MAX_BRACE_DEPTH_SIGNATURES)
  {
    const firstKey = lastKnownBraceDepthBySignature.keys().next().value
    if (typeof firstKey === 'string') lastKnownBraceDepthBySignature.delete(firstKey)
  }
  lastKnownBraceDepthBySignature.set(signature, depth)
}

function clearLastKnownBraceDepthBySignature(signature: string) {
  lastKnownBraceDepthBySignature.delete(signature)
}

function isBraceNullTraceEnabled(): boolean {
  const globalObj = globalThis as typeof globalThis & { __EDITOR_TRACE_NULL_BRACES?: boolean }
  return globalObj.__EDITOR_TRACE_NULL_BRACES === true
}

function logBraceNullTrace(
  key: string,
  payload: Record<string, unknown>,
) {
  const now = Date.now()
  const last = braceNullTraceLastLogAt.get(key) ?? 0
  if (now - last < BRACE_NULL_TRACE_THROTTLE_MS) return
  braceNullTraceLastLogAt.set(key, now)
  console.log('[brace-null-trace]', payload)
}

function lineHasBraceCandidates(line: VisualLine): boolean {
  const cached = lineHasBraceCandidatesCache.get(line)
  if (cached !== undefined) return cached

  const visualTokens = line.tokens
  for (let i = 0; i < visualTokens.length; i++) {
    const text = visualTokens[i].token.text
    if (text.length === 1 && isBraceOrQuoteChar(text)) {
      lineHasBraceCandidatesCache.set(line, true)
      return true
    }
  }
  lineHasBraceCandidatesCache.set(line, false)
  return false
}

function lineHasLigatureCandidates(line: VisualLine): boolean {
  if (!IS_CHROME) return false
  const cached = lineHasLigatureCandidatesCache.get(line)
  if (cached !== undefined) return cached

  const visualTokens = line.tokens
  for (let i = 0; i < visualTokens.length; i++) {
    if (ligatures.has(visualTokens[i].token.text)) {
      lineHasLigatureCandidatesCache.set(line, true)
      return true
    }
  }

  lineHasLigatureCandidatesCache.set(line, false)
  return false
}

function resolveDirectMode(targetDeltaX: number, targetDeltaY: number): boolean {
  return Math.max(targetDeltaX, targetDeltaY) > SCROLL_DIRECT_THRESHOLD_PX
}

export function drawLine(
  context: Context,
  line: VisualLine,
  directDraw = false,
) {
  const { canvas, settings, caches } = context
  const { c, dpr } = canvas
  const {
    lineCanvasCacheByLine,
    getLineCanvasSegmentKey,
    getLineCanvasBucketSize,
    acquireLineCanvas,
    markLineCanvasUsed,
  } = caches

  const logicalLine = line.logicalLine
  const visualTokens = line.tokens
  const tokenLines = context.doc.tokenLines
  const logicalLineTokens = tokenLines[logicalLine] || []
  const lineCacheKey = getLineCacheKey(context, line, logicalLineTokens)
  const lineCanvasSegmentKey = getLineCanvasSegmentKey(logicalLine, line.tokenOffset)
  const braceAnalysisVersion = context.blocks.getBraceAnalysisVersion()
  const tokenVersion = context.doc.tokenVersion
  const isBraceAnalysisCurrent = context.blocks.isBraceAnalysisCurrent()
  const hasBraceCandidates = lineHasBraceCandidates(line)
  const shouldDeferBraceOnlyRedraw = settings.performanceMode === 'stress' && logicalLine !== context.caret.line.value
  const aboveHeight = calculateAboveHeightForLine(context, line)
  const contentY = line.tokenOffset === 0 ? line.y : line.y + aboveHeight

  const drawLineDecorations = () => {
    drawFullWidgets(context, line)
    drawAboveWidgets(context, line)
    drawOverlayWidgets(context, line)
    drawInlayWidgets(context, line)
    drawBeforeAfterWidgets(context, line)
    drawBelowWidgets(context, line)
    drawErrorSquiggles(context, line)
  }

  const renderLineTokens = (
    targetCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    textY: number,
    allowLigatures: boolean,
  ) => {
    const theme = settings.theme
    const fallbackTokenStyle = theme.text
    const tokenRenderStyleByType = new Map<string, { font: string; color: string }>()

    const getTokenRenderStyle = (token: Token): { font: string; color: string } => {
      const cached = tokenRenderStyleByType.get(token.type)
      if (cached) return cached
      const tokenStyle = theme[token.type] ?? fallbackTokenStyle
      const fontWeight = tokenStyle.weight === 'bold' ? 700 : 400
      const style = {
        font: `${fontWeight} ${tokenStyle.style} ${settings.fontSize} '${settings.fontFamilyName}', monospace`,
        color: tokenStyle.color,
      }
      tokenRenderStyleByType.set(token.type, style)
      return style
    }

    targetCtx.textBaseline = 'top'
    let currentFont = ''
    let currentFillStyle = ''
    let currentStrokeStyle = ''
    let strokeStyleInitialized = false
    let runFont = ''
    let runColor = ''
    let runText = ''
    let runStartX = 0
    let runEndX = 0

    const flushRun = () => {
      if (runText.length === 0) return
      if (currentFont !== runFont) {
        targetCtx.font = runFont
        currentFont = runFont
      }
      if (currentFillStyle !== runColor) {
        targetCtx.fillStyle = runColor
        currentFillStyle = runColor
      }
      if (currentStrokeStyle !== runColor) {
        targetCtx.strokeStyle = runColor
        currentStrokeStyle = runColor
      }
      if (!strokeStyleInitialized) {
        targetCtx.lineWidth = 0.2
        targetCtx.lineCap = 'round'
        targetCtx.lineJoin = 'miter'
        targetCtx.miterLimit = 3
        strokeStyleInitialized = true
      }
      targetCtx.fillText(runText, runStartX, textY)
      targetCtx.strokeText(runText, runStartX, textY)
      runText = ''
      runStartX = 0
      runEndX = 0
      runFont = ''
      runColor = ''
    }

    const drawRenderedToken = (
      token: Token,
      x: number,
      endX: number,
      colorOverride?: string,
    ) => {
      if (
        allowLigatures
        && IS_CHROME
        && ligatures.has(token.text)
        && isOffscreen2DContext(targetCtx)
      ) {
        flushRun()
        drawToken(targetCtx, context, token, x, textY, colorOverride)
        currentFont = ''
        currentFillStyle = ''
        return
      }

      const tokenRenderStyle = getTokenRenderStyle(token)
      const font = tokenRenderStyle.font
      const color = colorOverride ?? tokenRenderStyle.color
      if (
        runText.length > 0
        && runFont === font
        && runColor === color
        && x >= runEndX - RUN_CONTIGUOUS_EPSILON
        && x <= runEndX + RUN_CONTIGUOUS_EPSILON
      ) {
        runText += token.text
        runEndX = endX
        return
      }

      flushRun()
      runFont = font
      runColor = color
      runStartX = x
      runEndX = endX
      runText = token.text
    }

    if (!hasBraceCandidates) {
      for (let i = 0; i < visualTokens.length; i++) {
        const visualToken = visualTokens[i]
        drawRenderedToken(visualToken.token, visualToken.x, visualToken.tokenEndX)
      }
      flushRun()
      return
    }

    let logicalLineText = ''
    for (let i = 0; i < logicalLineTokens.length; i++) {
      logicalLineText += logicalLineTokens[i]?.text ?? ''
    }
    const blockColors = context.settings.ui.blockColors
    const tokenStartColumns = new Array<number>(logicalLineTokens.length + 1)
    tokenStartColumns[0] = 0
    for (let i = 0; i < logicalLineTokens.length; i++) {
      tokenStartColumns[i + 1] = tokenStartColumns[i] + (logicalLineTokens[i]?.text.length ?? 0)
    }

    const getColumnFromTokenLocation = (tokenIndex: number, charIndex: number): number => {
      const boundedTokenIndex = Math.max(0, Math.min(tokenIndex, logicalLineTokens.length))
      const tokenStart = tokenStartColumns[boundedTokenIndex] ?? 0
      return tokenStart + Math.max(0, charIndex)
    }

    const getDepthFromMatchingBraceAtColumn = (column: number): number | null => {
      const matchAfter = context.blocks.findMatchingBrace(logicalLine, column + 1)
      if (matchAfter) {
        if (matchAfter.line === logicalLine) {
          const openColumn = getColumnFromTokenLocation(matchAfter.tokenIndex, matchAfter.charIndex)
          if (openColumn === column) return matchAfter.depth
        }
        if (matchAfter.matchingLine === logicalLine) {
          const closeColumn = getColumnFromTokenLocation(matchAfter.matchingTokenIndex, matchAfter.matchingCharIndex)
          if (closeColumn === column) return matchAfter.depth
        }
      }

      const matchAt = context.blocks.findMatchingBrace(logicalLine, column)
      if (matchAt) {
        if (matchAt.line === logicalLine) {
          const openColumn = getColumnFromTokenLocation(matchAt.tokenIndex, matchAt.charIndex)
          if (openColumn === column) return matchAt.depth
        }
        if (matchAt.matchingLine === logicalLine) {
          const closeColumn = getColumnFromTokenLocation(matchAt.matchingTokenIndex, matchAt.matchingCharIndex)
          if (closeColumn === column) return matchAt.depth
        }
      }

      return null
    }

    let tokenColumnStart = visualTokens.length > 0
      ? getColumnFromTokenLocation(visualTokens[0].logicalTokenIndex, visualTokens[0].logicalCharOffset)
      : 0

    for (let i = 0; i < visualTokens.length; i++) {
      const visualToken = visualTokens[i]
      const { token, x, logicalTokenIndex, logicalCharOffset } = visualToken
      const logicalToken = logicalLineTokens[logicalTokenIndex]
      const currentColumn = tokenColumnStart

      let colorOverride: string | undefined
      if (logicalToken && logicalToken.type !== 'comment' && token.type !== 'comment' && token.text.length === 1) {
        const char = token.text
        if (isBraceOrQuoteChar(char)) {
          const depthToken = logicalToken ?? token
          const signature = makeBraceDepthSignature(logicalLineText, currentColumn, char)
          let depth = context.blocks.getBraceDepthForPosition(logicalLine, logicalTokenIndex, logicalCharOffset)
          if (depth === null && !isBraceAnalysisCurrent) {
            depth = getDepthFromMatchingBraceAtColumn(currentColumn)
          }
          if (depth === null && !isBraceAnalysisCurrent) {
            depth = getLastKnownBraceDepth(depthToken, logicalCharOffset)
          }
          if (depth === null && !isBraceAnalysisCurrent) {
            depth = getLastKnownBraceDepthBySignature(signature)
          }
          if (depth !== null) {
            setLastKnownBraceDepth(depthToken, logicalCharOffset, depth)
            setLastKnownBraceDepthBySignature(signature, depth)
            colorOverride = blockColors[depth % blockColors.length]
          }
          else if (isBraceAnalysisCurrent) {
            clearLastKnownBraceDepth(depthToken, logicalCharOffset)
            clearLastKnownBraceDepthBySignature(signature)
            colorOverride = 'red'
          }

          if (depth === null && !isBraceAnalysisCurrent && isBraceNullTraceEnabled()) {
            const probe = context.blocks.debugBraceProbe?.(logicalLine, currentColumn + 1) ?? null
            const traceKey = `${logicalLine}:${currentColumn}:${char}:${tokenVersion}:${braceAnalysisVersion}`
            logBraceNullTrace(traceKey, {
              logicalLine,
              tokenIndex: logicalTokenIndex,
              charOffset: logicalCharOffset,
              column: currentColumn,
              char,
              tokenText: token.text,
              tokenVersion,
              braceAnalysisVersion,
              isBraceAnalysisCurrent,
              probe,
            })
          }
        }
      }

      drawRenderedToken(token, x, visualToken.tokenEndX, colorOverride)
      tokenColumnStart += token.text.length
    }
    flushRun()
  }

  const shouldUseDirectDraw = directDraw
  if (shouldUseDirectDraw) {
    drawLineDecorations()
    renderLineTokens(c, contentY + 2, false)
    return
  }

  let needsRedraw = false

  let lineCanvas = lineCanvasCacheByLine.get(lineCanvasSegmentKey)
  if (!lineCanvas) {
    needsRedraw = true
    const metrics = measureVisualTokens(c, settings, caches, visualTokens)
    const lineWidth = Math.max(metrics.width, line.width)
    lineCanvas = acquireLineCanvas(lineWidth * dpr.value, metrics.height * dpr.value, dpr.value)
    lineCanvas.lineCacheKey = lineCacheKey
    lineCanvasCacheByLine.set(lineCanvasSegmentKey, lineCanvas)
  }
  else if (lineCanvas.lineCacheKey !== lineCacheKey) {
    needsRedraw = true
    const metrics = measureVisualTokens(c, settings, caches, visualTokens)
    const lineWidth = Math.max(metrics.width, line.width)
    const bucketSize = getLineCanvasBucketSize(lineWidth * dpr.value, metrics.height * dpr.value)

    const { canvas: offscreenCanvas, c: offscreenContext } = lineCanvas
    const needsResize = offscreenCanvas.width !== bucketSize.width || offscreenCanvas.height !== bucketSize.height
    if (needsResize) {
      offscreenCanvas.width = bucketSize.width
      offscreenCanvas.height = bucketSize.height
      offscreenContext.setTransform(dpr.value, 0, 0, dpr.value, 0, 0)
    }
    if (!needsResize) {
      offscreenContext.clearRect(0, 0, offscreenCanvas.width / dpr.value, offscreenCanvas.height / dpr.value)
    }
    lineCanvas.lineCacheKey = lineCacheKey
  }
  if (!lineCanvas) return
  markLineCanvasUsed(lineCanvasSegmentKey)
  if (
    !needsRedraw
    && lineCanvas
    && hasBraceCandidates
    && braceAnalysisVersion >= 0
    && (
      lineCanvas.braceAnalysisVersion !== braceAnalysisVersion
      || (
        lineCanvas.braceRenderTokenVersion !== tokenVersion
        && lineCanvas.braceRenderTokenRef !== logicalLineTokens
      )
    )
  ) {
    if (shouldDeferBraceOnlyRedraw) {
      lineCanvas.braceAnalysisVersion = braceAnalysisVersion
      lineCanvas.braceRenderTokenVersion = tokenVersion
      lineCanvas.braceRenderTokenRef = logicalLineTokens
    }
    else {
      needsRedraw = true
      const { canvas: offscreenCanvas, c: offscreenContext } = lineCanvas
      offscreenContext.clearRect(0, 0, offscreenCanvas.width / dpr.value, offscreenCanvas.height / dpr.value)
    }
  }

  if (needsRedraw) {
    renderLineTokens(lineCanvas.c, 2, true)
    lineCanvas.braceAnalysisVersion = braceAnalysisVersion
    lineCanvas.braceRenderTokenVersion = tokenVersion
    lineCanvas.braceRenderTokenRef = logicalLineTokens
  }

  drawLineDecorations()

  c.drawImage(
    lineCanvas.canvas,
    0,
    contentY,
    lineCanvas.canvas.width / dpr.value,
    lineCanvas.canvas.height / dpr.value,
  )
}

export function drawLines(context: Context) {
  const { size: { height: { value: height } } } = context.canvas
  const { paddingTop } = context.settings
  const { x, y } = context.scroll.pos
  const scrollDeltaX = Math.abs(context.scroll.targetX.value - x)
  const scrollDeltaY = Math.abs(context.scroll.targetY.value - y)
  const useDirectDraw = resolveDirectMode(scrollDeltaX, scrollDeltaY)
  const headerHeight = context.header.value?.height ?? 0
  const visibleTop = -headerHeight - paddingTop
  const visibleBottom = height - paddingTop
  const approximateVisibleRange = context.lines.getApproxVisibleLogicalRange(visibleTop, visibleBottom, y)
  let optimisticViewportRetokenized = false
  if (approximateVisibleRange) {
    optimisticViewportRetokenized = context.doc.optimisticallyTokenizeViewport(
      approximateVisibleRange.start,
      approximateVisibleRange.end,
    )
  }

  let visualLines = context.lines.getVisibleVisualLines(visibleTop, visibleBottom, y)
  if (!approximateVisibleRange && visualLines.length > 0) {
    let startLine = visualLines[0].logicalLine
    let endLine = startLine
    for (let i = 1; i < visualLines.length; i++) {
      const logicalLine = visualLines[i].logicalLine
      if (logicalLine < startLine) startLine = logicalLine
      if (logicalLine > endLine) endLine = logicalLine
    }
    optimisticViewportRetokenized = context.doc.optimisticallyTokenizeViewport(startLine, endLine)
  }
  if (optimisticViewportRetokenized) {
    visualLines = context.lines.getVisibleVisualLines(visibleTop, visibleBottom, y)
  }
  if (visualLines.length === 0) return
  if (!useDirectDraw) {
    context.caches.setLineCanvasBudget(Math.max(64, visualLines.length * 3))
  }
  for (let i = 0; i < visualLines.length; i++) {
    drawLine(context, visualLines[i], useDirectDraw)
  }
  if (!useDirectDraw) {
    context.caches.trimLineCanvasesToBudget()
  }
}
