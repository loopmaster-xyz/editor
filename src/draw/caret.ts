import type { Context } from '../context.ts'
import { findVisualLineForColumn, getColumnForTokenIndex, getTokenIndexFromColumn,
  getXFromColumn } from '../line-utils.ts'
import { findCallBlockForToken, findTokenPositionInTokenLines, getParameterIndex,
  getParameterStartToken } from '../mouse.ts'
import { createOverlayCanvas } from '../overlay-canvas.ts'
import { calculateAboveHeightForLine } from './widget.ts'

import { getActiveCanvas } from '../textarea-singleton.ts'
import type { Token } from '../token.ts'

export function drawCaret(context: Context) {
  const { canvas, doc, lines, caret, settings, caches, gutter, scroll, header } = context
  const { c } = canvas

  const activeCanvas = getActiveCanvas()
  const isFocused = activeCanvas === canvas.el
  if (!isFocused) {
    caret.caretToken = null
    return
  }
  if (context.mouse.buttonsDown.value) {
    caret.caretToken = null
    return
  }

  const opacity = caret.updateBlink()

  const visualLines = lines.visualLines.value
  const codeLines = doc.code.split('\n')
  const currentLine = caret.line.value
  const currentColumn = caret.column.value

  if (currentLine < 0 || currentLine >= codeLines.length) {
    caret.caretToken = null
    return
  }

  const tokenLines = doc.tokenLines
  let foundLine = findVisualLineForColumn(lines, currentLine, currentColumn, tokenLines, caches)

  if (!foundLine) {
    const visualLines = lines.visualLines.value
    const relevantLines = visualLines.filter(line => line.logicalLine === currentLine)
    if (relevantLines.length > 0) {
      foundLine = relevantLines[0]
    }
    else {
      const lastVisualLine = visualLines[visualLines.length - 1]
      if (lastVisualLine && currentLine === lastVisualLine.logicalLine + 1) {
        foundLine = {
          tokens: [],
          logicalLine: currentLine,
          tokenOffset: 0,
          y: lastVisualLine.y + lastVisualLine.height,
          width: 0,
          height: settings.lineHeight,
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
      else {
        caret.caretToken = null
        return
      }
    }
  }

  let x = Math.max(1, getXFromColumn(lines, foundLine, currentColumn, tokenLines, canvas, settings, caches))
  for (const w of doc.widgets) {
    if (w.type === 'before' && w.pos.y - 1 === currentLine && w.pos.x - 1 === currentColumn) {
      x += w.pos.width
    }
  }

  const aboveHeight = calculateAboveHeightForLine(context, foundLine)
  const contentY = foundLine.tokenOffset === 0 ? foundLine.y : foundLine.y + aboveHeight
  const lineHeight = settings.lineHeight

  c.strokeStyle = settings.colors.brightWhite
  c.globalAlpha = opacity
  c.lineWidth = 1.5
  c.beginPath()
  c.moveTo(x, contentY)
  c.lineTo(x, contentY + lineHeight)
  c.stroke()
  c.globalAlpha = 1

  const logicalLineTokens = tokenLines[currentLine] || []
  const lineText = codeLines[currentLine] || ''
  if (logicalLineTokens.length > 0 && foundLine.tokens.length > 0) {
    const tokenColumn = currentColumn > 0 ? currentColumn - 1 : currentColumn
    let tokenIndex = getTokenIndexFromColumn(logicalLineTokens, tokenColumn)
    let token = tokenIndex >= 0 && tokenIndex < logicalLineTokens.length ? logicalLineTokens[tokenIndex] : null

    let finalToken: Token | null = token
    let finalTokenIndex = tokenIndex

    if (finalToken && finalTokenIndex >= 0 && finalTokenIndex < logicalLineTokens.length) {
      if (caret.isTyping.value) {
        const callBlock = findCallBlockForToken(tokenLines, currentLine, finalTokenIndex)
        const parameterIndex = callBlock.length > 0
          ? getParameterIndex(callBlock, tokenLines, currentLine, finalTokenIndex)
          : -1

        let tokenX = x
        for (const visualToken of foundLine.tokens) {
          if (visualToken.logicalTokenIndex === finalTokenIndex) {
            tokenX = visualToken.x
            break
          }
        }

        const headerHeight = header.value?.height ?? 0
        const scrollX = scroll.pos.x
        const scrollY = scroll.pos.y
        const canvasRect = canvas.rect
        let screenX = tokenX + gutter.width.value + settings.paddingLeft + scrollX + canvasRect.left
        let screenY = contentY + headerHeight + settings.paddingTop + scrollY + canvasRect.top
        if (parameterIndex >= 0) {
          const paramStartToken = getParameterStartToken(callBlock, parameterIndex)
          if (paramStartToken) {
            const pos = findTokenPositionInTokenLines(tokenLines, paramStartToken)
            if (pos) {
              const lineTokens = tokenLines[pos.lineIndex] || []
              const column = getColumnForTokenIndex(lineTokens, pos.tokenIndex)
              const paramLine = findVisualLineForColumn(lines, pos.lineIndex, column, tokenLines, caches)
              if (paramLine) {
                const paramX = getXFromColumn(lines, paramLine, column, tokenLines, canvas, settings, caches)
                const paramContentY = paramLine.tokenOffset === 0
                  ? paramLine.y
                  : paramLine.y + calculateAboveHeightForLine(context, paramLine)
                screenX = paramX + gutter.width.value + settings.paddingLeft + scrollX + canvasRect.left
                screenY = paramContentY + headerHeight + settings.paddingTop + scrollY + canvasRect.top
              }
            }
          }
        }

        let callBlockX = screenX
        let callBlockY = screenY
        if (callBlock.length > 0) {
          const lineTokens = tokenLines[currentLine] || []
          let functionTokenIndex = -1
          for (let i = 0; i < callBlock.length; i++) {
            const token = callBlock[i]
            if (token.text === '(' && i > 0) {
              const prevToken = callBlock[i - 1]
              if (prevToken && (prevToken.type === 'function' || prevToken.type === 'identifier')) {
                functionTokenIndex = lineTokens.indexOf(prevToken)
                break
              }
            }
          }
          if (functionTokenIndex >= 0) {
            for (const visualToken of foundLine.tokens) {
              if (visualToken.logicalTokenIndex === functionTokenIndex) {
                callBlockX = visualToken.x + gutter.width.value + settings.paddingLeft + scrollX + canvasRect.left
                callBlockY = contentY + headerHeight + settings.paddingTop + scrollY + canvasRect.top
                break
              }
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

export function getCaretScreenPosition(context: Context): { x: number; y: number } | null {
  const { doc, lines, caret, settings, caches, gutter, scroll, header } = context
  const codeLines = doc.code.split('\n')
  const currentLine = caret.line.value
  const currentColumn = caret.column.value
  if (currentLine < 0 || currentLine >= codeLines.length) return null
  const tokenLines = doc.tokenLines
  let foundLine = findVisualLineForColumn(lines, currentLine, currentColumn, tokenLines, caches)
  if (!foundLine) {
    const visualLines = lines.visualLines.value
    const relevantLines = visualLines.filter(line => line.logicalLine === currentLine)
    if (relevantLines.length > 0) foundLine = relevantLines[0]
    else {
      const lastVisualLine = visualLines[visualLines.length - 1]
      if (lastVisualLine && currentLine === lastVisualLine.logicalLine + 1) {
        foundLine = {
          tokens: [],
          logicalLine: currentLine,
          tokenOffset: 0,
          y: lastVisualLine.y + lastVisualLine.height,
          width: 0,
          height: settings.lineHeight,
          widgets: { above: [], below: [], overlay: [], inlay: [], beforeAfter: [], full: [] },
          errors: [],
        }
      }
      else return null
    }
  }
  const { canvas } = context
  let x = Math.max(1, getXFromColumn(lines, foundLine, currentColumn, tokenLines, canvas, settings, caches))
  for (const w of doc.widgets) {
    if (w.type === 'before' && w.pos.y - 1 === currentLine && w.pos.x - 1 === currentColumn) x += w.pos.width
  }
  const aboveHeight = calculateAboveHeightForLine(context, foundLine)
  const contentY = foundLine.tokenOffset === 0 ? foundLine.y : foundLine.y + aboveHeight
  const headerHeight = header.value?.height ?? 0
  const canvasRect = canvas.rect
  return {
    x: x + gutter.width.value + settings.paddingLeft + scroll.pos.x + canvasRect.left,
    y: contentY + headerHeight + settings.paddingTop + scroll.pos.y + canvasRect.top,
  }
}
