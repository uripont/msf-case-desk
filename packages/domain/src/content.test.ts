import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  BUILT_IN_TEMPLATES,
  CONTENT_SCHEMA_VERSION,
  type ContentProblemCode,
  type ItemValue,
  type ReportContent,
  type Template,
  contentProblems,
  emptyContent,
  isItemFilled,
  isValidDate,
  sectionStates,
  validateContent,
  validateTemplate,
} from './index'
import {
  MINI_TEMPLATE,
  contentArbitrary,
  templateWithContentArbitrary,
} from './testing/content'
import { PANEL_TEMPLATE } from './testing/templates'

const ALL_TEMPLATES: ReadonlyArray<Template> = [
  ...BUILT_IN_TEMPLATES,
  PANEL_TEMPLATE,
  MINI_TEMPLATE,
]

const codes = (
  template: Template,
  input: unknown,
): ReadonlyArray<ContentProblemCode> => {
  const result = validateContent(template, input)
  return Result.isFailure(result) ? result.failure.map(p => p.code) : []
}

const base = (template: Template, sections: ReportContent['sections']) => ({
  ...emptyContent(template),
  sections,
})

const text = (value: string): ItemValue => ({ type: 'text', text: value })
const para = (value: string): ItemValue => ({
  type: 'rich_text',
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
  },
})
const empty = { values: {}, sections: {} }

describe('the test templates', () => {
  test('the mini template is a valid template', () => {
    expect(Result.isSuccess(validateTemplate(MINI_TEMPLATE))).toBe(true)
  })
})

describe('content validation', () => {
  test('empty content fits every template', () => {
    for (const template of ALL_TEMPLATES) {
      expect(
        Result.isSuccess(validateContent(template, emptyContent(template))),
      ).toBe(true)
    }
  })

  test('generated content fits its template, also after JSON', () => {
    for (const template of ALL_TEMPLATES) {
      fc.assert(
        fc.property(contentArbitrary(template), content => {
          const result = validateContent(
            template,
            JSON.parse(JSON.stringify(content)),
          )
          expect(Result.isSuccess(result) && result.success).toEqual(content)
        }),
        { numRuns: 40 },
      )
    }
    fc.assert(
      fc.property(templateWithContentArbitrary, ({ template, content }) => {
        expect(contentProblems(template, content)).toEqual([])
        const result = validateContent(
          template,
          JSON.parse(JSON.stringify(content)),
        )
        expect(Result.isSuccess(result) && result.success).toEqual(content)
      }),
      { numRuns: 150 },
    )
  })

  test('refuses content for another template or version', () => {
    expect(
      codes(MINI_TEMPLATE, {
        ...emptyContent(MINI_TEMPLATE),
        templateId: 'other',
      }),
    ).toContain('template-mismatch')
    expect(
      codes(MINI_TEMPLATE, {
        ...emptyContent(MINI_TEMPLATE),
        templateVersion: 2,
      }),
    ).toContain('template-mismatch')
    expect(
      codes(MINI_TEMPLATE, {
        ...emptyContent(MINI_TEMPLATE),
        schemaVersion: 2,
      }),
    ).toContain('schema')
  })

  test('refuses unknown keys and unknown sections and items', () => {
    expect(
      codes(MINI_TEMPLATE, { ...emptyContent(MINI_TEMPLATE), extra: 1 }),
    ).toContain('schema')
    expect(
      codes(MINI_TEMPLATE, base(MINI_TEMPLATE, { nope: empty })),
    ).toContain('unknown-section')
    expect(
      codes(
        MINI_TEMPLATE,
        base(MINI_TEMPLATE, {
          details: { values: { nope: text('x') }, sections: {} },
        }),
      ),
    ).toContain('unknown-item')
    // A real section in the wrong place.
    expect(
      codes(MINI_TEMPLATE, base(MINI_TEMPLATE, { 'things-summary': empty })),
    ).toContain('unknown-section')
  })

  test('refuses values of the wrong type or outside what the item allows', () => {
    const put = (id: string, value: unknown) =>
      codes(
        MINI_TEMPLATE,
        base(MINI_TEMPLATE, {
          details: { values: { [id]: value as ItemValue }, sections: {} },
        }),
      )
    expect(put('name', { type: 'date', date: '2025-01-01' })).toContain(
      'wrong-value-type',
    )
    expect(put('proceed', text('yes'))).toContain('wrong-value-type')
    expect(put('proceed', { type: 'select', optionIds: ['maybe'] })).toContain(
      'unknown-option',
    )
    expect(
      put('proceed', { type: 'select', optionIds: ['yes', 'no'] }),
    ).toContain('too-many-answers')
    expect(put('when', { type: 'date', date: '2025-02-30' })).toContain(
      'invalid-date',
    )
    expect(put('when', { type: 'date', date: '2025-02' })).toContain(
      'invalid-date',
    )
    expect(put('when', { type: 'date', date: '2025-13-01' })).toContain(
      'invalid-date',
    )
    expect(put('name', { type: 'text' })).toContain('schema')
    expect(put('name', { type: 'text', text: 'x', extra: true })).toContain(
      'schema',
    )
    expect(
      put('name', {
        type: 'rich_text',
        doc: { type: 'doc', content: [{ type: 'codeBlock' }] },
      }),
    ).toContain('schema')
    expect(put('name', { type: 'not_applicable', reason: 'no' })).toContain(
      'not-applicable-not-allowed',
    )
    expect(put('when', { type: 'date', date: '2025-02-28' })).toEqual([])
    expect(put('proceed', { type: 'select', optionIds: ['no'] })).toEqual([])
  })

  test('refuses a value in a case-file item, and dates of the wrong precision', () => {
    const intake = BUILT_IN_TEMPLATES[0] as Template
    expect(
      codes(
        intake,
        base(intake, {
          'case-details': {
            values: { 'case-reference': text('x') },
            sections: {},
          },
        }),
      ),
    ).toContain('value-not-allowed')
    expect(isValidDate('2025-02', 'month')).toBe(true)
    expect(isValidDate('2025-02-01', 'month')).toBe(false)
    expect(isValidDate('2024-02-29', 'day')).toBe(true)
    expect(isValidDate('2023-02-29', 'day')).toBe(false)
  })

  test('not applicable only where the template allows it, and with a reason', () => {
    const mark = (id: string, reason: string) =>
      base(MINI_TEMPLATE, { [id]: { ...empty, notApplicable: { reason } } })
    expect(codes(MINI_TEMPLATE, mark('extras', 'not relevant'))).toEqual([])
    expect(codes(MINI_TEMPLATE, mark('details', 'because'))).toContain(
      'not-applicable-not-allowed',
    )
    expect(codes(MINI_TEMPLATE, mark('extras', ''))).toContain('schema')
    expect(codes(MINI_TEMPLATE, mark('extras', '   '))).toContain('schema')
  })

  test('repeat entries: placement, limits and stable unique IDs', () => {
    const things = (entries: Array<{ id: string }>) =>
      base(MINI_TEMPLATE, {
        things: {
          ...empty,
          sections: {
            thing: {
              ...empty,
              entries: entries.map(({ id }) => ({
                id,
                values: {},
                sections: {},
              })),
            },
          },
        },
      })
    expect(
      codes(MINI_TEMPLATE, things([{ id: 'a' }, { id: 'b' }, { id: 'c' }])),
    ).toEqual([])
    expect(
      codes(
        MINI_TEMPLATE,
        things([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]),
      ),
    ).toContain('too-many-entries')
    expect(codes(MINI_TEMPLATE, things([{ id: 'a' }, { id: 'a' }]))).toContain(
      'duplicate-entry-id',
    )
    expect(codes(MINI_TEMPLATE, things([{ id: 'a b' }]))).toContain('schema')
    // Entries on a section that is not repeatable, and content outside the entries of one that is.
    expect(
      codes(
        MINI_TEMPLATE,
        base(MINI_TEMPLATE, { details: { ...empty, entries: [] } }),
      ),
    ).toContain('entries-misplaced')
    expect(
      codes(
        MINI_TEMPLATE,
        base(MINI_TEMPLATE, {
          things: {
            ...empty,
            sections: {
              thing: { values: { 'thing-title': text('x') }, sections: {} },
            },
          },
        }),
      ),
    ).toContain('repeat-content-misplaced')
    // The same entry ID in a repeated item and a repeated section is also refused.
    expect(
      codes(
        MINI_TEMPLATE,
        base(MINI_TEMPLATE, {
          things: {
            ...empty,
            sections: {
              thing: {
                ...empty,
                entries: [
                  {
                    id: 'a',
                    values: {
                      'thing-refs': {
                        type: 'repeated',
                        entries: [{ id: 'a', values: {} }],
                      },
                    },
                    sections: {},
                  },
                ],
              },
            },
          },
        }),
      ),
    ).toContain('duplicate-entry-id')
  })

  test('refuses content that does not fit, for generated templates', () => {
    fc.assert(
      fc.property(templateWithContentArbitrary, ({ template, content }) => {
        const refusedWith = (changed: unknown, code: ContentProblemCode) =>
          expect(codes(template, changed), code).toContain(code)
        refusedWith(
          { ...content, templateId: `${content.templateId}-x` },
          'template-mismatch',
        )
        refusedWith(
          { ...content, templateVersion: content.templateVersion + 1 },
          'template-mismatch',
        )
        refusedWith(
          {
            ...content,
            sections: { ...content.sections, 'no-such-section': empty },
          },
          'unknown-section',
        )

        const first = template.sections[0]
        if (first === undefined) {
          return
        }
        const current = content.sections[first.id] ?? empty
        refusedWith(
          {
            ...content,
            sections: {
              ...content.sections,
              [first.id]: {
                ...current,
                values: { ...current.values, 'no-such-item': text('x') },
              },
            },
          },
          'unknown-item',
        )
        // A value of the wrong type in the first item of the section.
        const item = first.items[0]
        if (item !== undefined && first.repeat === undefined) {
          const wrong: ItemValue =
            item.type === 'text' ? { type: 'signature', name: 'x' } : text('x')
          const result = codes(template, {
            ...content,
            sections: {
              ...content.sections,
              [first.id]: {
                ...current,
                values: { ...current.values, [item.id]: wrong },
              },
            },
          })
          expect(
            result.some(
              code =>
                code === 'wrong-value-type' || code === 'value-not-allowed',
            ),
          ).toBe(true)
        }
        // Not applicable on a section that must be filled.
        const required = template.sections.find(
          s => s.requirement !== 'optional_with_reason',
        )
        if (required !== undefined) {
          refusedWith(
            {
              ...content,
              sections: {
                ...content.sections,
                [required.id]: {
                  ...(content.sections[required.id] ?? empty),
                  notApplicable: { reason: 'x' },
                },
              },
            },
            'not-applicable-not-allowed',
          )
        }
      }),
      { numRuns: 150 },
    )
  })
})

describe('items and states', () => {
  const nameItem = MINI_TEMPLATE.sections[1]?.items[0]
  test('what counts as filled', () => {
    expect(nameItem).toBeDefined()
    if (nameItem === undefined) {
      return
    }
    expect(isItemFilled(nameItem, text('  '))).toBe(false)
    expect(isItemFilled(nameItem, text('Ana'))).toBe(true)
    expect(isItemFilled(nameItem, undefined)).toBe(false)
    expect(
      isItemFilled(nameItem, { type: 'not_applicable', reason: 'x' }),
    ).toBe(false)
    expect(isItemFilled(nameItem, { type: 'date', date: '2025-01-01' })).toBe(
      false,
    )
    const rich = MINI_TEMPLATE.sections[2]?.items[0]
    if (rich !== undefined) {
      expect(isItemFilled(rich, para(' '))).toBe(false)
      expect(isItemFilled(rich, para('Hello'))).toBe(true)
    }
  })

  test('empty, in progress, complete, not applicable', () => {
    const states = (sections: ReportContent['sections']) =>
      sectionStates(MINI_TEMPLATE, base(MINI_TEMPLATE, sections))
    expect(states({}).get('details')).toBe('empty')
    expect(states({}).get('extras')).toBe('empty')
    const partial = states({
      details: { values: { name: text('Ana') }, sections: {} },
    })
    expect(partial.get('details')).toBe('in_progress')
    const done = states({
      details: {
        values: {
          name: text('Ana'),
          when: { type: 'date', date: '2025-03-04' },
          proceed: { type: 'select', optionIds: ['yes'] },
        },
        sections: {},
      },
    })
    expect(done.get('details')).toBe('complete')
    // An optional section holds nothing back, whatever it holds.
    expect(
      states({ extras: { ...empty, notApplicable: { reason: 'none' } } }).get(
        'extras',
      ),
    ).toBe('not_applicable')
    // Filling an optional item only starts the section.
    expect(
      states({ details: { values: { nick: text('A') }, sections: {} } }).get(
        'details',
      ),
    ).toBe('in_progress')
  })

  test('a required repeatable subsection needs its minimum, each entry complete', () => {
    const key = 'things/thing'
    const withEntries = (
      entries: Array<{
        id: string
        title?: string
        values: Record<string, ItemValue>
        facts?: boolean
      }>,
    ) =>
      sectionStates(
        MINI_TEMPLATE,
        base(MINI_TEMPLATE, {
          things: {
            ...empty,
            sections: {
              thing: {
                ...empty,
                entries: entries.map(entry => ({
                  id: entry.id,
                  ...(entry.title === undefined ? {} : { title: entry.title }),
                  values: entry.values,
                  sections: entry.facts
                    ? {
                        'thing-facts': {
                          values: { 'thing-facts-text': para('Facts') },
                          sections: {},
                        },
                      }
                    : {},
                })),
              },
              'things-summary': {
                values: { 'things-summary-text': para('Done') },
                sections: {},
              },
            },
          },
        }),
      )
    expect(withEntries([]).get(key)).toBe('empty')
    expect(withEntries([]).get('things')).toBe('in_progress')
    const half = withEntries([
      { id: 'a', values: { 'thing-title': text('One') } },
    ])
    expect(half.get(`${key}#a`)).toBe('in_progress')
    expect(half.get(key)).toBe('in_progress')
    const full = withEntries([
      { id: 'a', values: { 'thing-title': text('One') }, facts: true },
    ])
    expect(full.get(`${key}#a`)).toBe('complete')
    expect(full.get(key)).toBe('complete')
    expect(full.get('things')).toBe('complete')
  })

  test('states are defined for every shown section, for generated content', () => {
    fc.assert(
      fc.property(templateWithContentArbitrary, ({ template, content }) => {
        const states = sectionStates(template, content)
        for (const section of template.sections) {
          expect(states.has(section.id)).toBe(true)
        }
      }),
      { numRuns: 100 },
    )
  })
})

test('the content schema version is 1', () => {
  expect(CONTENT_SCHEMA_VERSION).toBe(1)
})
