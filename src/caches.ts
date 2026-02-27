import { effect } from '@preact/signals-core'
import type { MatchingBrace } from './blocks.ts'
import type { Canvas } from './canvas.ts'
import type { Context } from './context.ts'
import type { Doc, DocError } from './doc.ts'
import type { VisualLine, VisualToken } from './lines.ts'
import type { Settings } from './settings.ts'
import type { Token } from './token.ts'
import type { Widget } from './widget.ts'

export interface LineCanvas {
  lineCacheKey: string
  c: OffscreenCanvasRenderingContext2D
  canvas: OffscreenCanvas
}

function getTokenCacheKey(token: Token): string {
  return `${token.type}${token.text}`
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
  tokens: Token[],
  logicalLine: number,
  maxWidth: number,
  lineWidgets: Widget[],
  lineErrors: DocError[],
  settings: Settings,
): string {
  let tokensKey = ''
  for (let i = 0; i < tokens.length; i++) tokensKey += getTokenCacheKey(tokens[i])
  let widgetsKey = ''
  for (let i = 0; i < lineWidgets.length; i++) widgetsKey += getWidgetCacheKey(lineWidgets[i])
  let errorsKey = ''
  for (let i = 0; i < lineErrors.length; i++) errorsKey += getErrorCacheKey(lineErrors[i])
  return [
    tokensKey,
    logicalLine,
    maxWidth,
    widgetsKey,
    errorsKey,
    settings.lineHeight,
    settings.fontSize,
  ].join(WRAP_TOKENS_CACHE_KEY_DELIMITER)
}

const WRAP_TOKENS_CACHE_KEY_DELIMITER = '|||'

function parseCacheKeyLineNumber(key: string): number | null {
  const delimiterIndex = key.indexOf(WRAP_TOKENS_CACHE_KEY_DELIMITER)
  if (delimiterIndex === -1) return null

  const afterDelimiter = key.slice(delimiterIndex + WRAP_TOKENS_CACHE_KEY_DELIMITER.length)
  const nextDelimiterIndex = afterDelimiter.indexOf(WRAP_TOKENS_CACHE_KEY_DELIMITER)
  if (nextDelimiterIndex === -1) return null

  const lineNumStr = afterDelimiter.slice(0, nextDelimiterIndex)
  const lineNum = Number.parseInt(lineNumStr, 10)
  if (!Number.isNaN(lineNum)) {
    return lineNum
  }
  return null
}

function updateCacheKeyLineNumber(key: string, newLineNumber: number): string {
  const delimiterIndex = key.indexOf(WRAP_TOKENS_CACHE_KEY_DELIMITER)
  if (delimiterIndex === -1) return key

  const before = key.slice(0, delimiterIndex + WRAP_TOKENS_CACHE_KEY_DELIMITER.length)
  const afterDelimiter = key.slice(delimiterIndex + WRAP_TOKENS_CACHE_KEY_DELIMITER.length)
  const nextDelimiterIndex = afterDelimiter.indexOf(WRAP_TOKENS_CACHE_KEY_DELIMITER)
  if (nextDelimiterIndex === -1) return key

  const after = afterDelimiter.slice(nextDelimiterIndex)
  return `${before}${newLineNumber}${after}`
}

export function getLineCacheKey(context: Context, visualTokens: VisualToken[]) {
  return visualTokens.map(vt => getTokenCacheKey(vt.token)).join('')
    + `${context.canvas.ligatureDpr.value}${context.settings.lineHeight}${context.settings.fontSize}`
}

export type Caches = ReturnType<typeof createCaches>

export function createCaches(canvas: Canvas, settings: Settings, doc: Doc) {
  const measureTextCache = new Map<string, { width: number; height: number; fontHeight: number }>()
  const lineCanvasCache = new Map<string, LineCanvas>()
  const lineCanvasCacheByLine = new Map<number, LineCanvas>()
  const wrapTokensCache = new Map<string, VisualLine[]>()
  const wrapTokensCacheByLine = new Map<number, string>()
  const matchingBraceCache = new Map<string, MatchingBrace | null>()
  const getXFromColumnCache = new Map<string, number>()
  const findVisualLineForColumnCache = new Map<string, VisualLine | null>()
  const blockInfoCache = new Map<number, { endLine: number; depth: number | null; indent: number }>()

  const clear = () => {
    measureTextCache.clear()
    lineCanvasCache.clear()
    lineCanvasCacheByLine.clear()
    wrapTokensCache.clear()
    wrapTokensCacheByLine.clear()
    matchingBraceCache.clear()
    getXFromColumnCache.clear()
    findVisualLineForColumnCache.clear()
    blockInfoCache.clear()
  }

  const adjustWrapTokensCacheOnLineInsert = (insertedAt: number) => {
    const splitLineKey = wrapTokensCacheByLine.get(insertedAt - 1)
    if (splitLineKey) {
      wrapTokensCache.delete(splitLineKey)
      wrapTokensCacheByLine.delete(insertedAt - 1)
    }

    const lineNums = Array.from(wrapTokensCacheByLine.keys()).filter(lineNum => lineNum >= insertedAt)

    for (const lineNum of lineNums) {
      const key = wrapTokensCacheByLine.get(lineNum)
      if (key) {
        wrapTokensCache.delete(key)
        wrapTokensCacheByLine.delete(lineNum)
      }
    }
  }

  const adjustWrapTokensCacheOnLineInsertRange = (startLine: number, endLine: number) => {
    const insertedCount = endLine - startLine + 1

    const splitLineKey = wrapTokensCacheByLine.get(startLine - 1)
    if (splitLineKey) {
      wrapTokensCache.delete(splitLineKey)
      wrapTokensCacheByLine.delete(startLine - 1)
    }

    const lineNums = Array.from(wrapTokensCacheByLine.keys()).filter(lineNum => lineNum >= startLine)

    for (const lineNum of lineNums) {
      const key = wrapTokensCacheByLine.get(lineNum)
      if (key) {
        wrapTokensCache.delete(key)
        wrapTokensCacheByLine.delete(lineNum)
      }
    }
  }

  const adjustWrapTokensCacheOnLineDelete = (deletedAt: number) => {
    const deletedKey = wrapTokensCacheByLine.get(deletedAt)
    if (deletedKey) {
      wrapTokensCache.delete(deletedKey)
      wrapTokensCacheByLine.delete(deletedAt)
    }

    const prevLineKey = wrapTokensCacheByLine.get(deletedAt - 1)
    if (prevLineKey) {
      wrapTokensCache.delete(prevLineKey)
      wrapTokensCacheByLine.delete(deletedAt - 1)
    }

    const keysToUpdate: Array<[string, string, number, VisualLine[]]> = []

    for (const [lineNum, key] of wrapTokensCacheByLine.entries()) {
      if (lineNum > deletedAt) {
        const value = wrapTokensCache.get(key)
        if (value) {
          const lineNumInKey = parseCacheKeyLineNumber(key)
          if (lineNumInKey !== null && lineNumInKey === lineNum) {
            const parts = key.split(WRAP_TOKENS_CACHE_KEY_DELIMITER)
            const widgetsPart = parts.length > 3 ? parts[3] : ''
            const errorsPart = parts.length > 4 ? parts[4] : ''
            const hasWidgetsOrErrors = widgetsPart !== '' || errorsPart !== ''

            if (!hasWidgetsOrErrors) {
              const newKey = updateCacheKeyLineNumber(key, lineNum - 1)
              const updatedValue = value.map(line => ({ ...line, logicalLine: line.logicalLine - 1 }))
              keysToUpdate.push([key, newKey, lineNum, updatedValue])
            }
            else {
              wrapTokensCache.delete(key)
              wrapTokensCacheByLine.delete(lineNum)
            }
          }
        }
      }
    }

    for (const [oldKey, newKey, oldLineNum, updatedValue] of keysToUpdate) {
      wrapTokensCache.set(newKey, updatedValue)
      wrapTokensCache.delete(oldKey)
      wrapTokensCacheByLine.delete(oldLineNum)
      wrapTokensCacheByLine.set(oldLineNum - 1, newKey)
    }
  }

  const adjustWrapTokensCacheOnLineDeleteRange = (startLine: number, endLine: number) => {
    const deletedCount = endLine - startLine

    for (let i = startLine; i <= endLine; i++) {
      const deletedKey = wrapTokensCacheByLine.get(i)
      if (deletedKey) {
        wrapTokensCache.delete(deletedKey)
        wrapTokensCacheByLine.delete(i)
      }
    }

    const prevLineKey = wrapTokensCacheByLine.get(startLine - 1)
    if (prevLineKey) {
      wrapTokensCache.delete(prevLineKey)
      wrapTokensCacheByLine.delete(startLine - 1)
    }

    const keysToUpdate: Array<[string, string, number, VisualLine[]]> = []

    for (const [lineNum, key] of wrapTokensCacheByLine.entries()) {
      if (lineNum > endLine) {
        const value = wrapTokensCache.get(key)
        if (value) {
          const lineNumInKey = parseCacheKeyLineNumber(key)
          if (lineNumInKey !== null && lineNumInKey === lineNum) {
            const parts = key.split(WRAP_TOKENS_CACHE_KEY_DELIMITER)
            const widgetsPart = parts.length > 3 ? parts[3] : ''
            const errorsPart = parts.length > 4 ? parts[4] : ''
            const hasWidgetsOrErrors = widgetsPart !== '' || errorsPart !== ''

            if (!hasWidgetsOrErrors) {
              const newKey = updateCacheKeyLineNumber(key, lineNum - deletedCount)
              const updatedValue = value.map(line => ({ ...line, logicalLine: line.logicalLine - deletedCount }))
              keysToUpdate.push([key, newKey, lineNum, updatedValue])
            }
            else {
              wrapTokensCache.delete(key)
              wrapTokensCacheByLine.delete(lineNum)
            }
          }
        }
      }
    }

    for (const [oldKey, newKey, oldLineNum, updatedValue] of keysToUpdate) {
      wrapTokensCache.set(newKey, updatedValue)
      wrapTokensCache.delete(oldKey)
      wrapTokensCacheByLine.delete(oldLineNum)
      wrapTokensCacheByLine.set(oldLineNum - deletedCount, newKey)
    }
  }

  const invalidateWrapTokensCacheForLine = (line: number) => {
    const cacheKey = wrapTokensCacheByLine.get(line)
    if (cacheKey) {
      wrapTokensCache.delete(cacheKey)
      wrapTokensCacheByLine.delete(line)
    }
  }

  effect(() => {
    doc.widgets
    canvas.dpr.value
    canvas.size.width.value
    canvas.size.height.value
    settings.lineHeight
    settings.fontSize
    settings.theme
    settings.wordWrap
    settings.autoHeight
    clear()
  })

  effect(() => {
    doc.buffer.code.value
    doc.errors
    settings.wordWrap
    matchingBraceCache.clear()
    getXFromColumnCache.clear()
    findVisualLineForColumnCache.clear()
    blockInfoCache.clear()
  })

  const dispose = () => {
    clear()
  }

  return {
    measureTextCache,
    lineCanvasCache,
    lineCanvasCacheByLine,
    wrapTokensCache,
    wrapTokensCacheByLine,
    matchingBraceCache,
    getXFromColumnCache,
    findVisualLineForColumnCache,
    blockInfoCache,
    adjustWrapTokensCacheOnLineInsert,
    adjustWrapTokensCacheOnLineInsertRange,
    adjustWrapTokensCacheOnLineDelete,
    adjustWrapTokensCacheOnLineDeleteRange,
    invalidateWrapTokensCacheForLine,
    clear,
    dispose,
  }
}
