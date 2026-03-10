import type { Signal } from '@preact/signals-core'
import type { Canvas } from '../canvas.ts'
import type { Context } from '../context.ts'
import type { Gutter } from '../gutter.ts'
import type { Header } from '../header.ts'
import type { Lines } from '../lines.ts'
import workerUrl from '../minimap-worker.ts?worker&url'
import type {
  MinimapErrorMessage,
  MinimapRenderChunkRequestMessage,
  MinimapRenderChunkResultMessage,
  MinimapThemePayload,
  MinimapWorkerResponseMessage,
} from '../minimap-protocol.ts'
import type { Scroll } from '../scroll.ts'
import type { Settings } from '../settings.ts'
import type { Token, TokenType } from '../token.ts'

export const VERTICAL_SCROLLBAR_SIZE = 12
export const MINIMAP_SCROLLBAR_SIZE = 64
export const HORIZONTAL_SCROLLBAR_SIZE = 3

const SCROLLBAR_MIN_THUMB = 20
const SCROLLBAR_TRACK_COLOR = 'rgba(255, 255, 255, 0.05)'
const SCROLLBAR_THUMB_COLOR = 'rgba(255, 255, 255, 0.1)'
const SCROLLBAR_THUMB_HOVER_COLOR = 'rgba(255, 255, 255, 0.2)'

const MINIMAP_VIEWPORT_COLOR = 'rgba(255, 255, 255, 0.08)'
const MINIMAP_VIEWPORT_HOVER_COLOR = 'rgba(255, 255, 255, 0.14)'
const MINIMAP_INNER_PADDING = 4
const MINIMAP_BASE_ROW_HEIGHT = 2
const MINIMAP_MIN_ROW_HEIGHT = 1
const MINIMAP_DENSITY_RANGE = 2
const MINIMAP_MAX_VIRTUAL_ROWS = 1800
const MINIMAP_MAX_COMPRESSED_LINES_PER_ROW = 3
const MINIMAP_BITMAP_ROW_SCALE = 1
const MINIMAP_BURST_WINDOW_MS = 120
const MINIMAP_WORKER_THROTTLE_BURST_MS = 120
const MINIMAP_WORKER_THROTTLE_SETTLE_MS = 36
const MINIMAP_BACKGROUND_ALPHA = 0.62
const MINIMAP_BACKGROUND_HOVER_ALPHA = 0.52
const MINIMAP_LEFT_SHADOW_WIDTH = 7
const MINIMAP_LEFT_SHADOW_ALPHA = 0.25

const MINIMAP_TOKEN_TYPES: TokenType[] = [
  'keyword',
  'function',
  'identifier',
  'string',
  'number',
  'boolean',
  'null',
  'operator',
  'punctuation',
  'comment',
  'text',
  'special',
]

type Rgb = {
  r: number
  g: number
  b: number
}

type ScrollbarLayout = {
  width: number
  height: number
  totalWidth: number
  totalHeight: number
  scrollWidth: number
  scrollHeight: number
  scrollX: number
  scrollY: number
  headerHeight: number
  availableHeightForVertical: number
  availableWidth: number
  availableWidthForHorizontal: number
  verticalScrollbarSize: number
  needsVertical: boolean
  needsHorizontal: boolean
  availableHeight: number
}

type MinimapThemeSnapshot = {
  themeKey: string
  payload: MinimapThemePayload
}

type MinimapGeometryStats = {
  lineSpan: number
  virtualRowCount: number
  columnCount: number
  rowScale: number
  totalSourceRows: number
  mode: 'compressed' | 'windowed'
}

type MinimapCompressionState = {
  key: string
  lineCount: number
  lineSpan: number
  columnCount: number
  rowScale: number
  totalSourceRows: number
  chunkRowCount: number
  chunkCount: number
}

type MinimapSurface = {
  canvas: OffscreenCanvas | HTMLCanvasElement
  c: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  width: number
  height: number
}

type MinimapSnapshot = {
  sourceY: number
  sourceHeight: number
}

type MinimapRenderState = {
  contextId: number
  compression: MinimapCompressionState | null
  contentKey: string | null
  stitchSurface: MinimapSurface | null
  latchedViewportSurface: MinimapSurface | null
  latchedViewportCompressionKey: string | null
  readyChunks: Set<number>
  chunkContentKey: Map<number, string>
  pendingSnapshot: MinimapSnapshot | null
  inFlightRequestId: number | null
  inFlightChunkIndex: number | null
  inFlightCompressionKey: string | null
  inFlightContentKey: string | null
  throttleMs: number
  lastDispatchAt: number
}

type MinimapWorkerRequestMeta = {
  state: MinimapRenderState
  compressionKey: string
  contentKey: string
  chunkIndex: number
}

let minimapWorker: Worker | null = null
let minimapWorkerDisabled = false
let minimapContextId = 0
let minimapRequestId = 0
const minimapRenderStateByContext = new WeakMap<Context, MinimapRenderState>()
const minimapWorkerRequests = new Map<number, MinimapWorkerRequestMeta>()
const parsedColorCache = new Map<string, Rgb>()

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value | 0))
}

function parseHexColor(color: string): Rgb | null {
  const hex = color.slice(1)
  if (hex.length === 3 || hex.length === 4) {
    const r = parseInt(hex[0] + hex[0], 16)
    const g = parseInt(hex[1] + hex[1], 16)
    const b = parseInt(hex[2] + hex[2], 16)
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
    return { r, g, b }
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
    return { r, g, b }
  }
  return null
}

function parseRgbColor(color: string): Rgb | null {
  const match = color.match(/^rgba?\((.+)\)$/i)
  if (!match) return null
  const parts = match[1].split(',').map(part => part.trim())
  if (parts.length < 3) return null

  const parseChannel = (value: string): number | null => {
    if (value.endsWith('%')) {
      const percent = Number.parseFloat(value.slice(0, -1))
      if (!Number.isFinite(percent)) return null
      return clampByte(Math.round(percent * 2.55))
    }
    const numeric = Number.parseFloat(value)
    if (!Number.isFinite(numeric)) return null
    return clampByte(Math.round(numeric))
  }

  const r = parseChannel(parts[0])
  const g = parseChannel(parts[1])
  const b = parseChannel(parts[2])
  if (r == null || g == null || b == null) return null
  return { r, g, b }
}

function parseColorToRgb(color: string | undefined, fallback: Rgb): Rgb {
  if (!color) return fallback
  const cached = parsedColorCache.get(color)
  if (cached) return cached

  const normalized = color.trim().toLowerCase()
  const parsed = normalized.startsWith('#')
    ? parseHexColor(normalized)
    : (normalized.startsWith('rgb') ? parseRgbColor(normalized) : null)

  const value = parsed ?? fallback
  parsedColorCache.set(color, value)
  return value
}

function getMinimapBackgroundCss(context: Context, isHovered: boolean): string {
  const background = parseColorToRgb(context.settings.colors.black, { r: 0, g: 0, b: 0 })
  const alpha = isHovered ? MINIMAP_BACKGROUND_HOVER_ALPHA : MINIMAP_BACKGROUND_ALPHA
  return `rgba(${background.r}, ${background.g}, ${background.b}, ${alpha})`
}

function drawMinimapLeftShadow(c: CanvasRenderingContext2D, x: number, y: number, height: number) {
  const gradient = c.createLinearGradient(x, 0, x - MINIMAP_LEFT_SHADOW_WIDTH, 0)
  gradient.addColorStop(0, `rgba(0, 0, 0, ${MINIMAP_LEFT_SHADOW_ALPHA})`)
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  c.fillStyle = gradient
  c.fillRect(x - MINIMAP_LEFT_SHADOW_WIDTH, y, MINIMAP_LEFT_SHADOW_WIDTH, height)
}

function getMinimapThemeSnapshot(context: Context): MinimapThemeSnapshot {
  const theme = context.settings.theme
  const byTokenType = {} as Record<TokenType, string | undefined>
  const themeParts: string[] = new Array(MINIMAP_TOKEN_TYPES.length + 1)

  for (let i = 0; i < MINIMAP_TOKEN_TYPES.length; i++) {
    const tokenType = MINIMAP_TOKEN_TYPES[i]
    const color = theme[tokenType]?.color ?? theme.text?.color
    byTokenType[tokenType] = color
    themeParts[i] = color ?? ''
  }
  themeParts[MINIMAP_TOKEN_TYPES.length] = theme.text?.color ?? ''

  return {
    themeKey: themeParts.join('|'),
    payload: {
      textColor: theme.text?.color,
      byTokenType,
    },
  }
}

function createSurface(width: number, height: number): MinimapSurface | null {
  const safeWidth = Math.max(1, width | 0)
  const safeHeight = Math.max(1, height | 0)

  let canvas: OffscreenCanvas | HTMLCanvasElement
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(safeWidth, safeHeight)
  }
  else {
    if (typeof document === 'undefined') return null
    const element = document.createElement('canvas')
    element.width = safeWidth
    element.height = safeHeight
    canvas = element
  }

  const c = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (!c) return null
  return { canvas, c, width: safeWidth, height: safeHeight }
}

function ensureSurface(surface: MinimapSurface | null, width: number, height: number): MinimapSurface | null {
  const safeWidth = Math.max(1, width | 0)
  const safeHeight = Math.max(1, height | 0)
  if (surface && surface.width === safeWidth && surface.height === safeHeight) {
    return surface
  }
  return createSurface(safeWidth, safeHeight)
}

function closeBitmap(bitmap: ImageBitmap | null | undefined) {
  if (!bitmap) return
  if (typeof bitmap.close === 'function') bitmap.close()
}

function getMinimapWorkerThrottleDelay(burstMode: boolean): number {
  return burstMode ? MINIMAP_WORKER_THROTTLE_BURST_MS : MINIMAP_WORKER_THROTTLE_SETTLE_MS
}

function isMinimapBurstMode(context: Context): boolean {
  const inputAgeMs = context.caret.lastInputTime.value > 0
    ? Date.now() - context.caret.lastInputTime.value
    : Number.POSITIVE_INFINITY
  return context.doc.keyHoldActive || inputAgeMs <= MINIMAP_BURST_WINDOW_MS
}

function makeMinimapContentKey(revision: number, tokenVersion: number, themeKey: string): string {
  return `${revision}:${tokenVersion}:${themeKey}`
}

function prepareTokenLinesForWorker(lines: string[], tokenLines: Token[][]): Token[][] {
  const prepared = new Array<Token[]>(lines.length)
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineTokens = tokenLines[lineIndex]
    if (!lineTokens || lineTokens.length === 0) {
      prepared[lineIndex] = []
      continue
    }

    const sanitized: Token[] = []
    for (let tokenIndex = 0; tokenIndex < lineTokens.length; tokenIndex++) {
      const token = lineTokens[tokenIndex]
      const text = token?.text ?? ''
      if (text.length === 0) continue
      sanitized.push({
        type: token?.type ?? 'text',
        text,
      })
    }
    prepared[lineIndex] = sanitized
  }
  return prepared
}

function getMinimapRenderState(context: Context): MinimapRenderState {
  const existing = minimapRenderStateByContext.get(context)
  if (existing) return existing

  const state: MinimapRenderState = {
    contextId: ++minimapContextId,
    compression: null,
    contentKey: null,
    stitchSurface: null,
    latchedViewportSurface: null,
    latchedViewportCompressionKey: null,
    readyChunks: new Set<number>(),
    chunkContentKey: new Map<number, string>(),
    pendingSnapshot: null,
    inFlightRequestId: null,
    inFlightChunkIndex: null,
    inFlightCompressionKey: null,
    inFlightContentKey: null,
    throttleMs: MINIMAP_WORKER_THROTTLE_SETTLE_MS,
    lastDispatchAt: 0,
  }

  minimapRenderStateByContext.set(context, state)
  return state
}

function clearMinimapWorkerRequests() {
  for (const [, request] of minimapWorkerRequests) {
    const state = request.state
    if (state.inFlightRequestId != null) {
      state.inFlightRequestId = null
      state.inFlightChunkIndex = null
      state.inFlightCompressionKey = null
      state.inFlightContentKey = null
    }
  }
  minimapWorkerRequests.clear()
}

function dropMinimapWorker() {
  clearMinimapWorkerRequests()
  minimapWorkerDisabled = true
  if (minimapWorker) {
    minimapWorker.terminate()
    minimapWorker = null
  }
}

function ensureMinimapWorker(): Worker | null {
  if (minimapWorkerDisabled) return null
  if (typeof window === 'undefined' || typeof Worker === 'undefined') return null
  if (minimapWorker) return minimapWorker

  let worker: Worker
  try {
    worker = new Worker(workerUrl, { type: 'module' })
  }
  catch (error) {
    console.error('[editor:minimap] worker creation failed', { url: workerUrl, error })
    minimapWorkerDisabled = true
    return null
  }

  worker.onerror = (event: ErrorEvent) => {
    console.error('[editor:minimap] worker error', event)
    dropMinimapWorker()
  }
  worker.onmessageerror = () => {
    console.error('[editor:minimap] worker message error')
    dropMinimapWorker()
  }

  worker.onmessage = (event: MessageEvent<MinimapWorkerResponseMessage>) => {
    const message = event.data
    if (!message) return

    if (message.type === 'minimapError') {
      const error = message as MinimapErrorMessage
      const request = minimapWorkerRequests.get(error.requestId)
      if (request) {
        minimapWorkerRequests.delete(error.requestId)
        const state = request.state
        if (state.inFlightRequestId === error.requestId) {
          state.inFlightRequestId = null
          state.inFlightChunkIndex = null
          state.inFlightCompressionKey = null
          state.inFlightContentKey = null
        }
      }
      console.error('[editor:minimap] render error', error.error)
      return
    }

    if (message.type !== 'minimapRenderChunkResult') return
    const result = message as MinimapRenderChunkResultMessage
    const request = minimapWorkerRequests.get(result.requestId)
    if (!request) {
      closeBitmap(result.bitmap)
      return
    }

    minimapWorkerRequests.delete(result.requestId)
    const state = request.state
    if (state.inFlightRequestId === result.requestId) {
      state.inFlightRequestId = null
      state.inFlightChunkIndex = null
      state.inFlightCompressionKey = null
      state.inFlightContentKey = null
    }

    const compression = state.compression
    if (!compression
      || request.compressionKey !== compression.key
      || result.compressionKey !== compression.key
      || request.chunkIndex !== result.chunkIndex
      || request.contentKey !== state.contentKey)
    {
      closeBitmap(result.bitmap)
      return
    }

    const stitchSurface = ensureSurface(state.stitchSurface, compression.columnCount, compression.totalSourceRows)
    if (!stitchSurface) {
      closeBitmap(result.bitmap)
      return
    }
    state.stitchSurface = stitchSurface

    const chunkHeight = Math.max(1, result.rowCount * result.rowScale)
    stitchSurface.c.clearRect(0, result.chunkStartRow, compression.columnCount, chunkHeight)
    if (result.hasInk) {
      stitchSurface.c.drawImage(result.bitmap, 0, result.chunkStartRow)
    }

    state.readyChunks.add(result.chunkIndex)
    state.chunkContentKey.set(result.chunkIndex, result.contentKey)
    closeBitmap(result.bitmap)
  }

  minimapWorker = worker
  return worker
}

function resetCompressionState(state: MinimapRenderState, compression: MinimapCompressionState) {
  state.compression = compression
  state.readyChunks.clear()
  state.chunkContentKey.clear()
  state.pendingSnapshot = null

  state.stitchSurface = ensureSurface(state.stitchSurface, compression.columnCount, compression.totalSourceRows)
  if (state.stitchSurface) {
    state.stitchSurface.c.clearRect(0, 0, compression.columnCount, compression.totalSourceRows)
  }
}

function getVisibleChunkRange(compression: MinimapCompressionState, sourceY: number, sourceHeight: number) {
  const sourceStart = Math.max(0, Math.floor(sourceY))
  const sourceEnd = Math.max(sourceStart + 1, Math.ceil(sourceY + sourceHeight))
  const startChunk = Math.max(0, Math.floor(sourceStart / compression.chunkRowCount))
  const endChunk = Math.min(compression.chunkCount - 1, Math.floor((sourceEnd - 1) / compression.chunkRowCount))
  return { startChunk, endChunk }
}

function pickNextChunkIndexForSnapshot(
  state: MinimapRenderState,
  compression: MinimapCompressionState,
  sourceY: number,
  sourceHeight: number,
  contentKey: string,
): number {
  const visible = getVisibleChunkRange(compression, sourceY, sourceHeight)

  // 1) Fill visible holes for current content first (fixes last-chunk gaps near document end).
  for (let chunkIndex = visible.startChunk; chunkIndex <= visible.endChunk; chunkIndex++) {
    if (!isChunkReadyForContent(state, chunkIndex, contentKey, true)) return chunkIndex
  }

  // 2) Then upgrade stale chunks around the viewport center.
  const anchor = Math.max(
    0,
    Math.min(compression.chunkCount - 1, Math.floor(sourceY / compression.chunkRowCount)),
  )
  for (let radius = 0; radius < compression.chunkCount; radius++) {
    const right = anchor + radius
    if (right < compression.chunkCount && !isChunkReadyForContent(state, right, contentKey, true)) {
      return right
    }
    const left = anchor - radius
    if (left >= 0 && !isChunkReadyForContent(state, left, contentKey, true)) {
      return left
    }
  }

  return -1
}

function isChunkReadyForContent(state: MinimapRenderState, chunkIndex: number, contentKey: string, strict: boolean): boolean {
  if (!state.readyChunks.has(chunkIndex)) return false
  if (!strict) return true
  return state.chunkContentKey.get(chunkIndex) === contentKey
}

function isViewportCovered(
  state: MinimapRenderState,
  compression: MinimapCompressionState,
  sourceY: number,
  sourceHeight: number,
  contentKey: string,
  strict: boolean,
): boolean {
  const range = getVisibleChunkRange(compression, sourceY, sourceHeight)
  for (let chunkIndex = range.startChunk; chunkIndex <= range.endChunk; chunkIndex++) {
    if (!isChunkReadyForContent(state, chunkIndex, contentKey, strict)) {
      return false
    }
  }
  return true
}

function drawMinimapFromCache(
  c: CanvasRenderingContext2D,
  state: MinimapRenderState,
  sourceY: number,
  sourceHeight: number,
  drawX: number,
  drawY: number,
  drawWidth: number,
  drawHeight: number,
): boolean {
  const compression = state.compression
  const contentKey = state.contentKey
  if (!compression || !contentKey) return false

  const sourceStart = Math.max(0, Math.floor(sourceY))
  const sourceHeightInt = Math.max(1, Math.ceil(sourceHeight))

  const canDrawCurrent = isViewportCovered(state, compression, sourceStart, sourceHeightInt, contentKey, true)

  const previousSmoothing = c.imageSmoothingEnabled
  c.imageSmoothingEnabled = false

  if (canDrawCurrent && state.stitchSurface) {
    c.drawImage(
      state.stitchSurface.canvas,
      0,
      sourceStart,
      compression.columnCount,
      sourceHeightInt,
      drawX,
      drawY,
      drawWidth,
      drawHeight,
    )

    const latchedViewportSurface = ensureSurface(
      state.latchedViewportSurface,
      Math.max(1, Math.round(drawWidth)),
      Math.max(1, Math.round(drawHeight)),
    )
    if (latchedViewportSurface) {
      latchedViewportSurface.c.clearRect(0, 0, latchedViewportSurface.width, latchedViewportSurface.height)
      latchedViewportSurface.c.drawImage(
        state.stitchSurface.canvas,
        0,
        sourceStart,
        compression.columnCount,
        sourceHeightInt,
        0,
        0,
        latchedViewportSurface.width,
        latchedViewportSurface.height,
      )
      state.latchedViewportSurface = latchedViewportSurface
      state.latchedViewportCompressionKey = compression.key
    }

    c.imageSmoothingEnabled = previousSmoothing
    return true
  }

  if (state.latchedViewportSurface) {
    c.drawImage(
      state.latchedViewportSurface.canvas,
      0,
      0,
      state.latchedViewportSurface.width,
      state.latchedViewportSurface.height,
      drawX,
      drawY,
      drawWidth,
      drawHeight,
    )
    c.imageSmoothingEnabled = previousSmoothing
    return true
  }

  c.imageSmoothingEnabled = previousSmoothing
  return false
}

function tryDispatchMinimapRequest(
  context: Context,
  state: MinimapRenderState,
  compression: MinimapCompressionState,
  theme: MinimapThemeSnapshot,
) {
  if (state.inFlightRequestId != null) return
  if (!state.pendingSnapshot) return

  const worker = ensureMinimapWorker()
  if (!worker) return

  const contentKey = state.contentKey
  if (!contentKey) return

  const snapshot = state.pendingSnapshot
  const targetChunkIndex = pickNextChunkIndexForSnapshot(
    state,
    compression,
    snapshot.sourceY,
    snapshot.sourceHeight,
    contentKey,
  )
  if (targetChunkIndex < 0) {
    state.pendingSnapshot = null
    return
  }

  const now = Date.now()
  if (now - state.lastDispatchAt < state.throttleMs) return

  const chunkStartRow = targetChunkIndex * compression.chunkRowCount
  const rowCount = Math.max(1, Math.min(compression.chunkRowCount, compression.totalSourceRows - chunkStartRow))
  const chunkEndRow = chunkStartRow + rowCount
  const lineStart = chunkStartRow * compression.lineSpan
  const lineEnd = Math.min(compression.lineCount, chunkEndRow * compression.lineSpan)

  const linesSlice = context.doc.lines.slice(lineStart, lineEnd)
  const tokenLinesSlice = context.doc.tokenLines.slice(lineStart, lineEnd)
  const tokenLines = prepareTokenLinesForWorker(linesSlice, tokenLinesSlice)

  const requestId = ++minimapRequestId
  const message: MinimapRenderChunkRequestMessage = {
    type: 'minimapRenderChunk',
    requestId,
    contextId: state.contextId,
    revision: context.doc.revision,
    tokenVersion: context.doc.tokenVersion,
    compressionKey: compression.key,
    contentKey,
    chunkIndex: targetChunkIndex,
    chunkStartRow,
    rowCount,
    lineSpan: compression.lineSpan,
    columnCount: compression.columnCount,
    rowScale: compression.rowScale,
    lines: linesSlice,
    tokenLines,
    theme: theme.payload,
  }

  state.pendingSnapshot = null
  state.inFlightRequestId = requestId
  state.inFlightChunkIndex = targetChunkIndex
  state.inFlightCompressionKey = compression.key
  state.inFlightContentKey = contentKey
  state.lastDispatchAt = now

  minimapWorkerRequests.set(requestId, {
    state,
    compressionKey: compression.key,
    contentKey,
    chunkIndex: targetChunkIndex,
  })

  try {
    worker.postMessage(message)
  }
  catch (error) {
    console.error('[editor:minimap] request post failed', error)
    minimapWorkerRequests.delete(requestId)
    if (state.inFlightRequestId === requestId) {
      state.inFlightRequestId = null
      state.inFlightChunkIndex = null
      state.inFlightCompressionKey = null
      state.inFlightContentKey = null
    }
  }
}

function queueSnapshotRender(
  context: Context,
  state: MinimapRenderState,
  compression: MinimapCompressionState,
  theme: MinimapThemeSnapshot,
  sourceY: number,
  sourceHeight: number,
  burstMode: boolean,
) {
  state.throttleMs = getMinimapWorkerThrottleDelay(burstMode)
  state.pendingSnapshot = {
    sourceY,
    sourceHeight,
  }

  tryDispatchMinimapRequest(context, state, compression, theme)
}

function computeMinimapGeometry(lineCount: number, minimapHeight: number, minimapWidth: number): MinimapGeometryStats {
  const density = lineCount / MINIMAP_MAX_VIRTUAL_ROWS
  const densityT = density <= 1 ? 0 : Math.min(1, (density - 1) / MINIMAP_DENSITY_RANGE)
  const targetRowHeight = MINIMAP_BASE_ROW_HEIGHT
    - ((MINIMAP_BASE_ROW_HEIGHT - MINIMAP_MIN_ROW_HEIGHT) * densityT)

  const maxRowCount = Math.max(1, Math.floor(minimapHeight / MINIMAP_MIN_ROW_HEIGHT))
  const rowCount = Math.max(1, Math.min(maxRowCount, Math.round(minimapHeight / targetRowHeight)))
  const columnCount = Math.max(1, Math.floor(minimapWidth))

  const virtualRowCapacity = Math.max(rowCount, MINIMAP_MAX_VIRTUAL_ROWS)
  const compressedLineSpan = Math.max(1, Math.ceil(lineCount / virtualRowCapacity))
  const mode: 'compressed' | 'windowed' = compressedLineSpan > MINIMAP_MAX_COMPRESSED_LINES_PER_ROW
    ? 'windowed'
    : 'compressed'

  const lineSpan = mode === 'windowed' ? MINIMAP_MAX_COMPRESSED_LINES_PER_ROW : compressedLineSpan
  const virtualRowCount = Math.max(1, Math.ceil(lineCount / lineSpan))
  const rowScale = MINIMAP_BITMAP_ROW_SCALE
  const totalSourceRows = Math.max(1, virtualRowCount * rowScale)

  return {
    lineSpan,
    virtualRowCount,
    columnCount,
    rowScale,
    totalSourceRows,
    mode,
  }
}

function buildCompressionState(
  lineCount: number,
  geometry: MinimapGeometryStats,
  sourceHeight: number,
): MinimapCompressionState {
  const chunkRowCount = geometry.mode === 'windowed'
    ? Math.max(1, Math.min(geometry.totalSourceRows, sourceHeight))
    : geometry.totalSourceRows
  const chunkCount = Math.max(1, Math.ceil(geometry.totalSourceRows / chunkRowCount))
  const key = `${geometry.lineSpan}:${geometry.columnCount}:${geometry.rowScale}:${geometry.totalSourceRows}:${chunkRowCount}`

  return {
    key,
    lineCount,
    lineSpan: geometry.lineSpan,
    columnCount: geometry.columnCount,
    rowScale: geometry.rowScale,
    totalSourceRows: geometry.totalSourceRows,
    chunkRowCount,
    chunkCount,
  }
}

export interface ScrollbarHit {
  type: 'vertical' | 'horizontal' | null
  thumb: boolean
}

export function getVerticalScrollbarSize(settings: Settings): number {
  return settings.showMinimap ? MINIMAP_SCROLLBAR_SIZE : VERTICAL_SCROLLBAR_SIZE
}

function getScrollbarLayout(
  canvas: Canvas,
  scroll: Scroll,
  lines: Lines,
  settings: Settings,
  gutter: Gutter,
  header: Signal<Header>,
): ScrollbarLayout {
  const width = canvas.size.width.value
  const height = canvas.size.height.value
  const totalWidth = lines.totalWidth.value
  const totalHeight = lines.totalHeight.value
  const scrollWidth = scroll.scrollWidth.value
  const scrollHeight = scroll.scrollHeight.value
  const scrollX = scroll.targetX.value
  const scrollY = scroll.targetY.value
  const headerHeight = header.value?.height ?? 0

  const availableHeightForVertical = height - headerHeight - settings.paddingTop - settings.paddingBottom
  const availableWidth = width - settings.paddingLeft - settings.paddingRight - gutter.width.value
  const needsVertical = settings.showMinimap || totalHeight > availableHeightForVertical
  const verticalScrollbarSize = getVerticalScrollbarSize(settings)
  const availableWidthForHorizontal = availableWidth - (needsVertical ? verticalScrollbarSize : 0)
  const needsHorizontal = !settings.wordWrap && totalWidth > availableWidthForHorizontal
  const availableHeight = availableHeightForVertical - (needsHorizontal ? HORIZONTAL_SCROLLBAR_SIZE : 0)

  return {
    width,
    height,
    totalWidth,
    totalHeight,
    scrollWidth,
    scrollHeight,
    scrollX,
    scrollY,
    headerHeight,
    availableHeightForVertical,
    availableWidth,
    availableWidthForHorizontal,
    verticalScrollbarSize,
    needsVertical,
    needsHorizontal,
    availableHeight,
  }
}

function getVerticalThumbMetrics(layout: ScrollbarLayout, scrollY = layout.scrollY) {
  const scrollbarX = layout.width - layout.verticalScrollbarSize
  const trackHeight = layout.height - layout.headerHeight
  const thumbHeightUnclamped = Math.max(
    SCROLLBAR_MIN_THUMB,
    (layout.availableHeight / layout.totalHeight) * trackHeight,
  )
  const thumbHeight = Math.min(trackHeight, thumbHeightUnclamped)
  const trackLength = Math.max(0, trackHeight - thumbHeight)
  const scrollRange = -layout.scrollHeight
  const scrollRatio = scrollRange > 0 ? Math.max(0, Math.min(1, -scrollY / scrollRange)) : 0
  const thumbY = layout.headerHeight + scrollRatio * trackLength

  return {
    scrollbarX,
    trackHeight,
    thumbHeight,
    thumbY,
  }
}

export function hitTestScrollbar(
  canvas: Canvas,
  scroll: Scroll,
  lines: Lines,
  settings: Settings,
  gutter: Gutter,
  header: Signal<Header>,
  x: number,
  y: number,
): ScrollbarHit {
  const layout = getScrollbarLayout(canvas, scroll, lines, settings, gutter, header)

  if (layout.needsVertical) {
    const { scrollbarX, thumbHeight, thumbY } = getVerticalThumbMetrics(layout)
    if (x >= scrollbarX && x <= layout.width && y >= layout.headerHeight) {
      const isThumb = y >= thumbY && y <= thumbY + thumbHeight
      return { type: 'vertical', thumb: isThumb }
    }
  }

  if (layout.needsHorizontal) {
    const scrollbarY = layout.height - HORIZONTAL_SCROLLBAR_SIZE
    if (y >= scrollbarY && y <= layout.height) {
      const trackWidth = layout.width - (layout.needsVertical ? layout.verticalScrollbarSize : 0)
      const thumbWidth = Math.max(
        SCROLLBAR_MIN_THUMB,
        (layout.availableWidthForHorizontal / layout.totalWidth) * trackWidth,
      )
      const scrollRange = -layout.scrollWidth
      const scrollRatio = scrollRange > 0 ? -layout.scrollX / scrollRange : 0
      const thumbX = scrollRatio * (trackWidth - thumbWidth)
      const isThumb = x >= thumbX && x <= thumbX + thumbWidth
      return { type: 'horizontal', thumb: isThumb }
    }
  }

  return { type: null, thumb: false }
}

export function drawScrollbars(context: Context) {
  const { canvas, scroll, lines, settings, gutter, header } = context
  const { c } = canvas
  const layout = getScrollbarLayout(canvas, scroll, lines, settings, gutter, header)

  if (layout.needsVertical) {
    const liveScrollY = scroll.pos.y === Infinity ? layout.scrollY : scroll.pos.y
    const { scrollbarX, trackHeight, thumbHeight, thumbY } = getVerticalThumbMetrics(layout, liveScrollY)
    const isHovered = context.mouse.hovered.scrollbar === 'vertical'

    if (settings.showMinimap) {
      c.fillStyle = getMinimapBackgroundCss(context, isHovered)
      c.fillRect(scrollbarX, layout.headerHeight, layout.verticalScrollbarSize, trackHeight)
      drawMinimapLeftShadow(c, scrollbarX, layout.headerHeight, trackHeight)

      const minimapX = scrollbarX + MINIMAP_INNER_PADDING
      const minimapY = layout.headerHeight + MINIMAP_INNER_PADDING
      const minimapWidth = Math.max(1, layout.verticalScrollbarSize - MINIMAP_INNER_PADDING * 2)
      const minimapHeight = Math.max(1, trackHeight - MINIMAP_INNER_PADDING * 2)
      const lineCount = Math.max(1, context.doc.lines.length)
      const geometry = computeMinimapGeometry(lineCount, minimapHeight, minimapWidth)

      const drawHeight = Math.max(1, minimapHeight)
      const sourceHeight = geometry.mode === 'windowed'
        ? Math.max(1, Math.min(geometry.totalSourceRows, Math.round(drawHeight)))
        : geometry.totalSourceRows

      const scrollRangeY = -layout.scrollHeight
      const scrollRatioY = scrollRangeY > 0 ? Math.max(0, Math.min(1, -liveScrollY / scrollRangeY)) : 0
      const maxSourceY = Math.max(0, geometry.totalSourceRows - sourceHeight)
      const sourceY = geometry.mode === 'windowed'
        ? Math.max(0, Math.min(maxSourceY, Math.round(scrollRatioY * maxSourceY)))
        : 0

      const compression = buildCompressionState(lineCount, geometry, sourceHeight)
      const theme = getMinimapThemeSnapshot(context)
      const contentKey = makeMinimapContentKey(context.doc.revision, context.doc.tokenVersion, theme.themeKey)
      const burstMode = isMinimapBurstMode(context)

      const state = getMinimapRenderState(context)
      if (!state.compression || state.compression.key !== compression.key) {
        resetCompressionState(state, compression)
      }

      state.contentKey = contentKey
      queueSnapshotRender(context, state, compression, theme, sourceY, sourceHeight, burstMode)

      const drewCached = drawMinimapFromCache(
        c,
        state,
        sourceY,
        sourceHeight,
        minimapX,
        minimapY,
        minimapWidth,
        drawHeight,
      )

      if (!drewCached) {
        c.fillStyle = 'rgba(255, 255, 255, 0.02)'
        c.fillRect(minimapX, minimapY, minimapWidth, drawHeight)
      }

      c.fillStyle = isHovered ? MINIMAP_VIEWPORT_HOVER_COLOR : MINIMAP_VIEWPORT_COLOR
      c.fillRect(scrollbarX + 1, thumbY, Math.max(1, layout.verticalScrollbarSize - 2), thumbHeight)
    }
    else {
      c.strokeStyle = SCROLLBAR_TRACK_COLOR
      c.lineWidth = 1
      c.beginPath()
      c.moveTo(scrollbarX, layout.headerHeight)
      c.lineTo(scrollbarX, layout.height)
      c.stroke()

      c.fillStyle = isHovered ? SCROLLBAR_THUMB_HOVER_COLOR : SCROLLBAR_THUMB_COLOR
      c.fillRect(scrollbarX, thumbY, layout.verticalScrollbarSize, thumbHeight)
    }
  }

  if (layout.needsHorizontal) {
    const scrollbarY = layout.height - HORIZONTAL_SCROLLBAR_SIZE
    const trackWidth = layout.width - (layout.needsVertical ? layout.verticalScrollbarSize : 0)

    const thumbWidth = Math.max(
      SCROLLBAR_MIN_THUMB,
      (layout.availableWidthForHorizontal / layout.totalWidth) * trackWidth,
    )
    const scrollRange = -layout.scrollWidth
    const scrollRatio = scrollRange > 0 ? -layout.scrollX / scrollRange : 0
    const thumbX = scrollRatio * (trackWidth - thumbWidth)
    const isHovered = context.mouse.hovered.scrollbar === 'horizontal'

    c.fillStyle = isHovered ? SCROLLBAR_THUMB_HOVER_COLOR : SCROLLBAR_THUMB_COLOR
    c.fillRect(thumbX, scrollbarY, thumbWidth, HORIZONTAL_SCROLLBAR_SIZE)
  }
}
