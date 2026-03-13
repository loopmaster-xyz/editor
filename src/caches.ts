import { effect } from '@preact/signals-core'
import type { MatchingBrace } from './blocks.ts'
import type { Canvas } from './canvas.ts'
import type { Context } from './context.ts'
import type { Doc, DocError } from './doc.ts'
import type { VisualLine } from './lines.ts'
import type { Settings } from './settings.ts'
import type { Token } from './token.ts'
import type { Widget } from './widget.ts'

export interface LineCanvas {
  lineCacheKey: string
  braceAnalysisVersion: number
  braceRenderTokenVersion: number
  braceRenderTokenRef: Token[] | null
  c: OffscreenCanvasRenderingContext2D
  canvas: OffscreenCanvas
}

const MIN_LINE_CANVAS_DIMENSION = 32
const MIN_LINE_CANVAS_POOL_SIZE = 128

function nextPowerOfTwo(value: number): number {
  let power = 1
  const target = Math.max(1, Math.ceil(value))
  while (power < target) power *= 2
  return power
}

function quantizeLineCanvasDimension(value: number): number {
  return Math.max(MIN_LINE_CANVAS_DIMENSION, nextPowerOfTwo(value))
}

function makeLineCanvasBucketKey(width: number, height: number): string {
  return `${width}x${height}`
}

function getLineCanvasSegmentKey(logicalLine: number, tokenOffset: number): string {
  return `${logicalLine}:${tokenOffset}`
}

const logicalTokenLineIdCache = new WeakMap<Token[], number>()
let nextLogicalTokenLineId = 1

function getLogicalTokenLineId(tokens: Token[]): number {
  const cached = logicalTokenLineIdCache.get(tokens)
  if (cached !== undefined) return cached
  const id = nextLogicalTokenLineId++
  logicalTokenLineIdCache.set(tokens, id)
  return id
}

const docIdentityIdCache = new WeakMap<object, number>()
let nextDocIdentityId = 1

function getDocIdentityId(identity: unknown): number {
  if (typeof identity !== 'object' || identity === null) return 0
  const cached = docIdentityIdCache.get(identity)
  if (cached !== undefined) return cached
  const id = nextDocIdentityId++
  docIdentityIdCache.set(identity, id)
  return id
}

function getWidgetCacheKey(widget: Widget): string {
  const type = widget.type
  if (widget.type === 'above' || widget.type === 'below' || widget.type === 'overlay') {
    const [x1, x2] = widget.pos.x
    return `${type}${x1}${x2}${widget.pos.y}`
  }
  else if (widget.type === 'before' || widget.type === 'after') {
    return `${type}${widget.pos.x}${widget.pos.y}${widget.pos.width}`
  }
  else if (widget.type === 'inlay') {
    return `${type}${widget.pos.x}${widget.pos.y}${widget.content}`
  }
  else {
    return `${type}${widget.pos.y}`
  }
}

function getErrorCacheKey(error: DocError): string {
  const [x1, x2] = error.x
  return `${x1}${x2}${error.y}${error.message}`
}

export function getWrapTokensCacheKey(
  maxWidth: number,
  lineWidgets: Widget[],
  lineErrors: DocError[],
  settings: Settings,
): string {
  let widgetsKey = ''
  for (let i = 0; i < lineWidgets.length; i++) widgetsKey += getWidgetCacheKey(lineWidgets[i])
  let errorsKey = ''
  for (let i = 0; i < lineErrors.length; i++) errorsKey += getErrorCacheKey(lineErrors[i])
  return [
    maxWidth,
    widgetsKey,
    errorsKey,
    settings.lineHeight,
    settings.fontSize,
  ].join(WRAP_TOKENS_CACHE_KEY_DELIMITER)
}

const WRAP_TOKENS_CACHE_KEY_DELIMITER = '|||'

export function getLineCacheKey(context: Context, line: VisualLine, logicalLineTokens: Token[]) {
  const tokenLineId = getLogicalTokenLineId(logicalLineTokens)
  const docIdentityId = getDocIdentityId(context.docIdentity)
  const first = line.tokens[0]
  const last = line.tokens[line.tokens.length - 1]
  const firstLogicalTokenIndex = first?.logicalTokenIndex ?? -1
  const firstLogicalCharOffset = first?.logicalCharOffset ?? -1
  const lastLogicalTokenIndex = last?.logicalTokenIndex ?? -1
  const lastLogicalCharOffset = last?.logicalCharOffset ?? -1
  return `${docIdentityId}|${tokenLineId}|${line.logicalLine}|${line.tokenOffset}|${line.tokens.length}|${firstLogicalTokenIndex}|${firstLogicalCharOffset}|${lastLogicalTokenIndex}|${lastLogicalCharOffset}|${line.width}|${line.height}|${context.canvas.ligatureDpr.value}|${context.settings.lineHeight}|${context.settings.fontSize}|${context.doc.revision}`
}

export type Caches = ReturnType<typeof createCaches>

interface DocCacheState {
  lineCanvasCache: Map<string, LineCanvas>
  lineCanvasCacheByLine: Map<string, LineCanvas>
  lineCanvasPoolByBucket: Map<string, LineCanvas[]>
  lineCanvasPoolCount: number
  lineCanvasUsageOrder: Map<string, true>
  wrapTokensCache: Map<string, VisualLine[]>
  wrapTokensCacheByTokenRef: Map<Token[], Map<string, VisualLine[]>>
  wrapTokensCacheByLine: Map<number, string>
  matchingBraceCache: Map<string, MatchingBrace | null>
  getXFromColumnCache: Map<string, number>
  findVisualLineForColumnCache: Map<string, VisualLine | null>
  revision: number
  tokenVersion: number
  historyRef: unknown
  codeLength: number
  lineCount: number
}

export function createCaches(canvas: Canvas, settings: Settings, doc: Doc) {
  const measureTextCache = new Map<string, { width: number; height: number; fontHeight: number }>()
  const createDocCacheState = (): DocCacheState => ({
    lineCanvasCache: new Map<string, LineCanvas>(),
    lineCanvasCacheByLine: new Map<string, LineCanvas>(),
    lineCanvasPoolByBucket: new Map<string, LineCanvas[]>(),
    lineCanvasPoolCount: 0,
    lineCanvasUsageOrder: new Map<string, true>(),
    wrapTokensCache: new Map<string, VisualLine[]>(),
    wrapTokensCacheByTokenRef: new Map<Token[], Map<string, VisualLine[]>>(),
    wrapTokensCacheByLine: new Map<number, string>(),
    matchingBraceCache: new Map<string, MatchingBrace | null>(),
    getXFromColumnCache: new Map<string, number>(),
    findVisualLineForColumnCache: new Map<string, VisualLine | null>(),
    revision: -1,
    tokenVersion: -1,
    historyRef: null,
    codeLength: -1,
    lineCount: -1,
  })

  const cacheStateByDoc = new WeakMap<Doc, DocCacheState>()
  let activeDocCacheState = createDocCacheState()
  let lineCanvasCache = activeDocCacheState.lineCanvasCache
  let lineCanvasCacheByLine = activeDocCacheState.lineCanvasCacheByLine
  let lineCanvasPoolByBucket = activeDocCacheState.lineCanvasPoolByBucket
  let lineCanvasPoolCount = activeDocCacheState.lineCanvasPoolCount
  let lineCanvasUsageOrder = activeDocCacheState.lineCanvasUsageOrder
  let lineCanvasBudget = 128
  let wrapTokensCache = activeDocCacheState.wrapTokensCache
  let wrapTokensCacheByTokenRef = activeDocCacheState.wrapTokensCacheByTokenRef
  let wrapTokensCacheByLine = activeDocCacheState.wrapTokensCacheByLine
  let matchingBraceCache = activeDocCacheState.matchingBraceCache
  let getXFromColumnCache = activeDocCacheState.getXFromColumnCache
  let findVisualLineForColumnCache = activeDocCacheState.findVisualLineForColumnCache

  const syncLineCanvasPoolCount = () => {
    activeDocCacheState.lineCanvasPoolCount = lineCanvasPoolCount
  }

  const applyDocCacheState = (state: DocCacheState) => {
    activeDocCacheState = state
    lineCanvasCache = state.lineCanvasCache
    lineCanvasCacheByLine = state.lineCanvasCacheByLine
    lineCanvasPoolByBucket = state.lineCanvasPoolByBucket
    lineCanvasPoolCount = state.lineCanvasPoolCount
    lineCanvasUsageOrder = state.lineCanvasUsageOrder
    wrapTokensCache = state.wrapTokensCache
    wrapTokensCacheByTokenRef = state.wrapTokensCacheByTokenRef
    wrapTokensCacheByLine = state.wrapTokensCacheByLine
    matchingBraceCache = state.matchingBraceCache
    getXFromColumnCache = state.getXFromColumnCache
    findVisualLineForColumnCache = state.findVisualLineForColumnCache
  }

  const saveStateForDoc = (owner: Doc) => {
    syncLineCanvasPoolCount()
    activeDocCacheState.revision = owner.revision
    activeDocCacheState.tokenVersion = owner.tokenVersion
    activeDocCacheState.historyRef = owner.buffer.history.value
    activeDocCacheState.codeLength = owner.code.length
    activeDocCacheState.lineCount = owner.lines.length
    cacheStateByDoc.set(owner, activeDocCacheState)
  }

  const restoreStateForDoc = (owner: Doc) => {
    const cached = cacheStateByDoc.get(owner) ?? createDocCacheState()
    cacheStateByDoc.set(owner, cached)
    applyDocCacheState(cached)
    const cacheMatchesOwner = cached.revision === owner.revision
      && cached.tokenVersion === owner.tokenVersion
      && cached.historyRef === owner.buffer.history.value
      && cached.codeLength === owner.code.length
      && cached.lineCount === owner.lines.length
    if (!cacheMatchesOwner) {
      clearVisualCaches()
      cached.revision = owner.revision
      cached.tokenVersion = owner.tokenVersion
      cached.historyRef = owner.buffer.history.value
      cached.codeLength = owner.code.length
      cached.lineCount = owner.lines.length
    }
  }

  const getLineCanvasBucketSize = (targetWidth: number, targetHeight: number) => {
    return {
      width: quantizeLineCanvasDimension(targetWidth),
      height: quantizeLineCanvasDimension(targetHeight),
    }
  }

  const trimLineCanvasPool = () => {
    const maxPoolSize = Math.max(MIN_LINE_CANVAS_POOL_SIZE, lineCanvasBudget * 2)
    while (lineCanvasPoolCount > maxPoolSize) {
      const firstBucketEntry = lineCanvasPoolByBucket.entries().next().value as [string, LineCanvas[]] | undefined
      if (!firstBucketEntry) break
      const [key, bucket] = firstBucketEntry
      if (bucket.length === 0) {
        lineCanvasPoolByBucket.delete(key)
        continue
      }
      bucket.pop()
      lineCanvasPoolCount--
      syncLineCanvasPoolCount()
      if (bucket.length === 0) lineCanvasPoolByBucket.delete(key)
    }
  }

  const recycleLineCanvas = (lineCanvas: LineCanvas) => {
    lineCanvas.lineCacheKey = ''
    lineCanvas.braceAnalysisVersion = -1
    lineCanvas.braceRenderTokenVersion = -1
    lineCanvas.braceRenderTokenRef = null
    const bucketKey = makeLineCanvasBucketKey(lineCanvas.canvas.width, lineCanvas.canvas.height)
    const bucket = lineCanvasPoolByBucket.get(bucketKey)
    if (bucket) bucket.push(lineCanvas)
    else lineCanvasPoolByBucket.set(bucketKey, [lineCanvas])
    lineCanvasPoolCount++
    syncLineCanvasPoolCount()
    trimLineCanvasPool()
  }

  const trimLineCanvasesToBudget = () => {
    while (lineCanvasCacheByLine.size > lineCanvasBudget) {
      const oldestKey = lineCanvasUsageOrder.keys().next().value
      if (typeof oldestKey !== 'string') break
      lineCanvasUsageOrder.delete(oldestKey)

      const lineCanvas = lineCanvasCacheByLine.get(oldestKey)
      if (!lineCanvas) continue
      lineCanvasCacheByLine.delete(oldestKey)
      if (lineCanvas.lineCacheKey) {
        lineCanvasCache.delete(lineCanvas.lineCacheKey)
      }
      recycleLineCanvas(lineCanvas)
    }
  }

  const setLineCanvasBudget = (budget: number) => {
    const nextBudget = Math.max(32, Math.floor(budget))
    if (nextBudget === lineCanvasBudget) return
    lineCanvasBudget = nextBudget
    trimLineCanvasPool()
  }

  const markLineCanvasUsed = (segmentKey: string) => {
    if (lineCanvasUsageOrder.has(segmentKey)) {
      lineCanvasUsageOrder.delete(segmentKey)
    }
    lineCanvasUsageOrder.set(segmentKey, true)
  }

  const acquireLineCanvas = (targetWidth: number, targetHeight: number, dpr: number): LineCanvas => {
    const bucketSize = getLineCanvasBucketSize(targetWidth, targetHeight)
    const bucketKey = makeLineCanvasBucketKey(bucketSize.width, bucketSize.height)
    const bucket = lineCanvasPoolByBucket.get(bucketKey)
    const pooled = bucket?.pop()
    if (bucket && bucket.length === 0) lineCanvasPoolByBucket.delete(bucketKey)
    if (pooled) {
      lineCanvasPoolCount--
      syncLineCanvasPoolCount()
    }

    if (!pooled) {
      const canvas = new OffscreenCanvas(bucketSize.width, bucketSize.height)
      const c = canvas.getContext('2d')
      c.setTransform(dpr, 0, 0, dpr, 0, 0)
      return {
        lineCacheKey: '',
        braceAnalysisVersion: -1,
        braceRenderTokenVersion: -1,
        braceRenderTokenRef: null,
        canvas,
        c,
      }
    }

    const { canvas: pooledCanvas, c: pooledContext } = pooled
    const needsResize = pooledCanvas.width !== bucketSize.width || pooledCanvas.height !== bucketSize.height
    if (needsResize) {
      pooledCanvas.width = bucketSize.width
      pooledCanvas.height = bucketSize.height
      pooledContext.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    pooledContext.clearRect(0, 0, pooledCanvas.width / dpr, pooledCanvas.height / dpr)
    pooled.lineCacheKey = ''
    pooled.braceAnalysisVersion = -1
    pooled.braceRenderTokenVersion = -1
    pooled.braceRenderTokenRef = null
    return pooled
  }

  const clear = () => {
    measureTextCache.clear()
    clearVisualCaches()
  }

  const clearDrawCaches = () => {
    lineCanvasCache.clear()
    lineCanvasCacheByLine.clear()
    lineCanvasPoolByBucket.clear()
    lineCanvasPoolCount = 0
    syncLineCanvasPoolCount()
    lineCanvasUsageOrder.clear()
    matchingBraceCache.clear()
    getXFromColumnCache.clear()
    findVisualLineForColumnCache.clear()
  }

  const clearVisualCaches = () => {
    clearDrawCaches()
    wrapTokensCache.clear()
    wrapTokensCacheByTokenRef.clear()
    wrapTokensCacheByLine.clear()
  }

  const invalidateWrapTokensCacheForLine = (line: number) => {
    if (line < 0) return
    const tokenRef = doc.tokenLines[line]
    if (tokenRef) wrapTokensCacheByTokenRef.delete(tokenRef)

    const cacheKey = wrapTokensCacheByLine.get(line)
    if (cacheKey) {
      wrapTokensCache.delete(cacheKey)
      wrapTokensCacheByLine.delete(line)
    }
  }

  const adjustWrapTokensCacheOnLineInsert = (insertedAt: number) => {
    invalidateWrapTokensCacheForLine(insertedAt - 1)
  }

  const adjustWrapTokensCacheOnLineInsertRange = (startLine: number, _endLine: number) => {
    invalidateWrapTokensCacheForLine(startLine - 1)
  }

  const adjustWrapTokensCacheOnLineDelete = (deletedAt: number) => {
    invalidateWrapTokensCacheForLine(deletedAt)
    invalidateWrapTokensCacheForLine(deletedAt - 1)
  }

  const adjustWrapTokensCacheOnLineDeleteRange = (startLine: number, _endLine: number) => {
    invalidateWrapTokensCacheForLine(startLine)
    invalidateWrapTokensCacheForLine(startLine - 1)
  }

  effect(() => {
    doc.widgets
    canvas.dpr.value
    settings.lineHeight
    settings.fontSize
    settings.theme
    settings.wordWrap
    settings.autoHeight
    clear()
  })

  effect(() => {
    doc.buffer.code.value
    doc.tokenVersion
    doc.errors
    settings.wordWrap
    matchingBraceCache.clear()
    getXFromColumnCache.clear()
    findVisualLineForColumnCache.clear()
  })

  const dispose = () => {
    clear()
  }

  return {
    measureTextCache,
    get lineCanvasCache() {
      return lineCanvasCache
    },
    get lineCanvasCacheByLine() {
      return lineCanvasCacheByLine
    },
    acquireLineCanvas,
    getLineCanvasBucketSize,
    markLineCanvasUsed,
    setLineCanvasBudget,
    trimLineCanvasesToBudget,
    getLineCanvasSegmentKey,
    get wrapTokensCache() {
      return wrapTokensCache
    },
    get wrapTokensCacheByTokenRef() {
      return wrapTokensCacheByTokenRef
    },
    get wrapTokensCacheByLine() {
      return wrapTokensCacheByLine
    },
    get matchingBraceCache() {
      return matchingBraceCache
    },
    get getXFromColumnCache() {
      return getXFromColumnCache
    },
    get findVisualLineForColumnCache() {
      return findVisualLineForColumnCache
    },
    saveStateForDoc,
    restoreStateForDoc,
    adjustWrapTokensCacheOnLineInsert,
    adjustWrapTokensCacheOnLineInsertRange,
    adjustWrapTokensCacheOnLineDelete,
    adjustWrapTokensCacheOnLineDeleteRange,
    invalidateWrapTokensCacheForLine,
    clearDrawCaches,
    clearVisualCaches,
    clear,
    dispose,
  }
}
