import type { Doc } from './doc.ts'
import type { Selection } from './selection.ts'
import { getTextareaElement, setActiveClipboard } from './textarea-singleton.ts'
import type { Canvas } from './canvas.ts'

export type Clipboard = ReturnType<typeof createClipboard>

export function createClipboard(doc: Doc, selection: Selection, insertText: (text: string) => void, deleteSelection: () => boolean, ensureCaretVisible?: () => void, onKeyDown?: (event: KeyboardEvent) => void, onKeyUp?: (event: KeyboardEvent) => void, canvas?: Canvas) {
  const textarea = getTextareaElement()

  function getSelectedText(): string {
    const ordered = selection.getOrdered.value
    if (!ordered) return ''

    const { start, end } = ordered
    const lines = doc.lines

    if (start.line === end.line) {
      const line = lines[start.line] || ''
      return line.slice(start.column, end.column)
    }

    let text = ''
    for (let line = start.line; line <= end.line; line++) {
      const lineText = lines[line] || ''
      if (line === start.line) {
        text += lineText.slice(start.column)
      }
      else if (line === end.line) {
        text += lineText.slice(0, end.column)
      }
      else {
        text += lineText
      }
      if (line < end.line) {
        text += '\n'
      }
    }

    return text
  }

  function copy() {
    const text = getSelectedText()
    if (!text) return

    textarea.value = text
    textarea.select()
    
    try {
      const success = document.execCommand('copy')
      if (!success) {
        console.error('Failed to copy: execCommand returned false')
      }
    }
    catch (err) {
      console.error('Failed to copy:', err)
    }
    finally {
      textarea.value = ''
      const activeCanvas = document.activeElement?.tagName === 'CANVAS' ? document.activeElement : null
      if (activeCanvas) {
        setTimeout(() => {
          if (document.activeElement === activeCanvas) {
            textarea.focus()
          }
        }, 0)
      }
    }
  }

  function cut() {
    const text = getSelectedText()
    if (!text) return

    textarea.value = text
    textarea.select()
    
    try {
      const success = document.execCommand('copy')
      if (!success) {
        console.error('Failed to cut: execCommand returned false')
        textarea.value = ''
        return
      }
      deleteSelection()
    }
    catch (err) {
      console.error('Failed to cut:', err)
    }
    finally {
      textarea.value = ''
      const activeCanvas = document.activeElement?.tagName === 'CANVAS' ? document.activeElement : null
      if (activeCanvas) {
        setTimeout(() => {
          if (document.activeElement === activeCanvas) {
            textarea.focus()
          }
        }, 0)
      }
    }
  }

  function focus() {
    textarea.focus()
  }

  function handlePaste(event: ClipboardEvent) {
    event.preventDefault()
    event.stopPropagation()
    
    const text = event.clipboardData?.getData('text/plain') || ''
    if (text) {
      insertText(text)
      ensureCaretVisible?.()
    }
    textarea.value = ''
    
    const activeCanvas = document.activeElement?.tagName === 'CANVAS' ? document.activeElement : null
    if (activeCanvas) {
      setTimeout(() => {
        if (document.activeElement === activeCanvas) {
          textarea.focus()
        }
      }, 0)
    }
  }

  function handleInput(event: Event) {
    event.preventDefault()
    const text = textarea.value
    if (text) {
      insertText(text)
      ensureCaretVisible?.()
    }
    textarea.value = ''
  }

  function handleKeyDown(event: KeyboardEvent) {
    onKeyDown?.(event)
  }

  function handleKeyUp(event: KeyboardEvent) {
    onKeyUp?.(event)
  }

  const handlers = {
    handlePaste,
    handleInput,
    handleKeyDown,
    handleKeyUp,
    focus,
  }

  const activate = () => {
    setActiveClipboard(handlers, canvas?.el)
  }

  const deactivate = () => {
    setActiveClipboard(null, undefined)
  }

  const dispose = () => {
    deactivate()
  }

  return {
    copy,
    cut,
    focus,
    handlePaste,
    activate,
    deactivate,
    el: textarea,
    dispose,
  }
}
