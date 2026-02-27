import type { Context } from '../context.ts'
import { findVisualLineForColumn, getXFromColumn, isLineEmpty } from '../line-utils.ts'
import { calculateAboveHeightForLine } from './widget.ts'

const OPACITY_HIGHLIGHT = 0.8
const OPACITY_NORMAL = 0.3
const LINE_WIDTH = 1

export function drawBlocks(context: Context) {
  const { canvas, doc, lines, blocks, settings, caches, scroll, header, caret } = context
  const { c } = canvas
  const visualLines = lines.visualLines.value
  const visualLinesByLogicalLine = lines.visualLinesByLogicalLine.value
  const blockStarts = blocks.blockStarts.value
  const codeLines = doc.lines
  const tokenLines = doc.tokenLines
  const scrollY = scroll.pos.y
  const headerHeight = header.value?.height ?? 0
  const visibleTop = -headerHeight - settings.paddingTop
  const canvasHeight = canvas.size.height.value - settings.paddingTop

  const matchingBrace = blocks.findMatchingBrace(caret.line.value, caret.column.value)
  const blockColors = settings.ui.blockColors

  function textBottom(line: (typeof visualLines)[number]) {
    return line.y + (line.widgets.below.length > 0 ? settings.lineHeight : line.height)
  }

  c.save()

  c.lineWidth = LINE_WIDTH
  c.lineCap = 'square'
  c.lineJoin = 'miter'

  if (matchingBrace && matchingBrace.line === matchingBrace.matchingLine) {
    let openColumn = 0
    for (let i = 0; i < matchingBrace.tokenIndex; i++) {
      openColumn += tokenLines[matchingBrace.line][i]?.text.length || 0
    }
    openColumn += matchingBrace.charIndex + 1

    let closeColumn = 0
    for (let i = 0; i < matchingBrace.matchingTokenIndex; i++) {
      closeColumn += tokenLines[matchingBrace.matchingLine][i]?.text.length || 0
    }
    closeColumn += matchingBrace.matchingCharIndex

    if (closeColumn !== openColumn) {
      const braceVisualLine = findVisualLineForColumn(lines, matchingBrace.line, openColumn, tokenLines, caches)
      if (braceVisualLine) {
        const openX = getXFromColumn(lines, braceVisualLine, openColumn, tokenLines, canvas, settings, caches)
        const closeX = getXFromColumn(lines, braceVisualLine, closeColumn, tokenLines, canvas, settings, caches)
        const braceY = textBottom(braceVisualLine)

        c.strokeStyle = blockColors[matchingBrace.depth % blockColors.length]
        c.globalAlpha = OPACITY_HIGHLIGHT
        c.beginPath()
        c.moveTo(openX, braceY)
        c.lineTo(closeX, braceY)
        c.stroke()
      }
    }
  }

  function getBlockInfo(startLine: number): { endLine: number; depth: number | null; indent: number } | null {
    if (startLine < 0 || startLine >= codeLines.length) return null

    const cached = caches.blockInfoCache.get(startLine)
    if (cached !== undefined) return cached

    const endLine = blocks.blockEnds.value.get(startLine)
    if (endLine === undefined || endLine < startLine) return null

    const depth = blocks.braceDepths.value.get(startLine) ?? null
    const startLineText = codeLines[startLine]
    const indent = startLineText.length - startLineText.trimStart().length

    const info = { endLine, depth, indent }
    caches.blockInfoCache.set(startLine, info)
    return info
  }

  function findBlockContainingLine(line: number): number | null {
    if (line < 0 || line >= codeLines.length) return null

    let bestStart: number | null = null
    let bestEnd = -1

    for (const startLine of blockStarts) {
      if (startLine > line) continue
      const info = getBlockInfo(startLine)
      if (!info) continue
      if (line >= startLine && line <= info.endLine) {
        if (bestStart === null || startLine > bestStart) {
          bestStart = startLine
          bestEnd = info.endLine
        }
      }
    }

    return bestStart
  }

  function findNearestBlockStart(line: number): number | null {
    if (line < 0 || line >= codeLines.length) return null

    let nearest: number | null = null
    for (const startLine of blockStarts) {
      if (startLine <= line) {
        if (nearest === null || startLine > nearest) {
          nearest = startLine
        }
      }
    }
    return nearest
  }

  const visibleLogicalLines = new Set<number>()
  for (let i = 0; i < visualLines.length; i++) {
    const visualLine = visualLines[i]
    const lineY = visualLine.y + scrollY
    const aboveHeight = calculateAboveHeightForLine(context, visualLine)
    const blockTop = lineY - aboveHeight
    const blockBottom = lineY + visualLine.height
    if (blockBottom > visibleTop && blockTop < canvasHeight) {
      visibleLogicalLines.add(visualLine.logicalLine)
    }
    else if (isLineEmpty(visualLine)) {
      for (let j = i + 1; j < visualLines.length; j++) {
        const next = visualLines[j]
        if (next.tokenOffset === 0 && next.widgets.above.length > 0) {
          const nextAbove = calculateAboveHeightForLine(context, next)
          const nextY = next.y + scrollY
          if (nextY + next.height > visibleTop && nextY - nextAbove < canvasHeight) {
            visibleLogicalLines.add(visualLine.logicalLine)
          }
          break
        }
      }
    }
  }

  if (visibleLogicalLines.size === 0) {
    c.restore()
    return
  }

  const blocksToDraw = new Set<number>()

  for (const logicalLine of visibleLogicalLines) {
    const containingBlock = findBlockContainingLine(logicalLine)
    if (containingBlock !== null) {
      blocksToDraw.add(containingBlock)
    }
    else {
      const nearestBlock = findNearestBlockStart(logicalLine)
      if (nearestBlock !== null) {
        blocksToDraw.add(nearestBlock)
      }
    }
  }

  const drawnBlocks = new Set<number>()

  function drawBlock(startLine: number) {
    if (drawnBlocks.has(startLine)) return
    if (!blockStarts.has(startLine)) return
    drawnBlocks.add(startLine)

    const info = getBlockInfo(startLine)
    if (!info) return

    const { endLine, depth } = info
    if (depth === null) return

    const startVisualLines = visualLinesByLogicalLine.get(startLine) ?? []
    const endVisualLines = visualLinesByLogicalLine.get(endLine) ?? []

    if (startVisualLines.length === 0) return

    const startVisualLine = startVisualLines.at(0)
    const isCollapsed = blocks.isCollapsed(startLine)
    const hasMatchingBrace = matchingBrace
      && (startLine === matchingBrace.line && endLine === matchingBrace.matchingLine - 1)

    if (isCollapsed && !hasMatchingBrace) return

    const startLineText = codeLines[startLine]
    const startIndent = startLineText.length - startLineText.trimStart().length

    const x = getXFromColumn(lines, startVisualLine, startIndent, tokenLines, canvas, settings, caches) + 1
    const startY = startVisualLine.y + startVisualLine.height

    if (isCollapsed) {
      if (hasMatchingBrace && matchingBrace.line === startLine) {
        let braceColumn = 0
        for (let i = 0; i < matchingBrace.tokenIndex; i++) {
          braceColumn += tokenLines[matchingBrace.line][i]?.text.length || 0
        }
        braceColumn += matchingBrace.charIndex

        const braceVisualLine = findVisualLineForColumn(lines, matchingBrace.line, braceColumn, tokenLines, caches)
        if (braceVisualLine) {
          const braceX = getXFromColumn(lines, braceVisualLine, braceColumn, tokenLines, canvas, settings, caches)

          const startYCanvas = startY + scrollY
          if (startYCanvas < visibleTop || startYCanvas > canvasHeight) return

          c.strokeStyle = blockColors[matchingBrace.depth % blockColors.length]
          c.globalAlpha = OPACITY_HIGHLIGHT
          c.beginPath()
          c.moveTo(x, startY)
          c.lineTo(braceX, startY)
          c.stroke()
        }
      }
      return
    }

    if (endVisualLines.length === 0) return

    const endVisualLine = endVisualLines.at(-1)
    const endY = textBottom(endVisualLine)

    const startYCanvas = startY + scrollY
    const endYCanvas = endY + scrollY
    if (endYCanvas < visibleTop || startYCanvas > canvasHeight) return

    if (hasMatchingBrace) {
      c.strokeStyle = blockColors[matchingBrace.depth % blockColors.length]
      c.globalAlpha = OPACITY_HIGHLIGHT
    }
    else {
      c.strokeStyle = blockColors[depth % blockColors.length]
      c.globalAlpha = OPACITY_NORMAL
    }

    c.beginPath()
    c.moveTo(x, endY)
    c.lineTo(x, startY)

    if (hasMatchingBrace) {
      if (matchingBrace.line === startLine) {
        let braceColumn = 0
        for (let i = 0; i < matchingBrace.tokenIndex; i++) {
          braceColumn += tokenLines[matchingBrace.line][i]?.text.length || 0
        }
        braceColumn += matchingBrace.charIndex

        const braceVisualLine = findVisualLineForColumn(lines, matchingBrace.line, braceColumn, tokenLines, caches)
        if (braceVisualLine) {
          const braceX = getXFromColumn(lines, braceVisualLine, braceColumn, tokenLines, canvas, settings, caches)
          c.lineTo(braceX, startY)
        }
      }
    }

    c.stroke()
  }

  function walkUp(fromLine: number) {
    if (fromLine < 0) return

    for (let line = fromLine; line >= 0; line--) {
      if (!blockStarts.has(line)) continue

      const info = getBlockInfo(line)
      if (!info) continue

      if (!blocksToDraw.has(line)) {
        blocksToDraw.add(line)
      }

      if (info.indent === 0) return
    }
  }

  function walkDown(fromLine: number) {
    if (fromLine >= codeLines.length) return

    for (let line = fromLine; line < codeLines.length; line++) {
      if (!blockStarts.has(line)) continue

      const info = getBlockInfo(line)
      if (!info) continue

      if (!blocksToDraw.has(line)) {
        blocksToDraw.add(line)
      }

      if (info.indent === 0) return
    }
  }

  const visibleLinesArray = Array.from(visibleLogicalLines).sort((a, b) => a - b)
  if (visibleLinesArray.length > 0) {
    const firstVisibleLine = visibleLinesArray[0]
    const lastVisibleLine = visibleLinesArray[visibleLinesArray.length - 1]

    walkUp(firstVisibleLine - 1)
    walkDown(lastVisibleLine + 1)
  }

  for (const startLine of blocksToDraw) {
    drawBlock(startLine)
  }

  c.restore()
}
