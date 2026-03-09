import type { Context } from '../context.ts'
import { getCharOffsetForVisualLine, getXFromColumn } from '../line-utils.ts'
import { measureText } from '../measure.ts'
import { calculateAboveHeightForLine } from './widget.ts'

export function drawSelection(context: Context) {
  const { canvas, doc, lines, selection, settings, scroll, caches, header } = context
  const { c } = canvas

  if (!selection.hasSelection.value) return
  const ordered = selection.getOrdered.value
  if (!ordered) return

  const codeLines = doc.lines
  const tokenLines = doc.tokenLines
  const scrollY = scroll.pos.y
  const headerHeight = header.value?.height ?? 0
  const visibleTop = -headerHeight - settings.paddingTop
  const visibleBottom = canvas.size.height.value - settings.paddingTop
  const visibleLeft = -settings.paddingLeft

  const startLine = ordered.start.line
  const endLine = ordered.end.line
  const startColumn = ordered.start.column
  const endColumn = ordered.end.column

  const newlineIndicatorWidth = measureText(c, settings, caches, { type: 'text', text: ' ' }).width / 2

  const baseX = visibleLeft - scroll.pos.x
  const baseY = visibleTop - scroll.pos.y

  const temp = selection.getOffscreenCanvas(canvas.size.width.value, canvas.size.height.value, canvas.dpr.value)
  const tempCanvas = temp.canvas
  const tempC = temp.c

  tempC.clearRect(0, 0, tempCanvas.width, tempCanvas.height)
  tempC.fillStyle = settings.colors.blue + 'dd'
  tempC.beginPath()

  let prevEmpty = false
  for (let logicalLine = startLine; logicalLine <= endLine; logicalLine++) {
    if (logicalLine < 0 || logicalLine >= codeLines.length) continue

    const visualLines = lines.visualLinesByLogicalLine.value[logicalLine] ?? []
    if (!visualLines.length) continue

    let prevVisualBottom: number | null = null
    let lastIndex: number | null = null
    let firstHeight: number | null = null
    let prevVisualEndX: number | null = null
    let prevVisualStartX: number | null = null
    let prevVisualWidth: number | null = null

    for (let i = 0; i < visualLines.length; i++) {
      const isFirst = i === 0
      if (isFirst) {
        prevVisualEndX = null
        prevVisualStartX = null
        prevVisualWidth = null
      }
      const v = visualLines[i]
      const y = v.y
      const h = v.height
      const yScroll = y + scrollY
      if (yScroll + h < visibleTop) continue
      const aboveHeight = calculateAboveHeightForLine(context, v)
      if (yScroll > visibleBottom + aboveHeight) break

      const isStartLine = logicalLine === startLine
      const isEndLine = logicalLine === endLine
      const lineLen = codeLines[logicalLine]?.length || 0

      const vStartCol = getCharOffsetForVisualLine(logicalLine, v, tokenLines, lines)
      let vEndCol = vStartCol
      for (const token of v.tokens) {
        vEndCol += token.token.text.length
      }

      const selStart = isStartLine ? startColumn : 0
      const selEnd = isEndLine ? endColumn : lineLen

      const colStart = Math.max(selStart, vStartCol)
      const colEnd = Math.min(selEnd, vEndCol)

      const isEmptyVisual = colStart >= colEnd && logicalLine < endLine
      if (!isEmptyVisual && colStart >= colEnd) {
        prevVisualEndX = null
        prevVisualStartX = null
        prevVisualWidth = null
        prevEmpty = false
        continue
      }

      let startX: number
      let endX: number

      if (isEmptyVisual) {
        startX = getXFromColumn(lines, v, vEndCol, tokenLines, canvas, settings, caches)
        endX = startX + newlineIndicatorWidth
      }
      else {
        startX = getXFromColumn(lines, v, colStart, tokenLines, canvas, settings, caches)
        endX = getXFromColumn(lines, v, colEnd, tokenLines, canvas, settings, caches)
        if (logicalLine < endLine) endX += newlineIndicatorWidth / 2
      }

      const widthRaw = Math.abs(endX - startX)
      const x = Math.min(startX, endX)
      const ox = x - baseX
      const oy = y - baseY

      let oyInt: number
      let hInt: number

      const consecutive = lastIndex !== null && i === lastIndex + 1

      if (isFirst || !consecutive || prevVisualBottom === null) {
        oyInt = oy
        hInt = h
        if (isFirst) firstHeight = hInt
      }
      else {
        oyInt = prevVisualBottom
        hInt = h
      }

      prevVisualBottom = oyInt + hInt

      const width = widthRaw
      if (width <= 0 || hInt <= 0) {
        prevVisualEndX = null
        prevVisualStartX = null
        prevVisualWidth = null
        continue
      }

      lastIndex = i

      let radius = 3
      const eps = 0.5
      const isLast = i === visualLines.length - 1
      const hasAbove = logicalLine > startLine
      const hasBelow = logicalLine < endLine

      let tl = false
      let tr = false
      let bl = false
      let br = false
      let drawTopLine = false

      let prevWidth: number | null = null
      let nextWidth: number | null = null
      let prevStartX: number | null = null
      let nextStartX: number | null = null

      if (consecutive && prevVisualEndX !== null && prevVisualStartX !== null && prevVisualWidth !== null) {
        const prevEndX = prevVisualEndX
        prevStartX = prevVisualStartX
        prevWidth = prevVisualWidth

        if (prevEndX > endX + eps) {
          tr = true
        }
        if (prevStartX < startX - eps) {
          tl = true
        }
      }

      prevVisualEndX = endX
      prevVisualStartX = startX
      prevVisualWidth = widthRaw

      let nextIsEmpty = false
      if (!isLast) {
        const nv = visualLines[i + 1]
        const nvStartCol = getCharOffsetForVisualLine(logicalLine, nv, tokenLines, lines)
        let nvEndCol = nvStartCol
        for (const token of nv.tokens) {
          nvEndCol += token.token.text.length
        }

        const nvSelStart = isStartLine ? startColumn : 0
        const nvSelEnd = isEndLine ? endColumn : lineLen
        const nvColStart = Math.max(nvSelStart, nvStartCol)
        const nvColEnd = Math.min(nvSelEnd, nvEndCol)

        const nvIsEmptyVisual = nvColStart >= nvColEnd && logicalLine < endLine
        nextIsEmpty = nvIsEmptyVisual
        const nvIsSelected = nvColStart < nvColEnd || nvIsEmptyVisual

        if (nvIsSelected) {
          let nvStartX: number
          let nvEndX: number

          if (nvIsEmptyVisual) {
            nvStartX = getXFromColumn(lines, nv, nvEndCol, tokenLines, canvas, settings, caches)
            nvEndX = nvStartX + newlineIndicatorWidth
          }
          else {
            nvStartX = getXFromColumn(lines, nv, nvColStart, tokenLines, canvas, settings, caches)
            nvEndX = getXFromColumn(lines, nv, nvColEnd, tokenLines, canvas, settings, caches)
            if (logicalLine < endLine) nvEndX += newlineIndicatorWidth / 2
          }

          nextStartX = nvStartX
          nextWidth = Math.abs(nvEndX - nvStartX)

          if (nvEndX > endX + eps) br = true
          if (nvStartX < startX - eps) bl = true
        }
      }

      if (hasAbove && isFirst) {
        const pl = logicalLine - 1
        const pv = lines.visualLinesByLogicalLine.value[pl] ?? []
        if (pv.length) {
          const lv = pv[pv.length - 1]
          const ps = getCharOffsetForVisualLine(pl, lv, tokenLines, lines)
          let pe = ps
          for (const token of lv.tokens) {
            pe += token.token.text.length
          }

          const s0 = pl === startLine ? startColumn : 0
          const e0 = pl < endLine ? (codeLines[pl]?.length || 0) : endColumn
          const cs = Math.max(s0, ps)
          const ce = Math.min(e0, pe)

          let psx = getXFromColumn(lines, lv, cs, tokenLines, canvas, settings, caches)
          let pex = getXFromColumn(lines, lv, ce, tokenLines, canvas, settings, caches)
          if (pl < endLine) pex += newlineIndicatorWidth / 2

          if (prevStartX === null || prevWidth === null) {
            prevStartX = psx
            prevWidth = Math.abs(pex - psx)
          }

          if (pex > endX + eps) tr = true
          if (psx < startX - eps) tl = true
          if (psx > endX + eps) drawTopLine = true
        }
      }

      if (hasBelow && isLast) {
        const nl = logicalLine + 1
        const nv = lines.visualLinesByLogicalLine.value[nl] ?? []
        if (nv.length) {
          const fv = nv[0]
          const ns = getCharOffsetForVisualLine(nl, fv, tokenLines, lines)
          let ne = ns
          for (const token of fv.tokens) {
            ne += token.token.text.length
          }

          const s0 = nl === startLine ? startColumn : 0
          const e0 = nl === endLine ? endColumn : (codeLines[nl]?.length || 0)
          const cs = Math.max(s0, ns)
          const ce = Math.min(e0, ne)

          if ((codeLines[nl]?.length || 0) === 0 && nl < endLine) nextIsEmpty = true

          let nsx = getXFromColumn(lines, fv, cs, tokenLines, canvas, settings, caches)
          let nex = getXFromColumn(lines, fv, ce, tokenLines, canvas, settings, caches)
          if (nl < endLine) nex += newlineIndicatorWidth / 2

          if (nextStartX === null || nextWidth === null) {
            nextStartX = nsx
            nextWidth = Math.abs(nex - nsx)
          }

          if (nex > endX + eps) br = true
          if (nsx < startX - eps) bl = true
        }
      }

      const straightTop = isEmptyVisual && prevEmpty
      const straightBottom = isEmptyVisual && nextIsEmpty
      const startsAtVisualStart = colStart === vStartCol
      let roundTL = !startsAtVisualStart && !tl
      let roundBL = !startsAtVisualStart && !bl

      const widerThanNL = widthRaw > newlineIndicatorWidth
      const moreVisuals = !isLast
      let roundTR = !tr && (hasBelow || moreVisuals || widerThanNL)
      let roundBR = !br && (hasBelow || moreVisuals || widerThanNL)
      if (straightTop) {
        roundTL = false
        roundTR = false
      }
      if (straightBottom) {
        roundBL = false
        roundBR = false
      }

      tempC.moveTo(roundTL ? ox + radius : ox, oyInt)

      if (roundTR) {
        tempC.lineTo(ox + width - radius, oyInt)
        tempC.arcTo(ox + width, oyInt, ox + width, oyInt + radius, radius)
      }
      else {
        tempC.lineTo(ox + width, oyInt)
      }

      if (roundBR) {
        tempC.lineTo(ox + width, oyInt + hInt - radius)
        tempC.arcTo(ox + width, oyInt + hInt, ox + width - radius, oyInt + hInt, radius)
      }
      else {
        tempC.lineTo(ox + width, oyInt + hInt)
      }

      if (roundBL) {
        tempC.lineTo(ox + radius, oyInt + hInt)
        tempC.arcTo(ox, oyInt + hInt, ox, oyInt + hInt - radius, radius)
      }
      else {
        tempC.lineTo(ox, oyInt + hInt)
      }

      if (roundTL) {
        tempC.lineTo(ox, oyInt + radius)
        tempC.arcTo(ox, oyInt, ox + radius, oyInt, radius)
      }
      else {
        tempC.lineTo(ox, oyInt)
      }

      tempC.closePath()

      radius = 2.75

      if (!straightTop && tr && prevWidth !== null) {
        const extra = Math.max(newlineIndicatorWidth, prevWidth - widthRaw)
        const b = Math.min(radius, Math.max(0, extra))
        if (b > 0) {
          tempC.moveTo(ox + width, oyInt)
          tempC.lineTo(ox + width + b, oyInt)
          tempC.quadraticCurveTo(ox + width + b * 0.6, oyInt + radius * 0.5, ox + width, oyInt + radius)
          tempC.closePath()
        }
      }

      if (!straightBottom && br && nextWidth !== null) {
        const extra = nextWidth - widthRaw
        const b = Math.min(radius, Math.max(0, extra))
        if (b > 0) {
          tempC.moveTo(ox + width, oyInt + hInt)
          tempC.lineTo(ox + width + b, oyInt + hInt)
          tempC.quadraticCurveTo(ox + width + b * 0.6, oyInt + hInt - radius * 0.5, ox + width, oyInt + hInt - radius)
          tempC.closePath()
        }
      }

      if (tl && prevStartX !== null) {
        const extra = startX - prevStartX
        const b = Math.min(radius, Math.max(0, extra))
        if (b > 0) {
          tempC.moveTo(ox, oyInt)
          tempC.lineTo(ox - b, oyInt)
          tempC.quadraticCurveTo(ox - b * 0.6, oyInt + radius * 0.5, ox, oyInt + radius)
          tempC.closePath()
        }
      }

      if (!straightBottom && bl && nextStartX !== null) {
        const extra = startX - nextStartX
        const b = Math.min(radius, Math.max(0, extra))
        if (b > 0) {
          tempC.moveTo(ox, oyInt + hInt)
          tempC.lineTo(ox - b, oyInt + hInt)
          tempC.quadraticCurveTo(ox - b * 0.6, oyInt + hInt - radius * 0.5, ox, oyInt + hInt - radius)
          tempC.closePath()
        }
      }

      if (drawTopLine && prevStartX !== null) {
        const ex = endX - baseX
        const psx = prevStartX - baseX
        const t = 0.75
        tempC.moveTo(ex, oyInt)
        tempC.lineTo(psx, oyInt)
        tempC.lineTo(psx, oyInt + t)
        tempC.lineTo(ex, oyInt + t)
        tempC.closePath()
      }

      prevEmpty = isEmptyVisual
    }
  }

  tempC.fill()

  c.globalAlpha = 0.3
  c.drawImage(tempCanvas, baseX, baseY, canvas.size.width.value, canvas.size.height.value)
  c.globalAlpha = 1
}
