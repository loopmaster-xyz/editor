import { describe, expect, it } from 'bun:test'
import type { VisualLine } from '../src/lines.ts'
import { getAboveHeight, shouldBreakBottom } from '../src/draw/widget.ts'

function makeLine(opts: {
  logicalLine: number
  tokenOffset: number
  y: number
  height: number
  text?: string
  withAboveWidget?: boolean
}): VisualLine {
  const text = opts.text ?? ''

  return {
    tokens: text.length > 0
      ? [{
        token: { type: 'text', text },
        x: 0,
        tokenEndX: text.length * 10,
        endX: text.length * 10,
        logicalTokenIndex: opts.tokenOffset,
      }]
      : [],
    logicalLine: opts.logicalLine,
    tokenOffset: opts.tokenOffset,
    y: opts.y,
    width: text.length * 10,
    height: opts.height,
    widgets: {
      above: opts.withAboveWidget
        ? [{
          type: 'above',
          pos: { x: [1, 2], y: opts.logicalLine + 1 },
          draw: () => {},
        }]
        : [],
      below: [],
      overlay: [],
      inlay: [],
      beforeAfter: [],
      full: [],
    },
    errors: [],
  } as unknown as VisualLine
}

describe('draw/widget above-height index', () => {
  it('returns same above height for wrapped visual lines with above widgets', () => {
    const visualLines = [
      makeLine({ logicalLine: 0, tokenOffset: 0, y: 0, height: 10, text: 'root' }),
      makeLine({ logicalLine: 1, tokenOffset: 0, y: 10, height: 10, text: '' }),
      makeLine({ logicalLine: 2, tokenOffset: 0, y: 20, height: 10, text: '' }),
      makeLine({ logicalLine: 3, tokenOffset: 0, y: 30, height: 10, text: 'wrapA' }),
      makeLine({ logicalLine: 3, tokenOffset: 1, y: 40, height: 10, text: 'wrapB', withAboveWidget: true }),
    ]

    expect(getAboveHeight(visualLines, visualLines[4])).toBe(20)
    expect(getAboveHeight(visualLines, visualLines[3])).toBe(0)
  })

  it('handles empty-line break decisions with above-widget carryover', () => {
    const visualLines = [
      makeLine({ logicalLine: 0, tokenOffset: 0, y: 0, height: 10, text: 'a' }),
      makeLine({ logicalLine: 1, tokenOffset: 0, y: 10, height: 10, text: '' }),
      makeLine({ logicalLine: 2, tokenOffset: 0, y: 20, height: 10, text: 'b', withAboveWidget: true }),
    ]

    const emptyLine = visualLines[1]
    expect(shouldBreakBottom(visualLines, emptyLine, 10, 15, 0)).toBe(false)
    expect(shouldBreakBottom(visualLines, emptyLine, 10, 5, 0)).toBe(true)
  })
})
