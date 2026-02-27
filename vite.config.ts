import preact from '@preact/preset-vite'
import { type ConfigEnv, defineConfig, loadEnv, type UserConfig } from 'vite'
import { openInEditor } from 'vite-plugin-open-in-editor'

export default ({ mode }: ConfigEnv): UserConfig => {
  const dirname = process.cwd()
  const env = loadEnv(mode, dirname)
  Object.assign(process.env, env)

  return defineConfig({
    plugins: [
      openInEditor({ cmd: 'cursor' }),
      preact(),
    ],
    optimizeDeps: {
      exclude: ['utils/mouse-buttons'],
    },
  })
}
