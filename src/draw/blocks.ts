import type { Context } from '../context.ts'
import type { MatchingBrace } from '../blocks.ts'
import { findVisualLineForColumn, getXFromColumn } from '../line-utils.ts'

const OPACITY_HIGHLIGHT = 0.8
const OPACITY_NORMAL = 0.3
const LINE_WIDTH = 1
const OPTIMISTIC_BRACE_MARGIN_LINES = 80
const OPTIMISTIC_INPUT_WINDOW_MS = 180

interface OptimisticViewportSnapshot {
  depthByLine: Map<number, number>
  blockEndsByStart: Map<number, number>
  sortedStarts: number[]
  parentByStart: Map<number, number | null>
  matchingBrace: MatchingBrace | null
}

interface OptimisticSnapshotCacheEntry {
  docIdentity: unknown
  revision: number
  tokenVersion: number
  startLine: number
  endLine: number
  snapshot: OptimisticViewportSnapshot
}

const optimisticSnapshotCacheByContext = new WeakMap<Context, OptimisticSnapshotCacheEntry>()

export function invalidateBlockRenderState(context: Context) {
  optimisticSnapshotCacheByContext.delete(context)
}

function upperBound(sorted: number[], target: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (sorted[mid] <= target) low = mid + 1
    else high = mid
  }
  return low
}

function buildOptimisticViewportSnapshot(
  codeLines: string[],
  startLine: number,
  endLine: number,
): OptimisticViewportSnapshot {
  const scanStart = Math.max(0, Math.min(startLine, codeLines.length - 1))
  const scanEnd = Math.max(scanStart, Math.min(endLine, codeLines.length - 1))
  const depthByLine = new Map<number, number>()
  const blockEndsByStart = new Map<number, number>()
  const parentByStart = new Map<number, number | null>()
  const sortedStarts: number[] = []

  if (codeLines.length === 0 || scanStart > scanEnd) {
    return { depthByLine, blockEndsByStart, sortedStarts, parentByStart, matchingBrace: null }
  }

  const nonEmpty = new Uint8Array(scanEnd - scanStart + 1)
  const indentByLine = new Uint32Array(scanEnd - scanStart + 1)
  const nextNonEmpty = new Int32Array(scanEnd - scanStart + 1)
  nextNonEmpty.fill(-1)

  for (let line = scanStart; line <= scanEnd; line++) {
    const text = codeLines[line] ?? ''
    const localIndex = line - scanStart
    const indent = countIndent(text)
    if (indent < text.length) {
      nonEmpty[localIndex] = 1
      indentByLine[localIndex] = indent
    }
  }

  type StartCandidate = { startLine: number; indent: number; crossesIntoViewport: boolean }
  const startCandidates: StartCandidate[] = []

  const findCrossingEndInRange = (indent: number): number => {
    for (let line = scanStart; line <= scanEnd; line++) {
      const localIndex = line - scanStart
      if (nonEmpty[localIndex] === 0) continue
      if (indentByLine[localIndex] <= indent) return line - 1
    }
    return scanEnd
  }

  // Add parent blocks that start before the viewport range but continue into it.
  if (scanStart > 0) {
    let minIndentSeen = Number.POSITIVE_INFINITY
    let nextNonEmptyIndent = -1
    const crossing: StartCandidate[] = []
    for (let line = scanStart - 1; line >= 0; line--) {
      const text = codeLines[line] ?? ''
      const indent = countIndent(text)
      if (indent >= text.length) continue

      const isStart = nextNonEmptyIndent > indent
      const isOpenAtBoundary = indent < minIndentSeen
      if (isStart && isOpenAtBoundary) {
        crossing.push({ startLine: line, indent, crossesIntoViewport: true })
        if (indent === 0) break
      }

      if (indent < minIndentSeen) minIndentSeen = indent
      nextNonEmptyIndent = indent
    }
    crossing.reverse()
    for (let i = 0; i < crossing.length; i++) {
      const candidate = crossing[i]
      const endLine = findCrossingEndInRange(candidate.indent)
      if (endLine < scanStart) continue
      startCandidates.push(candidate)
      blockEndsByStart.set(candidate.startLine, endLine)
    }
  }

  let next = -1
  for (let line = scanEnd; line >= scanStart; line--) {
    const localIndex = line - scanStart
    nextNonEmpty[localIndex] = next
    if (nonEmpty[localIndex] === 1) next = line
  }

  const stack: Array<{ startLine: number; indent: number }> = []

  for (let line = scanStart; line <= scanEnd; line++) {
    const localIndex = line - scanStart
    if (nonEmpty[localIndex] === 0) continue
    const currentIndent = indentByLine[localIndex]

    while (stack.length > 0 && currentIndent <= stack[stack.length - 1].indent) {
      const block = stack.pop()!
      blockEndsByStart.set(block.startLine, line - 1)
    }

    const nextLine = nextNonEmpty[localIndex]
    if (nextLine < 0) continue
    const nextIndent = indentByLine[nextLine - scanStart]
    if (nextIndent > currentIndent) {
      startCandidates.push({ startLine: line, indent: currentIndent, crossesIntoViewport: false })
      stack.push({ startLine: line, indent: currentIndent })
    }
  }

  while (stack.length > 0) {
    const block = stack.pop()!
    blockEndsByStart.set(block.startLine, scanEnd)
  }

  startCandidates.sort((a, b) => a.startLine - b.startLine)
  const parentStack: Array<{ startLine: number; indent: number }> = []
  for (let i = 0; i < startCandidates.length; i++) {
    const candidate = startCandidates[i]
    const start = candidate.startLine
    const end = blockEndsByStart.get(start)
    if (end === undefined || end < start) continue

    while (parentStack.length > 0) {
      const parent = parentStack[parentStack.length - 1]
      const parentEnd = blockEndsByStart.get(parent.startLine)
      if (parentEnd === undefined || parentEnd < start || candidate.indent <= parent.indent) {
        parentStack.pop()
      }
      else {
        break
      }
    }

    const parent = parentStack.length > 0 ? parentStack[parentStack.length - 1].startLine : null
    parentByStart.set(start, parent)
    sortedStarts.push(start)
    depthByLine.set(start, parentStack.length)
    parentStack.push({ startLine: start, indent: candidate.indent })
  }

  return { depthByLine, blockEndsByStart, sortedStarts, parentByStart, matchingBrace: null }
}

function countIndent(line: string): number {
  let indent = 0
  while (indent < line.length) {
    const code = line.charCodeAt(indent)
    if (code !== 32 && code !== 9) break
    indent++
  }
  return indent
}

function resolveGuideIndent(codeLines: string[], startLine: number, endLine: number, startIndent: number): number {
  for (let line = startLine + 1; line <= endLine; line++) {
    const text = codeLines[line] ?? ''
    const indent = countIndent(text)
    if (indent >= text.length) continue
    if (indent < startIndent) return indent
    return startIndent
  }
  return startIndent
}

export function drawBlocks(context: Context) {
  const { canvas, doc, lines, blocks, settings, caches, scroll, header, caret } = context
  const { c } = canvas
  const visualLinesByLogicalLine = lines.visualLinesByLogicalLine.value
  const blockStarts = blocks.blockStarts.value
  const codeLines = doc.lines
  const tokenLines = doc.tokenLines
  const scrollY = scroll.pos.y
  const headerHeight = header.value?.height ?? 0
  const visibleTop = -headerHeight - settings.paddingTop
  const canvasHeight = canvas.size.height.value - settings.paddingTop
  const visibleVisualLines = lines.getVisibleVisualLines(visibleTop, canvasHeight, scrollY)
  const visibleLogicalLines = new Set<number>()
  const firstVisibleVisualByLogicalLine = new Map<number, (typeof visibleVisualLines)[number]>()
  const lastVisibleVisualByLogicalLine = new Map<number, (typeof visibleVisualLines)[number]>()
  for (let i = 0; i < visibleVisualLines.length; i++) {
    const visualLine = visibleVisualLines[i]
    const logicalLine = visualLine.logicalLine
    visibleLogicalLines.add(logicalLine)
    if (!firstVisibleVisualByLogicalLine.has(logicalLine)) {
      firstVisibleVisualByLogicalLine.set(logicalLine, visualLine)
    }
    lastVisibleVisualByLogicalLine.set(logicalLine, visualLine)
  }

  if (visibleLogicalLines.size === 0) {
    return
  }

  const visibleLinesArray = Array.from(visibleLogicalLines).sort((a, b) => a - b)
  const firstVisibleLogicalLine = visibleLinesArray[0]
  const lastVisibleLogicalLine = visibleLinesArray[visibleLinesArray.length - 1]
  const visibleContentTop = visibleTop - scrollY
  const visibleContentBottom = canvasHeight - scrollY

  let optimisticSnapshot: OptimisticViewportSnapshot | null = null
  const now = Date.now()
  const inputAgeMs = now - caret.lastInputTime.value
  const braceAnalysisCurrent = blocks.isBraceAnalysisCurrent()
  const shouldUseOptimistic = doc.keyHoldActive
    || !braceAnalysisCurrent
    || (caret.isTyping.value && inputAgeMs <= OPTIMISTIC_INPUT_WINDOW_MS)
  const shouldBuildOptimisticSnapshot = shouldUseOptimistic || braceAnalysisCurrent
  const shouldBypassOptimisticCache = doc.keyHoldActive
  if (shouldBuildOptimisticSnapshot) {
    const optimisticStartLine = Math.max(0, firstVisibleLogicalLine - OPTIMISTIC_BRACE_MARGIN_LINES)
    const optimisticEndLine = Math.min(codeLines.length - 1, lastVisibleLogicalLine + OPTIMISTIC_BRACE_MARGIN_LINES)
    if (optimisticStartLine <= optimisticEndLine) {
      const cachedOptimistic = optimisticSnapshotCacheByContext.get(context)
      if (
        !shouldBypassOptimisticCache
        && cachedOptimistic
        && cachedOptimistic.docIdentity === context.docIdentity
        && cachedOptimistic.revision === doc.revision
        && cachedOptimistic.tokenVersion === doc.tokenVersion
        && cachedOptimistic.startLine === optimisticStartLine
        && cachedOptimistic.endLine === optimisticEndLine
      ) {
        optimisticSnapshot = cachedOptimistic.snapshot
      }
      else {
        optimisticSnapshot = buildOptimisticViewportSnapshot(
          codeLines,
          optimisticStartLine,
          optimisticEndLine,
        )
        optimisticSnapshotCacheByContext.set(context, {
          docIdentity: context.docIdentity,
          revision: doc.revision,
          tokenVersion: doc.tokenVersion,
          startLine: optimisticStartLine,
          endLine: optimisticEndLine,
          snapshot: optimisticSnapshot,
        })
      }
    }
  }

  const optimisticDepthByLine = optimisticSnapshot?.depthByLine ?? null
  const optimisticBlockEndsByStart = optimisticSnapshot?.blockEndsByStart ?? null
  const optimisticSortedStarts = optimisticSnapshot?.sortedStarts ?? []
  const optimisticParentByStart = optimisticSnapshot?.parentByStart ?? null
  let useOptimisticTopology = shouldUseOptimistic && optimisticSnapshot !== null

  const matchingBrace = blocks.findMatchingBrace(caret.line.value, caret.column.value)
  const blockColors = settings.ui.blockColors
  const blockInfoCache = new Map<number,
    { endLine: number; depth: number | null; indent: number; guideIndent: number } | null>()
  let didDrawMatchingMultilineGuide = false

  function textBottom(line: (typeof visibleVisualLines)[number]) {
    return line.y + (line.widgets.below.length > 0 ? settings.lineHeight : line.height)
  }

  c.save()

  c.lineWidth = LINE_WIDTH
  c.lineCap = 'square'
  c.lineJoin = 'miter'

  if (matchingBrace && matchingBrace.line === matchingBrace.matchingLine) {
    let openColumn = 0
    for (let i = 0; i < matchingBrace.tokenIndex; i++) {
      openColumn += tokenLines[matchingBrace.line][i]?.text.length || 0
    }
    openColumn += matchingBrace.charIndex + 1

    let closeColumn = 0
    for (let i = 0; i < matchingBrace.matchingTokenIndex; i++) {
      closeColumn += tokenLines[matchingBrace.matchingLine][i]?.text.length || 0
    }
    closeColumn += matchingBrace.matchingCharIndex

    if (closeColumn !== openColumn) {
      const braceVisualLine = findVisualLineForColumn(lines, matchingBrace.line, openColumn, tokenLines, caches)
      if (braceVisualLine) {
        const openX = getXFromColumn(lines, braceVisualLine, openColumn, tokenLines, canvas, settings, caches)
        const closeX = getXFromColumn(lines, braceVisualLine, closeColumn, tokenLines, canvas, settings, caches)
        const braceY = textBottom(braceVisualLine)

        c.strokeStyle = blockColors[matchingBrace.depth % blockColors.length]
        c.globalAlpha = OPACITY_HIGHLIGHT
        c.beginPath()
        c.moveTo(openX, braceY)
        c.lineTo(closeX, braceY)
        c.stroke()
      }
    }
  }

  function getBlockInfo(
    startLine: number,
  ): { endLine: number; depth: number | null; indent: number; guideIndent: number } | null {
    if (startLine < 0 || startLine >= codeLines.length) return null

    if (blockInfoCache.has(startLine)) return blockInfoCache.get(startLine) ?? null

    const endLine = useOptimisticTopology
      ? optimisticBlockEndsByStart?.get(startLine)
      : blocks.blockEnds.value.get(startLine)
    if (endLine === undefined || endLine < startLine) {
      blockInfoCache.set(startLine, null)
      return null
    }

    const depth = useOptimisticTopology
      ? (optimisticDepthByLine?.get(startLine) ?? 0)
      : (blocks.getBraceDepthForLine(startLine) ?? 0)
    const startLineText = codeLines[startLine]
    const indent = countIndent(startLineText)
    const guideIndent = resolveGuideIndent(codeLines, startLine, endLine, indent)

    const info = { endLine, depth, indent, guideIndent }
    blockInfoCache.set(startLine, info)
    return info
  }

  const findOptimisticNearestBlockStartAtOrBefore = (line: number): number | null => {
    if (!optimisticBlockEndsByStart || optimisticSortedStarts.length === 0) return null
    const index = upperBound(optimisticSortedStarts, line) - 1
    if (index < 0) return null
    return optimisticSortedStarts[index]
  }

  const findOptimisticContainingBlockStart = (line: number): number | null => {
    if (!optimisticBlockEndsByStart || !optimisticParentByStart || optimisticSortedStarts.length === 0) return null
    const index = upperBound(optimisticSortedStarts, line) - 1
    if (index < 0) return null

    let current: number | null = optimisticSortedStarts[index]
    while (current !== null) {
      const endLine = optimisticBlockEndsByStart.get(current)
      if (endLine !== undefined && line <= endLine) return current
      current = optimisticParentByStart.get(current) ?? null
    }
    return null
  }

  const doesStableContainLine = (line: number, stableStart: number | null): boolean => {
    if (stableStart === null) return false
    const stableEnd = blocks.blockEnds.value.get(stableStart)
    return stableEnd !== undefined && line >= stableStart && line <= stableEnd
  }

  const getStableBlockChain = (line: number): number[] => {
    const chain: number[] = []
    let current = blocks.findContainingBlockStart(line)
    while (current !== null) {
      chain.push(current)
      current = blocks.getParentBlockStart(current)
    }
    return chain
  }

  const getOptimisticBlockChain = (line: number): number[] => {
    const chain: number[] = []
    if (!optimisticParentByStart) return chain
    let current = findOptimisticContainingBlockStart(line)
    while (current !== null) {
      chain.push(current)
      current = optimisticParentByStart.get(current) ?? null
    }
    return chain
  }

  if (!useOptimisticTopology && optimisticSnapshot) {
    const linesToValidate = [caret.line.value, ...visibleLinesArray]
    for (let i = 0; i < linesToValidate.length; i++) {
      const line = linesToValidate[i]
      const optimisticContainingBlock = findOptimisticContainingBlockStart(line)
      if (optimisticContainingBlock === null) continue

      const stableContainingBlock = blocks.findContainingBlockStart(line)
      if (!doesStableContainLine(line, stableContainingBlock)) {
        useOptimisticTopology = true
        break
      }

      const optimisticChain = getOptimisticBlockChain(line)
      const stableChain = getStableBlockChain(line)
      if (stableChain.length < optimisticChain.length) {
        // Only fall back when stable topology is missing inner levels.
        // Avoid broad mismatch-based fallback that can keep stale topology latched.
        useOptimisticTopology = true
        break
      }
    }
  }

  const blocksToDraw = new Set<number>()

  for (const logicalLine of visibleLogicalLines) {
    const containingBlock = useOptimisticTopology
      ? findOptimisticContainingBlockStart(logicalLine)
      : blocks.findContainingBlockStart(logicalLine)
    if (containingBlock !== null) {
      blocksToDraw.add(containingBlock)
    }
    else {
      const nearestBlock = useOptimisticTopology
        ? findOptimisticNearestBlockStartAtOrBefore(logicalLine)
        : blocks.findNearestBlockStartAtOrBefore(logicalLine)
      if (nearestBlock !== null) {
        blocksToDraw.add(nearestBlock)
      }
    }
  }

  const initialBlocks = Array.from(blocksToDraw)
  for (const startLine of initialBlocks) {
    let current = startLine
    while (true) {
      const currentInfo = getBlockInfo(current)
      if (!currentInfo || currentInfo.indent === 0) {
        break
      }

      let parent: number | null
      if (useOptimisticTopology) {
        parent = optimisticParentByStart?.get(current) ?? null
      }
      else {
        parent = blocks.getParentBlockStart(current)
      }
      if (parent === null) {
        break
      }

      if (!blocksToDraw.has(parent)) {
        blocksToDraw.add(parent)
      }

      current = parent
    }
  }

  const drawnBlocks = new Set<number>()

  function drawBlock(startLine: number) {
    if (drawnBlocks.has(startLine)) return
    if (useOptimisticTopology) {
      if (!(optimisticBlockEndsByStart?.has(startLine) ?? false)) return
    }
    else if (!blockStarts.has(startLine)) {
      return
    }
    drawnBlocks.add(startLine)

    const info = getBlockInfo(startLine)
    if (!info) return

    const { endLine, depth, guideIndent } = info
    const startVisualLine = firstVisibleVisualByLogicalLine.get(startLine)
      ?? (visualLinesByLogicalLine[startLine] ?? []).at(0)
    if (!startVisualLine) return
    const isCollapsed = blockStarts.has(startLine) && blocks.isCollapsed(startLine)
    const hasMatchingBrace = matchingBrace
      && (startLine === matchingBrace.line && endLine === matchingBrace.matchingLine - 1)

    if (isCollapsed && !hasMatchingBrace) return

    const startLineText = codeLines[startLine]
    const x = getXFromColumn(lines, startVisualLine, guideIndent, tokenLines, canvas, settings, caches) + 1
    const startY = startVisualLine.y + startVisualLine.height

    if (isCollapsed) {
      if (hasMatchingBrace && matchingBrace.line === startLine) {
        let braceColumn = 0
        for (let i = 0; i < matchingBrace.tokenIndex; i++) {
          braceColumn += tokenLines[matchingBrace.line][i]?.text.length || 0
        }
        braceColumn += matchingBrace.charIndex

        const braceVisualLine = findVisualLineForColumn(lines, matchingBrace.line, braceColumn, tokenLines, caches)
        if (braceVisualLine) {
          const braceX = getXFromColumn(lines, braceVisualLine, braceColumn, tokenLines, canvas, settings, caches)

          const startYCanvas = startY + scrollY
          if (startYCanvas < visibleTop || startYCanvas > canvasHeight) return

          c.strokeStyle = blockColors[matchingBrace.depth % blockColors.length]
          c.globalAlpha = OPACITY_HIGHLIGHT
          c.beginPath()
          c.moveTo(x, startY)
          c.lineTo(braceX, startY)
          c.stroke()
        }
      }
      return
    }

    const endVisualLine = lastVisibleVisualByLogicalLine.get(endLine)
      ?? (visualLinesByLogicalLine[endLine] ?? []).at(-1)
    if (!endVisualLine) return
    let endY = textBottom(endVisualLine)
    if (endY <= startY) {
      // Adjacent/open-empty-close blocks can resolve to zero-height ranges after reconciliation.
      // Keep the last structural guide visible with a minimal segment instead of dropping it.
      endY = startY + settings.lineHeight
    }

    const startYCanvas = startY + scrollY
    const endYCanvas = endY + scrollY
    if (endYCanvas < visibleTop || startYCanvas > canvasHeight) return
    let clampedStartY = Math.max(startY, visibleContentTop)
    let clampedEndY = Math.min(endY, visibleContentBottom)
    if (clampedEndY < clampedStartY) {
      const pinnedY = Math.max(visibleContentTop, Math.min(visibleContentBottom, clampedStartY))
      clampedStartY = pinnedY
      clampedEndY = pinnedY + Math.max(1, LINE_WIDTH)
    }

    if (hasMatchingBrace) {
      didDrawMatchingMultilineGuide = true
      c.strokeStyle = blockColors[matchingBrace.depth % blockColors.length]
      c.globalAlpha = OPACITY_HIGHLIGHT
    }
    else {
      c.strokeStyle = blockColors[depth % blockColors.length]
      c.globalAlpha = OPACITY_NORMAL
    }

    c.beginPath()
    c.moveTo(x, clampedEndY)
    c.lineTo(x, clampedStartY)

    if (hasMatchingBrace) {
      if (matchingBrace.line === startLine && clampedStartY === startY) {
        let braceColumn = 0
        for (let i = 0; i < matchingBrace.tokenIndex; i++) {
          braceColumn += tokenLines[matchingBrace.line][i]?.text.length || 0
        }
        braceColumn += matchingBrace.charIndex

        const braceVisualLine = findVisualLineForColumn(lines, matchingBrace.line, braceColumn, tokenLines, caches)
        if (braceVisualLine) {
          const braceX = getXFromColumn(lines, braceVisualLine, braceColumn, tokenLines, canvas, settings, caches)
          c.lineTo(braceX, startY)
        }
      }
    }

    c.stroke()
  }

  for (const startLine of blocksToDraw) {
    drawBlock(startLine)
  }

    if (matchingBrace && matchingBrace.line !== matchingBrace.matchingLine && !didDrawMatchingMultilineGuide) {
    const startLine = matchingBrace.line
    const startVisualLine = firstVisibleVisualByLogicalLine.get(startLine)
      ?? (visualLinesByLogicalLine[startLine] ?? []).at(0)
    if (startVisualLine) {
      const endLine = Math.max(startLine, matchingBrace.matchingLine - 1)
      const startIndent = countIndent(codeLines[startLine] ?? '')
      const guideIndent = resolveGuideIndent(codeLines, startLine, endLine, startIndent)
      const x = getXFromColumn(lines, startVisualLine, guideIndent, tokenLines, canvas, settings, caches) + 1
      const startY = startVisualLine.y + startVisualLine.height

      const fallbackEndLine = endLine
      const fallbackEndVisualLine = lastVisibleVisualByLogicalLine.get(fallbackEndLine)
        ?? (visualLinesByLogicalLine[fallbackEndLine] ?? []).at(-1)
      const endY = fallbackEndVisualLine
        ? textBottom(fallbackEndVisualLine)
        : startY

      const startYCanvas = startY + scrollY
      const endYCanvas = endY + scrollY
      if (!(endYCanvas < visibleTop || startYCanvas > canvasHeight)) {
        const clampedStartY = Math.max(startY, visibleContentTop)
        const clampedEndY = Math.min(endY, visibleContentBottom)
        if (clampedEndY >= clampedStartY || Math.abs(clampedEndY - clampedStartY) <= 1) {
          const guideStartY = clampedEndY >= clampedStartY
            ? clampedStartY
            : Math.max(visibleContentTop, Math.min(visibleContentBottom, clampedStartY))
          const guideEndY = clampedEndY >= clampedStartY
            ? clampedEndY
            : guideStartY + Math.max(1, LINE_WIDTH)
          let braceColumn = 0
          for (let i = 0; i < matchingBrace.tokenIndex; i++) {
            braceColumn += tokenLines[matchingBrace.line][i]?.text.length || 0
          }
          braceColumn += matchingBrace.charIndex

          const braceVisualLine = findVisualLineForColumn(lines, matchingBrace.line, braceColumn, tokenLines, caches)
          c.strokeStyle = blockColors[matchingBrace.depth % blockColors.length]
          c.globalAlpha = OPACITY_HIGHLIGHT
          c.beginPath()
          c.moveTo(x, guideEndY)
          c.lineTo(x, guideStartY)
          if (braceVisualLine && guideStartY === startY) {
            const braceX = getXFromColumn(lines, braceVisualLine, braceColumn, tokenLines, canvas, settings, caches)
            c.lineTo(braceX, startY)
          }
          c.stroke()
        }
      }
    }
  }

  c.restore()
}
