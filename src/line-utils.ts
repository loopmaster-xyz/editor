import type { Caches } from './caches.ts'
import type { Canvas } from './canvas.ts'
import type { Lines, VisualLine } from './lines.ts'
import { measureText } from './measure.ts'
import type { Settings } from './settings.ts'
import type { Token } from './token.ts'

const visualLineCharOffsetCache = new WeakMap<VisualLine, number>()
const visualLineEmptyCache = new WeakMap<VisualLine, boolean>()
const NON_WHITESPACE_RE = /\S/

export function isLineEmpty(line: VisualLine): boolean {
  const cached = visualLineEmptyCache.get(line)
  if (cached !== undefined) return cached

  let isEmpty = true
  if (line.tokens.length > 0) {
    for (let i = 0; i < line.tokens.length; i++) {
      if (NON_WHITESPACE_RE.test(line.tokens[i].token.text)) {
        isEmpty = false
        break
      }
    }
  }

  visualLineEmptyCache.set(line, isEmpty)
  return isEmpty
}

export function findVisualLineForLogicalLine(
  visualLines: VisualLine[],
  logicalLine: number,
): VisualLine | null {
  for (const vl of visualLines) {
    if (vl.logicalLine === logicalLine) return vl
  }
  return null
}

export function findVisualLineForColumn(
  lines: Lines,
  logicalLine: number,
  column: number,
  tokenLines: Token[][],
  caches: Caches,
): VisualLine | null {
  const cacheKey = `${logicalLine}:${column}`
  const cached = caches.findVisualLineForColumnCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const visualLinesByLogicalLine = lines.visualLinesByLogicalLine.value
  const relevantLines = visualLinesByLogicalLine[logicalLine] ?? []
  if (relevantLines.length === 0) {
    return null
  }

  for (const visualLine of relevantLines) {
    const lineStartColumn = getCharOffsetForVisualLine(logicalLine, visualLine, tokenLines, lines)
    let lineEndColumn = lineStartColumn
    for (let i = 0; i < visualLine.tokens.length; i++) {
      lineEndColumn += visualLine.tokens[i].token.text.length
    }

    const isLast = visualLine === relevantLines[relevantLines.length - 1]

    if (
      column >= lineStartColumn
      && (column < lineEndColumn || isLast)
    ) {
      caches.findVisualLineForColumnCache.set(cacheKey, visualLine)
      return visualLine
    }
  }

  const result = relevantLines[relevantLines.length - 1]
  caches.findVisualLineForColumnCache.set(cacheKey, result)
  return result
}

export function getCharOffsetForVisualLine(
  logicalLine: number,
  visualLine: VisualLine,
  tokenLines: Token[][],
  lines?: Lines,
): number {
  if (lines) {
    const cached = visualLineCharOffsetCache.get(visualLine)
    if (cached !== undefined) return cached
  }

  const logicalLineTokens = tokenLines[logicalLine] || []
  const currentTokenIndices = new Set(visualLine.tokens.map(t => t.logicalTokenIndex))
  let columnOffset = 0
  for (let i = 0; i < visualLine.tokenOffset; i++) {
    if (!currentTokenIndices.has(i)) {
      columnOffset += logicalLineTokens[i]?.text.length || 0
    }
  }
  if (lines) {
    const visualLinesByLogicalLine = lines.visualLinesByLogicalLine.value
    const allVisualLines = visualLinesByLogicalLine[logicalLine] ?? []
    for (const prevLine of allVisualLines) {
      if (prevLine === visualLine) break
      for (const token of prevLine.tokens) {
        if (currentTokenIndices.has(token.logicalTokenIndex)) {
          columnOffset += token.token.text.length
        }
      }
    }
  }
  if (lines) visualLineCharOffsetCache.set(visualLine, columnOffset)
  return columnOffset
}

export function getColumnFromVisualPosition(
  lines: Lines,
  visualLine: VisualLine,
  worldX: number,
  tokenLines: Token[][],
  codeLines: string[],
  canvas: Canvas,
  settings: Settings,
  caches: Caches,
): number {
  const logicalLine = visualLine.logicalLine
  const lineText = codeLines[logicalLine] || ''

  const columnOffset = getCharOffsetForVisualLine(logicalLine, visualLine, tokenLines, lines)
  let currentColumn = columnOffset

  if (visualLine.tokens.length === 0) {
    return Math.min(columnOffset, lineText.length)
  }

  for (let i = 0; i < visualLine.tokens.length; i++) {
    const visualToken = visualLine.tokens[i]
    if (worldX >= visualToken.x && worldX < visualToken.endX) {
      const tokenRelativeX = worldX - visualToken.x
      const token = visualToken.token

      if (tokenRelativeX < visualToken.tokenEndX - visualToken.x) {
        let charIndex = 0
        let currentWidth = 0

        for (let j = 0; j < token.text.length; j++) {
          const char = token.text[j]
          const charWidth = measureText(canvas.c, settings, caches, { type: token.type, text: char }).width
          if (currentWidth + charWidth / 2 > tokenRelativeX) {
            charIndex = j
            break
          }
          currentWidth += charWidth
          charIndex = j + 1
        }

        return Math.min(currentColumn + charIndex, lineText.length)
      }
      else {
        return Math.min(currentColumn + token.text.length, lineText.length)
      }
    }
    currentColumn += visualToken.token.text.length
  }

  if (worldX < 0) {
    return Math.min(columnOffset, lineText.length)
  }
  else {
    const lastToken = visualLine.tokens[visualLine.tokens.length - 1]
    if (lastToken) {
      return Math.min(currentColumn, lineText.length)
    }
    return Math.min(columnOffset, lineText.length)
  }
}

export function getXFromColumn(
  lines: Lines,
  visualLine: VisualLine,
  column: number,
  tokenLines: Token[][],
  canvas: Canvas,
  settings: Settings,
  caches: Caches,
): number {
  const logicalLine = visualLine.logicalLine

  if ((tokenLines[logicalLine] || []).length === 0 || visualLine.tokens.length === 0) {
    return 0
  }

  const columnOffset = getCharOffsetForVisualLine(logicalLine, visualLine, tokenLines, lines)

  const cacheKey = `${logicalLine}:${visualLine.tokenOffset}:${column}`
  const cached = caches.getXFromColumnCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  let currentColumn = columnOffset
  for (let i = 0; i < visualLine.tokens.length; i++) {
    const visualToken = visualLine.tokens[i]
    const tokenStartColumn = currentColumn
    const tokenEndColumn = currentColumn + visualToken.token.text.length

    if (column >= tokenStartColumn && column <= tokenEndColumn) {
      const relativePos = column - tokenStartColumn
      const tokenWidth = visualToken.tokenEndX - visualToken.x
      const charWidth = visualToken.token.text.length > 0 ? tokenWidth / visualToken.token.text.length : 0
      const result = visualToken.x + relativePos * charWidth
      caches.getXFromColumnCache.set(cacheKey, result)
      return result
    }
    else if (column < tokenStartColumn && i === 0) {
      caches.getXFromColumnCache.set(cacheKey, 0)
      return 0
    }
    else if (column > tokenEndColumn && i === visualLine.tokens.length - 1) {
      caches.getXFromColumnCache.set(cacheKey, visualToken.endX)
      return visualToken.endX
    }

    currentColumn = tokenEndColumn
  }

  const lastToken = visualLine.tokens[visualLine.tokens.length - 1]
  if (lastToken) {
    caches.getXFromColumnCache.set(cacheKey, lastToken.endX)
    return lastToken.endX
  }
  const result = 0
  caches.getXFromColumnCache.set(cacheKey, result)
  return result
}

export function getXFromColumnUnclamped(
  lines: Lines,
  visualLine: VisualLine,
  column: number,
  tokenLines: Token[][],
  canvas: Canvas,
  settings: Settings,
  caches: Caches,
): number {
  const logicalLine = visualLine.logicalLine
  if ((tokenLines[logicalLine] || []).length === 0 || visualLine.tokens.length === 0) {
    return 0
  }

  const cacheKey = `u:${logicalLine}:${visualLine.tokenOffset}:${column}`
  const cached = caches.getXFromColumnCache.get(cacheKey)
  if (cached !== undefined) return cached

  const columnOffset = getCharOffsetForVisualLine(logicalLine, visualLine, tokenLines, lines)

  if (column < columnOffset) {
    caches.getXFromColumnCache.set(cacheKey, 0)
    return 0
  }

  if (column === columnOffset) {
    caches.getXFromColumnCache.set(cacheKey, 0)
    return 0
  }

  let currentColumn = columnOffset
  for (let i = 0; i < visualLine.tokens.length; i++) {
    const visualToken = visualLine.tokens[i]
    const tokenStartColumn = currentColumn
    const tokenEndColumn = currentColumn + visualToken.token.text.length

    if (column >= tokenStartColumn && column <= tokenEndColumn) {
      const relativePos = column - tokenStartColumn
      const tokenWidth = visualToken.tokenEndX - visualToken.x
      const charWidth = visualToken.token.text.length > 0 ? tokenWidth / visualToken.token.text.length : 0
      const result = visualToken.x + relativePos * charWidth
      caches.getXFromColumnCache.set(cacheKey, result)
      return result
    }
    else if (column < tokenStartColumn && i === 0) {
      caches.getXFromColumnCache.set(cacheKey, 0)
      return 0
    }

    currentColumn = tokenEndColumn
  }

  const lastToken = visualLine.tokens[visualLine.tokens.length - 1]
  if (lastToken) {
    const tokenWidth = lastToken.tokenEndX - lastToken.x
    const charWidth = lastToken.token.text.length > 0 ? tokenWidth / lastToken.token.text.length : 0
    const columnsBeyond = column - currentColumn
    const result = lastToken.endX + columnsBeyond * charWidth
    caches.getXFromColumnCache.set(cacheKey, result)
    return result
  }
  caches.getXFromColumnCache.set(cacheKey, 0)
  return 0
}

export function getColumnForTokenIndex(tokens: Token[], tokenIndex: number): number {
  let column = 0
  for (let i = 0; i < tokenIndex && i < tokens.length; i++) {
    column += tokens[i].text.length
  }
  return column
}

export function getTokenIndexFromColumn(tokens: Token[], column: number): number {
  let charOffset = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const tokenEnd = charOffset + token.text.length
    if (column >= charOffset && column < tokenEnd) {
      return i
    }
    if (column === tokenEnd && i === tokens.length - 1) {
      return i + 1
    }
    charOffset = tokenEnd
  }
  return tokens.length
}

export function getTokenRangeFromColumnRange(tokens: Token[],
  columnRange: [start: number, end: number]): [start: number, end: number]
{
  const startToken = getTokenIndexFromColumn(tokens, columnRange[0])
  const endToken = getTokenIndexFromColumn(tokens, columnRange[1])
  return [startToken, endToken]
}

function isWordChar(char: string): boolean {
  return /[a-zA-Z0-9_]/.test(char)
}

export function findWordBoundaries(line: string, column: number): { start: number; end: number } {
  if (line.length === 0) {
    return { start: 0, end: 0 }
  }

  const clampedColumn = Math.max(0, Math.min(column, line.length))

  if (clampedColumn === line.length) {
    if (isWordChar(line[clampedColumn - 1])) {
      let start = clampedColumn - 1
      while (start > 0 && isWordChar(line[start - 1])) {
        start--
      }
      return { start, end: clampedColumn }
    }
    return { start: clampedColumn, end: clampedColumn }
  }

  const char = line[clampedColumn]

  if (isWordChar(char)) {
    let start = clampedColumn
    while (start > 0 && isWordChar(line[start - 1])) {
      start--
    }

    let end = clampedColumn + 1
    while (end < line.length && isWordChar(line[end])) {
      end++
    }

    return { start, end }
  }

  return { start: clampedColumn, end: clampedColumn }
}

export function findLineBoundaries(line: string): { start: number; end: number } {
  return { start: 0, end: line.length }
}
