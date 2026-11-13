import { describe, expect, test } from 'vitest'

import { INTAKE_TEMPLATE } from './builtin-templates'
import type { Person } from './people'
import {
  canonicalJson,
  highlightedTexts,
  markedParts,
  redactedSectionOf,
} from './redaction-preview'

const PEOPLE: ReadonlyArray<Person> = [
  { id: 'p1', name: 'Ines Marlow', label: 'Person 1', aliases: ['Ines'] },
]

describe('canonicalJson', () => {
  test('gives the same text whatever order the keys were built in', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } })).toBe(
      canonicalJson({ a: { c: 2, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    )
  })

  test('keeps the order of an array', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]))
  })
})

describe('redactedSectionOf', () => {
  test('replaces the alias and is the same for the same section however its keys are ordered', () => {
    const id = INTAKE_TEMPLATE.sections[0]?.id ?? ''
    const itemId = INTAKE_TEMPLATE.sections[0]?.items[0]?.id ?? ''
    const make = (first: boolean) => ({
      values: {
        [itemId]: first
          ? { type: 'text' as const, text: 'Ines Marlow was there' }
          : { text: 'Ines Marlow was there', type: 'text' as const },
      },
      sections: {},
    })
    const one = redactedSectionOf(INTAKE_TEMPLATE, PEOPLE, id, make(true))
    const two = redactedSectionOf(INTAKE_TEMPLATE, PEOPLE, id, make(false))
    expect(JSON.stringify(one)).not.toContain('Marlow')
    expect(canonicalJson(one)).toBe(canonicalJson(two))
  })
})

describe('markedParts', () => {
  test('cuts a text at every label and the placeholder, longest first', () => {
    const marks = highlightedTexts([
      ...PEOPLE,
      { id: 'p2', name: 'X', label: 'Person 10', aliases: [] },
    ])
    expect(markedParts('Person 10 met person 1. Image withheld.', marks)).toEqual([
      { text: 'Person 10', marked: true },
      { text: ' met ', marked: false },
      { text: 'person 1', marked: true },
      { text: '. ', marked: false },
      { text: 'Image withheld', marked: true },
      { text: '.', marked: false },
    ])
  })

  test('a text with nothing to mark is one plain part', () => {
    expect(markedParts('Nothing here', ['Person 1'])).toEqual([
      { text: 'Nothing here', marked: false },
    ])
    expect(markedParts('', ['Person 1'])).toEqual([{ text: '', marked: false }])
  })

  test('marks the right range when lowercasing changes the length of the text', () => {
    const text = '\u0130stanbul: Person 1 said'
    const parts = markedParts(text, ['Person 1'])
    expect(parts.map(part => part.text).join('')).toBe(text)
    expect(parts.filter(part => part.marked)).toEqual([
      { text: 'Person 1', marked: true },
    ])
    expect(markedParts('\u0130 Image withheld \u0130', ['Image withheld'])).toEqual([
      { text: '\u0130 ', marked: false },
      { text: 'Image withheld', marked: true },
      { text: ' \u0130', marked: false },
    ])
  })
})
