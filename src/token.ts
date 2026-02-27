export type TokenType =
  | 'keyword'
  | 'function'
  | 'identifier'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'operator'
  | 'punctuation'
  | 'comment'
  | 'text'
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
