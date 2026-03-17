export type TokenType =
  | 'keyword'
  | 'function'
  | 'identifier'
  | 'string'
  | 'number'
  | 'boolean'
  | 'builtin'
  | 'operator'
  | 'punctuation'
  | 'comment'
  | 'text'
  | 'parameter'
  | 'special'

export interface Token {
  type: TokenType
  text: string
  line?: number
  column?: number
}

export interface TokenStyle {
  color: string
  style: 'normal' | 'italic'
  weight: 'regular' | 'bold'
}
