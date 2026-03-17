import type { Token } from './token.ts'
import type { IncrementalTokenizerWorkerRequest, IncrementalTokenizerWorkerResponse } from './tokenizer.ts'

function tokenizeLine(line: string): Token[] {
  return [...line.matchAll(/\s+|.+/g)]
    .filter(x => x[0] !== '')
    .map(text => ({ text: text[0], type: 'text' as const }))
}

function annotateTokenLinePositions(tokens: Token[], lineIndex: number): Token[] {
  let column = 1
  const line = lineIndex + 1

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    token.line = line
    token.column = column
    column += token.text.length
  }

  return tokens
}

self.onmessage = (event: MessageEvent<IncrementalTokenizerWorkerRequest>) => {
  const message = event.data
  if (!message || message.type !== 'tokenizeChunk') return

  const states: unknown[] = new Array(message.lines.length).fill(null)
  const tokenLines = message.lines.map((line, lineIndex) =>
    annotateTokenLinePositions(tokenizeLine(line), message.startLine + lineIndex),
  )
  const response: IncrementalTokenizerWorkerResponse = {
    type: 'tokenizeChunkResult',
    jobId: message.jobId,
    revision: message.revision,
    startLine: message.startLine,
    tokenLines,
    states,
    processedEndLine: Math.max(message.startLine, message.startLine + message.lines.length - 1),
  }
  self.postMessage(response)
}
