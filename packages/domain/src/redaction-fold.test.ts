import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { foldForTest } from './redaction'

// NOTE: the folding as it was before the ASCII fast path (stage 10, CPU), kept
// here as the reference: the fast path must give the same text and the same
// offsets for every input, in both modes.
const SPECIAL: Readonly<Record<string, string>> = {
  ß: 'ss',
  ø: 'o',
  đ: 'd',
  ł: 'l',
  æ: 'ae',
  œ: 'oe',
  ı: 'i',
  ς: 'σ',
  '’': "'",
  '‘': "'",
  ʼ: "'",
  '`': "'",
  '´': "'",
  '‐': '-',
  '‑': '-',
  '–': '-',
  '—': '-',
  '−': '-',
}
const TRANSPARENT = /^[\p{M}\p{Cf}]$/u
const FORMAT = /^\p{Cf}$/u
const MARK = '￿'
const SPACE = /^\s$/u
const WORD = /[\p{L}\p{N}]/u

const reference = (input: string, loose: boolean) => {
  const text: Array<string> = []
  const starts: Array<number> = []
  const ends: Array<number> = []
  let lastFirst = -1
  let offset = 0
  const pushRun = (char: string, start: number, end: number) => {
    if (text.length > 0 && text[text.length - 1] === char) {
      ends[ends.length - 1] = end
    } else {
      lastFirst = text.length
      text.push(char)
      starts.push(start)
      ends.push(end)
    }
  }
  const pushSpace = (start: number, end: number) => pushRun(' ', start, end)
  for (const ch of input) {
    const start = offset
    const end = offset + ch.length
    offset = end
    if (FORMAT.test(ch) || ch === MARK) {
      pushRun(MARK, start, end)
      continue
    }
    if (TRANSPARENT.test(ch)) {
      for (let i = Math.max(lastFirst, 0); i < ends.length; i++) ends[i] = end
      continue
    }
    if (SPACE.test(ch)) {
      pushSpace(start, end)
      continue
    }
    const lower = ch.toLowerCase()
    const folded = (SPECIAL[lower] ?? lower).normalize('NFKD').replace(/\p{M}/gu, '')
    lastFirst = text.length
    for (const c of folded) {
      if (loose && !WORD.test(c)) {
        pushSpace(start, end)
        continue
      }
      for (const unit of c) {
        text.push(unit)
        starts.push(start)
        ends.push(end)
      }
    }
  }
  return { text: text.join(''), starts, ends }
}

const pieces = [
  ...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)),
  'é', 'É', 'ß', 'ø', 'Æ', 'ı', 'İ', 'ς', '’', '´', '—', '−', '́', '​',
  '­', '⁠', '￿', ' ', ' ', '﻿', 'ﬁ', '①', 'Ａ', '漢',
  'ไ', '😀', 'Ω', 'Ж', 'ǅ', 'ẞ',
]

describe('folding for redaction: the ASCII path', () => {
  test('every ASCII character, alone and around others, folds as before', () => {
    for (const loose of [false, true]) {
      for (let code = 0; code < 128; code += 1) {
        const ch = String.fromCharCode(code)
        for (const input of [ch, `a${ch}b`, `${ch}́`, `​${ch}​`, `${ch}${ch} ${ch}`]) {
          expect(foldForTest(input, loose)).toEqual(reference(input, loose))
        }
      }
    }
  })

  test('any mix of ASCII and other characters folds as before (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.constantFrom(...pieces), fc.string({ unit: 'binary', maxLength: 4 })), { maxLength: 40 }),
        fc.boolean(),
        (parts, loose) => {
          const input = parts.join('')
          expect(foldForTest(input, loose)).toEqual(reference(input, loose))
        },
      ),
      { numRuns: 3000 },
    )
  })
})
