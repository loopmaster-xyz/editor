import { batch, effect, untracked } from '@preact/signals-core'
import { debounce } from 'utils/debounce'
import { createBuffer, unpack } from './buffer.ts'
import { signalify } from './lib/signalify.ts'
import type { SelectionDirection } from './selection.ts'
import type { Token } from './token.ts'
import { tokenize as defaultTokenizer, type Tokenizer } from './tokenizer.ts'
import type { Widget } from './widget.ts'

/** Line and column are 1-based (LSP/editor convention). */
export type DocError = {
  x: [start: number, end: number]
  y: number
  message: string
}

export type Doc = ReturnType<typeof createDoc>

export function createDoc(tokenize: Tokenizer = defaultTokenizer) {
  const buffer = createBuffer('')
  const doc = signalify({
    epoch: 0,
    get code(): string {
      return buffer.code.value
    },
    set code(value: string) {
      buffer.code.value = value
    },
    buffer,
    onChange: buffer.onChange,
    caret: signalify({ line: 0, column: 0, columnIntent: 0 }),
    scroll: signalify({ x: 0, y: 0 }),
    collapsed: new Set<number>(),
    selection: signalify({
      start: signalify({ line: 0, column: 0 }),
      end: signalify({ line: 0, column: 0 }),
      direction: null as SelectionDirection | null,
    }),
    errors: [] as DocError[],
    widgets: [] as Widget[],
    tokenize,
    get lines(): string[] {
      return buffer.lines.value
    },
    get tokenLines(): Token[][] {
      return this.tokenize(buffer.code.value)
    },
    replace(index: number, length: number, text: string) {
      buffer.replace(index, length, text)
    },
  })
  effect(() => {
    doc.code
    untracked(() => doc.epoch++)
  })
  return doc
}

const debouncedSetItem = debounce(50, (key: string, json: () => unknown) => {
  localStorage.setItem(key, JSON.stringify(json()))
})

function persist<T extends Record<string, unknown>>(
  key: string,
  watch: () => void,
  json: () => T,
  read: (data: Partial<T>) => void,
) {
  untracked(() => batch(() => read(JSON.parse(localStorage.getItem(key) || '{}'))))
  effect(() => {
    watch()
    debouncedSetItem(key, json)
  })
}

export function createPersistedDoc(key: string, tokenize: Tokenizer = defaultTokenizer,
  doc: Doc = createDoc(tokenize))
{
  persist(key, () => {
    doc.code
    doc.caret.line
    doc.caret.column
    doc.scroll.x
    doc.scroll.y
    doc.collapsed
    doc.selection.start.line
    doc.selection.start.column
    doc.selection.end.line
    doc.selection.end.column
    doc.selection.direction
  }, () => ({
    buffer: doc.buffer.pack(),
    caret: doc.caret,
    scroll: doc.scroll,
    collapsed: [...doc.collapsed],
    selection: doc.selection,
  }), data => {
    if (data.buffer) {
      const restoredBuffer = unpack(data.buffer)
      doc.buffer.code.value = restoredBuffer.code.value
      doc.buffer.history.value = restoredBuffer.history.value
      doc.buffer.index.value = restoredBuffer.index.value
    }
    Object.assign(doc.caret, data.caret ?? { line: 0, column: 0, columnIntent: 0 })
    Object.assign(doc.scroll, data.scroll ?? { x: 0, y: 0 })
    doc.collapsed = new Set(data.collapsed ?? [])
    Object.assign(doc.selection,
      data.selection ?? { start: { line: 0, column: 0 }, end: { line: 0, column: 0 }, direction: null })
  })

  return doc
}
