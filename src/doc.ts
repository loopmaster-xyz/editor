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

function alignTokenSnapshotsForSpliceInPlace(
  tokenLines: Token[][],
  tokenStates: unknown[],
  nextLineCount: number,
  endLineBefore: number,
  endLineAfter: number,
): boolean {
  const delta = endLineAfter - endLineBefore
  if (delta === 0 && tokenLines.length === nextLineCount && tokenStates.length === nextLineCount) {
    return false
  }
  let changed = false

  if (delta > 0) {
    const insertCount = delta
    const insertAt = Math.max(0, Math.min(endLineBefore + 1, tokenLines.length))
    const tokenLinePlaceholders = new Array(insertCount) as Token[][]
    const tokenStatePlaceholders = new Array(insertCount) as unknown[]
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
    tokenLines.length = nextLineCount
    changed = true
  }

  if (tokenStates.length > nextLineCount) {
    tokenStates.length = nextLineCount
    changed = true
  }
  if (tokenStates.length < nextLineCount) {
    tokenStates.length = nextLineCount
    changed = true
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

      emitIncrementalChange({
        source: 'deferred',
        startLine: job.startLine,
        endLineBefore: job.endLine,
        endLineAfter: job.endLine,
        tokenProcessedStartLine: job.startLine,
        tokenProcessedEndLine: job.endLine,
        tokenConverged: pendingDeferredRange === null || pendingDeferredRange.startLine > pendingDeferredRange.endLine,
      })

      if (pendingDeferredRange) {
        pendingDeferredRange.startLine = job.endLine + 1
        if (pendingDeferredRange.startLine > pendingDeferredRange.endLine) {
          pendingDeferredRange = null
          doc.tokenizationPending = false
          return
        }
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

    if (!isIncrementalTokenizer(doc.tokenize)) {
      if (deferredTokenizationTimer !== null) {
        clearTimeout(deferredTokenizationTimer)
      }
      deferredTokenizationTimer = setTimeout(() => {
        deferredTokenizationTimer = null
        if (!pendingDeferredRange) return

        const lines = buffer.lines.value
        const tokenLines = doc.tokenize(lines.join('\n'))
        doc.tokenLines = tokenLines
        doc.tokenStates = new Array(tokenLines.length).fill(null)
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
      emitIncrementalChange({
        source: 'deferred',
        startLine,
        endLineBefore: endLine,
        endLineAfter: endLine,
        tokenProcessedStartLine: tokenized.processedStartLine,
        tokenProcessedEndLine: tokenized.processedEndLine,
        tokenConverged: tokenized.converged,
      })

      if (tokenized.converged) {
        pendingDeferredRange = null
        doc.tokenizationPending = false
        return
      }

      pendingDeferredRange.startLine = tokenized.processedEndLine + 1
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
        nextTokenLines[i] = []
        changed = true
      }
      for (let i = nextTokenStates.length; i < currentLines.length; i++) {
        nextTokenStates[i] = undefined
        changed = true
      }
      if (changed) bumpTokenVersion()
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
    doc.tokenizationPending = !tokenized.converged

    emitIncrementalChange({
      source,
      startLine,
      endLineBefore,
      endLineAfter,
      tokenProcessedStartLine: tokenized.processedStartLine,
      tokenProcessedEndLine: tokenized.processedEndLine,
      tokenConverged: tokenized.converged,
    })

    if (!tokenized.converged) {
      pendingDeferredRange = {
        startLine: Math.max(0, tokenized.processedEndLine + 1),
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
    const snapshotsAligned = alignTokenSnapshotsForSpliceInPlace(
      doc.tokenLines,
      doc.tokenStates,
      lineCount,
      endLineBefore,
      endLineAfter,
    )

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
