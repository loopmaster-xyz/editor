import type { Context } from '../context.ts'
import { getVerticalScrollbarSize } from './scrollbar.ts'

export function drawHeader(context: Context) {
  const header = context.header.value
  if (!header) return

  const { canvas, gutter, settings } = context
  const { c } = canvas
  const minimapWidth = settings.showMinimap ? getVerticalScrollbarSize(settings) : 0
  const width = Math.max(0, canvas.size.width.value - minimapWidth)
  const tx = gutter.width.value
  const tw = Math.max(0, width - tx)

  c.save()
  header.draw(c, 0, 0, width, header.height, tx, tw)
  c.restore()
}
