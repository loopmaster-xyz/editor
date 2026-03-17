import { batch, effect, untracked } from '@preact/signals-core'
import { debounce } from 'utils/debounce'
import { createBuffer, unpack } from './buffer.ts'
import { signalify } from './lib/signalify.ts'
import type { SelectionDirection } from './selection.ts'
import type { Token } from './token.ts'
import {
  annotateTokenLinePositions,
  annotateTokenLines,
  defaultIncrementalTokenizer,
  isIncrementalTokenizer,
  tokenizeAll,
  tokenizeIncremental,
  type IncrementalTokenizerWorkerRequest,
  type IncrementalTokenizerWorkerResponse,
  type Tokenizer,
  type TokenizerLegacy,
} from './tokenizer.ts'
import { adjustWidgetsForSplice, type Widget } from './widget.ts'

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

function countNewlines(text: string): number {
  const firstBreak = text.indexOf('\n')
  if (firstBreak < 0) return 0

  let count = 1
  for (let i = firstBreak + 1; i < text.length; i++) {
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

type CachedSpliceStart = {
  index: number
  line: number
  at: number
}

function resolveSpliceStartLine(
  lines: string[],
  maxLine: number,
  start: number,
  now: number,
  startLine: number | undefined,
  cachedSpliceStart: CachedSpliceStart | null,
): { line: number; cache: CachedSpliceStart } {
  if (startLine !== undefined) {
    const line = Math.max(0, Math.min(startLine, maxLine))
    return {
      line,
      cache: { index: start, line, at: now },
    }
  }

  if (
    cachedSpliceStart
    && cachedSpliceStart.index === start
    && (now - cachedSpliceStart.at) <= CACHED_SPLICE_START_WINDOW_MS
  ) {
    const line = Math.max(0, Math.min(cachedSpliceStart.line, maxLine))
    return {
      line,
      cache: { index: start, line, at: now },
    }
  }

  const line = lineFromIndexInLines(lines, start)
  return {
    line,
    cache: { index: start, line, at: now },
  }
}

function getSyncTokenizationBudget(lineCount: number): number {
  if (lineCount >= 100_000) return 32
  if (lineCount >= 50_000) return 64
  if (lineCount >= 20_000) return 128
  return Number.POSITIVE_INFINITY
}

const LEGACY_DEFERRED_TOKENIZE_DELAY_MS = 75
const BURST_DEFERRED_TOKENIZE_DELAY_MS = 120
const UNRESOLVED_SCAN_BUDGET_LINES = 4096
const ALIGN_DIRECT_FALLBACK_THRESHOLD_LINES = 256
const ALIGN_SYNC_SCAN_LIMIT_LINES = 320
const SYNC_INCREMENTAL_EMIT_THROTTLE_MS = 16
const SYNC_INCREMENTAL_EMIT_HEAVY_THROTTLE_MS = 24
const SYNC_INCREMENTAL_EMIT_HOLD_THROTTLE_MS = 32
const SYNC_INCREMENTAL_HEAVY_LINE_THRESHOLD = 128
const SYNC_INCREMENTAL_LAYOUT_PATCH_BUDGET_LINES = 96
const SYNC_INCREMENTAL_KEYHOLD_HOT_TOKENIZE_LINES = 2
// Keep medium/large pastes as a bounded changed span without penalizing normal typing.
const SYNC_INCREMENTAL_LAYOUT_PATCH_BUDGET_PASTE_LINES = 2048
const BURST_SYNC_TOKENIZATION_LINE_THRESHOLD = 16
const BURST_SYNC_TOKENIZATION_CHAR_THRESHOLD = 2048
const FAST_SNAPSHOT_INVALIDATE_CHAR_THRESHOLD = 8192
const DEFERRED_TOKENIZE_SLICE_DELAY_MS = 8
const CACHED_SPLICE_START_WINDOW_MS = 64
const LEGACY_SYNC_TOKENIZE_MAX_LINES = 4000
const LEGACY_SYNC_TOKENIZE_MAX_CHARS = 200_000
const EMPTY_TOKEN_LINE: Token[] = []

function getTokenizerSettleDelayMs(tokenizer: Tokenizer): number {
  if (!isIncrementalTokenizer(tokenizer)) return DEFERRED_TOKENIZE_SLICE_DELAY_MS
  return Math.max(0, tokenizer.settleDelayMs ?? DEFERRED_TOKENIZE_SLICE_DELAY_MS)
}

function getTokenizerWorkerChunkLines(tokenizer: Tokenizer): number {
  if (!isIncrementalTokenizer(tokenizer)) return 2048
  return Math.max(1, tokenizer.workerChunkLines ?? 2048)
}

function getTokenizerWorkerMinLineCount(tokenizer: Tokenizer): number {
  if (!isIncrementalTokenizer(tokenizer)) return Number.POSITIVE_INFINITY
  return Math.max(0, tokenizer.workerMinLineCount ?? Number.POSITIVE_INFINITY)
}

function createFallbackTokenLine(line: string): Token[] {
  if (line.length === 0) return []
  return [{ type: 'text', text: line }]
}

function getApproxCodeLength(lines: string[]): number {
  if (lines.length === 0) return 0
  let length = lines.length - 1
  for (let i = 0; i < lines.length; i++) {
    length += lines[i]?.length ?? 0
  }
  return length
}

function tokensMatchLine(tokens: Token[] | undefined, line: string): boolean {
  if (!tokens) return false
  if (tokens.length === 1) {
    const token = tokens[0]
    if (token?.type === 'text') return (token.text ?? '') === line
  }
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

function reconcileLegacyTokenizationInPlace(
  prevTokenLines: Token[][],
  prevStates: unknown[],
  nextTokenLines: Token[][],
  nextLineCount: number,
): boolean {
  let changed = false

  if (prevTokenLines.length > nextLineCount) {
    prevTokenLines.length = nextLineCount
    changed = true
  }
  if (prevStates.length > nextLineCount) {
    prevStates.length = nextLineCount
    changed = true
  }

  for (let i = 0; i < nextLineCount; i++) {
    const nextLineTokens = nextTokenLines[i] ?? EMPTY_TOKEN_LINE
    if (!tokensEqual(prevTokenLines[i], nextLineTokens)) {
      prevTokenLines[i] = nextLineTokens
      changed = true
    }
    else if (prevTokenLines[i] === undefined) {
      prevTokenLines[i] = nextLineTokens
      changed = true
    }

    if (prevStates[i] !== null) {
      prevStates[i] = null
      changed = true
    }
  }

  for (let i = prevTokenLines.length; i < nextLineCount; i++) {
    prevTokenLines[i] = nextTokenLines[i] ?? EMPTY_TOKEN_LINE
    changed = true
  }
  for (let i = prevStates.length; i < nextLineCount; i++) {
    prevStates[i] = null
    changed = true
  }

  return changed
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
    const tokenLinePlaceholders = new Array<Token[]>(insertCount).fill(EMPTY_TOKEN_LINE)
    const tokenStatePlaceholders = new Array(insertCount).fill(undefined) as unknown[]
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
      tokenLines[i] = EMPTY_TOKEN_LINE
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
  const alignLineCount = alignedEndLine - alignedStartLine + 1
  if (alignLineCount > ALIGN_SYNC_SCAN_LIMIT_LINES) {
    const reconcileBoundaryLine = (line: number) => {
      if (line < 0 || line >= nextLineCount) return
      const nextLineText = nextLines[line] ?? ''
      if (!tokensMatchLine(tokenLines[line], nextLineText)) {
        tokenLines[line] = createFallbackTokenLine(nextLineText)
        changed = true
      }
      if (tokenStates[line] !== undefined) {
        tokenStates[line] = undefined
        changed = true
      }
    }
    reconcileBoundaryLine(alignedStartLine)
    if (alignedEndLine !== alignedStartLine) reconcileBoundaryLine(alignedEndLine)
    // Large splices are reconciled by deferred tokenization; avoid blocking the main thread.
    return true
  }
  const useDirectFallback = alignLineCount >= ALIGN_DIRECT_FALLBACK_THRESHOLD_LINES
  for (let line = alignedStartLine; line <= alignedEndLine; line++) {
    const nextLineText = nextLines[line] ?? ''
    const tokenLine = tokenLines[line]
    let lineMatches = false
    if (tokenLine && tokenLine.length === 1) {
      const onlyToken = tokenLine[0]
      lineMatches = (onlyToken?.type === 'text') && ((onlyToken.text ?? '') === nextLineText)
    }
    else if (!useDirectFallback) {
      lineMatches = tokensMatchLine(tokenLine, nextLineText)
    }
    if (!lineMatches) {
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

function invalidateTokenSnapshotsFromLineInPlace(
  tokenLines: Token[][],
  tokenStates: unknown[],
  lineCount: number,
  startLine: number,
): boolean {
  let changed = false

  if (lineCount <= 0) {
    if (tokenLines.length > 0) {
      tokenLines.length = 0
      changed = true
    }
    if (tokenStates.length > 0) {
      tokenStates.length = 0
      changed = true
    }
    return changed
  }

  if (tokenLines.length > lineCount) {
    tokenLines.length = lineCount
    changed = true
  }
  else if (tokenLines.length < lineCount) {
    const previousLength = tokenLines.length
    tokenLines.length = lineCount
    for (let i = previousLength; i < lineCount; i++) {
      tokenLines[i] = EMPTY_TOKEN_LINE
    }
    changed = true
  }

  if (tokenStates.length > lineCount) {
    tokenStates.length = lineCount
    changed = true
  }
  else if (tokenStates.length < lineCount) {
    tokenStates.length = lineCount
    changed = true
  }

  const invalidateFrom = Math.max(0, Math.min(startLine, lineCount - 1))
  for (let i = invalidateFrom; i < lineCount; i++) {
    if (tokenLines[i] !== EMPTY_TOKEN_LINE) {
      tokenLines[i] = EMPTY_TOKEN_LINE
      changed = true
    }
    if (tokenStates[i] !== undefined) {
      tokenStates[i] = undefined
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
  let deferredConvergenceStarted = false
  let lastOptimisticViewportPass: {
    revision: number
    tokenVersion: number
    startLine: number
    endLine: number
  } | null = null
  let pendingSyncIncrementalChange: DocIncrementalChange | null = null
  let pendingSyncIncrementalEmitTimer: ReturnType<typeof setTimeout> | null = null
  let cachedSpliceStart: CachedSpliceStart | null = null

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
    widgetVersion: 0,
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
        const nextTokens = annotateTokenLinePositions(result.tokens, line)
        if (!tokensEqual(doc.tokenLines[line], nextTokens)) {
          doc.tokenLines[line] = nextTokens
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

  const dispatchIncrementalChange = (payload: DocIncrementalChange) => {
    for (const listener of incrementalChangeListeners) {
      listener(payload)
    }
  }

  const queuePendingSyncIncrementalEmit = (delay = SYNC_INCREMENTAL_EMIT_THROTTLE_MS) => {
    if (pendingSyncIncrementalEmitTimer !== null) {
      // Keep throttle behavior stable; do not continuously debounce-reschedule.
      return
    }
    pendingSyncIncrementalEmitTimer = setTimeout(() => {
      pendingSyncIncrementalEmitTimer = null
      flushPendingSyncIncrementalChange()
    }, delay)
  }

  const flushPendingSyncIncrementalChange = (force = false): boolean => {
    if (!pendingSyncIncrementalChange) {
      if (pendingSyncIncrementalEmitTimer !== null) {
        clearTimeout(pendingSyncIncrementalEmitTimer)
        pendingSyncIncrementalEmitTimer = null
      }
      return false
    }

    if (pendingSyncIncrementalEmitTimer !== null) {
      clearTimeout(pendingSyncIncrementalEmitTimer)
      pendingSyncIncrementalEmitTimer = null
    }

    const payload = pendingSyncIncrementalChange
    pendingSyncIncrementalChange = null
    dispatchIncrementalChange(payload)
    return true
  }

  const emitIncrementalChange = (change: Omit<DocIncrementalChange, 'revision'>) => {
    const payload: DocIncrementalChange = { revision, ...change }
    if (payload.source !== 'sync') {
      flushPendingSyncIncrementalChange(payload.source === 'reset')
      dispatchIncrementalChange(payload)
      return
    }

    const changedLineSpan = Math.max(payload.endLineBefore, payload.endLineAfter) - payload.startLine + 1
    // Keep visual line flow in lockstep with caret while Enter/backspace repeats.
    const lineDelta = payload.endLineAfter - payload.endLineBefore
    const isStructuralLineChange = lineDelta !== 0
    const useThrottledSyncEmit = (
      (doc.keyHoldActive && !isStructuralLineChange)
      || changedLineSpan >= SYNC_INCREMENTAL_HEAVY_LINE_THRESHOLD
    )
    if (useThrottledSyncEmit) {
      pendingSyncIncrementalChange = payload
      const delay = doc.keyHoldActive
        ? SYNC_INCREMENTAL_EMIT_HOLD_THROTTLE_MS
        : SYNC_INCREMENTAL_EMIT_HEAVY_THROTTLE_MS
      queuePendingSyncIncrementalEmit(delay)
      return
    }

    flushPendingSyncIncrementalChange()
    dispatchIncrementalChange(payload)
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
      && isIncrementalTokenizer(doc.tokenize)
      && typeof doc.tokenize.createWorker === 'function'
      && buffer.lines.value.length >= getTokenizerWorkerMinLineCount(doc.tokenize)
  }

  const ensureTokenizerWorker = () => {
    if (!shouldUseTokenizerWorker()) return null
    if (tokenizerWorker) return tokenizerWorker

    tokenizerWorker = doc.tokenize.createWorker!()
    tokenizerWorker.onmessage = (event: MessageEvent<IncrementalTokenizerWorkerResponse>) => {
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
        const nextLineTokens = annotateTokenLinePositions(message.tokenLines[i] ?? [], line)
        const nextLineState = message.states[i] ?? null
        if (nextTokenLines[line] !== nextLineTokens) {
          nextTokenLines[line] = nextLineTokens
          changed = true
        }
        if (nextTokenStates[line] !== nextLineState) {
          nextTokenStates[line] = nextLineState
          changed = true
        }
      }
      if (changed) bumpTokenVersion()

      if (pendingDeferredRange) {
        pendingDeferredRange.startLine = message.processedEndLine + 1
      }

      const unresolvedStartLine = refreshFirstUnresolvedTokenLine(message.processedEndLine, lines)
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
        endLineBefore: message.processedEndLine,
        endLineAfter: message.processedEndLine,
        tokenProcessedStartLine: job.startLine,
        tokenProcessedEndLine: message.processedEndLine,
        tokenConverged: converged,
      })

      if (converged) {
        pendingDeferredRange = null
        doc.tokenizationPending = false
        deferredConvergenceStarted = false
        return
      }

      if (pendingDeferredRange) {
        queueDeferredTokenization()
      }
      else {
        doc.tokenizationPending = false
        deferredConvergenceStarted = false
      }
    }
    return tokenizerWorker
  }

  const queueDeferredTokenization = (forceImmediate = false) => {
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

    const initialDelayMs = forceImmediate
      ? 0
      : (!deferredConvergenceStarted ? getTokenizerSettleDelayMs(doc.tokenize) : DEFERRED_TOKENIZE_SLICE_DELAY_MS)

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

        deferredConvergenceStarted = true
        const lines = buffer.lines.value
        const tokenLines = annotateTokenLines((doc.tokenize as TokenizerLegacy)(lines.join('\n')))
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
      }, Math.max(initialDelayMs, LEGACY_DEFERRED_TOKENIZE_DELAY_MS))
      return
    }

    if (shouldUseTokenizerWorker()) {
      if (deferredTokenizationTimer !== null) return
      if (initialDelayMs > 0) {
        deferredTokenizationTimer = setTimeout(() => {
          deferredTokenizationTimer = null
          queueDeferredTokenization(true)
        }, initialDelayMs)
        return
      }

      const worker = ensureTokenizerWorker()
      if (!worker) return
      if (activeWorkerJob) return

      deferredConvergenceStarted = true
      const lines = buffer.lines.value
      const startLine = Math.max(0, pendingDeferredRange.startLine)
      const endLine = Math.min(
        lines.length - 1,
        pendingDeferredRange.endLine,
        startLine + getTokenizerWorkerChunkLines(doc.tokenize) - 1,
      )
      if (endLine < startLine) {
        pendingDeferredRange = null
        doc.tokenizationPending = false
        deferredConvergenceStarted = false
        return
      }

      const linesChunk = lines.slice(startLine, endLine + 1)
      const prevState = startLine > 0 ? (doc.tokenStates[startLine - 1] ?? null) : null
      const jobId = ++workerJobId
      activeWorkerJob = { jobId, startLine, endLine, revision: doc.revision }
      const request: IncrementalTokenizerWorkerRequest = {
        type: 'tokenizeChunk',
        jobId,
        revision: doc.revision,
        startLine,
        lines: linesChunk,
        prevState,
      }
      worker.postMessage(request)
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

      deferredConvergenceStarted = true
      const lines = buffer.lines.value
      const startLine = Math.max(0, pendingDeferredRange.startLine)
      const endLine = Math.min(lines.length - 1, pendingDeferredRange.endLine)
      if (endLine < startLine) {
        pendingDeferredRange = null
        doc.tokenizationPending = false
        deferredConvergenceStarted = false
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
        deferredConvergenceStarted = false
        return
      }

      pendingDeferredRange.startLine = nextDeferredStartLine
      if (pendingDeferredRange.startLine > pendingDeferredRange.endLine) {
        pendingDeferredRange = null
        doc.tokenizationPending = false
        deferredConvergenceStarted = false
        return
      }

      queueDeferredTokenization()
    }, initialDelayMs)
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
      deferredConvergenceStarted = false
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
      const canSyncLegacyTokenize = source === 'sync'
        && currentLines.length <= LEGACY_SYNC_TOKENIZE_MAX_LINES
        && getApproxCodeLength(currentLines) <= LEGACY_SYNC_TOKENIZE_MAX_CHARS

      if (canSyncLegacyTokenize) {
        const nextTokenLines = annotateTokenLines((doc.tokenize as TokenizerLegacy)(currentLines.join('\n')))
        const changed = reconcileLegacyTokenizationInPlace(
          doc.tokenLines,
          doc.tokenStates,
          nextTokenLines,
          currentLines.length,
        )

        if (deferredTokenizationTimer !== null) {
          clearTimeout(deferredTokenizationTimer)
          deferredTokenizationTimer = null
        }
        pendingDeferredRange = null
        deferredConvergenceStarted = false
        firstUnresolvedTokenLine = -1
        doc.tokenizationPending = false

        if (changed || prealignedChanged) bumpTokenVersion()

        emitIncrementalChange({
          source,
          startLine,
          endLineBefore,
          endLineAfter,
          tokenProcessedStartLine: Math.max(0, startLine),
          tokenProcessedEndLine: Math.max(0, currentLines.length - 1),
          tokenConverged: true,
        })
        return
      }

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
      deferredConvergenceStarted = false
      queueDeferredTokenization()
      return
    }

    if (source === 'sync' && (doc.keyHoldActive || maxLines <= 0)) {
      const hasLines = currentLines.length > 0
      firstUnresolvedTokenLine = currentLines.length > 0
        ? Math.max(0, Math.min(startLine, currentLines.length - 1))
        : -1
      doc.tokenizationPending = hasLines
      let hotTokenizedStartLine = -1
      let hotTokenizedEndLine = -1
      let hotTokenizedChanged = false

      if (source === 'sync' && hasLines && isIncrementalTokenizer(doc.tokenize)) {
        const hotStartLine = Math.max(0, Math.min(startLine, currentLines.length - 1))
        const optimisticHotEndLine = Math.max(hotStartLine, Math.min(
          Math.max(endLineAfter, startLine),
          currentLines.length - 1,
        ))
        const hotEndLine = Math.max(
          optimisticHotEndLine,
          Math.min(currentLines.length - 1, hotStartLine + SYNC_INCREMENTAL_KEYHOLD_HOT_TOKENIZE_LINES - 1),
        )

        let prevState: unknown = hotStartLine > 0
          ? (doc.tokenStates[hotStartLine - 1] ?? null)
          : null

        for (let line = hotStartLine; line <= hotEndLine; line++) {
          const lineResult = doc.tokenize.tokenizeLine(currentLines[line] ?? '', line, prevState)
          const nextTokens = annotateTokenLinePositions(lineResult.tokens, line)
          const nextState = lineResult.state ?? null
          if (!tokensEqual(doc.tokenLines[line], nextTokens)) {
            doc.tokenLines[line] = nextTokens
            hotTokenizedChanged = true
          }
          if (doc.tokenStates[line] !== nextState) {
            doc.tokenStates[line] = nextState
            hotTokenizedChanged = true
          }
          prevState = nextState
        }

        hotTokenizedStartLine = hotStartLine
        hotTokenizedEndLine = hotEndLine
      }

      const isStructuralLineChange = endLineAfter !== endLineBefore
      // Avoid per-keystroke tokenVersion churn while a key is held; this keeps
      // brace/cache rebuilders from thrashing during fast typing.
      // Structural line changes (e.g. holding Enter/Backspace across lines) must still bump
      // so brace guides can invalidate stale topology as line mappings shift.
      if ((prealignedChanged || hotTokenizedChanged || isStructuralLineChange)
        && (!doc.keyHoldActive || isStructuralLineChange))
      {
        bumpTokenVersion()
      }

      const processedStartLine = Math.max(0, startLine)
      const optimisticProcessedEndLine = Math.max(0, Math.max(endLineBefore, endLineAfter))
      const layoutPatchBudgetLines = maxLines <= 0
        ? SYNC_INCREMENTAL_LAYOUT_PATCH_BUDGET_PASTE_LINES
        : SYNC_INCREMENTAL_LAYOUT_PATCH_BUDGET_LINES
      const cappedProcessedEndLineBase = Math.max(
        processedStartLine,
        Math.min(
          optimisticProcessedEndLine,
          processedStartLine + layoutPatchBudgetLines - 1,
        ),
      )
      const cappedProcessedEndLine = hotTokenizedEndLine >= 0
        ? Math.max(cappedProcessedEndLineBase, hotTokenizedEndLine)
        : cappedProcessedEndLineBase
      const processedStartForEmit = hotTokenizedStartLine >= 0
        ? Math.min(processedStartLine, hotTokenizedStartLine)
        : processedStartLine

      emitIncrementalChange({
        source,
        startLine,
        endLineBefore,
        endLineAfter,
        tokenProcessedStartLine: processedStartForEmit,
        tokenProcessedEndLine: cappedProcessedEndLine,
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
        deferredConvergenceStarted = false
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

    if (converged) {
      deferredConvergenceStarted = false
      return
    }

    if (!converged) {
      pendingDeferredRange = {
        startLine: nextDeferredStartLine,
        endLine: Math.max(0, currentLines.length - 1),
      }
      doc.tokenizationPending = true
      if (source === 'sync') deferredConvergenceStarted = false
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
      cachedSpliceStart = null
      const nextLines = change.nextCode.split('\n')
      applyTokenization('reset', 0, 0, Math.max(0, nextLines.length - 1), Number.POSITIVE_INFINITY, nextLines)
      return
    }

    if (change.source === 'history') {
      adjustWidgetsForSplice(doc, change)
    }

    const deletedLineCount = countNewlines(change.deletedText)
    const insertedLineCount = countNewlines(change.insertedText)
    const nextLines = buffer.lines.value
    const lineCount = nextLines.length
    const maxLine = Math.max(0, lineCount - 1)
    const changeNow = Date.now()
    const resolvedStart = resolveSpliceStartLine(
      nextLines,
      maxLine,
      change.start,
      changeNow,
      change.startLine,
      cachedSpliceStart,
    )
    const startLine = resolvedStart.line
    cachedSpliceStart = resolvedStart.cache

    const endLineBefore = startLine + deletedLineCount
    const endLineAfter = startLine + insertedLineCount
    shiftUnresolvedLineForSplice(startLine, endLineBefore, endLineAfter, lineCount)
    const isMultilineSplice = insertedLineCount > 0 || deletedLineCount > 0
    // Multiline edits are better handled via structural snapshot alignment.
    // Full-tail invalidation is too expensive for large pastes in the middle of big files.
    const shouldFastInvalidateSnapshots = !isMultilineSplice
      && (
        change.insertedText.length >= FAST_SNAPSHOT_INVALIDATE_CHAR_THRESHOLD
        || change.deletedText.length >= FAST_SNAPSHOT_INVALIDATE_CHAR_THRESHOLD
      )
    const snapshotsAligned = shouldFastInvalidateSnapshots
      ? invalidateTokenSnapshotsFromLineInPlace(doc.tokenLines, doc.tokenStates, lineCount, startLine)
      : alignTokenSnapshotsForSpliceInPlace(
          doc.tokenLines,
          doc.tokenStates,
          nextLines,
          startLine,
          endLineBefore,
          endLineAfter,
        )
    if (snapshotsAligned || shouldFastInvalidateSnapshots) {
      markUnresolvedFromLine(startLine, nextLines)
    }

    applyTokenization(
      'sync',
      startLine,
      endLineBefore,
      endLineAfter,
      (insertedLineCount >= BURST_SYNC_TOKENIZATION_LINE_THRESHOLD
          || deletedLineCount >= BURST_SYNC_TOKENIZATION_LINE_THRESHOLD
          || change.insertedText.length >= BURST_SYNC_TOKENIZATION_CHAR_THRESHOLD)
        ? 0
        : getSyncTokenizationBudget(lineCount),
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
