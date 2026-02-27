import { setActiveEditor } from './editor-state.ts'
import { runKeyOverride } from './key-override.ts'

type ClipboardHandlers = {
  handlePaste: (event: ClipboardEvent) => void
  handleInput: (event: Event) => void
  handleKeyDown: (event: KeyboardEvent) => void
  handleKeyUp: (event: KeyboardEvent) => void
  focus: () => void
}

let textarea: HTMLTextAreaElement | null = null
let activeHandlers: ClipboardHandlers | null = null
let activeCanvas: HTMLCanvasElement | null = null
let isRefocusing = false

function getTextarea(): HTMLTextAreaElement {
  if (!textarea) {
    textarea = document.createElement('textarea')
    textarea.style.position = 'fixed'
    textarea.style.left = '0'
    textarea.style.top = '0'
    textarea.style.width = '1px'
    textarea.style.height = '1px'
    textarea.style.opacity = '0.01'
    textarea.style.zIndex = '-1'
    textarea.style.outline = 'none'
    textarea.style.border = 'none'
    textarea.style.padding = '0'
    textarea.style.margin = '0'
    textarea.style.overflow = 'hidden'
    textarea.setAttribute('tabindex', '0')
    document.body.appendChild(textarea)

    const handleBlur = () => {
      if (isRefocusing) return
      if (activeCanvas && document.activeElement === activeCanvas) {
        isRefocusing = true
        setTimeout(() => {
          if (activeCanvas && document.activeElement !== textarea) {
            textarea?.focus()
          }
          isRefocusing = false
        }, 10)
      }
    }

    const handleWindowFocus = () => {
      if (activeCanvas && document.activeElement === activeCanvas) {
        setTimeout(() => {
          if (activeCanvas && document.activeElement !== textarea) {
            textarea?.focus()
          }
        }, 10)
      }
    }

    textarea.addEventListener('blur', handleBlur)
    window.addEventListener('focus', handleWindowFocus)

    const handleDocumentMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return
      if (!activeCanvas) return

      const target = event.target as Node | null
      if (!target) return

      if (target === textarea) return

      let isInsideCanvas = false
      let node: Node | null = target
      while (node) {
        if (node.nodeName === 'CANVAS') {
          isInsideCanvas = true
          break
        }
        node = node.parentNode
      }

      if (!isInsideCanvas) {
        // Only clear editor focus if the click actually moved focus away from the editor.
        // Many UI elements (e.g. div buttons) don't take focus; in that case the hidden textarea
        // remains focused and we want the caret/editor to remain active.
        setTimeout(() => {
          const activeElement = document.activeElement
          if (activeElement !== textarea && activeElement?.tagName !== 'CANVAS') {
            setActiveCanvas(null)
          }
        }, 0)
      }
    }

    document.addEventListener('mousedown', handleDocumentMouseDown, true)

    textarea.addEventListener('paste', event => {
      activeHandlers?.handlePaste(event)
    })

    textarea.addEventListener('input', event => {
      activeHandlers?.handleInput(event)
    })

    textarea.addEventListener('keydown', event => {
      if (runKeyOverride(event)) {
        event.stopPropagation()
        event.stopImmediatePropagation()
        event.preventDefault()
        return
      }
      activeHandlers?.handleKeyDown(event)
    })

    textarea.addEventListener('keyup', event => {
      activeHandlers?.handleKeyUp(event)
    })
  }
  return textarea
}

export function setActiveClipboard(handlers: ClipboardHandlers | null, canvas?: HTMLCanvasElement | null) {
  activeHandlers = handlers
  if (canvas !== undefined) {
    activeCanvas = canvas
  }
  if (handlers && activeCanvas) {
    handlers.focus()
  }
}

export function getActiveCanvas(): HTMLCanvasElement | null {
  return activeCanvas
}

export function setActiveCanvas(canvas: HTMLCanvasElement | null) {
  activeCanvas = canvas
  if (!canvas) setActiveEditor(null)
}

export function getTextareaElement(): HTMLTextAreaElement {
  return getTextarea()
}
