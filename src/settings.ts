import { deepMerge } from 'utils/deep-merge'
import { signalify } from './lib/signalify.ts'
import type { TokenStyle } from './token.ts'

export type Settings = ReturnType<typeof createSettings>
export type EditorSettings = typeof defaultSettings

export type ThemeColors = typeof defaultColors
export type Theme = Record<string, TokenStyle>

export interface FontFamily {
  name: string
  url: string
  weight: string
  style: string
}

const lineHeight = 18
const fontSize = '11pt'
const fontFamilyName = 'LigaSpaceMono'
const fontFamilies: FontFamily[] = [
  {
    name: fontFamilyName,
    url: '/LigaSpaceMono-Regular.ttf',
    weight: 'normal',
    style: 'normal',
  },
  {
    name: fontFamilyName,
    url: '/LigaSpaceMono-Bold.ttf',
    weight: 'bold',
    style: 'normal',
  },
  {
    name: fontFamilyName,
    url: '/LigaSpaceMono-Italic.ttf',
    weight: 'normal',
    style: 'italic',
  },
  {
    name: fontFamilyName,
    url: '/LigaSpaceMono-BoldItalic.ttf',
    weight: 'bold',
    style: 'italic',
  },
] as const

export const defaultColors = {
  black: '#000000',
  red: '#ff0000',
  green: '#00ff00',
  yellow: '#ffff00',
  blue: '#0000ff',
  purple: '#ff00ff',
  cyan: '#00ffff',
  white: '#eeeeee',
  gray: '#808080',
  brightBlack: '#666666',
  brightRed: '#ff7777',
  brightGreen: '#77ff77',
  brightYellow: '#ffff77',
  brightBlue: '#7777ff',
  brightPurple: '#ff77ff',
  brightCyan: '#77ffff',
  brightWhite: '#ffffff',
}

const defaultSyntax = (c: ThemeColors): Theme => ({
  keyword: { color: c.brightBlue, style: 'italic', weight: 'regular' },
  function: { color: c.green, style: 'normal', weight: 'regular' },
  identifier: { color: c.white, style: 'normal', weight: 'regular' },
  string: { color: c.yellow, style: 'normal', weight: 'regular' },
  number: { color: c.cyan, style: 'normal', weight: 'regular' },
  boolean: { color: c.red, style: 'normal', weight: 'regular' },
  null: { color: c.blue, style: 'normal', weight: 'regular' },
  operator: { color: c.purple, style: 'normal', weight: 'regular' },
  punctuation: { color: c.white, style: 'normal', weight: 'regular' },
  comment: { color: c.gray, style: 'normal', weight: 'regular' },
  text: { color: c.white, style: 'normal', weight: 'regular' },
})

const defaultSettings = {
  lineHeight,
  fontSize,
  fontFamilyName,
  fontFamilies,
  wordWrap: false,
  autoHeight: false,
  rect: null as null | DOMRect,
  paddingLeft: 20,
  paddingTop: 20,
  paddingRight: 20,
  paddingBottom: 20,
  caretMarginY: 100,
  caretMarginX: 100,
  caretPhaseCoeff: 1,
  colors: signalify(defaultColors),
  syntax: defaultSyntax,
  lineComment: '//',
  blockComment: ['/*', '*/'] as [string, string],
  minGutterDigits: 2,
  showGutter: true,
  showMinimap: false,
  overscroll: false,
  performanceMode: 'normal' as 'normal' | 'large' | 'stress',
}

export function createSettings(editorSettings: Partial<EditorSettings> = {}) {
  const settings = signalify({
    ...deepMerge(
      deepMerge<typeof defaultSettings>(
        {} as typeof defaultSettings,
        defaultSettings,
      ),
      editorSettings,
    ),
    get ui() {
      return {
        background: this.colors.black,
        blockColors: [
          this.colors.brightYellow,
          this.colors.brightPurple,
          this.colors.brightBlue,
        ],
      }
    },
    get theme(): Theme {
      return this.syntax(this.colors)
    },
  })
  return settings
}
