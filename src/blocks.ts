import { computed } from '@preact/signals-core'
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

const openingBraces = new Set(['{', '(', '['])
const closingBraces = new Set(['}', ')', ']'])
const quoteChars = new Set(["'", '"', '`'])

const braceCache = new WeakMap<Token[][], BraceCache>()

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

function buildBraceCache(tokenLines: Token[][]): BraceCache {
  const existing = braceCache.get(tokenLines)
  if (existing) return existing

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

  const events = new Map<number, { add: number[]; remove: number[] }>()
  const getOrCreateEvents = (pos: number) => {
    let event = events.get(pos)
    if (!event) {
      event = { add: [], remove: [] }
      events.set(pos, event)
    }
    return event
  }

  for (let i = 0; i < pairEntries.length; i++) {
    const pairEntry = pairEntries[i]
    getOrCreateEvents(pairEntry.openStart).add.push(i)
    getOrCreateEvents(pairEntry.closeEnd + 1).remove.push(i)
  }

  const eventPositions = Array.from(events.keys()).sort((a, b) => a - b)
  const active = new Array<boolean>(pairEntries.length).fill(false)
  const heap: number[] = []
  const coverageSegments: CoverageSegment[] = []

  for (let i = 0; i < eventPositions.length; i++) {
    const pos = eventPositions[i]
    const event = events.get(pos)
    if (!event) continue

    for (const pairIndex of event.remove) {
      active[pairIndex] = false
    }
    for (const pairIndex of event.add) {
      active[pairIndex] = true
      pushMinHeap(heap, pairIndex, pairEntries)
    }

    const nextPos = eventPositions[i + 1]
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
  braceCache.set(tokenLines, cache)
  return cache
}

function detectBlockStart(codeLines: string[], lineIndex: number): boolean {
  if (lineIndex >= codeLines.length) return false
  const line = codeLines[lineIndex]
  const trimmed = line.trim()
  if (trimmed.length === 0) return false

  const nextLineIndex = lineIndex + 1
  if (nextLineIndex >= codeLines.length) return false
  const nextLine = codeLines[nextLineIndex]
  if (nextLine.trim().length === 0) return false

  const currentIndent = line.length - line.trimStart().length
  const nextIndent = nextLine.length - nextLine.trimStart().length

  return nextIndent > currentIndent
}

function findBlockEnd(codeLines: string[], startLine: number): number {
  const startLineContent = codeLines[startLine]
  const startIndent = startLineContent.length - startLineContent.trimStart().length

  for (let i = startLine + 1; i < codeLines.length; i++) {
    const line = codeLines[i]
    const indent = line.length - line.trimStart().length
    if (line.trim().length > 0 && indent <= startIndent) {
      return i - 1
    }
  }

  return codeLines.length - 1
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

export function createBlocks(doc: Doc, caches: Caches) {
  const blockStarts = computed(() => {
    const codeLines = doc.lines
    const starts = new Set<number>()
    for (let i = 0; i < codeLines.length; i++) {
      if (detectBlockStart(codeLines, i)) {
        starts.add(i)
      }
    }
    return starts
  })

  const blockEnds = computed(() => {
    const codeLines = doc.lines
    const starts = blockStarts.value
    const ends = new Map<number, number>()
    for (const startLine of starts) {
      ends.set(startLine, findBlockEnd(codeLines, startLine))
    }
    return ends
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
      const indent = line.length - line.trimStart().length
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

  const braceDepths = computed(() => {
    const tokenLines = doc.tokenLines
    const cache = buildBraceCache(tokenLines)
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
    const tokenLines = doc.tokenLines
    const cache = buildBraceCache(tokenLines)
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
    const tokenLines = doc.tokenLines
    const cache = buildBraceCache(tokenLines)
    const { braces, matchedPairs } = cache

    let column = 0
    const lineTokens = tokenLines[line] || []
    for (let i = 0; i < tokenIndex && i < lineTokens.length; i++) {
      column += lineTokens[i]?.text.length || 0
    }
    column += charIndex

    for (const pair of matchedPairs) {
      const openBrace = braces[pair.openIndex]
      const closeBrace = braces[pair.closeIndex]

      if (openBrace.line === line && openBrace.tokenIndex === tokenIndex && openBrace.charIndex === charIndex) {
        return pair.depth
      }
      if (closeBrace.line === line && closeBrace.tokenIndex === tokenIndex && closeBrace.charIndex === charIndex) {
        return pair.depth
      }
    }

    return null
  }

  const getBraceGlobalPos = (brace: BraceInfo): number => {
    return (braceGlobalPos.value.get(brace.line) ?? 0) + brace.position
  }

  const findMatchingBrace = (
    cursorLine: number,
    cursorColumn: number,
  ): MatchingBrace | null => {
    const cacheKey = `${cursorLine}:${cursorColumn}`
    const cached = caches.matchingBraceCache.get(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    const tokenLines = doc.tokenLines
    const cache = buildBraceCache(tokenLines)
    const { braces, pairEntries, coverageSegments, lineStartPositions } = cache

    if (braces.length === 0 || pairEntries.length === 0 || coverageSegments.length === 0) {
      caches.matchingBraceCache.set(cacheKey, null)
      return null
    }

    const clampedCursorLine = Math.max(0, Math.min(cursorLine, lineStartPositions.length - 1))
    const cursorGlobalPos = (lineStartPositions[clampedCursorLine] ?? 0) + cursorColumn
    const coverageSegment = findCoverageSegment(coverageSegments, cursorGlobalPos)
    if (!coverageSegment) {
      caches.matchingBraceCache.set(cacheKey, null)
      return null
    }

    const pairEntry = pairEntries[coverageSegment.pairEntryIndex]
    const openBrace = braces[pairEntry.openIndex]
    const closeBrace = braces[pairEntry.closeIndex]

    const result: MatchingBrace = {
      line: openBrace.line,
      tokenIndex: openBrace.tokenIndex,
      token: openBrace.token,
      charIndex: openBrace.charIndex,
      matchingLine: closeBrace.line,
      matchingTokenIndex: closeBrace.tokenIndex,
      matchingToken: closeBrace.token,
      matchingCharIndex: closeBrace.charIndex,
      depth: pairEntry.depth,
    }

    caches.matchingBraceCache.set(cacheKey, result)
    return result
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
  }
}
