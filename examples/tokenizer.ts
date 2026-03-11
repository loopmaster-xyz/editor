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

const operatorsByFirstChar = new Map<number, string[]>()
for (const op of operators) {
  const first = op.charCodeAt(0)
  const list = operatorsByFirstChar.get(first)
  if (list) list.push(op)
  else operatorsByFirstChar.set(first, [op])
}
for (const [first, list] of operatorsByFirstChar) {
  list.sort((a, b) => b.length - a.length)
  operatorsByFirstChar.set(first, list)
}

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

const codeLf = 10
const codeCr = 13
const codeTab = 9
const codeVt = 11
const codeFf = 12
const codeSpace = 32
const codeSlash = 47
const codeStar = 42
const codeBackslash = 92
const codeSingleQuote = 39
const codeDoubleQuote = 34
const codeBacktick = 96
const codeDot = 46
const codeLParen = 40
const codePlus = 43
const codeMinus = 45
const codeLowerE = 101
const codeUpperE = 69
const codeUnderscore = 95
const codeDollar = 36

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

function isWhitespaceCode(code: number): boolean {
  return (
    code === codeSpace
    || code === codeTab
    || code === codeLf
    || code === codeCr
    || code === codeVt
    || code === codeFf
  )
}

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57
}

function isLetterCode(code: number): boolean {
  return (
    (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === codeUnderscore
  )
}

function isIdentifierCode(code: number): boolean {
  return isLetterCode(code) || isDigitCode(code) || code === codeDollar
}

function tokenizeLineInternal(
  input: string,
  prevState: unknown,
): { tokens: Token[]; state: number } {
  const tokens: Token[] = []
  const state = decodeState(prevState)
  const n = input.length
  let i = 0

  if (state.inBlockComment) {
    const start = i
    while (i < n) {
      if (input.charCodeAt(i) === codeStar && input.charCodeAt(i + 1) === codeSlash) {
        i += 2
        state.inBlockComment = false
        break
      }
      i++
    }
    if (i > start) {
      tokens.push({ text: input.slice(start, i), type: 'comment' })
    }
    if (state.inBlockComment) {
      return { tokens, state: encodeState(state) }
    }
  }

  if (state.inTemplateString) {
    const start = i
    let escaped = false
    while (i < n) {
      const code = input.charCodeAt(i)
      if (escaped) {
        escaped = false
        i++
        continue
      }
      if (code === codeBackslash) {
        escaped = true
        i++
        continue
      }
      i++
      if (code === codeBacktick) {
        state.inTemplateString = false
        break
      }
    }
    if (i > start) {
      tokens.push({ text: input.slice(start, i), type: 'string' })
    }
    if (state.inTemplateString) {
      return { tokens, state: encodeState(state) }
    }
  }

  while (i < n) {
    const start = i
    const code = input.charCodeAt(i)

    if (isWhitespaceCode(code)) {
      i++
      while (i < n && isWhitespaceCode(input.charCodeAt(i))) i++
      tokens.push({ text: input.slice(start, i), type: 'text' })
      continue
    }

    if (code === codeSlash && input.charCodeAt(i + 1) === codeSlash) {
      tokens.push({ text: input.slice(i), type: 'comment' })
      break
    }

    if (code === codeSlash && input.charCodeAt(i + 1) === codeStar) {
      i += 2
      let closed = false
      while (i < n) {
        if (input.charCodeAt(i) === codeStar && input.charCodeAt(i + 1) === codeSlash) {
          i += 2
          closed = true
          break
        }
        i++
      }
      if (!closed) {
        state.inBlockComment = true
      }
      tokens.push({ text: input.slice(start, i), type: 'comment' })
      if (state.inBlockComment) break
      continue
    }

    if (code === codeSingleQuote || code === codeDoubleQuote) {
      const quote = code
      i++
      let escaped = false
      while (i < n) {
        const c = input.charCodeAt(i)
        if (escaped) {
          escaped = false
          i++
          continue
        }
        if (c === codeBackslash) {
          escaped = true
          i++
          continue
        }
        i++
        if (c === quote) break
      }
      tokens.push({ text: input.slice(start, i), type: 'string' })
      continue
    }

    if (code === codeBacktick) {
      i++
      let escaped = false
      let closed = false
      while (i < n) {
        const c = input.charCodeAt(i)
        if (escaped) {
          escaped = false
          i++
          continue
        }
        if (c === codeBackslash) {
          escaped = true
          i++
          continue
        }
        i++
        if (c === codeBacktick) {
          closed = true
          break
        }
      }
      if (!closed) {
        state.inTemplateString = true
      }
      tokens.push({ text: input.slice(start, i), type: 'string' })
      continue
    }

    if (isDigitCode(code) || (code === codeDot && isDigitCode(input.charCodeAt(i + 1)))) {
      if (code === codeDot) i++
      while (i < n && isDigitCode(input.charCodeAt(i))) i++

      if (input.charCodeAt(i) === codeDot && isDigitCode(input.charCodeAt(i + 1))) {
        i++
        while (i < n && isDigitCode(input.charCodeAt(i))) i++
      }

      const e = input.charCodeAt(i)
      if (e === codeLowerE || e === codeUpperE) {
        i++
        const sign = input.charCodeAt(i)
        if (sign === codePlus || sign === codeMinus) i++
        while (i < n && isDigitCode(input.charCodeAt(i))) i++
      }

      tokens.push({ text: input.slice(start, i), type: 'number' })
      continue
    }

    const ops = operatorsByFirstChar.get(code)
    if (ops) {
      let matched = false
      for (let oi = 0; oi < ops.length; oi++) {
        const op = ops[oi]
        if (input.startsWith(op, i)) {
          tokens.push({ text: op, type: 'operator' })
          i += op.length
          matched = true
          break
        }
      }
      if (matched) continue
    }

    const char = input[i]!
    if (punctuation.has(char)) {
      tokens.push({ text: char, type: 'punctuation' })
      i++
      continue
    }

    if (isLetterCode(code)) {
      i++
      while (i < n && isIdentifierCode(input.charCodeAt(i))) i++

      const identifier = input.slice(start, i)
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
      else if (input.charCodeAt(i) === codeLParen) {
        type = 'function'
      }
      tokens.push({ text: identifier, type })
      continue
    }

    i++
    tokens.push({ text: input.slice(start, i), type: 'text' })
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
