import type { Token } from './token.ts'

export type Tokenizer = typeof tokenize

export function tokenize(code: string): Token[][] {
  return code.split('\n')
    .map(x =>
      [...x.matchAll(/\s+|.+/g)]
        .filter(x => x[0] !== '')
        .map(text => ({ text: text[0], type: 'text' }))
    )
}
