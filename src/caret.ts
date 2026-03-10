import { signal } from '@preact/signals-core'
import type { Canvas } from './canvas.ts'
import type { Settings } from './settings.ts'
import type { Token } from './token.ts'

export type Caret = ReturnType<typeof createCaret>

export function createCaret(settings: Settings) {
  const line = signal(0)
  const column = signal(0)
  const columnIntent = signal(0)
  const isTyping = signal(false)
  const isWindowFocused = signal(true)
  const lastInputTime = signal(0)

  let startTime = Date.now()
  let suppressAutoScroll = false
  let screenPosition: { x: number; y: number } | null = null
  let caretToken: {
    canvas: Canvas
    x: number
    y: number
    token: Token
    callBlock: Token[]
    parameterIndex: number
    callBlockX: number
    callBlockY: number
  } | null = null

  const resetBlink = () => {
    startTime = Date.now()
  }

  const updateBlink = () => {
    if (!isWindowFocused.value) {
      return 0
    }

    const now = Date.now()
    const elapsed = now - startTime
    const delay = 500 * settings.caretPhaseCoeff
    if (elapsed < delay) {
      return 1
    }
    const pulseElapsed = elapsed - delay
    const period = 1000 * settings.caretPhaseCoeff
    const opacity = ((Math.sin(Math.PI + (pulseElapsed / period) * Math.PI * 2) + 1) / 2) ** 0.707
    return opacity
  }

  const setPosition = (newLine: number, newColumn: number, codeLines: string[]) => {
    line.value = Math.max(0, Math.min(newLine, codeLines.length - 1))
    const lineLength = codeLines[line.value]?.length || 0
    column.value = Math.max(0, Math.min(newColumn, lineLength))
    resetBlink()
  }

  const setWindowFocus = (focused: boolean) => {
    if (isWindowFocused.value === focused) return
    isWindowFocused.value = focused
    if (focused) {
      resetBlink()
    }
  }

  return {
    line,
    column,
    columnIntent,
    isTyping,
    isWindowFocused,
    lastInputTime,
    resetBlink,
    updateBlink,
    setPosition,
    setWindowFocus,
    get suppressAutoScroll() {
      return suppressAutoScroll
    },
    set suppressAutoScroll(value) {
      suppressAutoScroll = value
    },
    get screenPosition() {
      return screenPosition
    },
    set screenPosition(value) {
      screenPosition = value
    },
    get caretToken() {
      return caretToken
    },
    set caretToken(value) {
      caretToken = value
    },
  }
}
