import { signal } from '@preact/signals-core'

export type Metrics = ReturnType<typeof createMetrics>

export function createMetrics() {
  const gutterWidth = signal(0)
  const visibleLines = signal({ start: 0, end: 0 })

  return { gutterWidth, visibleLines }
}
