import type { Signal } from '@preact/signals-core'
import type { Canvas } from '../canvas.ts'
import type { Context } from '../context.ts'
import type { Gutter } from '../gutter.ts'
import type { Header } from '../header.ts'
import type { Lines } from '../lines.ts'
import type {
  MinimapErrorMessage,
  MinimapRenderChunkRequestMessage,
  MinimapRenderChunkResultMessage,
  MinimapThemePayload,
  MinimapWorkerResponseMessage,
} from '../minimap-protocol.ts'
import workerUrl from '../minimap-worker.ts?worker&url'
import type { Scroll } from '../scroll.ts'
import type { Settings } from '../settings.ts'
import type { Token, TokenType } from '../token.ts'

export const VERTICAL_SCROLLBAR_SIZE = 12
export const MINIMAP_SCROLLBAR_SIZE = 64
export const HORIZONTAL_SCROLLBAR_SIZE = 3

const SCROLLBAR_MIN_THUMB = 20
const MINIMAP_MIN_THUMB = 1
const SCROLLBAR_TRACK_COLOR = 'rgba(255, 255, 255, 0.05)'
const SCROLLBAR_THUMB_COLOR = 'rgba(255, 255, 255, 0.1)'
const SCROLLBAR_THUMB_HOVER_COLOR = 'rgba(255, 255, 255, 0.2)'

const MINIMAP_VIEWPORT_COLOR = 'rgba(255, 255, 255, 0.08)'
const MINIMAP_VIEWPORT_HOVER_COLOR = 'rgba(255, 255, 255, 0.14)'
const MINIMAP_INNER_PADDING_X = 4
const MINIMAP_INNER_PADDING_Y = 0
const MINIMAP_BASE_ROW_HEIGHT = 2
const MINIMAP_MIN_ROW_HEIGHT = 1
const MINIMAP_DENSITY_RANGE = 1
const MINIMAP_MAX_VIRTUAL_ROWS = 3000
const MINIMAP_MAX_COMPRESSED_LINES_PER_ROW = 2
const MINIMAP_BITMAP_ROW_SCALE = 1
const MINIMAP_BURST_WINDOW_MS = 120
const MINIMAP_WORKER_THROTTLE_BURST_MS = 120
const MINIMAP_WORKER_THROTTLE_SETTLE_MS = 24
const MINIMAP_MAX_CHUNK_LINES = 1536
const MINIMAP_MAX_SURFACE_PIXELS = 32767
const MINIMAP_MAX_LINE_CHARS = 100
const MINIMAP_PIXEL_ALPHA = 0.5
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
  lineHeight: number
  paddingTop: number
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
  pixelScale: number
  pixelColumnCount: number
  pixelRowScale: number
  pixelTotalSourceRows: number
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

type MinimapViewportModel = {
  modelBaseHeight: number
  viewportHeight: number
  lineCount: number
  fullScrollRange: number
  contentScrollRange: number
  overscrollScrollRange: number
  scrollOffset: number
  contentHeightRatio: number
  fullMinimapHeight: number
  trackLength: number
  thumbHeight: number
  thumbOffset: number
  contentTrackLength: number
  overscrollTrackLength: number
  sourceY: number
  minimapMetrics: ReturnType<typeof getMinimapViewportMetrics>
}

type MinimapRenderState = {
  context: Context
  contextId: number
  compression: MinimapCompressionState | null
  contentKey: string | null
  renderContentKey: string | null
  stitchSurface: MinimapSurface | null
  latchedViewportSurface: MinimapSurface | null
  latchedViewportCompressionKey: string | null
  latchedViewportSourceStart: number
  latchedViewportSourceHeight: number
  latchedViewportContentKey: string | null
  latchedViewportDrawWidth: number
  latchedViewportDrawHeight: number
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
const minimapThemePaletteCache = new Map<string, Record<TokenType, Rgb>>()
const EMPTY_MINIMAP_TOKEN_LINE: Token[] = []
const minimapCompactTokenLineCache = new WeakMap<Token[], Token[]>()

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

function getMinimapThemePalette(theme: MinimapThemeSnapshot): Record<TokenType, Rgb> {
  const cached = minimapThemePaletteCache.get(theme.themeKey)
  if (cached) return cached

  const palette = {} as Record<TokenType, Rgb>
  const fallback = parseColorToRgb(theme.payload.textColor, { r: 255, g: 255, b: 255 })
  for (let i = 0; i < MINIMAP_TOKEN_TYPES.length; i++) {
    const tokenType = MINIMAP_TOKEN_TYPES[i]
    palette[tokenType] = parseColorToRgb(theme.payload.byTokenType[tokenType], fallback)
  }

  minimapThemePaletteCache.set(theme.themeKey, palette)
  return palette
}

function isWhitespaceTokenText(text: string): boolean {
  if (text.length === 0) return false
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 32) return false
  }
  return true
}

function mapMinimapSpan(
  startChar: number,
  length: number,
  columnCount: number,
  columnScale: number,
): [number, number] | null
{
  if (length <= 0) return null
  const start = Math.max(0, startChar)
  const end = Math.max(start + 1, start + length)
  let colStart = Math.floor(start * columnScale)
  let colEnd = Math.ceil(end * columnScale)
  if (colStart >= columnCount) return null
  if (colStart < 0) colStart = 0
  if (colEnd <= colStart) colEnd = colStart + 1
  if (colEnd > columnCount) colEnd = columnCount
  return [colStart, colEnd]
}

function drawMinimapTokenLineIntoRow(
  lineTokens: Token[] | undefined,
  palette: Record<TokenType, Rgb>,
  rowHits: Uint8Array,
  rowColorR: Uint16Array,
  rowColorG: Uint16Array,
  rowColorB: Uint16Array,
  rowColorN: Uint8Array,
  columnCount: number,
  columnScale: number,
) {
  if (!lineTokens || lineTokens.length === 0) return

  let charCursor = 0
  for (let tokenIndex = 0; tokenIndex < lineTokens.length; tokenIndex++) {
    const token = lineTokens[tokenIndex]
    const tokenText = token?.text ?? ''
    if (tokenText.length === 0) continue

    const start = charCursor
    charCursor += tokenText.length

    const tokenType = token?.type ?? 'text'
    if (tokenType === 'text' && isWhitespaceTokenText(tokenText)) continue
    const mapped = mapMinimapSpan(start, tokenText.length, columnCount, columnScale)
    if (!mapped) continue

    const color = palette[tokenType] ?? palette.text
    for (let col = mapped[0]; col < mapped[1]; col++) {
      rowHits[col] = 1
      rowColorR[col] += color.r
      rowColorG[col] += color.g
      rowColorB[col] += color.b
      rowColorN[col] = Math.min(255, rowColorN[col] + 1)
    }
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

function makeMinimapContentKey(tokenVersion: number, themeKey: string): string {
  return `${tokenVersion}:${themeKey}`
}

function isWhitespaceOnlyLine(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 32) return false
  }
  return text.length > 0
}

function createFallbackTokenLineForWorker(line: string): Token[] {
  if (line.length === 0 || isWhitespaceOnlyLine(line)) return EMPTY_MINIMAP_TOKEN_LINE
  return [{
    type: 'text',
    text: line.length > MINIMAP_MAX_LINE_CHARS ? line.slice(0, MINIMAP_MAX_LINE_CHARS) : line,
  }]
}

function compactTokenLineForWorker(tokenLine: Token[] | undefined): Token[] {
  if (!tokenLine || tokenLine.length === 0) return EMPTY_MINIMAP_TOKEN_LINE
  const cached = minimapCompactTokenLineCache.get(tokenLine)
  if (cached) return cached

  let needsCopy = false
  for (let i = 0; i < tokenLine.length; i++) {
    const token = tokenLine[i]
    const text = token?.text ?? ''
    if (text.length === 0 || token?.type == null) {
      needsCopy = true
      break
    }
    if ((token as { line?: number }).line !== undefined
      || (token as { column?: number }).column !== undefined)
    {
      needsCopy = true
      break
    }
  }

  if (!needsCopy) {
    minimapCompactTokenLineCache.set(tokenLine, tokenLine)
    return tokenLine
  }

  const compact: Token[] = []
  for (let i = 0; i < tokenLine.length; i++) {
    const token = tokenLine[i]
    const text = token?.text ?? ''
    if (text.length === 0) continue
    compact.push({
      type: token?.type ?? 'text',
      text,
    })
  }
  const result = compact.length > 0 ? compact : EMPTY_MINIMAP_TOKEN_LINE
  minimapCompactTokenLineCache.set(tokenLine, result)
  return result
}

function prepareTokenLinesForWorker(lines: string[], tokenLines: Token[][], startLine: number, lineCount: number):
  Token[][]
{
  if (lineCount <= 0) return []
  const prepared = new Array<Token[]>(lineCount)
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
    const absoluteLine = startLine + lineIndex
    const compact = compactTokenLineForWorker(tokenLines[absoluteLine])
    prepared[lineIndex] = compact !== EMPTY_MINIMAP_TOKEN_LINE
      ? compact
      : createFallbackTokenLineForWorker(lines[absoluteLine] ?? '')
  }
  return prepared
}

function getMinimapRenderState(context: Context): MinimapRenderState {
  const existing = minimapRenderStateByContext.get(context)
  if (existing) return existing

  const state: MinimapRenderState = {
    context,
    contextId: ++minimapContextId,
    compression: null,
    contentKey: null,
    renderContentKey: null,
    stitchSurface: null,
    latchedViewportSurface: null,
    latchedViewportCompressionKey: null,
    latchedViewportSourceStart: -1,
    latchedViewportSourceHeight: -1,
    latchedViewportContentKey: null,
    latchedViewportDrawWidth: -1,
    latchedViewportDrawHeight: -1,
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

function clearMinimapWorkerRequestsForState(state: MinimapRenderState) {
  for (const [requestId, request] of minimapWorkerRequests) {
    if (request.state !== state) continue
    minimapWorkerRequests.delete(requestId)
    if (state.inFlightRequestId === requestId) {
      state.inFlightRequestId = null
      state.inFlightChunkIndex = null
      state.inFlightCompressionKey = null
      state.inFlightContentKey = null
    }
  }
}

export function invalidateMinimapRenderState(context: Context) {
  const state = minimapRenderStateByContext.get(context)
  if (!state) return

  clearMinimapWorkerRequestsForState(state)
  state.renderContentKey = null
  state.pendingSnapshot = null
  state.lastDispatchAt = 0
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
      || request.chunkIndex !== result.chunkIndex)
    {
      closeBitmap(result.bitmap)
      return
    }

    const stitchSurface = ensureSurface(
      state.stitchSurface,
      compression.pixelColumnCount,
      compression.pixelTotalSourceRows,
    )
    if (!stitchSurface) {
      closeBitmap(result.bitmap)
      return
    }
    state.stitchSurface = stitchSurface

    const chunkHeight = Math.max(1, result.rowCount * result.rowScale)
    stitchSurface.c.clearRect(0, result.chunkStartRow, compression.pixelColumnCount, chunkHeight)
    if (result.hasInk) {
      stitchSurface.c.drawImage(result.bitmap, 0, result.chunkStartRow)
    }

    state.readyChunks.add(result.chunkIndex)
    state.chunkContentKey.set(result.chunkIndex, result.contentKey)
    closeBitmap(result.bitmap)

    if (state.pendingSnapshot && state.inFlightRequestId == null) {
      const theme = getMinimapThemeSnapshot(state.context)
      tryDispatchMinimapRequest(state.context, state, compression, theme)
    }
  }

  minimapWorker = worker
  return worker
}

function resetCompressionState(state: MinimapRenderState, compression: MinimapCompressionState) {
  state.compression = compression
  state.readyChunks.clear()
  state.chunkContentKey.clear()
  state.pendingSnapshot = null
  state.renderContentKey = state.contentKey
  state.latchedViewportSourceStart = -1
  state.latchedViewportSourceHeight = -1
  state.latchedViewportContentKey = null

  state.stitchSurface = ensureSurface(
    state.stitchSurface,
    compression.pixelColumnCount,
    compression.pixelTotalSourceRows,
  )
  if (state.stitchSurface) {
    state.stitchSurface.c.clearRect(0, 0, compression.pixelColumnCount, compression.pixelTotalSourceRows)
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

function isChunkReadyForContent(state: MinimapRenderState, chunkIndex: number, contentKey: string,
  strict: boolean): boolean
{
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

function seedLatchedViewportFromDoc(
  state: MinimapRenderState,
  compression: MinimapCompressionState,
  sourceStart: number,
  sourceHeightInt: number,
  drawWidth: number,
  drawHeight: number,
  contentKey: string,
  theme: MinimapThemeSnapshot,
): boolean {
  const sourceHeightPx = Math.max(1, sourceHeightInt * compression.pixelRowScale)
  const latchedViewportSurface = ensureSurface(
    state.latchedViewportSurface,
    compression.pixelColumnCount,
    sourceHeightPx,
  )
  if (!latchedViewportSurface) return false

  const palette = getMinimapThemePalette(theme)
  const width = compression.pixelColumnCount
  const imageData = latchedViewportSurface.c.createImageData(width, sourceHeightPx)
  const image = imageData.data
  const alpha = clampByte(Math.round(MINIMAP_PIXEL_ALPHA * 255))
  const rowHits = new Uint8Array(width)
  const rowColorR = new Uint16Array(width)
  const rowColorG = new Uint16Array(width)
  const rowColorB = new Uint16Array(width)
  const rowColorN = new Uint8Array(width)
  const columnScale = width / MINIMAP_MAX_LINE_CHARS
  const lines = state.context.doc.lines
  const tokenLines = state.context.doc.tokenLines

  for (let row = 0; row < sourceHeightInt; row++) {
    rowHits.fill(0)
    rowColorR.fill(0)
    rowColorG.fill(0)
    rowColorB.fill(0)
    rowColorN.fill(0)

    const sourceRow = sourceStart + row
    const lineStart = sourceRow * compression.lineSpan
    const lineEnd = Math.min(lines.length, lineStart + compression.lineSpan)
    for (let lineIndex = lineStart; lineIndex < lineEnd; lineIndex++) {
      const compact = compactTokenLineForWorker(tokenLines[lineIndex])
      const preparedLine = compact !== EMPTY_MINIMAP_TOKEN_LINE
        ? compact
        : createFallbackTokenLineForWorker(lines[lineIndex] ?? '')
      drawMinimapTokenLineIntoRow(
        preparedLine,
        palette,
        rowHits,
        rowColorR,
        rowColorG,
        rowColorB,
        rowColorN,
        width,
        columnScale,
      )
    }

    for (let scaleRow = 0; scaleRow < compression.pixelRowScale; scaleRow++) {
      const bitmapRow = row * compression.pixelRowScale + scaleRow
      if (bitmapRow >= sourceHeightPx) break
      const rowOffset = bitmapRow * width * 4
      for (let col = 0; col < width; col++) {
        if (rowHits[col] !== 1) continue
        const offset = rowOffset + col * 4
        const n = Math.max(1, rowColorN[col])
        image[offset] = clampByte(Math.round(rowColorR[col] / n))
        image[offset + 1] = clampByte(Math.round(rowColorG[col] / n))
        image[offset + 2] = clampByte(Math.round(rowColorB[col] / n))
        image[offset + 3] = alpha
      }
    }
  }

  latchedViewportSurface.c.putImageData(imageData, 0, 0)
  state.latchedViewportSurface = latchedViewportSurface
  state.latchedViewportCompressionKey = compression.key
  state.latchedViewportSourceStart = sourceStart
  state.latchedViewportSourceHeight = sourceHeightInt
  state.latchedViewportContentKey = contentKey
  state.latchedViewportDrawWidth = drawWidth
  state.latchedViewportDrawHeight = drawHeight

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
  theme: MinimapThemeSnapshot,
): boolean {
  const compression = state.compression
  if (!compression) return false
  const contentKey = state.contentKey

  const sourceStart = Math.max(0, Math.floor(sourceY))
  const sourceHeightInt = Math.max(1, Math.ceil(sourceHeight))
  const sourceStartPx = sourceStart * compression.pixelRowScale
  const sourceHeightPx = sourceHeightInt * compression.pixelRowScale
  const drawSourceStartPx = Math.max(
    0,
    Math.min(compression.pixelTotalSourceRows - 1, sourceY * compression.pixelRowScale),
  )
  const drawSourceEndPx = Math.max(
    drawSourceStartPx + 1,
    Math.min(compression.pixelTotalSourceRows, (sourceY + sourceHeight) * compression.pixelRowScale),
  )
  const drawSourceHeightPx = Math.max(1, drawSourceEndPx - drawSourceStartPx)

  const canDrawCurrent = !!contentKey
    && isViewportCovered(state, compression, sourceStart, sourceHeightInt, contentKey, true)
  const shouldDrawFromStitch = canDrawCurrent

  const previousSmoothing = c.imageSmoothingEnabled
  c.imageSmoothingEnabled = false

  if (shouldDrawFromStitch && state.stitchSurface) {
    c.drawImage(
      state.stitchSurface.canvas,
      0,
      drawSourceStartPx,
      compression.pixelColumnCount,
      drawSourceHeightPx,
      drawX,
      drawY,
      drawWidth,
      drawHeight,
    )

    const latchedContentKey = contentKey
    const shouldUpdateLatched = state.latchedViewportCompressionKey !== compression.key
      || state.latchedViewportSourceStart !== sourceStart
      || state.latchedViewportSourceHeight !== sourceHeightInt
      || state.latchedViewportContentKey !== latchedContentKey

    if (shouldUpdateLatched) {
      const latchedViewportSurface = ensureSurface(
        state.latchedViewportSurface,
        compression.pixelColumnCount,
        sourceHeightPx,
      )
      if (latchedViewportSurface) {
        latchedViewportSurface.c.clearRect(0, 0, latchedViewportSurface.width, latchedViewportSurface.height)
        latchedViewportSurface.c.drawImage(
          state.stitchSurface.canvas,
          0,
          sourceStartPx,
          compression.pixelColumnCount,
          sourceHeightPx,
          0,
          0,
          compression.pixelColumnCount,
          sourceHeightPx,
        )
        state.latchedViewportSurface = latchedViewportSurface
        state.latchedViewportCompressionKey = compression.key
        state.latchedViewportSourceStart = sourceStart
        state.latchedViewportSourceHeight = sourceHeightInt
        state.latchedViewportContentKey = latchedContentKey
        state.latchedViewportDrawWidth = drawWidth
        state.latchedViewportDrawHeight = drawHeight
      }
    }

    c.imageSmoothingEnabled = previousSmoothing
    return true
  }

  if (contentKey && state.latchedViewportContentKey !== contentKey) {
    seedLatchedViewportFromDoc(
      state,
      compression,
      sourceStart,
      sourceHeightInt,
      drawWidth,
      drawHeight,
      contentKey,
      theme,
    )
  }

  if (state.latchedViewportSurface) {
    const fallbackDrawWidth = state.latchedViewportDrawWidth > 0
      ? state.latchedViewportDrawWidth
      : drawWidth
    const fallbackDrawHeight = state.latchedViewportDrawHeight > 0
      ? state.latchedViewportDrawHeight
      : drawHeight
    const drawSizeChanged = Math.abs(fallbackDrawWidth - drawWidth) > 0.5
      || Math.abs(fallbackDrawHeight - drawHeight) > 0.5
    const targetDrawWidth = drawSizeChanged ? fallbackDrawWidth : drawWidth
    const targetDrawHeight = drawSizeChanged ? fallbackDrawHeight : drawHeight

    c.drawImage(
      state.latchedViewportSurface.canvas,
      0,
      0,
      state.latchedViewportSurface.width,
      state.latchedViewportSurface.height,
      drawX,
      drawY,
      targetDrawWidth,
      targetDrawHeight,
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

  const latestContentKey = state.contentKey
  if (!latestContentKey) return
  if (!state.renderContentKey) {
    state.renderContentKey = latestContentKey
  }

  const snapshot = state.pendingSnapshot
  let dispatchContentKey = state.renderContentKey
  if (
    dispatchContentKey !== latestContentKey
    && isViewportCovered(state, compression, snapshot.sourceY, snapshot.sourceHeight, dispatchContentKey, true)
  ) {
    // Once the currently visible viewport is fully reconciled, jump to latest content.
    dispatchContentKey = latestContentKey
    state.renderContentKey = latestContentKey
  }

  let targetChunkIndex = pickNextChunkIndexForSnapshot(
    state,
    compression,
    snapshot.sourceY,
    snapshot.sourceHeight,
    dispatchContentKey,
  )
  if (targetChunkIndex < 0 && dispatchContentKey !== latestContentKey) {
    dispatchContentKey = latestContentKey
    state.renderContentKey = latestContentKey
    targetChunkIndex = pickNextChunkIndexForSnapshot(
      state,
      compression,
      snapshot.sourceY,
      snapshot.sourceHeight,
      dispatchContentKey,
    )
  }
  if (targetChunkIndex < 0) {
    state.pendingSnapshot = null
    return
  }

  const now = Date.now()
  const viewportNeedsUrgentFill = !isViewportCovered(
    state,
    compression,
    snapshot.sourceY,
    snapshot.sourceHeight,
    dispatchContentKey,
    true,
  )
  const throttleMs = viewportNeedsUrgentFill ? 0 : state.throttleMs
  if (now - state.lastDispatchAt < throttleMs) return

  const chunkStartRow = targetChunkIndex * compression.chunkRowCount
  const rowCount = Math.max(1, Math.min(compression.chunkRowCount, compression.totalSourceRows - chunkStartRow))
  const chunkEndRow = chunkStartRow + rowCount
  const lineStart = chunkStartRow * compression.lineSpan
  const lineEnd = Math.min(compression.lineCount, chunkEndRow * compression.lineSpan)
  const lineCount = Math.max(0, lineEnd - lineStart)
  if (lineCount <= 0) {
    const chunkPixelStart = chunkStartRow * compression.pixelRowScale
    const chunkPixelHeight = Math.max(1, rowCount * compression.pixelRowScale)
    state.stitchSurface?.c.clearRect(0, chunkPixelStart, compression.pixelColumnCount, chunkPixelHeight)
    state.readyChunks.add(targetChunkIndex)
    state.chunkContentKey.set(targetChunkIndex, dispatchContentKey)
    // Keep draining the current snapshot until viewport coverage is complete.
    tryDispatchMinimapRequest(context, state, compression, theme)
    return
  }

  const tokenLines = prepareTokenLinesForWorker(context.doc.lines, context.doc.tokenLines, lineStart, lineCount)

  const requestId = ++minimapRequestId
  const message: MinimapRenderChunkRequestMessage = {
    type: 'minimapRenderChunk',
    requestId,
    contextId: state.contextId,
    revision: context.doc.revision,
    tokenVersion: context.doc.tokenVersion,
    compressionKey: compression.key,
    contentKey: dispatchContentKey,
    chunkIndex: targetChunkIndex,
    chunkStartRow: chunkStartRow * compression.pixelRowScale,
    rowCount,
    lineSpan: compression.lineSpan,
    columnCount: compression.pixelColumnCount,
    rowScale: compression.pixelRowScale,
    tokenLines,
    theme: theme.payload,
  }

  state.inFlightRequestId = requestId
  state.inFlightChunkIndex = targetChunkIndex
  state.inFlightCompressionKey = compression.key
  state.inFlightContentKey = dispatchContentKey
  state.lastDispatchAt = now

  minimapWorkerRequests.set(requestId, {
    state,
    compressionKey: compression.key,
    contentKey: dispatchContentKey,
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
  const snapshotChunkIndex = Math.max(
    0,
    Math.min(compression.chunkCount - 1, Math.floor(sourceY / compression.chunkRowCount)),
  )

  if (
    state.inFlightRequestId != null
    && state.inFlightChunkIndex === snapshotChunkIndex
    && state.inFlightCompressionKey === compression.key
    && state.inFlightContentKey === state.contentKey
  ) {
    return
  }

  if (state.pendingSnapshot) {
    const pendingChunkIndex = Math.max(
      0,
      Math.min(compression.chunkCount - 1, Math.floor(state.pendingSnapshot.sourceY / compression.chunkRowCount)),
    )
    if (pendingChunkIndex === snapshotChunkIndex
      && Math.round(state.pendingSnapshot.sourceHeight) === Math.round(sourceHeight))
    {
      // Keep pumping even when the snapshot target is unchanged; otherwise we can deadlock
      // waiting for a same-target pending snapshot to dispatch after in-flight completion.
      tryDispatchMinimapRequest(context, state, compression, theme)
      return
    }
  }

  state.pendingSnapshot = {
    sourceY,
    sourceHeight,
  }

  tryDispatchMinimapRequest(context, state, compression, theme)
}

function computeMinimapGeometry(
  lineCount: number,
  minimapHeight: number,
  minimapWidth: number,
  maxTotalSourceRows = Number.POSITIVE_INFINITY,
): MinimapGeometryStats {
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

  if (totalSourceRows > maxTotalSourceRows) {
    const clampedLineSpan = Math.max(lineSpan, Math.ceil(lineCount / Math.max(1, maxTotalSourceRows)))
    const clampedVirtualRowCount = Math.max(1, Math.ceil(lineCount / clampedLineSpan))
    const clampedMode: 'compressed' | 'windowed' = clampedLineSpan > MINIMAP_MAX_COMPRESSED_LINES_PER_ROW
      ? 'windowed'
      : 'compressed'
    return {
      lineSpan: clampedLineSpan,
      virtualRowCount: clampedVirtualRowCount,
      columnCount,
      rowScale,
      totalSourceRows: Math.max(1, clampedVirtualRowCount * rowScale),
      mode: clampedMode,
    }
  }

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
  pixelScale: number,
): MinimapCompressionState {
  const maxChunkRowsByLineBudget = Math.max(1, Math.floor(MINIMAP_MAX_CHUNK_LINES / geometry.lineSpan))
  const modeChunkRowCount = Math.max(1, Math.min(geometry.totalSourceRows, sourceHeight))
  const chunkRowCount = Math.max(1, Math.min(modeChunkRowCount, maxChunkRowsByLineBudget))
  const chunkCount = Math.max(1, Math.ceil(geometry.totalSourceRows / chunkRowCount))
  const pixelRowScale = Math.max(1, Math.round(geometry.rowScale * pixelScale))
  const pixelColumnCount = Math.max(1, Math.round(geometry.columnCount * pixelScale))
  const pixelTotalSourceRows = Math.max(1, geometry.totalSourceRows * pixelRowScale)
  const key =
    `${geometry.lineSpan}:${geometry.columnCount}:${geometry.rowScale}:${geometry.totalSourceRows}:${chunkRowCount}:`
    + `${pixelScale}:${pixelColumnCount}:${pixelRowScale}`

  return {
    key,
    lineCount,
    lineSpan: geometry.lineSpan,
    columnCount: geometry.columnCount,
    rowScale: geometry.rowScale,
    totalSourceRows: geometry.totalSourceRows,
    chunkRowCount,
    chunkCount,
    pixelScale,
    pixelColumnCount,
    pixelRowScale,
    pixelTotalSourceRows,
  }
}

export interface ScrollbarHit {
  type: 'vertical' | 'horizontal' | null
  thumb: boolean
}

export interface VerticalScrollbarMetrics {
  isMinimap: boolean
  modelBaseHeight: number
  viewportHeight: number
  minimapMode: 'compressed' | 'windowed' | null
  minimapLineSpan: number
  minimapSourceHeight: number
  minimapDrawHeight: number
  minimapSourceY: number
  minimapTotalSourceRows: number
  scrollbarX: number
  trackY: number
  trackHeight: number
  thumbTrackY: number
  thumbTrackHeight: number
  trackLength: number
  thumbHeight: number
  thumbY: number
  scrollHeight: number
  contentScrollRange: number
  overscrollScrollRange: number
  contentTrackLength: number
  overscrollTrackLength: number
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
  const lineHeight = settings.lineHeight
  const paddingTop = settings.paddingTop
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
    lineHeight,
    paddingTop,
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

function getMinimapViewportMetrics(
  lineCountInput: number,
  fullTrackHeight: number,
  verticalScrollbarSize: number,
  canvasDpr = 1,
  _contentHeightRatio = 1,
) {
  const lineCount = Math.max(1, Math.ceil(lineCountInput))
  const minimapPixelScale = Math.max(1, canvasDpr)
  const alignToDevicePixels = (value: number) => Math.round(value * minimapPixelScale) / minimapPixelScale
  const fullMinimapHeight = Math.max(
    1 / minimapPixelScale,
    alignToDevicePixels(fullTrackHeight - MINIMAP_INNER_PADDING_Y * 2),
  )
  const minimapHeight = fullMinimapHeight
  const minimapWidth = Math.max(
    1 / minimapPixelScale,
    alignToDevicePixels(verticalScrollbarSize - MINIMAP_INNER_PADDING_X * 2),
  )
  const maxPixelRowScale = Math.max(1, Math.round(MINIMAP_BITMAP_ROW_SCALE * minimapPixelScale))
  const maxTotalSourceRows = Math.max(1, Math.floor(MINIMAP_MAX_SURFACE_PIXELS / maxPixelRowScale))
  const geometry = computeMinimapGeometry(
    lineCount,
    fullMinimapHeight,
    minimapWidth,
    maxTotalSourceRows,
  )
  const pixelRowScale = Math.max(1, Math.round(geometry.rowScale * minimapPixelScale))
  const maxDrawHeight = (geometry.totalSourceRows * pixelRowScale) / minimapPixelScale
  const drawHeight = Math.max(
    1 / minimapPixelScale,
    Math.min(minimapHeight, maxDrawHeight),
  )
  const sourceHeightExact = Math.max(
    1,
    Math.min(
      geometry.totalSourceRows,
      (drawHeight * minimapPixelScale) / pixelRowScale,
    ),
  )
  const sourceHeight = Math.max(
    1,
    Math.min(
      geometry.totalSourceRows,
      Math.ceil(sourceHeightExact),
    ),
  )
  return {
    minimapHeight,
    minimapWidth,
    geometry,
    sourceHeight,
    sourceHeightExact,
    drawHeight,
    minimapPixelScale,
  }
}

export function getMinimapTrackHeightForLineCount(
  lineCountInput: number,
  fullTrackHeight: number,
  verticalScrollbarSize: number,
  canvasDpr = 1,
): number {
  const { drawHeight } = getMinimapViewportMetrics(
    lineCountInput,
    fullTrackHeight,
    verticalScrollbarSize,
    canvasDpr,
  )
  return Math.max(
    MINIMAP_MIN_THUMB,
    Math.min(fullTrackHeight, drawHeight + MINIMAP_INNER_PADDING_Y * 2),
  )
}

function getMinimapViewportModel(
  layout: ScrollbarLayout,
  scrollY = layout.scrollY,
  minimapLineCount?: number,
  canvasDpr = 1,
): MinimapViewportModel {
  const contentLineCount = Math.max(1, minimapLineCount ?? 1)
  const devicePixelScale = Math.max(1, canvasDpr)
  const alignToDevicePixels = (value: number) => Math.round(value * devicePixelScale) / devicePixelScale
  const fullMinimapHeight = Math.max(
    1 / devicePixelScale,
    alignToDevicePixels(layout.height - MINIMAP_INNER_PADDING_Y * 2),
  )
  const fullScrollRange = Math.max(0, -layout.scrollHeight)
  const contentScrollRange = Math.max(0, layout.totalHeight - layout.availableHeight)
  const scrollOffset = Math.max(0, Math.min(fullScrollRange, -scrollY))
  const overscrollScrollRange = Math.max(0, fullScrollRange - contentScrollRange)
  const modelBaseHeight = Math.max(1, layout.totalHeight + overscrollScrollRange)
  const contentHeightRatio = Math.max(0, Math.min(1, layout.totalHeight / modelBaseHeight))
  const safeContentHeightRatio = contentHeightRatio > 0 ? contentHeightRatio : 1
  const effectiveLineCount = Math.max(
    contentLineCount,
    Math.ceil(contentLineCount / safeContentHeightRatio),
  )
  const minimapMetrics = getMinimapViewportMetrics(
    effectiveLineCount,
    layout.height,
    layout.verticalScrollbarSize,
    canvasDpr,
  )
  const { geometry, sourceHeightExact, drawHeight } = minimapMetrics
  const sourceRowsPerPixel = geometry.totalSourceRows / modelBaseHeight
  const viewportSourceHeight = Math.max(
    Math.min(geometry.totalSourceRows, sourceRowsPerPixel),
    Math.min(geometry.totalSourceRows, layout.availableHeight * sourceRowsPerPixel),
  )
  const viewportSourceStart = Math.max(
    0,
    Math.min(
      Math.max(0, geometry.totalSourceRows - viewportSourceHeight),
      scrollOffset * sourceRowsPerPixel,
    ),
  )
  const visibleSourceHeight = Math.max(1, Math.min(geometry.totalSourceRows, sourceHeightExact))
  const maxSourceY = Math.max(0, geometry.totalSourceRows - visibleSourceHeight)
  const maxViewportSourceStart = Math.max(0, geometry.totalSourceRows - viewportSourceHeight)
  let sourceY = 0
  if (maxViewportSourceStart > 0) {
    sourceY = Math.max(
      0,
      Math.min(
        maxSourceY,
        (viewportSourceStart / maxViewportSourceStart) * maxSourceY,
      ),
    )
  }
  const viewportSourceEnd = Math.min(geometry.totalSourceRows, viewportSourceStart + viewportSourceHeight)
  const contentSliceStart = Math.max(0, Math.min(visibleSourceHeight, viewportSourceStart - sourceY))
  const contentSliceEnd = Math.max(0, Math.min(visibleSourceHeight, viewportSourceEnd - sourceY))
  const contentThumbOffset = visibleSourceHeight > 0 ? (contentSliceStart / visibleSourceHeight) * drawHeight : 0
  const contentThumbHeight = visibleSourceHeight > 0
    ? ((Math.max(contentSliceStart, contentSliceEnd) - Math.min(contentSliceStart, contentSliceEnd))
      / visibleSourceHeight)
      * drawHeight
    : drawHeight
  const blankTrackHeight = Math.max(0, fullMinimapHeight - drawHeight)
  const thumbHeight = Math.min(
    fullMinimapHeight,
    Math.max(
      MINIMAP_MIN_THUMB,
      contentThumbHeight + blankTrackHeight,
    ),
  )
  const trackLength = Math.max(0, fullMinimapHeight - thumbHeight)
  const thumbOffset = Math.max(0, Math.min(trackLength, contentThumbOffset))
  const contentTrackLength = trackLength
  const overscrollTrackLength = 0

  return {
    modelBaseHeight,
    viewportHeight: layout.availableHeight,
    lineCount: effectiveLineCount,
    fullScrollRange,
    contentScrollRange,
    overscrollScrollRange,
    scrollOffset,
    contentHeightRatio,
    fullMinimapHeight,
    trackLength,
    thumbHeight,
    thumbOffset,
    contentTrackLength,
    overscrollTrackLength,
    sourceY,
    minimapMetrics,
  }
}

function getVerticalThumbMetrics(
  layout: ScrollbarLayout,
  _lines: Lines,
  scrollY = layout.scrollY,
  minimapLineCount?: number,
  canvasDpr = 1,
) {
  const isMinimapMode = layout.verticalScrollbarSize === MINIMAP_SCROLLBAR_SIZE
  const scrollbarX = layout.width - layout.verticalScrollbarSize
  const trackY = isMinimapMode ? 0 : layout.headerHeight
  const trackHeight = layout.height - trackY
  const devicePixelScale = Math.max(1, canvasDpr)
  const alignToDevicePixels = (value: number) => Math.round(value * devicePixelScale) / devicePixelScale
  let thumbTrackY = trackY
  let thumbTrackHeight = trackHeight
  let thumbHeight = trackHeight
  let trackLength = 0
  let contentTrackLength = 0
  let overscrollTrackLength = 0
  let modelBaseHeight = layout.totalHeight
  let viewportHeight = layout.availableHeight
  let minimapMode: 'compressed' | 'windowed' | null = null
  let minimapLineSpan = 1
  let minimapSourceHeight = 0
  let minimapDrawHeight = 0
  let minimapSourceY = 0
  let minimapTotalSourceRows = 0
  const fullScrollRange = Math.max(0, -layout.scrollHeight)
  const rawContentScrollRange = Math.max(0, layout.totalHeight - layout.availableHeight)
  const contentScrollRange = isMinimapMode ? rawContentScrollRange : fullScrollRange
  const overscrollScrollRange = isMinimapMode ? Math.max(0, fullScrollRange - rawContentScrollRange) : 0
  const scrollOffset = Math.max(0, Math.min(fullScrollRange, -scrollY))
  let thumbY = thumbTrackY

  if (isMinimapMode) {
    const viewportModel = getMinimapViewportModel(layout, scrollY, minimapLineCount, canvasDpr)
    modelBaseHeight = viewportModel.modelBaseHeight
    viewportHeight = viewportModel.viewportHeight
    minimapMode = viewportModel.minimapMetrics.geometry.mode
    minimapLineSpan = viewportModel.minimapMetrics.geometry.lineSpan
    minimapSourceHeight = viewportModel.minimapMetrics.sourceHeight
    minimapDrawHeight = viewportModel.minimapMetrics.drawHeight
    minimapSourceY = viewportModel.sourceY
    minimapTotalSourceRows = viewportModel.minimapMetrics.geometry.totalSourceRows
    thumbTrackY = alignToDevicePixels(trackY + MINIMAP_INNER_PADDING_Y)
    thumbTrackHeight = viewportModel.fullMinimapHeight
    thumbHeight = viewportModel.thumbHeight
    trackLength = viewportModel.trackLength
    contentTrackLength = viewportModel.contentTrackLength
    overscrollTrackLength = viewportModel.overscrollTrackLength
    thumbY = thumbTrackY + Math.max(0, Math.min(trackLength, viewportModel.thumbOffset))
  }
  else {
    const thumbHeightUnclamped = Math.max(
      SCROLLBAR_MIN_THUMB,
      (layout.availableHeight / layout.totalHeight) * trackHeight,
    )
    thumbHeight = Math.min(trackHeight, thumbHeightUnclamped)
    trackLength = Math.max(0, trackHeight - thumbHeight)
    contentTrackLength = trackLength
    overscrollTrackLength = 0
    thumbY = trackY + (contentScrollRange > 0 ? (scrollOffset / contentScrollRange) * contentTrackLength : 0)
  }

  return {
    isMinimap: isMinimapMode,
    modelBaseHeight,
    viewportHeight,
    minimapMode,
    minimapLineSpan,
    minimapSourceHeight,
    minimapDrawHeight,
    minimapSourceY,
    minimapTotalSourceRows,
    scrollbarX,
    trackY,
    trackHeight,
    thumbTrackY,
    thumbTrackHeight,
    trackLength,
    thumbHeight,
    thumbY,
    contentScrollRange,
    overscrollScrollRange,
    contentTrackLength,
    overscrollTrackLength,
  }
}

export function getVerticalScrollbarMetrics(
  canvas: Canvas,
  scroll: Scroll,
  lines: Lines,
  settings: Settings,
  gutter: Gutter,
  header: Signal<Header>,
  minimapLineCount?: number,
  scrollYOverride?: number,
): VerticalScrollbarMetrics | null {
  const layout = getScrollbarLayout(canvas, scroll, lines, settings, gutter, header)
  if (!layout.needsVertical) return null
  const metrics = getVerticalThumbMetrics(
    layout,
    lines,
    scrollYOverride ?? layout.scrollY,
    minimapLineCount,
    canvas.dpr.value,
  )
  return {
    ...metrics,
    scrollHeight: layout.scrollHeight,
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
  minimapLineCount?: number,
): ScrollbarHit {
  const layout = getScrollbarLayout(canvas, scroll, lines, settings, gutter, header)

  if (layout.needsVertical) {
    const scrollYForHit = scroll.pos.y === Infinity ? 0 : scroll.pos.y
    const verticalMetrics = getVerticalScrollbarMetrics(
      canvas,
      scroll,
      lines,
      settings,
      gutter,
      header,
      minimapLineCount,
      scrollYForHit,
    )
    if (
      verticalMetrics
      && x >= verticalMetrics.scrollbarX
      && x <= layout.width
      && y >= verticalMetrics.trackY
      && y <= verticalMetrics.trackY
        + (settings.showMinimap ? verticalMetrics.trackHeight : verticalMetrics.thumbTrackHeight)
    ) {
      const { thumbY, thumbHeight } = verticalMetrics
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
    const liveScrollY = scroll.pos.y === Infinity ? 0 : scroll.pos.y
    const { scrollbarX, trackY, trackHeight, thumbHeight, thumbY } = getVerticalThumbMetrics(
      layout,
      lines,
      liveScrollY,
      context.doc.lines.length,
      canvas.dpr.value,
    )
    const isHovered = context.mouse.hovered.scrollbar === 'vertical'

    if (settings.showMinimap) {
      const canvasDpr = Math.max(1, canvas.dpr.value)
      const alignToDevicePixels = (value: number) => Math.round(value * canvasDpr) / canvasDpr
      const fullTrackHeight = trackHeight
      c.fillStyle = getMinimapBackgroundCss(context, isHovered)
      c.fillRect(scrollbarX, trackY, layout.verticalScrollbarSize, fullTrackHeight)
      drawMinimapLeftShadow(c, scrollbarX, trackY, fullTrackHeight)

      const viewportModel = getMinimapViewportModel(layout, liveScrollY, context.doc.lines.length, canvasDpr)
      const minimapX = alignToDevicePixels(scrollbarX + MINIMAP_INNER_PADDING_X)
      const minimapY = alignToDevicePixels(trackY + MINIMAP_INNER_PADDING_Y)
      const { geometry, sourceHeight, sourceHeightExact, drawHeight, minimapPixelScale } = viewportModel.minimapMetrics
      const sourceY = viewportModel.sourceY
      const compression = buildCompressionState(
        viewportModel.lineCount,
        geometry,
        sourceHeight,
        minimapPixelScale,
      )
      // Draw at the exact CSS size that maps to the source pixel crop to avoid stretch blits.
      const drawWidth = Math.max(1, compression.pixelColumnCount / compression.pixelScale)
      const theme = getMinimapThemeSnapshot(context)
      const state = getMinimapRenderState(context)
      const rawContentKey = makeMinimapContentKey(context.doc.tokenVersion, theme.themeKey)
      const contentKey = (context.doc.tokenizationPending && state.renderContentKey)
        ? state.renderContentKey
        : rawContentKey
      const burstMode = isMinimapBurstMode(context)
      state.contentKey = contentKey
      if (!state.compression
        || state.compression.key !== compression.key
        || state.compression.lineCount !== compression.lineCount)
      {
        resetCompressionState(state, compression)
      }

      state.contentKey = contentKey
      queueSnapshotRender(context, state, compression, theme, sourceY, sourceHeightExact, burstMode)

      c.save()
      c.beginPath()
      c.rect(minimapX, minimapY, drawWidth, drawHeight)
      c.clip()

      const drewCached = drawMinimapFromCache(
        c,
        state,
        sourceY,
        sourceHeightExact,
        minimapX,
        minimapY,
        drawWidth,
        drawHeight,
        theme,
      )

      if (!drewCached) {
        c.fillStyle = 'rgba(255, 255, 255, 0.02)'
        c.fillRect(minimapX, minimapY, drawWidth, drawHeight)
      }
      c.restore()

      // Keep viewport visuals on the exact same geometry used by minimap drag/hit-testing.
      const viewportHeight = thumbHeight
      const viewportY = thumbY

      c.fillStyle = isHovered ? MINIMAP_VIEWPORT_HOVER_COLOR : MINIMAP_VIEWPORT_COLOR
      c.fillRect(scrollbarX + 1, viewportY, Math.max(1, layout.verticalScrollbarSize - 2), viewportHeight)
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
