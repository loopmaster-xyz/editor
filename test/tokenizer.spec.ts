import { describe, expect, it } from 'bun:test'
import {
  defaultIncrementalTokenizer,
  tokenizeAll,
  tokenizeIncremental,
} from '../src/tokenizer.ts'

describe('tokenizeIncremental identity preservation', () => {
  it('keeps token line references when a processed line is unchanged', () => {
    const lines = ['alpha', 'beta', 'gamma', 'delta']
    const initial = tokenizeAll(defaultIncrementalTokenizer, lines)

    const result = tokenizeIncremental(
      defaultIncrementalTokenizer,
      lines,
      initial.tokenLines,
      initial.states,
      0,
      lines.length,
      Number.POSITIVE_INFINITY,
    )

    for (let i = 0; i < lines.length; i++) {
      expect(result.tokenLines[i]).toBe(initial.tokenLines[i])
      expect(result.states[i]).toBe(initial.states[i])
    }
  })

  it('preserves shifted tail references after top insertion once convergence is reached', () => {
    const beforeLines = ['first', 'second', 'third', 'fourth']
    const before = tokenizeAll(defaultIncrementalTokenizer, beforeLines)

    const afterLines = ['', 'first', 'second', 'third', 'fourth']
    const alignedTokenLines = before.tokenLines.slice()
    const alignedStates = before.states.slice()
    alignedTokenLines.splice(1, 0, [])
    alignedStates.splice(1, 0, undefined)

    const result = tokenizeIncremental(
      defaultIncrementalTokenizer,
      afterLines,
      alignedTokenLines,
      alignedStates,
      0,
      2,
      Number.POSITIVE_INFINITY,
    )

    expect(result.tokenLines[3]).toBe(alignedTokenLines[3])
    expect(result.tokenLines[4]).toBe(alignedTokenLines[4])
    expect(result.converged).toBeTrue()
  })
})
