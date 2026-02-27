import type { Context } from '../context.ts'
import { drawLigature, ligatures } from '../ligature.ts'
import { measureText } from '../measure.ts'
import type { Token } from '../token.ts'
import { drawText } from './util.ts'

const IS_CHROME = navigator.userAgent.includes('Chrome')

export function drawToken(
  c: OffscreenCanvasRenderingContext2D,
  context: Context,
  token: Token,
  x: number,
  y: number,
  colorOverride?: string,
) {
  const { text, type } = token
  const { color: themeColor, style, weight } = context.settings.theme[type]
  const color = colorOverride ?? themeColor
  const { width, height } = measureText(context.canvas.c, context.settings, context.caches, token)
  const fontWeight = weight === 'bold' ? 700 : 400
  c.save()
  try {
    c.font = `${fontWeight} ${style} ${context.settings.fontSize} '${context.settings.fontFamilyName}', monospace`
    c.textBaseline = 'top'
    if (IS_CHROME && ligatures.has(text)) {
      const fontUrl = context.settings.fontFamilies.find(font =>
        font.style === style && font.weight === (weight === 'bold' ? 'bold' : 'normal')
      )?.url
      const options = {
        fontUrl,
        fontWeight,
        fontSize: context.settings.fontSize,
        bgColor: 'transparent',
        textColor: color,
        dpr: context.canvas.ligatureDpr.value,
      }
      const promise = drawLigature(c, text, x, y, width, height, options)
      return { promise, width, height }
    }
    else {
      drawText(c, text, x, y, color)
      return { promise: null, width, height }
    }
  }
  finally {
    c.restore()
  }
}
