export class FenwickTree {
  private readonly tree: number[]

  constructor(size: number) {
    const n = Math.max(0, size | 0)
    this.tree = new Array(n + 1).fill(0)
  }

  static from(values: number[]): FenwickTree {
    const n = values.length
    const fenwick = new FenwickTree(n)
    const tree = fenwick.tree

    // O(n) Fenwick build: write leaves, then propagate to parents once.
    for (let i = 1; i <= n; i++) {
      tree[i] = values[i - 1] ?? 0
    }
    for (let i = 1; i <= n; i++) {
      const parent = i + (i & -i)
      if (parent <= n) tree[parent] += tree[i]
    }

    return fenwick
  }

  get size(): number {
    return this.tree.length - 1
  }

  add(index: number, delta: number) {
    if (delta === 0) return
    let i = (index | 0) + 1
    if (i <= 0) i = 1
    for (; i < this.tree.length; i += i & -i) {
      this.tree[i] += delta
    }
  }

  sum(index: number): number {
    let i = (index | 0) + 1
    if (i <= 0) return 0
    if (i >= this.tree.length) i = this.tree.length - 1
    let result = 0
    for (; i > 0; i -= i & -i) {
      result += this.tree[i]
    }
    return result
  }

  total(): number {
    return this.sum(this.size - 1)
  }

  /** Smallest index i such that prefix sum up to i is > target. */
  lowerBound(target: number): number {
    const n = this.size
    if (n <= 0) return 0
    if (target <= 0) return 0

    let idx = 0
    let bit = 1
    while ((bit << 1) <= n) bit <<= 1

    let acc = 0
    for (; bit > 0; bit >>= 1) {
      const next = idx + bit
      if (next <= n && acc + this.tree[next] <= target) {
        idx = next
        acc += this.tree[next]
      }
    }

    if (idx >= n) return n - 1
    return idx
  }
}
