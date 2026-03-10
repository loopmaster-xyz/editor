import type { Token, TokenType } from './token.ts'

export type MinimapThemePayload = {
  textColor: string | undefined
  byTokenType: Record<TokenType, string | undefined>
}

export type MinimapRenderChunkRequestMessage = {
  type: 'minimapRenderChunk'
  requestId: number
  contextId: number
  revision: number
  tokenVersion: number
  compressionKey: string
  contentKey: string
  chunkIndex: number
  chunkStartRow: number
  rowCount: number
  lineSpan: number
  columnCount: number
  rowScale: number
  lines: string[]
  tokenLines: Token[][]
  theme: MinimapThemePayload
}

export type MinimapRenderChunkResultMessage = {
  type: 'minimapRenderChunkResult'
  requestId: number
  contextId: number
  revision: number
  tokenVersion: number
  compressionKey: string
  contentKey: string
  chunkIndex: number
  chunkStartRow: number
  rowCount: number
  lineSpan: number
  columnCount: number
  rowScale: number
  hasInk: boolean
  bitmap: ImageBitmap
}

export type MinimapErrorMessage = {
  type: 'minimapError'
  requestId: number
  contextId: number
  error: string
}

export type MinimapWorkerRequestMessage = MinimapRenderChunkRequestMessage

export type MinimapWorkerResponseMessage =
  | MinimapRenderChunkResultMessage
  | MinimapErrorMessage
