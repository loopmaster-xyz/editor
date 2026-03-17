import { batch, signal, untracked } from '@preact/signals-core'
import { SkipString } from './lib/skip-string.ts'

export type Buffer = ReturnType<typeof createBuffer>

export enum BufferOpType {
  Insert,
  Delete,
}

export type BufferChange = {
  type: 'splice'
  start: number
  deletedText: string
  insertedText: string
  startLine?: number
  startColumn?: number
  source?: 'history'
} | {
  type: 'reset'
  prevCode: string
  nextCode: string
}

export type BufferChangeListener = (change: BufferChange) => void

function spliceChangeForOp(op: BufferOp, source?: 'history'): BufferChange {
  if (op.type === BufferOpType.Insert) {
    return {
      type: 'splice',
      start: op.index,
      deletedText: '',
      insertedText: op.text,
      startLine: op.startLine,
      startColumn: op.startColumn,
      source,
    }
  }
  return {
    type: 'splice',
    start: op.start,
    deletedText: op.text,
    insertedText: '',
    startLine: op.startLine,
    startColumn: op.startColumn,
    source,
  }
}

export type BufferOp = {
  type: BufferOpType.Insert
  index: number
  text: string
  startLine?: number
  startColumn?: number
  replace?: boolean
  selection?: { start: { line: number; column: number }; end: { line: number; column: number };
    direction: 'forward' | 'backward' }
  caretIndex?: number
} | {
  type: BufferOpType.Delete
  start: number
  end: number
  text: string
  startLine?: number
  startColumn?: number
  replace?: boolean
  selection?: { start: { line: number; column: number }; end: { line: number; column: number };
    direction: 'forward' | 'backward' }
  caretIndex?: number
}

function applyBufferOp(skipString: SkipString, op: BufferOp): void {
  switch (op.type) {
    case BufferOpType.Insert: {
      skipString.insert(op.index, op.text)
      break
    }
    case BufferOpType.Delete: {
      skipString.remove([op.start, op.end])
      break
    }
  }
}

function indexFromLineColumn(lines: string[], line: number, column: number): number {
  let index = 0
  for (let i = 0; i < line; i++) {
    index += lines[i].length + 1
  }
  index += column
  return index
}

function lineColumnFromIndex(code: string, index: number): [line: number, column: number] {
  let line = 0
  let column = 0
  for (let i = 0; i < index && i < code.length; i++) {
    if (code[i] === '\n') {
      line++
      column = 0
    }
    else {
      column++
    }
  }
  return [line, column]
}

function analyzeTextForLineSplice(text: string): { lineBreaks: number; tailLength: number } {
  let lineBreaks = 0
  let tailLength = 0

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lineBreaks++
      tailLength = 0
    }
    else {
      tailLength++
    }
  }

  return { lineBreaks, tailLength }
}

function resolveLineColumnAtIndex(
  lines: string[],
  index: number,
  lineHint?: number,
  columnHint?: number,
): { line: number; column: number } {
  if (lines.length === 0) {
    return { line: 0, column: 0 }
  }

  if (lineHint !== undefined && columnHint !== undefined) {
    const line = Math.max(0, Math.min(lineHint, lines.length - 1))
    const maxColumn = lines[line]?.length ?? 0
    return { line, column: Math.max(0, Math.min(columnHint, maxColumn)) }
  }

  let remaining = Math.max(0, index)
  for (let line = 0; line < lines.length; line++) {
    const lineLength = lines[line]?.length ?? 0
    if (remaining <= lineLength) {
      return { line, column: remaining }
    }
    remaining -= lineLength + 1
  }

  const lastLine = lines.length - 1
  return { line: lastLine, column: lines[lastLine]?.length ?? 0 }
}

function applySpliceToLinesInPlace(
  lines: string[],
  start: number,
  deletedText: string,
  insertedText: string,
  startLineHint?: number,
  startColumnHint?: number,
): { startLine: number; startColumn: number } {
  if (lines.length === 0) lines.push('')

  const startPos = resolveLineColumnAtIndex(lines, start, startLineHint, startColumnHint)
  const startLine = Math.max(0, Math.min(startPos.line, lines.length - 1))
  const startLineText = lines[startLine] ?? ''
  const startColumn = Math.max(0, Math.min(startPos.column, startLineText.length))

  const deletedInfo = analyzeTextForLineSplice(deletedText)
  let deletedEndLine = startLine + deletedInfo.lineBreaks
  if (deletedEndLine < startLine) deletedEndLine = startLine
  if (deletedEndLine >= lines.length) deletedEndLine = lines.length - 1

  const deletedEndLineText = lines[deletedEndLine] ?? ''
  const rawDeletedEndColumn = deletedInfo.lineBreaks === 0
    ? startColumn + deletedInfo.tailLength
    : deletedInfo.tailLength
  const deletedEndColumn = Math.max(0, Math.min(rawDeletedEndColumn, deletedEndLineText.length))

  const prefix = startLineText.slice(0, startColumn)
  const suffix = deletedEndLineText.slice(deletedEndColumn)
  const firstNewline = insertedText.indexOf('\n')

  let replacement: string[]
  if (firstNewline === -1) {
    replacement = [prefix + insertedText + suffix]
  }
  else {
    replacement = insertedText.split('\n')
    replacement[0] = prefix + replacement[0]
    replacement[replacement.length - 1] = replacement[replacement.length - 1] + suffix
  }

  const deleteCount = Math.max(1, deletedEndLine - startLine + 1)
  lines.splice(startLine, deleteCount, ...replacement)
  if (lines.length === 0) lines.push('')

  return { startLine, startColumn }
}

export function createBuffer(bufferCode: string) {
  const skipString = new SkipString()
  skipString.set(bufferCode)

  const changeListeners = new Set<BufferChangeListener>()
  const onChange = (listener: BufferChangeListener) => {
    changeListeners.add(listener)
    return () => {
      changeListeners.delete(listener)
    }
  }
  const emitChange = (change: BufferChange) => {
    untracked(() => {
      for (const listener of changeListeners) {
        listener(change)
      }
    })
  }

  const codeVersion = signal(0)
  let codeCache = bufferCode
  let codeDirty = false
  let codeLength = bufferCode.length
  const linesState = bufferCode.split('\n')
  const linesVersion = signal(0)

  const getCode = () => {
    if (codeDirty) {
      codeCache = skipString.toString()
      codeDirty = false
    }
    return codeCache
  }

  const applySpliceState = (
    start: number,
    deletedText: string,
    insertedText: string,
    startLineHint?: number,
    startColumnHint?: number,
  ) => {
    if (deletedText.length === 0 && insertedText.length === 0) return null

    const clampedStart = Math.max(0, Math.min(start, codeLength))
    const removedLength = Math.max(0, Math.min(deletedText.length, codeLength - clampedStart))
    if (removedLength === 0 && insertedText.length === 0) return null

    const { startLine, startColumn } = applySpliceToLinesInPlace(
      linesState,
      clampedStart,
      deletedText,
      insertedText,
      startLineHint,
      startColumnHint,
    )
    const removedText = removedLength === deletedText.length ? deletedText : deletedText.slice(0, removedLength)
    codeLength = codeLength - removedLength + insertedText.length
    codeDirty = true

    batch(() => {
      codeVersion.value++
      linesVersion.value++
    })

    return {
      start: clampedStart,
      deletedText: removedText,
      insertedText,
      startLine,
      startColumn,
    }
  }

  const code = {
    get value() {
      codeVersion.value
      return getCode()
    },
    set value(value: string) {
      const prevCode = getCode()
      if (value === prevCode) return
      skipString.set(value)
      const nextLines = value.split('\n')
      linesState.length = 0
      for (let i = 0; i < nextLines.length; i++) {
        linesState.push(nextLines[i] ?? '')
      }
      codeCache = value
      codeDirty = false
      codeLength = value.length
      clearMergeWindow()
      emitChange({ type: 'reset', prevCode, nextCode: value })
      batch(() => {
        codeVersion.value++
        linesVersion.value++
      })
    },
  }
  const lines = {
    get value() {
      linesVersion.value
      return linesState
    },
  }
  const history = signal<BufferOp[]>([])
  const index = signal(-1)

  let mergeTimestamp = -Infinity
  const clearMergeWindow = () => {
    mergeTimestamp = -Infinity
  }

  const applyOp = (op: BufferOp, useHints = true) => {
    applyBufferOp(skipString, op)
    let appliedSplice: { startLine: number; startColumn: number } | null = null
    if (op.type === BufferOpType.Insert) {
      const result = applySpliceState(
        op.index,
        '',
        op.text,
        useHints ? op.startLine : undefined,
        useHints ? op.startColumn : undefined,
      )
      if (result) appliedSplice = { startLine: result.startLine, startColumn: result.startColumn }
    }
    else {
      const result = applySpliceState(
        op.start,
        op.text,
        '',
        useHints ? op.startLine : undefined,
        useHints ? op.startColumn : undefined,
      )
      if (result) appliedSplice = { startLine: result.startLine, startColumn: result.startColumn }
    }

    if (appliedSplice) {
      if (op.startLine === undefined) op.startLine = appliedSplice.startLine
      if (op.startColumn === undefined) op.startColumn = appliedSplice.startColumn
    }
  }

  const apply = (op: BufferOp, merge = false) => {
    const prevOp = history.value[index.value]
    const now = Date.now()

    applyOp(op, true)

    if (merge && prevOp && now - mergeTimestamp < 1000) {
      if (op.type === BufferOpType.Insert && prevOp.type === BufferOpType.Insert) {
        if (op.index === prevOp.index + prevOp.text.length) {
          if (prevOp.replace) {
            const prevDeleteOp = history.value[index.value - 1]
            if (prevDeleteOp && prevDeleteOp.type === BufferOpType.Delete && prevDeleteOp.replace) {
              const mergedOp: BufferOp = {
                type: BufferOpType.Insert,
                index: prevOp.index,
                text: prevOp.text + op.text,
                startLine: prevOp.startLine ?? op.startLine,
                startColumn: prevOp.startColumn ?? op.startColumn,
                replace: true,
                selection: prevOp.selection,
              }
              if (prevOp.caretIndex !== undefined) {
                mergedOp.caretIndex = op.caretIndex !== undefined ? op.caretIndex : prevOp.caretIndex
              }
              else if (op.caretIndex !== undefined) {
                mergedOp.caretIndex = op.caretIndex
              }
              history.value = [...history.value.slice(0, index.value), mergedOp,
                ...history.value.slice(index.value + 1)]
              mergeTimestamp = now
              emitChange(spliceChangeForOp(op))
              return
            }
          }
          const mergedOp: BufferOp = {
            type: BufferOpType.Insert,
            index: prevOp.index,
            text: prevOp.text + op.text,
            startLine: prevOp.startLine ?? op.startLine,
            startColumn: prevOp.startColumn ?? op.startColumn,
            selection: prevOp.selection,
          }
          if (prevOp.caretIndex !== undefined) {
            mergedOp.caretIndex = prevOp.caretIndex
          }
          history.value = [...history.value.slice(0, index.value), mergedOp, ...history.value.slice(index.value + 1)]
          mergeTimestamp = now
          emitChange(spliceChangeForOp(op))
          return
        }
      }
      if (op.type === BufferOpType.Insert && op.replace && prevOp.type === BufferOpType.Delete && prevOp.replace) {
        const prevPrevOp = history.value[index.value - 1]
        if (prevPrevOp && prevPrevOp.type === BufferOpType.Insert && prevPrevOp.replace) {
          const prevPrevDeleteOp = history.value[index.value - 2]
          if (prevPrevDeleteOp && prevPrevDeleteOp.type === BufferOpType.Delete && prevPrevDeleteOp.replace) {
            const sameLines = prevOp.selection && prevPrevDeleteOp.selection
              && prevOp.selection.start.line === prevPrevDeleteOp.selection.start.line
              && prevOp.selection.end.line === prevPrevDeleteOp.selection.end.line
            const sameIndex = op.index === prevPrevOp.index && prevOp.start === prevPrevOp.index
              && prevOp.end === prevPrevOp.index + prevPrevOp.text.length
              && prevPrevDeleteOp.start === prevPrevOp.index
              && prevPrevDeleteOp.end === prevPrevOp.index + prevPrevOp.text.length
            const adjacentIndex = op.index === prevPrevOp.index + prevPrevOp.text.length && prevOp.start === op.index
              && prevPrevDeleteOp.start === prevPrevOp.index
              && prevPrevDeleteOp.end === prevPrevOp.index + prevPrevOp.text.length

            if (sameLines || sameIndex) {
              batch(() => {
                history.value = history.value.slice(0, index.value - 2)
                history.value.push({
                  type: BufferOpType.Delete,
                  start: prevPrevDeleteOp.start,
                  end: prevPrevDeleteOp.end,
                  text: prevPrevDeleteOp.text,
                  startLine: prevPrevDeleteOp.startLine ?? prevOp.startLine,
                  startColumn: prevPrevDeleteOp.startColumn ?? prevOp.startColumn,
                  replace: true,
                  selection: prevPrevDeleteOp.selection,
                  caretIndex: prevPrevDeleteOp.caretIndex,
                })
                history.value.push({
                  type: BufferOpType.Insert,
                  index: prevPrevOp.index,
                  text: op.text,
                  startLine: op.startLine ?? prevPrevOp.startLine,
                  startColumn: op.startColumn ?? prevPrevOp.startColumn,
                  replace: true,
                  selection: op.selection || prevPrevOp.selection,
                  caretIndex: op.caretIndex,
                })
                index.value = history.value.length - 1
              })
              mergeTimestamp = now
              emitChange(spliceChangeForOp(op))
              return
            }
            if (adjacentIndex) {
              batch(() => {
                history.value = history.value.slice(0, index.value - 1)
                history.value.push({
                  type: BufferOpType.Delete,
                  start: prevPrevDeleteOp.start,
                  end: prevOp.end,
                  text: prevPrevDeleteOp.text + prevOp.text,
                  startLine: prevPrevDeleteOp.startLine ?? prevOp.startLine,
                  startColumn: prevPrevDeleteOp.startColumn ?? prevOp.startColumn,
                  replace: true,
                  selection: prevPrevDeleteOp.selection || prevOp.selection,
                  caretIndex: prevPrevDeleteOp.caretIndex,
                })
                history.value.push({
                  type: BufferOpType.Insert,
                  index: prevPrevOp.index,
                  text: prevPrevOp.text + op.text,
                  startLine: prevPrevOp.startLine ?? op.startLine,
                  startColumn: prevPrevOp.startColumn ?? op.startColumn,
                  replace: true,
                  selection: op.selection || prevPrevOp.selection,
                  caretIndex: op.caretIndex,
                })
                index.value = history.value.length - 1
              })
              mergeTimestamp = now
              emitChange(spliceChangeForOp(op))
              return
            }
          }
        }
      }
      else if (op.type === BufferOpType.Delete && prevOp.type === BufferOpType.Delete) {
        // Merge adjacent deletes: backspace (prevOp.end === op.start) or forward adjacent (op.end === prevOp.start)
        // Also merge consecutive forward deletes at same position (prevOp.start === op.start)
        if (prevOp.end === op.start || op.end === prevOp.start || prevOp.start === op.start) {
          const isForwardDeleteAtSamePos = prevOp.start === op.start && prevOp.end !== op.start
            && op.end !== prevOp.start
          const start = Math.min(prevOp.start, op.start)
          const end = isForwardDeleteAtSamePos
            ? prevOp.start + prevOp.text.length + op.text.length
            : Math.max(prevOp.end, op.end)
          const text = isForwardDeleteAtSamePos
            ? prevOp.text + op.text
            : (prevOp.start < op.start ? prevOp.text + op.text : op.text + prevOp.text)
          const mergedOp: BufferOp = {
            type: BufferOpType.Delete,
            start,
            end,
            text,
            selection: prevOp.selection,
          }
          if (prevOp.startLine !== undefined || op.startLine !== undefined) {
            mergedOp.startLine = Math.min(prevOp.startLine ?? op.startLine ?? 0, op.startLine ?? prevOp.startLine ?? 0)
          }
          if (mergedOp.startLine !== undefined) {
            const sameStartLine = prevOp.startLine !== undefined && op.startLine !== undefined && prevOp.startLine === op.startLine
            if (sameStartLine) {
              if (prevOp.startColumn !== undefined || op.startColumn !== undefined) {
                mergedOp.startColumn = Math.min(prevOp.startColumn ?? op.startColumn ?? 0,
                  op.startColumn ?? prevOp.startColumn ?? 0)
              }
            }
            else if (mergedOp.startLine === prevOp.startLine) {
              mergedOp.startColumn = prevOp.startColumn
            }
            else if (mergedOp.startLine === op.startLine) {
              mergedOp.startColumn = op.startColumn
            }
          }
          if (prevOp.caretIndex !== undefined) {
            mergedOp.caretIndex = prevOp.caretIndex
          }
          history.value = [...history.value.slice(0, index.value), mergedOp, ...history.value.slice(index.value + 1)]
          mergeTimestamp = now
          emitChange(spliceChangeForOp(op))
          return
        }
      }
    }

    batch(() => {
      history.value = history.value.slice(0, index.value + 1)
      history.value.push(op)
      index.value++
    })
    if (merge) mergeTimestamp = now
    else clearMergeWindow()
    emitChange(spliceChangeForOp(op))
  }

  const undo = (): { line: number; column: number;
    selection?: { start: { line: number; column: number }; end: { line: number; column: number };
      direction: 'forward' | 'backward' } } | null =>
  {
    const op = history.value[index.value]
    if (!op) return null
    clearMergeWindow()
    index.value--
    switch (op.type) {
      case BufferOpType.Insert: {
        skipString.remove([op.index, op.index + op.text.length])
        const removed = applySpliceState(op.index, op.text, '', undefined, undefined)
        if (removed) {
          if (op.startLine === undefined) op.startLine = removed.startLine
          if (op.startColumn === undefined) op.startColumn = removed.startColumn
        }
        emitChange({
          type: 'splice',
          start: op.index,
          deletedText: op.text,
          insertedText: '',
          startLine: op.startLine,
          startColumn: op.startColumn,
          source: 'history',
        })
        if (op.replace) {
          const deleteOp = history.value[index.value]
          if (deleteOp && deleteOp.type === BufferOpType.Delete) {
            skipString.insert(deleteOp.start, deleteOp.text)
            const inserted = applySpliceState(deleteOp.start, '', deleteOp.text, undefined, undefined)
            if (inserted) {
              if (deleteOp.startLine === undefined) deleteOp.startLine = inserted.startLine
              if (deleteOp.startColumn === undefined) deleteOp.startColumn = inserted.startColumn
            }
            index.value--
            emitChange({
              type: 'splice',
              start: deleteOp.start,
              deletedText: '',
              insertedText: deleteOp.text,
              startLine: deleteOp.startLine,
              startColumn: deleteOp.startColumn,
              source: 'history',
            })
            if (deleteOp.selection) {
              const lines = linesState
              const maxLine = Math.max(0, lines.length - 1)
              const startLine = Math.min(deleteOp.selection.start.line, maxLine)
              const endLine = Math.min(deleteOp.selection.end.line, maxLine)
              const startMaxColumn = lines[startLine]?.length || 0
              const endMaxColumn = lines[endLine]?.length || 0
              const startColumn = Math.min(deleteOp.selection.start.column, startMaxColumn)
              const endColumn = Math.min(deleteOp.selection.end.column, endMaxColumn)
              const caretPos = deleteOp.selection.direction === 'forward'
                ? { line: endLine, column: endColumn }
                : { line: startLine, column: startColumn }
              return {
                line: caretPos.line,
                column: caretPos.column,
                selection: {
                  start: { line: startLine, column: startColumn },
                  end: { line: endLine, column: endColumn },
                  direction: deleteOp.selection.direction,
                },
              }
            }
            if (deleteOp.caretIndex !== undefined) {
              const clampedCaretIndex = Math.min(deleteOp.caretIndex, codeLength)
              const [line, column] = lineColumnFromIndex(code.value, clampedCaretIndex)
              const lines = linesState
              const maxLine = Math.max(0, lines.length - 1)
              const maxColumn = lines[Math.min(line, maxLine)]?.length || 0
              return {
                line: Math.min(line, maxLine),
                column: Math.min(column, maxColumn),
              }
            }
            const caretIndex = deleteOp.start + deleteOp.text.length
            const [line, column] = lineColumnFromIndex(code.value, caretIndex)
            const lines = linesState
            const maxLine = Math.max(0, lines.length - 1)
            const maxColumn = lines[Math.min(line, maxLine)]?.length || 0
            return {
              line: Math.min(line, maxLine),
              column: Math.min(column, maxColumn),
            }
          }
          // Orphaned replace Insert op - just return position at op.index
          const caretIndex = Math.min(op.index, codeLength)
          const [line, column] = lineColumnFromIndex(code.value, caretIndex)
          const lines = linesState
          const maxLine = Math.max(0, lines.length - 1)
          const maxColumn = lines[Math.min(line, maxLine)]?.length || 0
          return {
            line: Math.min(line, maxLine),
            column: Math.min(column, maxColumn),
          }
        }
        if (op.selection) {
          const lines = linesState
          const maxLine = Math.max(0, lines.length - 1)
          const startLine = Math.min(op.selection.start.line, maxLine)
          const endLine = Math.min(op.selection.end.line, maxLine)
          const startMaxColumn = lines[startLine]?.length || 0
          const endMaxColumn = lines[endLine]?.length || 0
          const startColumn = Math.min(op.selection.start.column, startMaxColumn)
          const endColumn = Math.min(op.selection.end.column, endMaxColumn)
          const caretPos = op.selection.direction === 'forward'
            ? { line: endLine, column: endColumn }
            : { line: startLine, column: startColumn }
          return {
            line: caretPos.line,
            column: caretPos.column,
            selection: {
              start: { line: startLine, column: startColumn },
              end: { line: endLine, column: endColumn },
              direction: op.selection.direction,
            },
          }
        }
        if (op.caretIndex !== undefined) {
          const [line, column] = lineColumnFromIndex(code.value, op.caretIndex)
          const lines = linesState
          const maxLine = Math.max(0, lines.length - 1)
          const maxColumn = lines[Math.min(line, maxLine)]?.length || 0
          return {
            line: Math.min(line, maxLine),
            column: Math.min(column, maxColumn),
          }
        }
        const caretIndex = Math.min(op.index, codeLength)
        const [line, column] = lineColumnFromIndex(code.value, caretIndex)
        const lines = linesState
        const maxLine = Math.max(0, lines.length - 1)
        const maxColumn = lines[Math.min(line, maxLine)]?.length || 0
        return {
          line: Math.min(line, maxLine),
          column: Math.min(column, maxColumn),
        }
      }
      case BufferOpType.Delete: {
        skipString.insert(op.start, op.text)
        const inserted = applySpliceState(op.start, '', op.text, undefined, undefined)
        if (inserted) {
          if (op.startLine === undefined) op.startLine = inserted.startLine
          if (op.startColumn === undefined) op.startColumn = inserted.startColumn
        }
        emitChange({
          type: 'splice',
          start: op.start,
          deletedText: '',
          insertedText: op.text,
          startLine: op.startLine,
          startColumn: op.startColumn,
          source: 'history',
        })
        if (op.selection) {
          const lines = linesState
          const maxLine = Math.max(0, lines.length - 1)
          const startLine = Math.min(op.selection.start.line, maxLine)
          const endLine = Math.min(op.selection.end.line, maxLine)
          const startMaxColumn = lines[startLine]?.length || 0
          const endMaxColumn = lines[endLine]?.length || 0
          const startColumn = Math.min(op.selection.start.column, startMaxColumn)
          const endColumn = Math.min(op.selection.end.column, endMaxColumn)
          const caretPos = op.selection.direction === 'forward'
            ? { line: endLine, column: endColumn }
            : { line: startLine, column: startColumn }
          return {
            line: caretPos.line,
            column: caretPos.column,
            selection: {
              start: { line: startLine, column: startColumn },
              end: { line: endLine, column: endColumn },
              direction: op.selection.direction,
            },
          }
        }
        if (op.caretIndex !== undefined) {
          const [line, column] = lineColumnFromIndex(code.value, op.caretIndex)
          const lines = linesState
          const maxLine = Math.max(0, lines.length - 1)
          const maxColumn = lines[Math.min(line, maxLine)]?.length || 0
          return {
            line: Math.min(line, maxLine),
            column: Math.min(column, maxColumn),
          }
        }
        const caretIndex = op.start + op.text.length
        const [line, column] = lineColumnFromIndex(code.value, caretIndex)
        const lines = linesState
        const maxLine = Math.max(0, lines.length - 1)
        const maxColumn = lines[Math.min(line, maxLine)]?.length || 0
        return {
          line: Math.min(line, maxLine),
          column: Math.min(column, maxColumn),
        }
      }
    }
  }

  const redo = (): { line: number; column: number;
    selection?: { start: { line: number; column: number }; end: { line: number; column: number };
      direction: 'forward' | 'backward' } } | null =>
  {
    const op = history.value[index.value + 1]
    if (!op) return null
    clearMergeWindow()
    index.value++
    applyOp(op, false)
    emitChange(spliceChangeForOp(op, 'history'))
    if (op.replace) {
      const nextOp = history.value[index.value + 1]
      if (nextOp && nextOp.type === BufferOpType.Insert && nextOp.replace) {
        index.value++
        applyOp(nextOp, false)
        emitChange(spliceChangeForOp(nextOp, 'history'))
        if (nextOp.selection) {
          const lines = linesState
          const maxLine = Math.max(0, lines.length - 1)
          const startLine = Math.min(nextOp.selection.start.line, maxLine)
          const endLine = Math.min(nextOp.selection.end.line, maxLine)
          const startMaxColumn = lines[startLine]?.length || 0
          const endMaxColumn = lines[endLine]?.length || 0
          const startColumn = Math.min(nextOp.selection.start.column, startMaxColumn)
          const endColumn = Math.min(nextOp.selection.end.column, endMaxColumn)
          const caretPos = nextOp.selection.direction === 'forward'
            ? { line: endLine, column: endColumn }
            : { line: startLine, column: startColumn }
          return {
            line: caretPos.line,
            column: caretPos.column,
            selection: {
              start: { line: startLine, column: startColumn },
              end: { line: endLine, column: endColumn },
              direction: nextOp.selection.direction,
            },
          }
        }
        if (nextOp.caretIndex !== undefined) {
          const [line, column] = lineColumnFromIndex(code.value, nextOp.caretIndex)
          return { line, column }
        }
        const [line, column] = lineColumnFromIndex(code.value, nextOp.index + nextOp.text.length)
        return { line, column }
      }
      // Orphaned replace op - return position based on op type
      if (op.type === BufferOpType.Delete) {
        const [line, column] = lineColumnFromIndex(code.value, op.start)
        return { line, column }
      }
      // Shouldn't happen, but fallback for Insert
      const [line, column] = lineColumnFromIndex(code.value, op.index)
      return { line, column }
    }
    switch (op.type) {
      case BufferOpType.Insert: {
        if (op.caretIndex !== undefined) {
          const [line, column] = lineColumnFromIndex(code.value, op.caretIndex)
          return { line, column }
        }
        const [line, column] = lineColumnFromIndex(code.value, op.index + op.text.length)
        return { line, column }
      }
      case BufferOpType.Delete: {
        // For redo of delete, caret goes to op.start (where text was deleted from)
        // caretIndex is only used for undo (position before delete)
        const [line, column] = lineColumnFromIndex(code.value, op.start)
        return { line, column }
      }
      default: {
        const [line, column] = lineColumnFromIndex(code.value, 0)
        return { line, column }
      }
    }
  }

  const insert = (line: number, column: number, text: string) => {
    const raw = indexFromLineColumn(lines.value, line, column)
    const index = Math.max(0, Math.min(raw, codeLength))
    apply({ type: BufferOpType.Insert, index, text, startLine: line, startColumn: column }, true)
  }

  const del = (line: number, column: number) => {
    const index = indexFromLineColumn(lines.value, line, column)
    const char = skipString.substring(index, index + 1)
    apply({
      type: BufferOpType.Delete,
      start: index,
      end: index + 1,
      text: char,
      caretIndex: index,
      startLine: line,
      startColumn: column,
    }, true)
  }

  const backspace = (line: number, column: number) => {
    const index = indexFromLineColumn(lines.value, line, column)
    const char = skipString.substring(index - 1, index)
    const startLine = Math.max(0, column > 0 ? line : line - 1)
    const startColumn = column > 0 ? column - 1 : (lines.value[startLine]?.length ?? 0)
    apply({
      type: BufferOpType.Delete,
      start: index - 1,
      end: index,
      text: char,
      caretIndex: index,
      startLine,
      startColumn,
    }, true)
  }

  const deleteSelection = (start: { line: number; column: number }, end: { line: number; column: number },
    selection?: { start: { line: number; column: number }; end: { line: number; column: number };
      direction: 'forward' | 'backward' }, merge = false, caretPosition?: { line: number; column: number }) =>
  {
    const startIndex = indexFromLineColumn(lines.value, start.line, start.column)
    const endIndex = indexFromLineColumn(lines.value, end.line, end.column)
    const text = skipString.substring(startIndex, endIndex)
    const caretIndex = caretPosition
      ? indexFromLineColumn(lines.value, caretPosition.line, caretPosition.column)
      : undefined
    apply({ type: BufferOpType.Delete, start: startIndex, end: endIndex, text, selection, caretIndex,
      startLine: start.line, startColumn: start.column }, merge)
  }

  const replace = (index: number, length: number, text: string) => {
    const deletedText = skipString.substring(index, index + length)
    const deleteOp: BufferOp = { type: BufferOpType.Delete, start: index, end: index + length, text: deletedText,
      replace: true }
    const insertOp: BufferOp = { type: BufferOpType.Insert, index, text, replace: true }
    batch(() => {
      apply(deleteOp, true)
      apply(insertOp, true)
    })
  }

  const replaceSelection = (start: { line: number; column: number }, end: { line: number; column: number },
    text: string,
    selectionBefore?: { start: { line: number; column: number }; end: { line: number; column: number };
      direction: 'forward' | 'backward' }, caretPositionBefore?: { line: number; column: number },
    selectionAfter?: { start: { line: number; column: number }; end: { line: number; column: number };
      direction: 'forward' | 'backward' }, caretPositionAfter?: { line: number; column: number }) =>
  {
    const startIndex = indexFromLineColumn(lines.value, start.line, start.column)
    const endIndex = indexFromLineColumn(lines.value, end.line, end.column)
    const deletedText = skipString.substring(startIndex, endIndex)
    const beforeCaretIndex = caretPositionBefore !== undefined
      ? indexFromLineColumn(lines.value, caretPositionBefore.line, caretPositionBefore.column)
      : undefined

    const afterCaretIndex = caretPositionAfter !== undefined
      ? (() => {
        const currentCode = code.value
        const newCode = currentCode.slice(0, startIndex) + text + currentCode.slice(endIndex)
        const newLines = newCode.split('\n')
        return indexFromLineColumn(newLines, caretPositionAfter.line, caretPositionAfter.column)
      })()
      : undefined

    const deleteOp: BufferOp = { type: BufferOpType.Delete, start: startIndex, end: endIndex, text: deletedText,
      replace: true, selection: selectionBefore, caretIndex: beforeCaretIndex, startLine: start.line,
      startColumn: start.column }
    const insertOp: BufferOp = { type: BufferOpType.Insert, index: startIndex, text: text, replace: true,
      selection: selectionAfter, caretIndex: afterCaretIndex, startLine: start.line, startColumn: start.column }

    const now = Date.now()
    batch(() => {
      applyOp(deleteOp)
      applyOp(insertOp)
      history.value = history.value.slice(0, index.value + 1)
      history.value.push(deleteOp)
      history.value.push(insertOp)
      index.value += 2
    })
    mergeTimestamp = now
    emitChange(spliceChangeForOp(deleteOp))
    emitChange(spliceChangeForOp(insertOp))
  }

  const pack = () => {
    const packedHistory: unknown[] = []
    for (const op of history.value) {
      if (op.type === BufferOpType.Insert) {
        const item: unknown[] = [0, op.index, op.text]
        if (op.replace) item.push(1)
        if (op.selection) {
          item.push(op.selection.direction === 'forward' ? 'f' : 'b')
          item.push(op.selection.start.line, op.selection.start.column, op.selection.end.line, op.selection.end.column)
        }
        if (op.caretIndex !== undefined) item.push(op.caretIndex)
        packedHistory.push(item)
      }
      else {
        const item: unknown[] = [1, op.start, op.end, op.text]
        if (op.replace) item.push(1)
        if (op.selection) {
          item.push(op.selection.direction === 'forward' ? 'f' : 'b')
          item.push(op.selection.start.line, op.selection.start.column, op.selection.end.line, op.selection.end.column)
        }
        if (op.caretIndex !== undefined) item.push(op.caretIndex)
        packedHistory.push(item)
      }
    }
    return {
      code: code.value,
      history: packedHistory,
      index: index.value,
    }
  }

  return {
    code,
    lines,
    history,
    index,
    onChange,
    apply,
    undo,
    redo,
    insert,
    del,
    backspace,
    deleteSelection,
    replace,
    replaceSelection,
    pack,
  }
}

export type BufferPacked = {
  code: string
  history: unknown[]
  index: number
}

export function unpack(data: Partial<BufferPacked>): Buffer {
  const buffer = createBuffer(data.code ?? '')
  if (data.history && Array.isArray(data.history)) {
    const unpackedHistory: BufferOp[] = []
    for (const item of data.history) {
      if (!Array.isArray(item) || item.length < 2) continue
      const type = item[0]
      if (type === 0) {
        const op: BufferOp = {
          type: BufferOpType.Insert,
          index: item[1] as number,
          text: item[2] as string,
        }
        let offset = 3
        if (item[3] === 1) {
          op.replace = true
          offset = 4
        }
        if (item.length > offset && typeof item[offset] === 'string'
          && (item[offset] === 'f' || item[offset] === 'b'))
        {
          const direction = item[offset] === 'f' ? 'forward' : 'backward'
          if (item.length > offset + 4 && typeof item[offset + 1] === 'number' && typeof item[offset + 2] === 'number'
            && typeof item[offset + 3] === 'number' && typeof item[offset + 4] === 'number')
          {
            op.selection = {
              start: { line: item[offset + 1] as number, column: item[offset + 2] as number },
              end: { line: item[offset + 3] as number, column: item[offset + 4] as number },
              direction,
            }
            offset += 5
          }
          else {
            const [startLine, startColumn] = lineColumnFromIndex(buffer.code.value, op.index)
            const [endLine, endColumn] = lineColumnFromIndex(buffer.code.value, op.index + op.text.length)
            op.selection = { start: { line: startLine, column: startColumn }, end: { line: endLine, column: endColumn },
              direction }
            offset += 1
          }
        }
        if (item.length > offset && typeof item[offset] === 'number') {
          op.caretIndex = item[offset] as number
        }
        unpackedHistory.push(op)
      }
      else if (type === 1) {
        const op: BufferOp = {
          type: BufferOpType.Delete,
          start: item[1] as number,
          end: item[2] as number,
          text: item[3] as string,
        }
        let offset = 4
        if (item[4] === 1) {
          op.replace = true
          offset = 5
        }
        if (item.length > offset && typeof item[offset] === 'string'
          && (item[offset] === 'f' || item[offset] === 'b'))
        {
          const direction = item[offset] === 'f' ? 'forward' : 'backward'
          if (item.length > offset + 4 && typeof item[offset + 1] === 'number' && typeof item[offset + 2] === 'number'
            && typeof item[offset + 3] === 'number' && typeof item[offset + 4] === 'number')
          {
            op.selection = {
              start: { line: item[offset + 1] as number, column: item[offset + 2] as number },
              end: { line: item[offset + 3] as number, column: item[offset + 4] as number },
              direction,
            }
            offset += 5
          }
          else {
            const [startLine, startColumn] = lineColumnFromIndex(buffer.code.value, op.start)
            const [endLine, endColumn] = lineColumnFromIndex(buffer.code.value, op.start + op.text.length)
            op.selection = { start: { line: startLine, column: startColumn }, end: { line: endLine, column: endColumn },
              direction }
            offset += 1
          }
        }
        if (item.length > offset && typeof item[offset] === 'number') {
          op.caretIndex = item[offset] as number
        }
        unpackedHistory.push(op)
      }
    }
    buffer.history.value = unpackedHistory
  }
  if (data.index !== undefined) {
    buffer.index.value = data.index
  }
  return buffer
}
