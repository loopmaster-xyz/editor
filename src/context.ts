import { batch, signal } from '@preact/signals-core'
import { createBlocks } from './blocks.ts'
import { createCaches } from './caches.ts'
import type { Canvas } from './canvas.ts'
import { createCanvas } from './canvas.ts'
import { createCaret } from './caret.ts'
import type { Doc, DocError } from './doc.ts'
import { createGutter } from './gutter.ts'
import type { Header } from './header.ts'
import { createKeyboard } from './keyboard.ts'
import { createLines } from './lines.ts'
import { createMetrics } from './metrics.ts'
import { createMouse } from './mouse.ts'
import { createScroll } from './scroll.ts'
import { createScrollbars } from './scrollbars.ts'
import { createSelection } from './selection.ts'
import { createSettings, type EditorSettings } from './settings.ts'
import type { Token } from './token.ts'

export enum Position {
  TopLeft,
  TopRight,
  BottomLeft,
  BottomRight,
}

export type Context = ReturnType<typeof createContext>

type EditorRef = { current: unknown }
type ActiveEditorOpts = { editorRef: EditorRef; setActiveEditor: (editor: unknown) => void }

export function createContext(editorSettings: Partial<EditorSettings>, doc: Doc, activeEditorOpts?: ActiveEditorOpts) {
  let onHoverToken:
    | ((canvas: Canvas, x: number, y: number, token: Token, callBlock: Token[], parameterIndex: number,
      callBlockX: number, callBlockY: number, doc: Doc, paramX?: number, paramY?: number,
      caretX?: number, caretY?: number) => Position | null)
    | null = null
  let onCaretToken:
    | ((canvas: Canvas, x: number, y: number, token: Token, callBlock: Token[], parameterIndex: number,
      callBlockX: number, callBlockY: number, doc: Doc, paramX?: number, paramY?: number,
      caretX?: number, caretY?: number) => Position | null)
    | null = null
  const settings = createSettings(editorSettings)
  const canvas = createCanvas(settings)
  const caches = createCaches(canvas, settings, doc)
  const metrics = createMetrics()
  const blocks = createBlocks(doc, caches)
  const header = signal<Header>(null)
  const lines = createLines(doc, canvas, metrics, settings, caches, blocks, header)
  const gutter = createGutter(doc, canvas, metrics, settings, caches, blocks, lines)
  const scroll = createScroll(canvas, lines, settings, gutter, header, metrics)
  blocks.setScrollSource(scroll)
  const scrollbars = createScrollbars(canvas, scroll, lines, settings, gutter, doc, header)
  const caret = createCaret(settings)
  const selection = createSelection()
  let pinnedError: DocError | null = null
  let tooltipDismissed = false
  let docIdentity: unknown = doc
  const notifyActivated = () => activeEditorOpts?.setActiveEditor(activeEditorOpts.editorRef.current)
  const mouse = createMouse(canvas, scroll, lines, settings, caches, doc, caret, scrollbars, selection, gutter, blocks,
    header, notifyActivated)
  const keyboard = createKeyboard(doc, canvas, scroll, lines, metrics, settings, caret, caches, selection, blocks,
    header, mouse, () => {
    pinnedError = null
    tooltipDismissed = true
  }, activeEditorOpts)

  const reset = () => {
    batch(() => {
      scroll.pos.x = Infinity
      scroll.pos.y = Infinity
      scroll.targetX.value = Infinity
      scroll.targetY.value = Infinity
    })
  }

  const dispose = () => {
    blocks.dispose()
    canvas.dispose()
    caches.dispose()
    keyboard.dispose()
    mouse.dispose()
  }

  return {
    settings,
    doc,
    get docIdentity() {
      return docIdentity
    },
    set docIdentity(value) {
      docIdentity = value
    },
    get pinnedError() {
      return pinnedError
    },
    set pinnedError(v) {
      pinnedError = v
    },
    get tooltipDismissed() {
      return tooltipDismissed
    },
    set tooltipDismissed(v) {
      tooltipDismissed = v
    },
    canvas,
    scroll,
    scrollbars,
    mouse,
    keyboard,
    caret,
    selection,
    lines,
    caches,
    metrics,
    gutter,
    blocks,
    header,
    get onHoverToken():
      | ((canvas: Canvas, x: number, y: number, token: Token, callBlock: Token[], parameterIndex: number,
        callBlockX: number, callBlockY: number, doc: Doc, paramX?: number, paramY?: number,
        caretX?: number, caretY?: number) => Position | null)
      | null
    {
      return onHoverToken
    },
    set onHoverToken(
      value:
        | ((canvas: Canvas, x: number, y: number, token: Token, callBlock: Token[], parameterIndex: number,
          callBlockX: number, callBlockY: number, doc: Doc, paramX?: number, paramY?: number,
          caretX?: number, caretY?: number) => Position | null)
        | null,
    ) {
      onHoverToken = value
    },
    get onCaretToken():
      | ((canvas: Canvas, x: number, y: number, token: Token, callBlock: Token[], parameterIndex: number,
        callBlockX: number, callBlockY: number, doc: Doc, paramX?: number, paramY?: number,
        caretX?: number, caretY?: number) => Position | null)
      | null
    {
      return onCaretToken
    },
    set onCaretToken(
      value:
        | ((canvas: Canvas, x: number, y: number, token: Token, callBlock: Token[], parameterIndex: number,
          callBlockX: number, callBlockY: number, doc: Doc, paramX?: number, paramY?: number,
          caretX?: number, caretY?: number) => Position | null)
        | null,
    ) {
      onCaretToken = value
    },
    reset,
    dispose,
  }
}
