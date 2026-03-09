import { describe, expect, it } from 'bun:test'
import { FenwickTree } from '../src/lib/fenwick.ts'

describe('FenwickTree', () => {
  it('builds from values and returns prefix sums', () => {
    const tree = FenwickTree.from([3, 1, 4, 1, 5])
    expect(tree.sum(-1)).toBe(0)
    expect(tree.sum(0)).toBe(3)
    expect(tree.sum(1)).toBe(4)
    expect(tree.sum(2)).toBe(8)
    expect(tree.sum(4)).toBe(14)
    expect(tree.total()).toBe(14)
  })

  it('supports point updates', () => {
    const tree = FenwickTree.from([10, 0, 0, 0])
    tree.add(1, 7)
    tree.add(0, -3)
    tree.add(3, 2)

    expect(tree.sum(0)).toBe(7)
    expect(tree.sum(1)).toBe(14)
    expect(tree.sum(2)).toBe(14)
    expect(tree.sum(3)).toBe(16)
    expect(tree.total()).toBe(16)
  })
})
