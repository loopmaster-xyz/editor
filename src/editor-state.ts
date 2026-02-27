import { signal } from '@preact/signals-core'

export const activeEditor = signal<unknown>(null)

export function setActiveEditor(editor: unknown) {
  activeEditor.value = editor
}
