import type { Canvas } from '../canvas.ts'
import type { Context } from '../context.ts'
import type { Gutter } from '../gutter.ts'
import { findVisualLineForColumn } from '../line-utils.ts'
import type { Lines, VisualLine } from '../lines.ts'
import type { Scroll } from '../scroll.ts'
import type { Settings } from '../settings.ts'
import { getActiveCanvas } from '../textarea-singleton.ts'
import { drawText } from './util.ts'

const COLLAPSE_TOGGLE_SIZE = 11
const COLLAPSE_TOGGLE_RIGHT_MARGIN = 5

function getVisibleVisualLinesForRange(
  lines: Pick<Lines, 'visualLines'> & Partial<Pick<Lines, 'getVisibleVisualLines'>>,
  visibleTop: number,
  visibleBottom: number,
  scrollY: number,
): VisualLine[] {
  if (typeof lines.getVisibleVisualLines === 'function') {
    return lines.getVisibleVisualLines(visibleTop, visibleBottom, scrollY)
  }
  return lines.visualLines.value
}

function getLastVisualLine(
  lines: Pick<Lines, 'visualLines'> & Partial<Pick<Lines, 'getLastVisualLine'>>,
): VisualLine | null {
  if (typeof lines.getLastVisualLine === 'function') {
    return lines.getLastVisualLine()
  }
  return lines.visualLines.value.at(-1) ?? null
}

export function drawGutterBackground(context: Context) {
  if (!context.settings.showGutter) return
  const { canvas, gutter, header } = context
  const { c } = canvas
  const gutterWidth = gutter.width.value
  const { size: { height: { value: height } } } = canvas
  const headerHeight = header.value?.height ?? 0

  c.save()
  c.fillStyle = context.settings.ui.background + 'dd'
  c.fillRect(
    -context.settings.paddingLeft,
    -headerHeight - context.settings.paddingTop,
    gutterWidth + context.settings.paddingLeft,
    height + headerHeight + context.settings.paddingTop,
  )
  c.restore()
}

export function drawGutter(context: Context) {
  if (!context.settings.showGutter) return
  const { canvas, lines, caret, settings, gutter, doc, header, caches } = context
  const { c } = canvas
  const visualLinesByLogicalLine = lines.visualLinesByLogicalLine.value
  const currentLine = caret.line.value
  const currentColumn = caret.column.value
  const collapsedLines = doc.collapsed
  const gutterWidth = gutter.width.value
  const { size: { height: { value: height } } } = canvas
  const { paddingTop } = settings
  const { y: scrollY } = context.scroll.pos
  const headerHeight = header.value?.height ?? 0
  const visibleTop = -headerHeight - paddingTop
  const visibleBottom = height - paddingTop
  const blockStarts = gutter.blockStarts.value
  const visibleVisualLines = lines.getVisibleVisualLines(visibleTop, visibleBottom, scrollY)
  const visibleLogicalLines = new Set<number>()
  for (let i = 0; i < visibleVisualLines.length; i++) {
    visibleLogicalLines.add(visibleVisualLines[i].logicalLine)
  }

  const activeCanvas = getActiveCanvas()
  const isFocused = activeCanvas === canvas.el

  const currentVisualLine = isFocused && currentLine >= 0 && currentLine < doc.lines.length
    ? findVisualLineForColumn(lines, currentLine, currentColumn, doc.tokenLines, caches)
    : null

  c.save()
  c.font = `${settings.fontSize} ${settings.fontFamilyName}`
  c.textBaseline = 'top'
  c.fillStyle = 'rgba(255, 255, 255, 0.05)'

  if (currentVisualLine) {
    const currentLineY = currentVisualLine.y + scrollY
    if (currentLineY + currentVisualLine.height >= visibleTop && currentLineY <= visibleBottom) {
      c.fillRect(-settings.paddingLeft, currentLineY, gutterWidth + settings.paddingLeft, settings.lineHeight)
    }
  }

  const showCollapseToggles = !!context.mouse.hovered.gutter
  for (const logicalLine of visibleLogicalLines) {
    const lineVisualLines = visualLinesByLogicalLine[logicalLine] ?? []
    const visualLine = lineVisualLines[0]
    if (!visualLine) continue

    const lineY = visualLine.y + scrollY
    if (lineY + visualLine.height < visibleTop || lineY > visibleBottom) continue

    const hasError = visualLine.errors.length > 0
    const isCollapsed = collapsedLines.has(logicalLine)
    const canCollapse = blockStarts.has(logicalLine)

    // if (hasError) {
    //   c.fillStyle = '#f00'
    //   c.fillRect(-settings.paddingLeft, lineY, gutterWidth + settings.paddingLeft, visualLine.height)
    // }

    const metrics = gutter.getLineNumberMetric(logicalLine)
    const lineNumberY = lineY + 2
    drawText(c, metrics.text, metrics.x, lineNumberY, hasError ? '#f00' : 'rgba(255, 255, 255, 0.3)')

    if (canCollapse && (isCollapsed || showCollapseToggles)) {
      const toggleX = gutterWidth - COLLAPSE_TOGGLE_SIZE - COLLAPSE_TOGGLE_RIGHT_MARGIN
      const toggleY = lineY + 6.5
      const size = COLLAPSE_TOGGLE_SIZE - 4
      const centerX = toggleX + size / 2
      const centerY = toggleY + size / 2
      const halfSize = size / 2

      c.lineWidth = 1.5
      c.lineCap = 'round'
      c.lineJoin = 'round'
      c.beginPath()

      if (isCollapsed) {
        c.strokeStyle = hasError ? settings.colors.white : settings.colors.white
        c.save()
        c.translate(-halfSize * 0.25, -halfSize * 1.75)
        c.moveTo(centerX, centerY)
        c.lineTo(centerX + halfSize, centerY + halfSize)
        c.lineTo(centerX, centerY + halfSize * 2)
        c.restore()
      }
      else {
        c.strokeStyle = hasError ? settings.colors.white : settings.colors.gray
        c.moveTo(centerX - halfSize, centerY - halfSize)
        c.lineTo(centerX, centerY)
        c.lineTo(centerX + halfSize, centerY - halfSize)
      }
      c.stroke()
    }
  }

  const codeLines = context.doc.lines
  const lastLineIndex = codeLines.length - 1
  const lastVisualLines = lastLineIndex >= 0 ? (visualLinesByLogicalLine[lastLineIndex] ?? []) : []
  if (lastLineIndex >= 0 && lastVisualLines.length === 0) {
    const lastVisualLine = getLastVisualLine(lines)
    if (lastVisualLine) {
      const lineY = lastVisualLine.y + lastVisualLine.height + scrollY
      if (lineY >= -paddingTop && lineY <= visibleBottom) {
        const isCurrentVisualLine = isFocused && lastLineIndex === currentLine
          && currentVisualLine?.logicalLine === lastLineIndex
        const metrics = gutter.getLineNumberMetric(lastLineIndex)

        if (isCurrentVisualLine) {
          c.fillStyle = 'rgba(255, 255, 255, 0.05)'
          c.fillRect(-settings.paddingLeft, lineY, gutterWidth + settings.paddingLeft, settings.lineHeight)
        }

        const lineNumberY = lineY + 2
        drawText(c, metrics.text, metrics.x, lineNumberY, 'rgba(255, 255, 255, 0.3)')
      }
    }
  }

  c.restore()
}

export function hitTestGutter(
  canvas: Canvas,
  settings: Settings,
  lines: Lines,
  scroll: Scroll,
  gutter: Gutter,
  x: number,
  y: number,
  headerHeight: number,
) {
  x = Math.floor(x)
  y = Math.floor(y)
  const gutterWidth = gutter.width.value
  const { paddingLeft, paddingTop } = settings
  const { y: scrollY } = scroll.pos

  const gutterX = x - paddingLeft
  const gutterInteractiveWidth = gutterWidth + paddingLeft
  const isInGutterArea = x >= 0 && x < gutterInteractiveWidth

  if (!isInGutterArea || y < headerHeight) {
    return { type: null, line: null }
  }

  const relativeY = y - headerHeight - paddingTop
  const visibleTop = -headerHeight - paddingTop
  const visibleBottom = canvas.size.height.value - paddingTop
  const visualLines = getVisibleVisualLinesForRange(lines, visibleTop, visibleBottom, scrollY)
  const blockStarts = gutter.blockStarts.value

  for (let i = 0; i < visualLines.length; i++) {
    const visualLine = visualLines[i]
    const lineY = visualLine.y + scrollY

    if (relativeY >= lineY && relativeY < lineY + visualLine.height) {
      const logicalLine = visualLine.logicalLine
      const isFirstVisualLine = visualLine.tokenOffset === 0
      const canCollapse = blockStarts.has(logicalLine)

      if (canCollapse && isFirstVisualLine) {
        const toggleX = gutterWidth - COLLAPSE_TOGGLE_SIZE - COLLAPSE_TOGGLE_RIGHT_MARGIN
        const toggleRight = toggleX + COLLAPSE_TOGGLE_SIZE
        if (gutterX >= toggleX && gutterX <= toggleRight) {
          return { type: 'collapse', line: logicalLine }
        }
      }

      return { type: 'line', line: logicalLine }
    }
  }

  return { type: 'gutter', line: null }
}
