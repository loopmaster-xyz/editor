import { describe, expect, it } from 'bun:test'
import { drawCaret, getCaretScreenPosition } from '../src/draw/caret.ts'
import { setActiveCanvas } from '../src/textarea-singleton.ts'

function createCanvasContextStub() {
  return {
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
  }
}

describe('caret screen position', () => {
  it('returns cached caret screen position via deprecated helper', () => {
    const context = {
      caret: {
        screenPosition: { x: 12, y: 34 },
      },
    }

    expect(getCaretScreenPosition(context as any)).toEqual({ x: 12, y: 34 })
  })

  it('clears caret state when editor is unfocused', () => {
    setActiveCanvas(null)

    const caretState = {
      screenPosition: { x: 9, y: 9 },
      caretToken: { x: 1, y: 1 },
      line: { value: 0 },
      column: { value: 0 },
      isTyping: { value: false },
      updateBlink: () => 1,
    }

    const context = {
      canvas: {
        el: {} as HTMLCanvasElement,
        c: createCanvasContextStub(),
      },
      caret: caretState,
      mouse: {
        buttonsDown: { value: false },
        hovered: { hoverToken: null },
      },
    }

    drawCaret(context as any)
    expect(caretState.screenPosition).toBeNull()
    expect(caretState.caretToken).toBeNull()
  })

  it('stores screen position when caret resolves through synthetic fallback line', () => {
    const canvasEl = {} as HTMLCanvasElement
    setActiveCanvas(canvasEl)

    const visualLine = {
      tokens: [{
        token: { type: 'text', text: 'a' },
        x: 0,
        tokenEndX: 10,
        endX: 10,
        logicalTokenIndex: 0,
      }],
      logicalLine: 0,
      tokenOffset: 0,
      y: 0,
      width: 10,
      height: 10,
      widgets: {
        above: [],
        below: [],
        overlay: [],
        inlay: [],
        beforeAfter: [],
        full: [],
      },
      errors: [],
    }

    const caretState = {
      screenPosition: null as { x: number; y: number } | null,
      caretToken: { x: 1, y: 1 } as any,
      line: { value: 1 },
      column: { value: 0 },
      isTyping: { value: false },
      updateBlink: () => 1,
    }

    const context = {
      canvas: {
        el: canvasEl,
        c: createCanvasContextStub(),
        rect: { left: 0, top: 0 },
      },
      doc: {
        lines: ['a', ''],
        tokenLines: [[{ type: 'text', text: 'a' }], []],
        widgets: [],
      },
      lines: {
        visualLines: { value: [visualLine] },
        visualLinesByLogicalLine: { value: [[visualLine]] },
      },
      caret: caretState,
      settings: {
        lineHeight: 10,
        paddingLeft: 0,
        paddingTop: 0,
        colors: { brightWhite: '#fff' },
      },
      caches: {
        getXFromColumnCache: new Map<string, number>(),
        findVisualLineForColumnCache: new Map<string, unknown>(),
      },
      gutter: { width: { value: 0 } },
      scroll: { pos: { x: 0, y: 0 } },
      header: { value: null },
      mouse: {
        buttonsDown: { value: false },
        hovered: { hoverToken: null },
      },
    }

    drawCaret(context as any)
    expect(caretState.screenPosition).toEqual({ x: 1, y: 10 })
    expect(caretState.caretToken).toBeNull()
    setActiveCanvas(null)
  })
})
