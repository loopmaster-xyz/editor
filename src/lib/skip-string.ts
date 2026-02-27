interface SkipStringOptions {
  levels?: number
  bias?: number
  chunkSize?: number
}

interface SearchResult {
  node: Node
  steps: Node[]
  width: number[]
  offset: number
}

class Node {
  value: string | null
  level: number
  width: number[]
  next: (Node | null)[]

  constructor(value: string | null, level: number) {
    this.value = value
    this.level = level
    this.width = new Array(this.level).fill(value && value.length || 0)
    this.next = new Array(this.level).fill(null)
  }

  get length(): number {
    return this.width[0]
  }
}

export class SkipString {
  private levels: number
  private bias: number
  private head: Node
  private chunkSize: number

  constructor(o: SkipStringOptions = {}) {
    this.levels = o.levels || 11
    this.bias = o.bias || 1 / Math.E
    this.head = new Node(null, this.levels)
    this.chunkSize = o.chunkSize || 5000
  }

  get length(): number {
    return this.head.width[this.levels - 1]
  }

  get(offset: number): SearchResult {
    return this.search(offset, true)
  }

  set(text: string): void {
    if (this.length > 0) {
      this.remove([0, this.length])
    }
    this.insertChunked(0, text)
  }

  search(offset: number, incl?: boolean): SearchResult {
    const inclValue = incl ? 0.1 : 0

    const steps = new Array<Node>(this.levels)
    const width = new Array<number>(this.levels)

    let i = this.levels
    let node = this.head

    while (i--) {
      while (offset + inclValue > node.width[i] && node.next[i] !== null) {
        offset -= node.width[i]
        node = node.next[i]!
      }
      steps[i] = node
      width[i] = offset
    }

    return {
      node,
      steps,
      width,
      offset,
    }
  }

  splice(s: SearchResult, offset: number, value: string, level?: number): Node {
    const steps = s.steps
    const width = s.width

    let p: Node
    let q: Node
    let len: number

    level = level || this.randomLevel()
    q = new Node(value, level)
    len = q.width[0]

    let i: number

    i = level
    while (i--) {
      p = steps[i]
      q.next[i] = p.next[i]
      p.next[i] = q
      q.width[i] = p.width[i] - width[i] + len
      p.width[i] = width[i]
    }

    i = this.levels
    while (i-- > level) {
      p = steps[i]
      p.width[i] += len
    }

    return q
  }

  insert(offset: number, value: string, level?: number): Node {
    const s = this.search(offset)

    if (s.offset && s.node.value && s.offset < s.node.value.length) {
      this.update(s, insert(s.offset, s.node.value, value))
      return s.node
    }

    return this.splice(s, offset, value, level)
  }

  update(s: SearchResult, value: string): number {
    const length = (s.node.value?.length || 0) - value.length

    s.node.value = value

    let i = this.levels

    while (i--) {
      s.steps[i].width[i] -= length
    }

    return length
  }

  remove(range: [number, number]): void {
    if (range[1] > this.length) {
      throw new Error(
        `range end over maximum length(${this.length}): [${range.join()}]`
      )
    }

    let x = range[1] - range[0]

    const s = this.search(range[0])
    let offset = s.offset
    const steps = s.steps
    let node = s.node

    if (this.head === node) node = node.next[0]!
    if (!node) return

    if (offset) {
      if (offset < node.width[0]) {
        x -= this.update(s,
          node.value!.slice(0, offset) +
          node.value!.slice(
            offset +
            Math.min(x, node.length - offset)
          )
        )
      }

      node = node.next[0]!
      if (!node) return
    }

    while (node && x >= node.width[0]) {
      x -= this.removeNode(steps, node)
      node = node.next[0]!
    }

    if (x && node) {
      this.replace(steps, node, node.value!.slice(x))
    }
  }

  removeNode(steps: Node[], node: Node): number {
    const length = node.width[0]

    let i = node.level
    while (i--) {
      steps[i].width[i] -= length - node.width[i]
      steps[i].next[i] = node.next[i]
    }

    i = this.levels
    while (i-- > node.level) {
      steps[i].width[i] -= length
    }

    return length
  }

  replace(steps: Node[], node: Node, value: string): number {
    const length = (node.value?.length || 0) - value.length

    node.value = value

    let i = node.level
    while (i--) {
      node.width[i] -= length
    }

    i = this.levels
    while (i-- > node.level) {
      steps[i].width[i] -= length
    }

    return length
  }

  removeCharAt(offset: number): void {
    this.remove([offset, offset + 1])
  }

  insertChunked(offset: number, text: string): void {
    let currentOffset = offset
    for (let i = 0; i < text.length; i += this.chunkSize) {
      const chunk = text.slice(i, i + this.chunkSize)
      this.insert(currentOffset, chunk)
      currentOffset += chunk.length
    }
  }

  substring(a: number, b: number): string {
    const length = b - a

    const search = this.search(a, true)
    let node = search.node
    if (this.head === node) node = node.next[0]!
    if (!node) return ''
    let d = length + search.offset
    let s = ''
    while (node && d >= 0) {
      d -= node.width[0]
      s += node.value
      node = node.next[0]!
    }
    if (node) {
      s += node.value
    }

    return s.slice(search.offset, search.offset + length)
  }

  randomLevel(): number {
    let level = 1
    while (level < this.levels - 1 && Math.random() < this.bias) level++
    return level
  }

  getRange(range: [number, number]): string {
    return this.substring(range[0], range[1])
  }

  copy(): SkipString {
    const copy = new SkipString()
    let node = this.head
    let offset = 0
    while (node = node.next[0]!) {
      copy.insert(offset, node.value!)
      offset += node.width[0]
    }
    return copy
  }

  joinString(delimiter: string): string {
    const parts: string[] = []
    let node = this.head
    while (node = node.next[0]!) {
      parts.push(node.value!)
    }
    return parts.join(delimiter)
  }

  toString(): string {
    return this.substring(0, this.length)
  }
}

function insert(offset: number, string: string, part: string): string {
  return string.slice(0, offset) + part + string.slice(offset)
}
