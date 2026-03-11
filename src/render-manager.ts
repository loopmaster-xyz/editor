import { type Context, Position } from './context.ts'
import { drawBlocks } from './draw/blocks.ts'
import { drawCaret } from './draw/caret.ts'
import { drawGutter, drawGutterBackground } from './draw/gutter.ts'
import { drawHeader } from './draw/header.ts'
import { drawLines } from './draw/lines.ts'
import { drawScrollbars } from './draw/scrollbar.ts'
import { drawSelection } from './draw/selection.ts'
import { drawTooltip } from './draw/tooltip.ts'
import { createOverlayCanvas } from './overlay-canvas.ts'

type PerfStats = {
  emaDrawMs: number
  emaInputToPaintMs: number
  lastSampledInputTime: number
}

type ViewportMetrics = {
  top: number
  left: number
  width: number
  height: number
}

const perfStatsByContext = new WeakMap<Context, PerfStats>()

function readViewportMetrics(): ViewportMetrics {
  const viewport = window.visualViewport
  return {
    top: viewport?.offsetTop ?? 0,
    left: viewport?.offsetLeft ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  }
}

function updatePerformanceMode(context: Context, drawMs: number) {
  let stats = perfStatsByContext.get(context)
  if (!stats) {
    stats = { emaDrawMs: drawMs, emaInputToPaintMs: 0, lastSampledInputTime: 0 }
    perfStatsByContext.set(context, stats)
  }

  const ALPHA = 0.15
  const now = Date.now()
  const inputTime = context.caret.lastInputTime.value
  let inputLagSample = 0
  // Only sample once per new input event; otherwise lag grows forever after typing stops.
  if (inputTime > 0 && inputTime !== stats.lastSampledInputTime) {
    stats.lastSampledInputTime = inputTime
    inputLagSample = Math.max(0, now - inputTime)
  }
  stats.emaDrawMs = stats.emaDrawMs * (1 - ALPHA) + drawMs * ALPHA
  stats.emaInputToPaintMs = stats.emaInputToPaintMs * (1 - ALPHA) + inputLagSample * ALPHA

  const lineCount = context.doc.lines.length
  let mode: 'normal' | 'large' | 'stress' = 'normal'
  if (lineCount >= 50_000 || stats.emaDrawMs > 10) mode = 'large'
  if (lineCount >= 100_000 || stats.emaDrawMs > 16 || stats.emaInputToPaintMs > 45) mode = 'stress'

  if (context.settings.performanceMode !== mode) {
    context.settings.performanceMode = mode
  }
}

function drawContext(context: Context, overlayCanvas: ReturnType<typeof createOverlayCanvas>,
  activeTooltip: Map<Context, 'hover' | 'caret' | null>, viewport: ViewportMetrics)
{
  const drawStart = performance.now()
  const { canvas } = context

  context.mouse.update()
  context.scroll.update()

  const rect = canvas.rect
  const inViewport = rect.bottom > viewport.top && rect.top < viewport.top + viewport.height
    && rect.right > viewport.left && rect.left < viewport.left + viewport.width
  if (!inViewport) {
    return
  }

  canvas.clear()
  const headerHeight = context.header.value?.height ?? 0
  canvas.c.save()
  canvas.c.translate(context.gutter.width.value, headerHeight)
  canvas.c.translate(context.settings.paddingLeft, context.settings.paddingTop)
  canvas.c.translate(context.scroll.pos.x, context.scroll.pos.y)
  drawLines(context)
  drawBlocks(context)
  drawSelection(context)
  drawCaret(context)
  canvas.c.restore()
  canvas.c.save()
  canvas.c.translate(context.gutter.width.value, headerHeight)
  canvas.c.translate(context.settings.paddingLeft, context.settings.paddingTop)
  canvas.c.save()
  canvas.c.translate(-context.gutter.width.value, 0)
  drawGutterBackground(context)
  drawGutter(context)
  canvas.c.restore()
  canvas.c.restore()
  try {
    drawScrollbars(context)
  }
  catch (error) {
    console.error('[editor:render] drawScrollbars failed', error)
    context.settings.showMinimap = false
  }
  drawHeader(context)

  const currentlyActive = activeTooltip.get(context) || null
  const hoverToken = context.mouse.hovered.hoverToken
  const hoverTime = context.mouse.lastHoverMoveTime.value
  const caretTime = context.caret.lastInputTime.value
  const caretToken = context.caret.caretToken
  const canDrawHover = !!hoverToken && !!context.onHoverToken
  const canDrawCaret = !!caretToken && context.caret.isTyping.value && !!context.onCaretToken
  const hoverIsPrimary = hoverTime >= caretTime || !context.caret.isTyping.value

  const scroll = context.scroll.pos
  const canvasRect = context.canvas.rect
  const hoverX = hoverToken ? hoverToken.contentX + scroll.x + canvasRect.left : 0
  const hoverY = hoverToken ? hoverToken.contentY + scroll.y + canvasRect.top : 0
  const hoverParamX = hoverToken?.contentParamX != null
    ? hoverToken.contentParamX + scroll.x + canvasRect.left
    : undefined
  const hoverParamY = hoverToken?.contentParamY != null
    ? hoverToken.contentParamY + scroll.y + canvasRect.top
    : undefined
  const hoverCallBlockX = hoverToken ? hoverToken.contentCallBlockX + scroll.x + canvasRect.left : 0
  const hoverCallBlockY = hoverToken ? hoverToken.contentCallBlockY + scroll.y + canvasRect.top : 0
  const caretPos = context.caret.screenPosition

  let hoverPosition: Position | null = null
  let caretPosition: Position | null = null

  if (hoverIsPrimary && canDrawHover) {
    hoverPosition = context.onHoverToken!(overlayCanvas, hoverX, hoverY, hoverToken.token, hoverToken.callBlock,
      hoverToken.parameterIndex, hoverCallBlockX, hoverCallBlockY, context.doc, hoverParamX, hoverParamY, caretPos?.x,
      caretPos?.y)
  }
  else if (!hoverIsPrimary && canDrawCaret) {
    caretPosition = context.onCaretToken!(overlayCanvas, caretToken.x, caretToken.y, caretToken.token,
      caretToken.callBlock, caretToken.parameterIndex, caretToken.callBlockX, caretToken.callBlockY, context.doc,
      undefined, undefined, caretPos?.x, caretPos?.y)
  }

  if (hoverPosition == null && caretPosition == null) {
    if (currentlyActive === 'hover' && canDrawHover) {
      hoverPosition = context.onHoverToken!(overlayCanvas, hoverX, hoverY, hoverToken.token, hoverToken.callBlock,
        hoverToken.parameterIndex, hoverCallBlockX, hoverCallBlockY, context.doc, hoverParamX, hoverParamY, caretPos?.x,
        caretPos?.y)
    }
    else if (currentlyActive === 'caret' && canDrawCaret) {
      caretPosition = context.onCaretToken!(overlayCanvas, caretToken.x, caretToken.y, caretToken.token,
        caretToken.callBlock, caretToken.parameterIndex, caretToken.callBlockX, caretToken.callBlockY, context.doc,
        undefined, undefined, caretPos?.x, caretPos?.y)
    }
  }

  const hoverDrew = hoverPosition != null
  const caretDrew = caretPosition != null
  const primaryPosition = hoverIsPrimary ? hoverPosition : caretPosition
  const positionToPreferAbove = (p: Position) => p === Position.BottomLeft || p === Position.BottomRight
  const preferErrorAbove = hoverDrew && caretDrew
    ? !positionToPreferAbove(primaryPosition!)
    : (primaryPosition != null ? positionToPreferAbove(primaryPosition) : false)

  const error = context.tooltipDismissed
    ? context.mouse.hovered.error
    : (context.mouse.hovered.error ?? context.pinnedError)
  if (context.mouse.hovered.error) context.tooltipDismissed = false
  drawTooltip(context, error, overlayCanvas, preferErrorAbove)

  if (hoverDrew) {
    activeTooltip.set(context, 'hover')
    if (caretToken) {
      context.caret.caretToken = null
    }
  }
  else if (currentlyActive === 'hover') {
    activeTooltip.set(context, null)
  }

  if (caretDrew) {
    activeTooltip.set(context, 'caret')
    if (hoverToken) {
      context.mouse.hovered.hoverToken = null
      context.mouse.clearHoverToken(false)
    }
  }
  else if (currentlyActive === 'caret') {
    activeTooltip.set(context, null)
  }

  updatePerformanceMode(context, performance.now() - drawStart)
}

class RenderManager {
  private contexts = new Set<Context>()
  private overlayCanvas = createOverlayCanvas()
  private activeTooltip = new Map<Context, 'hover' | 'caret' | null>()
  private viewport = readViewportMetrics()
  private viewportDirty = true

  constructor() {
    const markViewportDirty = () => {
      this.viewportDirty = true
    }

    window.addEventListener('resize', markViewportDirty, { passive: true })
    window.addEventListener('scroll', markViewportDirty, { passive: true, capture: true })
    window.visualViewport?.addEventListener('resize', markViewportDirty, { passive: true })
    window.visualViewport?.addEventListener('scroll', markViewportDirty, { passive: true })
  }

  register(context: Context) {
    this.contexts.add(context)
  }

  unregister(context: Context) {
    this.contexts.delete(context)
    this.activeTooltip.delete(context)
  }

  draw() {
    if (this.viewportDirty) {
      this.viewport = readViewportMetrics()
      this.viewportDirty = false
    }
    this.overlayCanvas.clear()

    for (const context of this.contexts) {
      try {
        drawContext(context, this.overlayCanvas, this.activeTooltip, this.viewport)
      }
      catch (error) {
        console.error('[editor:render] drawContext failed', error)
      }
    }
  }
}

export const renderManager = new RenderManager()

export function draw() {
  renderManager.draw()
}
