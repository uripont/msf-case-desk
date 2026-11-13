import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import { type Person, redactedQuote } from './index'

// NOTE: An independent tokenizer, not the redaction code: lower-case letters
// and digits only, without accents.
const letters = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')

const grams = (word: string, size: number): ReadonlyArray<string> =>
  Array.from({ length: Math.max(0, word.length - size + 1) }, (_, at) =>
    word.slice(at, at + size),
  )

const PEOPLE: ReadonlyArray<Person> = [
  {
    id: 'p1',
    name: 'Zorana Veltkamp',
    label: 'Person A',
    aliases: ['Zorana', 'Veltkamp', 'Z. Veltkamp'],
  },
  { id: 'p2', name: 'Bertil Nwosu', label: 'Person B', aliases: ['Bertil', 'Nwosu'] },
]
// NOTE: every run of three or more letters of any alias.
const ALIAS_GRAMS = new Set(
  PEOPLE.flatMap(person =>
    [person.name, ...person.aliases].flatMap(alias => {
      const flat = letters(alias)
      return [3, 4, 5, 6].flatMap(size => grams(flat, size))
    }),
  ),
)
const leaked = (text: string): ReadonlyArray<string> => {
  const flat = letters(text)
  return [...ALIAS_GRAMS].filter(gram => flat.includes(gram))
}

const FILLER = ['Statement', 'of', 'about', 'the', 'case', 'and', 'said', 'on', 'Monday']
const NAMES = ['Zorana Veltkamp', 'Zorana', 'Veltkamp', 'Z. Veltkamp', 'Bertil Nwosu', 'Nwosu', 'Bertil']

describe('redactedQuote', () => {
  test('the filler words hold no run of letters of an alias (the property below is meaningful)', () => {
    expect(leaked(FILLER.join(' '))).toEqual([])
  })

  test('a selection cut inside a name takes the whole name, as its label', () => {
    const text = 'Statement of Zorana Veltkamp about the case'
    const from = text.indexOf('rana Velt')
    expect(redactedQuote(PEOPLE, text, from, from + 'rana Velt'.length)).toBe('Person A')
    const mid = text.indexOf('of Zor')
    expect(redactedQuote(PEOPLE, text, mid, mid + 'of Zor'.length)).toBe('of Person A')
  })

  test('a plain selection is cut at whole words', () => {
    expect(redactedQuote(PEOPLE, 'Statement of the case', 3, 12)).toBe('Statement of')
  })

  test('for any selection over a text with names, no run of three letters of an alias is left', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(fc.constantFrom(...FILLER), fc.constantFrom(...NAMES)),
          { minLength: 1, maxLength: 12 },
        ),
        fc.nat(),
        fc.nat(),
        (words, a, b) => {
          const text = words.join(' ')
          const low = a % (text.length + 1)
          const high = b % (text.length + 1)
          const quote = redactedQuote(PEOPLE, text, Math.min(low, high), Math.max(low, high))
          expect(leaked(quote)).toEqual([])
        },
      ),
      { numRuns: 2000 },
    )
  })
})
