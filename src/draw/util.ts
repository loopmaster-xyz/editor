export function drawRoundedRect(
  c: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  c.beginPath()
  c.moveTo(x + radius, y)
  c.lineTo(x + width - radius, y)
  c.quadraticCurveTo(x + width, y, x + width, y + radius)
  c.lineTo(x + width, y + height - radius)
  c.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  c.lineTo(x + radius, y + height)
  c.quadraticCurveTo(x, y + height, x, y + height - radius)
  c.lineTo(x, y + radius)
  c.quadraticCurveTo(x, y, x + radius, y)
  c.closePath()
}

export function drawText(
  c: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
) {
  c.fillStyle = color
  c.strokeStyle = color
  c.lineWidth = .2
  c.lineCap = 'round'
  c.lineJoin = 'miter'
  c.miterLimit = 3
  c.fillText(text, x, y)
  c.strokeText(text, x, y)
}
