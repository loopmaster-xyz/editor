import type { Token, Tokenizer, TokenType } from '../src/editor.ts'

const keywords = new Set([
  'let',
  'const',
  'var',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'return',
  'function',
  'async',
  'await',
  'class',
  'extends',
  'import',
  'export',
  'from',
  'default',
  'try',
  'catch',
  'finally',
  'throw',
  'new',
  'this',
  'super',
  'typeof',
  'instanceof',
  'in',
  'of',
  'with',
  'void',
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  'type',
  'interface',
  'enum',
  'namespace',
  'declare',
  'as',
  'is',
  'satisfies',
  'keyof',
  'readonly',
  'abstract',
  'implements',
  'private',
  'protected',
  'public',
  'static',
  'override',
  'module',
  'global',
])

const operators = new Set([
  '|>',
  '->',
  '->>',
  '-->',
  '<-',
  '<<-',
  '<-->',
  '=>',
  '==>',
  '<=>',
  '<=',
  '>=',
  '<|',
  '<~',
  '~>',
  '<~>',
  '~~>',
  '<->',
  '==',
  '===',
  '!=',
  '!==',
  '<>',
  '<+',
  '+=',
  '-=',
  '*=',
  '/=',
  '**',
  '**=',
  '++',
  '--',
  '-+',
  '+-',
  '&&',
  '||',
  '!!',
  '&=',
  '|=',
  '^=',
  '~=',
  '=',
  '::',
  ':::',
  '|->',
  '|',
  '...',
  '..<',
  '..<.',
  '!!!',
  '~~~',
  '<*>',
  '<$>',
  '<$!>',
  '+++',
  '^^',
  '+',
  '-',
  '*',
  '/',
  '%',
  '&',
  '|',
  '^',
  '~',
  '!',
  '<',
  '>',
  '?',
  ':',
])

const punctuation = new Set([
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '.',
  ',',
  ';',
  ':',
])

type DecodedLineState = {
  inBlockComment: boolean
  inTemplateString: boolean
}

const STATE_IN_BLOCK_COMMENT = 1 << 0
const STATE_IN_TEMPLATE_STRING = 1 << 1

function decodeState(prevState: unknown): DecodedLineState {
  const stateBits = typeof prevState === 'number' ? prevState : 0
  return {
    inBlockComment: (stateBits & STATE_IN_BLOCK_COMMENT) !== 0,
    inTemplateString: (stateBits & STATE_IN_TEMPLATE_STRING) !== 0,
  }
}

function encodeState(state: DecodedLineState): number {
  let bits = 0
  if (state.inBlockComment) bits |= STATE_IN_BLOCK_COMMENT
  if (state.inTemplateString) bits |= STATE_IN_TEMPLATE_STRING
  return bits
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char)
}

function isDigit(char: string): boolean {
  return /[0-9]/.test(char)
}

function isLetter(char: string): boolean {
  return /[a-zA-Z_]/.test(char)
}

function isIdentifierChar(char: string): boolean {
  return isLetter(char) || isDigit(char) || char === '_' || char === '$'
}

function tokenizeLineInternal(
  input: string,
  prevState: unknown,
): { tokens: Token[]; state: number } {
  const tokens: Token[] = []
  const state = decodeState(prevState)
  let i = 0

  if (state.inBlockComment) {
    let comment = ''
    while (i < input.length) {
      const char = input[i]
      if (char === '*' && input[i + 1] === '/') {
        comment += '*/'
        i += 2
        state.inBlockComment = false
        break
      }
      comment += char
      i++
    }
    if (comment.length > 0) {
      tokens.push({ text: comment, type: 'comment' })
    }
    if (state.inBlockComment) {
      return { tokens, state: encodeState(state) }
    }
  }

  if (state.inTemplateString) {
    let string = ''
    let escaped = false
    while (i < input.length) {
      const char = input[i]
      if (escaped) {
        string += char
        escaped = false
        i++
        continue
      }
      if (char === '\\') {
        string += char
        escaped = true
        i++
        continue
      }
      if (char === '`') {
        string += char
        i++
        state.inTemplateString = false
        break
      }
      string += char
      i++
    }
    if (string.length > 0) {
      tokens.push({ text: string, type: 'string' })
    }
    if (state.inTemplateString) {
      return { tokens, state: encodeState(state) }
    }
  }

  while (i < input.length) {
    const char = input[i]

    if (isWhitespace(char)) {
      let whitespace = ''
      while (i < input.length && isWhitespace(input[i])) {
        whitespace += input[i]
        i++
      }
      if (whitespace.length > 0) {
        tokens.push({ text: whitespace, type: 'text' })
      }
      continue
    }

    if (char === '/' && input[i + 1] === '/') {
      const comment = input.slice(i)
      tokens.push({ text: comment, type: 'comment' })
      break
    }

    if (char === '/' && input[i + 1] === '*') {
      let comment = '/*'
      i += 2
      while (i < input.length) {
        if (input[i] === '*' && input[i + 1] === '/') {
          comment += '*/'
          i += 2
          break
        }
        comment += input[i]
        i++
      }
      if (!comment.endsWith('*/')) {
        state.inBlockComment = true
      }
      tokens.push({ text: comment, type: 'comment' })
      if (state.inBlockComment) {
        break
      }
      continue
    }

    if (char === '"' || char === '\'') {
      const quote = char
      let string = quote
      i++
      let escaped = false
      while (i < input.length) {
        if (escaped) {
          string += input[i]
          escaped = false
          i++
          continue
        }
        if (input[i] === '\\') {
          string += input[i]
          escaped = true
          i++
          continue
        }
        if (input[i] === quote) {
          string += input[i]
          i++
          break
        }
        string += input[i]
        i++
      }
      tokens.push({ text: string, type: 'string' })
      continue
    }

    if (char === '`') {
      let string = '`'
      i++
      let escaped = false
      let closed = false
      while (i < input.length) {
        if (escaped) {
          string += input[i]
          escaped = false
          i++
          continue
        }
        if (input[i] === '\\') {
          string += input[i]
          escaped = true
          i++
          continue
        }
        if (input[i] === '`') {
          string += input[i]
          i++
          closed = true
          break
        }
        string += input[i]
        i++
      }
      if (!closed) {
        state.inTemplateString = true
      }
      tokens.push({ text: string, type: 'string' })
      continue
    }

    if (isDigit(char) || (char === '.' && isDigit(input[i + 1]))) {
      let number = ''
      if (char === '.') {
        number += char
        i++
      }
      while (i < input.length && isDigit(input[i])) {
        number += input[i]
        i++
      }
      if (input[i] === '.' && isDigit(input[i + 1])) {
        number += input[i]
        i++
        while (i < input.length && isDigit(input[i])) {
          number += input[i]
          i++
        }
      }
      if (input[i] === 'e' || input[i] === 'E') {
        number += input[i]
        i++
        if (input[i] === '+' || input[i] === '-') {
          number += input[i]
          i++
        }
        while (i < input.length && isDigit(input[i])) {
          number += input[i]
          i++
        }
      }
      tokens.push({ text: number, type: 'number' })
      continue
    }

    let matched = false
    for (let len = 4; len >= 1; len--) {
      const candidate = input.slice(i, i + len)
      if (operators.has(candidate)) {
        tokens.push({ text: candidate, type: 'operator' })
        i += len
        matched = true
        break
      }
    }
    if (matched) continue

    if (punctuation.has(char)) {
      tokens.push({ text: char, type: 'punctuation' })
      i++
      continue
    }

    if (isLetter(char)) {
      let identifier = ''
      while (i < input.length && isIdentifierChar(input[i])) {
        identifier += input[i]
        i++
      }
      let type: TokenType = 'identifier'
      if (keywords.has(identifier)) {
        type = 'keyword'
      }
      else if (identifier === 'true' || identifier === 'false') {
        type = 'boolean'
      }
      else if (identifier === 'null' || identifier === 'undefined') {
        type = 'null'
      }
      else if (i < input.length && input[i] === '(') {
        type = 'function'
      }
      tokens.push({ text: identifier, type })
      continue
    }

    tokens.push({ text: char, type: 'text' })
    i++
  }

  return { tokens, state: encodeState(state) }
}

export const tokenizer: Tokenizer = {
  tokenizeLine(line: string, _lineIndex: number, prevState: unknown) {
    return tokenizeLineInternal(line, prevState)
  },
}

// Compatibility helper used by preview/demo utilities that still tokenize full code at once.
export function tokenize(input: string): Token[][] {
  const lines = input.split('\n')
  const result: Token[][] = new Array(lines.length)
  let state = 0

  for (let i = 0; i < lines.length; i++) {
    const lineResult = tokenizeLineInternal(lines[i] ?? '', state)
    result[i] = lineResult.tokens
    state = lineResult.state
  }

  return result
}
