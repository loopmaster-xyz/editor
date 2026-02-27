export function disposables() {
  const effects: (() => void)[] = []
  const dispose = () => {
    effects.forEach(dispose => dispose())
    effects.length = 0
    return effects
  }
  dispose.dispose = dispose
  return dispose
}
