import type { Doc, DocError } from './doc.ts'

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

export function adjustWidgetsOnLineSplit(doc: Doc, line: number, column: number, delta: number) {
  const widgetLine = line + 1
  const widgetColumn = column + 1
  for (const widget of doc.widgets) {
    if (widget.pos.y === widgetLine) {
      let shouldMove = false

      if (widget.type === 'above' || widget.type === 'below' || widget.type === 'overlay') {
        const [startColumn, endColumn] = widget.pos.x
        if (startColumn >= widgetColumn) {
          shouldMove = true
          widget.pos.x[0] = startColumn - column
          widget.pos.x[1] = endColumn - column
        }
        else if (endColumn >= widgetColumn) {
          widget.pos.x[1] = widgetColumn
        }
      }
      else if (widget.type === 'before' || widget.type === 'after' || widget.type === 'inlay') {
        const widgetCol = widget.pos.x
        shouldMove = widgetCol >= widgetColumn
        if (shouldMove) {
          widget.pos.x = widgetCol - column
        }
      }
      else if (widget.type === 'full') {
        shouldMove = true
      }

      if (shouldMove) {
        widget.pos.y += delta
      }
    }
    else if (widget.pos.y > widgetLine) {
      widget.pos.y += delta
    }
  }

  doc.errors = doc.errors.map(error =>
    adjustError(error, (x, y) => {
      if (y === line + 1) {
        const [startColumn, endColumn] = [x[0] - 1, x[1] - 1]
        if (startColumn >= column) return { x: [startColumn - column + 1, endColumn - column + 1], y: y + delta }
        if (endColumn >= column) return { x: [x[0], column + 1], y }
        return null
      }
      if (y > line + 1) return { x, y: y + delta }
      return null
    })
  )
}

export function adjustWidgetsOnLineMerge(doc: Doc, line: number, prevLineLength: number) {
  const widgetLine = line + 1
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
    }
    else if (widget.pos.y > widgetLine) {
      widget.pos.y--
    }
  }

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
    }
    else if (widget.pos.y > widgetLine) {
      widget.pos.y--
    }
  }

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
  for (const widget of doc.widgets) {
    if (widget.pos.y === widgetLine) {
      if (widget.type === 'above' || widget.type === 'below' || widget.type === 'overlay') {
        const [startColumn, endColumn] = widget.pos.x
        if (startColumn >= widgetColumn) {
          widget.pos.x[0] = startColumn + length
          widget.pos.x[1] = Math.min(endColumn + length, newWidgetLineLength)
        }
        else if (widgetColumn > startColumn && widgetColumn < endColumn) {
          widget.pos.x[1] = Math.min(endColumn + length, newWidgetLineLength)
          if (widget.pos.x[1] < widget.pos.x[0]) {
            widget.pos.x[1] = widget.pos.x[0]
          }
        }
      }
      else if (widget.type === 'before' || widget.type === 'inlay') {
        if (widget.pos.x >= widgetColumn) {
          widget.pos.x = Math.min(widget.pos.x + length, newWidgetLineLength)
        }
      }
      else if (widget.type === 'after') {
        if (widget.pos.x > widgetColumn) {
          widget.pos.x = Math.min(widget.pos.x + length, newWidgetLineLength)
        }
      }
    }
  }

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
  for (const widget of doc.widgets) {
    if (widget.pos.y > startWidgetLine && widget.pos.y <= endWidgetLine) {
      widgetsToRemove.push(widget)
    }
    else if (widget.pos.y > endWidgetLine) {
      widget.pos.y -= deletedCount
    }
  }

  for (const widget of widgetsToRemove) {
    const index = doc.widgets.indexOf(widget)
    if (index !== -1) {
      doc.widgets.splice(index, 1)
    }
  }

  doc.errors = doc.errors.flatMap(error => {
    const y = error.y
    if (y > startLine + 1 && y <= endLine + 1) return []
    if (y > endLine + 1) {
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

  if (endColumn > 0) {
    const endWidgetLine = endLine + 1
    const endWidgetColumn = endColumn + 1
    const startWidgetLine = startLine + 1
    const deletedCount = endLine - startLine

    for (const widget of doc.widgets) {
      if (widget.pos.y === endWidgetLine) {
        if (widget.type === 'above' || widget.type === 'below' || widget.type === 'overlay') {
          const [startCol, endCol] = widget.pos.x
          if (startCol >= endWidgetColumn) {
            widget.pos.x[0] = startCol - endColumn + startColumn
            widget.pos.x[1] = endCol - endColumn + startColumn
            widget.pos.y = startWidgetLine
          }
          else if (endCol > endWidgetColumn) {
            widget.pos.x[0] = startColumn + 1
            widget.pos.x[1] = endCol - endColumn + startColumn
            widget.pos.y = startWidgetLine
          }
        }
        else if (widget.type === 'before' || widget.type === 'after' || widget.type === 'inlay') {
          if (widget.pos.x >= endWidgetColumn) {
            widget.pos.x = widget.pos.x - endColumn + startColumn
            widget.pos.y = startWidgetLine
          }
        }
        else if (widget.type === 'full') {
          widget.pos.y = startWidgetLine
        }
      }
      else if (widget.pos.y > endWidgetLine) {
        widget.pos.y -= deletedCount
      }
    }

    if (endLine > startLine + 1) {
      adjustWidgetsOnLineDeleteRange(doc, startLine + 1, endLine - 1)
    }

    doc.errors = doc.errors.map(error =>
      adjustError(error, (x, y) => {
        if (y === endLine + 1) {
          const [errorStartCol, errorEndCol] = [x[0] - 1, x[1] - 1]
          if (errorStartCol >= endColumn) {
            return { x: [errorStartCol - endColumn + startColumn + 1, errorEndCol - endColumn + startColumn + 1],
              y: startLine + 1 }
          }
          if (errorEndCol > endColumn) {
            return { x: [startColumn + 1, errorEndCol - endColumn + startColumn + 1], y: startLine + 1 }
          }
          return null
        }
        if (y > endLine + 1) return { x, y: y - deletedCount }
        return null
      })
    )
  }
  else {
    adjustWidgetsOnLineDeleteRange(doc, startLine + 1, endLine)
  }
}

export function adjustWidgetsOnColumnDelete(doc: Doc, line: number, column: number, length: number) {
  const widgetLine = line + 1
  const widgetColumn = column + 1
  for (const widget of doc.widgets) {
    if (widget.pos.y === widgetLine) {
      if (widget.type === 'above' || widget.type === 'below' || widget.type === 'overlay') {
        const [startColumn, endColumn] = widget.pos.x
        if (startColumn >= widgetColumn + length) {
          widget.pos.x[0] = startColumn - length
          widget.pos.x[1] = endColumn - length
        }
        else if (startColumn >= widgetColumn) {
          widget.pos.x[0] = widgetColumn
          if (endColumn >= widgetColumn + length) {
            widget.pos.x[1] = endColumn - length
          }
          else {
            widget.pos.x[1] = widgetColumn
          }
        }
        else if (endColumn >= widgetColumn + length) {
          widget.pos.x[1] = endColumn - length
        }
        else if (endColumn > widgetColumn) {
          widget.pos.x[1] = widgetColumn
        }
      }
      else if (widget.type === 'before' || widget.type === 'after' || widget.type === 'inlay') {
        if (widget.pos.x >= widgetColumn + length) {
          widget.pos.x -= length
        }
        else if (widget.pos.x >= widgetColumn) {
          widget.pos.x = widgetColumn
        }
      }
    }
  }

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
