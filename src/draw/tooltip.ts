import type { Context } from '../context.ts'
import type { DocError } from '../doc.ts'
import { findVisualLineForColumn, getXFromColumn } from '../line-utils.ts'
import type { OverlayCanvas } from '../overlay-canvas.ts'
import { drawText } from './util.ts'

const PADDING = 10
const ARROW_SIZE = 6
const MAX_WIDTH = 400
const MARGIN = 4
const TOOLTIP_GAP = 0
const RADIUS = 8

function wrapTooltipText(c: CanvasRenderingContext2D, font: string, message: string,
  maxWidth: number): { lines: string[]; width: number }
{
  c.save()
  c.font = font
  const out: string[] = []
  let maxLineWidth = 0
  const maxLineWidthLimit = Math.max(1, maxWidth)
  for (const paragraph of message.split('\n')) {
    const words = paragraph.split(' ')
    let current = ''
    for (const word of words) {
      const candidate = current ? current + ' ' + word : word
      const w = c.measureText(candidate).width
      if (w <= maxLineWidthLimit) {
        current = candidate
      }
      else {
        if (current) {
          const cw = c.measureText(current).width
          maxLineWidth = Math.max(maxLineWidth, cw)
          out.push(current)
          current = ''
        }
        const wordW = c.measureText(word).width
        if (wordW <= maxLineWidthLimit) {
          current = word
        }
        else {
          let rest = word
          while (rest) {
            let fit = rest.length
            while (fit > 0 && c.measureText(rest.slice(0, fit)).width > maxLineWidthLimit) fit--
            if (fit === 0) fit = 1
            const segment = rest.slice(0, fit)
            maxLineWidth = Math.max(maxLineWidth, c.measureText(segment).width)
            out.push(segment)
            rest = rest.slice(fit)
          }
        }
      }
    }
    if (current) {
      maxLineWidth = Math.max(maxLineWidth, c.measureText(current).width)
      out.push(current)
    }
  }
  c.restore()
  return { lines: out, width: maxLineWidth }
}

export function drawTooltip(context: Context, error: DocError | null, overlayCanvas: OverlayCanvas,
  preferErrorAbove: boolean)
{
  if (!error) return
  const { canvas, settings, lines, scroll, caches } = context
  const { c } = overlayCanvas
  const canvasRect = canvas.rect

  const tokenLines = context.doc.tokenLines
  const logicalLine = error.y - 1
  const [errorStartColumn, errorEndColumn] = [error.x[0] - 1, error.x[1] - 1]

  const errorLine = findVisualLineForColumn(lines, logicalLine, errorStartColumn, tokenLines, caches)
  if (!errorLine) return

  const errorStartX = getXFromColumn(lines, errorLine, errorStartColumn, tokenLines, canvas, settings, caches)
  const errorEndX = getXFromColumn(lines, errorLine, errorEndColumn, tokenLines, canvas, settings, caches)

  const textY = errorLine.y

  const message = error.message
  const font = `${
    settings.theme.text.weight === 'bold' ? 700 : 400
  } ${settings.theme.text.style} 10pt '${settings.fontFamilyName}', monospace`
  const maxTextWidth = MAX_WIDTH - PADDING * 2
  const { lines: wrappedLines, width: textWidth } = wrapTooltipText(c, font, message, maxTextWidth)
  const lineHeight = 12
  const tooltipWidth = Math.min(MAX_WIDTH, textWidth + PADDING * 2)
  const tooltipHeight = wrappedLines.length * lineHeight + PADDING * 2

  const headerHeight = context.header.value?.height ?? 0
  const gutterWidth = context.gutter.width.value

  const viewport = window.visualViewport!
  const viewportLeft = viewport.offsetLeft
  const viewportTop = viewport.offsetTop
  const viewportWidth = viewport.width
  const viewportHeight = viewport.height

  const screenX = errorStartX + canvasRect.left + gutterWidth + settings.paddingLeft + scroll.pos.x
  const screenY = textY + canvasRect.top + headerHeight + settings.paddingTop + scroll.pos.y

  const tooltipYAbove = screenY - tooltipHeight - ARROW_SIZE - TOOLTIP_GAP
  const tooltipYBelow = screenY + settings.lineHeight + ARROW_SIZE + TOOLTIP_GAP

  const viewportTopWithMargin = viewportTop + MARGIN
  const viewportBottomWithMargin = viewportTop + viewportHeight - MARGIN

  const fitsAbove = tooltipYAbove >= viewportTopWithMargin && tooltipYAbove + tooltipHeight <= viewportBottomWithMargin
  const fitsBelow = tooltipYBelow >= viewportTopWithMargin && tooltipYBelow + tooltipHeight <= viewportBottomWithMargin

  let tooltipX = screenX
  let tooltipY: number
  let tooltipAbove: boolean

  if (preferErrorAbove) {
    tooltipAbove = true
    tooltipY = tooltipYAbove
  }
  else if (fitsBelow) {
    tooltipAbove = false
    tooltipY = tooltipYBelow
  }
  else if (fitsAbove) {
    tooltipAbove = true
    tooltipY = tooltipYAbove
  }
  else {
    tooltipAbove = tooltipYAbove >= viewportTopWithMargin
    tooltipY = tooltipAbove ? tooltipYAbove : tooltipYBelow
  }

  if (tooltipX < viewportLeft + MARGIN) {
    tooltipX = viewportLeft + MARGIN
  }
  if (tooltipX + tooltipWidth > viewportLeft + viewportWidth - MARGIN) {
    tooltipX = viewportLeft + viewportWidth - tooltipWidth - MARGIN
  }

  if (tooltipY < viewportTopWithMargin) {
    tooltipY = viewportTopWithMargin
  }
  if (tooltipY + tooltipHeight > viewportBottomWithMargin) {
    tooltipY = viewportBottomWithMargin - tooltipHeight
  }

  c.save()

  const BG_COLOR = context.settings.colors.black
  const STROKE_COLOR = '#f00'
  c.fillStyle = BG_COLOR
  c.strokeStyle = STROKE_COLOR
  c.lineWidth = 1.35

  c.beginPath()
  if (tooltipAbove) {
    // Rounded rect with square left bottom corner
    c.moveTo(tooltipX + RADIUS, tooltipY)
    c.lineTo(tooltipX + tooltipWidth - RADIUS, tooltipY)
    c.quadraticCurveTo(tooltipX + tooltipWidth, tooltipY, tooltipX + tooltipWidth, tooltipY + RADIUS)
    c.lineTo(tooltipX + tooltipWidth, tooltipY + tooltipHeight - RADIUS)
    c.quadraticCurveTo(tooltipX + tooltipWidth, tooltipY + tooltipHeight, tooltipX + tooltipWidth - RADIUS,
      tooltipY + tooltipHeight)
    c.lineTo(tooltipX + ARROW_SIZE, tooltipY + tooltipHeight)
    c.lineTo(tooltipX, tooltipY + tooltipHeight + ARROW_SIZE)
    c.lineTo(tooltipX, tooltipY + tooltipHeight)
    c.lineTo(tooltipX, tooltipY + RADIUS)
    c.quadraticCurveTo(tooltipX, tooltipY, tooltipX + RADIUS, tooltipY)
    c.closePath()
  }
  else {
    // Rounded rect with square left top corner
    c.moveTo(tooltipX + ARROW_SIZE, tooltipY)
    c.lineTo(tooltipX, tooltipY - ARROW_SIZE)
    c.lineTo(tooltipX, tooltipY)
    c.lineTo(tooltipX, tooltipY + tooltipHeight - RADIUS)
    c.quadraticCurveTo(tooltipX, tooltipY + tooltipHeight, tooltipX + RADIUS, tooltipY + tooltipHeight)
    c.lineTo(tooltipX + tooltipWidth - RADIUS, tooltipY + tooltipHeight)
    c.quadraticCurveTo(tooltipX + tooltipWidth, tooltipY + tooltipHeight, tooltipX + tooltipWidth,
      tooltipY + tooltipHeight - RADIUS)
    c.lineTo(tooltipX + tooltipWidth, tooltipY + RADIUS)
    c.quadraticCurveTo(tooltipX + tooltipWidth, tooltipY, tooltipX + tooltipWidth - RADIUS, tooltipY)
    c.lineTo(tooltipX + ARROW_SIZE, tooltipY)
    c.closePath()
  }
  c.fill()
  c.stroke()

  c.fillStyle = settings.theme.text.color
  c.font = font
  c.textBaseline = 'top'
  for (let i = 0; i < wrappedLines.length; i++) {
    drawText(c, wrappedLines[i], tooltipX + PADDING, tooltipY + PADDING + i * lineHeight, settings.theme.text.color)
  }

  c.restore()
}
