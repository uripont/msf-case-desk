import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  BUILT_IN_TEMPLATES,
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
  type NumberedSection,
  type NumberingLevel,
  type ReportContent,
  type Template,
  emptyContent,
  entryLabel,
  formatNumber,
  numberSections,
  sectionStates,
  toLetters,
  toRoman,
} from './index'
import {
  MINI_TEMPLATE,
  markAllNotApplicable,
  templateWithContentArbitrary,
  withEndAnswer,
  withoutEndAnswers,
} from './testing/content'
import { PANEL_TEMPLATE } from './testing/templates'

const shown = (template: Template, content: ReportContent) =>
  numberSections(template, content).map(
    section => `${section.number?.full ?? '-'} ${section.sectionId}`,
  )

const fromLetters = (letters: string): number =>
  [...letters].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0)

describe('number formats', () => {
  test('roman numbers', () => {
    expect([1, 4, 9, 14, 40, 90, 400, 1994, 3999].map(toRoman)).toEqual([
      'I',
      'IV',
      'IX',
      'XIV',
      'XL',
      'XC',
      'CD',
      'MCMXCIV',
      'MMMCMXCIX',
    ])
  })

  test('letters go on past Z, as a spreadsheet does', () => {
    expect([1, 2, 26, 27, 28, 52, 53, 702, 703].map(toLetters)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ])
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), n => {
        expect(fromLetters(toLetters(n))).toBe(n)
      }),
    )
  })

  test('every style, case and suffix', () => {
    const level = (
      style: NumberingLevel['style'],
      letterCase?: 'upper' | 'lower',
    ): NumberingLevel => ({
      style,
      ...(letterCase === undefined ? {} : { letterCase }),
      suffix: '.',
    })
    expect(formatNumber(12, level('arabic'))).toBe('12')
    expect(formatNumber(4, level('roman', 'upper'))).toBe('IV')
    expect(formatNumber(4, level('roman', 'lower'))).toBe('iv')
    expect(formatNumber(2, level('letters', 'upper'))).toBe('B')
    expect(formatNumber(28, level('letters', 'lower'))).toBe('ab')
  })

  test('entry labels count from one', () => {
    expect(entryLabel('Allegation', 0)).toBe('Allegation 1')
    expect(entryLabel('Witness', 2)).toBe('Witness 3')
  })
})

describe('numbering', () => {
  test('the intake: letters A to G, with the unnumbered parts left out', () => {
    expect(shown(INTAKE_TEMPLATE, emptyContent(INTAKE_TEMPLATE))).toEqual([
      '- case-details',
      'A. summary',
      'B. allegations',
      'C. jurisdiction-materiality',
      'C.1. jurisdiction',
      'C.2. materiality',
      'D. witnesses',
      'E. results',
      '- research-results',
      '- related-cases',
      '- other-background',
      '- context-risks',
      '- evidence-risk',
      '- working-environment',
      '- cultural-issues',
      '- logistics-security',
      '- technical-issues',
      'F. assessment',
      'G. recommendation',
      '- sign-off',
      '- committee-conclusion',
    ])
  })

  test('the investigation report: roman, letters, and no number for front matter', () => {
    const numbers = shown(
      INVESTIGATION_TEMPLATE,
      emptyContent(INVESTIGATION_TEMPLATE),
    )
    expect(numbers.slice(0, 2)).toEqual([
      '- report-details',
      '- executive-summary',
    ])
    expect(numbers).toContain('I. introduction')
    expect(numbers).toContain('VII. recommendation')
    expect(numbers).toContain('VII.B. recommend-organisation')
    const front = numberSections(
      INVESTIGATION_TEMPLATE,
      emptyContent(INVESTIGATION_TEMPLATE),
    )
    expect(
      front
        .filter(section => section.frontMatter)
        .map(section => section.sectionId),
    ).toEqual(['report-details', 'executive-summary'])
  })

  const entry = (id: string, title?: string) => ({
    id,
    ...(title === undefined ? {} : { title }),
    values: {},
    sections: {},
  })
  const mini = (ids: ReadonlyArray<string>): ReportContent => ({
    ...emptyContent(MINI_TEMPLATE),
    sections: {
      things: {
        values: {},
        sections: {
          thing: {
            values: {},
            sections: {},
            entries: ids.map(id => entry(id, `Title ${id}`)),
          },
        },
      },
    },
  })

  test('front matter, unnumbered sections, repeat entries as numbered subsections', () => {
    const result = numberSections(MINI_TEMPLATE, mini(['x', 'y', 'z']))
    expect(shown(MINI_TEMPLATE, mini(['x', 'y', 'z']))).toEqual([
      '- cover',
      'I. details',
      'II. extras',
      'III. things',
      'III.a) thing',
      'III.a.1. thing-facts',
      'III.b) thing',
      'III.b.1. thing-facts',
      'III.c) thing',
      'III.c.1. thing-facts',
      'III.d) things-summary',
      '- sign',
    ])
    const entries = result.filter(section => section.sectionId === 'thing')
    expect(
      entries.map(section => [
        section.number?.own,
        section.title,
        section.entryId,
      ]),
    ).toEqual([
      ['a)', 'Title x', 'x'],
      ['b)', 'Title y', 'y'],
      ['c)', 'Title z', 'z'],
    ])
    // Each entry has its own key; the keys are unique.
    const keys = result.map(section => section.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('with no entry the repeatable subsection takes no number, and falls back to its template title', () => {
    expect(shown(MINI_TEMPLATE, mini([]))).toContain('III.a) things-summary')
    const untitled = numberSections(MINI_TEMPLATE, {
      ...emptyContent(MINI_TEMPLATE),
      sections: {
        things: {
          values: {},
          sections: {
            thing: { values: {}, sections: {}, entries: [entry('q')] },
          },
        },
      },
    })
    expect(untitled.find(section => section.entryId === 'q')?.title).toBe(
      'Thing',
    )
  })

  test('the first numbered section after the front matter is the first number', () => {
    const first = numberSections(
      MINI_TEMPLATE,
      emptyContent(MINI_TEMPLATE),
    ).find(section => section.number !== undefined)
    expect(first?.number).toEqual({ own: 'I.', full: 'I.' })
  })

  test('children of an unnumbered section show only their own level', () => {
    const template: Template = {
      ...PANEL_TEMPLATE,
      sections: [
        {
          id: 'outer',
          title: 'Outer',
          requirement: 'required',
          frontMatter: false,
          numbered: false,
          items: [],
          sections: [
            {
              id: 'inner',
              title: 'Inner',
              requirement: 'required',
              frontMatter: false,
              numbered: true,
              items: [
                { id: 'x', label: 'x', requirement: 'required', type: 'text' },
              ],
              sections: [],
            },
          ],
        },
      ],
    }
    expect(shown(template, emptyContent(template))).toEqual([
      '- outer',
      'a. inner',
    ])
  })

  test('the conclusion follows the body', () => {
    const intake = INTAKE_TEMPLATE
    const result = numberSections(intake, emptyContent(intake))
    expect(result[result.length - 1]?.conclusion).toBe(true)
    expect(result.filter(section => section.conclusion)).toHaveLength(1)
  })

  test('numbering is the same however the sections are marked or ended (built-in templates)', () => {
    for (const template of [
      ...BUILT_IN_TEMPLATES,
      PANEL_TEMPLATE,
      MINI_TEMPLATE,
    ]) {
      const content = emptyContent(template)
      const marked = markAllNotApplicable(template, content)
      expect(numberSections(template, marked)).toEqual(
        numberSections(template, content),
      )
      const ended = withEndAnswer(template, content, 0)
      expect(numberSections(template, ended)).toEqual(
        numberSections(template, content),
      )
    }
  })

  test('numbering is stable when sections are marked not applicable or the report ends', () => {
    fc.assert(
      fc.property(
        templateWithContentArbitrary,
        fc.nat(5),
        ({ template, content }, pick) => {
          const before = numberSections(template, content)
          expect(
            numberSections(template, markAllNotApplicable(template, content)),
          ).toEqual(before)
          expect(
            numberSections(template, withEndAnswer(template, content, pick)),
          ).toEqual(before)
          expect(
            numberSections(template, withoutEndAnswers(template, content)),
          ).toEqual(before)
          // The same sections in the same order, whatever their states.
          const states = sectionStates(
            template,
            withEndAnswer(
              template,
              markAllNotApplicable(template, content),
              pick,
            ),
          )
          for (const section of before) {
            expect(states.has(section.key)).toBe(true)
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  test('numbers count the numbered siblings of each parent, in order, in the generator templates', () => {
    fc.assert(
      fc.property(templateWithContentArbitrary, ({ template, content }) => {
        const sections = numberSections(template, content)
        const byParent = new Map<string, Array<NumberedSection>>()
        for (const section of sections) {
          byParent.set(section.parentKey, [
            ...(byParent.get(section.parentKey) ?? []),
            section,
          ])
        }
        for (const siblings of byParent.values()) {
          const numbered = siblings.filter(
            section => section.number !== undefined,
          )
          numbered.forEach((section, index) => {
            const level = template.numbering[section.depth - 1]
            expect(level).toBeDefined()
            if (level !== undefined) {
              expect(section.number?.own).toBe(
                formatNumber(index + 1, level) + level.suffix,
              )
            }
          })
          for (const section of siblings) {
            // Front matter and sections with `numbered: false` never get a number.
            if (section.frontMatter) {
              expect(section.number).toBeUndefined()
            }
          }
        }
        // Document order: a parent comes before its children.
        const seen = new Set<string>([''])
        for (const section of sections) {
          expect(seen.has(section.parentKey)).toBe(true)
          seen.add(section.key)
        }
      }),
      { numRuns: 200 },
    )
  })
})
