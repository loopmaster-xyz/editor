export type KeyOverrideHandler = (event: KeyboardEvent) => boolean

let keyOverride: KeyOverrideHandler | null = null

export function onKeyOverride(fn: KeyOverrideHandler): void {
  keyOverride = fn
}

export function runKeyOverride(event: KeyboardEvent): boolean {
  return keyOverride?.(event) === true
}
