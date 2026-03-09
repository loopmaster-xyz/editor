import type { Context } from '../context.ts'
import { findVisualLineForColumn, getColumnForTokenIndex, getTokenIndexFromColumn,
  getXFromColumn } from '../line-utils.ts'
import { findCallBlockForToken, getParameterIndex, getParameterStartToken } from '../mouse.ts'
import { createOverlayCanvas } from '../overlay-canvas.ts'
import { getActiveCanvas } from '../textarea-singleton.ts'
import type { Token } from '../token.ts'
import type { VisualLine } from '../lines.ts'
import { calculateAboveHeightForLine } from './widget.ts'

type CaretLayout = {
  visualLine: VisualLine
  contentX: number
  contentY: number
  screenX: number
  screenY: number
}

type CaretCallBlockAnalysis = {
  revision: number
  tokenVersion: number
  line: number
  tokenIndex: number
  token: Token
  callBlock: Token[]
  parameterIndex: number
  parameterStartToken: Token | null
  functionToken: Token | null
}

const caretCallBlockAnalysisByContext = new WeakMap<Context, CaretCallBlockAnalysis>()

function createSyntheticCaretLine(currentLine: number, y: number, lineHeight: number): VisualLine {
  return {
    tokens: [],
    logicalLine: currentLine,
    tokenOffset: 0,
    y,
    width: 0,
    height: lineHeight,
    aboveHeight: 0,
    logicalAboveHeight: 0,
    widgets: {
      above: [],
      below: [],
      overlay: [],
      inlay: [],
      beforeAfter: [],
      full: [],
    },
    errors: [],
  }
}

function resolveCaretVisualLine(context: Context, currentLine: number, currentColumn: number, tokenLines: Token[][]) {
  const { lines, settings, caches } = context
  let foundLine = findVisualLineForColumn(lines, currentLine, currentColumn, tokenLines, caches)
  if (foundLine) return foundLine

  const relevantLines = lines.visualLinesByLogicalLine.value[currentLine] ?? []
  if (relevantLines.length > 0) return relevantLines[0]

  const getLastVisualLine = typeof lines.getLastVisualLine === 'function'
    ? lines.getLastVisualLine.bind(lines)
    : () => lines.visualLines.value.at(-1) ?? null
  const lastVisualLine = getLastVisualLine()
  if (lastVisualLine && currentLine === lastVisualLine.logicalLine + 1) {
    return createSyntheticCaretLine(currentLine, lastVisualLine.y + lastVisualLine.height, settings.lineHeight)
  }

  return null
}

function resolveBeforeWidgetOffset(context: Context, line: number, column: number): number {
  let offset = 0
  for (const widget of context.doc.widgets) {
    if (widget.type === 'before' && widget.pos.y - 1 === line && widget.pos.x - 1 === column) {
      offset += widget.pos.width
    }
  }
  return offset
}

function toScreenPosition(context: Context, x: number, contentY: number): { x: number; y: number } {
  const { settings, gutter, scroll, canvas, header } = context
  const headerHeight = header.value?.height ?? 0
  const canvasRect = canvas.rect

  return {
    x: x + gutter.width.value + settings.paddingLeft + scroll.pos.x + canvasRect.left,
    y: contentY + headerHeight + settings.paddingTop + scroll.pos.y + canvasRect.top,
  }
}

function resolveCaretLayout(context: Context): CaretLayout | null {
  const { doc, lines, caret, settings, caches, canvas } = context
  const codeLines = doc.lines
  const currentLine = caret.line.value
  const currentColumn = caret.column.value
  if (currentLine < 0 || currentLine >= codeLines.length) return null

  const tokenLines = doc.tokenLines
  const foundLine = resolveCaretVisualLine(context, currentLine, currentColumn, tokenLines)
  if (!foundLine) return null

  const baseX = Math.max(1, getXFromColumn(lines, foundLine, currentColumn, tokenLines, canvas, settings, caches))
  const contentX = baseX + resolveBeforeWidgetOffset(context, currentLine, currentColumn)
  const aboveHeight = calculateAboveHeightForLine(context, foundLine)
  const contentY = foundLine.tokenOffset === 0 ? foundLine.y : foundLine.y + aboveHeight
  const screen = toScreenPosition(context, contentX, contentY)

  return {
    visualLine: foundLine,
    contentX,
    contentY,
    screenX: screen.x,
    screenY: screen.y,
  }
}

function moveTokenPosition(tokenLines: Token[][], lineIndex: number, tokenIndex: number, delta: number): {
  lineIndex: number
  tokenIndex: number
} | null
{
  if (delta === 0) return { lineIndex, tokenIndex }

  let line = lineIndex
  let token = tokenIndex

  if (delta > 0) {
    for (let i = 0; i < delta; i++) {
      token++
      while (line < tokenLines.length && token >= (tokenLines[line]?.length ?? 0)) {
        line++
        token = 0
      }
      if (line >= tokenLines.length) return null
    }
    return { lineIndex: line, tokenIndex: token }
  }

  for (let i = 0; i < -delta; i++) {
    token--
    while (line >= 0 && token < 0) {
      line--
      if (line < 0) return null
      token = (tokenLines[line]?.length ?? 0) - 1
    }
    if (line < 0) return null
  }

  return { lineIndex: line, tokenIndex: token }
}

function findCallBlockTokenPositionFromAnchor(
  tokenLines: Token[][],
  callBlock: Token[],
  anchorLine: number,
  anchorTokenIndex: number,
  anchorToken: Token,
  targetToken: Token,
): { lineIndex: number; tokenIndex: number } | null
{
  const anchorBlockIndex = callBlock.indexOf(anchorToken)
  const targetBlockIndex = callBlock.indexOf(targetToken)
  if (anchorBlockIndex < 0 || targetBlockIndex < 0) return null
  return moveTokenPosition(tokenLines, anchorLine, anchorTokenIndex, targetBlockIndex - anchorBlockIndex)
}

function resolveCaretCallBlockAnalysis(
  context: Context,
  tokenLines: Token[][],
  line: number,
  tokenIndex: number,
  token: Token,
): CaretCallBlockAnalysis {
  const revision = context.doc.revision
  const tokenVersion = context.doc.tokenVersion
  const cached = caretCallBlockAnalysisByContext.get(context)
  if (
    cached
    && cached.revision === revision
    && cached.tokenVersion === tokenVersion
    && cached.line === line
    && cached.tokenIndex === tokenIndex
    && cached.token === token
  ) {
    return cached
  }

  const callBlock = findCallBlockForToken(tokenLines, line, tokenIndex)
  const parameterIndex = callBlock.length > 0
    ? getParameterIndex(callBlock, tokenLines, line, tokenIndex)
    : -1
  const parameterStartToken = parameterIndex >= 0 ? getParameterStartToken(callBlock, parameterIndex) : null
  let functionToken: Token | null = null
  for (let i = 0; i < callBlock.length; i++) {
    const blockToken = callBlock[i]
    if (blockToken.text === '(' && i > 0) {
      const prevToken = callBlock[i - 1]
      if (prevToken && (prevToken.type === 'function' || prevToken.type === 'identifier')) {
        functionToken = prevToken
        break
      }
    }
  }

  const analysis: CaretCallBlockAnalysis = {
    revision,
    tokenVersion,
    line,
    tokenIndex,
    token,
    callBlock,
    parameterIndex,
    parameterStartToken,
    functionToken,
  }
  caretCallBlockAnalysisByContext.set(context, analysis)
  return analysis
}

export function drawCaret(context: Context) {
  const { canvas, doc, lines, caret, settings, caches } = context
  const { c } = canvas

  const activeCanvas = getActiveCanvas()
  const isFocused = activeCanvas === canvas.el
  if (!isFocused) {
    caret.caretToken = null
    caret.screenPosition = null
    return
  }
  const isSelectingWithMouse = context.mouse.buttonsDown.value
  if (isSelectingWithMouse) {
    caret.caretToken = null
  }

  const opacity = caret.updateBlink()
  const layout = resolveCaretLayout(context)
  if (!layout) {
    caret.caretToken = null
    caret.screenPosition = null
    return
  }

  const currentLine = caret.line.value
  const currentColumn = caret.column.value
  const tokenLines = doc.tokenLines
  const foundLine = layout.visualLine

  const x = layout.contentX
  const contentY = layout.contentY
  const lineHeight = settings.lineHeight

  c.strokeStyle = settings.colors.brightWhite
  c.globalAlpha = opacity
  c.lineWidth = 1.5
  c.beginPath()
  c.moveTo(x, contentY)
  c.lineTo(x, contentY + lineHeight)
  c.stroke()
  c.globalAlpha = 1
  caret.screenPosition = { x: layout.screenX, y: layout.screenY }

  const logicalLineTokens = tokenLines[currentLine] || []
  if (logicalLineTokens.length > 0 && foundLine.tokens.length > 0) {
    const tokenColumn = currentColumn > 0 ? currentColumn - 1 : currentColumn
    const tokenIndex = getTokenIndexFromColumn(logicalLineTokens, tokenColumn)
    const finalTokenIndex = tokenIndex
    const finalToken = tokenIndex >= 0 && tokenIndex < logicalLineTokens.length ? logicalLineTokens[tokenIndex] : null

    if (finalToken && finalTokenIndex >= 0 && finalTokenIndex < logicalLineTokens.length) {
      if (!isSelectingWithMouse && caret.isTyping.value && context.onCaretToken) {
        const analysis = resolveCaretCallBlockAnalysis(context, tokenLines, currentLine, finalTokenIndex, finalToken)
        const callBlock = analysis.callBlock
        const parameterIndex = analysis.parameterIndex

        let tokenX = x
        for (const visualToken of foundLine.tokens) {
          if (visualToken.logicalTokenIndex === finalTokenIndex) {
            tokenX = visualToken.x
            break
          }
        }

        let { x: screenX, y: screenY } = toScreenPosition(context, tokenX, contentY)
        if (parameterIndex >= 0) {
          const paramStartToken = analysis.parameterStartToken
          if (paramStartToken) {
            const pos = findCallBlockTokenPositionFromAnchor(tokenLines, callBlock, currentLine, finalTokenIndex,
              finalToken, paramStartToken)
            if (pos) {
              const lineTokens = tokenLines[pos.lineIndex] || []
              const column = getColumnForTokenIndex(lineTokens, pos.tokenIndex)
              const paramLine = findVisualLineForColumn(lines, pos.lineIndex, column, tokenLines, caches)
              if (paramLine) {
                const paramX = getXFromColumn(lines, paramLine, column, tokenLines, canvas, settings, caches)
                const paramContentY = paramLine.tokenOffset === 0
                  ? paramLine.y
                  : paramLine.y + calculateAboveHeightForLine(context, paramLine)
                const paramScreen = toScreenPosition(context, paramX, paramContentY)
                screenX = paramScreen.x
                screenY = paramScreen.y
              }
            }
          }
        }

        let callBlockX = screenX
        let callBlockY = screenY
        const functionToken = analysis.functionToken
        if (callBlock.length > 0 && functionToken) {
          const functionPos = findCallBlockTokenPositionFromAnchor(tokenLines, callBlock, currentLine, finalTokenIndex,
            finalToken, functionToken)
          if (functionPos) {
            const functionLineTokens = tokenLines[functionPos.lineIndex] || []
            const functionColumn = getColumnForTokenIndex(functionLineTokens, functionPos.tokenIndex)
            const functionLine = findVisualLineForColumn(lines, functionPos.lineIndex, functionColumn, tokenLines,
              caches)
            if (functionLine) {
              const functionX = getXFromColumn(lines, functionLine, functionColumn, tokenLines, canvas, settings,
                caches)
              const functionContentY = functionLine.tokenOffset === 0
                ? functionLine.y
                : functionLine.y + calculateAboveHeightForLine(context, functionLine)
              const functionScreen = toScreenPosition(context, functionX, functionContentY)
              callBlockX = functionScreen.x
              callBlockY = functionScreen.y
            }
          }
        }

        caret.caretToken = {
          canvas: createOverlayCanvas(),
          x: screenX,
          y: screenY,
          token: finalToken,
          callBlock,
          parameterIndex,
          callBlockX,
          callBlockY,
        }
      }
      else if (!context.mouse.hovered.hoverToken) {
        caret.caretToken = null
      }
    }
    else if (!context.mouse.hovered.hoverToken) {
      caret.caretToken = null
    }
  }
  else {
    caret.caretToken = null
  }
}

/** @deprecated Use `context.caret.screenPosition` directly. */
export function getCaretScreenPosition(context: Context): { x: number; y: number } | null {
  return context.caret.screenPosition
}
