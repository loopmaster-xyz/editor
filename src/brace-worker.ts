import type { Token } from './token.ts'

interface BraceInfo {
  char: string
  line: number
  tokenIndex: number
  token: Token
  charIndex: number
  position: number
  isOpening: boolean
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

interface BraceCache {
  braces: BraceInfo[]
  matchedPairs: { openIndex: number; closeIndex: number; depth: number }[]
  lineLengths: number[]
  lineStartPositions: number[]
  pairEntries: PairEntry[]
  coverageSegments: CoverageSegment[]
}

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

const openingBraces = new Set(['{', '(', '['])
const closingBraces = new Set(['}', ')', ']'])
const quoteChars = new Set(["'", '"', '`'])

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

function buildBraceCache(tokenLines: Token[][]): BraceCache {
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

  return { braces, matchedPairs, lineLengths, lineStartPositions, pairEntries, coverageSegments }
}

self.onmessage = (event: MessageEvent<BraceCacheRebuildRequestMessage>) => {
  const message = event.data
  if (!message || message.type !== 'braceCacheRebuild') return

  const response: BraceCacheRebuildResultMessage = {
    type: 'braceCacheRebuildResult',
    jobId: message.jobId,
    tokenVersion: message.tokenVersion,
    cache: buildBraceCache(message.tokenLines),
  }
  self.postMessage(response)
}
