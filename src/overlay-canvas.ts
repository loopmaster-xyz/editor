import { batch, computed, effect, type Signal, signal } from '@preact/signals-core'

let overlayCanvasInstance: OverlayCanvas | null = null

export interface OverlayCanvas {
  el: HTMLCanvasElement
  size: { width: Signal<number>; height: Signal<number> }
  rect: DOMRect
  c: CanvasRenderingContext2D
  dpr: Signal<number>
  ligatureDpr: Signal<number>
  clear: () => void
  dispose: () => void
}

export function createOverlayCanvas(): OverlayCanvas {
  if (overlayCanvasInstance) {
    return overlayCanvasInstance
  }

  const el = document.createElement('canvas')
  el.style.position = 'fixed'
  el.style.top = '0'
  el.style.left = '0'
  el.style.width = '100dvw'
  el.style.height = '100dvh'
  el.style.pointerEvents = 'none'
  el.style.zIndex = '9999'
  document.body.appendChild(el)

  const width = signal(window.innerWidth)
  const height = signal(window.innerHeight)
  const size = { width, height }
  const c = el.getContext('2d')
  const dpr = signal(window.devicePixelRatio)
  const ligatureDpr = computed(() => dpr.value * 1.5)

  const clear = () => {
    c.clearRect(0, 0, width.value, height.value)
  }

  effect(() => {
    el.width = width.value * dpr.value
    el.height = height.value * dpr.value
    c.scale(dpr.value, dpr.value)
    clear()
  })

  const handleResize = () => {
    batch(() => {
      width.value = window.innerWidth
      height.value = window.innerHeight
      dpr.value = window.devicePixelRatio
    })
  }

  window.addEventListener('resize', handleResize)

  const dispose = () => {
    window.removeEventListener('resize', handleResize)
    el.remove()
    overlayCanvasInstance = null
  }

  overlayCanvasInstance = {
    el,
    size,
    get rect() {
      return el.getBoundingClientRect()
    },
    c,
    dpr,
    ligatureDpr,
    clear,
    dispose,
  }

  return overlayCanvasInstance
}
