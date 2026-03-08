import type { Canvas } from '../canvas.ts'
import type { Context } from '../context.ts'
import type { Gutter } from '../gutter.ts'
import { findVisualLineForColumn } from '../line-utils.ts'
import type { Lines, VisualLine } from '../lines.ts'
import type { Scroll } from '../scroll.ts'
import type { Settings } from '../settings.ts'
import { getActiveCanvas } from '../textarea-singleton.ts'
import { shouldBreakBottom } from './widget.ts'

const COLLAPSE_TOGGLE_SIZE = 11
const COLLAPSE_TOGGLE_RIGHT_MARGIN = 5

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
  const visualLines = lines.visualLines.value
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
  const lineNumberMap = gutter.lineNumberMap.value
  const blockStarts = gutter.blockStarts.value
  const lineNumberMetrics = gutter.lineNumberMetrics.value

  const activeCanvas = getActiveCanvas()
  const isFocused = activeCanvas === canvas.el

  const currentVisualLine = isFocused && currentLine >= 0 && currentLine < doc.lines.length
    ? findVisualLineForColumn(lines, currentLine, currentColumn, doc.tokenLines, caches)
    : null

  c.save()

  const startIndex = lowerBoundVisualLineBottomAtLeast(visualLines, visibleTop - scrollY)
  for (let i = startIndex; i < visualLines.length; i++) {
    const visualLine = visualLines[i]
    const lineY = visualLine.y + scrollY
    if (shouldBreakBottom(visualLines, visualLine, lineY, visibleBottom, scrollY)) break

    const logicalLine = visualLine.logicalLine
    const isFirstVisualLine = lineNumberMap.get(logicalLine)?.[0] === visualLine
    const hasError = visualLine.errors.length > 0
    const isCurrentVisualLine = visualLine.y === currentVisualLine?.y
    const isCollapsed = collapsedLines.has(logicalLine)
    const canCollapse = blockStarts.has(logicalLine)

    if (isCurrentVisualLine) {
      c.fillStyle = 'rgba(255, 255, 255, 0.05)'
      c.fillRect(-settings.paddingLeft, lineY, gutterWidth + settings.paddingLeft, settings.lineHeight)
    }

    if (!isFirstVisualLine) continue

    // if (hasError) {
    //   c.fillStyle = '#f00'
    //   c.fillRect(-settings.paddingLeft, lineY, gutterWidth + settings.paddingLeft, visualLine.height)
    // }

    const metrics = lineNumberMetrics.get(logicalLine)
    if (metrics) {
      const lineNumberY = lineY + 2

      c.fillStyle = hasError ? '#f00' : 'rgba(255, 255, 255, 0.3)'
      c.font = `${settings.fontSize} ${settings.fontFamilyName}`
      c.textBaseline = 'top'
      c.fillText(metrics.text, metrics.x, lineNumberY)
    }

    if (canCollapse && (isCollapsed || context.mouse.hovered.gutter)) {
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
  if (lastLineIndex >= 0 && !lineNumberMap.has(lastLineIndex)) {
    const lastVisualLine = visualLines[visualLines.length - 1]
    if (lastVisualLine) {
      const lineY = lastVisualLine.y + lastVisualLine.height + scrollY
      if (lineY >= -paddingTop && lineY <= visibleBottom) {
        const isCurrentVisualLine = isFocused && lastLineIndex === currentLine
          && currentVisualLine?.logicalLine === lastLineIndex
        const metrics = lineNumberMetrics.get(lastLineIndex)

        if (isCurrentVisualLine) {
          c.fillStyle = 'rgba(255, 255, 255, 0.05)'
          c.fillRect(-settings.paddingLeft, lineY, gutterWidth + settings.paddingLeft, settings.lineHeight)
        }

        if (metrics) {
          const lineNumberY = lineY + 2
          c.fillStyle = 'rgba(255, 255, 255, 0.3)'
          c.font = `${settings.fontSize} ${settings.fontFamilyName}`
          c.textBaseline = 'top'
          c.fillText(metrics.text, metrics.x, lineNumberY)
        }
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
  const visualLines = lines.visualLines.value
  const lineNumberMap = gutter.lineNumberMap.value
  const blockStarts = gutter.blockStarts.value

  const visibleTop = -paddingTop
  const visibleBottom = canvas.size.height.value - headerHeight - paddingTop
  const startIndex = lowerBoundVisualLineBottomAtLeast(visualLines, visibleTop - scrollY)
  for (let i = startIndex; i < visualLines.length; i++) {
    const visualLine = visualLines[i]
    const lineY = visualLine.y + scrollY
    if (shouldBreakBottom(visualLines, visualLine, lineY, visibleBottom, scrollY)) break

    if (relativeY >= lineY && relativeY < lineY + visualLine.height) {
      const logicalLine = visualLine.logicalLine
      const isFirstVisualLine = lineNumberMap.get(logicalLine)?.[0] === visualLine
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
