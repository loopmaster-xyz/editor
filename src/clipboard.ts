import type { Doc } from './doc.ts'
import type { Selection } from './selection.ts'
import {
  getTextareaElement,
  setActiveClipboard,
  shouldSuppressCaretVisibleOnRefocus,
} from './textarea-singleton.ts'
import type { Canvas } from './canvas.ts'

export type Clipboard = ReturnType<typeof createClipboard>

const PASTE_BURST_WINDOW_MS = 80
const PASTE_COALESCE_DELAY_MS = 24
const PASTE_FORCE_FLUSH_CHARS = 256 * 1024
const PASTE_CARET_VISIBLE_THROTTLE_MS = 96
const PASTE_STREAM_TRIGGER_CHARS = 192 * 1024
const PASTE_STREAM_CHUNK_CHARS = 64 * 1024
const PASTE_STREAM_STEP_DELAY_MS = 0
const PASTE_POST_LAYOUT_CARET_PASSES = 2

type ChunkedPasteState = {
  segments: string[]
  segmentIndex: number
  offset: number
}

export function createClipboard(
  doc: Doc,
  selection: Selection,
  insertText: (text: string) => void,
  deleteSelection: () => boolean,
  ensureCaretVisible?: () => void,
  onKeyDown?: (event: KeyboardEvent) => void,
  onKeyUp?: (event: KeyboardEvent) => void,
  canvas?: Canvas,
  syncKeyHoldActive?: () => void,
) {
  const textarea = getTextareaElement()
  let pendingPasteText = ''
  let pendingPasteTimer: ReturnType<typeof setTimeout> | null = null
  let lastPasteQueuedAt = 0
  let lastCaretVisibleAt = 0
  let chunkedPaste: ChunkedPasteState | null = null
  let chunkedPasteTimer: ReturnType<typeof setTimeout> | null = null
  let deferredCaretVisibleRaf: number | null = null
  let deferredCaretVisibleTimer: ReturnType<typeof setTimeout> | null = null
  let deferredCaretVisiblePasses = 0
  let pasteActivityDepth = 0
  let chunkedPasteSessionActive = false

  function restoreTextareaFocus() {
    const activeCanvas = document.activeElement?.tagName === 'CANVAS' ? document.activeElement : null
    if (activeCanvas) {
      setTimeout(() => {
        if (document.activeElement === activeCanvas) {
          textarea.focus()
        }
      }, 0)
    }
  }

  function beginChunkedPasteSession() {
    if (chunkedPasteSessionActive) return
    chunkedPasteSessionActive = true
    doc.keyHoldActive = false
  }

  function endChunkedPasteSession() {
    if (!chunkedPasteSessionActive) return
    chunkedPasteSessionActive = false
    syncKeyHoldActive?.()
  }

  function withPasteActivity<T>(fn: () => T): T {
    pasteActivityDepth++
    const prevKeyHoldActive = doc.keyHoldActive
    // While applying pasted text, avoid "key is held" throttles that can delay scroll/layout catch-up.
    doc.keyHoldActive = false
    try {
      return fn()
    }
    finally {
      if (chunkedPasteSessionActive || pasteActivityDepth > 1) {
        doc.keyHoldActive = false
      }
      else if (syncKeyHoldActive) {
        syncKeyHoldActive()
      }
      else {
        doc.keyHoldActive = prevKeyHoldActive
      }
      pasteActivityDepth = Math.max(0, pasteActivityDepth - 1)
    }
  }

  function normalizeChunkedPasteState(state: ChunkedPasteState): void {
    while (state.segmentIndex < state.segments.length) {
      const segment = state.segments[state.segmentIndex] ?? ''
      if (state.offset < segment.length) break
      state.segmentIndex++
      state.offset = 0
    }
    if (state.segmentIndex > 32) {
      state.segments = state.segments.slice(state.segmentIndex)
      state.segmentIndex = 0
    }
  }

  function appendChunkedPasteText(text: string): void {
    if (!text) return
    if (chunkedPaste) {
      chunkedPaste.segments.push(text)
      return
    }
    chunkedPaste = {
      segments: [text],
      segmentIndex: 0,
      offset: 0,
    }
  }

  function flushPendingPaste() {
    if (pendingPasteTimer) {
      clearTimeout(pendingPasteTimer)
      pendingPasteTimer = null
    }
    if (!pendingPasteText) return

    const text = pendingPasteText
    pendingPasteText = ''
    const shouldStream = chunkedPaste !== null
      || text.length >= PASTE_STREAM_TRIGGER_CHARS
    if (shouldStream) {
      beginChunkedPasteSession()
      appendChunkedPasteText(text)
      scheduleChunkedPasteStep(PASTE_STREAM_STEP_DELAY_MS)
      return
    }

    withPasteActivity(() => {
      insertText(text)
      maybeEnsureCaretVisible()
    })
    scheduleDeferredCaretVisible()
    textarea.value = ''
    restoreTextareaFocus()
  }

  function schedulePendingPasteFlush(delay: number) {
    if (pendingPasteTimer) return
    pendingPasteTimer = setTimeout(() => {
      pendingPasteTimer = null
      flushPendingPaste()
    }, delay)
  }

  function queuePastedText(text: string, immediate = false) {
    if (!text) return

    if (immediate) {
      pendingPasteText += text
      flushPendingPaste()
      return
    }

    const now = Date.now()
    const isBurst = pendingPasteText.length > 0
      || (now - lastPasteQueuedAt) <= PASTE_BURST_WINDOW_MS
    lastPasteQueuedAt = now

    if (!isBurst) {
      withPasteActivity(() => {
        insertText(text)
        maybeEnsureCaretVisible(true)
      })
      scheduleDeferredCaretVisible()
      textarea.value = ''
      restoreTextareaFocus()
      return
    }

    pendingPasteText += text
    if (pendingPasteText.length >= PASTE_FORCE_FLUSH_CHARS) {
      flushPendingPaste()
      return
    }

    schedulePendingPasteFlush(PASTE_COALESCE_DELAY_MS)
  }

  function maybeEnsureCaretVisible(force = false) {
    const now = Date.now()
    const shouldBypassKeyHoldThrottle = pasteActivityDepth > 0 || chunkedPasteSessionActive
    if (force || shouldBypassKeyHoldThrottle || !doc.keyHoldActive
      || now - lastCaretVisibleAt >= PASTE_CARET_VISIBLE_THROTTLE_MS)
    {
      ensureCaretVisible?.()
      lastCaretVisibleAt = now
    }
  }

  function clearDeferredCaretVisible() {
    if (deferredCaretVisibleRaf !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(deferredCaretVisibleRaf)
    }
    if (deferredCaretVisibleTimer) {
      clearTimeout(deferredCaretVisibleTimer)
      deferredCaretVisibleTimer = null
    }
    deferredCaretVisibleRaf = null
    deferredCaretVisiblePasses = 0
  }

  function scheduleDeferredCaretVisible() {
    if (!ensureCaretVisible) return
    deferredCaretVisiblePasses = Math.max(deferredCaretVisiblePasses, PASTE_POST_LAYOUT_CARET_PASSES)
    if (deferredCaretVisibleRaf !== null || deferredCaretVisibleTimer !== null) return

    const runPass = () => {
      deferredCaretVisibleRaf = null
      deferredCaretVisibleTimer = null
      if (deferredCaretVisiblePasses <= 0) return
      deferredCaretVisiblePasses--
      maybeEnsureCaretVisible(true)

      if (deferredCaretVisiblePasses <= 0) return
      if (typeof requestAnimationFrame === 'function') {
        deferredCaretVisibleRaf = requestAnimationFrame(runPass)
      }
      else {
        deferredCaretVisibleTimer = setTimeout(runPass, 16)
      }
    }

    if (typeof requestAnimationFrame === 'function') {
      deferredCaretVisibleRaf = requestAnimationFrame(runPass)
    }
    else {
      deferredCaretVisibleTimer = setTimeout(runPass, 16)
    }
  }

  function scheduleChunkedPasteStep(delay: number) {
    if (chunkedPasteTimer) return
    chunkedPasteTimer = setTimeout(() => {
      chunkedPasteTimer = null
      processChunkedPasteStep()
    }, delay)
  }

  function processChunkedPasteStep() {
    const state = chunkedPaste
    if (!state) return

    normalizeChunkedPasteState(state)
    if (state.segmentIndex >= state.segments.length) {
      chunkedPaste = null
      endChunkedPasteSession()
      maybeEnsureCaretVisible(true)
      scheduleDeferredCaretVisible()
      textarea.value = ''
      restoreTextareaFocus()
      if (pendingPasteText.length > 0) flushPendingPaste()
      return
    }

    const text = state.segments[state.segmentIndex] ?? ''
    const start = state.offset
    let end = Math.min(text.length, start + PASTE_STREAM_CHUNK_CHARS)
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1)
      if (newline >= start + Math.max(64, PASTE_STREAM_CHUNK_CHARS >> 2)) {
        end = newline + 1
      }
    }
    if (end <= start) {
      end = Math.min(text.length, start + PASTE_STREAM_CHUNK_CHARS)
    }

    const chunk = text.slice(start, end)
    if (chunk.length > 0) {
      withPasteActivity(() => {
        insertText(chunk)
        maybeEnsureCaretVisible()
      })
    }
    state.offset = end
    if (state.offset >= text.length) {
      state.segmentIndex++
      state.offset = 0
    }
    normalizeChunkedPasteState(state)

    if (state.segmentIndex < state.segments.length) {
      scheduleChunkedPasteStep(PASTE_STREAM_STEP_DELAY_MS)
      return
    }

    chunkedPaste = null
    endChunkedPasteSession()
    maybeEnsureCaretVisible(true)
    scheduleDeferredCaretVisible()
    textarea.value = ''
    restoreTextareaFocus()
    if (pendingPasteText.length > 0) flushPendingPaste()
  }

  function flushChunkedPasteImmediately() {
    if (chunkedPasteTimer) {
      clearTimeout(chunkedPasteTimer)
      chunkedPasteTimer = null
    }
    const state = chunkedPaste
    if (!state) return
    normalizeChunkedPasteState(state)
    const remainingParts: string[] = []
    for (let i = state.segmentIndex; i < state.segments.length; i++) {
      const segment = state.segments[i] ?? ''
      if (!segment) continue
      if (i === state.segmentIndex) {
        if (state.offset < segment.length) remainingParts.push(segment.slice(state.offset))
      }
      else {
        remainingParts.push(segment)
      }
    }
    const remaining = remainingParts.length > 0 ? remainingParts.join('') : ''
    chunkedPaste = null
    if (remaining.length > 0) {
      withPasteActivity(() => {
        insertText(remaining)
        maybeEnsureCaretVisible(true)
      })
      scheduleDeferredCaretVisible()
    }
    endChunkedPasteSession()
    textarea.value = ''
    restoreTextareaFocus()
  }

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
      restoreTextareaFocus()
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
      restoreTextareaFocus()
    }
  }

  function focus() {
    textarea.focus()
  }

  function handlePaste(event: ClipboardEvent) {
    event.preventDefault()
    event.stopPropagation()

    const text = event.clipboardData?.getData('text/plain') || ''
    queuePastedText(text, true)
    textarea.value = ''
  }

  function handleInput(event: Event) {
    event.preventDefault()
    const text = textarea.value
    queuePastedText(text)
    textarea.value = ''
  }

  function handleKeyDown(event: KeyboardEvent) {
    onKeyDown?.(event)
  }

  function handleKeyUp(event: KeyboardEvent) {
    onKeyUp?.(event)
    if (pendingPasteText.length > 0) {
      flushPendingPaste()
    }
    if (!shouldSuppressCaretVisibleOnRefocus()) {
      maybeEnsureCaretVisible(true)
    }
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
    flushPendingPaste()
    flushChunkedPasteImmediately()
    endChunkedPasteSession()
    clearDeferredCaretVisible()
    setActiveClipboard(null, undefined)
  }

  const dispose = () => {
    flushPendingPaste()
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
