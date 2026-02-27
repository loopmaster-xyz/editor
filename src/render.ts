import { renderManager, draw } from './render-manager.ts'
import type { Context } from './context.ts'

export type Render = ReturnType<typeof createRender>

export function createRender(context: Context) {
  renderManager.register(context)

  return { dispose: () => renderManager.unregister(context) }
}

export { draw }
