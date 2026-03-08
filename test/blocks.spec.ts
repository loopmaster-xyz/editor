import { describe, expect, it } from 'bun:test'
import { createBlocks, type MatchingBrace } from '../src/blocks.ts'
import type { Caches } from '../src/caches.ts'
import { createDoc } from '../src/doc.ts'
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
})
