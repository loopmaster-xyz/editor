import { batch, computed, effect, signal, untracked } from '@preact/signals-core'
import { draw } from './render-manager.ts'
import type { Settings } from './settings.ts'

export type Canvas = ReturnType<typeof createCanvas>

export function createCanvas(settings: Settings) {
  const el = document.createElement('canvas')
  el.height = 20
  el.style.display = 'block'
  const width = signal(0)
  const height = signal(0)
  const size = { width, height }
  const c = el.getContext('2d')
  const dpr = signal(window.devicePixelRatio)
  const ligatureDpr = computed(() => dpr.value * 1.5)

  const clear = () => {
    c.clearRect(0, 0, width.value, height.value)
    c.fillStyle = settings.ui.background
    c.fillRect(0, 0, width.value, height.value)
  }

  effect(() => {
    if (!width.value || !height.value) return
    el.width = width.value * dpr.value
    el.height = height.value * dpr.value
    c.scale(dpr.value, dpr.value)
    if (settings.autoHeight) {
      el.style.height = `${height.value}px`
    }
    clear()
    untracked(draw)
  })

  const handleResize = () => {
    if (!el.parentElement) return
    const rect = el.parentElement.getBoundingClientRect()
    batch(() => {
      width.value = rect.width
      if (!settings.autoHeight) {
        height.value = rect.height
      }
      dpr.value = window.devicePixelRatio
    })
    el.style.width = `${rect.width}px`
    if (!settings.autoHeight) {
      el.style.height = `${rect.height}px`
    }
  }

  let resizeObserver: ResizeObserver | null = null
  let mutationObserver: MutationObserver | null = null

  const initialize = () => {
    if (resizeObserver || !el.parentElement) return
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(el.parentElement)
    window.addEventListener('resize', handleResize)
    handleResize()
    if (mutationObserver) {
      mutationObserver.disconnect()
      mutationObserver = null
    }
  }

  mutationObserver = new MutationObserver(() => {
    if (el.parentElement) {
      initialize()
    }
  })

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  })

  if (el.parentElement) {
    initialize()
  }

  const dispose = () => {
    if (resizeObserver) {
      resizeObserver.disconnect()
      window.removeEventListener('resize', handleResize)
    }
    if (mutationObserver) {
      mutationObserver.disconnect()
    }
    el.remove()
  }

  return {
    el,
    size,
    get rect() {
      return settings.rect ?? el.getBoundingClientRect()
    },
    c,
    dpr,
    ligatureDpr,
    clear,
    dispose,
  }
}
