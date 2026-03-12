import { batch, effect, type Signal, signal, untracked } from '@preact/signals-core'
import { MouseButton } from 'utils/mouse-buttons'
import type { Blocks } from './blocks.ts'
import type { Caches } from './caches.ts'
import type { Canvas } from './canvas.ts'
import type { Caret } from './caret.ts'
import type { Doc, DocError } from './doc.ts'
import { hitTestGutter } from './draw/gutter.ts'
import { getVerticalScrollbarSize, hitTestScrollbar } from './draw/scrollbar.ts'
import type { Gutter } from './gutter.ts'
import type { Header } from './header.ts'
import { signalify } from './lib/signalify.ts'
import {
  findLineBoundaries,
  findVisualLineForColumn,
  findWordBoundaries,
  getCharOffsetForVisualLine,
  getColumnForTokenIndex,
  getColumnFromVisualPosition,
  getXFromColumn,
  getXFromColumnUnclamped,
} from './line-utils.ts'
import type { Lines, VisualLine, VisualToken } from './lines.ts'
import { createOverlayCanvas } from './overlay-canvas.ts'
import { type Scroll, SCROLL_SMOOTH_KEYBOARD, SCROLL_SMOOTH_SCROLLING } from './scroll.ts'
import type { Scrollbars } from './scrollbars.ts'
import type { Selection } from './selection.ts'
import type { Settings } from './settings.ts'
import { getTextareaElement, setActiveCanvas } from './textarea-singleton.ts'
import type { Token } from './token.ts'
import type { Widget } from './widget.ts'

export type Mouse = ReturnType<typeof createMouse>

function lowerBoundVisualLineBottom(visualLines: VisualLine[], worldY: number): number {
  let low = 0
  let high = visualLines.length

  while (low < high) {
    const mid = (low + high) >> 1
    const line = visualLines[mid]
    if (line.y + line.height <= worldY) {
      low = mid + 1
    }
    else {
      high = mid
    }
  }

  return low
}

function lowerBoundVisualLineStart(visualLines: VisualLine[], worldY: number): number {
  let low = 0
  let high = visualLines.length

  while (low < high) {
    const mid = (low + high) >> 1
    const line = visualLines[mid]
    if (line.y < worldY) {
      low = mid + 1
    }
    else {
      high = mid
    }
  }

  return low
}

function findVisualLineAtWorldY(visualLines: VisualLine[], worldY: number): VisualLine | null {
  const index = lowerBoundVisualLineBottom(visualLines, worldY)
  if (index < 0 || index >= visualLines.length) return null
  const line = visualLines[index]
  if (worldY >= line.y && worldY < line.y + line.height) return line
  return null
}

function findNearestVisualLineAtWorldY(visualLines: VisualLine[], worldY: number): VisualLine | null {
  if (visualLines.length === 0) return null

  const containing = findVisualLineAtWorldY(visualLines, worldY)
  if (containing) return containing

  const insertionIndex = lowerBoundVisualLineBottom(visualLines, worldY)
  if (insertionIndex <= 0) return visualLines[0]
  if (insertionIndex >= visualLines.length) return visualLines[visualLines.length - 1]

  const before = visualLines[insertionIndex - 1]
  const after = visualLines[insertionIndex]
  const beforeDistance = Math.abs(worldY - (before.y + before.height / 2))
  const afterDistance = Math.abs(worldY - (after.y + after.height / 2))
  return beforeDistance <= afterDistance ? before : after
}

function moveTokenPosition(tokenLines: Token[][], lineIndex: number, tokenIndex: number, delta: number): {
  lineIndex: number
  tokenIndex: number
} | null {
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
): { lineIndex: number; tokenIndex: number } | null {
  const anchorBlockIndex = callBlock.indexOf(anchorToken)
  const targetBlockIndex = callBlock.indexOf(targetToken)
  if (anchorBlockIndex < 0 || targetBlockIndex < 0) return null
  return moveTokenPosition(tokenLines, anchorLine, anchorTokenIndex, targetBlockIndex - anchorBlockIndex)
}

function findCallBlock(tokenLines: Token[][], lineIndex: number, tokenIndex: number): Token[] {
  const line = tokenLines[lineIndex]
  if (!line || tokenIndex >= line.length) return []

  const token = line[tokenIndex]
  if (token.type !== 'function' && token.type !== 'identifier') return []

  if (tokenIndex + 1 >= line.length) return []
  const nextToken = line[tokenIndex + 1]
  if (nextToken.text !== '(') return []

  const memberAccessTokens: Token[] = []
  let currentMemberIndex = tokenIndex - 1
  while (currentMemberIndex >= 0) {
    const currentToken = line[currentMemberIndex]
    if (currentToken.type === 'punctuation' && currentToken.text === '.') {
      if (currentMemberIndex > 0) {
        const prevToken = line[currentMemberIndex - 1]
        if (prevToken && (prevToken.type === 'identifier' || prevToken.type === 'function')) {
          memberAccessTokens.unshift(prevToken, currentToken)
          currentMemberIndex -= 2
          continue
        }
      }
    }
    break
  }

  const callBlock: Token[] = [...memberAccessTokens, token, nextToken]
  let depth = 1
  let currentTokenIndex = tokenIndex + 2
  let currentLineIndex = lineIndex

  while (depth > 0 && currentLineIndex < tokenLines.length) {
    const currentLine = tokenLines[currentLineIndex]
    if (!currentLine) break

    while (currentTokenIndex < currentLine.length) {
      const currentToken = currentLine[currentTokenIndex]
      callBlock.push(currentToken)

      for (let i = 0; i < currentToken.text.length; i++) {
        const char = currentToken.text[i]
        if (char === '(') depth++
        else if (char === ')') {
          depth--
          if (depth === 0) return callBlock
        }
      }

      currentTokenIndex++
    }

    currentLineIndex++
    currentTokenIndex = 0
  }

  return callBlock
}

export function getParameterIndex(callBlock: Token[], tokenLines: Token[][], lineIndex: number,
  tokenIndex: number): number
{
  if (callBlock.length === 0) return -1

  const line = tokenLines[lineIndex]
  if (!line || tokenIndex >= line.length) return -1

  const targetToken = line[tokenIndex]
  let parenDepth = 0
  let braceDepth = 0
  let bracketDepth = 0
  let parameterIndex = 0
  let foundTarget = false

  for (let i = 0; i < callBlock.length; i++) {
    const token = callBlock[i]

    if (token === targetToken) {
      if (parenDepth === 1 && braceDepth === 0 && bracketDepth === 0) {
        // Caret after comma: highlight the next parameter slot
        if (token.text === ',') return parameterIndex + 1
        return parameterIndex
      }
      if (parenDepth === 0) {
        if (token.text === '(') {
          return 0
        }
        return -1
      }
      foundTarget = true
    }

    for (let j = 0; j < token.text.length; j++) {
      const char = token.text[j]
      if (char === '(') {
        if (token === targetToken && parenDepth === 0) {
          return 0
        }
        parenDepth++
      }
      else if (char === ')') {
        parenDepth--
        if (parenDepth === 0 && foundTarget) {
          return parameterIndex
        }
      }
      else if (char === '{') {
        braceDepth++
      }
      else if (char === '}') {
        braceDepth--
      }
      else if (char === '[') {
        bracketDepth++
      }
      else if (char === ']') {
        bracketDepth--
      }
      else if (char === ',' && parenDepth === 1 && braceDepth === 0 && bracketDepth === 0) {
        if (foundTarget) {
          return parameterIndex
        }
        parameterIndex++
      }
    }
  }

  return foundTarget ? parameterIndex : -1
}

export function getParameterStartToken(callBlock: Token[], parameterIndex: number): Token | null {
  if (callBlock.length === 0 || parameterIndex < 0) return null
  let parenDepth = 0
  let braceDepth = 0
  let bracketDepth = 0
  let openParenIndex = -1
  let currentParam = 0
  for (let i = 0; i < callBlock.length; i++) {
    const token = callBlock[i]
    for (let j = 0; j < token.text.length; j++) {
      const char = token.text[j]
      if (char === '(') {
        parenDepth++
        if (parenDepth === 1) openParenIndex = i
      }
      else if (char === ')') parenDepth--
      else if (char === '{') braceDepth++
      else if (char === '}') braceDepth--
      else if (char === '[') bracketDepth++
      else if (char === ']') bracketDepth--
      else if (char === ',' && parenDepth === 1 && braceDepth === 0 && bracketDepth === 0) {
        currentParam++
        if (currentParam === parameterIndex) return callBlock[i + 1] ?? null
      }
    }
  }
  // First parameter: token after opening '('
  if (parameterIndex === 0 && openParenIndex >= 0 && openParenIndex + 1 < callBlock.length) {
    return callBlock[openParenIndex + 1]
  }
  return null
}

export function findTokenPositionInTokenLines(tokenLines: Token[][], token: Token): { lineIndex: number;
  tokenIndex: number } | null
{
  for (let lineIndex = 0; lineIndex < tokenLines.length; lineIndex++) {
    const line = tokenLines[lineIndex]
    if (!line) continue
    const tokenIndex = line.indexOf(token)
    if (tokenIndex >= 0) return { lineIndex, tokenIndex }
  }
  return null
}

export function findCallBlockForToken(tokenLines: Token[][], lineIndex: number, tokenIndex: number): Token[] {
  const line = tokenLines[lineIndex]
  if (!line || tokenIndex >= line.length) return []

  const currentToken = line[tokenIndex]
  if (currentToken && (currentToken.type === 'identifier' || currentToken.type === 'function')) {
    let checkIndex = tokenIndex + 1
    while (checkIndex < line.length) {
      const nextToken = line[checkIndex]
      if (nextToken.type === 'punctuation' && nextToken.text === '.') {
        if (checkIndex + 1 < line.length) {
          const afterDotToken = line[checkIndex + 1]
          if (afterDotToken && (afterDotToken.type === 'function' || afterDotToken.type === 'identifier')) {
            if (checkIndex + 2 < line.length) {
              const afterMemberToken = line[checkIndex + 2]
              if (afterMemberToken && afterMemberToken.text === '(') {
                return findCallBlock(tokenLines, lineIndex, checkIndex + 1)
              }
            }
          }
        }
      }
      else if (nextToken && nextToken.text === '(') {
        return findCallBlock(tokenLines, lineIndex, tokenIndex)
      }
      else {
        break
      }
      checkIndex++
    }
  }
  else if (currentToken && currentToken.type === 'punctuation' && currentToken.text === '.') {
    if (tokenIndex > 0 && tokenIndex + 1 < line.length) {
      const prevToken = line[tokenIndex - 1]
      const nextToken = line[tokenIndex + 1]
      if (prevToken && (prevToken.type === 'identifier' || prevToken.type === 'function')
        && nextToken && (nextToken.type === 'function' || nextToken.type === 'identifier'))
      {
        if (tokenIndex + 2 < line.length) {
          const afterMemberToken = line[tokenIndex + 2]
          if (afterMemberToken && afterMemberToken.text === '(') {
            return findCallBlock(tokenLines, lineIndex, tokenIndex + 1)
          }
        }
      }
    }
  }

  let depth = 0
  let foundOpenParen = false
  let functionTokenIndex = -1
  let openParenTokenIndex = -1
  let currentTokenIndex = tokenIndex
  let currentLineIndex = lineIndex

  while (currentLineIndex >= 0) {
    const currentLine = tokenLines[currentLineIndex]
    if (!currentLine) break

    while (currentTokenIndex >= 0) {
      const currentToken = currentLine[currentTokenIndex]

      for (let i = currentToken.text.length - 1; i >= 0; i--) {
        const char = currentToken.text[i]
        if (char === ')') {
          depth++
        }
        else if (char === '(') {
          if (depth === 0) {
            foundOpenParen = true
            openParenTokenIndex = currentTokenIndex
            if (currentTokenIndex > 0) {
              const prevToken = currentLine[currentTokenIndex - 1]
              if (prevToken && (prevToken.type === 'function' || prevToken.type === 'identifier')) {
                functionTokenIndex = currentTokenIndex - 1
              }
              else if (prevToken && prevToken.type === 'punctuation' && prevToken.text === '.') {
                if (currentTokenIndex > 1) {
                  const prevPrevToken = currentLine[currentTokenIndex - 2]
                  if (prevPrevToken && (prevPrevToken.type === 'function' || prevPrevToken.type === 'identifier')) {
                    functionTokenIndex = currentTokenIndex - 2
                  }
                }
              }
            }
            break
          }
          else {
            depth--
          }
        }
      }

      if (foundOpenParen && functionTokenIndex >= 0) {
        return findCallBlock(tokenLines, currentLineIndex, functionTokenIndex)
      }

      currentTokenIndex--
    }

    if (foundOpenParen) break

    currentLineIndex--
    if (currentLineIndex >= 0 && currentLineIndex < tokenLines.length) {
      currentTokenIndex = (tokenLines[currentLineIndex]?.length ?? 0) - 1
    }
    else {
      currentTokenIndex = -1
    }
  }

  if (functionTokenIndex >= 0 && openParenTokenIndex >= 0) {
    return findCallBlock(tokenLines, currentLineIndex, functionTokenIndex)
  }

  return []
}

export function createMouse(
  canvas: Canvas,
  scroll: Scroll,
  lines: Lines,
  settings: Settings,
  caches: Caches,
  doc: Doc,
  caret: Caret,
  scrollbars: Scrollbars,
  selection: Selection,
  gutter: Gutter,
  blocks: Blocks,
  header: Signal<Header>,
  notifyActivated?: () => void,
) {
  let dominantAxisTimeoutId: ReturnType<typeof setTimeout> | null = null
  let dominantAxis: 'x' | 'y' | null = null
  let allowScrollPassThrough = false
  let allowScrollTimeoutId: ReturnType<typeof setTimeout> | null = null
  let hasMouseMovedInEditor = false
  const ALLOW_SCROLL_DEBOUNCE_MS = 200

  let velocityX = 0
  let velocityY = 0
  let accelerationX = 0
  let accelerationY = 0
  const FRICTION = 0.65
  const MIN_VELOCITY = 0.01
  const MIN_ACCELERATION = 0.01

  let lastMouseX: number | null = null
  let autoScrollInterval: ReturnType<typeof setInterval> | null = null
  let currentAutoScrollDirection: 'up' | 'down' | 'left' | 'right' | null = null
  const AUTO_SCROLL_SPEED = 10
  const widgetPressed = signal(false)
  const headerPressed = signal(false)
  let isClickNotDrag = false
  let clickStartX = 0
  let clickStartY = 0
  let prevMouseX = 0
  let prevMouseY = 0

  let clickCount = 0
  let clickTimeout: ReturnType<typeof setTimeout> | null = null
  let lastClickTime = 0
  let lastClickLine: number | null = null
  let lastClickColumn: number | null = null
  let selectionMode: 'normal' | 'word' | 'line' = 'normal'
  const CLICK_TIMEOUT_MS = 300

  let hoverShowTimeout: ReturnType<typeof setTimeout> | null = null
  let hoverHideTimeout: ReturnType<typeof setTimeout> | null = null
  let currentHoverTokenId: string | null = null
  let escapePressed = false
  const HOVER_SHOW_DELAY_MS = 500
  const HOVER_HIDE_DELAY_MS = 200
  const lastHoverMoveTime = signal(0)
  const buttonsDown = signal(false)

  const hovered = signalify({
    scrollbar: null as 'vertical' | 'horizontal' | null,
    line: null as VisualLine | null,
    column: null as number | null,
    token: null as VisualToken | null,
    error: null as DocError | null,
    gutter: false as boolean,
    hoverToken: null as {
      canvas: Canvas
      contentX: number
      contentY: number
      contentParamX?: number
      contentParamY?: number
      contentCallBlockX: number
      contentCallBlockY: number
      hitWorldX: number
      hitWorldY: number
      token: Token
      callBlock: Token[]
      parameterIndex: number
    } | null,
  })

  const pos = signalify({
    x: -1,
    y: -1,
  })

  // World position used for hover hit-test; only updated on mouse move so scroll does not clear hover
  const hoverHitPos = signal(null as { worldX: number; worldY: number } | null)

  const update = () => {
    updateScrollAnimation()
  }

  const updateScrollAnimation = () => {
    scroll.smooth.value = SCROLL_SMOOTH_KEYBOARD

    if (Math.abs(accelerationX) > MIN_ACCELERATION || Math.abs(accelerationY) > MIN_ACCELERATION) {
      scroll.smooth.value = SCROLL_SMOOTH_SCROLLING

      const torqueX = Math.pow(Math.abs(accelerationX), 1.5) * Math.sign(accelerationX)
      const torqueY = Math.pow(Math.abs(accelerationY), 1.5) * Math.sign(accelerationY)

      velocityX += torqueX
      velocityY += torqueY

      accelerationX *= FRICTION
      accelerationY *= FRICTION

      if (Math.abs(accelerationX) < MIN_ACCELERATION) accelerationX = 0
      if (Math.abs(accelerationY) < MIN_ACCELERATION) accelerationY = 0
    }

    if (Math.abs(velocityX) > MIN_VELOCITY || Math.abs(velocityY) > MIN_VELOCITY) {
      scroll.smooth.value = SCROLL_SMOOTH_SCROLLING

      scroll.targetX.value += velocityX
      scroll.targetY.value += velocityY

      velocityX *= FRICTION
      velocityY *= FRICTION

      if (Math.abs(velocityX) < MIN_VELOCITY) velocityX = 0
      if (Math.abs(velocityY) < MIN_VELOCITY) velocityY = 0
    }
  }

  const getInteractiveVisualLines = (extraMarginLines = 4): VisualLine[] => {
    const headerHeight = header.value?.height ?? 0
    const margin = settings.lineHeight * extraMarginLines
    const visibleTop = -headerHeight - settings.paddingTop - margin
    const visibleBottom = canvas.size.height.value - settings.paddingTop + margin
    return lines.getVisibleVisualLines(visibleTop, visibleBottom, scroll.pos.y)
  }

  const findLineColumnFromPosition = (x: number, y: number): { line: VisualLine; column: number } | null => {
    const headerHeight = header.value?.height ?? 0
    const visualLines = getInteractiveVisualLines()
    const scrollY = scroll.pos.y
    const scrollX = scroll.pos.x

    const worldY = y - headerHeight - settings.paddingTop - scrollY
    const worldX = x - settings.paddingLeft - gutter.width.value - scrollX

    let foundLine = findNearestVisualLineAtWorldY(visualLines, worldY)

    if (!foundLine) {
      return null
    }

    const codeLines = doc.lines
    const tokenLines = doc.tokenLines
    const column = getColumnFromVisualPosition(
      lines,
      foundLine,
      worldX,
      tokenLines,
      codeLines,
      canvas,
      settings,
      caches,
    )

    return { line: foundLine, column }
  }

  const getAboveHeightForLine = (line: VisualLine): number => {
    return line.aboveHeight ?? line.logicalAboveHeight ?? 0
  }

  const findBelowWidgetHit = (x: number, y: number): { widget: Widget & { type: 'below' }; canvasX: number;
    canvasY: number; canvasW: number; canvasH: number } | null =>
  {
    const headerHeight = header.value?.height ?? 0
    const visualLines = getInteractiveVisualLines()
    const scrollY = scroll.pos.y
    const scrollX = scroll.pos.x
    const worldY = y - headerHeight - settings.paddingTop - scrollY
    const worldX = x - settings.paddingLeft - gutter.width.value - scrollX
    const tokenLines = doc.tokenLines
    const { lineHeight } = settings

    const foundLine = findVisualLineAtWorldY(visualLines, worldY)
    if (!foundLine || foundLine.widgets.below.length === 0) return null
    if (worldY < foundLine.y + lineHeight || worldY >= foundLine.y + foundLine.height) return null

    const contentY = foundLine.tokenOffset === 0 ? foundLine.y : foundLine.y + getAboveHeightForLine(foundLine)
    const widgetWorldY = contentY + lineHeight - 2

    for (const widget of foundLine.widgets.below) {
      const onMouseDown =
        (widget as Widget & { type: 'below';
          onMouseDown?: (event: MouseEvent, x: number, y: number, w: number, h: number) => void }).onMouseDown
      if (!onMouseDown) continue
      const [startColumn, endColumn] = widget.pos.x
      const startCol0 = startColumn - 1
      const endCol0 = endColumn - 1
      const startX = getXFromColumnUnclamped(lines, foundLine, startCol0, tokenLines, canvas, settings, caches)
      const endX = getXFromColumnUnclamped(lines, foundLine, endCol0, tokenLines, canvas, settings, caches)
      const widgetWorldX = startX
      const widgetWorldW = endX - startX
      if (worldX >= widgetWorldX && worldX < widgetWorldX + widgetWorldW && worldY >= widgetWorldY
        && worldY < widgetWorldY + lineHeight)
      {
        const canvasX = widgetWorldX + scrollX + gutter.width.value + settings.paddingLeft
        const canvasY = widgetWorldY + headerHeight + settings.paddingTop + scrollY
        return { widget: widget as Widget & { type: 'below' }, canvasX, canvasY, canvasW: widgetWorldW,
          canvasH: lineHeight }
      }
    }
    return null
  }

  type BeforeAfterWidget = Widget & ({ type: 'before' } | { type: 'after' })
  const findBeforeAfterWidgetHit = (x: number, y: number): { widget: BeforeAfterWidget; canvasX: number;
    canvasY: number; canvasW: number; canvasH: number } | null =>
  {
    const headerHeight = header.value?.height ?? 0
    const visualLines = getInteractiveVisualLines()
    const scrollY = scroll.pos.y
    const scrollX = scroll.pos.x
    const worldY = y - headerHeight - settings.paddingTop - scrollY
    const worldX = x - settings.paddingLeft - gutter.width.value - scrollX
    const tokenLines = doc.tokenLines
    const { lineHeight } = settings

    const foundLine = findVisualLineAtWorldY(visualLines, worldY)
    if (!foundLine || foundLine.widgets.beforeAfter.length === 0) return null

    const contentY = foundLine.tokenOffset === 0 ? foundLine.y : foundLine.y + getAboveHeightForLine(foundLine)
    if (worldY < contentY || worldY >= contentY + lineHeight) return null

    const lineStartColumn = getCharOffsetForVisualLine(foundLine.logicalLine, foundLine, tokenLines, lines)
    let lineEndColumn = lineStartColumn
    for (const t of foundLine.tokens) {
      lineEndColumn += t.token.text.length
    }

    for (const widget of foundLine.widgets.beforeAfter) {
      const onMouseDown = (widget as BeforeAfterWidget & {
        onMouseDown?: (event: MouseEvent, x: number, y: number, w: number, h: number) => void
      }).onMouseDown
      if (!onMouseDown) continue

      const widgetColumn = widget.pos.x - 1
      const isRenderableOnLine = widget.type === 'before'
        ? (widgetColumn >= lineStartColumn && widgetColumn < lineEndColumn)
        : (widgetColumn > lineStartColumn && widgetColumn <= lineEndColumn)
      if (!isRenderableOnLine) continue

      const widgetWorldX = widget.type === 'before'
        ? getXFromColumnUnclamped(lines, foundLine, widgetColumn, tokenLines, canvas, settings, caches)
        : getXFromColumnUnclamped(lines, foundLine, widgetColumn + 1, tokenLines, canvas, settings, caches)

      const widgetWorldW = widget.pos.width
      if (worldX >= widgetWorldX && worldX < widgetWorldX + widgetWorldW) {
        const canvasX = widgetWorldX + scrollX + gutter.width.value + settings.paddingLeft
        const canvasY = contentY + headerHeight + settings.paddingTop + scrollY
        return { widget: widget as BeforeAfterWidget, canvasX, canvasY, canvasW: widgetWorldW, canvasH: lineHeight }
      }
    }
    return null
  }

  effect(() => {
    const { x, y } = pos
    const headerHeight = header.value?.height ?? 0
    const inHeader = y >= 0 && y < headerHeight
    const gutterHit = hitTestGutter(canvas, settings, lines, scroll, gutter, x, y, headerHeight)
    const scrollbarHit = hitTestScrollbar(canvas, scroll, lines, settings, gutter, header, x, y, doc.lines.length)
    const canHitWidget = y >= headerHeight && gutterHit.type === null && scrollbarHit.type === null
    const widgetHover = canHitWidget && (findBelowWidgetHit(x, y) !== null || findBeforeAfterWidgetHit(x, y) !== null)

    canvas.el.style.cursor = gutterHit.type === 'collapse'
      ? 'pointer'
      : widgetHover
      ? 'default'
      : (y < 0 || inHeader || gutterHit.type !== null || scrollbarHit.type !== null || widgetPressed.value
          || headerPressed.value || scrollbars.isDragging.value)
      ? 'default'
      : 'text'
  })

  effect(() => {
    const { x, y } = pos
    const headerHeight = header.value?.height ?? 0
    const gutterHit = hitTestGutter(canvas, settings, lines, scroll, gutter, x, y, headerHeight)
    hovered.gutter = gutterHit.type !== null
  })

  effect(() => {
    const hit = hoverHitPos.value
    const headerHeight = header.value?.height ?? 0

    if (!hit) {
      hovered.line = null
      hovered.column = null
      hovered.token = null
      hovered.error = null
      if (hoverShowTimeout) {
        clearTimeout(hoverShowTimeout)
        hoverShowTimeout = null
      }
      if (escapePressed) escapePressed = false
      if (currentHoverTokenId !== null) {
        currentHoverTokenId = null
        if (hoverHideTimeout) {
          clearTimeout(hoverHideTimeout)
        }
        hoverHideTimeout = setTimeout(() => {
          hovered.hoverToken = null
          hoverHideTimeout = null
        }, HOVER_HIDE_DELAY_MS)
      }
      return
    }

    if (buttonsDown.value) {
      hovered.line = null
      hovered.column = null
      hovered.token = null
      hovered.error = null
      if (hoverShowTimeout) {
        clearTimeout(hoverShowTimeout)
        hoverShowTimeout = null
      }
      if (currentHoverTokenId !== null) {
        currentHoverTokenId = null
        if (hoverHideTimeout) {
          clearTimeout(hoverHideTimeout)
        }
        hoverHideTimeout = setTimeout(() => {
          hovered.hoverToken = null
          hoverHideTimeout = null
        }, HOVER_HIDE_DELAY_MS)
      }
      return
    }

    untracked(() => {
      const visualLines = getInteractiveVisualLines()
      const worldX = hit.worldX
      const worldY = hit.worldY

      const foundLine = findVisualLineAtWorldY(visualLines, worldY)

      if (!foundLine) {
        hovered.line = null
        hovered.column = null
        hovered.token = null
        hovered.error = null

        if (hoverShowTimeout) {
          clearTimeout(hoverShowTimeout)
          hoverShowTimeout = null
        }

        if (escapePressed) {
          escapePressed = false
        }

        const existing = hovered.hoverToken
        const hitMoved = !existing || existing.hitWorldX !== hit.worldX || existing.hitWorldY !== hit.worldY
        if (currentHoverTokenId !== null && hitMoved) {
          currentHoverTokenId = null

          if (hoverHideTimeout) {
            clearTimeout(hoverHideTimeout)
          }

          hoverHideTimeout = setTimeout(() => {
            hovered.hoverToken = null
            hoverHideTimeout = null
          }, HOVER_HIDE_DELAY_MS)
        }

        return
      }

      hovered.line = foundLine

      const errors = foundLine.errors
      const lineHeight = settings.lineHeight
      const textAreaY = foundLine.y
      const textAreaHeight = lineHeight

      hovered.error = null

      if (worldY >= textAreaY && worldY < textAreaY + textAreaHeight) {
        const tokenLines = doc.tokenLines

        for (const error of errors) {
          const [errorStartColumn, errorEndColumn] = [error.x[0] - 1, error.x[1] - 1]
          const errorStartX = getXFromColumn(lines, foundLine, errorStartColumn, tokenLines, canvas, settings, caches)
          const errorEndX = getXFromColumn(lines, foundLine, errorEndColumn, tokenLines, canvas, settings, caches)

          if (worldX >= errorStartX && worldX <= errorEndX) {
            hovered.error = error
          }
        }
      }

      const codeLines = doc.lines
      const tokenLines = doc.tokenLines

      let foundToken: VisualToken | null = null
      for (const visualToken of foundLine.tokens) {
        if (worldX >= visualToken.x && worldX < visualToken.endX) {
          foundToken = visualToken
          break
        }
      }

      const column = getColumnFromVisualPosition(
        lines,
        foundLine,
        worldX,
        tokenLines,
        codeLines,
        canvas,
        settings,
        caches,
      )

      hovered.token = foundToken
      hovered.column = column

      if (foundToken && foundLine) {
        if (settings.performanceMode === 'stress') {
          if (hoverShowTimeout) {
            clearTimeout(hoverShowTimeout)
            hoverShowTimeout = null
          }
          currentHoverTokenId = null
          hovered.hoverToken = null
          return
        }

        const tokenId = `${foundLine.logicalLine}:${foundToken.logicalTokenIndex}`

        if (tokenId !== currentHoverTokenId && !escapePressed && !buttonsDown.value) {
          if (hoverShowTimeout) {
            clearTimeout(hoverShowTimeout)
            hoverShowTimeout = null
          }
          if (hoverHideTimeout) {
            clearTimeout(hoverHideTimeout)
            hoverHideTimeout = null
          }

          currentHoverTokenId = tokenId
          escapePressed = false

          hoverShowTimeout = setTimeout(() => {
            if (currentHoverTokenId === tokenId && foundToken && foundLine && !buttonsDown.value) {
              const tokenLines = doc.tokenLines
              const logicalLine = foundLine.logicalLine
              const logicalTokenIndex = foundToken.logicalTokenIndex
              const callBlock = findCallBlockForToken(tokenLines, logicalLine, logicalTokenIndex)
              const parameterIndex = callBlock.length > 0
                ? getParameterIndex(callBlock, tokenLines, logicalLine, logicalTokenIndex)
                : -1

              const headerHeight = header.value?.height ?? 0
              const scrollX = scroll.pos.x
              const scrollY = scroll.pos.y
              const canvasRect = canvas.rect
              const contentY = foundLine.tokenOffset === 0
                ? foundLine.y
                : foundLine.y + getAboveHeightForLine(foundLine)
              const tokenX = foundToken.x + gutter.width.value + settings.paddingLeft + scrollX + canvasRect.left
              const tokenY = contentY + headerHeight + settings.paddingTop + scrollY + canvasRect.top
              let paramX: number | undefined
              let paramY: number | undefined
              if (parameterIndex >= 0) {
                const paramStartToken = getParameterStartToken(callBlock, parameterIndex)
                if (paramStartToken) {
                  const pos = findCallBlockTokenPositionFromAnchor(tokenLines, callBlock, logicalLine,
                    logicalTokenIndex, foundToken.token, paramStartToken)
                  if (pos) {
                    const lineTokens = tokenLines[pos.lineIndex] || []
                    const column = getColumnForTokenIndex(lineTokens, pos.tokenIndex)
                    const paramLine = findVisualLineForColumn(lines, pos.lineIndex, column, tokenLines, caches)
                    if (paramLine) {
                      const px = getXFromColumn(lines, paramLine, column, tokenLines, canvas, settings, caches)
                      const paramContentY = paramLine.tokenOffset === 0
                        ? paramLine.y
                        : paramLine.y + getAboveHeightForLine(paramLine)
                      paramX = px + gutter.width.value + settings.paddingLeft + scrollX + canvasRect.left
                      paramY = paramContentY + headerHeight + settings.paddingTop + scrollY + canvasRect.top
                    }
                  }
                }
              }

              let callBlockX = tokenX
              let callBlockY = tokenY
              if (callBlock.length > 0) {
                let functionToken: Token | null = null
                for (let i = 0; i < callBlock.length; i++) {
                  const token = callBlock[i]
                  if (token.text === '(' && i > 0) {
                    const prevToken = callBlock[i - 1]
                    if (prevToken && (prevToken.type === 'function' || prevToken.type === 'identifier')) {
                      functionToken = prevToken
                      break
                    }
                  }
                }
                if (functionToken) {
                  const functionPos = findCallBlockTokenPositionFromAnchor(tokenLines, callBlock, logicalLine,
                    logicalTokenIndex, foundToken.token, functionToken)
                  if (functionPos) {
                    const functionLineTokens = tokenLines[functionPos.lineIndex] || []
                    const functionColumn = getColumnForTokenIndex(functionLineTokens, functionPos.tokenIndex)
                    const functionLine = findVisualLineForColumn(lines, functionPos.lineIndex, functionColumn,
                      tokenLines, caches)
                    if (functionLine) {
                      const functionX = getXFromColumn(lines, functionLine, functionColumn, tokenLines, canvas,
                        settings, caches)
                      const functionContentY = functionLine.tokenOffset === 0
                        ? functionLine.y
                        : functionLine.y + getAboveHeightForLine(functionLine)
                      callBlockX = functionX + gutter.width.value + settings.paddingLeft + scrollX + canvasRect.left
                      callBlockY = functionContentY + headerHeight + settings.paddingTop + scrollY + canvasRect.top
                    }
                  }
                }
              }

              hovered.hoverToken = {
                canvas: createOverlayCanvas(),
                contentX: tokenX - scrollX - canvasRect.left,
                contentY: tokenY - scrollY - canvasRect.top,
                contentParamX: paramX != null ? paramX - scrollX - canvasRect.left : undefined,
                contentParamY: paramY != null ? paramY - scrollY - canvasRect.top : undefined,
                contentCallBlockX: callBlockX - scrollX - canvasRect.left,
                contentCallBlockY: callBlockY - scrollY - canvasRect.top,
                hitWorldX: hit.worldX,
                hitWorldY: hit.worldY,
                token: foundToken.token,
                callBlock,
                parameterIndex,
              }
            }
            hoverShowTimeout = null
          }, HOVER_SHOW_DELAY_MS)
        }
      }
      else {
        if (hoverShowTimeout) {
          clearTimeout(hoverShowTimeout)
          hoverShowTimeout = null
        }

        if (escapePressed) {
          escapePressed = false
        }

        if (currentHoverTokenId !== null) {
          currentHoverTokenId = null

          if (hoverHideTimeout) {
            clearTimeout(hoverHideTimeout)
          }

          hoverHideTimeout = setTimeout(() => {
            hovered.hoverToken = null
            hoverHideTimeout = null
          }, HOVER_HIDE_DELAY_MS)
        }
      }
    })
  })

  const updateMousePositionFromPoint = (clientX: number, clientY: number) => {
    const rect = canvas.rect
    const x = clientX - rect.left
    const y = clientY - rect.top
    batch(() => {
      pos.x = x
      pos.y = y
    })
  }

  const updateMousePositionFromEvent = (event: MouseEvent) => {
    updateMousePositionFromPoint(event.clientX, event.clientY)
  }

  effect(() => {
    if (!selection.isSelecting.value) return

    const lineColumn = findLineColumnFromPosition(pos.x, pos.y)

    if (lineColumn && selection.start.value) {
      const codeLines = doc.lines
      const logicalLine = lineColumn.line.logicalLine
      let targetColumn = lineColumn.column
      const start = selection.start.value

      if (selectionMode === 'word') {
        const line = codeLines[logicalLine] || ''
        const boundaries = findWordBoundaries(line, targetColumn)
        const isForward = logicalLine > start.line || (logicalLine === start.line && targetColumn >= start.column)
        targetColumn = isForward ? boundaries.end : boundaries.start
      }
      else if (selectionMode === 'line') {
        const line = codeLines[logicalLine] || ''
        const boundaries = findLineBoundaries(line)
        if (logicalLine > start.line) {
          targetColumn = boundaries.end
        }
        else if (logicalLine < start.line) {
          targetColumn = boundaries.start
        }
        else {
          targetColumn = targetColumn >= start.column ? boundaries.end : boundaries.start
        }
      }

      if (autoScrollInterval) {
        lastMouseX = pos.x
        caret.column.value = targetColumn
        caret.resetBlink()
      }
      else {
        selection.setEnd(logicalLine, targetColumn)
        lastMouseX = pos.x
        caret.setPosition(logicalLine, targetColumn, codeLines)
        caret.resetBlink()
      }
    }

    const headerHeight = header.value?.height ?? 0
    const canvasHeight = canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
    const canvasWidth = canvas.size.width.value - settings.paddingLeft - settings.paddingRight

    const relativeY = pos.y - headerHeight - settings.paddingTop
    const relativeX = pos.x - settings.paddingLeft - gutter.width.value

    if (isClickNotDrag) {
      stopAutoScroll()
      return
    }

    const deltaX = pos.x - prevMouseX
    const deltaY = pos.y - prevMouseY
    prevMouseX = pos.x
    prevMouseY = pos.y

    const maxScrollY = scroll.scrollHeight.value
    const maxScrollX = settings.wordWrap ? 0 : -(lines.totalWidth.value - canvasWidth)
    const canScrollUp = scroll.targetY.value < 0
    const canScrollDown = scroll.targetY.value > maxScrollY
    const canScrollLeft = scroll.targetX.value < 0
    const canScrollRight = scroll.targetX.value > maxScrollX

    // If auto-scroll is already active, check if mouse is still in edge zone
    if (currentAutoScrollDirection === 'up') {
      if (!canScrollUp || relativeY >= 0) {
        // Reached the end or mouse moved away from edge, stop auto-scroll
        stopAutoScroll()
      }
    }
    else if (currentAutoScrollDirection === 'down') {
      if (!canScrollDown || relativeY <= canvasHeight - settings.lineHeight) {
        // Reached the end or mouse moved away from edge, stop auto-scroll
        stopAutoScroll()
      }
    }
    else if (currentAutoScrollDirection === 'left') {
      if (!canScrollLeft || relativeX >= 0) {
        // Reached the end or mouse moved away from edge, stop auto-scroll
        stopAutoScroll()
      }
    }
    else if (currentAutoScrollDirection === 'right') {
      if (!canScrollRight || relativeX <= canvasWidth) {
        // Reached the end or mouse moved away from edge, stop auto-scroll
        stopAutoScroll()
      }
    }
    else if (relativeY < 0 && canScrollUp && deltaY < 0) {
      // Start auto-scroll if moving towards the edge
      startAutoScroll('up')
    }
    else if (relativeY > canvasHeight - settings.lineHeight && canScrollDown && deltaY > 0) {
      // Start auto-scroll if moving towards the edge
      startAutoScroll('down')
    }
    else if (relativeX < 0 && canScrollLeft && deltaX < 0) {
      // Start auto-scroll if moving towards the edge
      startAutoScroll('left')
    }
    else if (relativeX > canvasWidth && canScrollRight && deltaX > 0) {
      // Start auto-scroll if moving towards the edge
      startAutoScroll('right')
    }
  })

  const stopAutoScroll = () => {
    if (autoScrollInterval) {
      clearInterval(autoScrollInterval)
      autoScrollInterval = null
      currentAutoScrollDirection = null
    }
  }

  const startAutoScroll = (direction: 'up' | 'down' | 'left' | 'right') => {
    if (currentAutoScrollDirection === direction) return
    stopAutoScroll()
    currentAutoScrollDirection = direction
    autoScrollInterval = setInterval(() => {
      const canvasWidth = canvas.size.width.value - settings.paddingLeft - settings.paddingRight

      const maxScrollY = scroll.scrollHeight.value
      const maxScrollX = settings.wordWrap ? 0 : -(lines.totalWidth.value - canvasWidth)

      if (direction === 'up') {
        if (scroll.targetY.value >= 0) {
          stopAutoScroll()
          return
        }
        scroll.targetY.value += AUTO_SCROLL_SPEED
        if (scroll.targetY.value > 0) {
          scroll.targetY.value = 0
        }
      }
      else if (direction === 'down') {
        if (scroll.targetY.value <= maxScrollY) {
          stopAutoScroll()
          return
        }
        scroll.targetY.value -= AUTO_SCROLL_SPEED
        if (scroll.targetY.value < maxScrollY) {
          scroll.targetY.value = maxScrollY
        }
      }
      else if (direction === 'left') {
        if (scroll.targetX.value >= 0) {
          stopAutoScroll()
          return
        }
        scroll.targetX.value += AUTO_SCROLL_SPEED
        if (scroll.targetX.value > 0) {
          scroll.targetX.value = 0
        }
      }
      else if (direction === 'right') {
        if (scroll.targetX.value <= maxScrollX) {
          stopAutoScroll()
          return
        }
        scroll.targetX.value -= AUTO_SCROLL_SPEED
        if (scroll.targetX.value < maxScrollX) {
          scroll.targetX.value = maxScrollX
        }
      }

      if (selection.isSelecting.value) {
        const codeLines = doc.lines
        if (direction === 'down') {
          const visualLines = getInteractiveVisualLines()
          const headerHeight = header.value?.height ?? 0
          const canvasHeight = canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
          const scrollY = scroll.pos.y
          const scrollX = scroll.pos.x
          const maxCaretY = canvasHeight - settings.lineHeight

          let targetLine: VisualLine | null = null
          const firstVisibleIndex = lowerBoundVisualLineBottom(visualLines, -scrollY)
          for (let i = firstVisibleIndex; i < visualLines.length; i++) {
            const line = visualLines[i]
            const lineY = line.y + scrollY
            if (lineY <= maxCaretY && lineY + line.height > 0) {
              targetLine = line
            }
            else if (lineY > maxCaretY) {
              break
            }
          }

          if (targetLine && lastMouseX !== null && selection.start.value) {
            const logicalLine = targetLine.logicalLine
            const worldX = lastMouseX - settings.paddingLeft - gutter.width.value - scrollX
            const tokenLines = doc.tokenLines
            let targetColumn = getColumnFromVisualPosition(
              lines,
              targetLine,
              worldX,
              tokenLines,
              codeLines,
              canvas,
              settings,
              caches,
            )
            const start = selection.start.value

            if (selectionMode === 'word') {
              const line = codeLines[logicalLine] || ''
              const boundaries = findWordBoundaries(line, targetColumn)
              const isForward = logicalLine > start.line || (logicalLine === start.line && targetColumn >= start.column)
              targetColumn = isForward ? boundaries.end : boundaries.start
            }
            else if (selectionMode === 'line') {
              const line = codeLines[logicalLine] || ''
              const boundaries = findLineBoundaries(line)
              if (logicalLine > start.line) {
                targetColumn = boundaries.end
              }
              else if (logicalLine < start.line) {
                targetColumn = boundaries.start
              }
              else {
                targetColumn = targetColumn >= start.column ? boundaries.end : boundaries.start
              }
            }

            selection.setEnd(logicalLine, targetColumn)
            caret.setPosition(logicalLine, targetColumn, codeLines)
            caret.resetBlink()
          }
        }
        else if (direction === 'up') {
          const visualLines = getInteractiveVisualLines()
          const scrollY = scroll.pos.y
          const scrollX = scroll.pos.x

          const firstAtOrBelowTop = lowerBoundVisualLineStart(visualLines, -scrollY)
          const targetLine = firstAtOrBelowTop < visualLines.length ? visualLines[firstAtOrBelowTop] : null

          if (targetLine && lastMouseX !== null) {
            const logicalLine = targetLine.logicalLine
            const worldX = lastMouseX - settings.paddingLeft - gutter.width.value - scrollX
            const tokenLines = doc.tokenLines
            let targetColumn = getColumnFromVisualPosition(
              lines,
              targetLine,
              worldX,
              tokenLines,
              codeLines,
              canvas,
              settings,
              caches,
            )

            if (selectionMode === 'word') {
              const line = codeLines[logicalLine] || ''
              const boundaries = findWordBoundaries(line, targetColumn)
              targetColumn = boundaries.end
            }
            else if (selectionMode === 'line') {
              const line = codeLines[logicalLine] || ''
              const boundaries = findLineBoundaries(line)
              targetColumn = boundaries.end
            }

            selection.setEnd(logicalLine, targetColumn)
            caret.setPosition(logicalLine, targetColumn, codeLines)
            caret.resetBlink()
          }
        }
        else {
          const lineColumn = lastMouseX !== null ? findLineColumnFromPosition(lastMouseX, pos.y) : null

          if (lineColumn && selection.start.value) {
            const logicalLine = lineColumn.line.logicalLine
            let targetColumn = lineColumn.column
            const start = selection.start.value

            if (selectionMode === 'word') {
              const line = codeLines[logicalLine] || ''
              const boundaries = findWordBoundaries(line, targetColumn)
              const isForward = logicalLine > start.line || (logicalLine === start.line && targetColumn >= start.column)
              targetColumn = isForward ? boundaries.end : boundaries.start
            }
            else if (selectionMode === 'line') {
              const line = codeLines[logicalLine] || ''
              const boundaries = findLineBoundaries(line)
              if (logicalLine > start.line) {
                targetColumn = boundaries.end
              }
              else if (logicalLine < start.line) {
                targetColumn = boundaries.start
              }
              else {
                targetColumn = targetColumn >= start.column ? boundaries.end : boundaries.start
              }
            }

            selection.setEnd(logicalLine, targetColumn)
            caret.setPosition(logicalLine, targetColumn, codeLines)
            caret.resetBlink()
          }
        }
      }
    }, 16)
  }

  const handleScroll = (event: WheelEvent) => {
    updateMousePositionFromEvent(event)

    clearTimeout(dominantAxisTimeoutId)

    let { deltaX, deltaY } = event

    const newDominantAxis = Math.abs(deltaX) > Math.abs(deltaY) ? 'x' : 'y'
    if (!dominantAxis) dominantAxis = newDominantAxis

    dominantAxisTimeoutId = setTimeout(() => {
      if (newDominantAxis !== dominantAxis) {
        dominantAxis = newDominantAxis
      }
      dominantAxisTimeoutId = null
    }, 15)

    const atEdgeY = (deltaY > 0 && scroll.targetY.value <= scroll.scrollHeight.value)
      || (deltaY < 0 && scroll.targetY.value >= 0)
    const atEdgeX = (deltaX > 0 && scroll.targetX.value <= scroll.scrollWidth.value)
      || (deltaX < 0 && scroll.targetX.value >= 0)
    const atEdge = newDominantAxis === 'y' ? atEdgeY : atEdgeX

    if (atEdge) {
      if (allowScrollPassThrough) return
      clearTimeout(allowScrollTimeoutId)
      allowScrollTimeoutId = setTimeout(() => {
        allowScrollPassThrough = true
        allowScrollTimeoutId = null
      }, ALLOW_SCROLL_DEBOUNCE_MS)
      event.preventDefault()
      return
    }

    clearTimeout(allowScrollTimeoutId)
    allowScrollTimeoutId = null
    if (!hasMouseMovedInEditor) return
    allowScrollPassThrough = false
    event.preventDefault()

    if (dominantAxis === 'x') {
      if (deltaX === Math.floor(deltaX)) {
        accelerationX += -deltaX / 5
      }
      else {
        accelerationX += -deltaX / 30
      }
    }
    else {
      if (deltaY === Math.floor(deltaY)) {
        accelerationY += -deltaY / 40
      }
      else {
        accelerationY += -deltaY / 30
      }
    }
  }

  const handleDocumentScroll = () => {
    if (allowScrollPassThrough) hasMouseMovedInEditor = false
  }

  const handleCanvasMouseMove = (event: MouseEvent) => {
    if (scrollbars.isDragging.value) return
    batch(() => {
      hasMouseMovedInEditor = true
      updateMousePositionFromEvent(event)
      const headerHeight = header.value?.height ?? 0
      const worldX = pos.x - settings.paddingLeft - gutter.width.value - scroll.pos.x
      const worldY = pos.y - headerHeight - settings.paddingTop - scroll.pos.y
      hoverHitPos.value = { worldX, worldY }
      lastHoverMoveTime.value = Date.now()
      const hit = hitTestScrollbar(
        canvas,
        scroll,
        lines,
        settings,
        gutter,
        header,
        pos.x,
        pos.y,
        doc.lines.length,
      )
      hovered.scrollbar = hit.type

      if (hit.type) {
        hovered.line = null
        hovered.column = null
        hovered.token = null
        hovered.error = null

        if (hoverShowTimeout) {
          clearTimeout(hoverShowTimeout)
          hoverShowTimeout = null
        }

        if (escapePressed) {
          escapePressed = false
        }

        if (currentHoverTokenId !== null) {
          currentHoverTokenId = null

          if (hoverHideTimeout) {
            clearTimeout(hoverHideTimeout)
          }

          hoverHideTimeout = setTimeout(() => {
            hovered.hoverToken = null
            hoverHideTimeout = null
          }, HOVER_HIDE_DELAY_MS)
        }
      }
    })
  }

  const handleCanvasMouseLeave = () => {
    if (scrollbars.isDragging.value) return
    batch(() => {
      pos.x = -1
      pos.y = -1
      hoverHitPos.value = null
    })
    hovered.scrollbar = null
    hovered.gutter = false
    hovered.line = null
    hovered.column = null
    hovered.token = null

    if (hoverShowTimeout) {
      clearTimeout(hoverShowTimeout)
      hoverShowTimeout = null
    }

    if (escapePressed) {
      escapePressed = false
    }

    if (currentHoverTokenId !== null) {
      currentHoverTokenId = null

      if (hoverHideTimeout) {
        clearTimeout(hoverHideTimeout)
      }

      hoverHideTimeout = setTimeout(() => {
        hovered.hoverToken = null
        hoverHideTimeout = null
      }, HOVER_HIDE_DELAY_MS)
    }
  }

  const handleWindowMouseMove = (event: MouseEvent) => {
    updateMousePositionFromEvent(event)
    scrollbars.handleMouseMove(pos.x, pos.y)
    if (isClickNotDrag) {
      const dx = Math.abs(pos.x - clickStartX)
      const dy = Math.abs(pos.y - clickStartY)
      if (dx > 3 || dy > 3) {
        isClickNotDrag = false
      }
    }
  }

  const handleMouseDown = (event: MouseEvent) => {
    if (Date.now() < ignoreMouseEventsUntil) {
      event.preventDefault()
      return
    }
    buttonsDown.value = true
    const onMouseUpForButtons = () => {
      buttonsDown.value = false
      window.removeEventListener('mouseup', onMouseUpForButtons)
    }
    window.addEventListener('mouseup', onMouseUpForButtons)

    setActiveCanvas(canvas.el)
    notifyActivated?.()
    const textarea = getTextareaElement()
    setTimeout(() => {
      textarea.focus()
    }, 0)
    updateMousePositionFromEvent(event)

    caret.isTyping.value = false
    caret.caretToken = null
    caret.suppressAutoScroll = true
    isClickNotDrag = true
    clickStartX = pos.x
    clickStartY = pos.y
    prevMouseX = pos.x
    prevMouseY = pos.y

    if (hoverShowTimeout) {
      clearTimeout(hoverShowTimeout)
      hoverShowTimeout = null
    }
    if (hoverHideTimeout) {
      clearTimeout(hoverHideTimeout)
      hoverHideTimeout = null
    }
    hovered.hoverToken = null
    currentHoverTokenId = null
    escapePressed = false

    const headerHeight = header.value?.height ?? 0
    const headerWidth = Math.max(
      0,
      canvas.size.width.value - (settings.showMinimap ? getVerticalScrollbarSize(settings) : 0),
    )
    const inHeader = headerHeight > 0 && pos.y >= 0 && pos.y < headerHeight && pos.x < headerWidth
    const headerValue = header.value
    const onMouseDown = headerValue?.onMouseDown
    if (inHeader && onMouseDown) {
      headerPressed.value = true
      const onHeaderMouseUp = () => {
        headerPressed.value = false
        window.removeEventListener('mouseup', onHeaderMouseUp)
      }
      window.addEventListener('mouseup', onHeaderMouseUp)
      const w = headerWidth
      const h = headerValue.height
      const tx = gutter.width.value
      const tw = Math.max(0, w - tx)
      onMouseDown(event, pos.x, pos.y, w, h, tx, tw)
      event.preventDefault()
      caret.suppressAutoScroll = false
      return
    }

    const onWidgetMouseUp = () => {
      widgetPressed.value = false
      window.removeEventListener('mouseup', onWidgetMouseUp)
    }
    const belowHit = findBelowWidgetHit(pos.x, pos.y)
    if (belowHit) {
      widgetPressed.value = true
      window.addEventListener('mouseup', onWidgetMouseUp)
      belowHit.widget.onMouseDown!(event, belowHit.canvasX, belowHit.canvasY, belowHit.canvasW, belowHit.canvasH)
      event.preventDefault()
      caret.suppressAutoScroll = false
      return
    }

    const beforeAfterHit = findBeforeAfterWidgetHit(pos.x, pos.y)
    if (beforeAfterHit) {
      widgetPressed.value = true
      window.addEventListener('mouseup', onWidgetMouseUp)
      beforeAfterHit.widget.onMouseDown!(event, beforeAfterHit.canvasX, beforeAfterHit.canvasY, beforeAfterHit.canvasW,
        beforeAfterHit.canvasH)
      event.preventDefault()
      caret.suppressAutoScroll = false
      return
    }

    if (event.button !== MouseButton.Left) return

    const gutterHit = hitTestGutter(canvas, settings, lines, scroll, gutter, pos.x, pos.y, headerHeight)
    if (gutterHit.type === 'collapse' && gutterHit.line !== null) {
      blocks.toggle(gutterHit.line)
      event.preventDefault()
      caret.suppressAutoScroll = false
      return
    }

    const hit = hitTestScrollbar(canvas, scroll, lines, settings, gutter, header, pos.x, pos.y, doc.lines.length)
    if (!hit.type) {
      const lineColumn = findLineColumnFromPosition(pos.x, pos.y)

      if (lineColumn) {
        const codeLines = doc.lines
        const logicalLine = lineColumn.line.logicalLine
        const column = lineColumn.column

        const now = Date.now()
        const isSamePosition = lastClickLine === logicalLine && lastClickColumn === column
        const timeSinceLastClick = now - lastClickTime

        if (isSamePosition && timeSinceLastClick < CLICK_TIMEOUT_MS) {
          clickCount++
        }
        else {
          clickCount = 1
        }

        lastClickTime = now
        lastClickLine = logicalLine
        lastClickColumn = column

        if (clickTimeout) {
          clearTimeout(clickTimeout)
        }

        clickTimeout = setTimeout(() => {
          clickCount = 0
          clickTimeout = null
        }, CLICK_TIMEOUT_MS)

        if (clickCount === 2) {
          selectionMode = 'word'
          const line = codeLines[logicalLine] || ''
          const boundaries = findWordBoundaries(line, column)
          selection.setStart(logicalLine, boundaries.start)
          selection.setEnd(logicalLine, boundaries.end)
          lastMouseX = pos.x
          selection.isSelecting.value = true
          window.addEventListener('mousemove', handleWindowMouseMove)
          window.addEventListener('mouseup', handleWindowMouseUp)
          caret.setPosition(logicalLine, boundaries.end, codeLines)
          caret.resetBlink()
        }
        else if (clickCount === 3) {
          selectionMode = 'line'
          const line = codeLines[logicalLine] || ''
          const boundaries = findLineBoundaries(line)
          selection.setStart(logicalLine, boundaries.start)
          selection.setEnd(logicalLine, boundaries.end)
          lastMouseX = pos.x
          selection.isSelecting.value = true
          window.addEventListener('mousemove', handleWindowMouseMove)
          window.addEventListener('mouseup', handleWindowMouseUp)
          caret.setPosition(logicalLine, boundaries.end, codeLines)
          caret.resetBlink()
        }
        else {
          selectionMode = 'normal'
          if (event.shiftKey && selection.start.value) {
            selection.setEnd(logicalLine, column)
            lastMouseX = pos.x
            selection.isSelecting.value = true
            window.addEventListener('mousemove', handleWindowMouseMove)
            window.addEventListener('mouseup', handleWindowMouseUp)
          }
          else {
            selection.setStart(logicalLine, column)
            lastMouseX = pos.x
            selection.isSelecting.value = true
            window.addEventListener('mousemove', handleWindowMouseMove)
            window.addEventListener('mouseup', handleWindowMouseUp)
          }

          caret.setPosition(logicalLine, column, codeLines)
          caret.resetBlink()
        }
      }
    }
    else if (scrollbars.handleMouseDown(pos.x, pos.y)) {
      window.addEventListener('mousemove', handleWindowMouseMove)
      window.addEventListener('mouseup', handleWindowMouseUp)
      caret.suppressAutoScroll = false
      event.preventDefault()
    }
  }

  const handleWindowMouseUp = (event: MouseEvent) => {
    if (Date.now() < ignoreMouseEventsUntil) {
      event.preventDefault()
      return
    }
    if (event.button !== 0) return

    updateMousePositionFromEvent(event)

    const scrollbarType = scrollbars.handleMouseUp(pos.x, pos.y)
    hovered.scrollbar = scrollbarType
    selection.isSelecting.value = false
    selectionMode = 'normal'
    stopAutoScroll()
    window.removeEventListener('mousemove', handleWindowMouseMove)
    window.removeEventListener('mouseup', handleWindowMouseUp)

    if (hovered.line && hovered.column !== null) {
      const codeLines = doc.lines
      const lineLength = codeLines[hovered.line.logicalLine]?.length || 0
      caret.columnIntent.value = Math.min(hovered.column, lineLength)
    }

    caret.suppressAutoScroll = false
    isClickNotDrag = false
  }

  let touchStartClientX = 0
  let touchStartClientY = 0
  let lastTouchClientX = 0
  let lastTouchClientY = 0
  let isTouchScrolling = false
  let ignoreMouseEventsUntil = 0
  const TOUCH_SCROLL_THRESHOLD = 5

  const handleTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) return
    const touch = event.touches[0]
    touchStartClientX = touch.clientX
    touchStartClientY = touch.clientY
    lastTouchClientX = touch.clientX
    lastTouchClientY = touch.clientY
    isTouchScrolling = false
    hasMouseMovedInEditor = true
    ignoreMouseEventsUntil = Date.now() + 1000
  }

  const handleTouchMove = (event: TouchEvent) => {
    if (event.touches.length !== 1) return
    const touch = event.touches[0]

    const clientX = touch.clientX
    const clientY = touch.clientY

    const deltaX = clientX - lastTouchClientX
    const deltaY = clientY - lastTouchClientY

    if (!isTouchScrolling) {
      const totalDx = clientX - touchStartClientX
      const totalDy = clientY - touchStartClientY
      if (Math.abs(totalDx) < TOUCH_SCROLL_THRESHOLD && Math.abs(totalDy) < TOUCH_SCROLL_THRESHOLD) {
        return
      }
      isTouchScrolling = true
    }

    lastTouchClientX = clientX
    lastTouchClientY = clientY

    const headerHeight = header.value?.height ?? 0
    const canvasWidth = canvas.size.width.value - settings.paddingLeft - settings.paddingRight

    const maxScrollY = scroll.scrollHeight.value
    const maxScrollX = settings.wordWrap ? 0 : -(lines.totalWidth.value - canvasWidth)

    const atEdgeY = (deltaY < 0 && scroll.targetY.value <= maxScrollY) || (deltaY > 0 && scroll.targetY.value >= 0)
    const atEdgeX = (deltaX < 0 && scroll.targetX.value <= maxScrollX) || (deltaX > 0 && scroll.targetX.value >= 0)
    const dominant = Math.abs(deltaX) > Math.abs(deltaY) ? 'x' : 'y'
    const atEdge = dominant === 'y' ? atEdgeY : atEdgeX

    if (atEdge) {
      if (allowScrollPassThrough) return
      clearTimeout(allowScrollTimeoutId)
      allowScrollTimeoutId = setTimeout(() => {
        allowScrollPassThrough = true
        allowScrollTimeoutId = null
      }, ALLOW_SCROLL_DEBOUNCE_MS)
      event.preventDefault()
      return
    }

    clearTimeout(allowScrollTimeoutId)
    allowScrollPassThrough = false
    event.preventDefault()

    scroll.smooth.value = SCROLL_SMOOTH_SCROLLING

    scroll.targetX.value += deltaX
    scroll.targetY.value += deltaY

    if (scroll.targetY.value > 0) scroll.targetY.value = 0
    if (scroll.targetY.value < maxScrollY) scroll.targetY.value = maxScrollY
    if (scroll.targetX.value > 0) scroll.targetX.value = 0
    if (scroll.targetX.value < maxScrollX) scroll.targetX.value = maxScrollX

    updateMousePositionFromPoint(clientX, clientY)

    const worldX = pos.x - settings.paddingLeft - gutter.width.value - scroll.pos.x
    const worldY = pos.y - headerHeight - settings.paddingTop - scroll.pos.y
    hoverHitPos.value = { worldX, worldY }
  }

  const handleTouchEnd = () => {
    isTouchScrolling = false
    clearTimeout(allowScrollTimeoutId)
    allowScrollTimeoutId = null
    allowScrollPassThrough = false
  }

  canvas.el.addEventListener('wheel', handleScroll, { passive: false })
  canvas.el.addEventListener('mousemove', handleCanvasMouseMove)
  canvas.el.addEventListener('mousedown', handleMouseDown)
  canvas.el.addEventListener('mouseleave', handleCanvasMouseLeave)
  canvas.el.addEventListener('touchstart', handleTouchStart, { passive: true })
  canvas.el.addEventListener('touchmove', handleTouchMove, { passive: false })
  canvas.el.addEventListener('touchend', handleTouchEnd)
  canvas.el.addEventListener('touchcancel', handleTouchEnd)

  const clearHoverToken = (setEscapePressed = false) => {
    if (hoverShowTimeout) {
      clearTimeout(hoverShowTimeout)
      hoverShowTimeout = null
    }
    if (hoverHideTimeout) {
      clearTimeout(hoverHideTimeout)
      hoverHideTimeout = null
    }
    hovered.hoverToken = null
    currentHoverTokenId = null
    if (setEscapePressed) {
      escapePressed = true
    }
  }

  const dispose = () => {
    stopAutoScroll()
    if (clickTimeout) {
      clearTimeout(clickTimeout)
      clickTimeout = null
    }
    if (hoverShowTimeout) {
      clearTimeout(hoverShowTimeout)
      hoverShowTimeout = null
    }
    if (hoverHideTimeout) {
      clearTimeout(hoverHideTimeout)
      hoverHideTimeout = null
    }
    canvas.el.removeEventListener('wheel', handleScroll)
    window.removeEventListener('scroll', handleDocumentScroll, true)
    canvas.el.removeEventListener('mousemove', handleCanvasMouseMove)
    canvas.el.removeEventListener('mousedown', handleMouseDown)
    canvas.el.removeEventListener('mouseleave', handleCanvasMouseLeave)
    canvas.el.removeEventListener('touchstart', handleTouchStart)
    canvas.el.removeEventListener('touchmove', handleTouchMove)
    canvas.el.removeEventListener('touchend', handleTouchEnd)
    canvas.el.removeEventListener('touchcancel', handleTouchEnd)
    window.removeEventListener('mousemove', handleWindowMouseMove)
    window.removeEventListener('mouseup', handleWindowMouseUp)
  }

  return { hovered, pos, update, dispose, clearHoverToken, lastHoverMoveTime, buttonsDown }
}
