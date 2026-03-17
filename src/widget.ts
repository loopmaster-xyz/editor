import type { Doc, DocError } from './doc.ts'
import type { BufferChange } from './buffer.ts'

export type WidgetType = 'above' | 'below' | 'before' | 'after' | 'inlay' | 'overlay' | 'full'

function isDerivedError(error: DocError): boolean {
  const desc = Object.getOwnPropertyDescriptor(error, 'y')
  return desc != null && desc.get != null && desc.set == null
}

function adjustError(
  error: DocError,
  adjust: (x: [number, number], y: number) => { x: [number, number]; y: number } | null,
): DocError {
  if (isDerivedError(error)) return error
  const next = adjust([...error.x], error.y)
  return next ? { ...error, x: next.x, y: next.y } : error
}

export type Widgets = Widget[]

type CanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export type Widget = {
  type: 'above'
  pos: { x: [start: number, end: number]; y: number }
  draw(c: CanvasContext, x: number, y: number, w: number, h: number): void
} | {
  type: 'below'
  pos: { x: [start: number, end: number]; y: number }
  draw(c: CanvasContext, x: number, y: number, w: number, h: number): void
  onMouseDown?(event: MouseEvent, x: number, y: number, w: number, h: number): void
} | {
  type: 'before'
  pos: { x: number; y: number; width: number }
  draw(c: CanvasContext, x: number, y: number, w: number, h: number): void
  onMouseDown?(event: MouseEvent, x: number, y: number, w: number, h: number): void
} | {
  type: 'after'
  pos: { x: number; y: number; width: number }
  draw(c: CanvasContext, x: number, y: number, w: number, h: number): void
  onMouseDown?(event: MouseEvent, x: number, y: number, w: number, h: number): void
} | {
  type: 'inlay'
  pos: { x: number; y: number }
  content: string
  fontSize?: string
  draw(c: CanvasContext, x: number, y: number, w: number, h: number): void
} | {
  type: 'overlay'
  pos: { x: [start: number, end: number]; y: number }
  draw(c: CanvasContext, x: number, y: number, w: number, h: number): void
} | {
  type: 'full'
  pos: { y: number }
  draw(c: CanvasContext, x: number, y: number, w: number, h: number, fw: number, contentLeft?: number): void
}

function publishWidgetsIfChanged(doc: Doc, changed: boolean) {
  if (!changed) return
  doc.widgetVersion++
}

function analyzeSpliceText(text: string): { newlineCount: number; headLength: number; tailLength: number } {
  let newlineCount = 0
  let headLength = 0
  let tailLength = 0

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\n') {
      newlineCount++
      tailLength = 0
      continue
    }
    if (newlineCount === 0) headLength++
    tailLength++
  }

  return { newlineCount, headLength, tailLength }
}

export function adjustWidgetsForSplice(
  doc: Doc,
  change: Extract<BufferChange, { type: 'splice' }>,
) {
  const startLine = change.startLine
  const startColumn = change.startColumn
  if (startLine === undefined || startColumn === undefined) return

  if (change.deletedText.length > 0) {
    const deleted = analyzeSpliceText(change.deletedText)
    if (deleted.newlineCount === 0) {
      adjustWidgetsOnColumnDelete(doc, startLine, startColumn, change.deletedText.length)
    }
    else {
      adjustWidgetsOnMultiLineDelete(
        doc,
        startLine,
        startColumn,
        startLine + deleted.newlineCount,
        deleted.tailLength,
        startColumn + deleted.headLength,
      )
    }
  }

  if (change.insertedText.length === 0) return

  const inserted = analyzeSpliceText(change.insertedText)
  if (inserted.newlineCount > 0) {
    adjustWidgetsOnLineSplit(doc, startLine, startColumn, inserted.newlineCount, inserted.tailLength)
    return
  }

  const newLineLength = doc.lines[startLine]?.length ?? (startColumn + change.insertedText.length)
  adjustWidgetsOnColumnInsert(doc, startLine, startColumn, change.insertedText.length, newLineLength)
}

export function adjustWidgetsOnLineSplit(
  doc: Doc,
  line: number,
  column: number,
  delta: number,
  insertedTailLength = 0,
) {
  if (delta === 0) return

  const widgetLine = line + 1
  const widgetColumn = column + 1

  const widgets = doc.widgets
  const errors = doc.errors
  if (widgets.length === 0 && errors.length === 0) return
  let widgetsChanged = false

  for (let i = 0; i < widgets.length; i++) {
    const widget = widgets[i]
    if (widget.pos.y === widgetLine) {
      let shouldMove = false

      if (widget.type === 'above' || widget.type === 'below' || widget.type === 'overlay') {
        const [startColumn, endColumn] = widget.pos.x
        if (startColumn >= widgetColumn) {
          shouldMove = true
          widget.pos.x[0] = startColumn - column + insertedTailLength
          widget.pos.x[1] = endColumn - column + insertedTailLength
          widgetsChanged = true
        }
        else if (endColumn >= widgetColumn) {
          widget.pos.x[1] = widgetColumn
          widgetsChanged = true
        }
      }
      else if (widget.type === 'before' || widget.type === 'after' || widget.type === 'inlay') {
        const widgetCol = widget.pos.x
        shouldMove = widgetCol >= widgetColumn
        if (shouldMove) {
          widget.pos.x = widgetCol - column + insertedTailLength
          widgetsChanged = true
        }
      }
      else if (widget.type === 'full') {
        shouldMove = true
      }

      if (shouldMove) {
        widget.pos.y += delta
        widgetsChanged = true
      }
    }
    else if (widget.pos.y > widgetLine) {
      widget.pos.y += delta
      widgetsChanged = true
    }
  }

  publishWidgetsIfChanged(doc, widgetsChanged)

  if (errors.length === 0) return
  let nextErrors: DocError[] | null = null
  for (let i = 0; i < errors.length; i++) {
    const error = errors[i]
    if (isDerivedError(error)) continue

    let nextY = error.y
    let nextXStart = error.x[0]
    let nextXEnd = error.x[1]

    if (nextY === widgetLine) {
      const startColumn = nextXStart - 1
      const endColumn = nextXEnd - 1
      if (startColumn >= column) {
        nextY += delta
        nextXStart = startColumn - column + insertedTailLength + 1
        nextXEnd = endColumn - column + insertedTailLength + 1
      }
      else if (endColumn >= column) {
        nextXEnd = column + 1
      }
      else {
        continue
      }
    }
    else if (nextY > widgetLine) {
      nextY += delta
    }
    else {
      continue
    }

    if (
      nextY === error.y
      && nextXStart === error.x[0]
      && nextXEnd === error.x[1]
    ) {
      continue
    }

    if (!nextErrors) nextErrors = errors.slice()
    nextErrors[i] = {
      ...error,
      x: [nextXStart, nextXEnd],
      y: nextY,
    }
  }

  if (!nextErrors) return
  doc.errors = nextErrors
}

export function adjustWidgetsOnLineMerge(doc: Doc, line: number, prevLineLength: number) {
  const widgetLine = line + 1
  let widgetsChanged = false
  for (const widget of doc.widgets) {
    if (widget.pos.y === widgetLine) {
      if (widget.type === 'above' || widget.type === 'below' || widget.type === 'overlay') {
        widget.pos.x[0] = widget.pos.x[0] + prevLineLength
        widget.pos.x[1] = widget.pos.x[1] + prevLineLength
      }
      else if (widget.type === 'before' || widget.type === 'after' || widget.type === 'inlay') {
        widget.pos.x = widget.pos.x + prevLineLength
      }
      widget.pos.y = line
      widgetsChanged = true
    }
    else if (widget.pos.y > widgetLine) {
      widget.pos.y--
      widgetsChanged = true
    }
  }

  publishWidgetsIfChanged(doc, widgetsChanged)

  doc.errors = doc.errors.map(error =>
    adjustError(error, (x, y) => {
      if (y === line + 1) return { x: [x[0] + prevLineLength, x[1] + prevLineLength], y: line }
      if (y > line + 1) return { x, y: y - 1 }
      return null
    })
  )
}

export function adjustWidgetsOnNextLineMerge(doc: Doc, line: number, currentLineLength: number) {
  const widgetLine = line + 2
  let widgetsChanged = false
  for (const widget of doc.widgets) {
    if (widget.pos.y === widgetLine) {
      if (widget.type === 'above' || widget.type === 'below' || widget.type === 'overlay') {
        widget.pos.x[0] = widget.pos.x[0] + currentLineLength
        widget.pos.x[1] = widget.pos.x[1] + currentLineLength
      }
      else if (widget.type === 'before' || widget.type === 'after' || widget.type === 'inlay') {
        widget.pos.x = widget.pos.x + currentLineLength
      }
      widget.pos.y = line + 1
      widgetsChanged = true
    }
    else if (widget.pos.y > widgetLine) {
      widget.pos.y--
      widgetsChanged = true
    }
  }

  publishWidgetsIfChanged(doc, widgetsChanged)

  doc.errors = doc.errors.map(error =>
    adjustError(error, (x, y) => {
      if (y === line + 2) return { x: [x[0] + currentLineLength, x[1] + currentLineLength], y: line + 1 }
      if (y > line + 2) return { x, y: y - 1 }
      return null
    })
  )
}

export function adjustWidgetsOnColumnInsert(doc: Doc, line: number, column: number, length: number,
  newLineLength: number)
{
  const widgetLine = line + 1
  const widgetColumn = column + 1
  const newWidgetLineLength = newLineLength + 1
  let widgetsChanged = false
  for (const widget of doc.widgets) {
    if (widget.pos.y === widgetLine) {
      if (widget.type === 'above' || widget.type === 'below' || widget.type === 'overlay') {
        const [startColumn, endColumn] = widget.pos.x
        if (startColumn >= widgetColumn) {
          widget.pos.x[0] = startColumn + length
          widget.pos.x[1] = Math.min(endColumn + length, newWidgetLineLength)
          widgetsChanged = true
        }
        else if (widgetColumn > startColumn && widgetColumn < endColumn) {
          widget.pos.x[1] = Math.min(endColumn + length, newWidgetLineLength)
          if (widget.pos.x[1] < widget.pos.x[0]) {
            widget.pos.x[1] = widget.pos.x[0]
          }
          widgetsChanged = true
        }
      }
      else if (widget.type === 'before' || widget.type === 'inlay') {
        if (widget.pos.x >= widgetColumn) {
          widget.pos.x = Math.min(widget.pos.x + length, newWidgetLineLength)
          widgetsChanged = true
        }
      }
      else if (widget.type === 'after') {
        if (widget.pos.x > widgetColumn) {
          widget.pos.x = Math.min(widget.pos.x + length, newWidgetLineLength)
          widgetsChanged = true
        }
      }
    }
  }

  publishWidgetsIfChanged(doc, widgetsChanged)

  doc.errors = doc.errors.map(error =>
    adjustError(error, (x, y) => {
      if (y !== line + 1) return null
      const [startColumn, endColumn] = [x[0] - 1, x[1] - 1]
      if (startColumn >= column) {return {
          x: [startColumn + length + 1, Math.min(endColumn + length + 1, newLineLength)],
          y,
        }}
      if (endColumn >= column) {
        const end = Math.min(endColumn + length + 1, newLineLength)
        return { x: [x[0], Math.max(end, x[0])], y }
      }
      return null
    })
  )
}

export function adjustWidgetsOnLineDeleteRange(doc: Doc, startLine: number, endLine: number) {
  const deletedCount = endLine - startLine
  const startWidgetLine = startLine + 1
  const endWidgetLine = endLine + 1

  const widgetsToRemove: Widget[] = []
  let widgetsChanged = false
  for (const widget of doc.widgets) {
    if (widget.pos.y > startWidgetLine && widget.pos.y <= endWidgetLine) {
      widgetsToRemove.push(widget)
    }
    else if (widget.pos.y > endWidgetLine) {
      widget.pos.y -= deletedCount
      widgetsChanged = true
    }
  }

  for (const widget of widgetsToRemove) {
    const index = doc.widgets.indexOf(widget)
    if (index !== -1) {
      doc.widgets.splice(index, 1)
      widgetsChanged = true
    }
  }

  publishWidgetsIfChanged(doc, widgetsChanged)

  doc.errors = doc.errors.flatMap(error => {
    const y = error.y
    if (y > startLine && y <= endLine) return []
    if (y > endLine) {
      const next = adjustError(error, (x, y) => ({ x, y: y - deletedCount }))
      return [next]
    }
    return [error]
  })
}

export function adjustWidgetsOnMultiLineDelete(
  doc: Doc,
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  startLineLength: number,
) {
  if (endLine === startLine) {
    const deletedLength = endColumn - startColumn
    adjustWidgetsOnColumnDelete(doc, startLine, startColumn, deletedLength)
    return
  }

  const deletedFromStartLine = startLineLength - startColumn
  if (deletedFromStartLine > 0) {
    adjustWidgetsOnColumnDelete(doc, startLine, startColumn, deletedFromStartLine)
  }

  const startWidgetLine = startLine + 1
  const endWidgetLine = endLine + 1
  const endWidgetColumn = endColumn + 1
  const deletedCount = endLine - startLine
  const widgetsToRemove: Widget[] = []
  let widgetsChanged = false

  for (const widget of doc.widgets) {
    if (widget.pos.y > startWidgetLine && widget.pos.y < endWidgetLine) {
      widgetsToRemove.push(widget)
      continue
    }

    if (widget.pos.y === endWidgetLine) {
      if (widget.type === 'above' || widget.type === 'below' || widget.type === 'overlay') {
        const [startCol, endCol] = widget.pos.x
        if (endColumn === 0) {
          widget.pos.x[0] = startCol + startColumn
          widget.pos.x[1] = endCol + startColumn
          widget.pos.y = startWidgetLine
          widgetsChanged = true
        }
        else if (startCol >= endWidgetColumn) {
          widget.pos.x[0] = startCol - endColumn + startColumn
          widget.pos.x[1] = endCol - endColumn + startColumn
          widget.pos.y = startWidgetLine
          widgetsChanged = true
        }
        else if (endCol > endWidgetColumn) {
          widget.pos.x[0] = startColumn + 1
          widget.pos.x[1] = endCol - endColumn + startColumn
          widget.pos.y = startWidgetLine
          widgetsChanged = true
        }
        else {
          widgetsToRemove.push(widget)
        }
      }
      else if (widget.type === 'before' || widget.type === 'after' || widget.type === 'inlay') {
        if (endColumn === 0) {
          widget.pos.x = widget.pos.x + startColumn
          widget.pos.y = startWidgetLine
          widgetsChanged = true
        }
        else if (widget.pos.x >= endWidgetColumn) {
          widget.pos.x = widget.pos.x - endColumn + startColumn
          widget.pos.y = startWidgetLine
          widgetsChanged = true
        }
        else {
          widgetsToRemove.push(widget)
        }
      }
      else if (widget.type === 'full') {
        widget.pos.y = startWidgetLine
        widgetsChanged = true
      }
      continue
    }

    if (widget.pos.y > endWidgetLine) {
      widget.pos.y -= deletedCount
      widgetsChanged = true
    }
  }

  for (const widget of widgetsToRemove) {
    const index = doc.widgets.indexOf(widget)
    if (index !== -1) {
      doc.widgets.splice(index, 1)
      widgetsChanged = true
    }
  }

  publishWidgetsIfChanged(doc, widgetsChanged)

  doc.errors = doc.errors.flatMap(error => {
    if (isDerivedError(error)) return [error]
    if (error.y > startWidgetLine && error.y < endWidgetLine) return []

    if (error.y === endWidgetLine) {
      if (endColumn === 0) {
        return [{
          ...error,
          x: [error.x[0] + startColumn, error.x[1] + startColumn],
          y: startWidgetLine,
        }]
      }

      const [errorStartCol, errorEndCol] = [error.x[0] - 1, error.x[1] - 1]
      if (errorStartCol >= endColumn) {
        return [{
          ...error,
          x: [errorStartCol - endColumn + startColumn + 1, errorEndCol - endColumn + startColumn + 1],
          y: startWidgetLine,
        }]
      }
      if (errorEndCol > endColumn) {
        return [{
          ...error,
          x: [startColumn + 1, errorEndCol - endColumn + startColumn + 1],
          y: startWidgetLine,
        }]
      }
      return []
    }

    if (error.y > endWidgetLine) {
      return [{ ...error, y: error.y - deletedCount }]
    }

    return [error]
  })
}

export function adjustWidgetsOnColumnDelete(doc: Doc, line: number, column: number, length: number) {
  const widgetLine = line + 1
  const widgetColumn = column + 1
  let widgetsChanged = false
  for (const widget of doc.widgets) {
    if (widget.pos.y === widgetLine) {
      if (widget.type === 'above' || widget.type === 'below' || widget.type === 'overlay') {
        const [startColumn, endColumn] = widget.pos.x
        if (startColumn >= widgetColumn + length) {
          widget.pos.x[0] = startColumn - length
          widget.pos.x[1] = endColumn - length
          widgetsChanged = true
        }
        else if (startColumn >= widgetColumn) {
          widget.pos.x[0] = widgetColumn
          if (endColumn >= widgetColumn + length) {
            widget.pos.x[1] = endColumn - length
          }
          else {
            widget.pos.x[1] = widgetColumn
          }
          widgetsChanged = true
        }
        else if (endColumn >= widgetColumn + length) {
          widget.pos.x[1] = endColumn - length
          widgetsChanged = true
        }
        else if (endColumn > widgetColumn) {
          widget.pos.x[1] = widgetColumn
          widgetsChanged = true
        }
      }
      else if (widget.type === 'before' || widget.type === 'after' || widget.type === 'inlay') {
        if (widget.pos.x >= widgetColumn + length) {
          widget.pos.x -= length
          widgetsChanged = true
        }
        else if (widget.pos.x >= widgetColumn) {
          widget.pos.x = widgetColumn
          widgetsChanged = true
        }
      }
    }
  }

  publishWidgetsIfChanged(doc, widgetsChanged)

  const col1 = column + 1
  doc.errors = doc.errors.map(error =>
    adjustError(error, (x, y) => {
      if (y !== line + 1) return null
      const [startColumn, endColumn] = [x[0] - 1, x[1] - 1]
      if (startColumn >= column + length) return { x: [startColumn - length + 1, endColumn - length + 1], y }
      if (startColumn >= column) {
        const end = endColumn >= column + length ? endColumn - length + 1 : col1
        return { x: [col1, end], y }
      }
      if (endColumn >= column + length) return { x: [x[0], endColumn - length + 1], y }
      if (endColumn > column) return { x: [x[0], col1], y }
      return null
    })
  )
}
