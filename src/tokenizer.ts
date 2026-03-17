import type { Token } from './token.ts'

export type TokenizerLegacy = (code: string) => Token[][]

export interface IncrementalTokenizeLineResult {
  tokens: Token[]
  state?: unknown
}

export interface IncrementalTokenizerWorkerRequest {
  type: 'tokenizeChunk'
  jobId: number
  revision: number
  startLine: number
  lines: string[]
  prevState: unknown
}

export interface IncrementalTokenizerWorkerResponse {
  type: 'tokenizeChunkResult'
  jobId: number
  revision: number
  startLine: number
  tokenLines: Token[][]
  states: unknown[]
  processedEndLine: number
}

export interface IncrementalTokenizer {
  tokenizeLine: (line: string, lineIndex: number, prevState: unknown) => IncrementalTokenizeLineResult
  createWorker?: () => Worker
  settleDelayMs?: number
  workerChunkLines?: number
  workerMinLineCount?: number
}

export interface IncrementalTokenizeResult {
  tokenLines: Token[][]
  states: unknown[]
  processedStartLine: number
  processedEndLine: number
  converged: boolean
  changed: boolean
}

export type Tokenizer = TokenizerLegacy | IncrementalTokenizer

const warnedLegacyTokenizers = new WeakSet<TokenizerLegacy>()

export function isIncrementalTokenizer(tokenizer: Tokenizer): tokenizer is IncrementalTokenizer {
  return typeof tokenizer !== 'function' && typeof tokenizer.tokenizeLine === 'function'
}

export function annotateTokenLinePositions(tokens: Token[], lineIndex: number): Token[] {
  let column = 1
  const line = lineIndex + 1

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    token.line = line
    token.column = column
    column += token.text.length
  }

  return tokens
}

function areStatesStructurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!areStatesStructurallyEqual(a[i], b[i])) return false
    }
    return true
  }

  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (let i = 0; i < leftKeys.length; i++) {
    const key = leftKeys[i]!
    if (!(key in right)) return false
    if (!areStatesStructurallyEqual(left[key], right[key])) return false
  }
  return true
}

export function annotateTokenLines(tokenLines: Token[][]): Token[][] {
  for (let lineIndex = 0; lineIndex < tokenLines.length; lineIndex++) {
    annotateTokenLinePositions(tokenLines[lineIndex] ?? [], lineIndex)
  }
  return tokenLines
}

function tokenizeLineWithRegex(line: string): Token[] {
  return [...line.matchAll(/\s+|.+/g)]
    .filter(x => x[0] !== '')
    .map(text => ({ text: text[0], type: 'text' as const }))
}

function areTokensEqual(a: Token[] | undefined, b: Token[]): boolean {
  if (!a) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text || a[i].type !== b[i].type) return false
  }
  return true
}

export function tokenizeAll(tokenizer: Tokenizer, lines: string[]): { tokenLines: Token[][]; states: unknown[] } {
  if (isIncrementalTokenizer(tokenizer)) {
    const tokenLines: Token[][] = new Array(lines.length)
    const states: unknown[] = new Array(lines.length)
    let prevState: unknown = null
    for (let i = 0; i < lines.length; i++) {
      const result = tokenizer.tokenizeLine(lines[i] ?? '', i, prevState)
      const state = result.state ?? null
      tokenLines[i] = annotateTokenLinePositions(result.tokens, i)
      states[i] = state
      prevState = state
    }
    return { tokenLines, states }
  }

  const code = lines.join('\n')
  const tokenLines = annotateTokenLines(tokenizer(code))
  return {
    tokenLines,
    states: new Array(tokenLines.length).fill(null),
  }
}

export function tokenizeIncremental(
  tokenizer: Tokenizer,
  lines: string[],
  prevTokenLines: Token[][],
  prevStates: unknown[],
  startLine: number,
  endLine: number,
  maxLines = Number.POSITIVE_INFINITY,
): IncrementalTokenizeResult {
  if (!isIncrementalTokenizer(tokenizer)) {
    if (!warnedLegacyTokenizers.has(tokenizer)) {
      warnedLegacyTokenizers.add(tokenizer)
      console.warn('[editor] Legacy tokenize(code) adapter path in use. Migrate to incremental tokenizeLine API for 100k-scale performance.')
    }
    const tokenLines = tokenizer(lines.join('\n'))
    return {
      tokenLines,
      states: new Array(tokenLines.length).fill(null),
      processedStartLine: 0,
      processedEndLine: Math.max(0, tokenLines.length - 1),
      converged: true,
      changed: true,
    }
  }

  const nextTokenLines = prevTokenLines
  const nextStates = prevStates
  const prevLength = nextTokenLines.length
  nextTokenLines.length = lines.length
  nextStates.length = lines.length
  for (let i = prevLength; i < lines.length; i++) {
    nextTokenLines[i] = []
    nextStates[i] = undefined
  }

  let line = Math.max(0, startLine)
  const targetEnd = Math.max(line, endLine)
  let processed = 0
  let converged = false
  let anyChanged = false
  const processedStartLine = line
  let prevState = line > 0 ? (nextStates[line - 1] ?? null) : null

  while (line < lines.length && processed < maxLines) {
    const result = tokenizer.tokenizeLine(lines[line] ?? '', line, prevState)
    const nextTokens = annotateTokenLinePositions(result.tokens, line)
    const rawState = result.state ?? null
    const previousState = nextStates[line]
    const state = (previousState !== undefined && areStatesStructurallyEqual(previousState, rawState))
      ? previousState
      : rawState
    const tokensChanged = !areTokensEqual(nextTokenLines[line], nextTokens)
    const stateChanged = nextStates[line] !== state
    const changed = tokensChanged || stateChanged

    // Preserve token/state references when nothing changed so downstream
    // incremental layout can reuse by identity and avoid broad recomputation.
    if (tokensChanged) nextTokenLines[line] = nextTokens
    if (stateChanged) nextStates[line] = state
    if (changed) anyChanged = true
    prevState = state

    processed++
    line++

    if (line > targetEnd && !changed) {
      converged = true
      break
    }
  }

  if (!converged && line >= lines.length) converged = true

  return {
    tokenLines: nextTokenLines,
    states: nextStates,
    processedStartLine,
    processedEndLine: Math.max(processedStartLine, line - 1),
    converged,
    changed: anyChanged,
  }
}

export const defaultIncrementalTokenizer: IncrementalTokenizer = {
  tokenizeLine(line: string, lineIndex: number): IncrementalTokenizeLineResult {
    return { tokens: annotateTokenLinePositions(tokenizeLineWithRegex(line), lineIndex), state: null }
  },
  createWorker: () => new Worker(new URL('./tokenizer-worker.ts', import.meta.url), { type: 'module' }),
  workerChunkLines: 2048,
  workerMinLineCount: 50_000,
}

export function tokenize(code: string): Token[][] {
  return code.split('\n').map((line, lineIndex) => annotateTokenLinePositions(tokenizeLineWithRegex(line), lineIndex))
}
