import { Deferred } from 'utils/deferred'
import type { FontFamily } from './settings.ts'

const loadedUrls = new Map<string, Deferred<void>>()

export async function loadFonts(fontFamilies: FontFamily[]) {
  let promises: Promise<void>[] = []
  for (const font of fontFamilies) {
    if (!loadedUrls.has(font.url)) {
      loadedUrls.set(font.url, Deferred<void>())
      const fontFace = new FontFace(
        font.name,
        `url(${font.url})`,
        { weight: font.weight, style: font.style, display: 'block' },
      )
      fontFace.load().then(() => {
        document.fonts.add(fontFace)
        loadedUrls.get(font.url)!.resolve()
      })
    }
    promises.push(loadedUrls.get(font.url)!.promise)
  }
  await Promise.all(promises)
}
