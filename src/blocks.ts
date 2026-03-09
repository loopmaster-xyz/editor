import { computed, effect, signal } from '@preact/signals-core'
import type { Caches } from './caches.ts'
import type { Doc } from './doc.ts'
import type { Token } from './token.ts'

export type Blocks = ReturnType<typeof createBlocks>

export interface MatchingBrace {
  line: number
  tokenIndex: number
  token: Token
  charIndex: number
  matchingLine: number
  matchingTokenIndex: number
  matchingToken: Token
  matchingCharIndex: number
  depth: number
}

interface BraceInfo {
  char: string
  line: number
  tokenIndex: number
  token: Token
  charIndex: number
  position: number
  isOpening: boolean
}

interface BraceCache {
  braces: BraceInfo[]
  matchedPairs: { openIndex: number; closeIndex: number; depth: number }[]
  lineLengths: number[]
  lineStartPositions: number[]
  pairEntries: PairEntry[]
  coverageSegments: CoverageSegment[]
}

interface PairEntry {
  id: number
  openIndex: number
  closeIndex: number
  depth: number
  openStart: number
  openEnd: number
  closeStart: number
  closeEnd: number
  range: number
}

interface CoverageSegment {
  start: number
  end: number
  pairEntryIndex: number
}

interface LineTransform {
  startLine: number
  endLineAfter: number
  lineDelta: number
}

const openingBraces = new Set(['{', '(', '['])
const closingBraces = new Set(['}', ')', ']'])
const quoteChars = new Set(["'", '"', '`'])

type VersionedBraceCacheEntry = {
  tokenVersion: number
  cache: BraceCache
}

const braceCache = new WeakMap<Token[][], VersionedBraceCacheEntry>()

type BraceCacheRebuildRequestMessage = {
  type: 'braceCacheRebuild'
  jobId: number
  tokenVersion: number
  tokenLines: Token[][]
}

type BraceCacheRebuildResultMessage = {
  type: 'braceCacheRebuildResult'
  jobId: number
  tokenVersion: number
  cache: BraceCache
}

function getBraceCacheRebuildDebounceMs(lineCount: number): number {
  if (lineCount >= 100_000) return 650
  if (lineCount >= 50_000) return 420
  if (lineCount >= 20_000) return 280
  return 180
}

const EMPTY_BRACE_CACHE: BraceCache = {
  braces: [],
  matchedPairs: [],
  lineLengths: [],
  lineStartPositions: [0],
  pairEntries: [],
  coverageSegments: [],
}

function makeBraceLocationKey(line: number, tokenIndex: number, charIndex: number): string {
  return `${line}:${tokenIndex}:${charIndex}`
}

function comparePairPriority(a: number, b: number, pairEntries: PairEntry[]): number {
  const aPair = pairEntries[a]
  const bPair = pairEntries[b]
  if (aPair.range !== bPair.range) return aPair.range - bPair.range
  return aPair.id - bPair.id
}

function pushMinHeap(heap: number[], value: number, pairEntries: PairEntry[]) {
  heap.push(value)
  let index = heap.length - 1
  while (index > 0) {
    const parent = (index - 1) >> 1
    if (comparePairPriority(heap[index], heap[parent], pairEntries) >= 0) break
    const tmp = heap[parent]
    heap[parent] = heap[index]
    heap[index] = tmp
    index = parent
  }
}

function popMinHeap(heap: number[], pairEntries: PairEntry[]): number | undefined {
  if (heap.length === 0) return undefined
  const top = heap[0]
  const last = heap.pop()
  if (heap.length === 0 || last === undefined) return top
  heap[0] = last

  let index = 0
  while (true) {
    const left = index * 2 + 1
    const right = left + 1
    let smallest = index

    if (left < heap.length && comparePairPriority(heap[left], heap[smallest], pairEntries) < 0) {
      smallest = left
    }
    if (right < heap.length && comparePairPriority(heap[right], heap[smallest], pairEntries) < 0) {
      smallest = right
    }
    if (smallest === index) break

    const tmp = heap[index]
    heap[index] = heap[smallest]
    heap[smallest] = tmp
    index = smallest
  }

  return top
}

function peekMinHeap(heap: number[]): number | undefined {
  return heap.length > 0 ? heap[0] : undefined
}

function getBestActivePairIndex(heap: number[], active: boolean[], pairEntries: PairEntry[]): number | null {
  while (heap.length > 0) {
    const top = peekMinHeap(heap)
    if (top === undefined) return null
    if (active[top]) return top
    popMinHeap(heap, pairEntries)
  }
  return null
}

function getMatchingOpenBrace(closeChar: string): string {
  switch (closeChar) {
    case '}':
      return '{'
    case ')':
      return '('
    case ']':
      return '['
    case "'":
      return "'"
    case '"':
      return '"'
    case '`':
      return '`'
    default:
      return ''
  }
}

type SameLineBrace = {
  char: string
  tokenIndex: number
  token: Token
  charIndex: number
  position: number
  depth: number
}

const sameLineBraceDepthCache = new WeakMap<Token[], Map<string, number>>()

function makeSameLineBraceLocationKey(tokenIndex: number, charIndex: number): string {
  return `${tokenIndex}:${charIndex}`
}

function getSameLineBraceDepthForPosition(
  tokenLines: Token[][],
  line: number,
  tokenIndex: number,
  charIndex: number,
): number | null {
  if (line < 0 || line >= tokenLines.length) return null
  const lineTokens = tokenLines[line] ?? []
  if (lineTokens.length === 0) return null

  let depthByLocation = sameLineBraceDepthCache.get(lineTokens)
  if (!depthByLocation) {
    depthByLocation = new Map<string, number>()
    const braces: Array<{
      char: string
      tokenIndex: number
      charIndex: number
      isOpening: boolean
    }> = []
    let inString: string | null = null

    for (let i = 0; i < lineTokens.length; i++) {
      const token = lineTokens[i]
      if (token.type === 'comment') continue
      const text = token.text
      let escaped = false

      for (let j = 0; j < text.length; j++) {
        const char = text[j]
        if (escaped) {
          escaped = false
          continue
        }
        if (char === '\\') {
          escaped = true
          continue
        }

        if (quoteChars.has(char)) {
          if (inString === null) {
            inString = char
            braces.push({ char, tokenIndex: i, charIndex: j, isOpening: true })
          }
          else if (inString === char) {
            inString = null
            braces.push({ char, tokenIndex: i, charIndex: j, isOpening: false })
          }
          continue
        }

        if (openingBraces.has(char) || closingBraces.has(char)) {
          braces.push({ char, tokenIndex: i, charIndex: j, isOpening: openingBraces.has(char) })
        }
      }
    }

    const stack: Array<{ char: string; index: number; depth: number }> = []
    for (let i = 0; i < braces.length; i++) {
      const brace = braces[i]
      if (brace.isOpening) {
        stack.push({ char: brace.char, index: i, depth: stack.length })
        continue
      }

      const expectedOpen = getMatchingOpenBrace(brace.char)
      for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j].char !== expectedOpen) continue

        const open = braces[stack[j].index]
        const depth = stack[j].depth
        depthByLocation.set(makeSameLineBraceLocationKey(open.tokenIndex, open.charIndex), depth)
        depthByLocation.set(makeSameLineBraceLocationKey(brace.tokenIndex, brace.charIndex), depth)
        stack.splice(j, 1)
        break
      }
    }

    sameLineBraceDepthCache.set(lineTokens, depthByLocation)
  }

  return depthByLocation.get(makeSameLineBraceLocationKey(tokenIndex, charIndex)) ?? null
}

function findSameLineMatchingBraceFallback(
  tokenLines: Token[][],
  cursorLine: number,
  cursorColumn: number,
): MatchingBrace | null {
  if (cursorLine < 0 || cursorLine >= tokenLines.length) return null
  const lineTokens = tokenLines[cursorLine] ?? []
  if (lineTokens.length === 0) return null

  const stack: SameLineBrace[] = []
  const pairs: Array<{ open: SameLineBrace; close: SameLineBrace }> = []

  let position = 0
  for (let tokenIndex = 0; tokenIndex < lineTokens.length; tokenIndex++) {
    const token = lineTokens[tokenIndex]
    const text = token.text

    if (token.type === 'comment') {
      position += text.length
      continue
    }

    for (let charIndex = 0; charIndex < text.length; charIndex++) {
      const char = text[charIndex]
      if (openingBraces.has(char)) {
        stack.push({
          char,
          tokenIndex,
          token,
          charIndex,
          position: position + charIndex,
          depth: stack.length,
        })
      }
      else if (closingBraces.has(char)) {
        const expectedOpen = getMatchingOpenBrace(char)
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].char !== expectedOpen) continue
          const open = stack[i]
          const close: SameLineBrace = {
            char,
            tokenIndex,
            token,
            charIndex,
            position: position + charIndex,
            depth: open.depth,
          }
          pairs.push({ open, close })
          stack.splice(i, 1)
          break
        }
      }
    }

    position += text.length
  }

  if (pairs.length === 0) return null

  let best: { open: SameLineBrace; close: SameLineBrace } | null = null
  let bestRange = Number.POSITIVE_INFINITY
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]
    const openPos = pair.open.position
    const closePos = pair.close.position
    if (cursorColumn < openPos || cursorColumn > closePos + 1) continue
    const range = closePos - openPos
    if (!best || range < bestRange) {
      best = pair
      bestRange = range
    }
  }

  if (!best) return null

  return {
    line: cursorLine,
    tokenIndex: best.open.tokenIndex,
    token: best.open.token,
    charIndex: best.open.charIndex,
    matchingLine: cursorLine,
    matchingTokenIndex: best.close.tokenIndex,
    matchingToken: best.close.token,
    matchingCharIndex: best.close.charIndex,
    depth: best.open.depth,
  }
}

function buildBraceCache(tokenLines: Token[][], tokenVersion: number): BraceCache {
  const existing = braceCache.get(tokenLines)
  if (existing && existing.tokenVersion === tokenVersion) return existing.cache

  const braces: BraceInfo[] = []
  const lineLengths: number[] = []
  const lineStartPositions: number[] = new Array(tokenLines.length + 1).fill(0)
  let inString: string | null = null
  let globalPos = 0

  for (let lineIndex = 0; lineIndex < tokenLines.length; lineIndex++) {
    const line = tokenLines[lineIndex]
    lineStartPositions[lineIndex] = globalPos
    let currentColumn = 0
    let lineLength = 0

    for (let tokenIndex = 0; tokenIndex < line.length; tokenIndex++) {
      const token = line[tokenIndex]
      const text = token.text
      lineLength += text.length

      if (token.type !== 'comment') {
        let escaped = false
        for (let charIndex = 0; charIndex < text.length; charIndex++) {
          const char = text[charIndex]
          if (escaped) {
            escaped = false
            continue
          }
          if (char === '\\') {
            escaped = true
            continue
          }
          if (quoteChars.has(char)) {
            if (inString === null) {
              inString = char
              braces.push({
                char,
                line: lineIndex,
                tokenIndex,
                token,
                charIndex,
                position: currentColumn + charIndex,
                isOpening: true,
              })
            }
            else if (inString === char) {
              inString = null
              braces.push({
                char,
                line: lineIndex,
                tokenIndex,
                token,
                charIndex,
                position: currentColumn + charIndex,
                isOpening: false,
              })
            }
          }
          else if (openingBraces.has(char) || closingBraces.has(char)) {
            braces.push({
              char,
              line: lineIndex,
              tokenIndex,
              token,
              charIndex,
              position: currentColumn + charIndex,
              isOpening: openingBraces.has(char),
            })
          }
        }
      }

      currentColumn += text.length
    }

    lineLengths.push(lineLength)
    globalPos += lineLength + 1
  }
  lineStartPositions[tokenLines.length] = globalPos

  const matchedPairs: { openIndex: number; closeIndex: number; depth: number }[] = []
  const stack: { char: string; index: number; depth: number }[] = []

  for (let i = 0; i < braces.length; i++) {
    const brace = braces[i]

    if (brace.isOpening) {
      const depth = stack.length
      stack.push({ char: brace.char, index: i, depth })
    }
    else {
      const expectedOpen = getMatchingOpenBrace(brace.char)

      for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j].char === expectedOpen) {
          matchedPairs.push({
            openIndex: stack[j].index,
            closeIndex: i,
            depth: stack[j].depth,
          })

          stack.splice(j, 1)
          break
        }
      }
    }
  }

  const pairEntries: PairEntry[] = matchedPairs.map((pair, id) => {
    const openBrace = braces[pair.openIndex]
    const closeBrace = braces[pair.closeIndex]
    const openStart = (lineStartPositions[openBrace.line] ?? 0) + openBrace.position
    const closeStart = (lineStartPositions[closeBrace.line] ?? 0) + closeBrace.position
    const openEnd = openStart + 1
    const closeEnd = closeStart + 1

    return {
      id,
      openIndex: pair.openIndex,
      closeIndex: pair.closeIndex,
      depth: pair.depth,
      openStart,
      openEnd,
      closeStart,
      closeEnd,
      range: closeEnd - openStart,
    }
  })

  const events: Array<{ pos: number; add: boolean; pairIndex: number }> = []
  events.length = pairEntries.length * 2
  let eventOffset = 0
  for (let i = 0; i < pairEntries.length; i++) {
    const pairEntry = pairEntries[i]
    events[eventOffset++] = { pos: pairEntry.openStart, add: true, pairIndex: i }
    events[eventOffset++] = { pos: pairEntry.closeEnd + 1, add: false, pairIndex: i }
  }
  events.length = eventOffset
  events.sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos
    if (a.add === b.add) return 0
    return a.add ? 1 : -1
  })

  const active = new Array<boolean>(pairEntries.length).fill(false)
  const heap: number[] = []
  const coverageSegments: CoverageSegment[] = []

  for (let i = 0; i < events.length;) {
    const pos = events[i].pos

    while (i < events.length && events[i].pos === pos && !events[i].add) {
      active[events[i].pairIndex] = false
      i++
    }
    while (i < events.length && events[i].pos === pos && events[i].add) {
      const pairIndex = events[i].pairIndex
      active[pairIndex] = true
      pushMinHeap(heap, pairIndex, pairEntries)
      i++
    }

    const nextPos = i < events.length ? events[i].pos : undefined
    if (nextPos === undefined) continue

    const bestPairIndex = getBestActivePairIndex(heap, active, pairEntries)
    if (bestPairIndex === null) continue

    const segmentStart = pos
    const segmentEnd = nextPos - 1
    if (segmentEnd < segmentStart) continue

    const prev = coverageSegments[coverageSegments.length - 1]
    if (prev && prev.pairEntryIndex === bestPairIndex && prev.end + 1 === segmentStart) {
      prev.end = segmentEnd
    }
    else {
      coverageSegments.push({
        start: segmentStart,
        end: segmentEnd,
        pairEntryIndex: bestPairIndex,
      })
    }
  }

  const cache: BraceCache = { braces, matchedPairs, lineLengths, lineStartPositions, pairEntries, coverageSegments }
  braceCache.set(tokenLines, { tokenVersion, cache })
  return cache
}

function computeBlockRanges(codeLines: string[]): { starts: Set<number>; ends: Map<number, number> } {
  const starts = new Set<number>()
  const ends = new Map<number, number>()
  const stack: Array<{ startLine: number; indent: number }> = []

  const lineCount = codeLines.length
  const nonEmpty = new Uint8Array(lineCount)
  const indentByLine = new Uint32Array(lineCount)
  const nextNonEmptyLine = new Int32Array(lineCount)
  nextNonEmptyLine.fill(-1)

  for (let i = 0; i < lineCount; i++) {
    const line = codeLines[i] ?? ''
    let indent = 0
    while (indent < line.length) {
      const code = line.charCodeAt(indent)
      if (code !== 32 && code !== 9) break
      indent++
    }

    if (indent < line.length) {
      nonEmpty[i] = 1
      indentByLine[i] = indent
    }
  }

  let next = -1
  for (let i = lineCount - 1; i >= 0; i--) {
    nextNonEmptyLine[i] = next
    if (nonEmpty[i] === 1) next = i
  }

  for (let i = 0; i < lineCount; i++) {
    if (nonEmpty[i] === 0) continue

    const currentIndent = indentByLine[i]
    while (stack.length > 0 && currentIndent <= stack[stack.length - 1].indent) {
      const block = stack.pop()!
      ends.set(block.startLine, i - 1)
    }

    const nextLineIndex = nextNonEmptyLine[i]
    if (nextLineIndex < 0) continue

    const nextIndent = indentByLine[nextLineIndex]
    if (nextIndent > currentIndent) {
      starts.add(i)
      stack.push({ startLine: i, indent: currentIndent })
    }
  }

  const defaultEnd = Math.max(0, lineCount - 1)
  while (stack.length > 0) {
    const block = stack.pop()!
    ends.set(block.startLine, defaultEnd)
  }

  return { starts, ends }
}

function mergeBraceMultilineBlockRanges(
  baseRanges: { starts: Set<number>; ends: Map<number, number> },
  cache: BraceCache,
  lineCount: number,
): { starts: Set<number>; ends: Map<number, number> } {
  if (lineCount <= 0 || cache.matchedPairs.length === 0) return baseRanges

  const starts = new Set<number>(baseRanges.starts)
  const ends = new Map<number, number>(baseRanges.ends)
  const { braces, matchedPairs } = cache

  for (let i = 0; i < matchedPairs.length; i++) {
    const pair = matchedPairs[i]
    const openBrace = braces[pair.openIndex]
    const closeBrace = braces[pair.closeIndex]
    if (!openBrace || !closeBrace) continue
    if (openBrace.char !== '{' || closeBrace.char !== '}') continue
    if (closeBrace.line <= openBrace.line) continue

    const startLine = openBrace.line
    if (startLine < 0 || startLine >= lineCount) continue

    const endLine = Math.min(lineCount - 1, closeBrace.line - 1)
    if (endLine < startLine) continue

    starts.add(startLine)
    const existingEnd = ends.get(startLine)
    if (existingEnd === undefined || endLine > existingEnd) {
      ends.set(startLine, endLine)
    }
  }

  return { starts, ends }
}

interface BlockNavigationIndex {
  sortedStarts: number[]
  parentByStart: Map<number, number | null>
  indentByStart: Map<number, number>
  endByStart: Map<number, number>
}

function upperBound(sorted: number[], target: number): number {
  let low = 0
  let high = sorted.length

  while (low < high) {
    const mid = (low + high) >> 1
    if (sorted[mid] <= target) {
      low = mid + 1
    }
    else {
      high = mid
    }
  }

  return low
}

function findCoverageSegment(
  coverageSegments: CoverageSegment[],
  pos: number,
): CoverageSegment | null {
  let low = 0
  let high = coverageSegments.length

  while (low < high) {
    const mid = (low + high) >> 1
    if (coverageSegments[mid].start <= pos) {
      low = mid + 1
    }
    else {
      high = mid
    }
  }

  const index = low - 1
  if (index < 0) return null
  const segment = coverageSegments[index]
  return pos <= segment.end ? segment : null
}

function findBracePairEntryAtPosition(
  cache: BraceCache,
  cursorLine: number,
  cursorColumn: number,
): PairEntry | null {
  const { pairEntries, coverageSegments, lineStartPositions, lineLengths } = cache
  if (pairEntries.length === 0 || coverageSegments.length === 0) return null

  const maxLine = Math.max(0, lineStartPositions.length - 2)
  const clampedCursorLine = Math.max(0, Math.min(cursorLine, maxLine))
  const maxColumn = lineLengths[clampedCursorLine] ?? 0
  const clampedCursorColumn = Math.max(0, Math.min(cursorColumn, maxColumn))
  const cursorGlobalPos = (lineStartPositions[clampedCursorLine] ?? 0) + clampedCursorColumn
  const coverageSegment = findCoverageSegment(coverageSegments, cursorGlobalPos)
  if (!coverageSegment) return null
  return pairEntries[coverageSegment.pairEntryIndex] ?? null
}

interface CacheMatchingBrace extends MatchingBrace {
  openColumn: number
  closeColumn: number
}

function findMatchingBraceInCache(
  cache: BraceCache,
  cursorLine: number,
  cursorColumn: number,
): CacheMatchingBrace | null {
  const { braces, lineStartPositions } = cache
  if (braces.length === 0) {
    return null
  }

  const pairEntry = findBracePairEntryAtPosition(cache, cursorLine, cursorColumn)
  if (!pairEntry) return null
  const openBrace = braces[pairEntry.openIndex]
  const closeBrace = braces[pairEntry.closeIndex]

  // Treat "after closing root brace" as outside the block for top-level guides.
  // This avoids sticky highlight when caret is positioned after an indent-0 `}` line.
  const isTopLevelCurlyPair = pairEntry.depth === 0 && openBrace.char === '{' && closeBrace.char === '}'
  const isAfterRootCloseBrace = cursorLine === closeBrace.line && closeBrace.position === 0
    && cursorColumn > closeBrace.position + 1
  if (isTopLevelCurlyPair && isAfterRootCloseBrace) {
    return null
  }

  return {
    line: openBrace.line,
    tokenIndex: openBrace.tokenIndex,
    token: openBrace.token,
    charIndex: openBrace.charIndex,
    matchingLine: closeBrace.line,
    matchingTokenIndex: closeBrace.tokenIndex,
    matchingToken: closeBrace.token,
    matchingCharIndex: closeBrace.charIndex,
    depth: pairEntry.depth,
    openColumn: openBrace.position,
    closeColumn: closeBrace.position,
  }
}

function getColumnFromTokenLocation(
  tokenLines: Token[][],
  line: number,
  tokenIndex: number,
  charIndex: number,
): number {
  if (line < 0 || line >= tokenLines.length) return Math.max(0, charIndex)
  const lineTokens = tokenLines[line] ?? []
  if (lineTokens.length === 0) return Math.max(0, charIndex)

  const safeTokenIndex = Math.max(0, Math.min(tokenIndex, lineTokens.length - 1))
  let column = Math.max(0, charIndex)
  for (let i = 0; i < safeTokenIndex; i++) {
    column += lineTokens[i]?.text.length ?? 0
  }
  return column
}

function isCursorInsideMatchingBraceRange(
  tokenLines: Token[][],
  match: MatchingBrace,
  cursorLine: number,
  cursorColumn: number,
): boolean {
  if (cursorLine < match.line || cursorLine > match.matchingLine) return false

  const openColumn = getColumnFromTokenLocation(tokenLines, match.line, match.tokenIndex, match.charIndex)
  const closeColumn = getColumnFromTokenLocation(
    tokenLines,
    match.matchingLine,
    match.matchingTokenIndex,
    match.matchingCharIndex,
  )

  if (match.line === match.matchingLine) {
    return cursorColumn >= openColumn && cursorColumn <= closeColumn + 1
  }

  if (cursorLine === match.line) {
    return cursorColumn >= openColumn
  }

  if (cursorLine === match.matchingLine) {
    const openChar = match.token.text[match.charIndex]
    const closeChar = match.matchingToken.text[match.matchingCharIndex]
    const isTopLevelCurlyPair = match.depth === 0 && openChar === '{' && closeChar === '}'
    const isAfterRootCloseBrace = closeColumn === 0 && cursorColumn > closeColumn + 1
    if (isTopLevelCurlyPair && isAfterRootCloseBrace) return false
    return cursorColumn <= closeColumn + 1
  }

  return true
}

function resolveTokenLocationAtColumn(
  tokenLines: Token[][],
  line: number,
  column: number,
  expectedChar: string,
): { tokenIndex: number; charIndex: number; token: Token } | null {
  if (line < 0 || line >= tokenLines.length) return null
  const tokens = tokenLines[line] ?? []
  if (tokens.length === 0) return null

  const targetColumn = Math.max(0, column)
  let currentColumn = 0

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex]
    const text = token?.text ?? ''
    const nextColumn = currentColumn + text.length
    if (text.length > 0 && targetColumn < nextColumn) {
      let charIndex = targetColumn - currentColumn
      if (charIndex < 0) charIndex = 0
      if (charIndex >= text.length) charIndex = text.length - 1

      if (text[charIndex] === expectedChar) {
        return { tokenIndex, charIndex, token }
      }

      const localExactIndex = text.indexOf(expectedChar)
      if (localExactIndex >= 0) {
        return { tokenIndex, charIndex: localExactIndex, token }
      }
    }
    currentColumn = nextColumn
  }

  let best: { tokenIndex: number; charIndex: number; token: Token; distance: number } | null = null
  currentColumn = 0
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex]
    const text = token?.text ?? ''
    for (let charIndex = 0; charIndex < text.length; charIndex++) {
      if (text[charIndex] !== expectedChar) continue
      const absoluteColumn = currentColumn + charIndex
      const distance = Math.abs(absoluteColumn - targetColumn)
      if (!best || distance < best.distance) {
        best = { tokenIndex, charIndex, token, distance }
        if (distance === 0) {
          return { tokenIndex, charIndex, token }
        }
      }
    }
    currentColumn += text.length
  }

  if (!best) return null
  return { tokenIndex: best.tokenIndex, charIndex: best.charIndex, token: best.token }
}

function countIndent(line: string): number {
  let indent = 0
  while (indent < line.length) {
    const code = line.charCodeAt(indent)
    if (code !== 32 && code !== 9) break
    indent++
  }
  return indent
}

export function createBlocks(doc: Doc, caches: Caches) {
  let lastStableBraceCache: BraceCache = EMPTY_BRACE_CACHE
  let lastStableBraceTokenVersion = -1
  let braceRebuildTimer: ReturnType<typeof setTimeout> | null = null
  let braceWorker: Worker | null = null
  let braceWorkerJobId = 0
  let activeBraceWorkerJob: { jobId: number; tokenVersion: number } | null = null
  let queuedBraceWorkerTokenVersion: number | null = null
  const debouncedBraceTokenVersion = signal(-1)
  const pendingLineTransforms: LineTransform[] = []
  let pendingLineTransformsVersion = 0
  let staleLookupCacheStamp = ''
  const stableLineCandidatesCache = new Map<number, number[]>()
  const staleDepthByColumnCache = new Map<string, number | null>()
  const staleMatchingBraceCache = new Map<string, MatchingBrace | null>()
  const MAX_STABLE_LINE_CANDIDATES = 64
  const MAX_PENDING_LINE_TRANSFORMS = 4096

  // Seed brace analysis synchronously so first paint has usable depths/colors.
  const initialTokenVersion = doc.tokenVersion
  debouncedBraceTokenVersion.value = initialTokenVersion
  lastStableBraceCache = buildBraceCache(doc.tokenLines, initialTokenVersion)
  lastStableBraceTokenVersion = initialTokenVersion

  const clearStaleLookupCaches = () => {
    stableLineCandidatesCache.clear()
    staleDepthByColumnCache.clear()
    staleMatchingBraceCache.clear()
  }

  const getStaleLookupCacheStamp = () => {
    return `${doc.tokenVersion}:${lastStableBraceTokenVersion}:${pendingLineTransformsVersion}`
  }

  const ensureStaleLookupCachesFresh = () => {
    const nextStamp = getStaleLookupCacheStamp()
    if (nextStamp === staleLookupCacheStamp) return
    staleLookupCacheStamp = nextStamp
    clearStaleLookupCaches()
  }

  const resetPendingLineTransforms = () => {
    pendingLineTransforms.length = 0
    pendingLineTransformsVersion++
    clearStaleLookupCaches()
  }

  const publishStableBraceCache = (tokenVersion: number, cache: BraceCache) => {
    lastStableBraceCache = cache
    lastStableBraceTokenVersion = tokenVersion
    debouncedBraceTokenVersion.value = tokenVersion
    resetPendingLineTransforms()
  }

  const shouldUseBraceWorker = () => {
    return typeof window !== 'undefined'
      && typeof Worker !== 'undefined'
      && doc.lines.length >= 20_000
  }

  const flushQueuedBraceWorkerRebuild = () => {
    if (queuedBraceWorkerTokenVersion === null) return
    if (activeBraceWorkerJob) return
    const nextTokenVersion = queuedBraceWorkerTokenVersion
    queuedBraceWorkerTokenVersion = null
    if (doc.tokenVersion !== nextTokenVersion) return
    const worker = ensureBraceWorker()
    if (!worker) {
      publishStableBraceCache(nextTokenVersion, buildBraceCache(doc.tokenLines, nextTokenVersion))
      return
    }
    const jobId = ++braceWorkerJobId
    activeBraceWorkerJob = { jobId, tokenVersion: nextTokenVersion }
    const message: BraceCacheRebuildRequestMessage = {
      type: 'braceCacheRebuild',
      jobId,
      tokenVersion: nextTokenVersion,
      tokenLines: doc.tokenLines,
    }
    worker.postMessage(message)
  }

  const ensureBraceWorker = () => {
    if (!shouldUseBraceWorker()) return null
    if (braceWorker) return braceWorker
    braceWorker = new Worker(new URL('./brace-worker.ts', import.meta.url), { type: 'module' })
    braceWorker.onmessage = (event: MessageEvent<BraceCacheRebuildResultMessage>) => {
      const message = event.data
      if (!message || message.type !== 'braceCacheRebuildResult') return
      if (!activeBraceWorkerJob || activeBraceWorkerJob.jobId !== message.jobId) return
      activeBraceWorkerJob = null

      if (doc.tokenVersion === message.tokenVersion) {
        publishStableBraceCache(message.tokenVersion, message.cache)
      }

      flushQueuedBraceWorkerRebuild()
    }
    return braceWorker
  }

  const mapCurrentLineToStableLine = (line: number): number | null => {
    let mappedLine = line
    for (let i = pendingLineTransforms.length - 1; i >= 0; i--) {
      const transform = pendingLineTransforms[i]
      const delta = transform.lineDelta
      if (delta === 0) continue
      if (mappedLine < transform.startLine) continue
      if (mappedLine <= transform.endLineAfter) return null
      mappedLine -= delta
    }
    return mappedLine
  }

  // Best-effort mapping for lines inside active transform windows.
  // Used for stale-color fallback so braces do not drop to baseline during insert/delete shifts.
  const mapCurrentLineToStableLineApprox = (line: number): number | null => {
    let mappedLine = line
    for (let i = pendingLineTransforms.length - 1; i >= 0; i--) {
      const transform = pendingLineTransforms[i]
      const delta = transform.lineDelta
      if (delta === 0) continue
      if (mappedLine < transform.startLine) continue
      if (mappedLine <= transform.endLineAfter) {
        mappedLine = transform.startLine
        continue
      }
      mappedLine -= delta
    }
    return mappedLine
  }

  const mapStableLineToCurrentLineApprox = (line: number): number => {
    let mappedLine = line
    for (let i = 0; i < pendingLineTransforms.length; i++) {
      const transform = pendingLineTransforms[i]
      const delta = transform.lineDelta
      if (delta === 0) continue

      const startLine = transform.startLine
      const endLineBefore = transform.endLineAfter - delta

      if (mappedLine < startLine) continue

      if (mappedLine > endLineBefore) {
        mappedLine += delta
        continue
      }

      if (delta < 0) {
        mappedLine = startLine
      }
    }
    return mappedLine
  }

  const getStableLineCandidatesForCurrentLine = (line: number): number[] => {
    ensureStaleLookupCachesFresh()
    const cached = stableLineCandidatesCache.get(line)
    if (cached) return cached

    let candidates = new Set<number>([line])

    for (let i = pendingLineTransforms.length - 1; i >= 0; i--) {
      const transform = pendingLineTransforms[i]
      const delta = transform.lineDelta
      if (delta === 0) continue

      const startLine = transform.startLine
      const endLineAfter = transform.endLineAfter
      const endLineBefore = endLineAfter - delta
      const rangeStart = Math.min(startLine, endLineBefore)
      const rangeEnd = Math.max(startLine, endLineBefore)
      const next = new Set<number>()

      for (const mappedLine of candidates) {
        if (mappedLine < startLine) {
          next.add(mappedLine)
          continue
        }

        if (mappedLine > endLineAfter) {
          next.add(mappedLine - delta)
          continue
        }

        const rangeLength = rangeEnd - rangeStart + 1
        if (rangeLength <= MAX_STABLE_LINE_CANDIDATES) {
          for (let stableLine = rangeStart; stableLine <= rangeEnd; stableLine++) {
            next.add(stableLine)
          }
        }
        else {
          const half = MAX_STABLE_LINE_CANDIDATES >> 1
          const headEnd = rangeStart + half - 1
          const tailStart = rangeEnd - half + 1
          for (let stableLine = rangeStart; stableLine <= headEnd; stableLine++) {
            next.add(stableLine)
          }
          for (let stableLine = tailStart; stableLine <= rangeEnd; stableLine++) {
            next.add(stableLine)
          }
        }
      }

      if (next.size > MAX_STABLE_LINE_CANDIDATES) {
        const sorted = Array.from(next).sort((a, b) => a - b)
        const trimmed = new Set<number>()
        const half = MAX_STABLE_LINE_CANDIDATES >> 1
        for (let j = 0; j < sorted.length && j < half; j++) trimmed.add(sorted[j])
        for (let j = Math.max(half, sorted.length - half); j < sorted.length; j++) trimmed.add(sorted[j])
        candidates = trimmed
      }
      else {
        candidates = next
      }
    }

    const result = Array.from(candidates)
    stableLineCandidatesCache.set(line, result)
    return result
  }

  const findStaleDepthAtCurrentColumn = (line: number, column: number): number | null => {
    if (lastStableBraceTokenVersion < 0) return null
    ensureStaleLookupCachesFresh()

    const cacheKey = `${line}:${column}`
    const cached = staleDepthByColumnCache.get(cacheKey)
    if (cached !== undefined) return cached

    const candidates = new Set<number>()
    const exactLine = mapCurrentLineToStableLine(line)
    if (exactLine !== null) candidates.add(exactLine)
    const approxLine = mapCurrentLineToStableLineApprox(line)
    if (approxLine !== null) candidates.add(approxLine)

    const expanded = getStableLineCandidatesForCurrentLine(line)
    for (let i = 0; i < expanded.length; i++) candidates.add(expanded[i])

    if (candidates.size === 0) candidates.add(line)

    const maxStableLine = Math.max(0, lastStableBraceCache.lineStartPositions.length - 2)
    for (const stableLineRaw of candidates) {
      const stableLine = Math.max(0, Math.min(stableLineRaw, maxStableLine))
      const pairEntry = findBracePairEntryAtPosition(lastStableBraceCache, stableLine, column)
      if (!pairEntry) continue
      const stableGlobalPos = (lastStableBraceCache.lineStartPositions[stableLine] ?? 0) + column
      if (stableGlobalPos === pairEntry.openStart || stableGlobalPos === pairEntry.closeStart) {
        staleDepthByColumnCache.set(cacheKey, pairEntry.depth)
        return pairEntry.depth
      }
    }

    staleDepthByColumnCache.set(cacheKey, null)
    return null
  }

  doc.onIncrementalChange(change => {
    if (change.source === 'reset') {
      if (braceRebuildTimer !== null) {
        clearTimeout(braceRebuildTimer)
        braceRebuildTimer = null
      }
      activeBraceWorkerJob = null
      queuedBraceWorkerTokenVersion = null
      const tokenVersion = doc.tokenVersion
      publishStableBraceCache(tokenVersion, buildBraceCache(doc.tokenLines, tokenVersion))
      return
    }
    if (change.source !== 'sync') return

    if (lastStableBraceTokenVersion === doc.tokenVersion) {
      resetPendingLineTransforms()
      return
    }

    const lineDelta = change.endLineAfter - change.endLineBefore
    if (lineDelta === 0) return

    pendingLineTransforms.push({
      startLine: change.startLine,
      endLineAfter: change.endLineAfter,
      lineDelta,
    })
    pendingLineTransformsVersion++
    clearStaleLookupCaches()

    if (pendingLineTransforms.length > MAX_PENDING_LINE_TRANSFORMS) {
      const excess = pendingLineTransforms.length - MAX_PENDING_LINE_TRANSFORMS
      pendingLineTransforms.splice(0, excess)
    }
  })

  const scheduleBraceRebuild = (tokenVersion: number) => {
    if (braceRebuildTimer !== null) {
      clearTimeout(braceRebuildTimer)
    }
    const debounceMs = getBraceCacheRebuildDebounceMs(doc.lines.length)
    braceRebuildTimer = setTimeout(() => {
      braceRebuildTimer = null
      if (doc.tokenVersion !== tokenVersion) return
      if (shouldUseBraceWorker()) {
        queuedBraceWorkerTokenVersion = tokenVersion
        flushQueuedBraceWorkerRebuild()
        return
      }
      publishStableBraceCache(tokenVersion, buildBraceCache(doc.tokenLines, tokenVersion))
    }, debounceMs)
  }

  effect(() => {
    const tokenVersion = doc.tokenVersion
    doc.tokenizationPending
    const keyHoldActive = doc.keyHoldActive

    if (lastStableBraceTokenVersion === tokenVersion) {
      if (braceRebuildTimer !== null) {
        clearTimeout(braceRebuildTimer)
        braceRebuildTimer = null
      }
      return
    }

    // Never start debounce while a key is held; wait for keyup idle.
    if (keyHoldActive) {
      if (braceRebuildTimer !== null) {
        clearTimeout(braceRebuildTimer)
        braceRebuildTimer = null
      }
      return
    }

    // Build the first snapshot eagerly so initial interactions stay correct.
    if (lastStableBraceTokenVersion < 0) {
      publishStableBraceCache(tokenVersion, buildBraceCache(doc.tokenLines, tokenVersion))
      return
    }

    // Coalesce rebuilds while typing; only publish when edits settle.
    scheduleBraceRebuild(tokenVersion)
  })

  const indentBlockRanges = computed(() => {
    return computeBlockRanges(doc.lines)
  })

  const blockRanges = computed(() => {
    const codeLines = doc.lines
    const indentRanges = indentBlockRanges.value
    // Avoid applying stale brace-derived ranges while edits are in flight; draw uses viewport-optimistic fallback then.
    debouncedBraceTokenVersion.value
    const canMergeBraceRanges = lastStableBraceTokenVersion >= 0 && lastStableBraceTokenVersion === doc.tokenVersion
    if (!canMergeBraceRanges) return indentRanges
    return mergeBraceMultilineBlockRanges(indentRanges, lastStableBraceCache, codeLines.length)
  })

  const blockStarts = computed(() => {
    return blockRanges.value.starts
  })

  const blockEnds = computed(() => {
    return blockRanges.value.ends
  })

  const blockNavigation = computed<BlockNavigationIndex>(() => {
    const starts = Array.from(blockStarts.value).sort((a, b) => a - b)
    const codeLines = doc.lines
    const endByStart = blockEnds.value
    const parentByStart = new Map<number, number | null>()
    const indentByStart = new Map<number, number>()
    const stack: number[] = []

    for (let i = 0; i < starts.length; i++) {
      const startLine = starts[i]
      const line = codeLines[startLine] ?? ''
      const indent = countIndent(line)
      indentByStart.set(startLine, indent)

      const endLine = endByStart.get(startLine)
      if (endLine === undefined || endLine < startLine) {
        parentByStart.set(startLine, null)
        continue
      }

      while (stack.length > 0) {
        const parentCandidate = stack[stack.length - 1]
        const parentCandidateEnd = endByStart.get(parentCandidate)
        if (parentCandidateEnd === undefined || parentCandidateEnd < startLine) {
          stack.pop()
          continue
        }
        break
      }

      parentByStart.set(startLine, stack.length > 0 ? stack[stack.length - 1] : null)
      stack.push(startLine)
    }

    return {
      sortedStarts: starts,
      parentByStart,
      indentByStart,
      endByStart,
    }
  })

  const braceCacheSnapshot = computed(() => {
    // Keep draw queries bound to the last published snapshot.
    // Rebuilds happen asynchronously (or debounced sync fallback) and publish through `publishStableBraceCache`.
    doc.tokenVersion
    debouncedBraceTokenVersion.value
    return lastStableBraceCache
  })

  const braceDepths = computed(() => {
    const cache = braceCacheSnapshot.value
    const { braces, matchedPairs } = cache
    const depths = new Map<number, number | null>()

    for (const pair of matchedPairs) {
      const openBrace = braces[pair.openIndex]
      if (openBrace.isOpening) {
        const existing = depths.get(openBrace.line)
        if (existing === undefined || existing === null || pair.depth < existing) {
          depths.set(openBrace.line, pair.depth)
        }
      }
    }

    return depths
  })

  const braceGlobalPos = computed(() => {
    const cache = braceCacheSnapshot.value
    const { lineLengths } = cache
    const globalPos = new Map<number, number>()
    let pos = 0
    let i = 0
    for (; i < lineLengths.length; i++) {
      globalPos.set(i, pos)
      pos += lineLengths[i] + 1
    }
    globalPos.set(i, pos)
    return globalPos
  })

  const braceDepthByLocation = computed(() => {
    const cache = braceCacheSnapshot.value
    const { braces, matchedPairs } = cache
    const depthByLocation = new Map<string, number>()

    for (const pair of matchedPairs) {
      const openBrace = braces[pair.openIndex]
      const closeBrace = braces[pair.closeIndex]
      depthByLocation.set(makeBraceLocationKey(openBrace.line, openBrace.tokenIndex, openBrace.charIndex), pair.depth)
      depthByLocation.set(makeBraceLocationKey(closeBrace.line, closeBrace.tokenIndex, closeBrace.charIndex), pair.depth)
    }

    return depthByLocation
  })

  const isCollapsed = (line: number): boolean => {
    return doc.collapsed.has(line)
  }

  const findNearestBlockStartAtOrBefore = (line: number): number | null => {
    if (line < 0 || line >= doc.lines.length) return null

    const { sortedStarts } = blockNavigation.value
    if (sortedStarts.length === 0) return null

    const index = upperBound(sortedStarts, line) - 1
    if (index < 0) return null
    return sortedStarts[index]
  }

  const findContainingBlockStart = (line: number): number | null => {
    if (line < 0 || line >= doc.lines.length) return null

    const { sortedStarts, endByStart, parentByStart } = blockNavigation.value
    if (sortedStarts.length === 0) return null

    const index = upperBound(sortedStarts, line) - 1
    if (index < 0) return null

    let current: number | null = sortedStarts[index]
    while (current !== null) {
      const endLine = endByStart.get(current)
      if (endLine !== undefined && line <= endLine) {
        return current
      }
      current = parentByStart.get(current) ?? null
    }

    return null
  }

  const getParentBlockStart = (startLine: number): number | null => {
    const { parentByStart } = blockNavigation.value
    if (!parentByStart.has(startLine)) return null
    return parentByStart.get(startLine) ?? null
  }

  const toggle = (line: number) => {
    const newCollapsed = new Set(doc.collapsed)
    if (newCollapsed.has(line)) {
      newCollapsed.delete(line)
    }
    else {
      newCollapsed.add(line)
    }
    doc.collapsed = newCollapsed
  }

  const expand = (line: number) => {
    const newCollapsed = new Set(doc.collapsed)
    newCollapsed.delete(line)
    doc.collapsed = newCollapsed
  }

  const collapse = (line: number) => {
    const newCollapsed = new Set(doc.collapsed)
    newCollapsed.add(line)
    doc.collapsed = newCollapsed
  }

  const adjustOnLineInsert = (insertedAt: number) => {
    const newCollapsed = new Set<number>()
    for (const line of doc.collapsed) {
      if (line >= insertedAt) {
        newCollapsed.add(line + 1)
      }
      else {
        newCollapsed.add(line)
      }
    }
    doc.collapsed = newCollapsed
  }

  const adjustOnLineInsertRange = (startLine: number, endLine: number) => {
    const insertedCount = endLine - startLine + 1
    const newCollapsed = new Set<number>()
    for (const line of doc.collapsed) {
      if (line >= startLine) {
        newCollapsed.add(line + insertedCount)
      }
      else {
        newCollapsed.add(line)
      }
    }
    doc.collapsed = newCollapsed
  }

  const adjustOnLineDelete = (deletedAt: number) => {
    const newCollapsed = new Set<number>()
    for (const line of doc.collapsed) {
      if (line > deletedAt) {
        newCollapsed.add(line - 1)
      }
      else if (line < deletedAt) {
        newCollapsed.add(line)
      }
    }
    doc.collapsed = newCollapsed
  }

  const adjustOnLineDeleteRange = (startLine: number, endLine: number) => {
    const deletedCount = endLine - startLine
    const newCollapsed = new Set<number>()
    for (const line of doc.collapsed) {
      if (line > endLine) {
        newCollapsed.add(line - deletedCount)
      }
      else if (line < startLine) {
        newCollapsed.add(line)
      }
    }
    doc.collapsed = newCollapsed
  }

  const getBraceDepthForPosition = (line: number, tokenIndex: number, charIndex: number): number | null => {
    if (lastStableBraceTokenVersion >= 0) {
      const lookupLine = lastStableBraceTokenVersion === doc.tokenVersion
        ? line
        : mapCurrentLineToStableLine(line)
      if (lookupLine !== null) {
        const depth = braceDepthByLocation.value.get(makeBraceLocationKey(lookupLine, tokenIndex, charIndex))
        if (depth !== undefined) return depth
      }

      if (lastStableBraceTokenVersion !== doc.tokenVersion) {
        const approxLine = mapCurrentLineToStableLineApprox(line)
        if (approxLine !== null) {
          const approxDepth = braceDepthByLocation.value.get(makeBraceLocationKey(approxLine, tokenIndex, charIndex))
          if (approxDepth !== undefined) return approxDepth
        }

        const column = getColumnFromTokenLocation(doc.tokenLines, line, tokenIndex, charIndex)
        const staleDepth = findStaleDepthAtCurrentColumn(line, column)
        if (staleDepth !== null) return staleDepth
      }
    }

    if (doc.tokenizationPending) {
      return getSameLineBraceDepthForPosition(doc.tokenLines, line, tokenIndex, charIndex)
    }

    if (lastStableBraceTokenVersion < 0) return null

    if (lastStableBraceTokenVersion !== doc.tokenVersion) {
      const column = getColumnFromTokenLocation(doc.tokenLines, line, tokenIndex, charIndex)
      const fromMatchAfter = findMatchingBrace(line, column + 1)
      if (fromMatchAfter) {
        const isOpen = fromMatchAfter.line === line
          && fromMatchAfter.tokenIndex === tokenIndex
          && fromMatchAfter.charIndex === charIndex
        const isClose = fromMatchAfter.matchingLine === line
          && fromMatchAfter.matchingTokenIndex === tokenIndex
          && fromMatchAfter.matchingCharIndex === charIndex
        if (isOpen || isClose) return fromMatchAfter.depth
      }

      const fromMatchAt = findMatchingBrace(line, column)
      if (fromMatchAt) {
        const isOpen = fromMatchAt.line === line
          && fromMatchAt.tokenIndex === tokenIndex
          && fromMatchAt.charIndex === charIndex
        const isClose = fromMatchAt.matchingLine === line
          && fromMatchAt.matchingTokenIndex === tokenIndex
          && fromMatchAt.matchingCharIndex === charIndex
        if (isOpen || isClose) return fromMatchAt.depth
      }

      return getSameLineBraceDepthForPosition(doc.tokenLines, line, tokenIndex, charIndex)
    }

    return null
  }

  const getBraceDepthForLine = (line: number): number | null => {
    if (lastStableBraceTokenVersion < 0 && doc.tokenizationPending) return null
    const lookupLine = lastStableBraceTokenVersion === doc.tokenVersion
      ? line
      : mapCurrentLineToStableLine(line)
    if (lookupLine !== null) return braceDepths.value.get(lookupLine) ?? null

    if (lastStableBraceTokenVersion !== doc.tokenVersion) {
      const approxLine = mapCurrentLineToStableLineApprox(line)
      if (approxLine !== null) {
        const approxDepth = braceDepths.value.get(approxLine)
        if (approxDepth !== undefined) return approxDepth
      }
    }

    return null
  }

  const getBraceGlobalPos = (brace: BraceInfo): number => {
    return (braceGlobalPos.value.get(brace.line) ?? 0) + brace.position
  }

  const mapStableMatchToCurrent = (stableMatch: CacheMatchingBrace): MatchingBrace => {
    const maxCurrentLine = Math.max(0, doc.lines.length - 1)
    const openLine = Math.max(0, Math.min(mapStableLineToCurrentLineApprox(stableMatch.line), maxCurrentLine))
    const closeLine = Math.max(
      0,
      Math.min(mapStableLineToCurrentLineApprox(stableMatch.matchingLine), maxCurrentLine),
    )

    const openExpectedChar = stableMatch.token.text[stableMatch.charIndex] ?? '{'
    const closeExpectedChar = stableMatch.matchingToken.text[stableMatch.matchingCharIndex] ?? '}'

    const resolvedOpen = resolveTokenLocationAtColumn(
      doc.tokenLines,
      openLine,
      stableMatch.openColumn,
      openExpectedChar,
    )
    const resolvedClose = resolveTokenLocationAtColumn(
      doc.tokenLines,
      closeLine,
      stableMatch.closeColumn,
      closeExpectedChar,
    )

    const openTokenIndex = resolvedOpen?.tokenIndex ?? stableMatch.tokenIndex
    const openCharIndex = resolvedOpen?.charIndex ?? stableMatch.charIndex
    const openToken = resolvedOpen?.token ?? doc.tokenLines[openLine]?.[openTokenIndex] ?? stableMatch.token

    const closeTokenIndex = resolvedClose?.tokenIndex ?? stableMatch.matchingTokenIndex
    const closeCharIndex = resolvedClose?.charIndex ?? stableMatch.matchingCharIndex
    const closeToken = resolvedClose?.token ?? doc.tokenLines[closeLine]?.[closeTokenIndex] ?? stableMatch.matchingToken

    return {
      line: openLine,
      tokenIndex: openTokenIndex,
      token: openToken,
      charIndex: openCharIndex,
      matchingLine: closeLine,
      matchingTokenIndex: closeTokenIndex,
      matchingToken: closeToken,
      matchingCharIndex: closeCharIndex,
      depth: stableMatch.depth,
    }
  }

  const debugBraceProbe = (cursorLine: number, cursorColumn: number) => {
    const staleAnalysis = lastStableBraceTokenVersion >= 0
      && lastStableBraceTokenVersion !== doc.tokenVersion
    const exactStableLine = staleAnalysis ? mapCurrentLineToStableLine(cursorLine) : null
    const approxStableLine = staleAnalysis ? mapCurrentLineToStableLineApprox(cursorLine) : null
    const candidateStableLines = staleAnalysis
      ? (() => {
        const candidates = new Set<number>()
        if (exactStableLine !== null) candidates.add(exactStableLine)
        if (approxStableLine !== null) candidates.add(approxStableLine)
        const expanded = getStableLineCandidatesForCurrentLine(cursorLine)
        for (let i = 0; i < expanded.length; i++) candidates.add(expanded[i])
        if (candidates.size === 0) candidates.add(cursorLine)
        const maxStableLine = Math.max(0, lastStableBraceCache.lineStartPositions.length - 2)
        const normalized = Array.from(candidates).map(line => Math.max(0, Math.min(line, maxStableLine)))
        normalized.sort((a, b) => a - b)
        return normalized
      })()
      : []

    let staleMatch: MatchingBrace | null = null
    if (staleAnalysis) {
      for (let i = 0; i < candidateStableLines.length; i++) {
        const stableLine = candidateStableLines[i]
        const match = findMatchingBraceInCache(lastStableBraceCache, stableLine, cursorColumn)
        if (!match) continue
        staleMatch = mapStableMatchToCurrent(match)
        break
      }
    }

    const sameLineFallback = findSameLineMatchingBraceFallback(doc.tokenLines, cursorLine, cursorColumn)
    const finalMatch = findMatchingBrace(cursorLine, cursorColumn)

    return {
      tokenVersion: doc.tokenVersion,
      braceAnalysisVersion: lastStableBraceTokenVersion,
      tokenizationPending: doc.tokenizationPending,
      keyHoldActive: doc.keyHoldActive,
      staleAnalysis,
      exactStableLine,
      approxStableLine,
      candidateStableLines,
      staleMatch,
      sameLineFallback,
      finalMatch,
    }
  }

  const findMatchingBrace = (
    cursorLine: number,
    cursorColumn: number,
  ): MatchingBrace | null => {
    const staleAnalysis = lastStableBraceTokenVersion >= 0
      && lastStableBraceTokenVersion !== doc.tokenVersion
    if (staleAnalysis) {
      ensureStaleLookupCachesFresh()
      const staleCacheKey = `${cursorLine}:${cursorColumn}`
      const staleCached = staleMatchingBraceCache.get(staleCacheKey)
      if (staleCached !== undefined) return staleCached

      const candidateLines = new Set<number>()
      const exactLine = mapCurrentLineToStableLine(cursorLine)
      if (exactLine !== null) candidateLines.add(exactLine)
      const approxLine = mapCurrentLineToStableLineApprox(cursorLine)
      if (approxLine !== null) candidateLines.add(approxLine)
      const expanded = getStableLineCandidatesForCurrentLine(cursorLine)
      for (let i = 0; i < expanded.length; i++) candidateLines.add(expanded[i])
      if (candidateLines.size === 0) candidateLines.add(cursorLine)

      const maxStableLine = Math.max(0, lastStableBraceCache.lineStartPositions.length - 2)
      for (const stableLineRaw of candidateLines) {
        const stableLine = Math.max(0, Math.min(stableLineRaw, maxStableLine))
        const stableMatch = findMatchingBraceInCache(lastStableBraceCache, stableLine, cursorColumn)
        if (!stableMatch) continue
        const mapped = mapStableMatchToCurrent(stableMatch)
        if (!isCursorInsideMatchingBraceRange(doc.tokenLines, mapped, cursorLine, cursorColumn)) continue
        staleMatchingBraceCache.set(staleCacheKey, mapped)
        return mapped
      }
      const fallback = findSameLineMatchingBraceFallback(doc.tokenLines, cursorLine, cursorColumn)
      if (fallback && !isCursorInsideMatchingBraceRange(doc.tokenLines, fallback, cursorLine, cursorColumn)) {
        staleMatchingBraceCache.set(staleCacheKey, null)
        return null
      }
      staleMatchingBraceCache.set(staleCacheKey, fallback)
      return fallback
    }

    if (doc.tokenizationPending) {
      return findSameLineMatchingBraceFallback(doc.tokenLines, cursorLine, cursorColumn)
    }

    const cacheKey = `${doc.tokenVersion}:${lastStableBraceTokenVersion}:${cursorLine}:${cursorColumn}`
    const cached = caches.matchingBraceCache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    const resolved = findMatchingBraceInCache(braceCacheSnapshot.value, cursorLine, cursorColumn)
    if (!resolved || !isCursorInsideMatchingBraceRange(doc.tokenLines, resolved, cursorLine, cursorColumn)) {
      caches.matchingBraceCache.set(cacheKey, null)
      return null
    }
    caches.matchingBraceCache.set(cacheKey, resolved)
    return resolved
  }

  const isBraceAnalysisCurrent = (): boolean => {
    return !doc.tokenizationPending && lastStableBraceTokenVersion === doc.tokenVersion
  }

  const getBraceAnalysisVersion = (): number => {
    return lastStableBraceTokenVersion
  }

  return {
    blockStarts,
    blockEnds,
    braceDepths,
    isCollapsed,
    toggle,
    expand,
    collapse,
    adjustOnLineInsert,
    adjustOnLineInsertRange,
    adjustOnLineDelete,
    adjustOnLineDeleteRange,
    findNearestBlockStartAtOrBefore,
    findContainingBlockStart,
    getParentBlockStart,
    findMatchingBrace,
    getBraceGlobalPos,
    getBraceDepthForPosition,
    getBraceDepthForLine,
    isBraceAnalysisCurrent,
    getBraceAnalysisVersion,
    debugBraceProbe,
  }
}
