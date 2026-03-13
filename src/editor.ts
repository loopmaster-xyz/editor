import { batch, effect, type Signal } from '@preact/signals-core'
import { BufferOpType } from './buffer.ts'
import type { Canvas } from './canvas.ts'
import { createContext, Position } from './context.ts'
import { createDoc, type Doc } from './doc.ts'
import { HORIZONTAL_SCROLLBAR_SIZE, invalidateMinimapRenderState } from './draw/scrollbar.ts'
import { activeEditor as activeEditorSignal, setActiveEditor } from './editor-state.ts'
import { disposables } from './lib/disposables.ts'
import { createRender, type Render } from './render.ts'
import type { EditorSettings } from './settings.ts'
import type { Token } from './token.ts'
import { defaultIncrementalTokenizer } from './tokenizer.ts'
import { warmup } from './warmup.ts'

export { Position } from './context.ts'
export { createDoc, createPersistedDoc, type Doc, type DocError } from './doc.ts'
export { drawRoundedRect, drawText } from './draw/util.ts'
export { type Header } from './header.ts'
export { type KeyOverrideHandler, onKeyOverride } from './key-override.ts'
export { measureText } from './measure.ts'
export { type OverlayCanvas } from './overlay-canvas.ts'
export { draw } from './render-manager.ts'
export { type Token, type TokenType } from './token.ts'
export { type Tokenizer } from './tokenizer.ts'
export { type Widget, type Widgets, type WidgetType } from './widget.ts'
export { type Canvas, EditorSettings }
export type OnHoverToken = (canvas: Canvas, x: number, y: number, token: Token, callBlock: Token[],
  parameterIndex: number, callBlockX: number, callBlockY: number, doc: Doc, paramX?: number, paramY?: number
) => Position | null

export type Editor = ReturnType<typeof createEditor>

export const activeEditor = activeEditorSignal as Signal<Editor | null>

export function createEditor(settings: Partial<EditorSettings> = {}) {
  const doc = createDoc(defaultIncrementalTokenizer)
  const editorRef = { current: null as Editor | null }
  const context = createContext(settings, doc, {
    editorRef,
    setActiveEditor,
  })

  let onHoverToken:
    | ((canvas: Canvas, x: number, y: number, token: Token, callBlock: Token[], parameterIndex: number,
      callBlockX: number, callBlockY: number, doc: Doc, paramX?: number, paramY?: number, caretX?: number,
      caretY?: number) => Position | null)
    | null = null
  let onCaretToken:
    | ((canvas: Canvas, x: number, y: number, token: Token, callBlock: Token[], parameterIndex: number,
      callBlockX: number, callBlockY: number, doc: Doc, paramX?: number, paramY?: number, caretX?: number,
      caretY?: number) => Position | null)
    | null = null

  let isEditorReady = false
  let pendingDoc: Doc | null = null

  const docEffects = disposables()

  const setDoc = async (newDoc: Doc) => {
    const effects = docEffects()
    if (!isEditorReady) {
      pendingDoc = newDoc
      return
    }

    void warmup(context, newDoc.tokenLines).catch(error => console.error(error))

    batch(() => {
      doc.tokenize = newDoc.tokenize
      doc.buffer.code.value = newDoc.buffer.code.value
      doc.buffer.history.value = newDoc.buffer.history.value
      doc.buffer.index.value = newDoc.buffer.index.value
    })
    invalidateMinimapRenderState(context)

    effects.push(
      (() => {
        let applyingFromDoc = false
        let applyingFromNewDoc = false

        const applyTo = (target: Doc, change: { start: number; deletedText: string; insertedText: string }) => {
          if (change.deletedText.length) {
            target.buffer.apply({
              type: BufferOpType.Delete,
              start: change.start,
              end: change.start + change.deletedText.length,
              text: change.deletedText,
            }, true)
          }
          if (change.insertedText.length) {
            target.buffer.apply({
              type: BufferOpType.Insert,
              index: change.start,
              text: change.insertedText,
            }, true)
          }
        }

        const unsubDoc = doc.buffer.onChange(change => {
          if (applyingFromNewDoc) return
          if (change.type === 'splice') {
            applyingFromDoc = true
            applyTo(newDoc, change)
            newDoc.buffer.history.value = doc.buffer.history.value
            newDoc.buffer.index.value = doc.buffer.index.value
            applyingFromDoc = false
            return
          }
          applyingFromDoc = true
          newDoc.buffer.code.value = change.nextCode
          newDoc.buffer.history.value = doc.buffer.history.value
          newDoc.buffer.index.value = doc.buffer.index.value
          applyingFromDoc = false
        })

        const unsubNewDoc = newDoc.buffer.onChange(change => {
          if (applyingFromDoc) return
          if (change.type === 'splice') {
            applyingFromNewDoc = true
            applyTo(doc, change)
            doc.buffer.history.value = newDoc.buffer.history.value
            doc.buffer.index.value = newDoc.buffer.index.value
            applyingFromNewDoc = false
            return
          }
          applyingFromNewDoc = true
          doc.buffer.code.value = change.nextCode
          doc.buffer.history.value = newDoc.buffer.history.value
          doc.buffer.index.value = newDoc.buffer.index.value
          applyingFromNewDoc = false
        })

        return () => {
          unsubDoc()
          unsubNewDoc()
        }
      })(),
      effect(() => {
        doc.widgets = newDoc.widgets
      }),
      effect(() => {
        doc.errors = newDoc.errors
        context.pinnedError = newDoc.errors[0] ?? null
      }),
      effect(() => {
        doc.collapsed = newDoc.collapsed
      }),
      effect(() => {
        newDoc.collapsed = doc.collapsed
      }),
      effect(() => {
        Object.assign(doc.caret, newDoc.caret)
      }),
      effect(() => {
        Object.assign(newDoc.caret, doc.caret)
      }),
      effect(() => {
        Object.assign(doc.scroll, newDoc.scroll)
      }),
      effect(() => {
        Object.assign(newDoc.scroll, doc.scroll)
      }),
      effect(() => {
        Object.assign(doc.selection, newDoc.selection)
      }),
      effect(() => {
        Object.assign(newDoc.selection, doc.selection)
      }),
    )

    batch(() => {
      const nextScrollX = Number.isFinite(newDoc.scroll.x) ? newDoc.scroll.x : 0
      const nextScrollY = Number.isFinite(newDoc.scroll.y) ? newDoc.scroll.y : 0
      context.scroll.pos.x = nextScrollX
      context.scroll.pos.y = nextScrollY
      context.scroll.targetX.value = nextScrollX
      context.scroll.targetY.value = nextScrollY
    })
  }

  let render: Render | undefined
  const start = async () => {
    try {
      await warmup(context, doc.tokenLines)
      render = createRender(context)
      isEditorReady = true
    }
    catch (error) {
      console.error(error)
    }
  }

  const editorEffects = disposables()

  start().then(() => {
    if (pendingDoc) {
      setDoc(pendingDoc)
      pendingDoc = null
    }
    editorEffects().push(
      effect(() => {
        context.caret.line.value = doc.caret.line
        context.caret.column.value = doc.caret.column
        context.caret.columnIntent.value = doc.caret.columnIntent
      }),
      effect(() => {
        doc.caret.line = context.caret.line.value
        doc.caret.column = context.caret.column.value
        doc.caret.columnIntent = context.caret.columnIntent.value
      }),
      effect(() => {
        if (context.scroll.targetX.value === Infinity || context.scroll.targetY.value === Infinity) {
          context.scroll.pos.x = doc.scroll.x
          context.scroll.pos.y = doc.scroll.y
          context.scroll.targetX.value = doc.scroll.x
          context.scroll.targetY.value = doc.scroll.y
        }
      }),
      effect(() => {
        if (context.scroll.targetX.value === Infinity || context.scroll.targetY.value === Infinity) {
          return
        }
        doc.scroll.x = context.scroll.targetX.value
        doc.scroll.y = context.scroll.targetY.value
      }),
      effect(() => {
        context.selection.start.value = doc.selection.start
        context.selection.end.value = doc.selection.end
        context.selection.direction.value = doc.selection.direction
      }),
      effect(() => {
        doc.selection.start = context.selection.start.value
        doc.selection.end = context.selection.end.value
        doc.selection.direction = context.selection.direction.value
      }),
      // auto height
      effect(() => {
        if (context.settings.autoHeight) {
          const availableWidth = context.canvas.size.width.value - context.settings.paddingLeft
            - context.settings.paddingRight - context.gutter.width.value
          const needsHorizontal = !context.settings.wordWrap
            && context.lines.totalWidth.value > availableWidth
          const scrollbarHeight = needsHorizontal ? HORIZONTAL_SCROLLBAR_SIZE : 0
          context.canvas.size.height.value = context.lines.totalHeight.value + (context.header.value?.height ?? 0)
            + context.settings.paddingTop + context.settings.paddingBottom + scrollbarHeight
        }
      }),
    )
  })

  const dispose = () => {
    if (activeEditor.value === editor) setActiveEditor(null)
    docEffects.dispose()
    editorEffects.dispose()
    render?.dispose()
    context.dispose()
  }

  const editor = {
    canvas: context.canvas.el,
    size: context.canvas.size,
    caret: context.caret,
    setDoc,
    focus: () => {
      activeEditor.value = editor
      context.keyboard.activate()
    },
    settings: context.settings,
    get header() {
      return context.header.value
    },
    set header(value) {
      context.header.value = value
    },
    get onHoverToken() {
      return onHoverToken
    },
    set onHoverToken(
      value:
        | ((canvas: Canvas, x: number, y: number, token: Token, callBlock: Token[], parameterIndex: number,
          callBlockX: number, callBlockY: number, doc: Doc, paramX?: number, paramY?: number, caretX?: number,
          caretY?: number) => Position | null)
        | null,
    ) {
      onHoverToken = value
      context.onHoverToken = value
    },
    get onCaretToken() {
      return onCaretToken
    },
    set onCaretToken(
      value:
        | ((canvas: Canvas, x: number, y: number, token: Token, callBlock: Token[], parameterIndex: number,
          callBlockX: number, callBlockY: number, doc: Doc, paramX?: number, paramY?: number, caretX?: number,
          caretY?: number) => Position | null)
        | null,
    ) {
      onCaretToken = value
      context.onCaretToken = value
    },
    dispose,
  }
  editorRef.current = editor
  return editor
}
