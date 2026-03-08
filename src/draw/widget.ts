import { type Context } from '../context.ts'
import { getCharOffsetForVisualLine, getXFromColumnUnclamped, isLineEmpty } from '../line-utils.ts'
import type { VisualLine } from '../lines.ts'
import { measureText } from '../measure.ts'
import type { Widget } from '../widget.ts'
import { VERTICAL_SCROLLBAR_SIZE } from './scrollbar.ts'

type AboveHeightIndex = {
  aboveHeightByLine: Map<VisualLine, number>
  logicalAboveHeightByLine: Map<number, number>
  visualLineIndexByLine: Map<VisualLine, number>
}

const aboveHeightIndexCache = new WeakMap<VisualLine[], AboveHeightIndex>()

function buildAboveHeightIndex(visualLines: VisualLine[]): AboveHeightIndex {
  const aboveHeightByLine = new Map<VisualLine, number>()
  const logicalAboveHeightByLine = new Map<number, number>()
  const visualLineIndexByLine = new Map<VisualLine, number>()
  let consecutiveEmptyHeight = 0

  for (let i = 0; i < visualLines.length; i++) {
    const line = visualLines[i]
    visualLineIndexByLine.set(line, i)

    if (line.tokenOffset === 0 && !logicalAboveHeightByLine.has(line.logicalLine)) {
      logicalAboveHeightByLine.set(line.logicalLine, consecutiveEmptyHeight)
    }

    if (isLineEmpty(line)) {
      consecutiveEmptyHeight += line.height
    }
    else {
      consecutiveEmptyHeight = 0
    }
  }

  for (let i = 0; i < visualLines.length; i++) {
    const line = visualLines[i]
    const logicalAboveHeight = logicalAboveHeightByLine.get(line.logicalLine) ?? 0
    aboveHeightByLine.set(line, line.widgets.above.length > 0 ? logicalAboveHeight : 0)
  }

  return {
    aboveHeightByLine,
    logicalAboveHeightByLine,
    visualLineIndexByLine,
  }
}

function getAboveHeightIndex(visualLines: VisualLine[]): AboveHeightIndex {
  const cached = aboveHeightIndexCache.get(visualLines)
  if (cached) return cached
  const index = buildAboveHeightIndex(visualLines)
  aboveHeightIndexCache.set(visualLines, index)
  return index
}

export function getAboveHeight(visualLines: VisualLine[], line: VisualLine): number {
  if (line.widgets.above.length === 0) return 0
  const index = getAboveHeightIndex(visualLines)
  return index.aboveHeightByLine.get(line) ?? 0
}

function getLogicalAboveHeight(visualLines: VisualLine[], logicalLine: number): number {
  const index = getAboveHeightIndex(visualLines)
  return index.logicalAboveHeightByLine.get(logicalLine) ?? 0
}

function getVisualLineIndex(visualLines: VisualLine[], line: VisualLine): number {
  const index = getAboveHeightIndex(visualLines)
  return index.visualLineIndexByLine.get(line) ?? -1
}

export function calculateAboveHeightForLine(
  context: Context,
  line: VisualLine,
): number {
  return getAboveHeight(context.lines.visualLines.value, line)
}

/** True when we should stop iterating (line block is below visible bottom). Empty lines above a line with widgets are part of that line's block. */
export function shouldBreakBottom(
  visualLines: VisualLine[],
  line: VisualLine,
  lineY: number,
  visibleBottom: number,
  scrollY: number,
): boolean {
  const aboveHeight = getAboveHeight(visualLines, line)
  if (lineY <= visibleBottom + aboveHeight) return false
  if (!isLineEmpty(line)) return true
  const idx = getVisualLineIndex(visualLines, line)
  if (idx < 0) return true
  for (let j = idx + 1; j < visualLines.length; j++) {
    const next = visualLines[j]
    if (next.tokenOffset === 0 && next.widgets.above.length > 0) {
      const nextAbove = getAboveHeight(visualLines, next)
      const nextY = next.y + scrollY
      if (nextY <= visibleBottom + nextAbove) return false
      break
    }
  }
  return true
}

export function drawAboveWidgets(
  context: Context,
  line: VisualLine,
) {
  const aboveWidgets = line.widgets.above
  if (aboveWidgets.length === 0) return

  const { lines } = context
  const { c, size } = context.canvas
  const visualLines = context.lines.visualLines.value

  const emptyHeight = getAboveHeight(visualLines, line)
  if (emptyHeight === 0) return

  const tokenLines = context.doc.tokenLines
  const logicalLineTokens = tokenLines[line.logicalLine] || []

  const lineStartColumn = getCharOffsetForVisualLine(line.logicalLine, line, tokenLines, context.lines)
  let lineEndColumn = lineStartColumn
  for (const token of line.tokens) {
    lineEndColumn += token.token.text.length
  }

  const widgetPositions: Array<{ widget: Widget & { type: 'above' }; x: number; width: number }> = []

  for (const widget of aboveWidgets) {
    const [startColumn, endColumn] = widget.pos.x
    const startCol0 = startColumn - 1
    const endCol0 = endColumn - 1

    if (startCol0 >= lineEndColumn) {
      continue
    }

    const clampedStartColumn = Math.max(startCol0, lineStartColumn)
    const clampedEndColumn = Math.min(endCol0, lineEndColumn)

    const startX = getXFromColumnUnclamped(lines, line, clampedStartColumn, tokenLines, context.canvas,
      context.settings, context.caches)
    const endX = getXFromColumnUnclamped(lines, line, clampedEndColumn, tokenLines, context.canvas, context.settings,
      context.caches)
    const widgetWidth = endX - startX
    const finalWidth = widgetWidth > 0 ? widgetWidth : size.width.value - startX
    widgetPositions.push({ widget, x: startX, width: finalWidth })
  }

  widgetPositions.sort((a, b) => a.x - b.x)

  const widgetY = line.tokenOffset === 0 ? line.y - emptyHeight : line.y
  for (let i = 0; i < widgetPositions.length; i++) {
    const current = widgetPositions[i]
    let width = current.width

    if (i < widgetPositions.length - 1) {
      const next = widgetPositions[i + 1]
      if (current.x + width > next.x) {
        width = next.x - current.x
      }
    }

    if (width > 0) {
      c.save()
      current.widget.draw(c, current.x, widgetY, width, emptyHeight)
      c.restore()
    }
  }
}

export function drawFullWidgets(
  context: Context,
  line: VisualLine,
) {
  const fullWidgets = line.widgets.full ?? []
  if (fullWidgets.length === 0 || line.tokenOffset !== 0) return

  const { c } = context.canvas
  const visualLines = context.lines.visualLines.value

  const emptyHeight = getLogicalAboveHeight(visualLines, line.logicalLine)
  if (emptyHeight === 0) return

  const headerHeight = context.header.value?.height ?? 0
  const needsVertical = context.lines.totalHeight.value > context.canvas.size.height.value - headerHeight
      - context.settings.paddingTop - context.settings.paddingBottom
  const widgetY = line.y - emptyHeight
  const x = -context.scroll.pos.x
  const contentLeft = context.gutter.width.value + context.settings.paddingLeft
  const w = context.canvas.size.width.value - context.gutter.width.value
    - (needsVertical ? VERTICAL_SCROLLBAR_SIZE : 0)
  const fw = context.canvas.size.width.value

  for (const widget of fullWidgets) {
    c.save()
    widget.draw(c, x, widgetY, w, emptyHeight, fw, contentLeft)
    c.restore()
  }
}

export function drawBelowWidgets(
  context: Context,
  line: VisualLine,
) {
  const widgets = line.widgets.below
  if (widgets.length === 0) return

  const { lines } = context
  const { c } = context.canvas
  const { lineHeight } = context.settings
  const tokenLines = context.doc.tokenLines
  const aboveHeight = calculateAboveHeightForLine(context, line)
  const contentY = line.tokenOffset === 0 ? line.y : line.y + aboveHeight

  for (const widget of widgets) {
    const [startColumn, endColumn] = widget.pos.x
    const startCol0 = startColumn - 1
    const endCol0 = endColumn - 1
    const startX = getXFromColumnUnclamped(lines, line, startCol0, tokenLines, context.canvas, context.settings,
      context.caches)
    const endX = getXFromColumnUnclamped(lines, line, endCol0, tokenLines, context.canvas, context.settings,
      context.caches)
    const widgetWidth = endX - startX
    c.save()
    widget.draw(c, startX, contentY + lineHeight - 2, widgetWidth, lineHeight)
    c.restore()
  }
}

export function drawOverlayWidgets(
  context: Context,
  line: VisualLine,
) {
  const widgets = line.widgets.overlay
  if (widgets.length === 0) return

  const { lines } = context
  const { c } = context.canvas
  const { lineHeight } = context.settings
  const tokenLines = context.doc.tokenLines
  const aboveHeight = calculateAboveHeightForLine(context, line)
  const contentY = line.tokenOffset === 0 ? line.y : line.y + aboveHeight

  for (const widget of widgets) {
    const [startColumn, endColumn] = widget.pos.x
    const startCol0 = startColumn - 1
    const endCol0 = endColumn - 1
    const startX = getXFromColumnUnclamped(lines, line, startCol0, tokenLines, context.canvas, context.settings,
      context.caches)
    const endX = getXFromColumnUnclamped(lines, line, endCol0, tokenLines, context.canvas, context.settings,
      context.caches)
    const widgetWidth = endX - startX
    c.save()
    widget.draw(c, startX, contentY, widgetWidth, lineHeight)
    c.restore()
  }
}

export function drawInlayWidgets(
  context: Context,
  line: VisualLine,
) {
  const widgets = line.widgets.inlay
  if (widgets.length === 0) return

  const { lines } = context
  const { c } = context.canvas
  const { lineHeight } = context.settings
  const tokenLines = context.doc.tokenLines
  const lineY = line.y
  const charOffset = getCharOffsetForVisualLine(line.logicalLine, line, tokenLines, context.lines)
  const tokenStart = line.tokenOffset

  for (const widget of widgets) {
    const widgetColumn = widget.pos.x - 1
    let currentCharOffset = charOffset
    for (let i = tokenStart; i < tokenStart + line.tokens.length; i++) {
      const token = tokenLines[line.logicalLine]?.[i]
      if (!token) break
      const tokenEnd = currentCharOffset + token.text.length
      if (widgetColumn >= currentCharOffset && widgetColumn <= tokenEnd) {
        const widgetX = getXFromColumnUnclamped(lines, line, widgetColumn, tokenLines, context.canvas, context.settings,
          context.caches)
        const { width } = measureText(c, context.settings, context.caches, { text: widget.content, type: 'text' })
        c.save()
        c.font = `400 normal ${context.settings.fontSize} '${context.settings.fontFamilyName}', monospace`
        c.textBaseline = 'top'
        widget.draw(c, widgetX, lineY, width, lineHeight)
        c.restore()
        break
      }
      currentCharOffset = tokenEnd
    }
  }
}

export function drawBeforeAfterWidgets(
  context: Context,
  line: VisualLine,
) {
  const widgets = line.widgets.beforeAfter
  if (widgets.length === 0) return

  const { lines } = context
  const { c } = context.canvas
  const { lineHeight } = context.settings
  const tokenLines = context.doc.tokenLines
  const aboveHeight = calculateAboveHeightForLine(context, line)
  const contentY = line.tokenOffset === 0 ? line.y : line.y + aboveHeight

  let lineStartColumn = getCharOffsetForVisualLine(line.logicalLine, line, tokenLines, context.lines)
  let lineEndColumn = lineStartColumn
  for (const token of line.tokens) {
    lineEndColumn += token.token.text.length
  }

  for (const widget of widgets) {
    const widgetColumn = widget.pos.x - 1

    if (widget.type === 'before') {
      // Attach "before" widgets to the *start* of the visual line:
      // draw them when their column is within [start, end) so that
      // a widget exactly at the wrap boundary belongs only to the
      // next line, not the previous one.
      if (widgetColumn < lineStartColumn || widgetColumn >= lineEndColumn) {
        continue
      }
      const widgetX = getXFromColumnUnclamped(lines, line, widgetColumn, tokenLines, context.canvas, context.settings,
        context.caches)
      c.save()
      widget.draw(c, widgetX, contentY, widget.pos.width, lineHeight)
      c.restore()
      continue
    }

    if (widget.type === 'after') {
      // Attach "after" widgets to the *end* of the visual line:
      // draw them when their column is within (start, end] so that
      // a widget exactly at the wrap boundary belongs only to the
      // previous line, not the next one.
      if (widgetColumn <= lineStartColumn || widgetColumn > lineEndColumn) {
        continue
      }
      const widgetX = getXFromColumnUnclamped(lines, line, widgetColumn + 1, tokenLines, context.canvas,
        context.settings, context.caches)
      c.save()
      widget.draw(c, widgetX, contentY, widget.pos.width, lineHeight)
      c.restore()
      continue
    }
  }
}
