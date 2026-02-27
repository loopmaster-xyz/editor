import { computed, signal } from '@preact/signals-core'

export type Selection = ReturnType<typeof createSelection>

export type SelectionPosition = {
  line: number
  column: number
}

export type SelectionDirection = 'forward' | 'backward'

type SelectionOffscreenCanvas = {
  canvas: OffscreenCanvas
  c: OffscreenCanvasRenderingContext2D
}

export function createSelection() {
  const start = signal<SelectionPosition>({ line: -1, column: -1 })
  const end = signal<SelectionPosition>({ line: -1, column: -1 })
  const direction = signal<SelectionDirection | null>(null)
  const isSelecting = signal(false)

  let offscreen: SelectionOffscreenCanvas | null = null

  const clear = () => {
    start.value = { line: -1, column: -1 }
    end.value = { line: -1, column: -1 }
    direction.value = null
  }

  const setStart = (line: number, column: number) => {
    start.value = { line, column }
    end.value = { line, column }
    direction.value = null
  }

  const setEnd = (line: number, column: number) => {
    if (start.value.line === -1 || start.value.column === -1) {
      start.value = { line, column }
    }
    end.value = { line, column }

    if (start.value.line !== -1 && start.value.column !== -1) {
      if (line > start.value.line || (line === start.value.line && column > start.value.column)) {
        direction.value = 'forward'
      }
      else if (line < start.value.line || (line === start.value.line && column < start.value.column)) {
        direction.value = 'backward'
      }
      else {
        direction.value = null
      }
    }
  }

  const hasSelection = computed(() => {
    if (start.value.line === -1 || start.value.column === -1 || end.value.line === -1 || end.value.column === -1) {
      return false
    }
    return start.value.line !== end.value.line
      || start.value.line === end.value.line && start.value.column !== end.value.column
  })

  const getOrdered = computed(() => {
    if (start.value.line === -1 || start.value.column === -1 || end.value.line === -1 || end.value.column === -1) {
      return null
    }
    if (!hasSelection.value) return null

    if (start.value.line < end.value.line
      || (start.value.line === end.value.line && start.value.column < end.value.column))
    {
      return { start: start.value, end: end.value }
    }
    return { start: end.value, end: start.value }
  })

  const getOffscreenCanvas = (width: number, height: number, dpr: number): SelectionOffscreenCanvas => {
    const validWidth = Math.max(1, Math.floor(width)) || 1
    const validHeight = Math.max(1, Math.floor(height)) || 1
    const validDpr = Math.max(1, dpr) || 1
    const scaledWidth = Math.floor(validWidth * validDpr)
    const scaledHeight = Math.floor(validHeight * validDpr)

    if (!offscreen) {
      const canvas = new OffscreenCanvas(scaledWidth, scaledHeight)
      const c = canvas.getContext('2d')
      if (!c) {
        throw new Error('Could not get 2D context from OffscreenCanvas')
      }
      c.scale(validDpr, validDpr)
      offscreen = { canvas, c }
      return offscreen
    }

    const needsResize = offscreen.canvas.width !== scaledWidth || offscreen.canvas.height !== scaledHeight
    if (needsResize) {
      offscreen.canvas.width = scaledWidth
      offscreen.canvas.height = scaledHeight
      offscreen.c.setTransform(1, 0, 0, 1, 0, 0)
      offscreen.c.scale(validDpr, validDpr)
    }

    return offscreen
  }

  return {
    start,
    end,
    direction,
    isSelecting,
    clear,
    setStart,
    setEnd,
    hasSelection,
    getOrdered,
    getOffscreenCanvas,
  }
}
