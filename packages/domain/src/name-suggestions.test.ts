import { describe, expect, test } from 'vitest'

import {
  CONTENT_SCHEMA_VERSION,
  type Person,
  contentTexts,
  suggestNames,
  suggestNamesInText,
} from './index'
import { MINI_TEMPLATE } from './testing/content'

const texts = (
  text: string,
  people: ReadonlyArray<Person> = [],
  template = MINI_TEMPLATE,
) => suggestNamesInText(text, people, template).map(s => s.text)

describe('suggestNames', () => {
  test('capitalised words in the middle of a sentence', () => {
    expect(
      texts('We heard that Maria Lopez and Okafor spoke with Bea.'),
    ).toEqual(['Bea', 'Maria Lopez', 'Okafor'])
  })
  test('a single capitalised word at the start of a sentence is skipped', () => {
    expect(texts('Yesterday it rained. Maria left.')).toEqual([])
    expect(texts('Then Maria left.\nMaria came back.')).toEqual(['Maria'])
  })
  test('a run of words at the start of a sentence is kept', () => {
    expect(texts('Maria Lopez left.')).toEqual(['Maria Lopez'])
  })
  test('titles do not end the sentence before the name', () => {
    expect(texts('He asked Dr. Okafor and Mrs. Diallo.')).toEqual([
      'Diallo',
      'Okafor',
    ])
    expect(texts('Dr. Okafor left.')).toEqual(['Okafor'])
  })
  test('accents, hyphens, apostrophes, particles and possessives', () => {
    expect(texts("They met José Álvarez, Jean-Pierre and O'Brien.")).toEqual([
      'Jean-Pierre',
      'José Álvarez',
      "O'Brien",
    ])
    expect(texts('Then Maria de la Cruz left.')).toEqual(['Maria de la Cruz'])
    expect(texts("It was Ana's idea; Ana's.")).toEqual(['Ana'])
    expect(texts('We saw Ödön and Łukasz.')).toEqual(['Ödön', 'Łukasz'])
  })
  test('acronyms, stopwords, months and the words of the template are skipped', () => {
    expect(
      texts('See the MSF report in March with The Hospital and Details.'),
    ).toEqual(['Hospital'])
    // "Details" and "Introduction" come from the template text.
    expect(texts('We read Introduction and Details.')).toEqual([])
  })
  test('people already listed are not suggested, partial names still are', () => {
    const people = [
      { id: 'p', name: 'Maria Lopez', label: 'Person 1', aliases: ['Mari'] },
    ]
    expect(texts('See Maria Lopez and Mari and Lopez.', people)).toEqual([
      'Lopez',
    ])
    expect(
      texts('See José and Jose.', [
        { id: 'j', name: 'Jose', label: 'Person 1', aliases: [] },
      ]),
    ).toEqual([])
  })
  test('counts, order and determinism', () => {
    const text = 'Then Bea saw Ana. Later Ana met Bea and Ana and Cy.'
    const first = suggestNamesInText(text, [], MINI_TEMPLATE)
    expect(first).toEqual([
      { text: 'Ana', count: 3 },
      { text: 'Bea', count: 2 },
      { text: 'Cy', count: 1 },
    ])
    expect(suggestNamesInText(text, [], MINI_TEMPLATE)).toEqual(first)
  })
  test('reads every text of a content', () => {
    const content = {
      schemaVersion: CONTENT_SCHEMA_VERSION as 1,
      templateId: MINI_TEMPLATE.id,
      templateVersion: MINI_TEMPLATE.version,
      sections: {
        extras: {
          notApplicable: { reason: 'Asked by Bea' },
          values: {
            'extras-text': {
              type: 'rich_text' as const,
              doc: {
                type: 'doc' as const,
                content: [
                  {
                    type: 'paragraph' as const,
                    content: [{ type: 'text' as const, text: 'Seen with Cy' }],
                  },
                  {
                    type: 'figure' as const,
                    attrs: {
                      imageId: 'i',
                      alt: 'photo of Dee',
                      safeToShare: false,
                    },
                  },
                ],
              },
            },
          },
          sections: {},
        },
      },
    }
    expect(contentTexts(content).length).toBe(4)
    expect(
      suggestNames({ content, people: [], template: MINI_TEMPLATE }).map(
        s => s.text,
      ),
    ).toEqual(['Bea', 'Cy', 'Dee'])
  })
  test('nothing for text without names', () => {
    expect(texts('')).toEqual([])
    expect(texts('all lower case, 12 March 2026.')).toEqual([])
  })
})
