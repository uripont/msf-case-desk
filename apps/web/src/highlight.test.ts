import { describe, expect, test } from 'vitest'

import { resolveRange, splitByHighlights } from './quoroom/highlight'

const range = (id: string, from: number, to: number, quoted: string) => ({
  id,
  from,
  to,
  quoted,
})

describe('resolveRange', () => {
  test('keeps a range whose quoted text is where it was made', () => {
    const r = range('c1', 4, 7, 'big')
    expect(resolveRange('the big dog', r)).toEqual(r)
  })

  test('moves to the nearest occurrence when the text has shifted', () => {
    expect(resolveRange('so the big dog and a big cat', range('c1', 24, 27, 'big'))).toEqual(
      range('c1', 21, 24, 'big'),
    )
  })

  test('is none when the quoted text is gone', () => {
    expect(resolveRange('the small dog', range('c1', 4, 7, 'big'))).toBeUndefined()
  })
})

describe('splitByHighlights', () => {
  test('a text with no ranges is one plain part', () => {
    expect(splitByHighlights('abc', 0, [])).toEqual([
      { text: 'abc', commentIds: [] },
    ])
  })

  test('cuts the text at the range and names the comment', () => {
    expect(splitByHighlights('the big dog', 0, [range('c1', 4, 7, 'big')])).toEqual([
      { text: 'the ', commentIds: [] },
      { text: 'big', commentIds: ['c1'] },
      { text: ' dog', commentIds: [] },
    ])
  })

  test('uses the offset of the text inside the anchor text', () => {
    expect(splitByHighlights('big dog', 4, [range('c1', 4, 7, 'big')])).toEqual([
      { text: 'big', commentIds: ['c1'] },
      { text: ' dog', commentIds: [] },
    ])
  })

  test('overlapping ranges share the part they both cover', () => {
    const parts = splitByHighlights('abcdef', 0, [
      range('c1', 0, 4, 'abcd'),
      range('c2', 2, 6, 'cdef'),
    ])
    expect(parts).toEqual([
      { text: 'ab', commentIds: ['c1'] },
      { text: 'cd', commentIds: ['c1', 'c2'] },
      { text: 'ef', commentIds: ['c2'] },
    ])
  })
})
