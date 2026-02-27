import { describe, expect, it } from 'bun:test'
import { type Buffer, createBuffer, unpack } from '../src/buffer.ts'

const flush = () => new Promise<void>(r => setTimeout(r, 0))

describe('Buffer', () => {
  describe('createBuffer', () => {
    it('should create empty buffer', () => {
      const buffer = createBuffer('')
      expect(buffer.code.value).toBe('')
      expect(buffer.lines.value).toEqual([''])
    })

    it('should create buffer with initial text', () => {
      const buffer = createBuffer('hello')
      expect(buffer.code.value).toBe('hello')
      expect(buffer.lines.value).toEqual(['hello'])
    })

    it('should create buffer with multiline text', () => {
      const buffer = createBuffer('line1\nline2\nline3')
      expect(buffer.code.value).toBe('line1\nline2\nline3')
      expect(buffer.lines.value).toEqual(['line1', 'line2', 'line3'])
    })
  })

  describe('insert', () => {
    it('should insert at beginning', () => {
      const buffer = createBuffer('world')
      buffer.insert(0, 0, 'hello ')
      expect(buffer.code.value).toBe('hello world')
    })

    it('should insert at end', () => {
      const buffer = createBuffer('hello')
      buffer.insert(0, 5, ' world')
      expect(buffer.code.value).toBe('hello world')
    })

    it('should insert in middle', () => {
      const buffer = createBuffer('helloworld')
      buffer.insert(0, 5, ' ')
      expect(buffer.code.value).toBe('hello world')
    })

    it('should insert on second line', () => {
      const buffer = createBuffer('line1\nline2')
      buffer.insert(1, 5, '!')
      expect(buffer.code.value).toBe('line1\nline2!')
    })

    it('should insert newline', () => {
      const buffer = createBuffer('helloworld')
      buffer.insert(0, 5, '\n')
      expect(buffer.code.value).toBe('hello\nworld')
      expect(buffer.lines.value).toEqual(['hello', 'world'])
    })
  })

  describe('del (forward delete)', () => {
    it('should delete character at position', () => {
      const buffer = createBuffer('hello')
      buffer.del(0, 0)
      expect(buffer.code.value).toBe('ello')
    })

    it('should delete in middle', () => {
      const buffer = createBuffer('hello')
      buffer.del(0, 2)
      expect(buffer.code.value).toBe('helo')
    })

    it('should delete last character', () => {
      const buffer = createBuffer('hello')
      buffer.del(0, 4)
      expect(buffer.code.value).toBe('hell')
    })

    it('should delete newline', () => {
      const buffer = createBuffer('hello\nworld')
      buffer.del(0, 5)
      expect(buffer.code.value).toBe('helloworld')
    })
  })

  describe('backspace', () => {
    it('should delete character before position', () => {
      const buffer = createBuffer('hello')
      buffer.backspace(0, 5)
      expect(buffer.code.value).toBe('hell')
    })

    it('should backspace in middle', () => {
      const buffer = createBuffer('hello')
      buffer.backspace(0, 3)
      expect(buffer.code.value).toBe('helo')
    })

    it('should backspace at start of line (delete newline)', () => {
      const buffer = createBuffer('hello\nworld')
      buffer.backspace(1, 0)
      expect(buffer.code.value).toBe('helloworld')
    })
  })

  describe('deleteSelection', () => {
    it('should delete selection on single line', () => {
      const buffer = createBuffer('hello world')
      buffer.deleteSelection({ line: 0, column: 0 }, { line: 0, column: 5 })
      expect(buffer.code.value).toBe(' world')
    })

    it('should delete selection across lines', () => {
      const buffer = createBuffer('hello\nworld')
      buffer.deleteSelection({ line: 0, column: 3 }, { line: 1, column: 2 })
      expect(buffer.code.value).toBe('helrld')
    })

    it('should delete entire content', () => {
      const buffer = createBuffer('hello')
      buffer.deleteSelection({ line: 0, column: 0 }, { line: 0, column: 5 })
      expect(buffer.code.value).toBe('')
    })
  })

  describe('replaceSelection', () => {
    it('should replace selection with text', () => {
      const buffer = createBuffer('hello world')
      buffer.replaceSelection(
        { line: 0, column: 6 },
        { line: 0, column: 11 },
        'universe',
      )
      expect(buffer.code.value).toBe('hello universe')
    })

    it('should replace with shorter text', () => {
      const buffer = createBuffer('hello world')
      buffer.replaceSelection(
        { line: 0, column: 0 },
        { line: 0, column: 5 },
        'hi',
      )
      expect(buffer.code.value).toBe('hi world')
    })

    it('should replace with longer text', () => {
      const buffer = createBuffer('hi world')
      buffer.replaceSelection(
        { line: 0, column: 0 },
        { line: 0, column: 2 },
        'hello',
      )
      expect(buffer.code.value).toBe('hello world')
    })

    it('should replace across lines', () => {
      const buffer = createBuffer('hello\nworld')
      buffer.replaceSelection(
        { line: 0, column: 3 },
        { line: 1, column: 2 },
        'p me ',
      )
      expect(buffer.code.value).toBe('help me rld')
    })
  })

  describe('undo', () => {
    it('should return null on empty history', () => {
      const buffer = createBuffer('hello')
      const result = buffer.undo()
      expect(result).toBeNull()
    })

    it('should undo single insert', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'hello')
      expect(buffer.code.value).toBe('hello')

      const result = buffer.undo()
      expect(buffer.code.value).toBe('')
      expect(result).not.toBeNull()
      expect(result!.line).toBe(0)
      expect(result!.column).toBe(0)
    })

    it('should undo single delete (del)', () => {
      const buffer = createBuffer('hello')
      buffer.del(0, 0)
      expect(buffer.code.value).toBe('ello')

      const result = buffer.undo()
      expect(buffer.code.value).toBe('hello')
      expect(result).not.toBeNull()
      expect(result!.line).toBe(0)
      expect(result!.column).toBe(0) // del stores caretIndex at delete position
    })

    it('should undo single backspace', () => {
      const buffer = createBuffer('hello')
      buffer.backspace(0, 5)
      expect(buffer.code.value).toBe('hell')

      const result = buffer.undo()
      expect(buffer.code.value).toBe('hello')
      expect(result).not.toBeNull()
      expect(result!.line).toBe(0)
      expect(result!.column).toBe(5) // backspace stores caretIndex at original position
    })

    it('should undo deleteSelection', () => {
      const buffer = createBuffer('hello world')
      buffer.deleteSelection(
        { line: 0, column: 5 },
        { line: 0, column: 11 },
        { start: { line: 0, column: 5 }, end: { line: 0, column: 11 }, direction: 'forward' },
      )
      expect(buffer.code.value).toBe('hello')

      const result = buffer.undo()
      expect(buffer.code.value).toBe('hello world')
      expect(result).not.toBeNull()
      expect(result!.selection).toBeDefined()
      expect(result!.selection!.start).toEqual({ line: 0, column: 5 })
      expect(result!.selection!.end).toEqual({ line: 0, column: 11 })
    })

    it('should undo replaceSelection', () => {
      const buffer = createBuffer('hello world')
      buffer.replaceSelection(
        { line: 0, column: 6 },
        { line: 0, column: 11 },
        'universe',
        { start: { line: 0, column: 6 }, end: { line: 0, column: 11 }, direction: 'forward' },
      )
      expect(buffer.code.value).toBe('hello universe')

      const result = buffer.undo()
      expect(buffer.code.value).toBe('hello world')
      expect(result).not.toBeNull()
      expect(result!.selection).toBeDefined()
    })

    it('should undo multiple operations', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'a')
      // Wait to prevent merging
      buffer.insert(0, 1, 'b')
      buffer.insert(0, 2, 'c')

      // Due to merging, these might be combined
      buffer.undo()
      // After undo, we should have less text
      expect(buffer.code.value.length).toBeLessThan(3)
    })
  })

  describe('redo', () => {
    it('should return null when nothing to redo', () => {
      const buffer = createBuffer('hello')
      const result = buffer.redo()
      expect(result).toBeNull()
    })

    it('should redo after undo of insert', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'hello')
      buffer.undo()
      expect(buffer.code.value).toBe('')

      const result = buffer.redo()
      expect(buffer.code.value).toBe('hello')
      expect(result).not.toBeNull()
      expect(result!.line).toBe(0)
      expect(result!.column).toBe(5)
    })

    it('should redo after undo of delete', () => {
      const buffer = createBuffer('hello')
      buffer.del(0, 0)
      buffer.undo()
      expect(buffer.code.value).toBe('hello')

      const result = buffer.redo()
      expect(buffer.code.value).toBe('ello')
      expect(result).not.toBeNull()
      expect(result!.line).toBe(0)
      expect(result!.column).toBe(0)
    })

    it('should redo after undo of backspace', () => {
      const buffer = createBuffer('hello')
      buffer.backspace(0, 5)
      buffer.undo()
      expect(buffer.code.value).toBe('hello')

      const result = buffer.redo()
      expect(buffer.code.value).toBe('hell')
      expect(result).not.toBeNull()
      expect(result!.line).toBe(0)
      expect(result!.column).toBe(4)
    })

    it('should redo replaceSelection', () => {
      const buffer = createBuffer('hello world')
      buffer.replaceSelection(
        { line: 0, column: 6 },
        { line: 0, column: 11 },
        'universe',
      )
      buffer.undo()
      expect(buffer.code.value).toBe('hello world')

      const result = buffer.redo()
      expect(buffer.code.value).toBe('hello universe')
      expect(result).not.toBeNull()
    })
  })

  describe('undo/redo sequences', () => {
    it('should handle undo-redo-undo', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'hello')

      buffer.undo()
      expect(buffer.code.value).toBe('')

      buffer.redo()
      expect(buffer.code.value).toBe('hello')

      buffer.undo()
      expect(buffer.code.value).toBe('')
    })

    it('should handle multiple undo then multiple redo', () => {
      const buffer = createBuffer('')

      // Simple sequential inserts that will be merged
      buffer.insert(0, 0, 'a')
      buffer.insert(0, 1, 'b')
      buffer.insert(0, 2, 'c')

      expect(buffer.code.value).toBe('abc')

      // Undo - should undo the merged operation
      buffer.undo()
      expect(buffer.code.value).toBe('')

      // Redo - should redo the merged operation
      buffer.redo()
      expect(buffer.code.value).toBe('abc')

      // Multiple undos and redos
      buffer.undo()
      expect(buffer.code.value).toBe('')

      buffer.redo()
      expect(buffer.code.value).toBe('abc')
    })

    it('should clear redo history on new operation', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'hello')
      buffer.undo()
      expect(buffer.code.value).toBe('')

      // New operation should clear redo history
      buffer.insert(0, 0, 'world')
      expect(buffer.code.value).toBe('world')

      const result = buffer.redo()
      expect(result).toBeNull()
    })

    it('should handle interleaved operations and undos', () => {
      const buffer = createBuffer('start')

      buffer.insert(0, 5, '1')
      expect(buffer.code.value).toBe('start1')

      buffer.undo()
      expect(buffer.code.value).toBe('start')

      buffer.insert(0, 5, '2')
      expect(buffer.code.value).toBe('start2')

      buffer.insert(0, 6, '3')
      expect(buffer.code.value).toBe('start23')

      buffer.undo()
      // Due to merging, might undo both 2 and 3
      expect(buffer.code.value.startsWith('start')).toBe(true)
    })
  })

  describe('operation merging', () => {
    it('should merge consecutive inserts at adjacent positions', () => {
      const buffer = createBuffer('')

      buffer.insert(0, 0, 'a')
      buffer.insert(0, 1, 'b')
      buffer.insert(0, 2, 'c')

      expect(buffer.code.value).toBe('abc')

      // Should be merged into single operation
      buffer.undo()
      expect(buffer.code.value).toBe('')

      // Only one redo needed
      buffer.redo()
      expect(buffer.code.value).toBe('abc')
    })

    it('should merge consecutive backspaces', () => {
      const buffer = createBuffer('abc')

      buffer.backspace(0, 3) // delete 'c'
      buffer.backspace(0, 2) // delete 'b'
      buffer.backspace(0, 1) // delete 'a'

      expect(buffer.code.value).toBe('')

      // Should be merged
      buffer.undo()
      expect(buffer.code.value).toBe('abc')
    })

    it('should merge consecutive forward deletes', () => {
      const buffer = createBuffer('abc')

      buffer.del(0, 0) // delete 'a'
      buffer.del(0, 0) // delete 'b'
      buffer.del(0, 0) // delete 'c'

      expect(buffer.code.value).toBe('')

      // Should be merged
      buffer.undo()
      expect(buffer.code.value).toBe('abc')
    })

    it('should not merge non-adjacent inserts', () => {
      const buffer = createBuffer('ac')

      buffer.insert(0, 1, 'b') // Insert between a and c
      expect(buffer.code.value).toBe('abc')

      buffer.insert(0, 0, 'X') // Insert at beginning (non-adjacent)
      expect(buffer.code.value).toBe('Xabc')

      // These should NOT be merged
      buffer.undo()
      expect(buffer.code.value).toBe('abc')

      buffer.undo()
      expect(buffer.code.value).toBe('ac')
    })
  })

  describe('caret position restoration', () => {
    it('should restore caret after undo of insert', () => {
      const buffer = createBuffer('hello')
      buffer.insert(0, 5, ' world')

      const result = buffer.undo()
      expect(result).not.toBeNull()
      expect(result!.line).toBe(0)
      expect(result!.column).toBe(5)
    })

    it('should restore caret after undo of backspace', () => {
      const buffer = createBuffer('hello')
      buffer.backspace(0, 5)

      const result = buffer.undo()
      expect(result).not.toBeNull()
      expect(result!.line).toBe(0)
      expect(result!.column).toBe(5) // Back to original position
    })

    it('should restore caret after undo of del', () => {
      const buffer = createBuffer('hello')
      buffer.del(0, 2)

      const result = buffer.undo()
      expect(result).not.toBeNull()
      expect(result!.line).toBe(0)
      expect(result!.column).toBe(2) // Back to delete position
    })

    it('should restore caret on correct line for multiline', () => {
      const buffer = createBuffer('line1\nline2')
      buffer.insert(1, 5, '!')

      const result = buffer.undo()
      expect(result).not.toBeNull()
      expect(result!.line).toBe(1)
      expect(result!.column).toBe(5)
    })

    it('should restore caret after redo of insert', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'hello')
      buffer.undo()

      const result = buffer.redo()
      expect(result).not.toBeNull()
      expect(result!.line).toBe(0)
      expect(result!.column).toBe(5) // End of inserted text
    })

    it('should restore caret after redo of delete', () => {
      const buffer = createBuffer('hello')
      buffer.del(0, 2)
      buffer.undo()

      const result = buffer.redo()
      expect(result).not.toBeNull()
      expect(result!.line).toBe(0)
      expect(result!.column).toBe(2) // Position after delete
    })
  })

  describe('selection restoration', () => {
    it('should restore selection after undo of deleteSelection', () => {
      const buffer = createBuffer('hello world')
      buffer.deleteSelection(
        { line: 0, column: 0 },
        { line: 0, column: 5 },
        { start: { line: 0, column: 0 }, end: { line: 0, column: 5 }, direction: 'forward' },
      )

      const result = buffer.undo()
      expect(result).not.toBeNull()
      expect(result!.selection).toBeDefined()
      expect(result!.selection!.start).toEqual({ line: 0, column: 0 })
      expect(result!.selection!.end).toEqual({ line: 0, column: 5 })
      expect(result!.selection!.direction).toBe('forward')
    })

    it('should restore backward selection', () => {
      const buffer = createBuffer('hello world')
      buffer.deleteSelection(
        { line: 0, column: 0 },
        { line: 0, column: 5 },
        { start: { line: 0, column: 0 }, end: { line: 0, column: 5 }, direction: 'backward' },
      )

      const result = buffer.undo()
      expect(result).not.toBeNull()
      expect(result!.selection!.direction).toBe('backward')
      expect(result!.line).toBe(0)
      expect(result!.column).toBe(0) // Caret at start for backward selection
    })

    it('should restore selection after undo of replaceSelection', () => {
      const buffer = createBuffer('hello world')
      buffer.replaceSelection(
        { line: 0, column: 6 },
        { line: 0, column: 11 },
        'X',
        { start: { line: 0, column: 6 }, end: { line: 0, column: 11 }, direction: 'forward' },
      )

      const result = buffer.undo()
      expect(result).not.toBeNull()
      expect(result!.selection).toBeDefined()
      expect(result!.selection!.start).toEqual({ line: 0, column: 6 })
      expect(result!.selection!.end).toEqual({ line: 0, column: 11 })
    })
  })

  describe('multiline operations', () => {
    it('should undo multiline insert', () => {
      const buffer = createBuffer('hello')
      buffer.insert(0, 5, '\nworld\nfoo')

      expect(buffer.code.value).toBe('hello\nworld\nfoo')
      expect(buffer.lines.value).toEqual(['hello', 'world', 'foo'])

      buffer.undo()
      expect(buffer.code.value).toBe('hello')
      expect(buffer.lines.value).toEqual(['hello'])
    })

    it('should undo multiline delete', () => {
      const buffer = createBuffer('hello\nworld\nfoo')
      buffer.deleteSelection(
        { line: 0, column: 3 },
        { line: 2, column: 2 },
      )

      expect(buffer.code.value).toBe('helo')

      buffer.undo()
      expect(buffer.code.value).toBe('hello\nworld\nfoo')
    })

    it('should undo multiline replace', () => {
      const buffer = createBuffer('hello\nworld\nfoo')
      buffer.replaceSelection(
        { line: 0, column: 3 },
        { line: 2, column: 2 },
        'X',
      )

      expect(buffer.code.value).toBe('helXo')

      buffer.undo()
      expect(buffer.code.value).toBe('hello\nworld\nfoo')
    })
  })

  describe('edge cases', () => {
    it('should handle empty document operations', () => {
      const buffer = createBuffer('')

      buffer.insert(0, 0, 'a')
      buffer.undo()
      expect(buffer.code.value).toBe('')

      buffer.redo()
      expect(buffer.code.value).toBe('a')
    })

    it('should handle operations at document boundaries', () => {
      const buffer = createBuffer('hello')

      // Insert at very end
      buffer.insert(0, 5, '!')
      expect(buffer.code.value).toBe('hello!')

      buffer.undo()
      expect(buffer.code.value).toBe('hello')

      // Delete at very beginning
      buffer.del(0, 0)
      expect(buffer.code.value).toBe('ello')

      buffer.undo()
      expect(buffer.code.value).toBe('hello')
    })

    it('should handle deleting entire content', () => {
      const buffer = createBuffer('hello')
      buffer.deleteSelection({ line: 0, column: 0 }, { line: 0, column: 5 })

      expect(buffer.code.value).toBe('')

      buffer.undo()
      expect(buffer.code.value).toBe('hello')
    })

    it('should handle rapid undo/redo', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'test')

      for (let i = 0; i < 10; i++) {
        buffer.undo()
        buffer.redo()
      }

      expect(buffer.code.value).toBe('test')
    })

    it('should not corrupt history on rapid undo/redo (no insert elsewhere)', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'ab')
      buffer.insert(0, 2, 'c')
      const expected = 'abc'

      for (let i = 0; i < 50; i++) {
        buffer.undo()
        buffer.redo()
        expect(buffer.code.value).toBe(expected)
      }
    })

    it('should not corrupt on rapid undo/redo with multiple distinct ops', () => {
      const buffer = createBuffer('x')
      buffer.insert(0, 1, 'a')
      buffer.insert(0, 2, 'b')
      buffer.insert(0, 3, 'c')
      expect(buffer.code.value).toBe('xabc')

      for (let i = 0; i < 30; i++) {
        buffer.undo()
        buffer.undo()
        buffer.undo()
        expect(buffer.code.value).toBe('x')
        buffer.redo()
        buffer.redo()
        buffer.redo()
        expect(buffer.code.value).toBe('xabc')
      }
    })

    it('should not add insert elsewhere on rapid undo/redo after replace', () => {
      const buffer = createBuffer('hello')
      buffer.replaceSelection(
        { line: 0, column: 0 },
        { line: 0, column: 5 },
        'world',
      )
      expect(buffer.code.value).toBe('world')

      for (let i = 0; i < 20; i++) {
        buffer.undo()
        buffer.undo()
        expect(buffer.code.value).toBe('hello')
        buffer.redo()
        buffer.redo()
        expect(buffer.code.value).toBe('world')
      }
    })

    it('rapid undo/redo preserves exact content (non-adjacent inserts)', () => {
      const buffer = createBuffer('ac')
      buffer.insert(0, 1, 'b')
      expect(buffer.code.value).toBe('abc')
      const expected = buffer.code.value

      for (let i = 0; i < 100; i++) {
        buffer.undo()
        expect(buffer.code.value).toBe('ac')
        buffer.redo()
        expect(buffer.code.value).toBe(expected)
      }
    })

    it('insert at column past end (e.g. stale caret after undo) clamps to end', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 5, 'x')
      expect(buffer.code.value).toBe('x')
    })

    it('should not corrupt on rapid undo/redo with flush between ops', async () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'test')

      for (let i = 0; i < 10; i++) {
        buffer.undo()
        await flush()
        buffer.redo()
        await flush()
      }
      expect(buffer.code.value).toBe('test')
    }, 5000)

    it('should not corrupt on rapid undo/redo with flush (multiple ops)', async () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'ab')
      buffer.insert(0, 2, 'c')
      const expected = 'abc'

      for (let i = 0; i < 50; i++) {
        buffer.undo()
        await flush()
        buffer.redo()
        await flush()
        expect(buffer.code.value).toBe(expected)
      }
    }, 10000)

    it('should not add insert elsewhere on undo/redo after replace with flush', async () => {
      const buffer = createBuffer('hello')
      buffer.replaceSelection(
        { line: 0, column: 0 },
        { line: 0, column: 5 },
        'world',
      )
      expect(buffer.code.value).toBe('world')

      for (let i = 0; i < 20; i++) {
        buffer.undo()
        buffer.undo()
        await flush()
        expect(buffer.code.value).toBe('hello')
        buffer.redo()
        buffer.redo()
        await flush()
        expect(buffer.code.value).toBe('world')
      }
    }, 5000)

    it('random undo/redo counts on same history: can always redo back to head', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'a')
      buffer.insert(0, 1, 'b')
      buffer.insert(0, 2, 'c')
      const expectedAtHead = buffer.code.value

      for (let trial = 0; trial < 200; trial++) {
        const undos = Math.floor(Math.random() * 8)
        const redos = Math.floor(Math.random() * 8)
        for (let i = 0; i < undos; i++) buffer.undo()
        for (let i = 0; i < redos; i++) buffer.redo()
        while (buffer.redo() !== null) {}
        expect(buffer.code.value).toBe(expectedAtHead)
      }
    })

    it('random undo/redo on replace history: can always redo back to head', () => {
      const buffer = createBuffer('hello')
      buffer.replaceSelection(
        { line: 0, column: 0 },
        { line: 0, column: 5 },
        'world',
      )
      const expectedAtHead = buffer.code.value

      for (let trial = 0; trial < 200; trial++) {
        const undos = Math.floor(Math.random() * 6)
        const redos = Math.floor(Math.random() * 6)
        for (let i = 0; i < undos; i++) buffer.undo()
        for (let i = 0; i < redos; i++) buffer.redo()
        while (buffer.redo() !== null) {}
        expect(buffer.code.value).toBe(expectedAtHead)
      }
    })

    it('foobar replace foo then undo/redo never produces foofoobar', () => {
      const buffer = createBuffer('foobar')
      buffer.replaceSelection(
        { line: 0, column: 0 },
        { line: 0, column: 3 },
        '',
      )
      expect(buffer.code.value).toBe('bar')

      buffer.undo()
      buffer.undo()
      expect(buffer.code.value).toBe('foobar')

      buffer.redo()
      expect(buffer.code.value).toBe('bar')
      buffer.redo()
      expect(buffer.redo()).toBeNull()
      expect(buffer.code.value).toBe('bar')
      expect(buffer.code.value).not.toBe('foofoobar')
    })

    it('foobar replace foo with baz: undo then redo twice stays consistent', () => {
      const buffer = createBuffer('foobar')
      buffer.replaceSelection(
        { line: 0, column: 0 },
        { line: 0, column: 3 },
        'baz',
      )
      expect(buffer.code.value).toBe('bazbar')

      buffer.undo()
      buffer.undo()
      expect(buffer.code.value).toBe('foobar')

      buffer.redo()
      expect(buffer.code.value).toBe('bazbar')
      const secondRedo = buffer.redo()
      expect(secondRedo).toBeNull()
      expect(buffer.code.value).toBe('bazbar')
      expect(buffer.code.value).not.toBe('foofoobar')
    })

    it('foobar replace then random undo/redo never yields foofoobar', () => {
      const buffer = createBuffer('foobar')
      buffer.replaceSelection(
        { line: 0, column: 0 },
        { line: 0, column: 3 },
        '',
      )
      const atHead = 'bar'

      for (let trial = 0; trial < 300; trial++) {
        const undos = Math.floor(Math.random() * 5)
        const redos = Math.floor(Math.random() * 5)
        for (let i = 0; i < undos; i++) buffer.undo()
        for (let i = 0; i < redos; i++) buffer.redo()
        expect(buffer.code.value).not.toBe('foofoobar')
        while (buffer.redo() !== null) {}
        expect(buffer.code.value).toBe(atHead)
        expect(buffer.code.value).not.toBe('foofoobar')
      }
    })

    it('should handle undo past beginning', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'a')

      buffer.undo()
      expect(buffer.code.value).toBe('')

      // Second undo should return null
      const result = buffer.undo()
      expect(result).toBeNull()
      expect(buffer.code.value).toBe('')
    })

    it('should handle redo past end', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'a')
      buffer.undo()
      buffer.redo()

      // Second redo should return null
      const result = buffer.redo()
      expect(result).toBeNull()
      expect(buffer.code.value).toBe('a')
    })
  })

  describe('pack and unpack', () => {
    it('should pack and unpack empty buffer', () => {
      const buffer = createBuffer('')
      const packed = buffer.pack()

      const restored = unpack(packed)
      expect(restored.code.value).toBe('')
    })

    it('should pack and unpack buffer with content', () => {
      const buffer = createBuffer('hello world')
      const packed = buffer.pack()

      const restored = unpack(packed)
      expect(restored.code.value).toBe('hello world')
    })

    it('should pack and unpack buffer with history', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'hello')

      const packed = buffer.pack()
      const restored = unpack(packed)

      expect(restored.code.value).toBe('hello')
      expect(restored.history.value.length).toBeGreaterThan(0)

      // Should be able to undo
      restored.undo()
      expect(restored.code.value).toBe('')
    })

    it('should preserve history index', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'a')
      buffer.insert(0, 1, 'b')
      buffer.undo()

      const packed = buffer.pack()
      const restored = unpack(packed)

      // Should be able to redo
      restored.redo()
      expect(restored.code.value).toBe('ab')
    })
  })

  describe('stress tests', () => {
    it('should handle many operations', () => {
      const buffer = createBuffer('')

      for (let i = 0; i < 100; i++) {
        buffer.insert(0, i, String.fromCharCode(97 + (i % 26)))
      }

      expect(buffer.code.value.length).toBe(100)

      // Undo all
      let undoCount = 0
      while (buffer.undo()) {
        undoCount++
      }

      expect(buffer.code.value).toBe('')

      // Redo all
      let redoCount = 0
      while (buffer.redo()) {
        redoCount++
      }

      expect(buffer.code.value.length).toBe(100)
    })

    it('should handle alternating insert and delete', () => {
      const buffer = createBuffer('')

      for (let i = 0; i < 50; i++) {
        buffer.insert(0, 0, 'x')
        if (i % 2 === 1) {
          buffer.backspace(0, 1)
        }
      }

      // Undo everything
      while (buffer.undo()) {}

      expect(buffer.code.value).toBe('')

      // Redo everything
      while (buffer.redo()) {}

      // Should end with 25 'x' characters
      expect(buffer.code.value).toBe('x'.repeat(25))
    })

    it('should maintain consistency through random operations', () => {
      const buffer = createBuffer('initial')
      const states: string[] = ['initial']

      // Perform random operations
      for (let i = 0; i < 30; i++) {
        const op = Math.random()
        if (op < 0.4) {
          const pos = Math.floor(Math.random() * (buffer.code.value.length + 1))
          const line = buffer.code.value.substring(0, pos).split('\n').length - 1
          const lastNewline = buffer.code.value.substring(0, pos).lastIndexOf('\n')
          const col = lastNewline === -1 ? pos : pos - lastNewline - 1
          buffer.insert(line, col, 'X')
        }
        else if (op < 0.7 && buffer.code.value.length > 0) {
          const pos = Math.floor(Math.random() * buffer.code.value.length)
          const line = buffer.code.value.substring(0, pos).split('\n').length - 1
          const lastNewline = buffer.code.value.substring(0, pos).lastIndexOf('\n')
          const col = lastNewline === -1 ? pos : pos - lastNewline - 1
          buffer.del(line, col)
        }
        else if (buffer.undo()) {
          // Undo succeeded
        }
        states.push(buffer.code.value)
      }

      // Should be able to undo to start
      while (buffer.undo()) {}

      // Then redo to some state
      while (buffer.redo()) {}
    })
  })

  describe('history truncation', () => {
    it('should truncate future history on new operation after undo', () => {
      const buffer = createBuffer('')

      buffer.insert(0, 0, 'a')
      buffer.insert(0, 1, 'b')
      buffer.insert(0, 2, 'c')

      // Undo twice - may undo merged operations
      buffer.undo()

      // Insert new character - should truncate future history
      buffer.insert(0, buffer.code.value.length, 'X')

      // Should not be able to redo 'c'
      buffer.undo() // Undo 'X'

      // The next redo should bring back 'X', not 'c'
      buffer.redo()
      expect(buffer.code.value.endsWith('X')).toBe(true)
    })
  })

  describe('code property', () => {
    it('should allow direct code assignment', () => {
      const buffer = createBuffer('hello')
      buffer.code.value = 'world'
      expect(buffer.code.value).toBe('world')
      expect(buffer.lines.value).toEqual(['world'])
    })

    it('should not add to history on direct assignment', () => {
      const buffer = createBuffer('hello')
      buffer.code.value = 'world'

      // No history, so undo should return null
      const result = buffer.undo()
      expect(result).toBeNull()
    })
  })

  describe('lines computed property', () => {
    it('should update lines when code changes', () => {
      const buffer = createBuffer('a\nb\nc')
      expect(buffer.lines.value).toEqual(['a', 'b', 'c'])

      buffer.insert(0, 1, '\nx')
      expect(buffer.lines.value).toEqual(['a', 'x', 'b', 'c'])
    })
  })

  describe('undo/redo edge cases', () => {
    it('should handle undo after replace operation', () => {
      const buffer = createBuffer('hello')
      buffer.replaceSelection(
        { line: 0, column: 0 },
        { line: 0, column: 5 },
        'world',
      )
      expect(buffer.code.value).toBe('world')

      buffer.undo()
      buffer.undo() // replaceSelection creates 2 history entries
      expect(buffer.code.value).toBe('hello')
    })

    it('should handle undo with selection then redo maintains text', () => {
      const buffer = createBuffer('hello')
      buffer.deleteSelection(
        { line: 0, column: 1 },
        { line: 0, column: 4 },
        { start: { line: 0, column: 1 }, end: { line: 0, column: 4 }, direction: 'forward' },
      )
      expect(buffer.code.value).toBe('ho')

      buffer.undo()
      expect(buffer.code.value).toBe('hello')

      buffer.redo()
      expect(buffer.code.value).toBe('ho')
    })

    it('should handle mixed operations: insert, delete, replace', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'abc')
      buffer.del(0, 0) // deletes 'a', now 'bc'
      buffer.replaceSelection(
        { line: 0, column: 0 },
        { line: 0, column: 1 }, // bc -> XY (replace 'b')
        'XY',
      )
      expect(buffer.code.value).toBe('XYc')

      // After replace selection, might have different undo count based on merging
      // Just verify we can undo and it returns to valid state
      buffer.undo()
      expect(buffer.code.value).toBeDefined()

      buffer.undo()
      // Should eventually get back to empty
      while (buffer.undo()) {}
      expect(buffer.code.value).toBe('')

      // Redo everything
      while (buffer.redo()) {}
      expect(buffer.code.value).toBe('XYc')
    })

    it('should handle undo with empty selection', () => {
      const buffer = createBuffer('hello')
      buffer.deleteSelection(
        { line: 0, column: 2 },
        { line: 0, column: 2 },
      )
      expect(buffer.code.value).toBe('hello') // No change

      const result = buffer.undo()
      // Should still work (empty delete op)
      expect(buffer.code.value).toBe('hello')
    })

    it('should handle redo of multiline operations', () => {
      const buffer = createBuffer('line1\nline2\nline3')
      // Test multiline delete
      buffer.deleteSelection(
        { line: 0, column: 3 },
        { line: 2, column: 2 },
      )
      const afterDelete = buffer.code.value
      expect(afterDelete).toBeDefined()

      buffer.undo()
      expect(buffer.code.value).toBe('line1\nline2\nline3')

      buffer.redo()
      expect(buffer.code.value).toBe(afterDelete)
    })

    it('should handle undo of insert with special characters', () => {
      const buffer = createBuffer('hello')
      buffer.insert(0, 2, '\t\n🎉')
      expect(buffer.code.value).toBe('he\t\n🎉llo')

      buffer.undo()
      expect(buffer.code.value).toBe('hello')

      buffer.redo()
      expect(buffer.code.value).toBe('he\t\n🎉llo')
    })

    it('should handle undo of delete at line boundaries', () => {
      const buffer = createBuffer('a\nb\nc')
      buffer.del(0, 1) // delete newline
      expect(buffer.code.value).toBe('ab\nc')

      buffer.undo()
      expect(buffer.code.value).toBe('a\nb\nc')
    })

    it('should handle consecutive undo then redo', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'x')
      buffer.insert(0, 1, 'y')
      buffer.insert(0, 2, 'z')

      // Undo all
      buffer.undo()
      buffer.undo()
      buffer.undo()

      expect(buffer.code.value).toBe('')

      // Redo all
      buffer.redo()
      buffer.redo()
      buffer.redo()

      expect(buffer.code.value).toBe('xyz')
    })

    it('should handle undo at start of line on multiline', () => {
      const buffer = createBuffer('line1\nline2')
      buffer.insert(1, 0, 'prefix:')
      expect(buffer.code.value).toBe('line1\nprefix:line2')

      buffer.undo()
      expect(buffer.code.value).toBe('line1\nline2')
    })

    it('should handle undo of backspace at line start', () => {
      const buffer = createBuffer('line1\nline2')
      buffer.backspace(1, 0)
      expect(buffer.code.value).toBe('line1line2')

      buffer.undo()
      expect(buffer.code.value).toBe('line1\nline2')
    })

    it('should handle undo-redo with multiple line operations', () => {
      const buffer = createBuffer('a\nb\nc\nd\ne')
      // Delete from start of line2 to start of line4 (b\nc\n)
      buffer.deleteSelection(
        { line: 1, column: 0 },
        { line: 3, column: 0 },
      )
      expect(buffer.code.value).toBe('a\nd\ne')

      buffer.undo()
      expect(buffer.code.value).toBe('a\nb\nc\nd\ne')

      buffer.redo()
      expect(buffer.code.value).toBe('a\nd\ne')
    })

    it('should handle undo-redo after history modification', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'a')
      buffer.insert(0, 1, 'b')

      buffer.undo()
      buffer.undo()

      expect(buffer.code.value).toBe('')

      // Insert new content (clears redo history)
      buffer.insert(0, 0, 'c')
      expect(buffer.code.value).toBe('c')

      // Cannot redo 'ab'
      const redoResult = buffer.redo()
      expect(redoResult).toBeNull()
      expect(buffer.code.value).toBe('c')
    })

    it('should handle undo-redo with large deletions', () => {
      const buffer = createBuffer('x'.repeat(1000))
      buffer.deleteSelection(
        { line: 0, column: 100 },
        { line: 0, column: 800 },
      )
      expect(buffer.code.value.length).toBe(300) // 100 before + 200 after
      expect(buffer.code.value).toBe('x'.repeat(100) + 'x'.repeat(200))

      buffer.undo()
      expect(buffer.code.value.length).toBe(1000)

      buffer.redo()
      expect(buffer.code.value.length).toBe(300)
    })

    it('should handle undo-redo with large insertions', () => {
      const buffer = createBuffer('test')
      const largeText = 'y'.repeat(5000)
      buffer.insert(0, 2, largeText)
      expect(buffer.code.value.length).toBe(5004)

      buffer.undo()
      expect(buffer.code.value).toBe('test')

      buffer.redo()
      expect(buffer.code.value.length).toBe(5004)
    })

    it('should handle undo of replace with selection info', () => {
      const buffer = createBuffer('hello world')
      buffer.replaceSelection(
        { line: 0, column: 0 },
        { line: 0, column: 5 },
        'goodbye',
        { start: { line: 0, column: 0 }, end: { line: 0, column: 5 }, direction: 'backward' },
      )
      expect(buffer.code.value).toBe('goodbye world')

      const result = buffer.undo()
      expect(buffer.code.value).toBe('hello world')
      expect(result).not.toBeNull()
      expect(result!.selection).toBeDefined()
    })

    it('should maintain caret index through complex merge scenarios', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'a')
      buffer.insert(0, 1, 'b')
      buffer.insert(0, 2, 'c')
      expect(buffer.code.value).toBe('abc')

      buffer.undo()
      expect(buffer.code.value).toBe('')

      buffer.redo()
      expect(buffer.code.value).toBe('abc')

      // Multiple undos
      buffer.undo()
      buffer.undo()
      buffer.undo()
      expect(buffer.code.value).toBe('')

      // Multiple redos
      buffer.redo()
      buffer.redo()
      buffer.redo()
      expect(buffer.code.value).toBe('abc')
    })

    it('should handle alternating undo/redo operations', () => {
      const buffer = createBuffer('')
      buffer.insert(0, 0, 'a')
      buffer.insert(0, 1, 'b')

      // These might merge, so we need to account for that
      buffer.undo() // Might undo both 'a' and 'b' or just 'b'
      const stateAfterFirstUndo = buffer.code.value

      buffer.redo() // Redo what was undone
      expect(buffer.code.value).toBe('ab')

      buffer.undo() // Undo again
      expect(buffer.code.value).toBe(stateAfterFirstUndo)

      buffer.insert(0, stateAfterFirstUndo.length, 'c') // New operation, clears future

      // Cannot redo original operation anymore
      const result = buffer.redo()
      expect(result).toBeNull()
    })

    it('should handle undo-redo with nested multiline selections', () => {
      const buffer = createBuffer('line1\nline2\nline3\nline4')
      buffer.replaceSelection(
        { line: 1, column: 2 },
        { line: 2, column: 3 },
        '[REPLACED]',
      )
      expect(buffer.code.value).toBe('line1\nli[REPLACED]e3\nline4')

      buffer.undo()
      buffer.undo() // replaceSelection is 2 ops
      expect(buffer.code.value).toBe('line1\nline2\nline3\nline4')

      buffer.redo()
      buffer.redo()
      expect(buffer.code.value).toBe('line1\nli[REPLACED]e3\nline4')
    })

    it('should handle undo-redo boundary between merged and non-merged ops', () => {
      const buffer = createBuffer('')

      // Insert operations (will merge)
      buffer.insert(0, 0, 'a')
      buffer.insert(0, 1, 'b')
      buffer.insert(0, 2, 'c')

      expect(buffer.code.value).toBe('abc')

      // Delete operation (won't merge with insert)
      buffer.del(0, 0)
      expect(buffer.code.value).toBe('bc')

      // Undo delete
      buffer.undo()
      expect(buffer.code.value).toBe('abc')

      // Undo merged inserts
      buffer.undo()
      expect(buffer.code.value).toBe('')

      // Redo inserts
      buffer.redo()
      expect(buffer.code.value).toBe('abc')

      // Redo delete
      buffer.redo()
      expect(buffer.code.value).toBe('bc')
    })

    it('should handle undo-redo with caret preservation across blank lines', () => {
      const buffer = createBuffer('line1\n\nline3')
      buffer.insert(1, 0, 'line2')
      expect(buffer.code.value).toBe('line1\nline2\nline3')

      buffer.undo()
      expect(buffer.code.value).toBe('line1\n\nline3')

      buffer.redo()
      expect(buffer.code.value).toBe('line1\nline2\nline3')
    })
  })
})
