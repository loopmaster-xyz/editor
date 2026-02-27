import { batch } from '@preact/signals-core'
import { createDoc, createEditor, draw } from '../src/editor.ts'
import type { Settings } from '../src/settings.ts'
import { tokenize } from './tokenizer.ts'

const editorSettings: Partial<Settings> = {
  wordWrap: false,
  autoHeight: true,
  colors: {
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#e6db74',
    blue: '#66d9ef',
    purple: '#ae81ff',
    cyan: '#38ccd1',
    white: '#f8f8f2',
    gray: '#75715e',
    brightBlack: '#666666',
    brightRed: '#fd5ff1',
    brightGreen: '#a1efe4',
    brightYellow: '#ffd866',
    brightBlue: '#66d9ef',
    brightPurple: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5',
  },
  syntax: c => ({
    keyword: { color: c.blue, style: 'italic', weight: 'regular' },
    function: { color: c.green, style: 'normal', weight: 'regular' },
    identifier: { color: c.white, style: 'normal', weight: 'regular' },
    string: { color: c.yellow, style: 'normal', weight: 'regular' },
    number: { color: c.cyan, style: 'normal', weight: 'regular' },
    boolean: { color: c.red, style: 'normal', weight: 'regular' },
    null: { color: c.blue, style: 'normal', weight: 'regular' },
    operator: { color: c.red, style: 'normal', weight: 'regular' },
    punctuation: { color: c.gray, style: 'normal', weight: 'regular' },
    comment: { color: c.gray, style: 'normal', weight: 'regular' },
    text: { color: c.white, style: 'normal', weight: 'regular' },
  }),
}

const canvas = document.createElement('canvas')
const width = window.visualViewport?.width ?? window.innerWidth
const height = window.visualViewport?.height ?? window.innerHeight
const dpr = window.devicePixelRatio
canvas.width = width * dpr
canvas.height = height * dpr
canvas.style.width = `${width}px`
canvas.style.height = `${height}px`
// canvas.style.imageRendering = 'pixelated'
canvas.style.position = 'fixed'
canvas.style.top = '0'
canvas.style.left = '0'
canvas.style.zIndex = '9999'
document.body.appendChild(canvas)

const c = canvas.getContext('2d')
if (!c) {
  throw new Error('Failed to get context')
}

c.fillStyle = '#222'
c.fillRect(0, 0, canvas.width, canvas.height)

let scale = 1
let targetScale = 1
let translateX = 0
let translateY = 0
let targetTranslateX = 0
let targetTranslateY = 0
let velocityX = 0
let velocityY = 0
let accelerationX = 0
let accelerationY = 0
const minScale = 0.05
const maxScale = 1
const zoomFactor = 0.001
const PAN_SMOOTH = 0.4
const PAN_SMOOTH_THRESHOLD = 0.1
const ZOOM_SMOOTH_THRESHOLD = 0.0001
const FRICTION = 0.65
const MIN_VELOCITY = 0.01
const MIN_ACCELERATION = 0.01

canvas.addEventListener('wheel', (e: WheelEvent) => {
  e.preventDefault()
  if (e.ctrlKey) {
    const rect = canvas.getBoundingClientRect()
    const mouseX = ((e.clientX - rect.left) / rect.width) * canvas.width
    const mouseY = ((e.clientY - rect.top) / rect.height) * canvas.height
    const delta = -e.deltaY
    const factor = 1 + delta * zoomFactor
    const newScale = Math.min(maxScale, Math.max(minScale, scale * factor))
    const ratio = newScale / scale
    targetScale = newScale
    targetTranslateX = mouseX * (1 - ratio) + translateX * ratio
    targetTranslateY = mouseY * (1 - ratio) + translateY * ratio
  }
  else {
    const { deltaX, deltaY } = e
    const dominantX = Math.abs(deltaX) > Math.abs(deltaY)
    if (dominantX) {
      accelerationX -= deltaX === Math.floor(deltaX) ? deltaX / 5 : deltaX / 30
    }
    else {
      accelerationY -= deltaY === Math.floor(deltaY) ? deltaY / 40 : deltaY / 30
    }
  }
}, { passive: false })

const gridCols = 2
const gridRows = 2
const cellWidth = 400
const cellHeight = 300

const editors: ReturnType<typeof createEditor>[][] = []
const docs: ReturnType<typeof createDoc>[][] = []
for (let row = 0; row < gridRows; row++) {
  editors[row] = []
  docs[row] = []
  for (let col = 0; col < gridCols; col++) {
    const ed = createEditor(editorSettings)
    const doc = createDoc(tokenize)
    doc.code = `// cell ${row},${col}\n${createDoc.toString()}`
    ed.setDoc(doc)
    batch(() => {
      ed.size.width.value = cellWidth
      ed.size.height.value = cellHeight
      ed.settings.rect = new DOMRect(col * cellWidth, row * cellHeight, cellWidth, cellHeight)
    })
    editors[row][col] = ed
    docs[row][col] = doc
  }
}

const updatePan = () => {
  const scaleDiff = targetScale - scale
  scale += scaleDiff * PAN_SMOOTH
  if (Math.abs(scaleDiff) < ZOOM_SMOOTH_THRESHOLD) scale = targetScale
  if (Math.abs(accelerationX) > MIN_ACCELERATION || Math.abs(accelerationY) > MIN_ACCELERATION) {
    const torqueX = Math.pow(Math.abs(accelerationX), 1.5) * Math.sign(accelerationX)
    const torqueY = Math.pow(Math.abs(accelerationY), 1.5) * Math.sign(accelerationY)
    velocityX += torqueX
    velocityY += torqueY
    accelerationX *= FRICTION
    accelerationY *= FRICTION
    if (Math.abs(accelerationX) < MIN_ACCELERATION) accelerationX = 0
    if (Math.abs(accelerationY) < MIN_ACCELERATION) accelerationY = 0
  }
  if (Math.abs(velocityX) > MIN_VELOCITY || Math.abs(velocityY) > MIN_VELOCITY) {
    targetTranslateX += velocityX
    targetTranslateY += velocityY
    velocityX *= FRICTION
    velocityY *= FRICTION
    if (Math.abs(velocityX) < MIN_VELOCITY) velocityX = 0
    if (Math.abs(velocityY) < MIN_VELOCITY) velocityY = 0
  }
  const dx = targetTranslateX - translateX
  const dy = targetTranslateY - translateY
  translateX += dx * PAN_SMOOTH
  translateY += dy * PAN_SMOOTH
  if (Math.abs(dx) < PAN_SMOOTH_THRESHOLD && Math.abs(dy) < PAN_SMOOTH_THRESHOLD) {
    translateX = targetTranslateX
    translateY = targetTranslateY
  }
}

const tick = () => {
  updatePan()
  const cellW = cellWidth * dpr
  const cellH = cellHeight * dpr
  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      const ed = editors[row][col]
      ed.settings.rect = new DOMRect(
        (translateX + col * cellW * scale) / dpr,
        (translateY + row * cellH * scale) / dpr,
        cellWidth * scale,
        cellHeight * scale,
      )
    }
  }
  draw()
  c.fillStyle = '#222'
  c.fillRect(0, 0, canvas.width, canvas.height)
  c.save()
  c.translate(translateX, translateY)
  c.scale(scale, scale)
  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      c.drawImage(editors[row][col].canvas, col * cellW, row * cellH)
    }
  }
  c.restore()
  requestAnimationFrame(tick)
}
tick()
