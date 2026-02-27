import { computed, effect, type Signal, signal } from '@preact/signals-core'
import type { Blocks } from './blocks.ts'
import { type Caches, getWrapTokensCacheKey } from './caches.ts'
import type { Canvas } from './canvas.ts'
import type { Doc, DocError } from './doc.ts'
import { VERTICAL_SCROLLBAR_SIZE } from './draw/scrollbar.ts'
import type { Header } from './header.ts'
import { getCharOffsetForVisualLine, isLineEmpty } from './line-utils.ts'
import { measureText } from './measure.ts'
import type { Metrics } from './metrics.ts'
import type { Settings } from './settings.ts'
import type { Token } from './token.ts'
import type { Widget } from './widget.ts'

function createTokenColumnPrefix(tokens: Token[]): number[] {
  const prefix = new Array(tokens.length + 1)
  prefix[0] = 0
  for (let i = 0; i < tokens.length; i++) {
    prefix[i + 1] = prefix[i] + tokens[i].text.length
  }
  return prefix
}

function applyAboveWidgetSpace(
  doc: Doc,
  visualLines: VisualLine[],
  widgetsByLogicalLine: Map<number, Widget[]>,
): VisualLine[] {
  const aboveSpaceByLogicalLine = new Map<number, number>()

  let consecutiveEmptyHeight = 0
  for (let i = 0; i < visualLines.length; i++) {
    const line = visualLines[i]

    if (line.tokenOffset === 0 && !aboveSpaceByLogicalLine.has(line.logicalLine)) {
      const aboveHeight = consecutiveEmptyHeight
      if (aboveHeight > 0) {
        const lineWidgets = widgetsByLogicalLine.get(line.logicalLine)
        if (lineWidgets && lineWidgets.length > 0) {
          let hasAboveOrFull = false
          for (let j = 0; j < lineWidgets.length; j++) {
            const t = lineWidgets[j].type
            if (t === 'above' || t === 'full') {
              hasAboveOrFull = true
              break
            }
          }
          if (hasAboveOrFull) {
            aboveSpaceByLogicalLine.set(line.logicalLine, aboveHeight)
          }
        }
      }
    }

    if (isLineEmpty(line)) {
      consecutiveEmptyHeight += line.height
    }
    else {
      consecutiveEmptyHeight = 0
    }
  }

  if (aboveSpaceByLogicalLine.size === 0) return visualLines

  const result: VisualLine[] = []
  let currentY = 0

  for (let i = 0; i < visualLines.length; i++) {
    const line = visualLines[i]
    const aboveHeight = aboveSpaceByLogicalLine.get(line.logicalLine) || 0
    let newHeight = line.height

    if (aboveHeight > 0 && line.tokenOffset > 0 && line.widgets.above.length > 0) {
      const tokenLines = doc.tokenLines
      const lineStartColumn = getCharOffsetForVisualLine(line.logicalLine, line, tokenLines, undefined)
      let lineEndColumn = lineStartColumn
      for (let j = 0; j < line.tokens.length; j++) {
        lineEndColumn += line.tokens[j].token.text.length
      }

      const hasWidgetsOnThisLine = line.widgets.above.some(widget => {
        const [startColumn, endColumn] = widget.pos.x
        const startCol0 = startColumn - 1
        const endCol0 = endColumn - 1
        return startCol0 < lineEndColumn && endCol0 > lineStartColumn
      })

      if (hasWidgetsOnThisLine) newHeight = line.height + aboveHeight
    }

    result.push({
      ...line,
      y: currentY,
      height: newHeight,
    })

    currentY += newHeight
  }

  return result
}

function createVisualLineFromCurrent(
  currentLine: Token[],
  tokenOffset: number,
  y: number,
  logicalLine: number,
  c: CanvasRenderingContext2D,
  settings: Settings,
  caches: Caches,
  lineWidgets: Widget[],
  lineErrors: DocError[],
  inlineWidgetWidthIndex: InlineWidgetWidthIndex,
  logicalColumnPrefix: number[],
  logicalTokenIndices?: number[],
  currentLineTokenWidths?: number[],
): VisualLine {
  const lineStartColumn = logicalColumnPrefix[tokenOffset] ?? 0
  let lineEndColumn = lineStartColumn
  for (let i = 0; i < currentLine.length; i++) {
    lineEndColumn += currentLine[i].text.length
  }

  const visualTokens = calculateVisualTokens(c, settings, caches, currentLine, tokenOffset, inlineWidgetWidthIndex,
    logicalColumnPrefix, logicalTokenIndices, currentLineTokenWidths)
  const calculatedWidth = visualTokens.length > 0 ? visualTokens[visualTokens.length - 1]?.endX || 0 : 0

  const aboveWidgets: (Widget & { type: 'above' })[] = []
  const belowWidgets: (Widget & { type: 'below' })[] = []
  const overlayWidgets: (Widget & { type: 'overlay' })[] = []
  const fullWidgets: (Widget & { type: 'full' })[] = []
  const beforeAfterWidgets: (Widget & ({ type: 'before' } | { type: 'after' }))[] = []
  const inlayWidgets: (Widget & { type: 'inlay' })[] = []

  for (let i = 0; i < lineWidgets.length; i++) {
    const widget = lineWidgets[i]
    if (widget.type === 'above') {
      const [startColumn] = widget.pos.x
      const startCol0 = startColumn - 1
      if (startCol0 >= lineStartColumn && startCol0 < lineEndColumn) {
        aboveWidgets.push(widget)
      }
    }
    else if (widget.type === 'below') {
      const [startColumn] = widget.pos.x
      const startCol0 = startColumn - 1
      if (startCol0 >= lineStartColumn && startCol0 < lineEndColumn) {
        belowWidgets.push(widget)
      }
    }
    else if (widget.type === 'overlay') {
      const [startColumn] = widget.pos.x
      const startCol0 = startColumn - 1
      if (startCol0 >= lineStartColumn && startCol0 < lineEndColumn) {
        overlayWidgets.push(widget)
      }
    }
    else if (widget.type === 'full') {
      fullWidgets.push(widget)
    }
    else if (widget.type === 'before' || widget.type === 'after') {
      const widgetColumn = widget.pos.x - 1
      if (widgetColumn >= lineStartColumn && widgetColumn <= lineEndColumn) {
        beforeAfterWidgets.push(widget)
      }
    }
    else if (widget.type === 'inlay') {
      const widgetColumn = widget.pos.x - 1
      if (widgetColumn >= lineStartColumn && widgetColumn <= lineEndColumn) {
        inlayWidgets.push(widget)
      }
    }
  }

  const lineHeight = settings.lineHeight * (belowWidgets.length > 0 ? 2 : 1)

  const filteredErrors: DocError[] = []
  for (let i = 0; i < lineErrors.length; i++) {
    const error = lineErrors[i]
    const [errorStartColumn, errorEndColumn] = [error.x[0] - 1, error.x[1] - 1]
    if (errorStartColumn <= lineEndColumn && errorEndColumn > lineStartColumn) {
      filteredErrors.push(error)
    }
  }

  return {
    tokens: visualTokens,
    logicalLine,
    tokenOffset,
    y,
    width: calculatedWidth,
    height: lineHeight,
    widgets: {
      above: aboveWidgets,
      below: belowWidgets,
      overlay: overlayWidgets,
      inlay: inlayWidgets,
      beforeAfter: beforeAfterWidgets,
      full: fullWidgets,
    },
    errors: filteredErrors,
  }
}

function filterErrorsFromLine(
  lineErrors: DocError[],
  tokenOffset: number,
  lineLength: number,
  logicalLineTokens: Token[],
): DocError[] {
  const logicalColumnPrefix = createTokenColumnPrefix(logicalLineTokens)
  const lineStartColumn = logicalColumnPrefix[tokenOffset] ?? 0
  const lineEndColumn = logicalColumnPrefix[tokenOffset + lineLength] ?? lineStartColumn
  const out: DocError[] = []
  for (let i = 0; i < lineErrors.length; i++) {
    const error = lineErrors[i]
    const [errorStartColumn, errorEndColumn] = [error.x[0] - 1, error.x[1] - 1]
    if (errorStartColumn <= lineEndColumn && errorEndColumn > lineStartColumn) out.push(error)
  }
  return out
}

function calculateVisualTokens(
  c: CanvasRenderingContext2D,
  settings: Settings,
  caches: Caches,
  tokens: Token[],
  tokenOffset: number,
  inlineWidgetWidthIndex: InlineWidgetWidthIndex,
  logicalColumnPrefix: number[],
  logicalTokenIndices?: number[],
  tokenWidths?: number[],
): VisualToken[] {
  const visualTokens: VisualToken[] = []
  let x = 0

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const logicalTokenIndex = logicalTokenIndices ? logicalTokenIndices[i] : tokenOffset + i

    const tokenStartColumn = logicalColumnPrefix[logicalTokenIndex] ?? 0
    const tokenEndColumn = logicalColumnPrefix[logicalTokenIndex + 1] ?? tokenStartColumn

    const beforeWidth = inlineWidgetWidthIndex.before.get(tokenStartColumn) ?? 0
    const afterWidth = inlineWidgetWidthIndex.after.get(tokenEndColumn) ?? 0
    const inlayWidth = inlineWidgetWidthIndex.inlay.get(tokenEndColumn) ?? 0

    const tokenStartX = x + beforeWidth
    const tokenWidth = tokenWidths ? tokenWidths[i] : measureText(c, settings, caches, token).width
    const tokenEndX = tokenStartX + tokenWidth
    x = tokenEndX + afterWidth + inlayWidth

    visualTokens.push({
      token,
      x: tokenStartX,
      tokenEndX,
      endX: x,
      logicalTokenIndex,
    })
  }

  return visualTokens
}

type InlineWidgetWidthIndex = {
  before: Map<number, number>
  after: Map<number, number>
  inlay: Map<number, number>
}

function createInlineWidgetWidthIndex(
  c: CanvasRenderingContext2D,
  settings: Settings,
  caches: Caches,
  widgets: (Widget & ({ type: 'before' } | { type: 'after' } | { type: 'inlay' }))[],
): InlineWidgetWidthIndex {
  const before = new Map<number, number>()
  const after = new Map<number, number>()
  const inlay = new Map<number, number>()

  for (const widget of widgets) {
    const column = widget.pos.x - 1
    if (widget.type === 'before') {
      before.set(column, (before.get(column) ?? 0) + widget.pos.width)
    }
    else if (widget.type === 'after') {
      after.set(column, (after.get(column) ?? 0) + widget.pos.width)
    }
    else if (widget.type === 'inlay') {
      const { width: widgetWidth } = measureText(c, settings, caches, { text: widget.content, type: 'text' })
      inlay.set(column, (inlay.get(column) ?? 0) + widgetWidth)
    }
  }

  return { before, after, inlay }
}

function breakToken(
  c: CanvasRenderingContext2D,
  settings: Settings,
  caches: Caches,
  token: Token,
  maxWidth: number,
): Token[] {
  const tokenWidth = measureText(c, settings, caches, token).width
  if (tokenWidth <= maxWidth) {
    return [token]
  }

  const text = token.text
  const parts: Token[] = []
  let start = 0

  const {
    fontSize,
    fontFamilyName,
    theme: { [token.type]: { style, weight } },
  } = settings

  const punct = '.,;:!?-_/\\|()[]{}<>=+*&%$#@^~`"\''
  const isBreakPunct = (ch: string) => punct.includes(ch)

  c.save()
  c.font = `${weight === 'bold' ? 700 : 400} ${style} ${fontSize} '${fontFamilyName}', monospace`

  const measureWidth = (from: number, to: number) => c.measureText(text.slice(from, to)).width

  while (start < text.length) {
    let best = start

    if (measureWidth(start, start + 1) <= maxWidth) {
      let lo = start + 1
      let hi = text.length
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const w = measureWidth(start, mid)
        if (w <= maxWidth) {
          best = mid
          lo = mid + 1
        }
        else {
          hi = mid - 1
        }
      }
    }

    if (best === start) best = start + 1

    let breakPos = best

    for (let i = best - 1; i >= start; i--) {
      const ch = text[i]
      if (ch === ' ' || ch === '\t') {
        breakPos = i + 1
        break
      }
    }

    if (breakPos === best) {
      for (let i = start; i < best; i++) {
        if (isBreakPunct(text[i])) {
          breakPos = i + 1
          break
        }
      }
    }

    if (breakPos === start) breakPos = start + 1

    parts.push({ type: token.type, text: text.slice(start, breakPos) })
    start = breakPos
  }

  c.restore()

  return parts.length > 0 ? parts : [token]
}

export interface VisualToken {
  token: Token
  x: number
  tokenEndX: number
  endX: number
  logicalTokenIndex: number
}

export interface VisualLine {
  tokens: VisualToken[]
  logicalLine: number
  tokenOffset: number
  y: number
  width: number
  height: number
  widgets: {
    above: (Widget & { type: 'above' })[]
    below: (Widget & { type: 'below' })[]
    overlay: (Widget & { type: 'overlay' })[]
    inlay: (Widget & { type: 'inlay' })[]
    beforeAfter: (Widget & ({ type: 'before' } | { type: 'after' }))[]
    full: (Widget & { type: 'full' })[]
  }
  errors: DocError[]
}

function applyCachedY(cached: VisualLine[], y: number): VisualLine[] {
  const baseY = cached[0]?.y ?? y
  const yOffset = y - baseY
  if (yOffset === 0) return cached
  return cached.map(line => ({ ...line, y: line.y + yOffset }))
}

function wrapTokens(
  c: CanvasRenderingContext2D,
  settings: Settings,
  caches: Caches,
  tokenLines: Token[][],
  tokens: Token[],
  logicalLine: number,
  y: number,
  maxWidth: number,
  lineWidgets: Widget[],
  lineErrors: DocError[],
): VisualLine[] {
  const { wrapTokensCache, wrapTokensCacheByLine } = caches
  const cacheKey = getWrapTokensCacheKey(tokens, logicalLine, maxWidth, lineWidgets, lineErrors, settings)

  if (wrapTokensCache) {
    if (wrapTokensCacheByLine) {
      const existingKey = wrapTokensCacheByLine.get(logicalLine)
      if (existingKey === cacheKey) {
        const cached = wrapTokensCache.get(existingKey)
        if (cached) return applyCachedY(cached, y)
      }
    }

    const cached = wrapTokensCache.get(cacheKey)
    if (cached) {
      if (wrapTokensCacheByLine) {
        wrapTokensCacheByLine.set(logicalLine, cacheKey)
      }
      return applyCachedY(cached, y)
    }
  }

  if (tokens.length === 0) {
    const aboveWidgets = (lineWidgets.filter(w => w.type === 'above') as (Widget & { type: 'above' })[]).filter(widget => {
      const [startColumn, endColumn] = widget.pos.x
      const startCol0 = startColumn - 1
      const endCol0 = endColumn - 1
      return startCol0 <= 0 && endCol0 > 0
    })
    const result = [{
      tokens: [],
      logicalLine,
      tokenOffset: 0,
      y,
      width: 0,
      height: settings.lineHeight,
      widgets: {
        above: aboveWidgets,
        below: [],
        overlay: [],
        inlay: [],
        beforeAfter: [],
        full: [],
      },
      errors: filterErrorsFromLine(lineErrors, 0, 0, tokenLines[logicalLine] ?? []),
    }]
    if (wrapTokensCache) {
      wrapTokensCache.set(cacheKey, result)
      if (wrapTokensCacheByLine) {
        wrapTokensCacheByLine.set(logicalLine, cacheKey)
      }
    }
    return result
  }

  const visualLines: VisualLine[] = []
  const currentLine: Token[] = []
  const currentLineLogicalIndices: number[] = []
  const inlineWidgets = lineWidgets.filter(w =>
    w.type === 'before' || w.type === 'after' || w.type === 'inlay'
  ) as (Widget & ({ type: 'before' } | { type: 'after' } | { type: 'inlay' }))[]
  const inlineWidgetWidthIndex = createInlineWidgetWidthIndex(c, settings, caches, inlineWidgets)

  let currentY = y
  let currentLineWidth = 0
  const currentLineTokenWidths: number[] = []
  const logicalLineTokens = tokenLines[logicalLine] ?? []
  const logicalColumnPrefix = createTokenColumnPrefix(logicalLineTokens)

  function flushCurrentLine() {
    if (currentLine.length === 0) return
    const tokenOffset = currentLineLogicalIndices[0] ?? 0
    const visualLine = createVisualLineFromCurrent(
      currentLine,
      tokenOffset,
      currentY,
      logicalLine,
      c,
      settings,
      caches,
      lineWidgets,
      lineErrors,
      inlineWidgetWidthIndex,
      logicalColumnPrefix,
      currentLineLogicalIndices,
      currentLineTokenWidths,
    )
    visualLines.push(visualLine)
    currentY += visualLine.height
    currentLine.length = 0
    currentLineLogicalIndices.length = 0
    currentLineTokenWidths.length = 0
    currentLineWidth = 0
  }

  function tryAddTokenToCurrentLine(token: Token, logicalTokenIndex: number, tokenWidth: number) {
    const tokenStartColumn = logicalColumnPrefix[logicalTokenIndex] ?? 0
    const tokenEndColumn = logicalColumnPrefix[logicalTokenIndex + 1] ?? tokenStartColumn
    const beforeWidth = inlineWidgetWidthIndex.before.get(tokenStartColumn) ?? 0
    const afterWidth = inlineWidgetWidthIndex.after.get(tokenEndColumn) ?? 0
    const inlayWidth = inlineWidgetWidthIndex.inlay.get(tokenEndColumn) ?? 0
    const addedWidth = beforeWidth + tokenWidth + afterWidth + inlayWidth
    const newWidth = currentLineWidth + addedWidth

    if (newWidth > maxWidth && currentLine.length > 0) {
      flushCurrentLine()
      currentLineWidth = beforeWidth + tokenWidth + afterWidth + inlayWidth
      currentLine.push(token)
      currentLineLogicalIndices.push(logicalTokenIndex)
      currentLineTokenWidths.push(tokenWidth)
      return currentLineWidth
    }

    currentLineWidth = newWidth
    currentLine.push(token)
    currentLineLogicalIndices.push(logicalTokenIndex)
    currentLineTokenWidths.push(tokenWidth)
    return currentLineWidth
  }

  for (let logicalIndex = 0; logicalIndex < tokens.length; logicalIndex++) {
    const token = tokens[logicalIndex]
    const tokenWidth = measureText(c, settings, caches, token).width

    if (tokenWidth > maxWidth) {
      const brokenTokens = breakToken(c, settings, caches, token, maxWidth)
      for (let i = 0; i < brokenTokens.length; i++) {
        const brokenToken = brokenTokens[i]
        const brokenTokenWidth = measureText(c, settings, caches, brokenToken).width
        tryAddTokenToCurrentLine(brokenToken, logicalIndex, brokenTokenWidth)
      }
    }
    else {
      tryAddTokenToCurrentLine(token, logicalIndex, tokenWidth)
    }
  }

  flushCurrentLine()

  const result = visualLines.length > 0
    ? visualLines
    : [{
      tokens: [],
      logicalLine,
      tokenOffset: 0,
      y,
      width: 0,
      height: settings.lineHeight,
      widgets: {
        above: lineWidgets.filter(w => w.type === 'above') as (Widget & { type: 'above' })[],
        below: [],
        overlay: [],
        inlay: [],
        beforeAfter: [],
        full: lineWidgets.filter(w => w.type === 'full') as (Widget & { type: 'full' })[],
      },
      errors: filterErrorsFromLine(lineErrors, 0, 0, tokenLines[logicalLine] ?? []),
    } as VisualLine]

  if (wrapTokensCache) {
    wrapTokensCache.set(cacheKey, result)
    if (wrapTokensCacheByLine) {
      wrapTokensCacheByLine.set(logicalLine, cacheKey)
    }
  }

  return result
}

export type Lines = ReturnType<typeof createLines>

export function createLines(
  doc: Doc,
  canvas: Canvas,
  metrics: Metrics,
  settings: Settings,
  caches: Caches,
  blocks: Blocks,
  header: Signal<Header>,
) {
  const totalWidth = signal(0)
  const totalHeight = signal(0)

  const visualLines = computed(() => {
    const tokenLines = doc.tokenLines
    header.value
    const baseAvailableWidth = canvas.size.width.value - settings.paddingLeft - settings.paddingRight
      - metrics.gutterWidth.value
    const maxWidth = settings.wordWrap
      ? baseAvailableWidth - VERTICAL_SCROLLBAR_SIZE
      : Infinity

    const widgetsByLogicalLine = new Map<number, Widget[]>()
    for (const widget of doc.widgets) {
      const line = widget.pos.y - 1
      const existing = widgetsByLogicalLine.get(line)
      if (existing) {
        existing.push(widget)
      }
      else {
        widgetsByLogicalLine.set(line, [widget])
      }
    }

    const errorsByLogicalLine = new Map<number, DocError[]>()
    for (const error of doc.errors) {
      const line = error.y - 1
      const existing = errorsByLogicalLine.get(line)
      if (existing) {
        existing.push(error)
      }
      else {
        errorsByLogicalLine.set(line, [error])
      }
    }

    const visualLines: VisualLine[] = []
    let logicalLine = 0
    let maxLineWidth = 0
    let y = 0
    const collapsedLines = doc.collapsed

    let skipUntil = -1

    for (const tokens of tokenLines) {
      if (logicalLine > skipUntil) {
        const lineWidgets = widgetsByLogicalLine.get(logicalLine) ?? []
        const lineErrors = errorsByLogicalLine.get(logicalLine) ?? []

        const wrapped = wrapTokens(
          canvas.c,
          settings,
          caches,
          tokenLines,
          tokens,
          logicalLine,
          y,
          maxWidth,
          lineWidgets,
          lineErrors,
        )
        for (let i = 0; i < wrapped.length; i++) {
          visualLines.push(wrapped[i])
        }

        const last = wrapped[wrapped.length - 1]
        y = (last?.y ?? y) + (last?.height ?? 0)
        for (let i = 0; i < wrapped.length; i++) {
          if (wrapped[i].width > maxLineWidth) maxLineWidth = wrapped[i].width
        }

        if (collapsedLines.has(logicalLine)) {
          skipUntil = blocks.blockEnds.value.get(logicalLine) ?? -1
        }
      }

      logicalLine++
    }

    if (settings.wordWrap) {
      totalWidth.value = Math.min(maxLineWidth, baseAvailableWidth - VERTICAL_SCROLLBAR_SIZE)
    }
    else {
      totalWidth.value = maxLineWidth
    }

    const processedLines = applyAboveWidgetSpace(doc, visualLines, widgetsByLogicalLine)
    totalHeight.value = processedLines.length > 0
      ? processedLines[processedLines.length - 1].y + processedLines[processedLines.length - 1].height
      : y

    return processedLines
  })

  const visualLinesByLogicalLine = computed(() => {
    const map = new Map<number, VisualLine[]>()
    for (const line of visualLines.value) {
      const existing = map.get(line.logicalLine)
      if (existing) {
        existing.push(line)
      }
      else {
        map.set(line.logicalLine, [line])
      }
    }
    return map
  })

  effect(() => {
    settings.wordWrap
    totalWidth.value = 0
  })

  return { visualLines, visualLinesByLogicalLine, totalWidth, totalHeight }
}
