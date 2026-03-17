import { beforeEach, describe, expect, it } from 'bun:test'
import { createDoc } from '../src/doc.ts'
import {
  adjustWidgetsOnLineDeleteRange,
  adjustWidgetsOnLineSplit,
  adjustWidgetsOnMultiLineDelete,
  type Widget,
} from '../src/widget.ts'

describe('Widget adjustments', () => {
  let doc: ReturnType<typeof createDoc>

  beforeEach(() => {
    doc = createDoc()
    doc.buffer.code.value = 'line0\nline1\nline2\nline3\nline4'
    doc.widgets.length = 0
    doc.errors.length = 0
  })

  function createWidget(
    type: Widget['type'],
    line: number,
    x: number | [number, number],
    extra?: Partial<Widget>,
  ): Widget {
    const base = {
      draw: () => {},
    }

    if (type === 'above' || type === 'below' || type === 'overlay') {
      return {
        ...base,
        type,
        pos: { x: x as [number, number], y: line + 1 },
        ...extra,
      } as Widget
    }
    else if (type === 'before' || type === 'after') {
      return {
        ...base,
        type,
        pos: { x: x as number, y: line + 1, width: 10 },
        ...extra,
      } as Widget
    }
    else if (type === 'inlay') {
      return {
        ...base,
        type,
        pos: { x: x as number, y: line + 1 },
        content: 'test',
        ...extra,
      } as Widget
    }
    else {
      return {
        ...base,
        type: 'full',
        pos: { y: line + 1 },
        ...extra,
      } as Widget
    }
  }

  describe('adjustWidgetsOnLineSplit', () => {
    it('moves inlay widgets to the inserted tail column when splitting a line', () => {
      doc.widgets.push(
        createWidget('inlay', 1, 8),
        createWidget('inlay', 1, 2),
        createWidget('inlay', 3, 5),
      )

      adjustWidgetsOnLineSplit(doc, 1, 2, 1, 4)

      const movedInlay = doc.widgets.find(widget => widget.pos.y === 3 && widget.type === 'inlay')
      const sameLineInlay = doc.widgets.find(widget => widget.pos.y === 2 && widget.type === 'inlay')
      const shiftedLineInlay = doc.widgets.find(widget => widget.pos.y === 5 && widget.type === 'inlay')

      expect(movedInlay?.pos.x).toBe(10)
      expect(sameLineInlay?.pos.x).toBe(2)
      expect(shiftedLineInlay?.pos.x).toBe(5)
    })

    it('moves errors to the inserted tail column when splitting a line', () => {
      doc.errors.push(
        { x: [8, 10], y: 2, message: 'error' },
      )

      adjustWidgetsOnLineSplit(doc, 1, 2, 1, 4)

      expect(doc.errors).toHaveLength(1)
      expect(doc.errors[0].y).toBe(3)
      expect(doc.errors[0].x).toEqual([10, 12])
    })
  })

  describe('adjustWidgetsOnLineDeleteRange', () => {
    it('should remove widgets on deleted lines', () => {
      doc.widgets.push(
        createWidget('above', 1, [1, 5]),
        createWidget('below', 2, [1, 5]),
        createWidget('overlay', 3, [1, 5]),
      )

      adjustWidgetsOnLineDeleteRange(doc, 1, 2)

      expect(doc.widgets.length).toBe(2)
      const sorted = doc.widgets.sort((a, b) => a.pos.y - b.pos.y)
      expect(sorted[0].pos.y).toBe(2)
      expect(sorted[1].pos.y).toBe(3)
    })

    it('should move widgets below deleted range up', () => {
      doc.widgets.push(
        createWidget('above', 0, [1, 5]),
        createWidget('below', 3, [1, 5]),
        createWidget('overlay', 4, [1, 5]),
      )

      adjustWidgetsOnLineDeleteRange(doc, 1, 2)

      expect(doc.widgets.length).toBe(3)
      const sorted = doc.widgets.sort((a, b) => a.pos.y - b.pos.y)
      expect(sorted[0].pos.y).toBe(1)
      expect(sorted[1].pos.y).toBe(3)
      expect(sorted[2].pos.y).toBe(4)
    })

    it('should not affect widgets above deleted range', () => {
      doc.widgets.push(
        createWidget('above', 0, [1, 5]),
        createWidget('below', 1, [1, 5]),
      )

      adjustWidgetsOnLineDeleteRange(doc, 2, 3)

      expect(doc.widgets.length).toBe(2)
      expect(doc.widgets[0].pos.y).toBe(1)
      expect(doc.widgets[1].pos.y).toBe(2)
    })

    it('should handle errors correctly', () => {
      doc.errors.push(
        { x: [1, 5], y: 1, message: 'error1' },
        { x: [1, 5], y: 2, message: 'error2' },
        { x: [1, 5], y: 3, message: 'error3' },
      )

      adjustWidgetsOnLineDeleteRange(doc, 1, 2)

      expect(doc.errors.length).toBe(2)
      expect(doc.errors[0].y).toBe(1)
      expect(doc.errors[1].y).toBe(2)
    })
  })

  describe('adjustWidgetsOnMultiLineDelete', () => {
    it('should handle single line deletion (column delete)', () => {
      doc.widgets.push(
        createWidget('above', 1, [1, 5]),
        createWidget('below', 1, [6, 10]),
      )

      adjustWidgetsOnMultiLineDelete(doc, 1, 2, 1, 5, 10)

      expect(doc.widgets.length).toBe(2)
      const above = doc.widgets.find(w => w.type === 'above')
      const below = doc.widgets.find(w => w.type === 'below')
      expect(above?.pos.x).toEqual([1, 3])
      expect(below?.pos.x).toEqual([3, 7])
    })

    it('should remove widgets on fully deleted lines', () => {
      doc.widgets.push(
        createWidget('above', 0, [1, 5]),
        createWidget('below', 1, [1, 5]),
        createWidget('overlay', 2, [1, 5]),
        createWidget('above', 3, [1, 5]),
      )

      adjustWidgetsOnMultiLineDelete(doc, 0, 5, 2, 0, 5)

      expect(doc.widgets.length).toBe(3)
      const widgets = doc.widgets.map(w => ({ type: w.type, y: w.pos.y }))
      expect(widgets).toContainEqual({ type: 'above', y: 1 })
      expect(widgets).toContainEqual({ type: 'below', y: 2 })
      expect(widgets).toContainEqual({ type: 'above', y: 3 })
    })

    it('should move widgets from end line to start line when endColumn > 0', () => {
      doc.widgets.push(
        createWidget('above', 0, [1, 5]),
        createWidget('below', 2, [6, 10]),
        createWidget('overlay', 2, [11, 15]),
      )

      adjustWidgetsOnMultiLineDelete(doc, 0, 3, 2, 5, 5)

      expect(doc.widgets.length).toBe(3)
      const movedBelow = doc.widgets.find(w => w.type === 'below')
      const movedOverlay = doc.widgets.find(w => w.type === 'overlay')
      expect(movedBelow?.pos.y).toBe(1)
      expect(movedBelow?.pos.x).toEqual([4, 8])
      expect(movedOverlay?.pos.y).toBe(1)
      expect(movedOverlay?.pos.x).toEqual([9, 13])
    })

    it('should clip widgets that span deletion point on end line', () => {
      doc.widgets.push(
        createWidget('above', 2, [3, 8]),
      )

      adjustWidgetsOnMultiLineDelete(doc, 0, 5, 2, 5, 5)

      expect(doc.widgets.length).toBe(1)
      const widget = doc.widgets[0]
      expect(widget.pos.y).toBe(1)
      expect(widget.pos.x).toEqual([6, 8])
    })

    it('should handle widgets before deletion point on end line', () => {
      doc.widgets.push(
        createWidget('before', 2, 3),
        createWidget('after', 2, 4),
        createWidget('inlay', 2, 2),
      )

      adjustWidgetsOnMultiLineDelete(doc, 0, 5, 2, 5, 5)

      expect(doc.widgets.length).toBe(3)
      const sorted = doc.widgets.sort((a, b) => (a.pos.x as number) - (b.pos.x as number))
      expect(sorted[0].pos.x).toBe(2)
      expect(sorted[1].pos.x).toBe(3)
      expect(sorted[2].pos.x).toBe(4)
      expect(sorted.every(w => w.pos.y === 3)).toBe(true)
    })

    it('should move widgets after deletion point on end line', () => {
      doc.widgets.push(
        createWidget('before', 2, 6),
        createWidget('after', 2, 7),
        createWidget('inlay', 2, 8),
      )

      adjustWidgetsOnMultiLineDelete(doc, 0, 5, 2, 5, 5)

      expect(doc.widgets.length).toBe(3)
      expect(doc.widgets[0].pos.y).toBe(1)
      expect(doc.widgets[0].pos.x).toBe(6)
      expect(doc.widgets[1].pos.y).toBe(1)
      expect(doc.widgets[1].pos.x).toBe(7)
      expect(doc.widgets[2].pos.y).toBe(1)
      expect(doc.widgets[2].pos.x).toBe(8)
    })

    it('should move full widgets from end line', () => {
      doc.widgets.push(
        createWidget('full', 2),
      )

      adjustWidgetsOnMultiLineDelete(doc, 0, 5, 2, 5, 5)

      expect(doc.widgets.length).toBe(1)
      expect(doc.widgets[0].pos.y).toBe(1)
    })

    it('should adjust widgets on start line', () => {
      doc.widgets.push(
        createWidget('above', 0, [6, 10]),
      )

      adjustWidgetsOnMultiLineDelete(doc, 0, 3, 1, 0, 10)

      expect(doc.widgets.length).toBe(1)
      const widget = doc.widgets[0]
      expect(widget.pos.x).toEqual([4, 4])
    })

    it('should move widgets below deleted range up', () => {
      doc.widgets.push(
        createWidget('above', 3, [1, 5]),
        createWidget('below', 4, [1, 5]),
      )

      adjustWidgetsOnMultiLineDelete(doc, 0, 5, 2, 0, 5)

      expect(doc.widgets.length).toBe(2)
      const sorted = doc.widgets.sort((a, b) => a.pos.y - b.pos.y)
      expect(sorted[0].pos.y).toBe(3)
      expect(sorted[1].pos.y).toBe(4)
    })

    it('should handle errors on deleted lines', () => {
      doc.errors.push(
        { x: [1, 5], y: 1, message: 'error1' },
        { x: [6, 10], y: 2, message: 'error2' },
      )

      adjustWidgetsOnMultiLineDelete(doc, 0, 5, 2, 0, 5)

      expect(doc.errors.length).toBe(1)
      expect(doc.errors[0].y).toBe(1)
      expect(doc.errors[0].x).toEqual([1, 5])
    })

    it('should move errors from end line to start line when endColumn > 0', () => {
      doc.errors.push(
        { x: [6, 10], y: 2, message: 'error1' },
        { x: [3, 8], y: 2, message: 'error2' },
      )

      adjustWidgetsOnMultiLineDelete(doc, 0, 5, 2, 5, 5)

      expect(doc.errors.length).toBe(2)
      expect(doc.errors[0].y).toBe(0)
      expect(doc.errors[0].x).toEqual([6, 10])
      expect(doc.errors[1].y).toBe(0)
      expect(doc.errors[1].x).toEqual([5, 8])
    })

    it('should handle complex multi-line deletion scenario', () => {
      doc.widgets.push(
        createWidget('above', 0, [1, 3]),
        createWidget('below', 1, [1, 5]),
        createWidget('overlay', 2, [6, 10]),
        createWidget('before', 3, 1),
        createWidget('above', 4, [1, 5]),
      )

      adjustWidgetsOnMultiLineDelete(doc, 0, 2, 2, 3, 5)

      expect(doc.widgets.length).toBe(5)
      const above = doc.widgets.find(w => w.type === 'above' && w.pos.y === 1)
      const overlay = doc.widgets.find(w => w.type === 'overlay')
      const before = doc.widgets.find(w => w.type === 'before')
      expect(above?.pos.x).toEqual([1, 3])
      expect(overlay?.pos.y).toBe(1)
      expect(overlay?.pos.x).toEqual([5, 9])
      expect(before?.pos.y).toBe(2)
    })
  })
})
