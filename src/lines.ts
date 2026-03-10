import { computed, type Signal, signal } from '@preact/signals-core'
import type { Blocks } from './blocks.ts'
import { type Caches, getWrapTokensCacheKey } from './caches.ts'
import type { Canvas } from './canvas.ts'
import type { Doc, DocError, DocIncrementalChange } from './doc.ts'
import { getVerticalScrollbarSize } from './draw/scrollbar.ts'
import type { Header } from './header.ts'
import { FenwickTree } from './lib/fenwick.ts'
import { getCharOffsetForVisualLine, isLineEmpty } from './line-utils.ts'
import { measureText } from './measure.ts'
import type { Metrics } from './metrics.ts'
import type { Settings } from './settings.ts'
import type { Token } from './token.ts'
import type { Widget } from './widget.ts'

const EMPTY_DOC_ERRORS: DocError[] = []
const EMPTY_WIDGETS: Widget[] = []
const EMPTY_TOKENS: Token[] = []
const EMPTY_VISUAL_LINES: VisualLine[] = []

interface WidgetsByLogicalLineIndex {
  map: Map<number, Widget[]>
  hasAboveOrFull: boolean
}

function buildWidgetsByLogicalLineIndex(widgets: Widget[]): WidgetsByLogicalLineIndex {
  const map = new Map<number, Widget[]>()
  let hasAboveOrFull = false
  for (let i = 0; i < widgets.length; i++) {
    const widget = widgets[i]
    const line = widget.pos.y - 1
    const existing = map.get(line)
    if (existing) existing.push(widget)
    else map.set(line, [widget])
    if (widget.type === 'above' || widget.type === 'full') hasAboveOrFull = true
  }
  return { map, hasAboveOrFull }
}

function buildErrorsByLogicalLineIndex(errors: DocError[]): Map<number, DocError[]> {
  const map = new Map<number, DocError[]>()
  for (let i = 0; i < errors.length; i++) {
    const error = errors[i]
    const line = error.y - 1
    const existing = map.get(line)
    if (existing) existing.push(error)
    else map.set(line, [error])
  }
  return map
}

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
    const logicalAboveHeight = aboveSpaceByLogicalLine.get(line.logicalLine) || 0
    const aboveHeight = line.widgets.above.length > 0 ? logicalAboveHeight : 0
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
      aboveHeight,
      logicalAboveHeight,
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
  logicalTokenCharOffsets?: number[],
  currentLineTokenWidths?: number[],
): VisualLine {
  const lineStartColumn = logicalColumnPrefix[tokenOffset] ?? 0
  let lineEndColumn = lineStartColumn
  for (let i = 0; i < currentLine.length; i++) {
    lineEndColumn += currentLine[i].text.length
  }

  const visualTokens = calculateVisualTokens(c, settings, caches, currentLine, tokenOffset, inlineWidgetWidthIndex,
    logicalColumnPrefix, logicalTokenIndices, logicalTokenCharOffsets, currentLineTokenWidths)
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

  let filteredErrors = EMPTY_DOC_ERRORS
  if (lineErrors.length > 0) {
    const out: DocError[] = []
    for (let i = 0; i < lineErrors.length; i++) {
      const error = lineErrors[i]
      const [errorStartColumn, errorEndColumn] = [error.x[0] - 1, error.x[1] - 1]
      if (errorStartColumn <= lineEndColumn && errorEndColumn > lineStartColumn) {
        out.push(error)
      }
    }
    if (out.length > 0) filteredErrors = out
  }

  return {
    tokens: visualTokens,
    logicalLine,
    tokenOffset,
    y,
    width: calculatedWidth,
    height: lineHeight,
    aboveHeight: 0,
    logicalAboveHeight: 0,
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
  if (lineErrors.length === 0) return EMPTY_DOC_ERRORS

  // Common fast path for empty visual lines.
  if (tokenOffset === 0 && lineLength === 0) {
    const out: DocError[] = []
    for (let i = 0; i < lineErrors.length; i++) {
      const error = lineErrors[i]
      const [errorStartColumn, errorEndColumn] = [error.x[0] - 1, error.x[1] - 1]
      if (errorStartColumn <= 0 && errorEndColumn > 0) out.push(error)
    }
    return out.length > 0 ? out : EMPTY_DOC_ERRORS
  }

  const logicalColumnPrefix = createTokenColumnPrefix(logicalLineTokens)
  const lineStartColumn = logicalColumnPrefix[tokenOffset] ?? 0
  const lineEndColumn = logicalColumnPrefix[tokenOffset + lineLength] ?? lineStartColumn
  const out: DocError[] = []
  for (let i = 0; i < lineErrors.length; i++) {
    const error = lineErrors[i]
    const [errorStartColumn, errorEndColumn] = [error.x[0] - 1, error.x[1] - 1]
    if (errorStartColumn <= lineEndColumn && errorEndColumn > lineStartColumn) out.push(error)
  }
  return out.length > 0 ? out : EMPTY_DOC_ERRORS
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
  logicalTokenCharOffsets?: number[],
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
      logicalCharOffset: logicalTokenCharOffsets ? (logicalTokenCharOffsets[i] ?? 0) : 0,
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
  logicalCharOffset: number
}

export interface VisualLine {
  tokens: VisualToken[]
  logicalLine: number
  tokenOffset: number
  y: number
  width: number
  height: number
  aboveHeight: number
  logicalAboveHeight: number
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

function applyCachedPlacement(cached: VisualLine[], y: number, logicalLine: number): VisualLine[] {
  if (cached.length === 0) return cached
  const baseY = cached[0]?.y ?? y
  const baseLogicalLine = cached[0]?.logicalLine ?? logicalLine
  const yOffset = y - baseY
  const logicalOffset = logicalLine - baseLogicalLine
  if (yOffset === 0 && logicalOffset === 0) return cached

  const shifted = new Array<VisualLine>(cached.length)
  for (let i = 0; i < cached.length; i++) {
    const line = cached[i]
    shifted[i] = {
      tokens: line.tokens,
      logicalLine: line.logicalLine + logicalOffset,
      tokenOffset: line.tokenOffset,
      y: line.y + yOffset,
      width: line.width,
      height: line.height,
      aboveHeight: line.aboveHeight,
      logicalAboveHeight: line.logicalAboveHeight,
      widgets: line.widgets,
      errors: line.errors,
    }
  }
  return shifted
}

function wrapTokens(
  c: CanvasRenderingContext2D,
  settings: Settings,
  caches: Caches,
  tokenLines: Token[][],
  tokens: Token[] | undefined,
  logicalLine: number,
  y: number,
  maxWidth: number,
  lineWidgets: Widget[],
  lineErrors: DocError[],
): VisualLine[] {
  const safeTokens = tokens ?? EMPTY_TOKENS
  const { wrapTokensCacheByTokenRef } = caches
  const hasDecorations = lineWidgets.length > 0 || lineErrors.length > 0
  const cacheKey = hasDecorations
    ? getWrapTokensCacheKey(maxWidth, lineWidgets, lineErrors, settings)
    : `${maxWidth}|${settings.lineHeight}|${settings.fontSize}`
  const cachedByVariant = wrapTokensCacheByTokenRef.get(safeTokens)
  const cached = cachedByVariant?.get(cacheKey)
  if (cached) {
    return applyCachedPlacement(cached, y, logicalLine)
  }

  if (safeTokens.length === 0) {
    const aboveWidgets = (lineWidgets.filter(w => w.type === 'above') as (Widget & { type: 'above' })[]).filter(
      widget => {
        const [startColumn, endColumn] = widget.pos.x
        const startCol0 = startColumn - 1
        const endCol0 = endColumn - 1
        return startCol0 <= 0 && endCol0 > 0
      },
    )
    const result = [{
      tokens: [],
      logicalLine,
      tokenOffset: 0,
      y,
      width: 0,
      height: settings.lineHeight,
      aboveHeight: 0,
      logicalAboveHeight: 0,
      widgets: {
        above: aboveWidgets,
        below: [],
        overlay: [],
        inlay: [],
        beforeAfter: [],
        full: [],
      },
      errors: lineErrors.length === 0
        ? EMPTY_DOC_ERRORS
        : filterErrorsFromLine(lineErrors, 0, 0, tokenLines[logicalLine] ?? EMPTY_TOKENS),
    }]
    if (cachedByVariant) cachedByVariant.set(cacheKey, result)
    else wrapTokensCacheByTokenRef.set(safeTokens, new Map([[cacheKey, result]]))
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
  const currentLineTokenCharOffsets: number[] = []
  const logicalLineTokens = tokenLines[logicalLine] ?? safeTokens
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
      currentLineTokenCharOffsets,
      currentLineTokenWidths,
    )
    visualLines.push(visualLine)
    currentY += visualLine.height
    currentLine.length = 0
    currentLineLogicalIndices.length = 0
    currentLineTokenWidths.length = 0
    currentLineTokenCharOffsets.length = 0
    currentLineWidth = 0
  }

  function tryAddTokenToCurrentLine(
    token: Token,
    logicalTokenIndex: number,
    tokenWidth: number,
    logicalTokenCharOffset = 0,
  ) {
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
      currentLineTokenCharOffsets.push(logicalTokenCharOffset)
      return currentLineWidth
    }

    currentLineWidth = newWidth
    currentLine.push(token)
    currentLineLogicalIndices.push(logicalTokenIndex)
    currentLineTokenWidths.push(tokenWidth)
    currentLineTokenCharOffsets.push(logicalTokenCharOffset)
    return currentLineWidth
  }

  for (let logicalIndex = 0; logicalIndex < safeTokens.length; logicalIndex++) {
    const token = safeTokens[logicalIndex]
    const tokenWidth = measureText(c, settings, caches, token).width

    if (tokenWidth > maxWidth) {
      const brokenTokens = breakToken(c, settings, caches, token, maxWidth)
      let brokenCharOffset = 0
      for (let i = 0; i < brokenTokens.length; i++) {
        const brokenToken = brokenTokens[i]
        const brokenTokenWidth = measureText(c, settings, caches, brokenToken).width
        tryAddTokenToCurrentLine(brokenToken, logicalIndex, brokenTokenWidth, brokenCharOffset)
        brokenCharOffset += brokenToken.text.length
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
      aboveHeight: 0,
      logicalAboveHeight: 0,
      widgets: {
        above: lineWidgets.filter(w => w.type === 'above') as (Widget & { type: 'above' })[],
        below: [],
        overlay: [],
        inlay: [],
        beforeAfter: [],
        full: lineWidgets.filter(w => w.type === 'full') as (Widget & { type: 'full' })[],
      },
      errors: lineErrors.length === 0
        ? EMPTY_DOC_ERRORS
        : filterErrorsFromLine(lineErrors, 0, 0, tokenLines[logicalLine] ?? EMPTY_TOKENS),
    } as VisualLine]

  if (cachedByVariant) cachedByVariant.set(cacheKey, result)
  else wrapTokensCacheByTokenRef.set(safeTokens, new Map([[cacheKey, result]]))

  return result
}

export type Lines = ReturnType<typeof createLines>

interface LogicalLineLayoutCache {
  tokenRef: Token[]
  visualLines: VisualLine[]
  startY: number
  height: number
  width: number
  pendingYShift: number
  pendingLogicalShift: number
}

interface VisualLayoutCacheState {
  maxWidth: number
  baseAvailableWidth: number
  lineHeight: number
  fontSize: string
  wordWrap: boolean
  lineLayouts: LogicalLineLayoutCache[]
  lineHeights: number[]
  heightIndex: FenwickTree
}

interface VisualLayoutOutput {
  visualLines: VisualLine[]
  visualLinesByLogicalLine: (VisualLine[] | undefined)[]
  lineLayouts: LogicalLineLayoutCache[]
  lineHeights: number[]
  heightIndex: FenwickTree
  hasAboveOrFullWidgets: boolean
  totalWidth: number
  totalHeight: number
}

interface CaretLayoutSnapshot {
  lineLayouts: LogicalLineLayoutCache[]
  heightIndex: FenwickTree
  totalWidth: number
  totalHeight: number
}

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

function getVisualLineBlockMetrics(visual: VisualLine[], startY: number): { height: number; width: number } {
  if (visual.length === 0) return { height: 0, width: 0 }
  let width = 0
  for (let i = 0; i < visual.length; i++) {
    if (visual[i].width > width) width = visual[i].width
  }
  const last = visual[visual.length - 1]
  return {
    height: Math.max(0, (last.y + last.height) - startY),
    width,
  }
}

function createSkippedLineLayout(tokenRef: Token[], y: number): LogicalLineLayoutCache {
  return {
    tokenRef,
    visualLines: [],
    startY: y,
    height: 0,
    width: 0,
    pendingYShift: 0,
    pendingLogicalShift: 0,
  }
}

function getCollapsedSkipUntilBeforeLine(
  collapsedLines: Set<number>,
  blockEnds: Map<number, number>,
  beforeLine: number,
): number {
  let skipUntil = -1
  for (const collapsedStart of collapsedLines) {
    if (collapsedStart >= beforeLine) continue
    const collapsedEnd = blockEnds.get(collapsedStart)
    if (collapsedEnd === undefined) continue
    if (collapsedEnd > skipUntil) skipUntil = collapsedEnd
  }
  return skipUntil
}

export function createLines(
  doc: Doc,
  canvas: Canvas,
  metrics: Metrics,
  settings: Settings,
  caches: Caches,
  blocks: Blocks,
  header: Signal<Header>,
) {
  void header
  const incrementalTokenChange = signal<DocIncrementalChange | null>(null)
  doc.onIncrementalChange(change => {
    incrementalTokenChange.value = change
  })

  let previousLayout: VisualLayoutCacheState | null = null
  let latestCaretLayoutSnapshot: CaretLayoutSnapshot | null = null
  let cachedWidgetsRef: Widget[] | null = null
  let cachedWidgetsIndex: WidgetsByLogicalLineIndex = { map: new Map(), hasAboveOrFull: false }
  let cachedErrorsRef: DocError[] | null = null
  let cachedErrorsByLine: Map<number, DocError[]> = new Map()

  const visualData = computed<VisualLayoutOutput>(() => {
    const tokenLines = doc.tokenLines
    const tokenChange = incrementalTokenChange.value
    const widgetsRef = doc.widgets
    const errorsRef = doc.errors
    const baseAvailableWidth = canvas.size.width.value - settings.paddingLeft - settings.paddingRight
      - metrics.gutterWidth.value
    const verticalScrollbarSize = getVerticalScrollbarSize(settings)
    const maxWidth = settings.wordWrap
      ? baseAvailableWidth - verticalScrollbarSize
      : Infinity

    if (widgetsRef !== cachedWidgetsRef) {
      cachedWidgetsRef = widgetsRef
      cachedWidgetsIndex = buildWidgetsByLogicalLineIndex(widgetsRef)
    }
    const widgetsByLogicalLine = cachedWidgetsIndex.map
    const hasAboveOrFullWidgets = cachedWidgetsIndex.hasAboveOrFull

    if (errorsRef !== cachedErrorsRef) {
      cachedErrorsRef = errorsRef
      cachedErrorsByLine = buildErrorsByLogicalLineIndex(errorsRef)
    }
    const errorsByLogicalLine = cachedErrorsByLine

    const hasCollapsed = doc.collapsed.size > 0
    const collapsedLines = doc.collapsed
    const collapsedBlockEnds = hasCollapsed ? blocks.blockEnds.value : null

    const canIncrementalLayoutPatch = previousLayout !== null
      && tokenChange !== null
      && tokenChange.source !== 'reset'
      && previousLayout.maxWidth === maxWidth
      && previousLayout.baseAvailableWidth === baseAvailableWidth
      && previousLayout.lineHeight === settings.lineHeight
      && previousLayout.fontSize === settings.fontSize
      && previousLayout.wordWrap === settings.wordWrap

    if (canIncrementalLayoutPatch) {
      const prev = previousLayout
      const delta = tokenChange.endLineAfter - tokenChange.endLineBefore
      const newLayouts: LogicalLineLayoutCache[] = new Array(tokenLines.length)
      const nextLineHeights = prev.lineHeights.slice()
      let maxLineWidth = 0

      if (delta > 0) {
        const insertAt = Math.max(0, Math.min(tokenChange.endLineBefore + 1, nextLineHeights.length))
        nextLineHeights.splice(insertAt, 0, ...new Array<number>(delta).fill(0))
      }
      else if (delta < 0) {
        const removeAt = Math.max(0, Math.min(tokenChange.endLineAfter + 1, nextLineHeights.length))
        const removeCount = Math.min(-delta, Math.max(0, nextLineHeights.length - removeAt))
        if (removeCount > 0) nextLineHeights.splice(removeAt, removeCount)
      }
      if (nextLineHeights.length > tokenLines.length) nextLineHeights.length = tokenLines.length
      while (nextLineHeights.length < tokenLines.length) nextLineHeights.push(0)

      const nextHeightIndex = FenwickTree.from(nextLineHeights)
      const getLineStartY = (lineIndex: number) => (lineIndex <= 0 ? 0 : nextHeightIndex.sum(lineIndex - 1))
      const includeLayoutWidth = (layout: LogicalLineLayoutCache) => {
        if (layout.width > maxLineWidth) maxLineWidth = layout.width
      }
      const setLayoutWithHeightUpdate = (lineIndex: number, layout: LogicalLineLayoutCache) => {
        newLayouts[lineIndex] = layout
        includeLayoutWidth(layout)
        const previousHeight = nextLineHeights[lineIndex] ?? 0
        if (layout.height !== previousHeight) {
          nextLineHeights[lineIndex] = layout.height
          nextHeightIndex.add(lineIndex, layout.height - previousHeight)
        }
      }

      let recomputeStart = Math.max(0, Math.min(tokenChange.startLine, tokenLines.length))
      while (recomputeStart > 0) {
        const prevIndex = recomputeStart - 1
        const prevLayout = prev.lineLayouts[prevIndex]
        const prevTokenRef = tokenLines[prevIndex] ?? EMPTY_TOKENS
        if (prevLayout && prevTokenRef !== EMPTY_TOKENS && prevTokenRef === prevLayout.tokenRef) break
        recomputeStart--
      }

      for (let i = 0; i < recomputeStart; i++) {
        const prevLayout = prev.lineLayouts[i]
        const tokenRef = tokenLines[i] ?? EMPTY_TOKENS
        if (!prevLayout || tokenRef === EMPTY_TOKENS || tokenRef !== prevLayout.tokenRef) {
          recomputeStart = i
          break
        }
        newLayouts[i] = prevLayout
        includeLayoutWidth(prevLayout)
      }

      let scanSkipUntil = hasCollapsed && collapsedBlockEnds
        ? getCollapsedSkipUntilBeforeLine(collapsedLines, collapsedBlockEnds, recomputeStart)
        : -1

      const processedEnd = Math.max(
        recomputeStart - 1,
        Math.min(tokenLines.length - 1, tokenChange.tokenProcessedEndLine),
      )

      let scannedLine = recomputeStart
      for (; scannedLine <= processedEnd; scannedLine++) {
        const lineIndex = scannedLine
        const tokenRef = tokenLines[lineIndex] ?? EMPTY_TOKENS

        const y = getLineStartY(lineIndex)
        if (lineIndex <= scanSkipUntil) {
          setLayoutWithHeightUpdate(lineIndex, createSkippedLineLayout(tokenRef, y))
          continue
        }

        const lineWidgets = widgetsByLogicalLine.get(lineIndex) ?? EMPTY_WIDGETS
        const lineErrors = errorsByLogicalLine.get(lineIndex) ?? EMPTY_DOC_ERRORS
        const wrapped = wrapTokens(
          canvas.c,
          settings,
          caches,
          tokenLines,
          tokenRef,
          lineIndex,
          y,
          maxWidth,
          lineWidgets,
          lineErrors,
        )
        const metricsForLine = getVisualLineBlockMetrics(wrapped, y)
        setLayoutWithHeightUpdate(lineIndex, {
          tokenRef,
          visualLines: wrapped,
          startY: y,
          height: metricsForLine.height,
          width: metricsForLine.width,
          pendingYShift: 0,
          pendingLogicalShift: 0,
        })

        if (hasCollapsed && collapsedBlockEnds && collapsedLines.has(lineIndex)) {
          scanSkipUntil = collapsedBlockEnds.get(lineIndex) ?? scanSkipUntil
        }
      }

      let firstUnfilled = Math.max(recomputeStart, processedEnd + 1)

      if (firstUnfilled < tokenLines.length) {
        const boundaryNew = firstUnfilled
        const boundaryOld = boundaryNew - delta

        if (boundaryOld >= 0 && boundaryOld < prev.lineLayouts.length) {
          const oldBoundary = prev.lineLayouts[boundaryOld]
          if (oldBoundary) {
            const yDelta = getLineStartY(boundaryNew) - oldBoundary.startY
            const logicalDelta = boundaryNew - boundaryOld
            const maxMapCount = Math.min(tokenLines.length - boundaryNew, prev.lineLayouts.length - boundaryOld)
            let mappedCount = 0
            for (let offset = 0; offset < maxMapCount; offset++) {
              const oldLayout = prev.lineLayouts[boundaryOld + offset]
              if (!oldLayout) break
              const mappedLineIndex = boundaryNew + offset
              const mappedTokenRef = tokenLines[mappedLineIndex] ?? EMPTY_TOKENS
              if (mappedTokenRef === EMPTY_TOKENS || mappedTokenRef !== oldLayout.tokenRef) break
              oldLayout.startY += yDelta
              oldLayout.pendingYShift += yDelta
              oldLayout.pendingLogicalShift += logicalDelta
              newLayouts[mappedLineIndex] = oldLayout
              includeLayoutWidth(oldLayout)
              mappedCount++
            }
            firstUnfilled = boundaryNew + mappedCount
          }
        }
      }

      let fillSkipUntil = hasCollapsed && collapsedBlockEnds
        ? getCollapsedSkipUntilBeforeLine(collapsedLines, collapsedBlockEnds, firstUnfilled)
        : -1
      for (let lineIndex = firstUnfilled; lineIndex < tokenLines.length; lineIndex++) {
        const tokenRef = tokenLines[lineIndex] ?? EMPTY_TOKENS
        const y = getLineStartY(lineIndex)
        if (lineIndex <= fillSkipUntil) {
          setLayoutWithHeightUpdate(lineIndex, createSkippedLineLayout(tokenRef, y))
          continue
        }

        const lineWidgets = widgetsByLogicalLine.get(lineIndex) ?? EMPTY_WIDGETS
        const lineErrors = errorsByLogicalLine.get(lineIndex) ?? EMPTY_DOC_ERRORS
        const wrapped = wrapTokens(
          canvas.c,
          settings,
          caches,
          tokenLines,
          tokenRef,
          lineIndex,
          y,
          maxWidth,
          lineWidgets,
          lineErrors,
        )
        const metricsForLine = getVisualLineBlockMetrics(wrapped, y)
        setLayoutWithHeightUpdate(lineIndex, {
          tokenRef,
          visualLines: wrapped,
          startY: y,
          height: metricsForLine.height,
          width: metricsForLine.width,
          pendingYShift: 0,
          pendingLogicalShift: 0,
        })

        if (hasCollapsed && collapsedBlockEnds && collapsedLines.has(lineIndex)) {
          fillSkipUntil = collapsedBlockEnds.get(lineIndex) ?? fillSkipUntil
        }
      }

      const nextTotalHeight = nextHeightIndex.total()
      const nextTotalWidth = settings.wordWrap
        ? Math.min(maxLineWidth, baseAvailableWidth - verticalScrollbarSize)
        : maxLineWidth

      let outputVisualLines: VisualLine[] = []
      let outputVisualLinesByLogicalLine: (VisualLine[] | undefined)[] = []
      let outputLineLayouts = newLayouts
      let outputLineHeights = nextLineHeights
      let outputHeightIndex = nextHeightIndex
      let outputTotalHeight = nextTotalHeight

      if (hasAboveOrFullWidgets) {
        const flattenedVisualLines: VisualLine[] = []
        for (let i = 0; i < newLayouts.length; i++) {
          const layout = newLayouts[i]
          if (!layout) continue
          const yShift = layout.pendingYShift
          const logicalShift = layout.pendingLogicalShift
          if (yShift !== 0 || logicalShift !== 0) {
            const shifted = layout.visualLines
            for (let j = 0; j < shifted.length; j++) {
              const visualLine = shifted[j]
              visualLine.logicalLine += logicalShift
              visualLine.y += yShift
            }
            layout.pendingYShift = 0
            layout.pendingLogicalShift = 0
          }

          const lineVisuals = layout.visualLines
          if (!lineVisuals || lineVisuals.length === 0) continue
          for (let j = 0; j < lineVisuals.length; j++) {
            flattenedVisualLines.push(lineVisuals[j])
          }
        }

        outputVisualLines = applyAboveWidgetSpace(doc, flattenedVisualLines, widgetsByLogicalLine)
        outputTotalHeight = outputVisualLines.length > 0
          ? outputVisualLines[outputVisualLines.length - 1].y + outputVisualLines[outputVisualLines.length - 1].height
          : 0

        outputVisualLinesByLogicalLine = new Array<VisualLine[] | undefined>(tokenLines.length)
        for (let i = 0; i < outputVisualLines.length; i++) {
          const line = outputVisualLines[i]
          const existing = outputVisualLinesByLogicalLine[line.logicalLine]
          if (existing) existing.push(line)
          else outputVisualLinesByLogicalLine[line.logicalLine] = [line]
        }

        outputLineLayouts = new Array(tokenLines.length)
        outputLineHeights = new Array(tokenLines.length).fill(0)
        for (let logicalLine = 0; logicalLine < tokenLines.length; logicalLine++) {
          const wrapped = outputVisualLinesByLogicalLine[logicalLine] ?? EMPTY_VISUAL_LINES
          const startY = wrapped[0]?.y ?? (logicalLine > 0
            ? (
              (outputLineLayouts[logicalLine - 1]?.startY ?? 0)
              + (outputLineLayouts[logicalLine - 1]?.height ?? 0)
            )
            : 0)
          const metricsForLine = getVisualLineBlockMetrics(wrapped, startY)
          outputLineLayouts[logicalLine] = {
            tokenRef: tokenLines[logicalLine] ?? EMPTY_TOKENS,
            visualLines: wrapped,
            startY,
            height: metricsForLine.height,
            width: metricsForLine.width,
            pendingYShift: 0,
            pendingLogicalShift: 0,
          }
          outputLineHeights[logicalLine] = metricsForLine.height
        }
        outputHeightIndex = FenwickTree.from(outputLineHeights)
      }

      latestCaretLayoutSnapshot = {
        lineLayouts: outputLineLayouts,
        heightIndex: outputHeightIndex,
        totalWidth: nextTotalWidth,
        totalHeight: outputTotalHeight,
      }

      previousLayout = {
        maxWidth,
        baseAvailableWidth,
        lineHeight: settings.lineHeight,
        fontSize: settings.fontSize,
        wordWrap: settings.wordWrap,
        lineLayouts: outputLineLayouts,
        lineHeights: outputLineHeights,
        heightIndex: outputHeightIndex,
      }
      return {
        visualLines: outputVisualLines,
        visualLinesByLogicalLine: outputVisualLinesByLogicalLine,
        lineLayouts: outputLineLayouts,
        lineHeights: outputLineHeights,
        heightIndex: outputHeightIndex,
        hasAboveOrFullWidgets,
        totalWidth: nextTotalWidth,
        totalHeight: outputTotalHeight,
      }
    }

    const visualLinesByLogicalLine: (VisualLine[] | undefined)[] = hasAboveOrFullWidgets
      ? new Array<VisualLine[] | undefined>(tokenLines.length)
      : []
    const lineLayouts: LogicalLineLayoutCache[] = new Array(tokenLines.length)
    const lineHeights: number[] = new Array(tokenLines.length).fill(0)
    let maxLineWidth = 0
    let y = 0
    let skipUntil = -1

    for (let logicalLine = 0; logicalLine < tokenLines.length; logicalLine++) {
      const tokens = tokenLines[logicalLine] ?? EMPTY_TOKENS
      if (logicalLine > skipUntil) {
        const lineWidgets = widgetsByLogicalLine.get(logicalLine) ?? EMPTY_WIDGETS
        const lineErrors = errorsByLogicalLine.get(logicalLine) ?? EMPTY_DOC_ERRORS

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
        if (hasAboveOrFullWidgets && wrapped.length > 0) {
          visualLinesByLogicalLine[logicalLine] = wrapped
        }

        const metricsForLine = getVisualLineBlockMetrics(wrapped, y)
        lineLayouts[logicalLine] = {
          tokenRef: tokens,
          visualLines: wrapped,
          startY: y,
          height: metricsForLine.height,
          width: metricsForLine.width,
          pendingYShift: 0,
          pendingLogicalShift: 0,
        }
        lineHeights[logicalLine] = metricsForLine.height

        const last = wrapped[wrapped.length - 1]
        y = (last?.y ?? y) + (last?.height ?? 0)
        for (let i = 0; i < wrapped.length; i++) {
          if (wrapped[i].width > maxLineWidth) maxLineWidth = wrapped[i].width
        }

        if (hasCollapsed && collapsedBlockEnds && collapsedLines.has(logicalLine)) {
          skipUntil = collapsedBlockEnds.get(logicalLine) ?? -1
        }
      }
      else {
        lineLayouts[logicalLine] = createSkippedLineLayout(tokens, y)
        lineHeights[logicalLine] = 0
      }
    }

    const nextTotalWidth = settings.wordWrap
      ? Math.min(maxLineWidth, baseAvailableWidth - verticalScrollbarSize)
      : maxLineWidth

    let processedLines: VisualLine[] = []
    let processedVisualLinesByLogicalLine: (VisualLine[] | undefined)[] = hasAboveOrFullWidgets
      ? visualLinesByLogicalLine
      : []
    let processedLineLayouts = lineLayouts
    let processedLineHeights = lineHeights
    let processedHeightIndex = FenwickTree.from(lineHeights)
    let nextTotalHeight = y
    if (hasAboveOrFullWidgets) {
      const flattenedVisualLines: VisualLine[] = []
      for (let i = 0; i < lineLayouts.length; i++) {
        const lineVisuals = lineLayouts[i]?.visualLines
        if (!lineVisuals || lineVisuals.length === 0) continue
        for (let j = 0; j < lineVisuals.length; j++) {
          flattenedVisualLines.push(lineVisuals[j])
        }
      }

      processedLines = applyAboveWidgetSpace(doc, flattenedVisualLines, widgetsByLogicalLine)
      nextTotalHeight = processedLines.length > 0
        ? processedLines[processedLines.length - 1].y + processedLines[processedLines.length - 1].height
        : 0

      processedVisualLinesByLogicalLine = new Array<VisualLine[] | undefined>(tokenLines.length)
      for (let i = 0; i < processedLines.length; i++) {
        const line = processedLines[i]
        const existing = processedVisualLinesByLogicalLine[line.logicalLine]
        if (existing) existing.push(line)
        else processedVisualLinesByLogicalLine[line.logicalLine] = [line]
      }

      processedLineLayouts = new Array(tokenLines.length)
      processedLineHeights = new Array(tokenLines.length).fill(0)
      for (let logicalLine = 0; logicalLine < tokenLines.length; logicalLine++) {
        const wrapped = processedVisualLinesByLogicalLine[logicalLine] ?? []
        const startY = wrapped[0]?.y ?? (logicalLine > 0
          ? ((processedLineLayouts[logicalLine - 1]?.startY ?? 0) + (processedLineLayouts[logicalLine - 1]?.height ?? 0))
          : 0)
        const metricsForLine = getVisualLineBlockMetrics(wrapped, startY)
        processedLineLayouts[logicalLine] = {
          tokenRef: tokenLines[logicalLine] ?? EMPTY_TOKENS,
          visualLines: wrapped,
          startY,
          height: metricsForLine.height,
          width: metricsForLine.width,
          pendingYShift: 0,
          pendingLogicalShift: 0,
        }
        processedLineHeights[logicalLine] = metricsForLine.height
      }
      processedHeightIndex = FenwickTree.from(processedLineHeights)
    }

    if (!hasAboveOrFullWidgets) {
      previousLayout = {
        maxWidth,
        baseAvailableWidth,
        lineHeight: settings.lineHeight,
        fontSize: settings.fontSize,
        wordWrap: settings.wordWrap,
        lineLayouts: processedLineLayouts,
        lineHeights: processedLineHeights,
        heightIndex: processedHeightIndex,
      }
    }
    else {
      previousLayout = null
    }

    latestCaretLayoutSnapshot = {
      lineLayouts: processedLineLayouts,
      heightIndex: processedHeightIndex,
      totalWidth: nextTotalWidth,
      totalHeight: nextTotalHeight,
    }

    return {
      visualLines: processedLines,
      visualLinesByLogicalLine: processedVisualLinesByLogicalLine,
      lineLayouts: processedLineLayouts,
      lineHeights: processedLineHeights,
      heightIndex: processedHeightIndex,
      hasAboveOrFullWidgets,
      totalWidth: nextTotalWidth,
      totalHeight: nextTotalHeight,
    }
  })

  const materializeLayoutVisualLines = (layout: LogicalLineLayoutCache | undefined): VisualLine[] | undefined => {
    if (!layout) return undefined
    const yShift = layout.pendingYShift
    const logicalShift = layout.pendingLogicalShift
    if (yShift !== 0 || logicalShift !== 0) {
      const shifted = layout.visualLines
      for (let i = 0; i < shifted.length; i++) {
        const visualLine = shifted[i]
        visualLine.logicalLine += logicalShift
        visualLine.y += yShift
      }
      layout.pendingYShift = 0
      layout.pendingLogicalShift = 0
    }
    return layout.visualLines
  }

  const visualLinesByLogicalLineProxy = new Proxy([] as (VisualLine[] | undefined)[], {
    get(_target, prop) {
      if (prop === 'length') return visualData.value.lineLayouts.length
      if (typeof prop === 'string') {
        const lineIndex = Number(prop)
        if (Number.isInteger(lineIndex) && lineIndex >= 0) {
          return materializeLayoutVisualLines(visualData.value.lineLayouts[lineIndex])
        }
      }
      const rawByLogicalLine = visualData.value.visualLinesByLogicalLine as unknown as Record<PropertyKey, unknown>
      return rawByLogicalLine[prop as keyof typeof rawByLogicalLine]
    },
  })

  const visualLines = computed(() => {
    const data = visualData.value
    if (data.visualLines.length > 0) return data.visualLines

    const flattened: VisualLine[] = []
    const lineLayouts = data.lineLayouts
    for (let i = 0; i < lineLayouts.length; i++) {
      const lineVisuals = materializeLayoutVisualLines(lineLayouts[i])
      if (!lineVisuals || lineVisuals.length === 0) continue
      for (let j = 0; j < lineVisuals.length; j++) {
        flattened.push(lineVisuals[j])
      }
    }
    return flattened
  })
  const visualLinesByLogicalLine = computed(() => {
    void visualData.value
    return visualLinesByLogicalLineProxy
  })
  const totalWidth = computed(() => visualData.value.totalWidth)
  const totalHeight = computed(() => visualData.value.totalHeight)

  const getVisibleVisualLines = (visibleTop: number, visibleBottom: number, scrollY: number): VisualLine[] => {
    const data = visualData.value
    const contentTop = visibleTop - scrollY
    const contentBottom = visibleBottom - scrollY
    const margin = settings.lineHeight

    if (data.visualLines.length > 0) {
      const allLines = data.visualLines
      if (allLines.length === 0) return []
      const out: VisualLine[] = []
      const startIndex = lowerBoundVisualLineBottomAtLeast(allLines, contentTop)
      for (let i = startIndex; i < allLines.length; i++) {
        const line = allLines[i]
        const blockTop = line.y - (line.aboveHeight ?? 0)
        if (blockTop > contentBottom + margin) break
        const blockBottom = line.y + line.height
        if (blockBottom >= contentTop) out.push(line)
      }
      return out
    }

    const lineLayouts = data.lineLayouts
    if (lineLayouts.length === 0) return []

    let lineIndex = data.heightIndex.lowerBound(Math.max(0, contentTop))
    if (lineIndex > 0) lineIndex--
    if (lineIndex < 0) lineIndex = 0

    const out: VisualLine[] = []
    for (; lineIndex < lineLayouts.length; lineIndex++) {
      const layout = lineLayouts[lineIndex]
      if (!layout) continue
      if (layout.startY > contentBottom + margin) break

      const lineVisuals = materializeLayoutVisualLines(layout)
      if (!lineVisuals) continue
      for (let j = 0; j < lineVisuals.length; j++) {
        const line = lineVisuals[j]
        const blockTop = line.y - (line.aboveHeight ?? 0)
        if (blockTop > contentBottom + margin) return out
        const blockBottom = line.y + line.height
        if (blockBottom >= contentTop) out.push(line)
      }
    }

    return out
  }

  const getLastVisualLine = (): VisualLine | null => {
    const data = visualData.value
    if (data.visualLines.length > 0) {
      return data.visualLines.at(-1) ?? null
    }

    const lineLayouts = data.lineLayouts
    for (let i = lineLayouts.length - 1; i >= 0; i--) {
      const lineVisuals = materializeLayoutVisualLines(lineLayouts[i])
      if (lineVisuals && lineVisuals.length > 0) {
        return lineVisuals[lineVisuals.length - 1] ?? null
      }
    }
    return null
  }

  const getFirstVisualLine = (): VisualLine | null => {
    const data = visualData.value
    if (data.visualLines.length > 0) {
      return data.visualLines[0] ?? null
    }

    const lineLayouts = data.lineLayouts
    for (let i = 0; i < lineLayouts.length; i++) {
      const lineVisuals = materializeLayoutVisualLines(lineLayouts[i])
      if (lineVisuals && lineVisuals.length > 0) return lineVisuals[0] ?? null
    }
    return null
  }

  const getApproxCaretMetrics = (
    logicalLine: number,
    column: number,
    tokenLines: Token[][],
  ): { targetY: number; caretX: number } | null => {
    const layoutState = latestCaretLayoutSnapshot
    if (!layoutState) return null
    if (logicalLine < 0) return null

    if (logicalLine >= layoutState.lineLayouts.length) {
      if (logicalLine !== layoutState.lineLayouts.length) return null
      return {
        targetY: layoutState.totalHeight + settings.lineHeight + 1.5,
        caretX: 0,
      }
    }

    const logicalLayout = layoutState.lineLayouts[logicalLine]
    if (!logicalLayout) return null

    const yShift = logicalLayout.pendingYShift
    const lineVisuals = logicalLayout.visualLines
    if (lineVisuals.length === 0) {
      return {
        targetY: logicalLayout.startY + yShift + settings.lineHeight + 1.5,
        caretX: 0,
      }
    }

    let targetVisual = lineVisuals[lineVisuals.length - 1]
    for (let i = 0; i < lineVisuals.length; i++) {
      const visualLine = lineVisuals[i]
      const lineStartColumn = getCharOffsetForVisualLine(logicalLine, visualLine, tokenLines)
      let lineEndColumn = lineStartColumn
      for (let j = 0; j < visualLine.tokens.length; j++) {
        lineEndColumn += visualLine.tokens[j].token.text.length
      }
      const isLast = i === lineVisuals.length - 1
      if (column >= lineStartColumn && (column < lineEndColumn || isLast)) {
        targetVisual = visualLine
        break
      }
    }

    let caretX = 0
    if (targetVisual.tokens.length > 0) {
      const columnOffset = getCharOffsetForVisualLine(logicalLine, targetVisual, tokenLines)
      let currentColumn = columnOffset
      for (let i = 0; i < targetVisual.tokens.length; i++) {
        const visualToken = targetVisual.tokens[i]
        const tokenStartColumn = currentColumn
        const tokenEndColumn = currentColumn + visualToken.token.text.length
        if (column >= tokenStartColumn && column <= tokenEndColumn) {
          const relativePos = column - tokenStartColumn
          const tokenWidth = visualToken.tokenEndX - visualToken.x
          const charWidth = visualToken.token.text.length > 0 ? tokenWidth / visualToken.token.text.length : 0
          caretX = visualToken.x + relativePos * charWidth
          break
        }
        if (column > tokenEndColumn && i === targetVisual.tokens.length - 1) {
          caretX = visualToken.endX
        }
        currentColumn = tokenEndColumn
      }
    }

    return {
      targetY: targetVisual.y + yShift + settings.lineHeight + 1.5,
      caretX,
    }
  }

  const getApproxContentMetrics = (): { totalWidth: number; totalHeight: number } | null => {
    const snapshot = latestCaretLayoutSnapshot
    if (!snapshot) return null
    return {
      totalWidth: snapshot.totalWidth,
      totalHeight: snapshot.totalHeight,
    }
  }

  const getApproxVisibleLogicalRange = (
    visibleTop: number,
    visibleBottom: number,
    scrollY: number,
  ): { start: number; end: number } | null => {
    const snapshot = latestCaretLayoutSnapshot
    if (!snapshot) return null

    const lineCount = snapshot.lineLayouts.length
    if (lineCount === 0) return { start: 0, end: 0 }

    const contentTop = visibleTop - scrollY
    const contentBottom = visibleBottom - scrollY
    if (!Number.isFinite(contentTop) || !Number.isFinite(contentBottom)) return null

    const heightIndex = snapshot.heightIndex
    const epsilon = 0.001
    const margin = settings.lineHeight

    let start = heightIndex.lowerBound(Math.max(0, contentTop - epsilon))
    if (start < 0) start = 0
    if (start >= lineCount) start = lineCount - 1

    let end = heightIndex.lowerBound(Math.max(0, contentBottom + margin))
    if (end < start) end = start
    if (end >= lineCount) end = lineCount - 1

    return { start, end }
  }

  return { visualLines, visualLinesByLogicalLine, totalWidth, totalHeight, getVisibleVisualLines,
    getLastVisualLine, getFirstVisualLine, getApproxCaretMetrics, getApproxContentMetrics,
    getApproxVisibleLogicalRange }
}
