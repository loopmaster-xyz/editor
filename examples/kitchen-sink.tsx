import { effect } from '@preact/signals-core'
import { render } from 'preact'
import { useEffect, useMemo, useRef } from 'preact/hooks'
import { debounce } from 'utils/debounce'
import { unpack } from '../src/buffer.ts'
import { drawLine } from '../src/draw/lines.ts'
import { drawToken } from '../src/draw/token.ts'
import { drawRoundedRect } from '../src/draw/util.ts'
import { createDoc, createEditor, type Doc, draw, type Editor, type Token, type Widgets,
  type WidgetType, Position } from '../src/editor.ts'
import { measureText } from '../src/measure.ts'
import type { OverlayCanvas } from '../src/overlay-canvas.ts'
import { tokenize, tokenizer } from './tokenizer.ts'

// import namesDark from '../public/themes/_names-dark.json'
// import { setDebugOptions } from '@preact/signals-debug'

// // Configure debug options
// setDebugOptions({
//   grouped: true, // Group related updates in console output
//   enabled: true, // Enable/disable debugging
//   spacing: 2, // Number of spaces for nested update indentation
// })

const debouncedSetItem = debounce(50, (key: string, json: () => unknown) => {
  localStorage.setItem(key, JSON.stringify(json()))
})

function persist<T extends Record<string, unknown>>(
  key: string,
  watch: () => void,
  json: () => T,
  read: (data: Partial<T>) => void,
) {
  read(JSON.parse(localStorage.getItem(key) || '{}'))
  effect(() => {
    watch()
    debouncedSetItem(key, json)
  })
}

function createDocument(key: string, code: string) {
  const doc = createDoc(tokenizer)
  doc.code = code

  doc.widgets = [
    new Above({ x: [5, 14], y: 2 }),
    new Below({ x: [5, 14], y: 2 }),
    new Above({ x: [0, 10], y: 7 }),
    new Above({ x: [9, 20], y: 7 }),
    new Below({ x: [0, 15], y: 7 }),
    new Below({ x: [0, 5], y: 4 }),
    new Before({ x: 9, y: 7, width: 15 }),
    new After({ x: 22, y: 13, width: 15 }),
    new Inlay({ x: 16, y: 17 }, ': Metrics'),
    new Overlay({ x: [0, 0], y: 7 }),
  ] as Widgets

  doc.errors = [
    { x: [11, 26], y: 11, message: 'Oops a syntax error here' },
  ]

  persist(key, () => {
    doc.buffer.code
    doc.caret.line
    doc.caret.column
    doc.scroll.x
    doc.scroll.y
    doc.collapsed
    doc.selection.start.line
    doc.selection.start.column
    doc.selection.end.line
    doc.selection.end.column
    doc.selection.direction
  }, () => ({
    buffer: doc.buffer.pack(),
    caret: doc.caret,
    scroll: doc.scroll,
    collapsed: [...doc.collapsed],
    selection: doc.selection,
  }), data => {
    if (data.buffer) {
      const restoredBuffer = unpack(data.buffer)
      doc.buffer.code.value = restoredBuffer.code.value
      doc.buffer.history.value = restoredBuffer.history.value
      doc.buffer.index.value = restoredBuffer.index.value
    }
    Object.assign(doc.caret, data.caret ?? { line: 0, column: 0, columnIntent: 0 })
    Object.assign(doc.scroll, data.scroll ?? { x: 0, y: 0 })
    doc.collapsed = new Set(data.collapsed ?? [])
    Object.assign(doc.selection,
      data.selection ?? { start: { line: 0, column: 0 }, end: { line: 0, column: 0 }, direction: null })
  })

  return doc
}

class Above {
  type: WidgetType = 'above'

  constructor(public pos: { x: [start: number, end: number]; y: number }) {
  }

  draw(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    c.fillStyle = 'red'
    c.fillRect(x, y, w, h)
  }
}

class Below {
  type: WidgetType = 'below'

  constructor(public pos: { x: [start: number, end: number]; y: number }) {
  }

  draw(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    c.fillStyle = 'red'
    c.fillRect(x, y, w, h)
  }
}

class Before {
  type: WidgetType = 'before'

  constructor(public pos: { x: number; y: number; width: number }) {
  }

  draw(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    c.fillStyle = 'red'
    c.fillRect(x, y, w, h)
  }
}

class After {
  type: WidgetType = 'after'

  constructor(public pos: { x: number; y: number; width: number }) {
  }

  draw(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    c.fillStyle = 'red'
    c.fillRect(x, y, w, h)
  }
}

class Overlay {
  type: WidgetType = 'overlay'

  constructor(public pos: { x: [start: number, end: number]; y: number }) {
  }

  draw(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    c.strokeStyle = 'gray'
    c.strokeRect(x, y, w, h)
  }
}

class Inlay {
  type: WidgetType = 'inlay'

  constructor(public pos: { x: number; y: number }, public content: string = 'Inlay') {
  }

  draw(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
    c.fillStyle = 'gray'
    c.fillText(this.content, x, y + 2)
  }
}

// const select = document.createElement('select')
// document.body.appendChild(select)
// for (const theme of namesDark) {
//   const option = document.createElement('option')
//   option.value = theme
//   option.textContent = theme
//   select.appendChild(option)
// }
// select.addEventListener('change', event => {
//   const theme = (event.target as HTMLSelectElement).value
//   if (theme) {
//     fetch(`/themes/${theme}.json`)
//       .then(response => response.json())
//       .then(data => {
//         console.log(data)
//         Object.assign(editor.settings.colors, data)
//       })
//       .catch(error => {
//         console.error(error)
//       })
//   }
// })

type DefinitionType = 'variable' | 'keyword' | 'function'

interface Parameter {
  name: string
  description: string[]
}

interface Definition {
  type: DefinitionType
  name: string
  description: string[]
  code?: string
  parameters?: Parameter[]
}

const definitions = new Map<string, Definition>([
  ['Math.max', {
    type: 'function',
    name: 'Math.max',
    description: [
      'Returns the largest of zero or more numbers.',
      'If no arguments are given, the result is -Infinity.',
    ],
    code: 'Math.max(...values: number[]): number',
    parameters: [
      {
        name: 'values',
        description: [
          'Zero or more numbers among which the largest value will be selected.',
          'The values can be any numeric type (number, bigint, etc.).',
        ],
      },
    ],
  }],
  ['true', {
    type: 'keyword',
    name: 'true',
    description: [
      'The boolean value representing logical truth.',
      'Used in conditional statements and boolean expressions.',
    ],
  }],
  ['false', {
    type: 'keyword',
    name: 'false',
    description: [
      'The boolean value representing logical falsity.',
      'Used in conditional statements and boolean expressions.',
    ],
  }],
])

function wrapText(
  c: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  font: string,
): string[] {
  c.save()
  c.font = font
  const words = text.split(' ')
  const lines: string[] = []
  let currentLine = ''

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word
    const metrics = c.measureText(testLine)
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine)
      currentLine = word
    }
    else {
      currentLine = testLine
    }
  }
  if (currentLine) {
    lines.push(currentLine)
  }
  c.restore()
  return lines
}

function createSimpleCache() {
  return {
    measureTextCache: new Map<string, { width: number; height: number; fontHeight: number }>(),
  } as any
}

function drawDefinitionTooltip(
  overlayCanvas: OverlayCanvas,
  editor: Editor,
  x: number,
  y: number,
  token: Token,
  parameterIndex: number = -1,
): Position | null {
  const definition = definitions.get(token.text)
  if (!definition) return null

  const { c } = overlayCanvas
  const settings = editor.settings
  const caches = createSimpleCache()

  const PADDING = 12
  const ARROW_SIZE = 6
  const MAX_WIDTH = 450
  const MARGIN = 4
  const TOOLTIP_GAP = 0
  const RADIUS = 8
  const CODE_PADDING = 12
  const PARAGRAPH_SPACING = 8
  const CODE_SPACING = 12
  const PARAM_HIGHLIGHT_COLOR = '#3a3a3a'
  const PARAM_HIGHLIGHT_PADDING = 2

  const viewport = window.visualViewport!
  const viewportLeft = viewport.offsetLeft
  const viewportTop = viewport.offsetTop
  const viewportWidth = viewport.width
  const viewportHeight = viewport.height

  const codeFont = `${settings.fontSize} '${settings.fontFamilyName}', monospace`
  const textFont = `400 normal 13px 'Inter', sans-serif`

  const typeColors = {
    variable: '#66d9ef',
    keyword: '#66d9ef',
    function: '#a6e22e',
  }

  const typeColor = typeColors[definition.type] || '#f8f8f2'

  c.save()
  c.font = `600 normal 14px 'Inter', sans-serif`
  c.textBaseline = 'top'
  const nameMetrics = c.measureText(definition.name)

  let contentY = PADDING
  const contentWidth = MAX_WIDTH - PADDING * 2

  if (definition.code) {
    const codeTokens = tokenize(definition.code)
    const codeLines: { tokens: Token[]; width: number; height: number }[] = []
    let maxCodeWidth = 0

    for (const lineTokens of codeTokens) {
      let lineWidth = 0
      let lineHeight = 0
      for (const token of lineTokens) {
        const metrics = measureText(c, settings, caches, token)
        lineWidth += metrics.width
        lineHeight = Math.max(lineHeight, metrics.height)
      }
      codeLines.push({ tokens: lineTokens, width: lineWidth, height: lineHeight })
      maxCodeWidth = Math.max(maxCodeWidth, lineWidth)
    }

    contentY += nameMetrics.actualBoundingBoxAscent + nameMetrics.actualBoundingBoxDescent + PARAGRAPH_SPACING
      + CODE_SPACING
    const codeBgWidth = Math.min(maxCodeWidth + CODE_PADDING * 2, contentWidth)
    const codeBgHeight = codeLines.reduce((sum, line) => sum + line.height, 0) + CODE_PADDING * 2
    contentY += codeBgHeight + CODE_SPACING
  }
  else {
    contentY += nameMetrics.actualBoundingBoxAscent + nameMetrics.actualBoundingBoxDescent + PARAGRAPH_SPACING
  }

  if (parameterIndex >= 0 && definition.parameters && definition.parameters[parameterIndex]) {
    const param = definition.parameters[parameterIndex]
    c.font = textFont
    for (const paragraph of param.description) {
      const lines = wrapText(c, paragraph, contentWidth, textFont)
      for (const line of lines) {
        const metrics = c.measureText(line)
        contentY += metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + 4
      }
      contentY += PARAGRAPH_SPACING
    }
  }

  c.font = textFont
  for (const paragraph of definition.description) {
    const lines = wrapText(c, paragraph, contentWidth, textFont)
    for (const line of lines) {
      const metrics = c.measureText(line)
      contentY += metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + 4
    }
    contentY += PARAGRAPH_SPACING
  }

  const tooltipHeight = contentY - PARAGRAPH_SPACING + PADDING
  const tooltipWidth = MAX_WIDTH

  const tooltipYAbove = y - tooltipHeight - ARROW_SIZE - TOOLTIP_GAP
  const tooltipYBelow = y + settings.lineHeight + ARROW_SIZE + TOOLTIP_GAP

  const viewportTopWithMargin = viewportTop + MARGIN
  const viewportBottomWithMargin = viewportTop + viewportHeight - MARGIN

  const fitsAbove = tooltipYAbove >= viewportTopWithMargin && tooltipYAbove + tooltipHeight <= viewportBottomWithMargin
  const fitsBelow = tooltipYBelow >= viewportTopWithMargin && tooltipYBelow + tooltipHeight <= viewportBottomWithMargin

  let tooltipX = x
  let tooltipY: number
  let tooltipAbove: boolean

  if (fitsAbove) {
    tooltipAbove = true
    tooltipY = tooltipYAbove
  }
  else if (fitsBelow) {
    tooltipAbove = false
    tooltipY = tooltipYBelow
  }
  else {
    tooltipAbove = tooltipYAbove >= viewportTopWithMargin
    tooltipY = tooltipAbove ? tooltipYAbove : tooltipYBelow
  }

  const tooltipLeft = tooltipX <= x
  const position = tooltipAbove
    ? (tooltipLeft ? Position.TopLeft : Position.TopRight)
    : (tooltipLeft ? Position.BottomLeft : Position.BottomRight)

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

  const BG_COLOR = '#3a3a3a'
  const STROKE_COLOR = '#606060'
  c.fillStyle = BG_COLOR
  c.strokeStyle = STROKE_COLOR
  c.lineWidth = 1

  c.beginPath()
  if (tooltipAbove) {
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

  c.translate(tooltipX, tooltipY)

  contentY = PADDING

  c.font = `600 normal 14px 'Inter', sans-serif`
  c.fillStyle = typeColor
  c.textBaseline = 'top'
  c.fillText(definition.name, PADDING, contentY)
  contentY += nameMetrics.actualBoundingBoxAscent + nameMetrics.actualBoundingBoxDescent + PARAGRAPH_SPACING

  if (definition.code) {
    contentY += CODE_SPACING
    const codeTokens = tokenize(definition.code)
    const codeLines: { tokens: Token[]; width: number; height: number }[] = []
    let maxCodeWidth = 0

    for (const lineTokens of codeTokens) {
      let lineWidth = 0
      let lineHeight = 0
      for (const token of lineTokens) {
        const metrics = measureText(c, settings, caches, token)
        lineWidth += metrics.width
        lineHeight = Math.max(lineHeight, metrics.height)
      }
      codeLines.push({ tokens: lineTokens, width: lineWidth, height: lineHeight })
      maxCodeWidth = Math.max(maxCodeWidth, lineWidth)
    }

    const codeBgWidth = Math.min(maxCodeWidth + CODE_PADDING * 2, contentWidth)
    const codeBgHeight = codeLines.reduce((sum, line) => sum + line.height, 0) + CODE_PADDING * 2

    c.fillStyle = '#1e1e1e'
    drawRoundedRect(c, PADDING, contentY, codeBgWidth, codeBgHeight, 4)
    c.fill()

    let codeY = contentY + CODE_PADDING
    const paramHighlightRects: { x: number; y: number; width: number; height: number }[] = []

    for (const line of codeLines) {
      let codeX = PADDING + CODE_PADDING
      let inParameter = false
      let paramStartX = PADDING + CODE_PADDING
      let paramWidth = 0
      let paramHeight = 0
      let parenDepth = 0
      let currentParamIndex = -1

      for (const token of line.tokens) {
        if (token.text === '(') {
          parenDepth++
          if (parenDepth === 1) {
            currentParamIndex = 0
          }
        }
        else if (token.text === ')') {
          if (inParameter && currentParamIndex === parameterIndex) {
            paramHighlightRects.push({
              x: paramStartX - PARAM_HIGHLIGHT_PADDING,
              y: codeY - PARAM_HIGHLIGHT_PADDING,
              width: paramWidth + PARAM_HIGHLIGHT_PADDING * 2,
              height: paramHeight + PARAM_HIGHLIGHT_PADDING * 2,
            })
          }
          parenDepth--
          inParameter = false
        }
        else if (token.text === ',' && parenDepth === 1) {
          if (inParameter && currentParamIndex === parameterIndex) {
            paramHighlightRects.push({
              x: paramStartX - PARAM_HIGHLIGHT_PADDING,
              y: codeY - PARAM_HIGHLIGHT_PADDING,
              width: paramWidth + PARAM_HIGHLIGHT_PADDING * 2,
              height: paramHeight + PARAM_HIGHLIGHT_PADDING * 2,
            })
          }
          inParameter = false
          currentParamIndex++
        }
        else if (parenDepth === 1 && currentParamIndex === parameterIndex) {
          if (!inParameter && (token.type === 'identifier' || token.text === '...')) {
            inParameter = true
            paramStartX = codeX
            paramWidth = 0
            paramHeight = 0
          }
          if (inParameter) {
            const metrics = measureText(c, settings, caches, token)
            paramWidth += metrics.width
            paramHeight = Math.max(paramHeight, metrics.height)
          }
        }

        codeX += measureText(c, settings, caches, token).width
      }

      if (inParameter && currentParamIndex === parameterIndex) {
        paramHighlightRects.push({
          x: paramStartX - PARAM_HIGHLIGHT_PADDING,
          y: codeY - PARAM_HIGHLIGHT_PADDING,
          width: paramWidth + PARAM_HIGHLIGHT_PADDING * 2,
          height: paramHeight + PARAM_HIGHLIGHT_PADDING * 2,
        })
      }

      codeY += line.height
    }

    if (parameterIndex >= 0 && paramHighlightRects.length > 0) {
      c.fillStyle = PARAM_HIGHLIGHT_COLOR
      for (const rect of paramHighlightRects) {
        drawRoundedRect(c, rect.x, rect.y, rect.width, rect.height, 3)
        c.fill()
      }
    }

    codeY = contentY + CODE_PADDING
    for (const line of codeLines) {
      let codeX = PADDING + CODE_PADDING
      for (const token of line.tokens) {
        const { color, style, weight } = settings.theme[token.type]
        const fontWeight = weight === 'bold' ? 700 : 400
        c.font = `${fontWeight} ${style} ${codeFont}`
        c.fillStyle = color
        c.textBaseline = 'top'
        c.fillText(token.text, codeX, codeY)
        const metrics = measureText(c, settings, caches, token)
        codeX += metrics.width
      }
      codeY += line.height
    }

    if (parameterIndex >= 0 && definition.parameters && definition.parameters[parameterIndex]) {
      codeY += CODE_SPACING
      const param = definition.parameters[parameterIndex]
      c.font = `600 normal 13px 'Inter', sans-serif`
      c.fillStyle = '#a6e22e'
      c.textBaseline = 'top'
      c.fillText(`Parameter: ${param.name}`, PADDING, codeY)
      codeY += 18 + PARAGRAPH_SPACING

      c.font = textFont
      c.fillStyle = '#e0e0e0'
      for (const paragraph of param.description) {
        const lines = wrapText(c, paragraph, contentWidth, textFont)
        for (const line of lines) {
          c.fillText(line, PADDING, codeY)
          const metrics = c.measureText(line)
          codeY += metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + 4
        }
        codeY += PARAGRAPH_SPACING
      }
      contentY = codeY - PARAGRAPH_SPACING
    }
    else {
      contentY += codeBgHeight + CODE_SPACING
    }
  }

  c.font = textFont
  c.fillStyle = '#e0e0e0'
  c.textBaseline = 'top'

  for (const paragraph of definition.description) {
    const lines = wrapText(c, paragraph, contentWidth, textFont)
    for (const line of lines) {
      c.fillText(line, PADDING, contentY)
      const metrics = c.measureText(line)
      contentY += metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent + 4
    }
    contentY += PARAGRAPH_SPACING
  }

  c.restore()
  return position
}

const Editor = ({ doc }: { doc: Doc }) => {
  const ref = useRef<HTMLDivElement>(null)

  const editor = useMemo(() =>
    createEditor({
      wordWrap: false,
      colors: {
        black: '#272822',
        red: '#f92672',
        green: '#a6e22e',
        yellow: '#e6db74',
        blue: '#66d9ef',
        purple: '#ae81ff',
        cyan: '#38ccd1',
        white: '#f8f8f2',
        gray: '#75715e',
        brightBlack: '#666666',
        brightRed: '#fd5ff1',
        brightGreen: '#a1efe4',
        brightYellow: '#ffd866',
        brightBlue: '#66d9ef',
        brightPurple: '#ae81ff',
        brightCyan: '#a1efe4',
        brightWhite: '#f9f8f5',
      },
      syntax: c => ({
        keyword: { color: c.blue, style: 'italic', weight: 'regular' },
        function: { color: c.green, style: 'normal', weight: 'regular' },
        identifier: { color: c.white, style: 'normal', weight: 'regular' },
        string: { color: c.yellow, style: 'normal', weight: 'regular' },
        number: { color: c.cyan, style: 'normal', weight: 'regular' },
        boolean: { color: c.red, style: 'normal', weight: 'regular' },
        null: { color: c.blue, style: 'normal', weight: 'regular' },
        operator: { color: c.red, style: 'normal', weight: 'regular' },
        punctuation: { color: c.gray, style: 'normal', weight: 'regular' },
        comment: { color: c.gray, style: 'normal', weight: 'regular' },
        text: { color: c.white, style: 'normal', weight: 'regular' },
      }),
    }), [])

  useEffect(() => {
    return () => {
      editor.dispose()
    }
  }, [editor])

  useEffect(() => {
    editor.setDoc(doc)
  }, [editor, doc])

  editor.header = {
    height: 40,
    draw: (c, x, y, w, h, tx, tw) => {
      c.fillStyle = '#000b'
      c.fillRect(tx, y, tw, h)
    },
  }

  editor.onHoverToken = editor.onCaretToken = (canvas, x, y, token, callBlock, parameterIndex, callBlockX, callBlockY,
    doc) =>
  {
    const isFunctionCall = callBlock.length > 0
    let definitionKey: string | null = null

    if (isFunctionCall) {
      const callBlockText = callBlock.map(t => t.text).join('')
      if (callBlockText.includes('Math') && callBlockText.includes('max')) {
        definitionKey = 'Math.max'
      }
    }

    if (!definitionKey) {
      definitionKey = token.text
      if (token.text === 'max') {
        definitionKey = 'Math.max'
      }
    }

    const tokenWithKey = { ...token, text: definitionKey }
    const definition = definitions.get(definitionKey)

    if (definition) {
      if (definition.type === 'function' && isFunctionCall) {
        return drawDefinitionTooltip(canvas as unknown as OverlayCanvas, editor, callBlockX, callBlockY, tokenWithKey,
          parameterIndex)
      }
      return drawDefinitionTooltip(canvas as unknown as OverlayCanvas, editor, x, y, tokenWithKey, parameterIndex)
    }
    return null
  }

  window.oncontextmenu = event => {
    event.preventDefault()
    editor.settings.wordWrap = !editor.settings.wordWrap
  }

  useEffect(() => {
    if (ref.current) {
      ref.current.appendChild(editor.canvas)
      editor.canvas.focus()
    }
  }, [ref, editor])
  return <div ref={ref} class="w-[600px] h-[400px]" />
}

const docs = Array.from({ length: 10 },
  (_, i) => createDocument(`doc${i}`, `\n\nsome line here\n\n\n\n\n${drawLine} ${drawToken}`.repeat(3)))

const App = () => {
  return (
    <div class="flex flex-col gap-4 items-center justify-center w-full m-10">
      {docs.map((doc, i) => <Editor doc={doc} key={i} />)}
    </div>
  )
}

// const container = document.createElement('div')
// Object.assign(container.style, {
//   cssText: `
//     display: flex;
//     flex: 1;
//     width: 100dvw;
//     height: 100dvh;
//   `,
// })

// document.body.appendChild(container)
// container.appendChild(editor.canvas)
// editor.canvas.focus()
let rafId: ReturnType<typeof requestAnimationFrame> = null
const tick = () => {
  draw()
  rafId = requestAnimationFrame(tick)
}
tick()

render(<App />, document.getElementById('app'))

// if (import.meta.hot) {
//   import.meta.hot.accept(() => {
//     try {
//       // container.remove()
//       // select.remove()
//       // editor.dispose()
//     }
//     catch {}
//   })
// }
