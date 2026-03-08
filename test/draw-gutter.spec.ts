import { describe, expect, it } from 'bun:test'
import { hitTestGutter } from '../src/draw/gutter.ts'
import type { VisualLine } from '../src/lines.ts'

function createVisualLine(overrides: Partial<VisualLine> = {}): VisualLine {
  return {
    logicalLine: 0,
    y: 0,
    height: 20,
    width: 10,
    tokenOffset: 0,
    tokens: [
      {
        token: { type: 'text', text: 'x' },
        x: 0,
        endX: 10,
        tokenEndX: 10,
        logicalTokenIndex: 0,
      },
    ],
    widgets: {
      above: [],
      below: [],
      overlay: [],
      inlay: [],
      beforeAfter: [],
      full: [],
    },
    errors: [],
    ...overrides,
  } as VisualLine
}

describe('gutter collapse hit testing', () => {
  it('detects collapse clicks when toggle sits in padding-extended gutter area', () => {
    const visualLine = createVisualLine()
    const lineNumberMap = new Map<number, VisualLine[]>([[0, [visualLine]]])
    const blockStarts = new Set<number>([0])

    const result = hitTestGutter(
      { size: { height: { value: 100 } } } as any,
      { paddingLeft: 20, paddingTop: 0 } as any,
      { visualLines: { value: [visualLine] } } as any,
      { pos: { y: 0 } } as any,
      {
        width: { value: 40 },
        lineNumberMap: { value: lineNumberMap },
        blockStarts: { value: blockStarts },
      } as any,
      44,
      8,
      0,
    )

    expect(result.type).toBe('collapse')
    expect(result.line).toBe(0)
  })

  it('returns line hit when clicking away from collapse toggle', () => {
    const visualLine = createVisualLine()
    const lineNumberMap = new Map<number, VisualLine[]>([[0, [visualLine]]])
    const blockStarts = new Set<number>([0])

    const result = hitTestGutter(
      { size: { height: { value: 100 } } } as any,
      { paddingLeft: 20, paddingTop: 0 } as any,
      { visualLines: { value: [visualLine] } } as any,
      { pos: { y: 0 } } as any,
      {
        width: { value: 40 },
        lineNumberMap: { value: lineNumberMap },
        blockStarts: { value: blockStarts },
      } as any,
      25,
      8,
      0,
    )

    expect(result.type).toBe('line')
    expect(result.line).toBe(0)
  })
})
