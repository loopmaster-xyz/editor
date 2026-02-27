import type { Context } from './context.ts'
import { drawToken } from './draw/token.ts'
import { loadFonts } from './fonts.ts'
import { ligatures } from './ligature.ts'
import type { Token } from './token.ts'

async function warmupLigatures(context: Context, tokenLines: Token[][]) {
  const tokens = tokenLines.flat().filter(token => ligatures.has(token.text))
  const canvas = new OffscreenCanvas(1, 1)
  const c = canvas.getContext('2d')
  for (const token of tokens) {
    const { promise } = drawToken(
      c,
      context,
      token,
      0,
      0,
    )
    if (promise) {
      await promise
    }
  }
}

export async function warmup(context: Context, tokenLines: Token[][]) {
  await Promise.all([
    loadFonts(context.settings.fontFamilies),
    document.fonts.ready,
    warmupLigatures(context, tokenLines),
  ])
}
