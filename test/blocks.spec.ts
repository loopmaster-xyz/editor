import { describe, expect, it } from 'bun:test'
import { createBlocks, type MatchingBrace } from '../src/blocks.ts'
import type { Caches } from '../src/caches.ts'
import { createDoc } from '../src/doc.ts'
import { tokenizer as incrementalTokenizer } from '../examples/tokenizer.ts'
import type { Token } from '../src/token.ts'

function simpleTokenize(code: string): Token[][] {
  return code.split('\n').map(line => (line.length > 0 ? [{ type: 'text', text: line }] : []))
}

function createBlocksForCode(code: string) {
  const doc = createDoc(simpleTokenize)
  doc.buffer.code.value = code

  const caches = {
    matchingBraceCache: new Map<string, MatchingBrace | null>(),
  } as unknown as Caches

  return createBlocks(doc, caches)
}

function createBlocksContextForCode(code: string) {
  const doc = createDoc(simpleTokenize)
  doc.buffer.code.value = code
  const caches = {
    matchingBraceCache: new Map<string, MatchingBrace | null>(),
  } as unknown as Caches
  const blocks = createBlocks(doc, caches)
  return { doc, blocks }
}

describe('block navigation index', () => {
  it('finds deepest containing block in nested structures', () => {
    const blocks = createBlocksForCode([
      'root',
      '  child',
      '    leaf',
      '  sibling',
      'tail',
    ].join('\n'))

    expect(blocks.findContainingBlockStart(2)).toBe(1)
    expect(blocks.findContainingBlockStart(3)).toBe(0)
    expect(blocks.findContainingBlockStart(4)).toBeNull()
  })

  it('walks up parent links when nearest block does not contain the line', () => {
    const blocks = createBlocksForCode([
      'root',
      '  branch',
      '    leaf',
      '  after-branch',
      'tail',
    ].join('\n'))

    expect(blocks.findContainingBlockStart(3)).toBe(0)
  })

  it('finds nearest block start at or before a line', () => {
    const blocks = createBlocksForCode([
      'root',
      '  child',
      '    leaf',
      '  sibling',
      'tail',
    ].join('\n'))

    expect(blocks.findNearestBlockStartAtOrBefore(4)).toBe(1)
    expect(blocks.findNearestBlockStartAtOrBefore(0)).toBe(0)
    expect(blocks.findNearestBlockStartAtOrBefore(-1)).toBeNull()
    expect(blocks.findNearestBlockStartAtOrBefore(5)).toBeNull()
  })

  it('builds parent chains that terminate at indent level 0', () => {
    const blocks = createBlocksForCode([
      'root',
      '  level1',
      '    level2',
      '      level3',
      '        leaf',
      'out',
    ].join('\n'))

    expect(blocks.getParentBlockStart(3)).toBe(2)
    expect(blocks.getParentBlockStart(2)).toBe(1)
    expect(blocks.getParentBlockStart(1)).toBe(0)
    expect(blocks.getParentBlockStart(0)).toBeNull()
  })

  it('handles edge cases for empty docs and single top-level blocks', () => {
    const empty = createBlocksForCode('')
    expect(empty.findContainingBlockStart(0)).toBeNull()
    expect(empty.findNearestBlockStartAtOrBefore(0)).toBeNull()
    expect(empty.getParentBlockStart(0)).toBeNull()

    const single = createBlocksForCode([
      'top',
      '  child',
      'after',
    ].join('\n'))
    expect(single.findContainingBlockStart(1)).toBe(0)
    expect(single.findNearestBlockStartAtOrBefore(2)).toBe(0)
    expect(single.getParentBlockStart(0)).toBeNull()
  })

  it('detects blocks when a blank line follows the block header', () => {
    const blocks = createBlocksForCode([
      'function foo() {',
      '',
      '  const x = 1',
      '}',
    ].join('\n'))

    expect(blocks.findContainingBlockStart(2)).toBe(0)
    expect(blocks.findNearestBlockStartAtOrBefore(2)).toBe(0)
  })

  it('detects multiline brace blocks even without indentation increase', () => {
    const blocks = createBlocksForCode([
      'if (flag) {',
      'doWork()',
      '}',
    ].join('\n'))

    expect(blocks.findContainingBlockStart(1)).toBe(0)
    expect(blocks.findNearestBlockStartAtOrBefore(1)).toBe(0)
  })
})

describe('matching brace lookup index', () => {
  it('returns innermost pair for nested same-line braces', () => {
    const blocks = createBlocksForCode('x(a(b))')
    const match = blocks.findMatchingBrace(0, 4)
    expect(match).not.toBeNull()
    expect(match?.line).toBe(0)
    expect(match?.charIndex).toBe(3)
    expect(match?.matchingLine).toBe(0)
    expect(match?.matchingCharIndex).toBe(5)
  })

  it('matches when cursor touches brace boundaries', () => {
    const blocks = createBlocksForCode('x(a(b))')
    const match = blocks.findMatchingBrace(0, 6)
    expect(match).not.toBeNull()
    expect(match?.line).toBe(0)
    expect(match?.charIndex).toBe(3)
    expect(match?.matchingLine).toBe(0)
    expect(match?.matchingCharIndex).toBe(5)
  })

  it('matches multiline outer and inner brace pairs', () => {
    const blocks = createBlocksForCode([
      'if (x) {',
      '  foo(bar)',
      '}',
    ].join('\n'))

    const inner = blocks.findMatchingBrace(1, 7)
    expect(inner).not.toBeNull()
    expect(inner?.line).toBe(1)
    expect(inner?.charIndex).toBe(5)
    expect(inner?.matchingLine).toBe(1)
    expect(inner?.matchingCharIndex).toBe(9)

    const outer = blocks.findMatchingBrace(1, 0)
    expect(outer).not.toBeNull()
    expect(outer?.line).toBe(0)
    expect(outer?.charIndex).toBe(7)
    expect(outer?.matchingLine).toBe(2)
    expect(outer?.matchingCharIndex).toBe(0)
  })

  it('returns null when cursor is outside all brace ranges', () => {
    const blocks = createBlocksForCode('abc')
    expect(blocks.findMatchingBrace(0, 1)).toBeNull()
  })

  it('returns null when cursor is before first brace on line', () => {
    const code = "import { calculateAboveHeightForLine } from './widget.ts'"
    const blocks = createBlocksForCode(code)
    const match = blocks.findMatchingBrace(0, 0)
    expect(match).toBeNull()
  })

  it('highlights when touching indent-0 closing root brace boundary', () => {
    const blocks = createBlocksForCode([
      'function x() {',
      '  return 1',
      '}  ',
    ].join('\n'))

    expect(blocks.findMatchingBrace(2, 1)).not.toBeNull()
  })

  it('returns null when caret is beyond indent-0 closing root brace boundary', () => {
    const blocks = createBlocksForCode([
      'function x() {',
      '  return 1',
      '}  ',
    ].join('\n'))

    expect(blocks.findMatchingBrace(2, 2)).toBeNull()
  })

  it('returns null after indent-0 closing root brace in stale-analysis mode', () => {
    const { doc, blocks } = createBlocksContextForCode([
      'function x() {',
      '  return 1',
      '}  ',
    ].join('\n'))

    doc.tokenVersion += 1
    expect(blocks.findMatchingBrace(2, 2)).toBeNull()
  })

  it('does not match braces on other lines when cursor column overflows line length', () => {
    const blocks = createBlocksForCode([
      'short',
      'function x() {',
      '}',
    ].join('\n'))

    expect(blocks.findMatchingBrace(0, 200)).toBeNull()
  })

  it('returns same-line match while tokenization is pending', () => {
    const code = 'export function drawBlocks(context: Context) {'
    const { doc, blocks } = createBlocksContextForCode(code)
    const cursorColumn = code.indexOf('(') + 1

    doc.tokenizationPending = true

    const match = blocks.findMatchingBrace(0, cursorColumn)
    expect(match).not.toBeNull()
    expect(match?.line).toBe(0)
    expect(match?.matchingLine).toBe(0)
    expect(match?.charIndex).toBe(code.indexOf('('))
    expect(match?.matchingCharIndex).toBe(code.indexOf(')'))
  })

  it('does not keep stale null after brace analysis catches up', () => {
    const code = 'export function drawBlocks(context: Context) {'
    const { doc, blocks } = createBlocksContextForCode(code)
    const cursorColumn = code.indexOf('(') + 1

    doc.tokenizationPending = true
    expect(blocks.findMatchingBrace(0, cursorColumn)).not.toBeNull()

    // Simulate stale pending tokenization for one lookup.
    doc.tokenizationPending = false
    const initial = blocks.findMatchingBrace(0, cursorColumn)
    expect(initial).not.toBeNull()

    // A second lookup at same position should remain resolvable (not poisoned by stale null cache).
    const second = blocks.findMatchingBrace(0, cursorColumn)
    expect(second).not.toBeNull()
  })

  it('keeps multiline brace match after backspace-merging a newline while stale analysis is pending', () => {
    const lines = [
      'export function drawBlocks(context: Context) {',
      '  return context',
      '}',
    ]
    const { doc, blocks } = createBlocksContextForCode(lines.join('\n'))
    const openColumn = lines[0].indexOf('{')

    const initial = blocks.findMatchingBrace(0, openColumn + 1)
    expect(initial).not.toBeNull()
    expect(initial?.line).toBe(0)
    expect(initial?.matchingLine).toBe(2)

    // Backspace at start of line 1 merges it into line 0 and shifts closing brace line up.
    doc.buffer.backspace(1, 0)
    expect(blocks.getBraceAnalysisVersion()).not.toBe(doc.tokenVersion)

    const afterMerge = blocks.findMatchingBrace(0, openColumn + 1)
    expect(afterMerge).not.toBeNull()
    expect(afterMerge?.line).toBe(0)
    expect(afterMerge?.matchingLine).toBe(1)
  })

  it('keeps brace depth for opening { after deleting a preceding newline with incremental tokenizer', () => {
    const doc = createDoc(incrementalTokenizer)
    const caches = {
      matchingBraceCache: new Map<string, MatchingBrace | null>(),
    } as unknown as Caches
    const blocks = createBlocks(doc, caches)

    doc.buffer.code.value = [
      '',
      'export function drawBlocks(context: Context) {',
      '  return context',
      '}',
    ].join('\n')

    const findBrace = (line: number) => {
      const tokens = doc.tokenLines[line] ?? []
      for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
        const text = tokens[tokenIndex]?.text ?? ''
        for (let charIndex = 0; charIndex < text.length; charIndex++) {
          if (text[charIndex] === '{') {
            return { tokenIndex, charIndex }
          }
        }
      }
      return null
    }

    const before = findBrace(1)
    expect(before).not.toBeNull()
    expect(blocks.getBraceDepthForPosition(1, before!.tokenIndex, before!.charIndex)).toBe(0)

    // Delete newline between line 0 (blank) and line 1 (export...), moving export to line 0.
    doc.buffer.backspace(1, 0)
    expect(blocks.getBraceAnalysisVersion()).not.toBe(doc.tokenVersion)

    const after = findBrace(0)
    expect(after).not.toBeNull()
    expect(blocks.getBraceDepthForPosition(0, after!.tokenIndex, after!.charIndex)).toBe(0)
  })

  it('keeps brace depth for opening { after inserting a newline at the start of the same line', () => {
    const doc = createDoc(incrementalTokenizer)
    const caches = {
      matchingBraceCache: new Map<string, MatchingBrace | null>(),
    } as unknown as Caches
    const blocks = createBlocks(doc, caches)

    doc.buffer.code.value = [
      'export function drawBlocks(context: Context) {',
      '  return context',
      '}',
    ].join('\n')

    const findBrace = (line: number) => {
      const tokens = doc.tokenLines[line] ?? []
      for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
        const text = tokens[tokenIndex]?.text ?? ''
        for (let charIndex = 0; charIndex < text.length; charIndex++) {
          if (text[charIndex] === '{') {
            return { tokenIndex, charIndex }
          }
        }
      }
      return null
    }

    const before = findBrace(0)
    expect(before).not.toBeNull()
    expect(blocks.getBraceDepthForPosition(0, before!.tokenIndex, before!.charIndex)).toBe(0)

    // Insert newline at column 0 of the brace line.
    doc.buffer.insert(0, 0, '\n')
    expect(blocks.getBraceAnalysisVersion()).not.toBe(doc.tokenVersion)

    const after = findBrace(1)
    expect(after).not.toBeNull()
    expect(blocks.getBraceDepthForPosition(1, after!.tokenIndex, after!.charIndex)).toBe(0)
  })
})
