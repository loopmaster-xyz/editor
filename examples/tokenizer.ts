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

export const tokenize: Tokenizer = (input: string) => {
  const lines: Token[][] = []
  let currentLine: Token[] = []
  let i = 0

  while (i < input.length) {
    const char = input[i]

    if (isWhitespace(char)) {
      let whitespace = ''
      while (i < input.length && isWhitespace(input[i])) {
        whitespace += input[i]
        i++
      }
      const parts = whitespace.split('\n')
      if (parts.length > 1) {
        if (parts[0]) {
          currentLine.push({
            text: parts[0],
            type: 'text',
          })
        }
        for (let j = 1; j < parts.length; j++) {
          lines.push(currentLine)
          currentLine = []
          if (parts[j]) {
            currentLine.push({
              text: parts[j],
              type: 'text',
            })
          }
        }
      }
      else {
        currentLine.push({
          text: whitespace,
          type: 'text',
        })
      }
      continue
    }

    if (char === '/' && input[i + 1] === '/') {
      let comment = '//'
      i += 2
      while (i < input.length && input[i] !== '\n') {
        comment += input[i]
        i++
      }
      currentLine.push({
        text: comment,
        type: 'comment',
      })
      continue
    }

    if (char === '/' && input[i + 1] === '*') {
      let comment = '/*'
      i += 2
      while (i < input.length - 1) {
        if (input[i] === '\n') {
          comment += input[i]
          currentLine.push({
            text: comment,
            type: 'comment',
          })
          lines.push(currentLine)
          currentLine = []
          comment = ''
          i++
        }
        else {
          comment += input[i]
          if (input[i] === '*' && input[i + 1] === '/') {
            comment += input[i + 1]
            i += 2
            break
          }
          i++
        }
      }
      if (comment) {
        currentLine.push({
          text: comment,
          type: 'comment',
        })
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
        }
        else if (input[i] === '\\') {
          string += input[i]
          escaped = true
          i++
        }
        else if (input[i] === quote) {
          string += input[i]
          i++
          break
        }
        else {
          string += input[i]
          i++
        }
      }
      currentLine.push({
        text: string,
        type: 'string',
      })
      continue
    }

    if (char === '`') {
      const quote = char
      let string = quote
      i++
      let escaped = false
      while (i < input.length) {
        if (escaped) {
          string += input[i]
          escaped = false
          i++
        }
        else if (input[i] === '\\') {
          string += input[i]
          escaped = true
          i++
        }
        else if (input[i] === '\n') {
          string += input[i]
          currentLine.push({
            text: string,
            type: 'string',
          })
          lines.push(currentLine)
          currentLine = []
          string = ''
          i++
        }
        else if (input[i] === quote) {
          string += input[i]
          i++
          break
        }
        else {
          string += input[i]
          i++
        }
      }
      if (string) {
        currentLine.push({
          text: string,
          type: 'string',
        })
      }
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
      currentLine.push({
        text: number,
        type: 'number',
      })
      continue
    }

    let matched = false
    for (let len = 4; len >= 1; len--) {
      const candidate = input.slice(i, i + len)
      if (operators.has(candidate)) {
        currentLine.push({
          text: candidate,
          type: 'operator',
        })
        i += len
        matched = true
        break
      }
    }
    if (matched) continue

    if (punctuation.has(char)) {
      currentLine.push({
        text: char,
        type: 'punctuation',
      })
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
      currentLine.push({
        text: identifier,
        type,
      })
      continue
    }

    currentLine.push({
      text: char,
      type: 'text',
    })
    i++
  }

  lines.push(currentLine)

  return lines
}
