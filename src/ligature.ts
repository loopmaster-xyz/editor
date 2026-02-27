import { Deferred } from 'utils/deferred'

export interface LigatureRendererOptions {
  fontSize?: string
  fontUrl: string
  fontWeight?: string | number
  textColor?: string
  bgColor?: string
  dpr?: number
}

// Memoization caches
const fontBase64Cache = new Map<string, Deferred<string>>()
const ligatureCanvasCache = new Map<string, OffscreenCanvas>()

async function loadFontAsBase64(fontUrl: string): Promise<string> {
  // Check cache first
  if (fontBase64Cache.has(fontUrl)) {
    return fontBase64Cache.get(fontUrl)!.promise
  }

  // Cache it
  const deferred = Deferred<string>()
  fontBase64Cache.set(fontUrl, deferred)

  // Fetch and convert font to base64
  const buffer = await fetch(fontUrl).then(response => response.arrayBuffer())
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  const base64 = btoa(binary)
  deferred.resolve(base64)

  return deferred.promise
}

function getCacheKey(
  ligature: string,
  fontSize: string,
  fontUrl: string,
  textColor: string,
  bgColor: string,
  dpr: number,
): string {
  return [
    ligature,
    fontSize,
    fontUrl,
    textColor,
    bgColor,
    dpr,
  ].join('|')
}

function renderLigatureSync(ligature: string, options: LigatureRendererOptions) {
  const {
    fontSize = '16px',
    fontUrl,
    fontWeight = 400,
    textColor = 'black',
    bgColor = 'transparent',
    dpr = 1.5,
  } = options

  const cacheKey = getCacheKey(ligature, fontSize, fontUrl, textColor, bgColor, dpr)
  if (ligatureCanvasCache.has(cacheKey)) {
    return ligatureCanvasCache.get(cacheKey)
  }

  return false
}

export async function renderLigature(
  ligature: string,
  width: number,
  height: number,
  options: LigatureRendererOptions,
): Promise<OffscreenCanvas> {
  const {
    fontSize = '16px',
    fontUrl,
    fontWeight = 400,
    textColor = 'black',
    bgColor = 'transparent',
    dpr = 1.5,
  } = options

  const cacheKey = getCacheKey(ligature, fontSize, fontUrl, textColor, bgColor, dpr)

  const span = document.createElement('span')
  span.innerText = ligature
  ligature = span.innerHTML

  // Load font (memoized)
  const base64 = await loadFontAsBase64(fontUrl)

  const makeSvg = ({ width, height }: { width: number; height: number }) => {
    return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice" width="${width}" height="${height}">
  <style>
    @font-face {
      font-family: 'LigaFont';
      src: url(data:application/font-truetype;base64,${base64}) format('truetype');
    }
    .ligature-text {
      font-family: 'LigaFont';
      font-size: ${fontSize};
      font-weight: ${fontWeight};
      fill: ${textColor};
      dominant-baseline: hanging;
    }
    .ligature-bg {
      fill: ${bgColor};
    }
  </style>
  <rect class="ligature-bg" x="0" y="0" width="${width}" height="${height}" />
  <text
    x="0"
    y="50%"
    class="ligature-text"
    dominant-baseline="middle"
    alignment-baseline="middle"
  >${ligature}</text>
</svg>
`
  }
  // Create final SVG with exact dimensions
  const svg = makeSvg({ width, height })

  // Create final OffscreenCanvas with measured dimensions
  const canvas = new OffscreenCanvas(width * dpr, height * dpr)
  const ctx = canvas.getContext('2d')

  if (!ctx) {
    throw new Error('Could not get 2D context from OffscreenCanvas')
  }

  ctx.scale(dpr, dpr)

  // Load and draw final SVG
  await new Promise<void>((resolve, reject) => {
    const img = new Image(width, height)

    img.onload = () => {
      ctx.drawImage(img, 0, 0)
      resolve()
    }

    img.onerror = () => {
      reject(new Error('Failed to load SVG image'))
    }

    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
  })

  // Cache the result
  ligatureCanvasCache.set(cacheKey, canvas)

  return canvas
}

export const ligatures = new Set([
  '->',
  '->>',
  '-->',
  '<-',
  '<<-',
  '<-->',
  '=>',
  '==>',
  '<=>',
  '<=',
  '>=',
  '<|',
  '|>',
  '<~',
  '~>',
  '<~>',
  '~~>',
  '<->',
  '==',
  '===',
  '!=',
  '!==',
  '<>',
  '<=',
  '<+',
  '+=',
  '-=',
  '*=',
  '/=',
  '**',
  '**=',
  '++',
  '--',
  '-+',
  '+-',
  '&&',
  '||',
  '!!',
  '&=',
  '|=',
  '^=',
  '~=',
  '::',
  ':::',
  '|->',
  '<-',
  '|',
  '...',
  '..<',
  '..<.',
  '!!!',
  '~~~',
  '<*>',
  '<$>',
  '<$>',
  '<$!>',
  '+++',
  '^^',
])

function drawLigatureCanvas(c: OffscreenCanvasRenderingContext2D, ligatureCanvas: OffscreenCanvas, x: number, y: number,
  options: LigatureRendererOptions)
{
  c.drawImage(
    ligatureCanvas,
    x,
    y,
    ligatureCanvas.width / options.dpr,
    ligatureCanvas.height / options.dpr,
  )
}

export async function drawLigature(
  c: OffscreenCanvasRenderingContext2D,
  ligature: string,
  x: number,
  y: number,
  width: number,
  height: number,
  options: LigatureRendererOptions,
) {
  let ligatureCanvas = renderLigatureSync(ligature, options)
  if (ligatureCanvas) {
    drawLigatureCanvas(c, ligatureCanvas, x, y, options)
    return null
  }
  ligatureCanvas = await renderLigature(ligature, width, height, options)
  drawLigatureCanvas(c, ligatureCanvas, x, y, options)
}
