import { type Context } from '../context.ts'
import { getXFromColumn } from '../line-utils.ts'
import type { VisualLine } from '../lines.ts'
import { calculateAboveHeightForLine } from './widget.ts'

function drawSquiggle(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
) {
  c.strokeStyle = '#ff0000'
  c.lineWidth = 1.25
  c.beginPath()
  const amplitude = 1
  const period = 5
  for (let i = 0; i <= width; i += 0.5) {
    const triangle = 2 * amplitude
        * Math.abs(2 * ((i / period) - Math.floor(0.5 + i / period)))
      - amplitude
    const squiggleY = y + triangle
    if (i === 0) {
      c.moveTo(x + i, squiggleY)
    }
    else {
      c.lineTo(x + i, squiggleY)
    }
  }
  c.stroke()
}

export function drawErrorSquiggles(
  context: Context,
  line: VisualLine,
) {
  const errors = line.errors
  if (errors.length === 0) return

  const { lines, doc, canvas, settings, caches } = context
  const { c } = canvas
  const { lineHeight } = settings
  const tokenLines = doc.tokenLines
  const aboveHeight = calculateAboveHeightForLine(context, line)
  const contentY = line.tokenOffset === 0 ? line.y : line.y + aboveHeight

  for (const error of errors) {
    const [startColumn, endColumn] = [error.x[0] - 1, error.x[1] - 1]
    const startX = getXFromColumn(lines, line, startColumn, tokenLines, canvas, settings, caches)
    const endX = getXFromColumn(lines, line, endColumn, tokenLines, canvas, settings, caches)
    const errorWidth = endX - startX
    drawSquiggle(c, startX, contentY + lineHeight - 2, errorWidth)
  }
}
