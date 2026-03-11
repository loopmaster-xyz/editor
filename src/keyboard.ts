import { batch, type Signal, signal } from '@preact/signals-core'
import type { Blocks } from './blocks.ts'
import type { Caches } from './caches.ts'
import type { Canvas } from './canvas.ts'
import type { Caret } from './caret.ts'
import { createClipboard } from './clipboard.ts'
import type { Doc } from './doc.ts'
import { getVerticalScrollbarSize, HORIZONTAL_SCROLLBAR_SIZE } from './draw/scrollbar.ts'
import type { Header } from './header.ts'
import {
  findVisualLineForColumn,
  getColumnFromVisualPosition,
  getXFromColumn,
} from './line-utils.ts'
import type { Lines, VisualLine } from './lines.ts'
import { measureText } from './measure.ts'
import type { Metrics } from './metrics.ts'
import type { Scroll } from './scroll.ts'
import type { Selection } from './selection.ts'
import type { Settings } from './settings.ts'
import { getActiveCanvas, getTextareaElement } from './textarea-singleton.ts'
import type { Token } from './token.ts'
import {
  adjustWidgetsOnColumnDelete,
  adjustWidgetsOnColumnInsert,
  adjustWidgetsOnLineMerge,
  adjustWidgetsOnLineSplit,
  adjustWidgetsOnMultiLineDelete,
  adjustWidgetsOnNextLineMerge,
} from './widget.ts'

export type Keyboard = ReturnType<typeof createKeyboard>

type ActiveEditorOpts = { editorRef: { current: unknown }; setActiveEditor: (editor: unknown) => void }

export function createKeyboard(
  doc: Doc,
  canvas: Canvas,
  scroll: Scroll,
  lines: Lines,
  metrics: Metrics,
  settings: Settings,
  caret: Caret,
  caches: Caches,
  selection: Selection,
  blocks: Blocks,
  header: Signal<Header>,
  mouse: { clearHoverToken: (setEscapePressed?: boolean) => void },
  clearPinnedError: () => void,
  activeEditorOpts?: ActiveEditorOpts,
) {
  const shiftKey = signal(false)
  const ctrlKey = signal(false)
  const metaKey = signal(false)
  const altKey = signal(false)
  const pressedInputKeys = new Set<string>()

  const updateKeyHoldActive = () => {
    doc.keyHoldActive = pressedInputKeys.size > 0
  }

  function insertText(text: string) {
    if (selection.hasSelection.value) {
      const ordered = selection.getOrdered.value
      if (ordered) {
        const startLine = ordered.start.line
        const endLine = ordered.end.line
        const startColumn = ordered.start.column
        const endColumn = ordered.end.column
        const selectionDirection = selection.direction.value

        const linesBeforeReplace = doc.lines.length
        const deletedLineCount = endLine > startLine ? endLine - startLine : 0

        const selectionDir = selectionDirection === 'forward' || selectionDirection === 'backward'
          ? selectionDirection
          : undefined
        const selectionObj = selectionDir && ordered
          ? {
            start: { line: startLine, column: startColumn },
            end: { line: endLine, column: endColumn },
            direction: selectionDir,
          }
          : undefined
        doc.buffer.replaceSelection(
          { line: startLine, column: startColumn },
          { line: endLine, column: endColumn },
          text,
          selectionObj,
        )

        const linesAfterReplace = doc.lines.length
        const newlineCount = (text.match(/\n/g) || []).length
        const insertedLineCount = newlineCount > 0 ? newlineCount : 0
        const netLineChange = linesAfterReplace - linesBeforeReplace

        if (deletedLineCount > 0) {
          caches.adjustWrapTokensCacheOnLineDeleteRange(startLine + 1, endLine)
          blocks.adjustOnLineDeleteRange(startLine + 1, endLine)
        }

        if (insertedLineCount > 0) {
          const insertStartLine = startLine + 1
          const insertEndLine = startLine + insertedLineCount
          caches.adjustWrapTokensCacheOnLineInsertRange(insertStartLine, insertEndLine)
          blocks.adjustOnLineInsertRange(insertStartLine, insertEndLine)
        }
        else if (deletedLineCount === 0) {
          caches.invalidateWrapTokensCacheForLine(startLine)
        }

        if (newlineCount > 0) {
          const lastNewlineIndex = text.lastIndexOf('\n')
          caret.line.value = startLine + newlineCount
          caret.column.value = lastNewlineIndex >= 0 ? text.length - lastNewlineIndex - 1 : startColumn + text.length
        }
        else {
          caret.line.value = startLine
          caret.column.value = startColumn + text.length
        }
        caret.columnIntent.value = caret.column.value
        selection.clear()
        return
      }
    }

    const newlineCount = (text.match(/\n/g) || []).length
    if (newlineCount > 0) {
      const insertLine = caret.line.value
      const insertColumn = caret.column.value
      const linesBeforeInsert = doc.lines.length

      adjustWidgetsOnLineSplit(doc, insertLine, insertColumn, newlineCount)

      doc.buffer.insert(insertLine, insertColumn, text)

      const linesAfterInsert = doc.lines.length
      const insertedLineCount = linesAfterInsert - linesBeforeInsert

      if (insertedLineCount > 0) {
        caches.adjustWrapTokensCacheOnLineInsertRange(insertLine + 1, insertLine + insertedLineCount)
        blocks.adjustOnLineInsertRange(insertLine + 1, insertLine + insertedLineCount)
      }

      const lastNewlineIndex = text.lastIndexOf('\n')
      if (lastNewlineIndex >= 0) {
        caret.line.value = insertLine + newlineCount
        caret.column.value = text.length - lastNewlineIndex - 1
      }
      else {
        caret.line.value++
        caret.column.value = 0
      }
    }
    else {
      const currentLine = doc.lines[caret.line.value] || ''
      const newLine = currentLine.slice(0, caret.column.value) + text + currentLine.slice(caret.column.value)
      adjustWidgetsOnColumnInsert(doc, caret.line.value, caret.column.value, text.length, newLine.length)
      caches.invalidateWrapTokensCacheForLine(caret.line.value)
      doc.buffer.insert(caret.line.value, caret.column.value, text)
      caret.column.value += text.length
    }
    caret.columnIntent.value = caret.column.value
    caret.isTyping.value = true
    caret.lastInputTime.value = Date.now()
  }

  function deleteSelection() {
    const ordered = selection.getOrdered.value
    if (!ordered) return false

    const startLine = ordered.start.line
    const endLine = ordered.end.line
    const startColumn = ordered.start.column
    const endColumn = ordered.end.column
    const selectionDirection = selection.direction.value

    const selectionDir = selectionDirection === 'forward' || selectionDirection === 'backward'
      ? selectionDirection
      : undefined
    const selectionObj = selectionDir
      ? {
        start: { line: startLine, column: startColumn },
        end: { line: endLine, column: endColumn },
        direction: selectionDir,
      }
      : undefined

    const startLineLength = doc.lines[startLine]?.length ?? 0
    adjustWidgetsOnMultiLineDelete(doc, startLine, startColumn, endLine, endColumn, startLineLength)

    doc.buffer.deleteSelection(
      { line: startLine, column: startColumn },
      { line: endLine, column: endColumn },
      selectionObj,
    )

    if (endLine > startLine) {
      caches.adjustWrapTokensCacheOnLineDeleteRange(startLine + 1, endLine)
      blocks.adjustOnLineDeleteRange(startLine + 1, endLine)
    }
    else {
      caches.invalidateWrapTokensCacheForLine(startLine)
    }

    caret.line.value = startLine
    caret.column.value = startColumn
    caret.columnIntent.value = caret.column.value
    selection.clear()
    return true
  }

  function deleteLine() {
    if (selection.hasSelection.value) {
      deleteSelection()
      return
    }

    const codeLines = doc.lines
    const currentLineNum = caret.line.value
    const currentColumn = caret.column.value
    const currentLine = codeLines[currentLineNum] || ''
    const caretPositionBefore = { line: currentLineNum, column: currentColumn }

    if (codeLines.length === 1) {
      adjustWidgetsOnColumnDelete(doc, currentLineNum, 0, currentLine.length)
      caches.invalidateWrapTokensCacheForLine(currentLineNum)
      const caretPositionAfter = { line: currentLineNum, column: 0 }
      doc.buffer.replaceSelection(
        { line: currentLineNum, column: 0 },
        { line: currentLineNum, column: currentLine.length },
        '',
        undefined,
        caretPositionBefore,
        undefined,
        caretPositionAfter,
      )
      caret.column.value = 0
    }
    else if (currentLineNum < codeLines.length - 1) {
      const nextLine = codeLines[currentLineNum + 1] || ''
      const nextLineLength = nextLine.length
      const preservedColumn = Math.min(currentColumn, nextLineLength)

      adjustWidgetsOnNextLineMerge(doc, currentLineNum, currentLine.length)
      caches.invalidateWrapTokensCacheForLine(currentLineNum)
      const caretPositionAfter = { line: currentLineNum, column: preservedColumn }
      doc.buffer.replaceSelection(
        { line: currentLineNum, column: 0 },
        { line: currentLineNum + 1, column: 0 },
        '',
        undefined,
        caretPositionBefore,
        undefined,
        caretPositionAfter,
      )
      caches.adjustWrapTokensCacheOnLineDelete(currentLineNum + 1)
      blocks.adjustOnLineDelete(currentLineNum + 1)
      caret.column.value = preservedColumn
    }
    else {
      const prevLineNum = currentLineNum - 1
      const prevLine = codeLines[prevLineNum] || ''
      const prevLineLength = prevLine.length
      const preservedColumn = Math.min(currentColumn, prevLineLength)

      adjustWidgetsOnLineMerge(doc, currentLineNum, prevLineLength)
      caches.invalidateWrapTokensCacheForLine(prevLineNum)
      const caretPositionAfter = { line: prevLineNum, column: preservedColumn }
      doc.buffer.replaceSelection(
        { line: currentLineNum, column: 0 },
        { line: currentLineNum, column: currentLine.length },
        '',
        undefined,
        caretPositionBefore,
        undefined,
        caretPositionAfter,
      )
      caches.adjustWrapTokensCacheOnLineDelete(currentLineNum)
      blocks.adjustOnLineDelete(currentLineNum)
      caret.line.value = prevLineNum
      caret.column.value = preservedColumn
    }
    caret.columnIntent.value = caret.column.value
    caret.lastInputTime.value = Date.now()
  }

  function deleteChar() {
    if (selection.hasSelection.value) {
      deleteSelection()
      return
    }

    const codeLines = doc.lines
    const currentLine = codeLines[caret.line.value] || ''
    if (caret.column.value < currentLine.length) {
      adjustWidgetsOnColumnDelete(doc, caret.line.value, caret.column.value, 1)
      caches.invalidateWrapTokensCacheForLine(caret.line.value)
      doc.buffer.del(caret.line.value, caret.column.value)
    }
    else if (caret.line.value < codeLines.length - 1) {
      adjustWidgetsOnNextLineMerge(doc, caret.line.value, currentLine.length)
      caches.invalidateWrapTokensCacheForLine(caret.line.value)
      doc.buffer.del(caret.line.value, caret.column.value)
      caches.adjustWrapTokensCacheOnLineDelete(caret.line.value + 1)
      blocks.adjustOnLineDelete(caret.line.value + 1)
    }
    caret.columnIntent.value = caret.column.value
    caret.lastInputTime.value = Date.now()
  }

  function backspace() {
    if (selection.hasSelection.value) {
      deleteSelection()
      return
    }

    const codeLines = doc.lines
    const currentLine = codeLines[caret.line.value] || ''
    if (caret.column.value > 0) {
      if (caret.column.value % 2 === 0 && caret.column.value >= 2
        && currentLine[caret.column.value - 2] === ' ' && currentLine[caret.column.value - 1] === ' ')
      {
        adjustWidgetsOnColumnDelete(doc, caret.line.value, caret.column.value - 2, 2)
        caches.invalidateWrapTokensCacheForLine(caret.line.value)
        doc.buffer.replaceSelection(
          { line: caret.line.value, column: caret.column.value - 2 },
          { line: caret.line.value, column: caret.column.value },
          '',
        )
        caret.column.value -= 2
      }
      else {
        const charBefore = currentLine[caret.column.value - 1]
        const bracePairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
        const stringDelimiters = new Set(['\'', '"', '`'])
        const matchingClose = charBefore && bracePairs[charBefore] ? bracePairs[charBefore] : null
        const isStringDelimiter = charBefore && stringDelimiters.has(charBefore)
        const shouldDeletePair = (matchingClose && caret.column.value < currentLine.length
          && currentLine[caret.column.value] === matchingClose)
          || (isStringDelimiter && caret.column.value < currentLine.length
            && currentLine[caret.column.value] === charBefore)

        if (shouldDeletePair) {
          const caretPositionBefore = { line: caret.line.value, column: caret.column.value }
          const caretPositionAfter = { line: caret.line.value, column: caret.column.value - 1 }

          adjustWidgetsOnColumnDelete(doc, caret.line.value, caret.column.value - 1, 2)
          caches.invalidateWrapTokensCacheForLine(caret.line.value)
          doc.buffer.replaceSelection(
            { line: caret.line.value, column: caret.column.value - 1 },
            { line: caret.line.value, column: caret.column.value + 1 },
            '',
            undefined,
            caretPositionBefore,
            undefined,
            caretPositionAfter,
          )
          caret.column.value--
        }
        else {
          adjustWidgetsOnColumnDelete(doc, caret.line.value, caret.column.value - 1, 1)
          caches.invalidateWrapTokensCacheForLine(caret.line.value)
          doc.buffer.backspace(caret.line.value, caret.column.value)
          caret.column.value--
        }
      }
    }
    else if (caret.line.value > 0) {
      const prevLine = codeLines[caret.line.value - 1] || ''
      const newColumn = prevLine.length
      adjustWidgetsOnLineMerge(doc, caret.line.value, prevLine.length)
      caches.invalidateWrapTokensCacheForLine(caret.line.value - 1)
      doc.buffer.backspace(caret.line.value, caret.column.value)
      caches.adjustWrapTokensCacheOnLineDelete(caret.line.value)
      blocks.adjustOnLineDelete(caret.line.value)
      caret.line.value--
      caret.column.value = newColumn
    }
    caret.columnIntent.value = caret.column.value
    caret.lastInputTime.value = Date.now()
  }

  function findWordStart(line: number, column: number): { line: number; column: number } {
    const codeLines = doc.lines
    const currentLine = codeLines[line] || ''
    const currentColumn = column

    if (currentColumn > 0) {
      let newColumn = currentColumn - 1

      if (newColumn >= 0) {
        const char = currentLine[newColumn]
        const isWordChar = /[a-zA-Z0-9_]/.test(char)
        const isPunct = /[^\s\w]/.test(char)

        if (isWordChar) {
          while (newColumn > 0 && /[a-zA-Z0-9_]/.test(currentLine[newColumn - 1])) {
            newColumn--
          }
        }
        else if (isPunct) {
          while (newColumn > 0 && /[^\s\w]/.test(currentLine[newColumn - 1])) {
            newColumn--
          }
        }
        else {
          while (newColumn > 0 && /\s/.test(currentLine[newColumn - 1])) {
            newColumn--
          }
        }
      }

      return { line, column: newColumn }
    }
    else if (line > 0) {
      const prevLine = codeLines[line - 1] || ''
      return { line: line - 1, column: prevLine.length }
    }

    return { line, column: 0 }
  }

  function findWordEnd(line: number, column: number): { line: number; column: number } {
    const codeLines = doc.lines
    const currentLine = codeLines[line] || ''
    const currentLineLength = currentLine.length
    const currentColumn = column

    if (currentColumn < currentLineLength) {
      let newColumn = currentColumn

      if (newColumn < currentLineLength) {
        const char = currentLine[newColumn]
        const isWordChar = /[a-zA-Z0-9_]/.test(char)
        const isPunct = /[^\s\w]/.test(char)

        if (isWordChar) {
          while (newColumn < currentLineLength && /[a-zA-Z0-9_]/.test(currentLine[newColumn])) {
            newColumn++
          }
        }
        else if (isPunct) {
          while (newColumn < currentLineLength && /[^\s\w]/.test(currentLine[newColumn])) {
            newColumn++
          }
        }
        else {
          while (newColumn < currentLineLength && /\s/.test(currentLine[newColumn])) {
            newColumn++
          }
        }
      }

      return { line, column: newColumn }
    }
    else if (line < codeLines.length - 1) {
      return { line: line + 1, column: 0 }
    }

    return { line, column: currentLineLength }
  }

  function deleteWordLeft() {
    if (selection.hasSelection.value) {
      deleteSelection()
      return
    }

    const codeLines = doc.lines
    const currentLine = caret.line.value
    const currentColumn = caret.column.value

    const wordStart = findWordStart(currentLine, currentColumn)
    const startLine = wordStart.line
    const startColumn = wordStart.column
    const endLine = currentLine
    const endColumn = currentColumn

    if (startLine === endLine && startColumn === endColumn) {
      return
    }

    const startLineLength = doc.lines[startLine]?.length ?? 0
    adjustWidgetsOnMultiLineDelete(doc, startLine, startColumn, endLine, endColumn, startLineLength)

    if (startLine === endLine) {
      caches.invalidateWrapTokensCacheForLine(startLine)
    }
    else {
      caches.invalidateWrapTokensCacheForLine(startLine)
      if (endLine > startLine) {
        caches.adjustWrapTokensCacheOnLineDeleteRange(startLine + 1, endLine)
        blocks.adjustOnLineDeleteRange(startLine + 1, endLine)
      }
    }

    doc.buffer.deleteSelection(
      { line: startLine, column: startColumn },
      { line: endLine, column: endColumn },
      undefined,
      true,
      { line: endLine, column: endColumn },
    )

    caret.line.value = startLine
    caret.column.value = startColumn
    caret.columnIntent.value = startColumn
    caret.lastInputTime.value = Date.now()
  }

  function deleteWordRight() {
    if (selection.hasSelection.value) {
      deleteSelection()
      return
    }

    const codeLines = doc.lines
    const currentLine = caret.line.value
    const currentColumn = caret.column.value

    const wordEnd = findWordEnd(currentLine, currentColumn)
    const startLine = currentLine
    const startColumn = currentColumn
    const endLine = wordEnd.line
    const endColumn = wordEnd.column

    if (startLine === endLine && startColumn === endColumn) {
      return
    }

    const startLineLength = doc.lines[startLine]?.length ?? 0
    adjustWidgetsOnMultiLineDelete(doc, startLine, startColumn, endLine, endColumn, startLineLength)

    if (startLine === endLine) {
      caches.invalidateWrapTokensCacheForLine(startLine)
    }
    else {
      caches.invalidateWrapTokensCacheForLine(startLine)
      if (endLine > startLine) {
        caches.adjustWrapTokensCacheOnLineDeleteRange(startLine + 1, endLine)
        blocks.adjustOnLineDeleteRange(startLine + 1, endLine)
      }
    }

    doc.buffer.deleteSelection(
      { line: startLine, column: startColumn },
      { line: endLine, column: endColumn },
      undefined,
      true,
      { line: startLine, column: startColumn },
    )

    caret.columnIntent.value = caret.column.value
    caret.lastInputTime.value = Date.now()
  }

  function moveLeft(shift: boolean) {
    const originalLine = caret.line.value
    const originalColumn = caret.column.value

    if (shift) {
      if (!selection.hasSelection.value) {
        selection.setStart(originalLine, originalColumn)
      }
    }
    else {
      selection.clear()
    }

    if (caret.column.value > 0) {
      caret.column.value--
    }
    else if (caret.line.value > 0) {
      caret.line.value--
      const codeLines = doc.lines
      caret.column.value = codeLines[caret.line.value]?.length || 0
    }
    caret.columnIntent.value = caret.column.value

    if (shift) {
      selection.setEnd(caret.line.value, caret.column.value)
    }
  }

  function moveRight(shift: boolean) {
    const originalLine = caret.line.value
    const originalColumn = caret.column.value

    if (shift) {
      if (!selection.hasSelection.value) {
        selection.setStart(originalLine, originalColumn)
      }
    }
    else {
      selection.clear()
    }

    const codeLines = doc.lines
    const currentLineLength = codeLines[caret.line.value]?.length || 0
    if (caret.column.value < currentLineLength) {
      caret.column.value++
    }
    else if (caret.line.value < codeLines.length - 1) {
      caret.line.value++
      caret.column.value = 0
    }
    caret.columnIntent.value = caret.column.value

    if (shift) {
      selection.setEnd(caret.line.value, caret.column.value)
    }
  }

  function moveWordLeft(shift: boolean) {
    const originalLine = caret.line.value
    const originalColumn = caret.column.value

    if (shift) {
      if (!selection.hasSelection.value) {
        selection.setStart(originalLine, originalColumn)
      }
    }
    else {
      selection.clear()
    }

    const codeLines = doc.lines
    const currentLine = codeLines[caret.line.value] || ''
    const currentColumn = caret.column.value

    if (currentColumn > 0) {
      let newColumn = currentColumn - 1

      if (newColumn >= 0) {
        const char = currentLine[newColumn]
        const isWordChar = /[a-zA-Z0-9_]/.test(char)
        const isPunct = /[^\s\w]/.test(char)

        if (isWordChar) {
          while (newColumn > 0 && /[a-zA-Z0-9_]/.test(currentLine[newColumn - 1])) {
            newColumn--
          }
        }
        else if (isPunct) {
          while (newColumn > 0 && /[^\s\w]/.test(currentLine[newColumn - 1])) {
            newColumn--
          }
        }
        else {
          while (newColumn > 0 && /\s/.test(currentLine[newColumn - 1])) {
            newColumn--
          }
        }
      }

      caret.column.value = newColumn
    }
    else if (caret.line.value > 0) {
      caret.line.value--
      const prevLine = codeLines[caret.line.value] || ''
      caret.column.value = prevLine.length
    }
    caret.columnIntent.value = caret.column.value

    if (shift) {
      selection.setEnd(caret.line.value, caret.column.value)
    }
  }

  function moveWordRight(shift: boolean) {
    const originalLine = caret.line.value
    const originalColumn = caret.column.value

    if (shift) {
      if (!selection.hasSelection.value) {
        selection.setStart(originalLine, originalColumn)
      }
    }
    else {
      selection.clear()
    }

    const codeLines = doc.lines
    const currentLine = codeLines[caret.line.value] || ''
    const currentLineLength = currentLine.length
    const currentColumn = caret.column.value

    if (currentColumn < currentLineLength) {
      let newColumn = currentColumn

      if (newColumn < currentLineLength) {
        const char = currentLine[newColumn]
        const isWordChar = /[a-zA-Z0-9_]/.test(char)
        const isPunct = /[^\s\w]/.test(char)

        if (isWordChar) {
          while (newColumn < currentLineLength && /[a-zA-Z0-9_]/.test(currentLine[newColumn])) {
            newColumn++
          }
        }
        else if (isPunct) {
          while (newColumn < currentLineLength && /[^\s\w]/.test(currentLine[newColumn])) {
            newColumn++
          }
        }
        else {
          while (newColumn < currentLineLength && /\s/.test(currentLine[newColumn])) {
            newColumn++
          }
        }
      }

      caret.column.value = newColumn
    }
    else if (caret.line.value < codeLines.length - 1) {
      caret.line.value++
      caret.column.value = 0
    }
    caret.columnIntent.value = caret.column.value

    if (shift) {
      selection.setEnd(caret.line.value, caret.column.value)
    }
  }

  function getVisualLineColumnRange(visualLine: VisualLine, tokenLines: Token[][],
    visualLines: VisualLine[]): [start: number, end: number]
  {
    const logicalLine = visualLine.logicalLine
    const logicalLineTokens = tokenLines[logicalLine] || []

    let lineStartColumn = 0
    for (let i = 0; i < visualLine.tokenOffset; i++) {
      lineStartColumn += logicalLineTokens[i]?.text.length || 0
    }

    let lineEndColumn = lineStartColumn
    for (const visualToken of visualLine.tokens) {
      lineEndColumn += visualToken.token.text.length
    }

    return [lineStartColumn, lineEndColumn]
  }

  function moveUp(shift: boolean) {
    const originalLine = caret.line.value
    const originalColumn = caret.column.value

    if (shift) {
      if (!selection.hasSelection.value) {
        selection.setStart(originalLine, originalColumn)
      }
    }
    else {
      selection.clear()
    }

    const tokenLines = doc.tokenLines
    const codeLines = doc.lines
    const intendedColumn = caret.columnIntent.value

    const visualLines = lines.visualLines.value
    if (visualLines.length === 0) return

    const sourceVisualLine = findVisualLineForColumn(
      lines,
      caret.line.value,
      caret.column.value,
      tokenLines,
      caches,
    )
    if (!sourceVisualLine) return

    const sourceIndex = visualLines.indexOf(sourceVisualLine)
    if (sourceIndex <= 0) return

    const targetVisualLine = visualLines[sourceIndex - 1]
    const [targetStartColumn, targetEndColumn] = getVisualLineColumnRange(
      targetVisualLine,
      tokenLines,
      visualLines,
    )

    let targetColumn: number

    if (intendedColumn >= targetStartColumn && intendedColumn <= targetEndColumn) {
      targetColumn = intendedColumn
    }
    else {
      const sourceX = getXFromColumn(
        lines,
        sourceVisualLine,
        intendedColumn,
        tokenLines,
        canvas,
        settings,
        caches,
      )

      targetColumn = getColumnFromVisualPosition(
        lines,
        targetVisualLine,
        sourceX,
        tokenLines,
        codeLines,
        canvas,
        settings,
        caches,
      )
    }

    const targetLineLength = codeLines[targetVisualLine.logicalLine]?.length ?? 0
    if (targetColumn > targetLineLength) {
      targetColumn = targetLineLength
    }

    caret.line.value = targetVisualLine.logicalLine
    caret.column.value = targetColumn

    if (shift) {
      selection.setEnd(caret.line.value, caret.column.value)
    }
  }

  function moveDown(shift: boolean) {
    const originalLine = caret.line.value
    const originalColumn = caret.column.value

    if (shift) {
      if (!selection.hasSelection.value) {
        selection.setStart(originalLine, originalColumn)
      }
    }
    else {
      selection.clear()
    }

    const tokenLines = doc.tokenLines
    const codeLines = doc.lines
    const intendedColumn = caret.columnIntent.value

    const visualLines = lines.visualLines.value
    if (visualLines.length === 0) return

    const sourceVisualLine = findVisualLineForColumn(
      lines,
      caret.line.value,
      caret.column.value,
      tokenLines,
      caches,
    )
    if (!sourceVisualLine) return

    const sourceIndex = visualLines.indexOf(sourceVisualLine)
    if (sourceIndex < 0 || sourceIndex >= visualLines.length - 1) return

    const targetVisualLine = visualLines[sourceIndex + 1]
    const [targetStartColumn, targetEndColumn] = getVisualLineColumnRange(
      targetVisualLine,
      tokenLines,
      visualLines,
    )

    let targetColumn: number

    if (intendedColumn >= targetStartColumn && intendedColumn <= targetEndColumn) {
      targetColumn = intendedColumn
    }
    else {
      const sourceX = getXFromColumn(
        lines,
        sourceVisualLine,
        intendedColumn,
        tokenLines,
        canvas,
        settings,
        caches,
      )

      targetColumn = getColumnFromVisualPosition(
        lines,
        targetVisualLine,
        sourceX,
        tokenLines,
        codeLines,
        canvas,
        settings,
        caches,
      )
    }

    const targetLineLength = codeLines[targetVisualLine.logicalLine]?.length ?? 0
    if (targetColumn > targetLineLength) {
      targetColumn = targetLineLength
    }

    caret.line.value = targetVisualLine.logicalLine
    caret.column.value = targetColumn

    if (shift) {
      selection.setEnd(caret.line.value, caret.column.value)
    }
  }

  function moveHome(shift: boolean) {
    const originalLine = caret.line.value
    const originalColumn = caret.column.value

    if (shift) {
      if (!selection.hasSelection.value) {
        selection.setStart(originalLine, originalColumn)
      }
    }
    else {
      selection.clear()
    }

    const codeLines = doc.lines
    const currentLine = caret.line.value
    const currentColumn = caret.column.value
    const line = codeLines[currentLine] || ''

    // Find the start of text (first non-whitespace character)
    const textStartIndex = line.search(/\S/)
    const textStartColumn = textStartIndex >= 0 ? textStartIndex : 0

    // Three-state behavior:
    // 1. If at 0: move to text start
    // 2. If at text start: move to 0
    // 3. Otherwise: move to text start
    let targetColumn: number
    if (currentColumn === 0) {
      targetColumn = textStartColumn
    }
    else if (currentColumn === textStartColumn) {
      targetColumn = 0
    }
    else {
      targetColumn = textStartColumn
    }

    caret.column.value = targetColumn
    caret.columnIntent.value = targetColumn

    if (shift) {
      selection.setEnd(caret.line.value, caret.column.value)
    }
  }

  function moveEnd(shift: boolean) {
    const originalLine = caret.line.value
    const originalColumn = caret.column.value

    if (shift) {
      if (!selection.hasSelection.value) {
        selection.setStart(originalLine, originalColumn)
      }
    }
    else {
      selection.clear()
    }

    const codeLines = doc.lines
    const visualLines = lines.visualLines.value
    const tokenLines = doc.tokenLines
    const currentLine = caret.line.value
    const currentColumn = caret.column.value

    const currentVisualLine = findVisualLineForColumn(lines, currentLine, currentColumn, tokenLines, caches)
    if (currentVisualLine) {
      const [, endColumn] = getVisualLineColumnRange(currentVisualLine, tokenLines, visualLines)
      if (currentColumn === endColumn) {
        caret.column.value = codeLines[currentLine]?.length || 0
      }
      else {
        caret.column.value = endColumn
      }
    }
    else {
      caret.column.value = codeLines[currentLine]?.length || 0
    }
    caret.columnIntent.value = caret.column.value

    if (shift) {
      selection.setEnd(caret.line.value, caret.column.value)
    }
  }

  function movePageUp(shift: boolean) {
    const originalLine = caret.line.value
    const originalColumn = caret.column.value

    if (shift) {
      if (!selection.hasSelection.value) {
        selection.setStart(originalLine, originalColumn)
      }
    }
    else {
      selection.clear()
    }

    const tokenLines = doc.tokenLines
    const codeLines = doc.lines
    const currentLine = caret.line.value
    const currentColumn = caret.column.value
    const intendedColumn = caret.columnIntent.value

    const currentVisualLine = findVisualLineForColumn(lines, currentLine, currentColumn, tokenLines, caches)
    if (!currentVisualLine) {
      if (caret.line.value > 0) {
        caret.line.value = 0
        const firstLineLength = codeLines[0]?.length || 0
        caret.column.value = Math.min(intendedColumn, firstLineLength)
      }
      if (shift) {
        selection.setEnd(caret.line.value, caret.column.value)
      }
      return
    }

    const visualLines = lines.visualLines.value
    const currentVisualLineIndex = visualLines.findIndex(line => line === currentVisualLine)
    if (currentVisualLineIndex < 0) {
      if (shift) {
        selection.setEnd(caret.line.value, caret.column.value)
      }
      return
    }

    const headerHeight = header.value?.height ?? 0
    const verticalScrollbarSize = getVerticalScrollbarSize(settings)
    const needsVertical =
      lines.totalHeight.value > canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
    const availableWidth = canvas.size.width.value - settings.paddingLeft
      - metrics.gutterWidth.value
      - (needsVertical ? verticalScrollbarSize : 0)
    const needsHorizontal = !settings.wordWrap && lines.totalWidth.value > availableWidth
    const availableHeight = canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
      - (needsHorizontal ? HORIZONTAL_SCROLLBAR_SIZE : 0)

    const viewportHeight = Math.max(1, Math.floor(availableHeight / settings.lineHeight))
    const targetVisualLineIndex = Math.max(0, currentVisualLineIndex - viewportHeight)

    if (targetVisualLineIndex === 0 && currentVisualLineIndex < viewportHeight) {
      if (caret.line.value === 0) {
        caret.column.value = 0
      }
      else {
        const firstLineLength = codeLines[0]?.length || 0
        caret.line.value = 0
        caret.column.value = Math.min(intendedColumn, firstLineLength)
      }
    }
    else if (targetVisualLineIndex < visualLines.length) {
      const targetVisualLine = visualLines[targetVisualLineIndex]
      const [targetStartColumn, targetEndColumn] = getVisualLineColumnRange(targetVisualLine, tokenLines, visualLines)

      if (intendedColumn >= targetStartColumn && intendedColumn <= targetEndColumn) {
        caret.line.value = targetVisualLine.logicalLine
        caret.column.value = intendedColumn
      }
      else {
        const currentX = getXFromColumn(lines, currentVisualLine, currentColumn, tokenLines, canvas, settings, caches)
        const targetColumn = getColumnFromVisualPosition(
          lines,
          targetVisualLine,
          currentX,
          tokenLines,
          codeLines,
          canvas,
          settings,
          caches,
        )
        caret.line.value = targetVisualLine.logicalLine
        caret.column.value = targetColumn
      }
    }
    else if (caret.line.value > 0) {
      caret.line.value = 0
      const firstLineLength = codeLines[0]?.length || 0
      caret.column.value = Math.min(intendedColumn, firstLineLength)
    }

    if (shift) {
      selection.setEnd(caret.line.value, caret.column.value)
    }
  }

  function movePageDown(shift: boolean) {
    const originalLine = caret.line.value
    const originalColumn = caret.column.value

    if (shift) {
      if (!selection.hasSelection.value) {
        selection.setStart(originalLine, originalColumn)
      }
    }
    else {
      selection.clear()
    }

    const tokenLines = doc.tokenLines
    const codeLines = doc.lines
    const currentLine = caret.line.value
    const currentColumn = caret.column.value
    const intendedColumn = caret.columnIntent.value

    const currentVisualLine = findVisualLineForColumn(lines, currentLine, currentColumn, tokenLines, caches)
    if (!currentVisualLine) {
      if (caret.line.value < codeLines.length - 1) {
        caret.line.value = codeLines.length - 1
        const lastLineLength = codeLines[codeLines.length - 1]?.length || 0
        caret.column.value = Math.min(intendedColumn, lastLineLength)
      }
      if (shift) {
        selection.setEnd(caret.line.value, caret.column.value)
      }
      return
    }

    const visualLines = lines.visualLines.value
    const currentVisualLineIndex = visualLines.findIndex(line => line === currentVisualLine)
    if (currentVisualLineIndex < 0) {
      if (shift) {
        selection.setEnd(caret.line.value, caret.column.value)
      }
      return
    }

    const headerHeight = header.value?.height ?? 0
    const verticalScrollbarSize = getVerticalScrollbarSize(settings)
    const needsVertical =
      lines.totalHeight.value > canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
    const availableWidth = canvas.size.width.value - settings.paddingLeft
      - metrics.gutterWidth.value
      - (needsVertical ? verticalScrollbarSize : 0)
    const needsHorizontal = lines.totalWidth.value > availableWidth
    const availableHeight = canvas.size.height.value - headerHeight - settings.paddingTop - settings.paddingBottom
      - (needsHorizontal ? HORIZONTAL_SCROLLBAR_SIZE : 0)

    const viewportHeight = Math.max(1, Math.floor(availableHeight / settings.lineHeight))
    const lastVisualLineIndex = visualLines.length - 1
    const targetVisualLineIndex = Math.min(lastVisualLineIndex, currentVisualLineIndex + viewportHeight)

    if (targetVisualLineIndex === lastVisualLineIndex
      && currentVisualLineIndex + viewportHeight > lastVisualLineIndex)
    {
      const lastLineIndex = codeLines.length - 1
      if (caret.line.value === lastLineIndex) {
        const lastLineLength = codeLines[lastLineIndex]?.length || 0
        caret.column.value = lastLineLength
      }
      else {
        const lastLineLength = codeLines[lastLineIndex]?.length || 0
        caret.line.value = lastLineIndex
        caret.column.value = Math.min(intendedColumn, lastLineLength)
      }
    }
    else if (targetVisualLineIndex >= 0 && targetVisualLineIndex < visualLines.length) {
      const targetVisualLine = visualLines[targetVisualLineIndex]
      const [targetStartColumn, targetEndColumn] = getVisualLineColumnRange(targetVisualLine, tokenLines, visualLines)

      if (intendedColumn >= targetStartColumn && intendedColumn <= targetEndColumn) {
        caret.line.value = targetVisualLine.logicalLine
        caret.column.value = intendedColumn
      }
      else {
        const currentX = getXFromColumn(lines, currentVisualLine, currentColumn, tokenLines, canvas, settings, caches)
        const targetColumn = getColumnFromVisualPosition(
          lines,
          targetVisualLine,
          currentX,
          tokenLines,
          codeLines,
          canvas,
          settings,
          caches,
        )
        caret.line.value = targetVisualLine.logicalLine
        caret.column.value = targetColumn
      }
    }
    else if (caret.line.value < codeLines.length - 1) {
      caret.line.value = codeLines.length - 1
      const lastLineLength = codeLines[codeLines.length - 1]?.length || 0
      caret.column.value = Math.min(intendedColumn, lastLineLength)
    }

    if (shift) {
      selection.setEnd(caret.line.value, caret.column.value)
    }
  }

  function moveLineUp() {
    const codeLines = doc.lines
    let startLine: number
    let endLine: number

    const caretPositionBefore = { line: caret.line.value, column: caret.column.value }
    const hadSelection = selection.hasSelection.value

    if (hadSelection) {
      const ordered = selection.getOrdered.value
      if (!ordered) return
      startLine = ordered.start.line
      endLine = ordered.end.line
    }
    else {
      startLine = caret.line.value
      endLine = caret.line.value
    }

    if (startLine === 0) return

    const linesToMove = endLine - startLine + 1
    const targetLine = startLine - 1

    const linesText: string[] = []
    for (let i = startLine; i <= endLine; i++) {
      linesText.push(codeLines[i] || '')
    }
    const movedText = linesText.join('\n')
    const targetText = codeLines[targetLine] || ''

    const newText = movedText + '\n' + targetText

    caches.adjustWrapTokensCacheOnLineDeleteRange(targetLine, endLine)
    blocks.adjustOnLineDeleteRange(targetLine, endLine)

    const endColumn = codeLines[endLine]?.length || 0
    let caretPositionAfter: { line: number; column: number }
    let selectionBefore: { start: { line: number; column: number }; end: { line: number; column: number };
      direction: 'forward' | 'backward' } | undefined
    let selectionAfter: { start: { line: number; column: number }; end: { line: number; column: number };
      direction: 'forward' | 'backward' } | undefined

    if (hadSelection) {
      const ordered = selection.getOrdered.value
      if (ordered) {
        const startColumn = ordered.start.column
        const endColumn = ordered.end.column
        const selectionDirection = selection.direction.value
        if (selectionDirection === 'forward' || selectionDirection === 'backward') {
          selectionBefore = {
            start: { line: startLine, column: startColumn },
            end: { line: endLine, column: endColumn },
            direction: selectionDirection,
          }
          if (selectionDirection === 'backward') {
            caretPositionAfter = { line: targetLine, column: startColumn }
            selectionAfter = {
              start: { line: targetLine + linesToMove - 1, column: endColumn },
              end: { line: targetLine, column: startColumn },
              direction: selectionDirection,
            }
          }
          else {
            caretPositionAfter = { line: targetLine + linesToMove - 1, column: endColumn }
            selectionAfter = {
              start: { line: targetLine, column: startColumn },
              end: { line: targetLine + linesToMove - 1, column: endColumn },
              direction: selectionDirection,
            }
          }
        }
        else {
          caretPositionAfter = caretPositionBefore
        }
      }
      else {
        caretPositionAfter = caretPositionBefore
      }
    }
    else {
      caretPositionAfter = { line: targetLine, column: caret.column.value }
    }

    doc.buffer.replaceSelection(
      { line: targetLine, column: 0 },
      { line: endLine, column: endColumn },
      newText,
      selectionBefore,
      caretPositionBefore,
      selectionAfter,
      caretPositionAfter,
    )

    caches.adjustWrapTokensCacheOnLineInsertRange(targetLine, targetLine + linesToMove)
    blocks.adjustOnLineInsertRange(targetLine, targetLine + linesToMove)

    if (selection.hasSelection.value) {
      const ordered = selection.getOrdered.value
      if (ordered) {
        const startColumn = ordered.start.column
        const endColumn = ordered.end.column
        const selectionDirection = selection.direction.value
        if (selectionDirection === 'backward') {
          caret.line.value = targetLine
          caret.column.value = startColumn
          selection.setStart(targetLine + linesToMove - 1, endColumn)
          selection.setEnd(targetLine, startColumn)
        }
        else {
          caret.line.value = targetLine + linesToMove - 1
          caret.column.value = endColumn
          selection.setStart(targetLine, startColumn)
          selection.setEnd(targetLine + linesToMove - 1, endColumn)
        }
      }
    }
    else {
      caret.line.value = targetLine
    }
    caret.columnIntent.value = caret.column.value
  }

  function moveLineDown() {
    const codeLines = doc.lines
    let startLine: number
    let endLine: number

    const caretPositionBefore = { line: caret.line.value, column: caret.column.value }
    const hadSelection = selection.hasSelection.value

    if (hadSelection) {
      const ordered = selection.getOrdered.value
      if (!ordered) return
      startLine = ordered.start.line
      endLine = ordered.end.line
    }
    else {
      startLine = caret.line.value
      endLine = caret.line.value
    }

    if (endLine >= codeLines.length - 1) return

    const linesToMove = endLine - startLine + 1
    const targetLine = endLine + 1

    const linesText: string[] = []
    for (let i = startLine; i <= endLine; i++) {
      linesText.push(codeLines[i] || '')
    }
    const movedText = linesText.join('\n')
    const targetText = codeLines[targetLine] || ''

    const newText = targetText + '\n' + movedText

    caches.adjustWrapTokensCacheOnLineDeleteRange(startLine, targetLine)
    blocks.adjustOnLineDeleteRange(startLine, targetLine)

    const targetColumn = codeLines[targetLine]?.length || 0
    let caretPositionAfter: { line: number; column: number }
    let selectionBefore: { start: { line: number; column: number }; end: { line: number; column: number };
      direction: 'forward' | 'backward' } | undefined
    let selectionAfter: { start: { line: number; column: number }; end: { line: number; column: number };
      direction: 'forward' | 'backward' } | undefined

    if (hadSelection) {
      const ordered = selection.getOrdered.value
      if (ordered) {
        const startColumn = ordered.start.column
        const endColumn = ordered.end.column
        const selectionDirection = selection.direction.value
        if (selectionDirection === 'forward' || selectionDirection === 'backward') {
          selectionBefore = {
            start: { line: startLine, column: startColumn },
            end: { line: endLine, column: endColumn },
            direction: selectionDirection,
          }
          if (selectionDirection === 'backward') {
            caretPositionAfter = { line: startLine + 1, column: startColumn }
            selectionAfter = {
              start: { line: startLine + linesToMove, column: endColumn },
              end: { line: startLine + 1, column: startColumn },
              direction: selectionDirection,
            }
          }
          else {
            caretPositionAfter = { line: startLine + linesToMove, column: endColumn }
            selectionAfter = {
              start: { line: startLine + 1, column: startColumn },
              end: { line: startLine + linesToMove, column: endColumn },
              direction: selectionDirection,
            }
          }
        }
        else {
          caretPositionAfter = caretPositionBefore
        }
      }
      else {
        caretPositionAfter = caretPositionBefore
      }
    }
    else {
      caretPositionAfter = { line: startLine + 1, column: caret.column.value }
    }

    doc.buffer.replaceSelection(
      { line: startLine, column: 0 },
      { line: targetLine, column: targetColumn },
      newText,
      selectionBefore,
      caretPositionBefore,
      selectionAfter,
      caretPositionAfter,
    )

    caches.adjustWrapTokensCacheOnLineInsertRange(startLine, startLine + linesToMove)
    blocks.adjustOnLineInsertRange(startLine, startLine + linesToMove)

    if (selection.hasSelection.value) {
      const ordered = selection.getOrdered.value
      if (ordered) {
        const startColumn = ordered.start.column
        const endColumn = ordered.end.column
        const selectionDirection = selection.direction.value
        if (selectionDirection === 'backward') {
          caret.line.value = startLine + 1
          caret.column.value = startColumn
          selection.setStart(startLine + linesToMove, endColumn)
          selection.setEnd(startLine + 1, startColumn)
        }
        else {
          caret.line.value = startLine + linesToMove
          caret.column.value = endColumn
          selection.setStart(startLine + 1, startColumn)
          selection.setEnd(startLine + linesToMove, endColumn)
        }
      }
    }
    else {
      caret.line.value = startLine + 1
    }
    caret.columnIntent.value = caret.column.value
  }

  function duplicateLine() {
    const codeLines = doc.lines
    let startLine: number
    let endLine: number

    if (selection.hasSelection.value) {
      const ordered = selection.getOrdered.value
      if (!ordered) return
      startLine = ordered.start.line
      endLine = ordered.end.line
    }
    else {
      startLine = caret.line.value
      endLine = caret.line.value
    }

    const linesText: string[] = []
    for (let i = startLine; i <= endLine; i++) {
      linesText.push(codeLines[i] || '')
    }
    const textToDuplicate = linesText.join('\n')

    const linesBeforeInsert = doc.lines.length
    const newlineCount = (textToDuplicate.match(/\n/g) || []).length
    const insertedLineCount = newlineCount > 0 ? newlineCount : 0

    const endColumn = codeLines[endLine]?.length || 0
    const textToInsert = '\n' + textToDuplicate
    const insertLine = endLine
    const insertColumn = endColumn

    adjustWidgetsOnLineSplit(doc, insertLine, insertColumn, insertedLineCount + 1)
    doc.buffer.insert(insertLine, insertColumn, textToInsert)

    const linesAfterInsert = doc.lines.length
    const actualInsertedLineCount = linesAfterInsert - linesBeforeInsert
    const newStartLine = insertLine + 1

    if (actualInsertedLineCount > 0) {
      const insertEndLine = newStartLine + actualInsertedLineCount - 1
      caches.adjustWrapTokensCacheOnLineInsertRange(newStartLine, insertEndLine)
      blocks.adjustOnLineInsertRange(newStartLine, insertEndLine)
    }

    if (selection.hasSelection.value) {
      const ordered = selection.getOrdered.value
      if (ordered) {
        const newEndLine = newStartLine + (endLine - startLine)
        caret.line.value = newEndLine
        caret.column.value = ordered.end.column
        selection.setStart(newStartLine, ordered.start.column)
        selection.setEnd(newEndLine, ordered.end.column)
      }
    }
    else {
      const originalColumn = caret.column.value
      caret.line.value = newStartLine
      caret.column.value = originalColumn
    }
    caret.columnIntent.value = caret.column.value
  }

  function ensureCaretVisible() {
    if (caret.suppressAutoScroll) return

    const currentLine = caret.line.value
    const currentColumn = caret.column.value
    const codeLines = doc.lines

    if (currentLine < 0 || currentLine >= codeLines.length) return

    const canUseNoWrapFastPath = !settings.wordWrap
      && doc.collapsed.size === 0
      && doc.widgets.length === 0
      && doc.errors.length === 0
    const canUseApproxCaretFastPath = typeof lines.getApproxCaretMetrics === 'function'

    let targetY: number
    let caretX: number

    if (canUseNoWrapFastPath) {
      const lineLength = codeLines[currentLine]?.length ?? 0
      const clampedColumn = Math.max(0, Math.min(currentColumn, lineLength))
      targetY = (currentLine * settings.lineHeight) + settings.lineHeight + 1.5

      if (clampedColumn === 0) {
        caretX = 0
      }
      else {
        const lineTokens = doc.tokenLines[currentLine] ?? []
        let x = 0
        let tokenStartColumn = 0
        let found = false

        for (let i = 0; i < lineTokens.length; i++) {
          const token = lineTokens[i]
          const tokenLength = token.text.length
          const tokenEndColumn = tokenStartColumn + tokenLength
          const tokenWidth = measureText(canvas.c, settings, caches, token).width

          if (clampedColumn <= tokenEndColumn) {
            const relativePos = Math.max(0, clampedColumn - tokenStartColumn)
            const charWidth = tokenLength > 0 ? tokenWidth / tokenLength : 0
            caretX = x + (relativePos * charWidth)
            found = true
            break
          }

          x += tokenWidth
          tokenStartColumn = tokenEndColumn
        }

        if (!found) {
          caretX = x
        }
      }
    }
    else {
      if (canUseApproxCaretFastPath) {
        const approx = lines.getApproxCaretMetrics(currentLine, currentColumn, doc.tokenLines)
        if (approx) {
          targetY = approx.targetY
          caretX = approx.caretX
        }
        else {
          targetY = (currentLine * settings.lineHeight) + settings.lineHeight + 1.5
          const lineLength = codeLines[currentLine]?.length ?? 0
          const clampedColumn = Math.max(0, Math.min(currentColumn, lineLength))
          if (clampedColumn === 0) {
            caretX = 0
          }
          else {
            const lineTokens = doc.tokenLines[currentLine] ?? []
            let x = 0
            let tokenStartColumn = 0
            let found = false
            for (let i = 0; i < lineTokens.length; i++) {
              const token = lineTokens[i]
              const tokenLength = token.text.length
              const tokenEndColumn = tokenStartColumn + tokenLength
              const tokenWidth = measureText(canvas.c, settings, caches, token).width
              if (clampedColumn <= tokenEndColumn) {
                const relativePos = Math.max(0, clampedColumn - tokenStartColumn)
                const charWidth = tokenLength > 0 ? tokenWidth / tokenLength : 0
                caretX = x + (relativePos * charWidth)
                found = true
                break
              }
              x += tokenWidth
              tokenStartColumn = tokenEndColumn
            }
            if (!found) caretX = x
          }
        }
      }
      else {
        targetY = (currentLine * settings.lineHeight) + settings.lineHeight + 1.5
        const lineLength = codeLines[currentLine]?.length ?? 0
        const clampedColumn = Math.max(0, Math.min(currentColumn, lineLength))
        if (clampedColumn === 0) {
          caretX = 0
        }
        else {
          const lineTokens = doc.tokenLines[currentLine] ?? []
          let x = 0
          let tokenStartColumn = 0
          let found = false
          for (let i = 0; i < lineTokens.length; i++) {
            const token = lineTokens[i]
            const tokenLength = token.text.length
            const tokenEndColumn = tokenStartColumn + tokenLength
            const tokenWidth = measureText(canvas.c, settings, caches, token).width
            if (clampedColumn <= tokenEndColumn) {
              const relativePos = Math.max(0, clampedColumn - tokenStartColumn)
              const charWidth = tokenLength > 0 ? tokenWidth / tokenLength : 0
              caretX = x + (relativePos * charWidth)
              found = true
              break
            }
            x += tokenWidth
            tokenStartColumn = tokenEndColumn
          }
          if (!found) caretX = x
        }
      }
    }

    const canvasHeight = canvas.size.height.value
    const scrollY = scroll.pos.y
    const caretY = targetY + scrollY

    const approxContentMetrics = typeof lines.getApproxContentMetrics === 'function'
      ? lines.getApproxContentMetrics()
      : null
    const estimatedTotalHeight = approxContentMetrics?.totalHeight
      ?? Math.max(targetY, codeLines.length * settings.lineHeight)
    const verticalScrollbarSize = getVerticalScrollbarSize(settings)
    const needsVertical = estimatedTotalHeight > canvas.size.height.value
    const availableWidth = canvas.size.width.value - settings.paddingLeft
      - metrics.gutterWidth.value
      - (needsVertical ? verticalScrollbarSize : 0)
    const estimatedTotalWidth = approxContentMetrics?.totalWidth
      ?? (settings.wordWrap ? availableWidth : Math.max(availableWidth, caretX + 2))
    const needsHorizontal = !settings.wordWrap && estimatedTotalWidth > availableWidth

    const headerHeight = header.value?.height ?? 0
    const rightMargin = settings.caretMarginX
    const topMargin = Math.max(0, settings.caretMarginY + settings.lineHeight)
    const bottomMargin = canvasHeight - (
      settings.caretMarginY
      + (needsHorizontal ? HORIZONTAL_SCROLLBAR_SIZE : 0)
      + headerHeight
    )

    if (caretY < topMargin) {
      scroll.targetY.value = -targetY + topMargin
    }
    else if (caretY > bottomMargin) {
      scroll.targetY.value = -targetY + bottomMargin
    }

    const contentWidth = availableWidth
    const scrollX = scroll.pos.x
    const caretXInView = caretX + scrollX

    if (caretXInView - 1 < settings.caretMarginX) {
      scroll.targetX.value = -(caretX - 1) + settings.caretMarginX
    }
    else if (caretXInView + 1.5 > contentWidth - rightMargin) {
      scroll.targetX.value = -((caretX + 1.5) - contentWidth + rightMargin)
    }
  }

  function toggleLineComment() {
    if (!settings.lineComment) return

    const codeLines = doc.lines
    let startLine: number
    let endLine: number
    let originalStartColumn: number | undefined
    let originalEndColumn: number | undefined

    if (selection.hasSelection.value) {
      const ordered = selection.getOrdered.value
      if (!ordered) return
      startLine = ordered.start.line
      endLine = ordered.end.line
      originalStartColumn = ordered.start.column
      originalEndColumn = ordered.end.column
    }
    else {
      startLine = caret.line.value
      endLine = caret.line.value
    }

    const escapedComment = settings.lineComment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const commentWithSpace = `${settings.lineComment} `

    let minIndent = Infinity
    let allCommented = true
    let hasCommentedLines = false
    let hasNonEmptyLines = false
    const lineData: Array<
      { line: string; indent: number; indentStr: string; textContent: string; isEmpty: boolean; isCommented: boolean }
    > = []

    for (let i = startLine; i <= endLine; i++) {
      const line = codeLines[i] || ''
      const indentMatch = line.match(/^(\s*)/)
      const indentStr = indentMatch ? indentMatch[1] : ''
      const indent = indentStr.length
      const trimmed = line.trimStart()
      const isEmpty = trimmed.length === 0
      const isCommented = !isEmpty && trimmed.startsWith(settings.lineComment)
      const textContent = trimmed.replace(new RegExp(`^${escapedComment} ?`), '')

      lineData.push({ line, indent, indentStr, textContent, isEmpty, isCommented })

      if (!isEmpty) {
        hasNonEmptyLines = true
        if (indent < minIndent) {
          minIndent = indent
        }
        if (isCommented) {
          hasCommentedLines = true
        }
        else {
          allCommented = false
        }
      }
    }

    if (!hasNonEmptyLines || minIndent === Infinity) {
      return
    }

    const minIndentStr = ' '.repeat(minIndent)
    const linesToToggle: string[] = []
    const hasSomeCommented = hasCommentedLines && !allCommented

    for (const { line, indent, indentStr, textContent, isEmpty, isCommented } of lineData) {
      if (isEmpty) {
        linesToToggle.push(indentStr)
      }
      else if (allCommented) {
        linesToToggle.push(indentStr + textContent)
      }
      else if (hasSomeCommented) {
        const relativeIndent = indent - minIndent
        const relativeIndentStr = ' '.repeat(Math.max(0, relativeIndent))
        if (isCommented) {
          linesToToggle.push(minIndentStr + commentWithSpace + relativeIndentStr + line.trimStart())
        }
        else {
          linesToToggle.push(minIndentStr + commentWithSpace + relativeIndentStr + textContent)
        }
      }
      else {
        const relativeIndent = indent - minIndent
        const relativeIndentStr = ' '.repeat(Math.max(0, relativeIndent))
        linesToToggle.push(minIndentStr + commentWithSpace + relativeIndentStr + textContent)
      }
    }

    const newText = linesToToggle.join('\n')
    const lastLineOriginalLength = codeLines[endLine]?.length || 0
    const lastNewLine = linesToToggle[linesToToggle.length - 1] || ''
    const lastNewLineLength = lastNewLine.length

    const originalCaretPosition = { line: caret.line.value, column: caret.column.value }
    const hadSelection = selection.hasSelection.value
    const originalSelectionDirection = selection.direction.value

    let caretPosition: { line: number; column: number } | undefined
    let newStartColumn: number | undefined
    let newEndColumn: number | undefined

    if (hadSelection && originalStartColumn !== undefined && originalEndColumn !== undefined) {
      const firstLineData = lineData[0]
      const lastLineData = lineData[lineData.length - 1]

      if (!allCommented) {
        const firstLineIndent = firstLineData ? firstLineData.indent : 0
        const lastLineIndent = lastLineData ? lastLineData.indent : 0
        const firstLineRelativeIndent = firstLineIndent - minIndent
        const lastLineRelativeIndent = lastLineIndent - minIndent

        if (originalStartColumn <= firstLineIndent) {
          newStartColumn = originalStartColumn
        }
        else {
          newStartColumn = minIndent + commentWithSpace.length + firstLineRelativeIndent
            + (originalStartColumn - firstLineIndent)
        }

        if (originalEndColumn <= lastLineIndent) {
          newEndColumn = originalEndColumn
        }
        else {
          newEndColumn = minIndent + commentWithSpace.length + lastLineRelativeIndent
            + (originalEndColumn - lastLineIndent)
        }
      }
      else {
        const firstLineTrimmed = codeLines[startLine]?.trimStart() || ''
        const firstLineCommentStart = firstLineData ? firstLineData.indent : 0
        const firstLineHasSpace = firstLineTrimmed.startsWith(settings.lineComment + ' ')
        const firstLineCommentLength = settings.lineComment.length + (firstLineHasSpace ? 1 : 0)

        if (originalStartColumn < firstLineCommentStart) {
          newStartColumn = originalStartColumn
        }
        else if (originalStartColumn >= firstLineCommentStart + firstLineCommentLength) {
          newStartColumn = originalStartColumn - firstLineCommentLength
        }
        else {
          newStartColumn = firstLineCommentStart
        }

        const lastLineTrimmed = codeLines[endLine]?.trimStart() || ''
        const lastLineCommentStart = lastLineData ? lastLineData.indent : 0
        const lastLineHasSpace = lastLineTrimmed.startsWith(settings.lineComment + ' ')
        const lastLineCommentLength = settings.lineComment.length + (lastLineHasSpace ? 1 : 0)

        if (originalEndColumn < lastLineCommentStart) {
          newEndColumn = originalEndColumn
        }
        else if (originalEndColumn >= lastLineCommentStart + lastLineCommentLength) {
          newEndColumn = originalEndColumn - lastLineCommentLength
        }
        else {
          newEndColumn = lastLineCommentStart
        }
      }

      if (originalSelectionDirection === 'backward') {
        caretPosition = { line: startLine, column: newStartColumn ?? 0 }
      }
      else {
        caretPosition = { line: endLine, column: newEndColumn ?? lastNewLineLength }
      }
    }
    else {
      const originalColumn = caret.column.value
      const originalLine = codeLines[startLine] || ''
      const newLine = linesToToggle[0] || ''
      const firstLineData = lineData[0]

      let newColumn = originalColumn
      if (!allCommented) {
        if (firstLineData && !firstLineData.isEmpty) {
          if (originalColumn <= firstLineData.indent) {
            newColumn = originalColumn
          }
          else {
            const relativeIndent = firstLineData.indent - minIndent
            const relativeIndentLength = Math.max(0, relativeIndent)
            newColumn = originalColumn + commentWithSpace.length + relativeIndentLength
          }
        }
      }
      else {
        if (firstLineData && !firstLineData.isEmpty) {
          const trimmed = originalLine.trimStart()
          const commentStartInLine = firstLineData.indent
          const hasSpaceAfter = trimmed.startsWith(settings.lineComment + ' ')
          const commentLength = settings.lineComment.length + (hasSpaceAfter ? 1 : 0)
          const commentEndInLine = commentStartInLine + commentLength

          if (originalColumn < commentStartInLine) {
            newColumn = originalColumn
          }
          else if (originalColumn >= commentEndInLine) {
            newColumn = originalColumn - commentLength
          }
          else {
            newColumn = commentStartInLine
          }
        }
      }

      caretPosition = { line: startLine, column: Math.min(newColumn, newLine.length) }
    }

    caches.adjustWrapTokensCacheOnLineDeleteRange(startLine, endLine)
    blocks.adjustOnLineDeleteRange(startLine, endLine)

    const selectionBefore = hadSelection && originalStartColumn !== undefined && originalEndColumn !== undefined
        && (originalSelectionDirection === 'forward' || originalSelectionDirection === 'backward')
      ? {
        start: { line: startLine, column: originalStartColumn },
        end: { line: endLine, column: originalEndColumn },
        direction: originalSelectionDirection,
      }
      : undefined

    const selectionAfter = hadSelection && newStartColumn !== undefined && newEndColumn !== undefined
        && (originalSelectionDirection === 'forward' || originalSelectionDirection === 'backward')
      ? {
        start: { line: startLine, column: newStartColumn },
        end: { line: endLine, column: newEndColumn },
        direction: originalSelectionDirection,
      }
      : undefined

    doc.buffer.replaceSelection(
      { line: startLine, column: 0 },
      { line: endLine, column: lastLineOriginalLength },
      newText,
      selectionBefore,
      originalCaretPosition,
      selectionAfter,
      caretPosition,
    )

    caches.adjustWrapTokensCacheOnLineInsertRange(startLine, endLine)
    blocks.adjustOnLineInsertRange(startLine, endLine)

    if (hadSelection && newStartColumn !== undefined && newEndColumn !== undefined) {
      const ordered = selection.getOrdered.value
      if (ordered) {
        if (originalSelectionDirection === 'backward') {
          caret.line.value = startLine
          caret.column.value = newStartColumn
          caret.columnIntent.value = newStartColumn
          selection.setStart(endLine, newEndColumn)
          selection.setEnd(startLine, newStartColumn)
        }
        else {
          caret.line.value = endLine
          caret.column.value = newEndColumn
          caret.columnIntent.value = newEndColumn
          selection.setStart(startLine, newStartColumn)
          selection.setEnd(endLine, newEndColumn)
        }
      }
    }
    else {
      if (caretPosition) {
        caret.line.value = caretPosition.line
        caret.column.value = caretPosition.column
        caret.columnIntent.value = caretPosition.column
      }
    }
    caret.columnIntent.value = caret.column.value
  }

  function toggleBlockComment() {
    const [startComment, endComment] = settings.blockComment
    if (!startComment || !endComment) return

    const codeLines = doc.lines
    const hadSelection = selection.hasSelection.value
    let startLine: number
    let endLine: number
    let startColumn: number
    let endColumn: number

    if (hadSelection) {
      const ordered = selection.getOrdered.value
      if (!ordered) return
      startLine = ordered.start.line
      endLine = ordered.end.line
      startColumn = ordered.start.column
      endColumn = ordered.end.column
    }
    else {
      startLine = caret.line.value
      endLine = caret.line.value
      startColumn = caret.column.value
      endColumn = caret.column.value
    }

    const selectedText = (() => {
      if (startLine === endLine) {
        const line = codeLines[startLine] || ''
        return line.slice(startColumn, endColumn)
      }
      let text = ''
      for (let line = startLine; line <= endLine; line++) {
        const lineText = codeLines[line] || ''
        if (line === startLine) {
          text += lineText.slice(startColumn)
        }
        else if (line === endLine) {
          text += lineText.slice(0, endColumn)
        }
        else {
          text += lineText
        }
        if (line < endLine) {
          text += '\n'
        }
      }
      return text
    })()

    const isCommented = selectedText.startsWith(startComment) && selectedText.endsWith(endComment)
    let newText: string
    let newStartColumn: number
    let newEndColumn: number

    if (isCommented) {
      newText = selectedText.slice(startComment.length, -endComment.length)
      newStartColumn = startColumn
      if (startLine === endLine) {
        newEndColumn = startColumn + newText.length
      }
      else {
        newEndColumn = endColumn - endComment.length
      }
    }
    else {
      newText = startComment + selectedText + endComment
      newStartColumn = startColumn
      if (startLine === endLine) {
        newEndColumn = endColumn + startComment.length + endComment.length
      }
      else {
        const lastLineOriginalLength = codeLines[endLine]?.length || 0
        const lastLineSelectedLength = endColumn
        newEndColumn = lastLineSelectedLength + endComment.length
      }
    }

    const originalSelectionDirection = selection.direction.value
    const originalStartColumn = selection.start.value.column
    const originalEndColumn = selection.end.value.column
    const selectionObj = hadSelection && originalSelectionDirection
        && (originalSelectionDirection === 'forward' || originalSelectionDirection === 'backward')
        && originalStartColumn !== undefined && originalEndColumn !== undefined
      ? {
        start: { line: startLine, column: originalStartColumn },
        end: { line: endLine, column: originalEndColumn },
        direction: originalSelectionDirection,
      }
      : undefined
    doc.buffer.replaceSelection(
      { line: startLine, column: startColumn },
      { line: endLine, column: endColumn },
      newText,
      selectionObj,
    )

    if (endLine > startLine) {
      caches.adjustWrapTokensCacheOnLineDeleteRange(startLine + 1, endLine)
      blocks.adjustOnLineDeleteRange(startLine + 1, endLine)
    }

    const newlineCount = (newText.match(/\n/g) || []).length
    if (newlineCount > 0) {
      const insertStartLine = startLine + 1
      const insertEndLine = startLine + newlineCount
      caches.adjustWrapTokensCacheOnLineInsertRange(insertStartLine, insertEndLine)
      blocks.adjustOnLineInsertRange(insertStartLine, insertEndLine)
    }

    if (hadSelection) {
      if (originalSelectionDirection === 'backward') {
        caret.line.value = startLine
        caret.column.value = newStartColumn
        caret.columnIntent.value = newStartColumn
        selection.setStart(endLine, newEndColumn)
        selection.setEnd(startLine, newStartColumn)
      }
      else {
        caret.line.value = endLine
        caret.column.value = newEndColumn
        caret.columnIntent.value = newEndColumn
        selection.setStart(startLine, newStartColumn)
        selection.setEnd(endLine, newEndColumn)
      }
    }
    else {
      caret.line.value = startLine
      caret.column.value = newStartColumn
      selection.clear()
    }
    caret.columnIntent.value = caret.column.value
  }

  let clipboard: ReturnType<typeof createClipboard>

  function indentLines() {
    const tabSize = 2
    const indentStr = ' '.repeat(tabSize)

    if (selection.hasSelection.value) {
      const ordered = selection.getOrdered.value
      if (!ordered) return

      const startLine = ordered.start.line
      const endLine = ordered.end.line
      const startColumn = ordered.start.column
      const endColumn = ordered.end.column
      const selectionDirection = selection.direction.value

      const actualEndLine = endColumn === 0 && endLine > startLine ? endLine - 1 : endLine

      const selectionDir = selectionDirection === 'forward' || selectionDirection === 'backward'
        ? selectionDirection
        : 'forward'
      const selectionBefore = ordered
        ? {
          start: { line: startLine, column: startColumn },
          end: { line: endLine, column: endColumn },
          direction: selectionDir,
        }
        : undefined

      const originalCaretPosition = { line: caret.line.value, column: caret.column.value }

      const newStartColumn = startColumn + tabSize
      const newEndColumn = endColumn === 0 && endLine > startLine ? 0 : endColumn + tabSize
      const newEndLine = endColumn === 0 && endLine > startLine ? endLine : endLine
      const caretPositionAfter = selectionDirection === 'backward'
        ? { line: startLine, column: newStartColumn }
        : { line: newEndLine, column: newEndColumn }

      const selectionAfter = ordered
        ? {
          start: { line: startLine, column: newStartColumn },
          end: { line: newEndLine, column: newEndColumn },
          direction: selectionDir,
        }
        : undefined

      caches.adjustWrapTokensCacheOnLineDeleteRange(startLine, actualEndLine)
      blocks.adjustOnLineDeleteRange(startLine, actualEndLine)

      const codeLines = doc.lines
      const linesToIndent: string[] = []
      for (let i = startLine; i <= actualEndLine; i++) {
        const line = codeLines[i] || ''
        linesToIndent.push(indentStr + line)
      }
      const newText = linesToIndent.join('\n')
      const lastLineOriginalLength = codeLines[actualEndLine]?.length || 0

      doc.buffer.replaceSelection(
        { line: startLine, column: 0 },
        { line: actualEndLine, column: lastLineOriginalLength },
        newText,
        selectionBefore,
        originalCaretPosition,
        selectionAfter,
        caretPositionAfter,
      )

      caches.adjustWrapTokensCacheOnLineInsertRange(startLine, actualEndLine)
      blocks.adjustOnLineInsertRange(startLine, actualEndLine)

      for (let i = startLine; i <= actualEndLine; i++) {
        const newLineLength = doc.lines[i]?.length || 0
        adjustWidgetsOnColumnInsert(doc, i, 0, tabSize, newLineLength)
      }

      if (selectionDirection === 'backward') {
        caret.line.value = startLine
        caret.column.value = newStartColumn
        caret.columnIntent.value = newStartColumn
        selection.setStart(endLine, newEndColumn)
        selection.setEnd(startLine, newStartColumn)
      }
      else {
        caret.line.value = endLine
        caret.column.value = newEndColumn
        caret.columnIntent.value = newEndColumn
        selection.setStart(startLine, newStartColumn)
        selection.setEnd(endLine, newEndColumn)
      }
    }
    else {
      const currentLine = caret.line.value
      const currentColumn = caret.column.value
      const codeLines = doc.lines
      const line = codeLines[currentLine] || ''

      insertText(indentStr)
    }
  }

  function unindentLines() {
    const tabSize = 2

    if (selection.hasSelection.value) {
      const ordered = selection.getOrdered.value
      if (!ordered) return

      const startLine = ordered.start.line
      const endLine = ordered.end.line
      const startColumn = ordered.start.column
      const endColumn = ordered.end.column
      const selectionDirection = selection.direction.value

      const actualEndLine = endColumn === 0 && endLine > startLine ? endLine - 1 : endLine

      const selectionDir = selectionDirection === 'forward' || selectionDirection === 'backward'
        ? selectionDirection
        : 'forward'
      const selectionBefore = ordered
        ? {
          start: { line: startLine, column: startColumn },
          end: { line: endLine, column: endColumn },
          direction: selectionDir,
        }
        : undefined

      const originalCaretPosition = { line: caret.line.value, column: caret.column.value }

      caches.adjustWrapTokensCacheOnLineDeleteRange(startLine, actualEndLine)
      blocks.adjustOnLineDeleteRange(startLine, actualEndLine)

      const codeLines = doc.lines
      const linesToUnindent: string[] = []
      let minUnindent = Infinity

      for (let i = startLine; i <= actualEndLine; i++) {
        const line = codeLines[i] || ''
        const indentMatch = line.match(/^(\s*)/)
        const indentStr = indentMatch ? indentMatch[1] : ''
        const indent = indentStr.length
        const unindent = Math.min(indent, tabSize)
        if (unindent > 0) {
          if (unindent < minUnindent) {
            minUnindent = unindent
          }
        }
      }

      if (minUnindent === Infinity || minUnindent === 0) {
        return
      }

      for (let i = startLine; i <= actualEndLine; i++) {
        const line = codeLines[i] || ''
        linesToUnindent.push(line.slice(minUnindent))
      }

      const newText = linesToUnindent.join('\n')
      const lastLineOriginalLength = codeLines[actualEndLine]?.length || 0

      for (let i = startLine; i <= actualEndLine; i++) {
        adjustWidgetsOnColumnDelete(doc, i, 0, minUnindent)
      }

      const newStartColumn = Math.max(0, startColumn - minUnindent)
      const newEndColumn = endColumn === 0 && endLine > startLine ? 0 : Math.max(0, endColumn - minUnindent)
      const newEndLine = endColumn === 0 && endLine > startLine ? endLine : endLine
      const caretPositionAfter = selectionDirection === 'backward'
        ? { line: startLine, column: newStartColumn }
        : { line: newEndLine, column: newEndColumn }

      const selectionAfter = ordered
        ? {
          start: { line: startLine, column: newStartColumn },
          end: { line: newEndLine, column: newEndColumn },
          direction: selectionDir,
        }
        : undefined

      doc.buffer.replaceSelection(
        { line: startLine, column: 0 },
        { line: actualEndLine, column: lastLineOriginalLength },
        newText,
        selectionBefore,
        originalCaretPosition,
        selectionAfter,
        caretPositionAfter,
      )

      caches.adjustWrapTokensCacheOnLineInsertRange(startLine, actualEndLine)
      blocks.adjustOnLineInsertRange(startLine, actualEndLine)

      if (selectionDirection === 'backward') {
        caret.line.value = startLine
        caret.column.value = newStartColumn
        caret.columnIntent.value = newStartColumn
        selection.setStart(endLine, newEndColumn)
        selection.setEnd(startLine, newStartColumn)
      }
      else {
        caret.line.value = endLine
        caret.column.value = newEndColumn
        caret.columnIntent.value = newEndColumn
        selection.setStart(startLine, newStartColumn)
        selection.setEnd(endLine, newEndColumn)
      }
    }
    else {
      const currentLine = caret.line.value
      const currentColumn = caret.column.value
      const codeLines = doc.lines
      const line = codeLines[currentLine] || ''

      const indentMatch = line.match(/^(\s*)/)
      const indentStr = indentMatch ? indentMatch[1] : ''
      const indent = indentStr.length
      const unindent = Math.min(indent, tabSize)

      if (unindent > 0) {
        const newLine = line.slice(unindent)
        const newColumn = Math.max(0, currentColumn - unindent)

        const originalCaretPosition = { line: currentLine, column: currentColumn }
        const caretPositionAfter = { line: currentLine, column: newColumn }

        caches.invalidateWrapTokensCacheForLine(currentLine)
        doc.buffer.replaceSelection(
          { line: currentLine, column: 0 },
          { line: currentLine, column: line.length },
          newLine,
          undefined,
          originalCaretPosition,
          undefined,
          caretPositionAfter,
        )

        caret.column.value = newColumn
        caret.columnIntent.value = newColumn
      }
    }
  }

  function handleKeyAction(key: string, shift: boolean, ctrl: boolean, meta: boolean, alt: boolean) {
    caret.resetBlink()

    const normalizedKey = key.toLowerCase()
    if ((ctrl || meta) && normalizedKey === 'a') {
      const codeLines = doc.lines
      if (codeLines.length === 0) {
        selection.clear()
        caret.line.value = 0
        caret.column.value = 0
        caret.columnIntent.value = 0
        ensureCaretVisible()
        return
      }
      const lastLine = codeLines.length - 1
      const lastColumn = codeLines[lastLine]?.length || 0
      selection.setStart(0, 0)
      selection.setEnd(lastLine, lastColumn)
      caret.line.value = lastLine
      caret.column.value = lastColumn
      ensureCaretVisible()
      return
    }
    else if ((ctrl || meta) && normalizedKey === 'b') {
      const matchingBrace = blocks.findMatchingBrace(caret.line.value, caret.column.value)
      if (!matchingBrace) {
        ensureCaretVisible()
        return
      }

      const tokenLines = doc.tokenLines

      let openColumn = 0
      const openLineTokens = tokenLines[matchingBrace.line] || []
      for (let i = 0; i < matchingBrace.tokenIndex; i++) {
        openColumn += openLineTokens[i]?.text.length || 0
      }
      openColumn += matchingBrace.charIndex

      let closeColumn = 0
      const closeLineTokens = tokenLines[matchingBrace.matchingLine] || []
      for (let i = 0; i < matchingBrace.matchingTokenIndex; i++) {
        closeColumn += closeLineTokens[i]?.text.length || 0
      }
      closeColumn += matchingBrace.matchingCharIndex + 1

      selection.setStart(matchingBrace.line, openColumn)
      selection.setEnd(matchingBrace.matchingLine, closeColumn)
      caret.line.value = matchingBrace.matchingLine
      caret.column.value = closeColumn
      caret.columnIntent.value = closeColumn
      ensureCaretVisible()
      return
    }
    else if ((ctrl || meta) && normalizedKey === 'c') {
      clipboard.copy()
      return
    }
    else if ((ctrl || meta) && normalizedKey === 'x') {
      clipboard.cut()
      ensureCaretVisible()
      return
    }
    else if ((ctrl || meta) && key === 'z' && !shift) {
      const result = doc.buffer.undo()
      caches.clearDrawCaches()
      if (result) {
        caret.line.value = result.line
        caret.column.value = result.column
        caret.columnIntent.value = result.column
        if (result.selection) {
          // Restore selection as stored - start is anchor, end is active position
          if (result.selection.direction === 'backward') {
            // For backward, start is later in doc (anchor), end is earlier (active/caret)
            selection.start.value = result.selection.end
            selection.end.value = result.selection.start
          }
          else {
            // For forward, start is earlier (anchor), end is later (active/caret)
            selection.start.value = result.selection.start
            selection.end.value = result.selection.end
          }
          selection.direction.value = result.selection.direction
        }
        else {
          selection.clear()
        }
      }
      ensureCaretVisible()
      return
    }
    else if ((ctrl || meta) && (key === 'y' || (key === 'z' && shift))) {
      const result = doc.buffer.redo()
      caches.clearDrawCaches()
      if (result) {
        caret.line.value = result.line
        caret.column.value = result.column
        caret.columnIntent.value = result.column
        if (result.selection) {
          // Restore selection as stored - start is anchor, end is active position
          if (result.selection.direction === 'backward') {
            // For backward, start is later in doc (anchor), end is earlier (active/caret)
            selection.start.value = result.selection.end
            selection.end.value = result.selection.start
          }
          else {
            // For forward, start is earlier (anchor), end is later (active/caret)
            selection.start.value = result.selection.start
            selection.end.value = result.selection.end
          }
          selection.direction.value = result.selection.direction
        }
        else {
          selection.clear()
        }
      }
      else {
        selection.clear()
      }
      ensureCaretVisible()
      return
    }
    else if ((ctrl || meta) && shift && normalizedKey === 'd') {
      duplicateLine()
      ensureCaretVisible()
      return
    }
    else if ((ctrl || meta) && !shift && (key === '/' || normalizedKey === 'slash')) {
      toggleLineComment()
      ensureCaretVisible()
      return
    }
    else if ((ctrl || meta) && shift && (key === '/' || key === '?' || normalizedKey === 'slash')) {
      toggleBlockComment()
      ensureCaretVisible()
      return
    }

    if (key === 'ArrowLeft') {
      caret.isTyping.value = false
      caret.caretToken = null
      if (ctrl || meta) {
        moveWordLeft(shift)
      }
      else {
        moveLeft(shift)
      }
      ensureCaretVisible()
    }
    else if (key === 'ArrowRight') {
      caret.isTyping.value = false
      caret.caretToken = null
      if (ctrl || meta) {
        moveWordRight(shift)
      }
      else {
        moveRight(shift)
      }
      ensureCaretVisible()
    }
    else if (key === 'ArrowUp') {
      caret.isTyping.value = false
      caret.caretToken = null
      if (alt) {
        moveLineUp()
        ensureCaretVisible()
      }
      else {
        moveUp(shift)
        ensureCaretVisible()
      }
    }
    else if (key === 'ArrowDown') {
      caret.isTyping.value = false
      caret.caretToken = null
      if (alt) {
        moveLineDown()
        ensureCaretVisible()
      }
      else {
        moveDown(shift)
        ensureCaretVisible()
      }
    }
    else if (key === 'Home') {
      caret.isTyping.value = false
      caret.caretToken = null
      moveHome(shift)
      ensureCaretVisible()
    }
    else if (key === 'End') {
      caret.isTyping.value = false
      caret.caretToken = null
      moveEnd(shift)
      ensureCaretVisible()
    }
    else if (key === 'PageUp') {
      caret.isTyping.value = false
      caret.caretToken = null
      movePageUp(shift)
      ensureCaretVisible()
    }
    else if (key === 'PageDown') {
      caret.isTyping.value = false
      caret.caretToken = null
      movePageDown(shift)
      ensureCaretVisible()
    }
    else if (key === 'Backspace') {
      if (ctrl || meta) {
        deleteWordLeft()
      }
      else {
        backspace()
      }
      ensureCaretVisible()
    }
    else if (key === 'Delete') {
      if (ctrl || meta) {
        deleteWordRight()
      }
      else if (shift) {
        deleteLine()
      }
      else {
        deleteChar()
      }
      ensureCaretVisible()
    }
    else if (key === 'Escape') {
      caret.isTyping.value = false
      caret.caretToken = null
      mouse.clearHoverToken()
      clearPinnedError()
      return
    }
    else if (key === 'Tab') {
      if (shift) {
        unindentLines()
      }
      else {
        indentLines()
      }
      ensureCaretVisible()
    }
    else if (key === 'Enter') {
      const currentLine = doc.lines[caret.line.value] || ''

      if (caret.column.value === 0) {
        insertText('\n')
        ensureCaretVisible()
        return
      }

      const beforeCursor = currentLine.slice(0, caret.column.value)
      const afterCursor = currentLine.slice(caret.column.value)
      const lastChar = beforeCursor.trimEnd().slice(-1)
      const isBrace = lastChar === '{' || lastChar === '[' || lastChar === '('

      const indentMatch = currentLine.match(/^(\s*)/)
      const currentIndent = indentMatch ? indentMatch[1] : ''

      const bracePairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
      const trimmedAfter = afterCursor.trimStart()
      const firstAfterCursor = trimmedAfter[0]
      const closingBrace = lastChar ? bracePairs[lastChar] : null
      const isBetweenEmptyBraces = lastChar && closingBrace && firstAfterCursor === closingBrace

      if (isBetweenEmptyBraces) {
        const tabSize = 2
        const indentStr = ' '.repeat(tabSize)
        const newIndent = currentIndent + indentStr
        const closeBraceIndex = afterCursor.indexOf(closingBrace!)
        const afterCloseBrace = afterCursor.slice(closeBraceIndex + 1)

        const newText = '\n' + newIndent + '\n' + currentIndent + closingBrace + afterCloseBrace
        const startColumn = caret.column.value
        const endColumn = currentLine.length

        const caretPositionBefore = { line: caret.line.value, column: caret.column.value }
        const caretPositionAfter = { line: caret.line.value + 1, column: newIndent.length }

        const linesBeforeInsert = doc.lines.length
        adjustWidgetsOnLineSplit(doc, caret.line.value, startColumn, 2)
        caches.invalidateWrapTokensCacheForLine(caret.line.value)
        for (const [lineNum] of caches.wrapTokensCacheByLine.entries()) {
          if (lineNum > caret.line.value) caches.invalidateWrapTokensCacheForLine(lineNum)
        }

        doc.buffer.replaceSelection(
          { line: caret.line.value, column: startColumn },
          { line: caret.line.value, column: endColumn },
          newText,
          undefined,
          caretPositionBefore,
          undefined,
          caretPositionAfter,
        )

        const linesAfterInsert = doc.lines.length
        const insertedLineCount = linesAfterInsert - linesBeforeInsert

        if (insertedLineCount > 0) {
          blocks.adjustOnLineInsertRange(caret.line.value + 1, caret.line.value + insertedLineCount)
        }

        caret.line.value = caretPositionAfter.line
        caret.column.value = caretPositionAfter.column
        caret.columnIntent.value = caret.column.value
        ensureCaretVisible()
        return
      }

      const matchingBrace = blocks.findMatchingBrace(caret.line.value, caret.column.value)
      if (matchingBrace && matchingBrace.line === matchingBrace.matchingLine
        && caret.line.value === matchingBrace.line)
      {
        const tokenLines = doc.tokenLines

        let openColumn = 0
        const openLineTokens = tokenLines[matchingBrace.line] || []
        for (let i = 0; i < matchingBrace.tokenIndex; i++) {
          openColumn += openLineTokens[i]?.text.length || 0
        }
        openColumn += matchingBrace.charIndex

        let closeColumn = 0
        const closeLineTokens = tokenLines[matchingBrace.matchingLine] || []
        for (let i = 0; i < matchingBrace.matchingTokenIndex; i++) {
          closeColumn += closeLineTokens[i]?.text.length || 0
        }
        closeColumn += matchingBrace.matchingCharIndex

        if (caret.column.value > openColumn && caret.column.value < closeColumn) {
          const openLine = doc.lines[matchingBrace.line] || ''
          const openIndentMatch = openLine.match(/^(\s*)/)
          const openIndent = openIndentMatch ? openIndentMatch[1] : ''
          const tabSize = 2
          const indentStr = ' '.repeat(tabSize)
          const newIndent = openIndent + indentStr

          const closeLine = doc.lines[matchingBrace.matchingLine] || ''
          const textBetweenCaretAndClose = closeLine.slice(caret.column.value, closeColumn)
          const closingBraceChar = closeLine[closeColumn]

          const newText = '\n' + newIndent + textBetweenCaretAndClose + '\n' + openIndent + closingBraceChar
          const startColumn = caret.column.value
          const endColumn = closeColumn + 1

          const caretPositionBefore = { line: caret.line.value, column: caret.column.value }
          const caretPositionAfter = { line: caret.line.value + 1, column: newIndent.length }

          const linesBeforeInsert = doc.lines.length
          adjustWidgetsOnLineSplit(doc, caret.line.value, startColumn, 2)
          caches.invalidateWrapTokensCacheForLine(caret.line.value)
          for (const [lineNum] of caches.wrapTokensCacheByLine.entries()) {
            if (lineNum > caret.line.value) caches.invalidateWrapTokensCacheForLine(lineNum)
          }

          doc.buffer.replaceSelection(
            { line: caret.line.value, column: startColumn },
            { line: caret.line.value, column: endColumn },
            newText,
            undefined,
            caretPositionBefore,
            undefined,
            caretPositionAfter,
          )

          const linesAfterInsert = doc.lines.length
          const insertedLineCount = linesAfterInsert - linesBeforeInsert

          if (insertedLineCount > 0) {
            blocks.adjustOnLineInsertRange(caret.line.value + 1, caret.line.value + insertedLineCount)
          }

          caret.line.value = caretPositionAfter.line
          caret.column.value = caretPositionAfter.column
          caret.columnIntent.value = caret.column.value
          ensureCaretVisible()
          return
        }
      }

      if (isBrace) {
        const tabSize = 2
        const indentStr = ' '.repeat(tabSize)
        const newIndent = currentIndent + indentStr
        insertText('\n' + newIndent)
      }
      else {
        insertText('\n' + currentIndent)
      }
      ensureCaretVisible()
    }
    else if (key.length === 1 && !ctrl && !meta && !alt) {
      const skipOverChars = new Set(['[', '(', '{', ']', ')', '}', '\'', '"', '`'])
      const currentLine = doc.lines[caret.line.value] ?? ''
      const charRight = currentLine[caret.column.value]
      if (skipOverChars.has(key) && charRight === key) {
        const line = caret.line.value
        const column = caret.column.value
        doc.buffer.replaceSelection(
          { line, column },
          { line, column: column + 1 },
          key,
          undefined,
          { line, column },
          undefined,
          { line, column: column + 1 },
        )
        caches.invalidateWrapTokensCacheForLine(line)
        caret.column.value = column + 1
        caret.columnIntent.value = caret.column.value
        caret.isTyping.value = true
        caret.lastInputTime.value = Date.now()
      }
      else {
        const bracePairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
        const stringDelimiters = new Set(['\'', '"', '`'])
        const closingBrace = bracePairs[key]
        const isStringDelimiter = stringDelimiters.has(key)
        const nextChar = currentLine[caret.column.value]
        const canAutoClose = (closingBrace || isStringDelimiter)
          && (!nextChar || /\s/.test(nextChar))
        if (canAutoClose) {
          const pair = closingBrace ? key + closingBrace : key + key
          if (selection.hasSelection.value) {
            const ordered = selection.getOrdered.value
            if (ordered) {
              const startLine = ordered.start.line
              const endLine = ordered.end.line
              const startColumn = ordered.start.column
              const endColumn = ordered.end.column
              const selectionDirection = selection.direction.value

              const linesBeforeReplace = doc.lines.length
              const deletedLineCount = endLine > startLine ? endLine - startLine : 0

              const selectionDir = selectionDirection === 'forward' || selectionDirection === 'backward'
                ? selectionDirection
                : undefined
              const selectionObj = selectionDir && ordered
                ? {
                  start: { line: startLine, column: startColumn },
                  end: { line: endLine, column: endColumn },
                  direction: selectionDir,
                }
                : undefined
              doc.buffer.replaceSelection(
                { line: startLine, column: startColumn },
                { line: endLine, column: endColumn },
                pair,
                selectionObj,
              )

              const linesAfterReplace = doc.lines.length
              const newlineCount = 0
              const insertedLineCount = newlineCount > 0 ? newlineCount : 0

              if (deletedLineCount > 0) {
                caches.adjustWrapTokensCacheOnLineDeleteRange(startLine + 1, endLine)
                blocks.adjustOnLineDeleteRange(startLine + 1, endLine)
              }

              if (insertedLineCount > 0) {
                const insertStartLine = startLine + 1
                const insertEndLine = startLine + insertedLineCount
                caches.adjustWrapTokensCacheOnLineInsertRange(insertStartLine, insertEndLine)
                blocks.adjustOnLineInsertRange(insertStartLine, insertEndLine)
              }
              else if (deletedLineCount === 0) {
                caches.invalidateWrapTokensCacheForLine(startLine)
              }

              caret.line.value = startLine
              caret.column.value = startColumn + 1
              caret.columnIntent.value = caret.column.value
              selection.clear()
            }
          }
          else {
            const currentLine = doc.lines[caret.line.value] || ''
            const newLine = currentLine.slice(0, caret.column.value) + pair + currentLine.slice(caret.column.value)
            adjustWidgetsOnColumnInsert(doc, caret.line.value, caret.column.value, 2, newLine.length)
            caches.invalidateWrapTokensCacheForLine(caret.line.value)
            doc.buffer.insert(caret.line.value, caret.column.value, pair)
            caret.column.value += 1
            caret.columnIntent.value = caret.column.value
          }
          caret.isTyping.value = true
          caret.lastInputTime.value = Date.now()
        }
        else {
          insertText(key)
        }
      }
      ensureCaretVisible()
    }
  }

  const NON_KEYS = new Set(['Alt', 'Control', 'Meta', 'Shift'])

  const handleKeyDown = (event: KeyboardEvent) => {
    batch(() => {
      if (event.defaultPrevented) return

      shiftKey.value = event.shiftKey
      ctrlKey.value = event.ctrlKey
      metaKey.value = event.metaKey
      altKey.value = event.altKey

      if (NON_KEYS.has(event.key)) {
        return
      }

      const normalizedKey = event.key.toLowerCase()
      const normalizedCode = (event.code || '').toLowerCase()
      const isPasteShortcut = (event.ctrlKey || event.metaKey)
        && !event.altKey
        && (normalizedKey === 'v' || normalizedCode === 'keyv')
      const isShiftInsertPaste = !event.ctrlKey
        && !event.metaKey
        && event.shiftKey
        && normalizedKey === 'insert'
      if (isPasteShortcut || isShiftInsertPaste) {
        // Let native paste fire without entering key-hold mode; this keeps scroll/caret
        // updates responsive during rapid Ctrl/Cmd+V bursts.
        return
      }

      pressedInputKeys.add(event.code || event.key)
      updateKeyHoldActive()

      handleKeyAction(event.key, event.shiftKey, event.ctrlKey, event.metaKey, event.altKey)

      if (
        event.key === 'ArrowLeft'
        || event.key === 'ArrowRight'
        || event.key === 'ArrowUp'
        || event.key === 'ArrowDown'
        || event.key === 'Home'
        || event.key === 'End'
        || event.key === 'PageUp'
        || event.key === 'PageDown'
        || event.key === 'Backspace'
        || event.key === 'Delete'
        || event.key === 'Enter'
        || event.key === 'Escape'
        || event.key === 'Tab'
        || ((event.ctrlKey || event.metaKey)
          && (event.key.toLowerCase() === 'a' || event.key.toLowerCase() === 'b' || event.key.toLowerCase() === 'z'
            || event.key.toLowerCase() === 'y' || event.key.toLowerCase() === 'c'
            || event.key.toLowerCase() === 'x' || (event.shiftKey && event.key.toLowerCase() === 'd')
            || (!event.shiftKey && (event.key === '/' || event.key.toLowerCase() === 'slash'))
            || (event.shiftKey && (event.key === '/' || event.key === '?' || event.key.toLowerCase() === 'slash'))
            || event.key === 'ArrowLeft'
            || event.key === 'ArrowRight'))
        || (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
      ) {
        event.preventDefault()
      }
    })
  }

  const handleKeyUp = (event: KeyboardEvent) => {
    batch(() => {
      if (event.defaultPrevented) return

      shiftKey.value = event.shiftKey
      ctrlKey.value = event.ctrlKey
      metaKey.value = event.metaKey
      altKey.value = event.altKey

      if ((event.key === 'Control' || event.key === 'Meta') && pressedInputKeys.size > 0) {
        // Some platforms can swallow the paired keyup (e.g. "V" in Ctrl/Cmd+V).
        // Clearing here prevents keyHoldActive from getting stuck until blur.
        pressedInputKeys.clear()
        updateKeyHoldActive()
        return
      }

      if (!NON_KEYS.has(event.key)) {
        pressedInputKeys.delete(event.code || event.key)
        updateKeyHoldActive()
      }
    })
  }

  clipboard = createClipboard(doc, selection, insertText, deleteSelection, ensureCaretVisible, handleKeyDown,
    handleKeyUp, canvas, updateKeyHoldActive)

  const textarea = getTextareaElement()
  const handleTextareaFocus = () => {
    if (getActiveCanvas() === canvas.el) {
      clipboard.activate()
    }
  }

  const handleTextareaBlur = () => {
    setTimeout(() => {
      pressedInputKeys.clear()
      updateKeyHoldActive()
      const activeElement = document.activeElement
      const textarea = getTextareaElement()
      if (activeElement !== textarea && activeElement?.tagName !== 'CANVAS' && getActiveCanvas() !== canvas.el) {
        clipboard.deactivate()
      }
    }, 0)
  }

  const activate = () => {
    activeEditorOpts?.setActiveEditor(activeEditorOpts.editorRef.current)
    clipboard.activate()
    caret.resetBlink()
  }

  textarea.addEventListener('focus', handleTextareaFocus)
  textarea.addEventListener('blur', handleTextareaBlur)

  const dispose = () => {
    pressedInputKeys.clear()
    updateKeyHoldActive()
    textarea.removeEventListener('focus', handleTextareaFocus)
    textarea.removeEventListener('blur', handleTextareaBlur)
    clipboard.dispose()
  }

  return { dispose, clipboard, activate }
}
