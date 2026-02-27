import type { Context } from '../context.ts'

export function drawHeader(context: Context) {
  const header = context.header.value
  if (!header) return

  const { canvas, gutter } = context
  const { c } = canvas
  const width = canvas.size.width.value
  const tx = gutter.width.value
  const tw = width - tx

  c.save()
  header.draw(c, 0, 0, width, header.height, tx, tw)
  c.restore()
}
