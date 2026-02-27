import { describe, expect, it } from 'bun:test'
import { SkipString } from '../src/lib/skip-string.ts'

describe('SkipString', () => {
  describe('constructor', () => {
    it('should create empty SkipString', () => {
      const s = new SkipString()
      expect(s.length).toBe(0)
      expect(s.toString()).toBe('')
    })

    it('should accept custom options', () => {
      const s = new SkipString({ levels: 5, bias: 0.5, chunkSize: 100 })
      expect(s.length).toBe(0)
    })
  })

  describe('set', () => {
    it('should set text on empty SkipString', () => {
      const s = new SkipString()
      s.set('hello')
      expect(s.toString()).toBe('hello')
      expect(s.length).toBe(5)
    })

    it('should replace existing text', () => {
      const s = new SkipString()
      s.set('hello')
      s.set('world')
      expect(s.toString()).toBe('world')
      expect(s.length).toBe(5)
    })

    it('should handle empty string', () => {
      const s = new SkipString()
      s.set('hello')
      s.set('')
      expect(s.toString()).toBe('')
      expect(s.length).toBe(0)
    })

    it('should handle multiline text', () => {
      const s = new SkipString()
      s.set('line1\nline2\nline3')
      expect(s.toString()).toBe('line1\nline2\nline3')
    })

    it('should handle large text with chunking', () => {
      const s = new SkipString({ chunkSize: 100 })
      const largeText = 'a'.repeat(500)
      s.set(largeText)
      expect(s.toString()).toBe(largeText)
      expect(s.length).toBe(500)
    })
  })

  describe('insert', () => {
    it('should insert at beginning', () => {
      const s = new SkipString()
      s.set('world')
      s.insert(0, 'hello ')
      expect(s.toString()).toBe('hello world')
    })

    it('should insert at end', () => {
      const s = new SkipString()
      s.set('hello')
      s.insert(5, ' world')
      expect(s.toString()).toBe('hello world')
    })

    it('should insert in middle', () => {
      const s = new SkipString()
      s.set('helloworld')
      s.insert(5, ' ')
      expect(s.toString()).toBe('hello world')
    })

    it('should insert into empty string', () => {
      const s = new SkipString()
      s.insert(0, 'hello')
      expect(s.toString()).toBe('hello')
    })

    it('should handle multiple consecutive inserts', () => {
      const s = new SkipString()
      s.insert(0, 'a')
      s.insert(1, 'b')
      s.insert(2, 'c')
      expect(s.toString()).toBe('abc')
    })

    it('should handle insert at same position multiple times', () => {
      const s = new SkipString()
      s.set('ac')
      s.insert(1, 'b')
      expect(s.toString()).toBe('abc')
    })

    it('should handle unicode characters', () => {
      const s = new SkipString()
      s.set('hello')
      s.insert(5, ' 世界')
      expect(s.toString()).toBe('hello 世界')
    })

    it('should handle emoji', () => {
      const s = new SkipString()
      s.insert(0, '👋🌍')
      expect(s.toString()).toBe('👋🌍')
    })
  })

  describe('remove', () => {
    it('should remove from beginning', () => {
      const s = new SkipString()
      s.set('hello world')
      s.remove([0, 6])
      expect(s.toString()).toBe('world')
    })

    it('should remove from end', () => {
      const s = new SkipString()
      s.set('hello world')
      s.remove([5, 11])
      expect(s.toString()).toBe('hello')
    })

    it('should remove from middle', () => {
      const s = new SkipString()
      s.set('hello world')
      s.remove([5, 6])
      expect(s.toString()).toBe('helloworld')
    })

    it('should remove entire string', () => {
      const s = new SkipString()
      s.set('hello')
      s.remove([0, 5])
      expect(s.toString()).toBe('')
      expect(s.length).toBe(0)
    })

    it('should remove single character', () => {
      const s = new SkipString()
      s.set('hello')
      s.remove([2, 3])
      expect(s.toString()).toBe('helo')
    })

    it('should handle removing zero-length range', () => {
      const s = new SkipString()
      s.set('hello')
      s.remove([2, 2])
      expect(s.toString()).toBe('hello')
    })

    it('should throw on out of bounds range', () => {
      const s = new SkipString()
      s.set('hello')
      expect(() => s.remove([0, 10])).toThrow()
    })

    it('should handle multiple consecutive removes', () => {
      const s = new SkipString()
      s.set('abcdef')
      s.remove([4, 5]) // remove 'e'
      s.remove([3, 4]) // remove 'd'
      s.remove([2, 3]) // remove 'c'
      expect(s.toString()).toBe('abf')
    })
  })

  describe('removeCharAt', () => {
    it('should remove character at index', () => {
      const s = new SkipString()
      s.set('hello')
      s.removeCharAt(2)
      expect(s.toString()).toBe('helo')
    })

    it('should remove first character', () => {
      const s = new SkipString()
      s.set('hello')
      s.removeCharAt(0)
      expect(s.toString()).toBe('ello')
    })

    it('should remove last character', () => {
      const s = new SkipString()
      s.set('hello')
      s.removeCharAt(4)
      expect(s.toString()).toBe('hell')
    })
  })

  describe('substring', () => {
    it('should get substring from beginning', () => {
      const s = new SkipString()
      s.set('hello world')
      expect(s.substring(0, 5)).toBe('hello')
    })

    it('should get substring from end', () => {
      const s = new SkipString()
      s.set('hello world')
      expect(s.substring(6, 11)).toBe('world')
    })

    it('should get substring from middle', () => {
      const s = new SkipString()
      s.set('hello world')
      expect(s.substring(3, 8)).toBe('lo wo')
    })

    it('should get entire string', () => {
      const s = new SkipString()
      s.set('hello')
      expect(s.substring(0, 5)).toBe('hello')
    })

    it('should get single character', () => {
      const s = new SkipString()
      s.set('hello')
      expect(s.substring(2, 3)).toBe('l')
    })

    it('should return empty for zero-length range', () => {
      const s = new SkipString()
      s.set('hello')
      expect(s.substring(2, 2)).toBe('')
    })

    it('should return empty for empty string', () => {
      const s = new SkipString()
      expect(s.substring(0, 0)).toBe('')
    })

    it('should handle multiline substring', () => {
      const s = new SkipString()
      s.set('line1\nline2\nline3')
      expect(s.substring(0, 5)).toBe('line1')
      expect(s.substring(6, 11)).toBe('line2')
    })
  })

  describe('getRange', () => {
    it('should get range like substring', () => {
      const s = new SkipString()
      s.set('hello world')
      expect(s.getRange([0, 5])).toBe('hello')
      expect(s.getRange([6, 11])).toBe('world')
    })
  })

  describe('get', () => {
    it('should get search result at offset', () => {
      const s = new SkipString()
      s.set('hello')
      const result = s.get(2)
      expect(result).toBeDefined()
      expect(result.offset).toBeDefined()
    })
  })

  describe('copy', () => {
    it('should create independent copy', () => {
      const s = new SkipString()
      s.set('hello')
      const copy = s.copy()
      expect(copy.toString()).toBe('hello')

      s.set('world')
      expect(s.toString()).toBe('world')
      expect(copy.toString()).toBe('hello')
    })

    it('should copy empty string', () => {
      const s = new SkipString()
      const copy = s.copy()
      expect(copy.toString()).toBe('')
      expect(copy.length).toBe(0)
    })

    it('should copy large string', () => {
      const s = new SkipString()
      const text = 'a'.repeat(1000)
      s.set(text)
      const copy = s.copy()
      expect(copy.toString()).toBe(text)
    })
  })

  describe('toString', () => {
    it('should return string representation', () => {
      const s = new SkipString()
      s.set('hello world')
      expect(s.toString()).toBe('hello world')
    })

    it('should return empty string for empty SkipString', () => {
      const s = new SkipString()
      expect(s.toString()).toBe('')
    })
  })

  describe('length', () => {
    it('should return correct length', () => {
      const s = new SkipString()
      expect(s.length).toBe(0)
      s.set('hello')
      expect(s.length).toBe(5)
      s.insert(5, ' world')
      expect(s.length).toBe(11)
      s.remove([0, 6])
      expect(s.length).toBe(5)
    })
  })

  describe('complex operations', () => {
    it('should handle insert-remove-insert sequence', () => {
      const s = new SkipString()
      s.insert(0, 'hello')
      s.remove([2, 4])
      s.insert(2, 'XY')
      expect(s.toString()).toBe('heXYo')
    })

    it('should handle many small inserts', () => {
      const s = new SkipString()
      for (let i = 0; i < 100; i++) {
        s.insert(i, String.fromCharCode(97 + (i % 26)))
      }
      expect(s.length).toBe(100)
    })

    it('should handle alternating insert and remove', () => {
      const s = new SkipString()
      s.insert(0, 'a')
      s.insert(1, 'b')
      s.remove([0, 1])
      s.insert(0, 'c')
      s.insert(2, 'd')
      s.remove([1, 2])
      expect(s.toString()).toBe('cd')
    })

    it('should handle building text character by character', () => {
      const s = new SkipString()
      const text = 'hello world'
      for (let i = 0; i < text.length; i++) {
        s.insert(i, text[i])
      }
      expect(s.toString()).toBe(text)
    })

    it('should handle removing text character by character from end', () => {
      const s = new SkipString()
      s.set('hello')
      for (let i = 4; i >= 0; i--) {
        s.removeCharAt(i)
      }
      expect(s.toString()).toBe('')
      expect(s.length).toBe(0)
    })

    it('should handle removing text character by character from start', () => {
      const s = new SkipString()
      s.set('hello')
      for (let i = 0; i < 5; i++) {
        s.removeCharAt(0)
      }
      expect(s.toString()).toBe('')
      expect(s.length).toBe(0)
    })

    it('should handle replace operation (remove then insert)', () => {
      const s = new SkipString()
      s.set('hello world')
      s.remove([6, 11])
      s.insert(6, 'universe')
      expect(s.toString()).toBe('hello universe')
    })

    it('should handle multiline editing', () => {
      const s = new SkipString()
      s.set('line1\nline2\nline3')
      s.remove([6, 12]) // remove "line2\n"
      expect(s.toString()).toBe('line1\nline3')
      s.insert(6, 'new\n')
      expect(s.toString()).toBe('line1\nnew\nline3')
    })
  })

  describe('edge cases', () => {
    it('should handle very long single insert', () => {
      const s = new SkipString()
      const longText = 'x'.repeat(10000)
      s.set(longText)
      expect(s.length).toBe(10000)
      expect(s.toString()).toBe(longText)
    })

    it('should handle special characters', () => {
      const s = new SkipString()
      s.set('tab:\there\nnewline\r\nwindows')
      expect(s.toString()).toBe('tab:\there\nnewline\r\nwindows')
    })

    it('should handle null-like strings', () => {
      const s = new SkipString()
      s.set('null')
      expect(s.toString()).toBe('null')
      s.set('undefined')
      expect(s.toString()).toBe('undefined')
    })

    it('should maintain consistency after many operations', () => {
      const s = new SkipString()
      let expected = ''

      for (let i = 0; i < 50; i++) {
        const op = Math.random()
        if (op < 0.5 || expected.length === 0) {
          const pos = Math.floor(Math.random() * (expected.length + 1))
          const char = String.fromCharCode(97 + Math.floor(Math.random() * 26))
          s.insert(pos, char)
          expected = expected.slice(0, pos) + char + expected.slice(pos)
        }
        else {
          const pos = Math.floor(Math.random() * expected.length)
          s.removeCharAt(pos)
          expected = expected.slice(0, pos) + expected.slice(pos + 1)
        }
        expect(s.toString()).toBe(expected)
        expect(s.length).toBe(expected.length)
      }
    })

    it('should handle inserting at node boundaries', () => {
      const s = new SkipString({ chunkSize: 5 })
      s.set('abcdefghij') // Will create chunks
      s.insert(5, 'X')
      expect(s.toString()).toBe('abcdeXfghij')
    })

    it('should handle removing across node boundaries', () => {
      const s = new SkipString({ chunkSize: 5 })
      s.set('abcdefghij')
      s.remove([3, 7])
      expect(s.toString()).toBe('abchij')
    })
  })

  describe('joinString', () => {
    it('should join with delimiter', () => {
      const s = new SkipString({ chunkSize: 3 })
      s.set('abcdef')
      // The join depends on internal chunking, just verify it works
      const joined = s.joinString(',')
      expect(typeof joined).toBe('string')
    })
  })

  describe('stress tests', () => {
    it('should handle rapid inserts and removes', () => {
      const s = new SkipString()
      s.set('initial')

      for (let i = 0; i < 100; i++) {
        s.insert(0, 'x')
        s.removeCharAt(0)
      }

      expect(s.toString()).toBe('initial')
    })

    it('should handle growing and shrinking', () => {
      const s = new SkipString()

      // Grow
      for (let i = 0; i < 100; i++) {
        s.insert(s.length, 'a')
      }
      expect(s.length).toBe(100)

      // Shrink
      for (let i = 0; i < 100; i++) {
        s.removeCharAt(0)
      }
      expect(s.length).toBe(0)
    })

    it('should handle random access patterns', () => {
      const s = new SkipString()
      s.set('abcdefghijklmnopqrstuvwxyz')

      // Random substrings
      for (let i = 0; i < 50; i++) {
        const start = Math.floor(Math.random() * 20)
        const end = start + Math.floor(Math.random() * 6) + 1
        const sub = s.substring(start, Math.min(end, 26))
        expect(sub).toBe('abcdefghijklmnopqrstuvwxyz'.substring(start, Math.min(end, 26)))
      }
    })
  })
})
