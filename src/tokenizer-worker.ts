import type { Token } from './token.ts'

type TokenizeChunkRequest = {
  type: 'tokenizeChunk'
  jobId: number
  revision: number
  startLine: number
  lines: string[]
}

type TokenizeChunkResponse = {
  type: 'tokenizeChunkResult'
  jobId: number
  revision: number
  startLine: number
  tokenLines: Token[][]
}

function tokenizeLine(line: string): Token[] {
  return [...line.matchAll(/\s+|.+/g)]
    .filter(x => x[0] !== '')
    .map(text => ({ text: text[0], type: 'text' as const }))
}

self.onmessage = (event: MessageEvent<TokenizeChunkRequest>) => {
  const message = event.data
  if (!message || message.type !== 'tokenizeChunk') return

  const tokenLines = message.lines.map(tokenizeLine)
  const response: TokenizeChunkResponse = {
    type: 'tokenizeChunkResult',
    jobId: message.jobId,
    revision: message.revision,
    startLine: message.startLine,
    tokenLines,
  }
  self.postMessage(response)
}
