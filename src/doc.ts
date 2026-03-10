import { batch, effect, untracked } from '@preact/signals-core'
import { debounce } from 'utils/debounce'
import { createBuffer, unpack } from './buffer.ts'
import { signalify } from './lib/signalify.ts'
import type { SelectionDirection } from './selection.ts'
import type { Token } from './token.ts'
import {
  defaultIncrementalTokenizer,
  isIncrementalTokenizer,
  tokenizeIncremental,
  tokenizeAll,
  type Tokenizer,
} from './tokenizer.ts'
import type { Widget } from './widget.ts'

/** Line and column are 1-based (LSP/editor convention). */
export type DocError = {
  x: [start: number, end: number]
  y: number
  message: string
}

export type Doc = ReturnType<typeof createDoc>

export interface DocIncrementalChange {
  revision: number
  source: 'sync' | 'deferred' | 'reset'
  startLine: number
  endLineBefore: number
  endLineAfter: number
  tokenProcessedStartLine: number
  tokenProcessedEndLine: number
  tokenConverged: boolean
}

type DocIncrementalChangeListener = (change: DocIncrementalChange) => void

type TokenizeChunkResultMessage = {
  type: 'tokenizeChunkResult'
  jobId: number
  revision: number
  startLine: number
  tokenLines: Token[][]
}

function countNewlines(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count++
  }
  return count
}

function lineFromIndexInLines(lines: string[], index: number): number {
  if (lines.length === 0) return 0
  let remaining = Math.max(0, index)
  for (let i = 0; i < lines.length; i++) {
    const lineLength = lines[i]?.length ?? 0
    if (remaining <= lineLength) return i
    remaining -= lineLength + 1
  }
  return Math.max(0, lines.length - 1)
}

function getSyncTokenizationBudget(lineCount: number): number {
  if (lineCount >= 100_000) return 32
  if (lineCount >= 50_000) return 64
  if (lineCount >= 20_000) return 128
  return Number.POSITIVE_INFINITY
}

const LEGACY_DEFERRED_TOKENIZE_DELAY_MS = 75
const BURST_DEFERRED_TOKENIZE_DELAY_MS = 40
const UNRESOLVED_SCAN_BUDGET_LINES = 4096

function createFallbackTokenLine(line: string): Token[] {
  if (line.length === 0) return []
  return [{ type: 'text', text: line }]
}

function tokensMatchLine(tokens: Token[] | undefined, line: string): boolean {
  if (!tokens) return false
  if (line.length === 0) return tokens.length === 0

  let offset = 0
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i]?.text ?? ''
    if (!line.startsWith(text, offset)) return false
    offset += text.length
  }
  return offset === line.length
}

function tokensEqual(a: Token[] | undefined, b: Token[]): boolean {
  if (!a) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const tokenA = a[i]
    const tokenB = b[i]
    if (!tokenA || !tokenB) return false
    if (tokenA.type !== tokenB.type || tokenA.text !== tokenB.text) return false
  }
  return true
}

function alignTokenSnapshotsForSpliceInPlace(
  tokenLines: Token[][],
  tokenStates: unknown[],
  nextLines: string[],
  startLine: number,
  endLineBefore: number,
  endLineAfter: number,
): boolean {
  const nextLineCount = nextLines.length
  const delta = endLineAfter - endLineBefore
  let changed = false

  if (delta > 0) {
    const insertCount = delta
    const insertAt = Math.max(0, Math.min(endLineBefore + 1, tokenLines.length))
    const tokenLinePlaceholders = new Array<Token[]>(insertCount)
    const tokenStatePlaceholders = new Array(insertCount) as unknown[]
    for (let i = 0; i < insertCount; i++) {
      tokenLinePlaceholders[i] = createFallbackTokenLine(nextLines[insertAt + i] ?? '')
      tokenStatePlaceholders[i] = undefined
    }
    tokenLines.splice(insertAt, 0, ...tokenLinePlaceholders)
    tokenStates.splice(insertAt, 0, ...tokenStatePlaceholders)
    changed = true
  }
  else if (delta < 0) {
    const removeAt = Math.max(0, Math.min(endLineAfter + 1, tokenLines.length))
    const removeCount = Math.min(-delta, Math.max(0, tokenLines.length - removeAt))
    if (removeCount > 0) {
      tokenLines.splice(removeAt, removeCount)
      tokenStates.splice(removeAt, removeCount)
      changed = true
    }
  }

  if (tokenLines.length > nextLineCount) {
    tokenLines.length = nextLineCount
    changed = true
  }
  if (tokenLines.length < nextLineCount) {
    const previousLength = tokenLines.length
    tokenLines.length = nextLineCount
    for (let i = previousLength; i < nextLineCount; i++) {
      tokenLines[i] = createFallbackTokenLine(nextLines[i] ?? '')
    }
    changed = true
  }

  if (tokenStates.length > nextLineCount) {
    tokenStates.length = nextLineCount
    changed = true
  }
  if (tokenStates.length < nextLineCount) {
    const previousLength = tokenStates.length
    tokenStates.length = nextLineCount
    for (let i = previousLength; i < nextLineCount; i++) {
      tokenStates[i] = undefined
    }
    changed = true
  }

  if (nextLineCount === 0) return changed

  const alignedStartLine = Math.max(0, Math.min(startLine, nextLineCount - 1))
  const alignedEndLine = Math.max(
    alignedStartLine,
    Math.min(Math.max(endLineAfter, startLine), nextLineCount - 1),
  )
  for (let line = alignedStartLine; line <= alignedEndLine; line++) {
    const nextLineText = nextLines[line] ?? ''
    const tokenLine = tokenLines[line]
    if (!tokensMatchLine(tokenLine, nextLineText)) {
      tokenLines[line] = createFallbackTokenLine(nextLineText)
      changed = true
    }
    if (tokenStates[line] !== undefined) {
      tokenStates[line] = undefined
      changed = true
    }
  }

  return changed
}

export function createDoc(tokenize: Tokenizer = defaultIncrementalTokenizer) {
  const buffer = createBuffer('')
  const incrementalChangeListeners = new Set<DocIncrementalChangeListener>()
  let revision = 0
  let deferredTokenizationTimer: ReturnType<typeof setTimeout> | null = null
  let pendingDeferredRange: { startLine: number; endLine: number } | null = null
  let tokenizerWorker: Worker | null = null
  let workerJobId = 0
  let activeWorkerJob: { jobId: number; startLine: number; endLine: number; revision: number } | null = null
  let firstUnresolvedTokenLine = -1
  let lastOptimisticViewportPass: {
    revision: number
    tokenVersion: number
    startLine: number
    endLine: number
  } | null = null

  const doc = signalify({
    epoch: 0,
    revision: 0,
    get code(): string {
      return buffer.code.value
    },
    set code(value: string) {
      buffer.code.value = value
    },
    buffer,
    onChange: buffer.onChange,
    caret: signalify({ line: 0, column: 0, columnIntent: 0 }),
    scroll: signalify({ x: 0, y: 0 }),
    collapsed: new Set<number>(),
    selection: signalify({
      start: signalify({ line: 0, column: 0 }),
      end: signalify({ line: 0, column: 0 }),
      direction: null as SelectionDirection | null,
    }),
    errors: [] as DocError[],
    widgets: [] as Widget[],
    tokenize,
    tokenLines: [] as Token[][],
    tokenStates: [] as unknown[],
    tokenVersion: 0,
    tokenizationPending: false,
    keyHoldActive: false,
    onIncrementalChange(listener: DocIncrementalChangeListener) {
      incrementalChangeListeners.add(listener)
      return () => incrementalChangeListeners.delete(listener)
    },
    get lines(): string[] {
      return buffer.lines.value
    },
    optimisticallyTokenizeViewport(startLine: number, endLine: number) {
      if (!isIncrementalTokenizer(doc.tokenize)) return false

      const lines = buffer.lines.value
      if (lines.length === 0) return false

      let clampedStartLine = Math.max(0, Math.min(startLine, lines.length - 1))
      let clampedEndLine = Math.max(0, Math.min(endLine, lines.length - 1))
      if (clampedEndLine < clampedStartLine) {
        const swap = clampedStartLine
        clampedStartLine = clampedEndLine
        clampedEndLine = swap
      }

      if (
        lastOptimisticViewportPass
        && lastOptimisticViewportPass.revision === doc.revision
        && lastOptimisticViewportPass.tokenVersion === doc.tokenVersion
        && lastOptimisticViewportPass.startLine <= clampedStartLine
        && lastOptimisticViewportPass.endLine >= clampedEndLine
      ) {
        return false
      }

      const processedStartLine = clampedStartLine
      const processedEndLine = clampedEndLine
      let tokenVisualChanged = false
      let hadUnresolvedState = false
      let prevState: unknown = null
      if (clampedStartLine > 0) {
        const stateBeforeRange = doc.tokenStates[clampedStartLine - 1]
        prevState = stateBeforeRange === undefined ? null : (stateBeforeRange ?? null)
      }

      for (let line = clampedStartLine; line <= clampedEndLine; line++) {
        if (doc.tokenStates[line] === undefined) hadUnresolvedState = true
        const result = doc.tokenize.tokenizeLine(lines[line] ?? '', line, prevState)
        if (!tokensEqual(doc.tokenLines[line], result.tokens)) {
          doc.tokenLines[line] = result.tokens
          tokenVisualChanged = true
        }
        prevState = result.state ?? null
      }

      if (hadUnresolvedState) {
        markUnresolvedFromLine(processedStartLine, lines)
      }

      const fullEndLine = Math.max(0, lines.length - 1)
      const needsCanonicalPass = tokenVisualChanged || hadUnresolvedState
      if (needsCanonicalPass) {
        if (pendingDeferredRange) {
          pendingDeferredRange.startLine = Math.min(pendingDeferredRange.startLine, processedStartLine)
          pendingDeferredRange.endLine = Math.max(pendingDeferredRange.endLine, fullEndLine)
        }
        else {
          pendingDeferredRange = {
            startLine: processedStartLine,
            endLine: fullEndLine,
          }
        }
        doc.tokenizationPending = true
      }

      if (tokenVisualChanged) {
        bumpTokenVersion()
        emitIncrementalChange({
          source: 'sync',
          startLine: processedStartLine,
          endLineBefore: processedEndLine,
          endLineAfter: processedEndLine,
          tokenProcessedStartLine: processedStartLine,
          tokenProcessedEndLine: processedEndLine,
          tokenConverged: false,
        })
      }

      lastOptimisticViewportPass = {
        revision: doc.revision,
        tokenVersion: doc.tokenVersion,
        startLine: clampedStartLine,
        endLine: clampedEndLine,
      }

      if (needsCanonicalPass) {
        queueDeferredTokenization()
      }
      return tokenVisualChanged
    },
    replace(index: number, length: number, text: string) {
      buffer.replace(index, length, text)
    },
  })

  const emitIncrementalChange = (change: Omit<DocIncrementalChange, 'revision'>) => {
    const payload: DocIncrementalChange = { revision, ...change }
    for (const listener of incrementalChangeListeners) {
      listener(payload)
    }
  }

  const bumpTokenVersion = () => {
    doc.tokenVersion++
  }

  const findNextUnresolvedTokenLine = (fromLine: number, lines: string[]) => {
    const startLine = Math.max(0, fromLine)
    const scanLimit = Math.min(lines.length, startLine + UNRESOLVED_SCAN_BUDGET_LINES)
    for (let line = startLine; line < scanLimit; line++) {
      if (doc.tokenLines[line] === undefined || doc.tokenStates[line] === undefined) return line
    }
    return scanLimit >= lines.length ? -1 : scanLimit
  }

  const markUnresolvedFromLine = (line: number, lines: string[]) => {
    if (lines.length === 0) {
      firstUnresolvedTokenLine = -1
      return
    }
    const clamped = Math.max(0, Math.min(line, lines.length - 1))
    if (firstUnresolvedTokenLine === -1 || clamped < firstUnresolvedTokenLine) {
      firstUnresolvedTokenLine = clamped
    }
  }

  const shiftUnresolvedLineForSplice = (
    startLine: number,
    endLineBefore: number,
    endLineAfter: number,
    lineCount: number,
  ) => {
    if (firstUnresolvedTokenLine < 0) return
    const delta = endLineAfter - endLineBefore
    if (delta === 0) return

    if (firstUnresolvedTokenLine > endLineBefore) {
      firstUnresolvedTokenLine += delta
    }
    else if (firstUnresolvedTokenLine >= startLine) {
      firstUnresolvedTokenLine = startLine
    }

    if (lineCount <= 0) {
      firstUnresolvedTokenLine = -1
      return
    }
    if (firstUnresolvedTokenLine < 0) firstUnresolvedTokenLine = 0
    if (firstUnresolvedTokenLine >= lineCount) firstUnresolvedTokenLine = lineCount - 1
  }

  const refreshFirstUnresolvedTokenLine = (
    processedEndLine: number,
    lines: string[],
  ) => {
    if (firstUnresolvedTokenLine >= lines.length) {
      firstUnresolvedTokenLine = -1
    }
    if (firstUnresolvedTokenLine >= 0 && processedEndLine >= firstUnresolvedTokenLine) {
      firstUnresolvedTokenLine = findNextUnresolvedTokenLine(firstUnresolvedTokenLine, lines)
    }
    return firstUnresolvedTokenLine
  }

  const shouldUseTokenizerWorker = () => {
    return typeof window !== 'undefined'
      && typeof Worker !== 'undefined'
      && doc.tokenize === defaultIncrementalTokenizer
      && buffer.lines.value.length >= 50_000
  }

  const ensureTokenizerWorker = () => {
    if (!shouldUseTokenizerWorker()) return null
    if (tokenizerWorker) return tokenizerWorker

    tokenizerWorker = new Worker(new URL('./tokenizer-worker.ts', import.meta.url), { type: 'module' })
    tokenizerWorker.onmessage = (event: MessageEvent<TokenizeChunkResultMessage>) => {
      const message = event.data
      if (!message || message.type !== 'tokenizeChunkResult') return
      if (!activeWorkerJob || activeWorkerJob.jobId !== message.jobId) return

      const job = activeWorkerJob
      activeWorkerJob = null

      if (message.revision !== doc.revision) {
        if (pendingDeferredRange) {
          pendingDeferredRange.startLine = Math.max(0, pendingDeferredRange.startLine)
        }
        return
      }

      const nextTokenLines = doc.tokenLines
      const nextTokenStates = doc.tokenStates
      const lines = buffer.lines.value
      let changed = false
      for (let i = 0; i < message.tokenLines.length; i++) {
        const line = message.startLine + i
        if (line >= nextTokenLines.length) break
        const nextLineTokens = message.tokenLines[i]
        if (nextTokenLines[line] !== nextLineTokens) {
          nextTokenLines[line] = nextLineTokens
          changed = true
        }
        if (nextTokenStates[line] !== null) {
          nextTokenStates[line] = null
          changed = true
        }
      }
      if (changed) bumpTokenVersion()

      if (pendingDeferredRange) {
        pendingDeferredRange.startLine = job.endLine + 1
      }

      const unresolvedStartLine = refreshFirstUnresolvedTokenLine(job.endLine, lines)
      if (unresolvedStartLine >= 0) {
        const endLine = Math.max(0, lines.length - 1)
        if (!pendingDeferredRange) {
          pendingDeferredRange = {
            startLine: unresolvedStartLine,
            endLine,
          }
        }
        else {
          pendingDeferredRange.startLine = Math.min(pendingDeferredRange.startLine, unresolvedStartLine)
          pendingDeferredRange.endLine = Math.max(pendingDeferredRange.endLine, endLine)
        }
      }

      const converged = (pendingDeferredRange === null || pendingDeferredRange.startLine > pendingDeferredRange.endLine)
        && unresolvedStartLine < 0

      emitIncrementalChange({
        source: 'deferred',
        startLine: job.startLine,
        endLineBefore: job.endLine,
        endLineAfter: job.endLine,
        tokenProcessedStartLine: job.startLine,
        tokenProcessedEndLine: job.endLine,
        tokenConverged: converged,
      })

      if (converged) {
        pendingDeferredRange = null
        doc.tokenizationPending = false
        return
      }

      if (pendingDeferredRange) {
        queueDeferredTokenization()
      }
      else {
        doc.tokenizationPending = false
      }
    }
    return tokenizerWorker
  }

  const queueDeferredTokenization = () => {
    if (!pendingDeferredRange) return

    if (doc.keyHoldActive) {
      if (deferredTokenizationTimer !== null) return
      deferredTokenizationTimer = setTimeout(() => {
        deferredTokenizationTimer = null
        if (!pendingDeferredRange) return
        queueDeferredTokenization()
      }, BURST_DEFERRED_TOKENIZE_DELAY_MS)
      return
    }

    if (!isIncrementalTokenizer(doc.tokenize)) {
      if (deferredTokenizationTimer !== null) {
        clearTimeout(deferredTokenizationTimer)
      }
      deferredTokenizationTimer = setTimeout(() => {
        deferredTokenizationTimer = null
        if (!pendingDeferredRange) return
        if (doc.keyHoldActive) {
          queueDeferredTokenization()
          return
        }

        const lines = buffer.lines.value
        const tokenLines = doc.tokenize(lines.join('\n'))
        doc.tokenLines = tokenLines
        doc.tokenStates = new Array(tokenLines.length).fill(null)
        firstUnresolvedTokenLine = -1
        bumpTokenVersion()
        pendingDeferredRange = null
        doc.tokenizationPending = false

        emitIncrementalChange({
          source: 'deferred',
          startLine: 0,
          endLineBefore: Math.max(0, lines.length - 1),
          endLineAfter: Math.max(0, lines.length - 1),
          tokenProcessedStartLine: 0,
          tokenProcessedEndLine: Math.max(0, tokenLines.length - 1),
          tokenConverged: true,
        })
      }, LEGACY_DEFERRED_TOKENIZE_DELAY_MS)
      return
    }

    if (shouldUseTokenizerWorker()) {
      const worker = ensureTokenizerWorker()
      if (!worker) return
      if (activeWorkerJob) return

      const lines = buffer.lines.value
      const startLine = Math.max(0, pendingDeferredRange.startLine)
      const endLine = Math.min(lines.length - 1, pendingDeferredRange.endLine, startLine + 2047)
      if (endLine < startLine) {
        pendingDeferredRange = null
        doc.tokenizationPending = false
        return
      }

      const linesChunk = lines.slice(startLine, endLine + 1)
      const jobId = ++workerJobId
      activeWorkerJob = { jobId, startLine, endLine, revision: doc.revision }
      worker.postMessage({
        type: 'tokenizeChunk',
        jobId,
        revision: doc.revision,
        startLine,
        lines: linesChunk,
      })
      return
    }

    if (deferredTokenizationTimer !== null) return
    deferredTokenizationTimer = setTimeout(() => {
      deferredTokenizationTimer = null
      if (!pendingDeferredRange) return
      if (doc.keyHoldActive) {
        queueDeferredTokenization()
        return
      }

      const lines = buffer.lines.value
      const startLine = Math.max(0, pendingDeferredRange.startLine)
      const endLine = Math.min(lines.length - 1, pendingDeferredRange.endLine)
      if (endLine < startLine) {
        pendingDeferredRange = null
        doc.tokenizationPending = false
        return
      }

      const tokenized = tokenizeIncremental(
        doc.tokenize,
        lines,
        doc.tokenLines,
        doc.tokenStates,
        startLine,
        endLine + 1,
        Math.max(512, getSyncTokenizationBudget(lines.length) * 8),
      )
      if (tokenized.changed) bumpTokenVersion()
      const unresolvedStartLine = refreshFirstUnresolvedTokenLine(
        tokenized.processedEndLine,
        lines,
      )
      const converged = tokenized.converged && unresolvedStartLine < 0
      const nextDeferredStartLine = unresolvedStartLine >= 0
        ? Math.min(Math.max(0, tokenized.processedEndLine + 1), unresolvedStartLine)
        : Math.max(0, tokenized.processedEndLine + 1)
      emitIncrementalChange({
        source: 'deferred',
        startLine,
        endLineBefore: endLine,
        endLineAfter: endLine,
        tokenProcessedStartLine: tokenized.processedStartLine,
        tokenProcessedEndLine: tokenized.processedEndLine,
        tokenConverged: converged,
      })

      if (converged) {
        pendingDeferredRange = null
        doc.tokenizationPending = false
        return
      }

      pendingDeferredRange.startLine = nextDeferredStartLine
      if (pendingDeferredRange.startLine > pendingDeferredRange.endLine) {
        pendingDeferredRange = null
        doc.tokenizationPending = false
        return
      }

      queueDeferredTokenization()
    }, 0)
  }

  const applyTokenization = (
    source: 'sync' | 'deferred' | 'reset',
    startLine: number,
    endLineBefore: number,
    endLineAfter: number,
    maxLines = Number.POSITIVE_INFINITY,
    linesOverride?: string[],
    prealignedChanged = false,
  ) => {
    const currentLines = linesOverride ?? buffer.lines.value
    if (source === 'reset') {
      pendingDeferredRange = null
      if (deferredTokenizationTimer !== null) {
        clearTimeout(deferredTokenizationTimer)
        deferredTokenizationTimer = null
      }
      activeWorkerJob = null
      const full = tokenizeAll(doc.tokenize, currentLines)
      doc.tokenLines = full.tokenLines
      doc.tokenStates = full.states
      firstUnresolvedTokenLine = -1
      bumpTokenVersion()
      doc.tokenizationPending = false
      emitIncrementalChange({
        source,
        startLine: 0,
        endLineBefore,
        endLineAfter,
        tokenProcessedStartLine: 0,
        tokenProcessedEndLine: Math.max(0, full.tokenLines.length - 1),
        tokenConverged: true,
      })
      return
    }

    if (!isIncrementalTokenizer(doc.tokenize)) {
      const nextTokenLines = doc.tokenLines
      const nextTokenStates = doc.tokenStates
      let changed = prealignedChanged

      if (nextTokenLines.length > currentLines.length) {
        nextTokenLines.length = currentLines.length
        changed = true
      }
      if (nextTokenStates.length > currentLines.length) {
        nextTokenStates.length = currentLines.length
        changed = true
      }
      for (let i = nextTokenLines.length; i < currentLines.length; i++) {
        nextTokenLines[i] = createFallbackTokenLine(currentLines[i] ?? '')
        changed = true
      }
      for (let i = nextTokenStates.length; i < currentLines.length; i++) {
        nextTokenStates[i] = undefined
        changed = true
      }
      if (currentLines.length > 0) {
        const alignedStartLine = Math.max(0, Math.min(startLine, currentLines.length - 1))
        const alignedEndLine = Math.max(
          alignedStartLine,
          Math.min(Math.max(endLineAfter, startLine), currentLines.length - 1),
        )
        for (let line = alignedStartLine; line <= alignedEndLine; line++) {
          const lineText = currentLines[line] ?? ''
          if (!tokensMatchLine(nextTokenLines[line], lineText)) {
            nextTokenLines[line] = createFallbackTokenLine(lineText)
            changed = true
          }
          if (nextTokenStates[line] !== undefined) {
            nextTokenStates[line] = undefined
            changed = true
          }
        }
      }
      if (changed) bumpTokenVersion()
      firstUnresolvedTokenLine = currentLines.length > 0 ? 0 : -1
      doc.tokenizationPending = true

      emitIncrementalChange({
        source,
        startLine,
        endLineBefore,
        endLineAfter,
        tokenProcessedStartLine: Math.max(0, startLine),
        tokenProcessedEndLine: Math.max(0, Math.max(endLineBefore, endLineAfter)),
        tokenConverged: false,
      })

      pendingDeferredRange = {
        startLine: 0,
        endLine: Math.max(0, currentLines.length - 1),
      }
      queueDeferredTokenization()
      return
    }

    if (source === 'sync' && doc.keyHoldActive) {
      const hasLines = currentLines.length > 0
      firstUnresolvedTokenLine = currentLines.length > 0
        ? Math.max(0, Math.min(startLine, currentLines.length - 1))
        : -1
      doc.tokenizationPending = hasLines
      if (prealignedChanged) bumpTokenVersion()

      emitIncrementalChange({
        source,
        startLine,
        endLineBefore,
        endLineAfter,
        tokenProcessedStartLine: Math.max(0, startLine),
        tokenProcessedEndLine: Math.max(0, Math.max(endLineBefore, endLineAfter)),
        tokenConverged: !hasLines,
      })

      if (hasLines) {
        const rangeStart = Math.max(0, Math.min(startLine, currentLines.length - 1))
        const rangeEnd = Math.max(0, currentLines.length - 1)
        if (pendingDeferredRange) {
          pendingDeferredRange.startLine = Math.min(pendingDeferredRange.startLine, rangeStart)
          pendingDeferredRange.endLine = Math.max(pendingDeferredRange.endLine, rangeEnd)
        }
        else {
          pendingDeferredRange = {
            startLine: rangeStart,
            endLine: rangeEnd,
          }
        }
        queueDeferredTokenization()
      }
      return
    }

    const tokenized = tokenizeIncremental(
      doc.tokenize,
      currentLines,
      doc.tokenLines,
      doc.tokenStates,
      Math.max(0, startLine),
      Math.max(endLineBefore, endLineAfter) + 1,
      maxLines,
    )
    if (tokenized.changed || prealignedChanged) bumpTokenVersion()
    const unresolvedStartLine = refreshFirstUnresolvedTokenLine(
      tokenized.processedEndLine,
      currentLines,
    )
    const converged = tokenized.converged && unresolvedStartLine < 0
    const nextDeferredStartLine = unresolvedStartLine >= 0
      ? Math.min(Math.max(0, tokenized.processedEndLine + 1), unresolvedStartLine)
      : Math.max(0, tokenized.processedEndLine + 1)
    doc.tokenizationPending = !converged

    emitIncrementalChange({
      source,
      startLine,
      endLineBefore,
      endLineAfter,
      tokenProcessedStartLine: tokenized.processedStartLine,
      tokenProcessedEndLine: tokenized.processedEndLine,
      tokenConverged: converged,
    })

    if (!converged) {
      pendingDeferredRange = {
        startLine: nextDeferredStartLine,
        endLine: Math.max(0, currentLines.length - 1),
      }
      doc.tokenizationPending = true
      queueDeferredTokenization()
    }
  }

  // Initial tokenization snapshot.
  const initial = tokenizeAll(doc.tokenize, buffer.lines.value)
  doc.tokenLines = initial.tokenLines
  doc.tokenStates = initial.states
  firstUnresolvedTokenLine = -1
  bumpTokenVersion()

  buffer.onChange(change => {
    revision++
    doc.revision = revision

    if (change.type === 'reset') {
      const nextLines = change.nextCode.split('\n')
      applyTokenization('reset', 0, 0, Math.max(0, nextLines.length - 1), Number.POSITIVE_INFINITY, nextLines)
      return
    }

    const deletedLineCount = countNewlines(change.deletedText)
    const insertedLineCount = countNewlines(change.insertedText)
    const nextLines = buffer.lines.value
    const lineCount = nextLines.length
    const maxLine = Math.max(0, lineCount - 1)
    let startLine: number

    if (change.startLine !== undefined) {
      startLine = Math.max(0, Math.min(change.startLine, maxLine))
    }
    else {
      startLine = lineFromIndexInLines(nextLines, change.start)
    }

    const endLineBefore = startLine + deletedLineCount
    const endLineAfter = startLine + insertedLineCount
    shiftUnresolvedLineForSplice(startLine, endLineBefore, endLineAfter, lineCount)
    const snapshotsAligned = alignTokenSnapshotsForSpliceInPlace(
      doc.tokenLines,
      doc.tokenStates,
      nextLines,
      startLine,
      endLineBefore,
      endLineAfter,
    )
    if (snapshotsAligned) {
      markUnresolvedFromLine(startLine, nextLines)
    }

    applyTokenization(
      'sync',
      startLine,
      endLineBefore,
      endLineAfter,
      getSyncTokenizationBudget(lineCount),
      undefined,
      snapshotsAligned,
    )
  })

  effect(() => {
    buffer.lines.value
    untracked(() => doc.epoch++)
  })
  return doc
}

const debouncedSetItem = debounce(50, (key: string, json: () => unknown) => {
  localStorage.setItem(key, JSON.stringify(json()))
})

function persist<T extends Record<string, unknown>>(
  key: string,
  watch: () => void,
  json: () => T,
  read: (data: Partial<T>) => void,
) {
  untracked(() => batch(() => read(JSON.parse(localStorage.getItem(key) || '{}'))))
  effect(() => {
    watch()
    debouncedSetItem(key, json)
  })
}

export function createPersistedDoc(key: string, tokenize: Tokenizer = defaultIncrementalTokenizer,
  doc: Doc = createDoc(tokenize))
{
  persist(key, () => {
    doc.code
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
