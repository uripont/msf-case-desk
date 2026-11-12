import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  BUILT_IN_TEMPLATES,
  CONTENT_SCHEMA_VERSION,
  DEFAULT_THEME,
  HOUR,
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
  type DocumentInput,
  type Person,
  type ReportContent,
  type RichTextDoc,
  type Template,
  allBlocks,
  applyEvent,
  approvalRecordDescription,
  approvalRecordFileName,
  documentDescription,
  documentStrings,
  emptyContent,
  formatDate,
  formatInstant,
  headingsOf,
  initialFlow,
  numberSections,
  pdfFileName,
  redactContent,
  segmentsOf,
} from './index'
import {
  MINI_TEMPLATE,
  contentArbitrary,
  templateWithContentArbitrary,
} from './testing/content'
import { peopleArbitrary } from './testing/drafts'
import { PANEL_TEMPLATE } from './testing/templates'

const CASE = {
  reference: 'IL-2026-0042',
  unit: 'Unit A',
  title: 'A synthetic case',
}
const VERSION = {
  reportName: 'Synthetic report',
  versionLabel: 'Revision 2',
  date: '2026-11-12',
}

const input = (
  template: Template,
  content: ReportContent,
  extra: Partial<DocumentInput> = {},
): DocumentInput => ({
  template,
  content,
  view: { kind: 'original', people: [] },
  caseFile: CASE,
  theme: DEFAULT_THEME,
  version: VERSION,
  ...extra,
})

const ANA: Person = {
  id: 'p1',
  name: 'Ana Garcia',
  label: 'Person 1',
  aliases: ['Ana', 'Anita'],
}

const doc = (...blocks: RichTextDoc['content']): RichTextDoc => ({
  type: 'doc',
  content: blocks,
})
const text = (value: string) => ({ type: 'text' as const, text: value })

const TEMPLATES: ReadonlyArray<Template> = [
  ...BUILT_IN_TEMPLATES,
  PANEL_TEMPLATE,
  MINI_TEMPLATE,
]

describe('headings: every section, in order, with its number', () => {
  const expected = (template: Template, content: ReportContent) =>
    numberSections(template, content).map(entry => [
      entry.key,
      entry.number?.full,
      entry.title,
    ])
  const actual = (template: Template, content: ReportContent) =>
    headingsOf(
      documentDescription(
        input(template, content, { includeConclusion: true }),
      ),
    ).map(heading => [heading.id, heading.number?.full, heading.title])

  test.each(TEMPLATES.map(t => [t.shortName, t] as const))(
    '%s with empty content and with generated content',
    (_name, template) => {
      expect(actual(template, emptyContent(template))).toEqual(
        expected(template, emptyContent(template)),
      )
      fc.assert(
        fc.property(contentArbitrary(template), content => {
          expect(actual(template, content)).toEqual(expected(template, content))
        }),
        { numRuns: 40 },
      )
    },
  )

  test('generated templates with generated content', () => {
    fc.assert(
      fc.property(templateWithContentArbitrary, ({ template, content }) => {
        expect(actual(template, content)).toEqual(expected(template, content))
      }),
      { numRuns: 100 },
    )
  })

  test('the heading text is the full number, a space and the title', () => {
    const description = documentDescription(
      input(INVESTIGATION_TEMPLATE, emptyContent(INVESTIGATION_TEMPLATE)),
    )
    for (const heading of headingsOf(description)) {
      expect(heading.text).toBe(
        heading.number === undefined
          ? heading.title
          : `${heading.number.full} ${heading.title}`,
      )
    }
    expect(headingsOf(description).some(h => h.number !== undefined)).toBe(true)
  })

  test('numbers do not move when a section is not applicable or the report ended', () => {
    fc.assert(
      fc.property(contentArbitrary(MINI_TEMPLATE), content => {
        const marked: ReportContent = {
          ...content,
          sections: {
            ...content.sections,
            extras: {
              values: {},
              sections: {},
              notApplicable: { reason: 'Not relevant' },
            },
          },
        }
        const numbers = (c: ReportContent) =>
          headingsOf(documentDescription(input(MINI_TEMPLATE, c))).map(
            h => h.number?.full,
          )
        expect(numbers(marked)).toEqual(numbers(content))
      }),
      { numRuns: 30 },
    )
  })

  test('the conclusion is hidden until there is something in it, unless asked for', () => {
    const empty = emptyContent(INTAKE_TEMPLATE)
    const conclusion = INTAKE_TEMPLATE.conclusion
    if (conclusion === undefined) throw new Error('no conclusion')
    const titles = (c: ReportContent, include?: boolean) =>
      headingsOf(
        documentDescription(
          input(
            INTAKE_TEMPLATE,
            c,
            include === undefined ? {} : { includeConclusion: include },
          ),
        ),
      ).map(h => h.title)
    expect(titles(empty)).not.toContain(conclusion.title)
    expect(titles(empty, true)).toContain(conclusion.title)
    const written: ReportContent = {
      ...empty,
      sections: {
        [conclusion.id]: {
          values: {
            'conclusion-decision': {
              type: 'rich_text',
              doc: doc({ type: 'paragraph', content: [text('Decided.')] }),
            },
          },
          sections: {},
        },
      },
    }
    expect(titles(written)).toContain(conclusion.title)
    expect(titles(written, false)).not.toContain(conclusion.title)
  })
})

describe('contents', () => {
  test('lists the headings down to the configured depth, in order, none if unset', () => {
    fc.assert(
      fc.property(templateWithContentArbitrary, ({ template, content }) => {
        const description = documentDescription(input(template, content))
        const contents = allBlocks(description).flatMap(b =>
          b.type === 'contents' ? [b] : [],
        )
        const depth = template.contentsDepth
        if (depth === undefined) {
          expect(contents).toEqual([])
          return
        }
        expect(contents).toHaveLength(1)
        expect(contents[0]?.entries.map(e => e.headingId)).toEqual(
          headingsOf(description)
            .filter(h => h.level <= depth)
            .map(h => h.id),
        )
      }),
      { numRuns: 60 },
    )
  })
})

describe('cover (D23)', () => {
  const content: ReportContent = {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    templateId: INVESTIGATION_TEMPLATE.id,
    templateVersion: INVESTIGATION_TEMPLATE.version,
    sections: {
      'report-details': {
        values: {
          'issue-date': { type: 'date', date: '2026-10' },
          'allegations-in-brief': { type: 'text', text: 'Abuse of power' },
          place: { type: 'text', text: 'Synthetic Town' },
        },
        sections: {},
      },
    },
  }

  test('title lines from fixed text, case-file values and items', () => {
    const description = documentDescription(
      input(INVESTIGATION_TEMPLATE, content),
    )
    const cover = description.parts[0]
    expect(cover?.kind).toBe('cover')
    const lines = (cover?.blocks ?? []).flatMap(b =>
      b.type === 'cover_line' ? [[b.emphasis, b.text]] : [],
    )
    expect(lines).toEqual([
      ['normal', 'Your organisation'],
      ['title', 'Investigation report'],
      ['normal', 'IL-2026-0042'],
      ['normal', 'Oct 2026'],
      ['subtitle', 'Abuse of power in Synthetic Town'],
      ['subtitle', 'Synthetic report - Revision 2'],
      ['normal', '12 Nov 2026'],
    ])
  })

  test('a line whose items are empty is left out', () => {
    const description = documentDescription(
      input(INVESTIGATION_TEMPLATE, emptyContent(INVESTIGATION_TEMPLATE)),
    )
    const lines = (description.parts[0]?.blocks ?? []).flatMap(b =>
      b.type === 'cover_line' ? [b.text] : [],
    )
    expect(lines).toEqual([
      'Your organisation',
      'Investigation report',
      'IL-2026-0042',
      'Synthetic report - Revision 2',
      '12 Nov 2026',
    ])
  })

  test('the redaction label and the logo', () => {
    const plain = documentDescription(input(INVESTIGATION_TEMPLATE, content))
    expect(plain.redactionLabel).toBeUndefined()
    expect(plain.parts[0]?.blocks.some(b => b.type === 'stamp')).toBe(false)
    const redacted = documentDescription(
      input(INVESTIGATION_TEMPLATE, content, {
        view: { kind: 'redacted', people: [] },
        theme: { ...DEFAULT_THEME, logo: 'logo-1' },
      }),
    )
    expect(redacted.redactionLabel).toBe('Redacted')
    expect(redacted.parts[0]?.blocks).toContainEqual({
      type: 'stamp',
      text: 'Redacted',
    })
    expect(redacted.parts[0]?.blocks[0]).toEqual({
      type: 'logo',
      imageId: 'logo-1',
    })
    expect(redacted.imageIds).toContain('logo-1')
  })

  test('a template with no cover gets a plain one', () => {
    const { cover: _cover, ...rest } = INVESTIGATION_TEMPLATE
    const description = documentDescription(
      input(rest as Template, emptyContent(INVESTIGATION_TEMPLATE)),
    )
    const lines = (description.parts[0]?.blocks ?? []).flatMap(b =>
      b.type === 'cover_line' ? [b.text] : [],
    )
    expect(lines).toContain('Synthetic report')
    expect(lines).toContain(
      `${INVESTIGATION_TEMPLATE.caseReferenceLabel}: IL-2026-0042`,
    )
  })
})

describe('header, footer and page numbering', () => {
  test('tokens: case and title are filled, page and pages are left to the renderer', () => {
    expect(
      segmentsOf('{title} - {case} - page {page} of {pages}', {
        case: 'C-1',
        title: 'T',
      }),
    ).toEqual([
      { kind: 'text', text: 'T - C-1 - page ' },
      { kind: 'page' },
      { kind: 'text', text: ' of ' },
      { kind: 'pages' },
    ])
    expect(segmentsOf('', { case: 'a', title: 'b' })).toEqual([])
  })

  test('the investigation template: its own furniture, different on the cover', () => {
    const { furniture } = documentDescription(
      input(INVESTIGATION_TEMPLATE, emptyContent(INVESTIGATION_TEMPLATE)),
    )
    expect(furniture.normal.header).toEqual([
      { kind: 'text', text: 'STRICTLY CONFIDENTIAL - ' },
      { kind: 'page' },
      { kind: 'text', text: ' -' },
    ])
    expect(furniture.normal.footer).toEqual([
      { kind: 'text', text: 'IL-2026-0042' },
    ])
    expect(furniture.cover).toEqual({
      header: [{ kind: 'text', text: 'STRICTLY CONFIDENTIAL' }],
      footer: undefined,
    })
  })

  test('the intake template: no separate cover; title is the report name', () => {
    const { furniture } = documentDescription(
      input(INTAKE_TEMPLATE, emptyContent(INTAKE_TEMPLATE)),
    )
    expect(furniture.cover).toBeUndefined()
    expect(furniture.normal.header).toEqual([
      { kind: 'text', text: 'Synthetic report' },
    ])
    expect(furniture.normal.footer).toEqual([
      { kind: 'text', text: 'STRICTLY CONFIDENTIAL - page ' },
      { kind: 'page' },
    ])
  })

  test('the template overrides the theme field by field; the theme fills the gaps', () => {
    const template: Template = {
      ...PANEL_TEMPLATE,
      furniture: { header: 'From the template' },
    }
    const { furniture } = documentDescription(
      input(template, emptyContent(template), {
        theme: {
          ...DEFAULT_THEME,
          pdf: {
            header: 'From the theme',
            footer: 'Footer {page}',
            coverFooter: 'Cover',
          },
        },
      }),
    )
    expect(furniture.normal.header).toEqual([
      { kind: 'text', text: 'From the template' },
    ])
    expect(furniture.normal.footer).toEqual([
      { kind: 'text', text: 'Footer ' },
      { kind: 'page' },
    ])
    expect(furniture.cover).toEqual({
      header: undefined,
      footer: [{ kind: 'text', text: 'Cover' }],
    })
  })

  test('restart after front matter: front group in roman numerals, body restarts at 1', () => {
    const description = documentDescription(
      input(INVESTIGATION_TEMPLATE, emptyContent(INVESTIGATION_TEMPLATE)),
    )
    expect(description.parts.map(p => [p.kind, p.numbering])).toEqual([
      ['cover', { group: 'front', style: 'roman', restartAt: 1 }],
      ['front', { group: 'front', style: 'roman', restartAt: undefined }],
      ['body', { group: 'body', style: 'arabic', restartAt: 1 }],
    ])
    const front = description.parts[1]?.blocks ?? []
    expect(front[0]?.type).toBe('contents')
    expect(
      front.some(b => b.type === 'heading' && b.title === 'Executive summary'),
    ).toBe(true)
  })

  test('continuous numbering is one group', () => {
    const description = documentDescription(
      input(INTAKE_TEMPLATE, emptyContent(INTAKE_TEMPLATE)),
    )
    expect(new Set(description.parts.map(p => p.numbering.group))).toEqual(
      new Set(['all']),
    )
    expect(description.parts.map(p => p.numbering.restartAt)).toEqual([
      1,
      ...description.parts.slice(1).map(() => undefined),
    ])
  })
})

describe('content blocks', () => {
  const content: ReportContent = {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    templateId: MINI_TEMPLATE.id,
    templateVersion: MINI_TEMPLATE.version,
    sections: {
      details: {
        values: {
          name: { type: 'text', text: 'Ana Garcia filed this.' },
          when: { type: 'date', date: '2026-03-04' },
          proceed: { type: 'select', optionIds: ['yes'] },
        },
        sections: {},
      },
      extras: {
        values: {
          'extras-text': {
            type: 'rich_text',
            doc: doc(
              { type: 'heading', attrs: { level: 2 }, content: [text('Sub')] },
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
                  { type: 'text', text: ' and ' },
                  {
                    type: 'text',
                    text: 'link',
                    marks: [
                      { type: 'link', attrs: { href: 'https://example.org' } },
                    ],
                  },
                ],
              },
              {
                type: 'orderedList',
                attrs: { start: 3 },
                content: [
                  {
                    type: 'listItem',
                    content: [{ type: 'paragraph', content: [text('one')] }],
                  },
                ],
              },
              {
                type: 'table',
                content: [
                  {
                    type: 'tableRow',
                    content: [
                      {
                        type: 'tableHeader',
                        attrs: { colspan: 2, colwidth: [100, 80] },
                        content: [{ type: 'paragraph', content: [text('H')] }],
                      },
                    ],
                  },
                  {
                    type: 'tableRow',
                    content: [
                      {
                        type: 'tableCell',
                        content: [{ type: 'paragraph', content: [text('a')] }],
                      },
                      {
                        type: 'tableCell',
                        content: [{ type: 'paragraph', content: [text('b')] }],
                      },
                    ],
                  },
                ],
              },
              {
                type: 'figure',
                attrs: { imageId: 'img-9', alt: 'A chart', safeToShare: true },
                content: [text('Figure caption')],
              },
            ),
          },
        },
        sections: {},
      },
      sign: {
        values: {
          signature: {
            type: 'signature',
            name: 'A. Author',
            date: '2026-11-12',
          },
        },
        sections: {},
      },
    },
  }
  const description = documentDescription(input(MINI_TEMPLATE, content))
  const blocks = allBlocks(description)

  test('fields, dates and select answers', () => {
    const fields = blocks.flatMap(b => (b.type === 'field' ? [b] : []))
    const byLabel = (label: string) => fields.find(f => f.label === label)
    expect(byLabel('Name')?.blocks).toEqual([
      { type: 'paragraph', runs: [{ text: 'Ana Garcia filed this.' }] },
    ])
    expect(byLabel('When')?.blocks).toEqual([
      { type: 'paragraph', runs: [{ text: '4 Mar 2026' }] },
    ])
    expect(byLabel('Proceed?')?.blocks).toEqual([
      { type: 'paragraph', runs: [{ text: 'Yes' }] },
    ])
  })

  test('rich text: headings, marks, links, lists, tables and figures', () => {
    expect(blocks).toContainEqual({
      type: 'rich_heading',
      level: 2,
      runs: [{ text: 'Sub' }],
    })
    expect(blocks).toContainEqual({
      type: 'paragraph',
      runs: [
        { text: 'Bold', bold: true },
        { text: ' and ' },
        { text: 'link', link: 'https://example.org' },
      ],
    })
    const list = blocks.find(b => b.type === 'list')
    expect(list).toMatchObject({ ordered: true, start: 3 })
    const table = blocks.find(b => b.type === 'table')
    expect(table?.type === 'table' && table.rows.map(r => r.length)).toEqual([
      1, 2,
    ])
    expect(table?.type === 'table' && table.rows[0]?.[0]).toMatchObject({
      header: true,
      colspan: 2,
      colwidth: [100, 80],
    })
    expect(blocks).toContainEqual({
      type: 'figure',
      imageId: 'img-9',
      alt: 'A chart',
      caption: [{ text: 'Figure caption' }],
    })
    expect(description.imageIds).toEqual(['img-9'])
  })

  test('a signature is printed with its line, with name and date if given', () => {
    expect(blocks).toContainEqual({
      type: 'signature',
      label: 'Signed',
      name: 'A. Author',
      date: '12 Nov 2026',
    })
    const empty = allBlocks(
      documentDescription(input(MINI_TEMPLATE, emptyContent(MINI_TEMPLATE))),
    )
    expect(empty).toContainEqual({
      type: 'signature',
      label: 'Signed',
      name: '',
      date: undefined,
    })
  })

  test('not applicable and ended sections keep their heading and show a note, not content', () => {
    const marked: ReportContent = {
      ...content,
      sections: {
        ...content.sections,
        extras: {
          ...(content.sections.extras ?? { values: {}, sections: {} }),
          notApplicable: { reason: 'Nothing to add' },
        },
      },
    }
    const na = allBlocks(documentDescription(input(MINI_TEMPLATE, marked)))
    expect(na).toContainEqual({
      type: 'note',
      text: 'Not applicable: Nothing to add',
    })
    expect(na.some(b => b.type === 'figure')).toBe(false)

    const ended: ReportContent = {
      ...content,
      sections: {
        ...content.sections,
        details: {
          values: {
            ...content.sections.details?.values,
            proceed: { type: 'select', optionIds: ['no'] },
          },
          sections: {},
        },
      },
    }
    const out = documentDescription(input(MINI_TEMPLATE, ended))
    const outBlocks = allBlocks(out)
    expect(outBlocks).toContainEqual({
      type: 'note',
      text: 'The report ended early.',
    })
    expect(
      outBlocks.filter(
        b => b.type === 'note' && b.text === 'Not applicable (ended)',
      ).length,
    ).toBeGreaterThan(0)
    expect(headingsOf(out).map(h => h.id)).toEqual(
      headingsOf(description).map(h => h.id),
    )
  })

  test('repeated entries are numbered groups', () => {
    const withEntries: ReportContent = {
      ...content,
      sections: {
        ...content.sections,
        things: {
          values: {},
          sections: {
            thing: {
              values: {},
              sections: {},
              entries: [
                {
                  id: 'e1',
                  title: 'First thing',
                  values: {
                    'thing-title': { type: 'text', text: 'T1' },
                    'thing-refs': {
                      type: 'repeated',
                      entries: [
                        {
                          id: 'r1',
                          values: {
                            'ref-text': { type: 'text', text: 'Ref A' },
                          },
                        },
                        {
                          id: 'r2',
                          title: 'Named',
                          values: {
                            'ref-text': { type: 'text', text: 'Ref B' },
                          },
                        },
                      ],
                    },
                  },
                  sections: {},
                },
              ],
            },
          },
        },
      },
    }
    const out = allBlocks(
      documentDescription(input(MINI_TEMPLATE, withEntries)),
    )
    const groups = out.flatMap(b => (b.type === 'group' ? [b.label] : []))
    expect(groups).toEqual(['Reference 1', 'Reference 2: Named'])
    expect(
      out.some(b => b.type === 'heading' && b.title === 'First thing'),
    ).toBe(true)
  })
})

describe('redacted content (D14)', () => {
  const figure = (imageId: string, safeToShare: boolean) => ({
    type: 'figure' as const,
    attrs: { imageId, alt: 'Alt', safeToShare },
    content: [text('Caption')],
  })
  const content: ReportContent = {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    templateId: MINI_TEMPLATE.id,
    templateVersion: MINI_TEMPLATE.version,
    sections: {
      details: {
        values: { name: { type: 'text', text: 'Ana met Anita.' } },
        sections: {},
      },
      extras: {
        values: {
          'extras-text': {
            type: 'rich_text',
            doc: doc(
              { type: 'paragraph', content: [text('Ana wrote this.')] },
              figure('img-safe', true),
              figure('img-secret', false),
            ),
          },
        },
        sections: {},
      },
    },
  }

  test('built from redacted content, no withheld image and no alias is in the document', () => {
    const redacted = redactContent([ANA], content)
    const description = documentDescription(
      input(MINI_TEMPLATE, redacted, {
        view: { kind: 'redacted', people: [ANA] },
      }),
    )
    expect(description.imageIds).toEqual(['img-safe'])
    const strings = documentStrings(description).join('\n')
    expect(strings).not.toMatch(/\bAna\b|\bAnita\b|Garcia/)
    expect(strings).toContain('Person 1')
    expect(strings).toContain('Image withheld')
    expect(strings).not.toContain('img-secret')
    expect(description.redactionLabel).toBe('Redacted')
  })

  test('as a second line of defence, an unsafe image is dropped even if content was not redacted', () => {
    const description = documentDescription(
      input(MINI_TEMPLATE, content, {
        view: { kind: 'redacted', people: [] },
      }),
    )
    expect(description.imageIds).toEqual(['img-safe'])
    expect(documentStrings(description).join('\n')).toContain('Image withheld')
  })

  test('regression: the case file and the metadata are redacted by the description itself', () => {
    const named = {
      reference: 'IL-Ana-2026',
      unit: "Ana's unit",
      title: 'Complaint about Ana Garcia',
    }
    const base = MINI_TEMPLATE
    const template: Template = {
      ...base,
      cover: {
        lines: [
          { emphasis: 'title', parts: [{ kind: 'case_value', field: 'title' }] },
          { emphasis: 'normal', parts: [{ kind: 'case_value', field: 'unit' }] },
          { emphasis: 'normal', parts: [{ kind: 'case_value', field: 'reference' }] },
        ],
      },
      sections: base.sections.map((section, index) =>
        index === 1
          ? {
              ...section,
              items: [
                ...section.items,
                { id: 'cv-title', label: 'Case title', type: 'case_value' as const, field: 'title' as const, requirement: 'optional' as const },
                { id: 'cv-unit', label: 'Unit', type: 'case_value' as const, field: 'unit' as const, requirement: 'optional' as const },
              ],
            }
          : section,
      ),
    }
    const named2 = (view: DocumentInput['view']) =>
      documentDescription(
        input(template, emptyContent(template), {
          caseFile: named,
          view,
          version: {
            ...VERSION,
            reportName: 'Ana Garcia: the report',
            versionLabel: 'Revision 2 for Anita',
          },
        }),
      )
    const original = documentStrings(named2({ kind: 'original', people: [ANA] })).join('\n')
    expect(original).toContain('Complaint about Ana Garcia')
    expect(original).toContain("Ana's unit")
    const redacted = named2({ kind: 'redacted', people: [ANA] })
    const strings = documentStrings(redacted).join('\n')
    expect(strings).not.toMatch(/\bAna\b|\bAnita\b|Garcia/)
    expect(strings).toContain('Complaint about Person 1')
    expect(strings).toContain("Person 1's unit")
    expect(JSON.stringify(redacted)).not.toMatch(/Ana|Anita|Garcia/)
  })

  test('the original keeps every image', () => {
    expect(documentDescription(input(MINI_TEMPLATE, content)).imageIds).toEqual(
      ['img-safe', 'img-secret'],
    )
  })

  test('people are shown by label when redacted, by name otherwise', () => {
    const peopleTemplate = INTAKE_TEMPLATE
    const item = peopleTemplate.sections
      .flatMap(s => s.items)
      .find(i => i.type === 'people' && i.id === 'complainant')
    if (item === undefined) throw new Error('no people item')
    const section = peopleTemplate.sections.find(s => s.items.includes(item))
    if (section === undefined) throw new Error('no section')
    const withPerson: ReportContent = {
      ...emptyContent(peopleTemplate),
      sections: {
        [section.id]: {
          values: { complainant: { type: 'people', personIds: ['p1'] } },
          sections: {},
        },
      },
    }
    const strings = (redacted: boolean) =>
      documentStrings(
        documentDescription(
          input(peopleTemplate, withPerson, {
            view: { kind: redacted ? 'redacted' : 'original', people: [ANA] },
          }),
        ),
      )
    expect(strings(false)).toContain('Ana Garcia')
    expect(strings(true)).toContain('Person 1')
    expect(strings(true).join('\n')).not.toContain('Garcia')
  })

  test('generated content: redacted documents hold only images that are safe in the redacted content', () => {
    fc.assert(
      fc.property(
        templateWithContentArbitrary,
        peopleArbitrary,
        ({ template, content: generated }, people) => {
          const redacted = redactContent(people, generated)
          const text = JSON.stringify(redacted)
          const safeIds = new Set(
            [
              ...text.matchAll(
                /"type":"figure","attrs":\{[^}]*?"imageId":"([^"]+)"/g,
              ),
            ].map(m => m[1]),
          )
          const description = documentDescription(
            input(template, redacted, {
              view: { kind: 'redacted', people },
              includeConclusion: true,
            }),
          )
          for (const id of description.imageIds)
            expect(safeIds.has(id)).toBe(true)
          const fromOriginal = documentDescription(
            input(template, generated, {
              view: { kind: 'redacted', people },
              includeConclusion: true,
            }),
          )
          expect(fromOriginal.imageIds).toEqual(description.imageIds)
        },
      ),
      { numRuns: 80 },
    )
  })
})

describe('file names (D10)', () => {
  const base = {
    caseReference: 'IL-2026-0042',
    templateShortName: 'intake',
    people: [] as ReadonlyArray<Person>,
  }

  test('the pattern of the plan', () => {
    expect(
      pdfFileName({
        ...base,
        version: { kind: 'revision', number: 2 },
        redacted: true,
      }),
    ).toBe('IL-2026-0042_intake_Revision-2_redacted.pdf')
    expect(
      pdfFileName({
        ...base,
        version: { kind: 'draft', number: 5 },
        redacted: false,
      }),
    ).toBe('IL-2026-0042_intake_Draft-5.pdf')
    expect(approvalRecordFileName(base)).toBe(
      'IL-2026-0042_intake_approval-record.pdf',
    )
  })

  test('only safe characters, whatever the reference holds', () => {
    fc.assert(
      fc.property(fc.string(), fc.boolean(), (reference, redacted) => {
        const name = pdfFileName({
          ...base,
          caseReference: reference,
          version: { kind: 'draft', number: 1 },
          redacted,
        })
        expect(name).toMatch(/^[A-Za-z0-9._-]+\.pdf$/)
      }),
    )
  })

  test('a redacted name never carries an alias, an original one is left alone', () => {
    const people = [ANA]
    const redacted = pdfFileName({
      ...base,
      caseReference: 'Ana_Garcia-case',
      people,
      version: { kind: 'revision', number: 1 },
      redacted: true,
    })
    expect(redacted).not.toMatch(/Ana|Garcia/i)
    expect(redacted).toMatch(/^Person-1.*_Revision-1_redacted\.pdf$/)
    expect(
      pdfFileName({
        ...base,
        caseReference: 'Ana-case',
        people,
        version: { kind: 'revision', number: 1 },
        redacted: false,
      }),
    ).toBe('Ana-case_intake_Revision-1.pdf')
  })
})

describe('the approval record (D4)', () => {
  const COMMITTEE = [
    { accountId: 'r1', roleId: 'committee' },
    { accountId: 'r2', roleId: 'committee' },
  ]
  const T0 = 1_762_900_000_000
  const apply = (
    flow = initialFlow,
    now: number,
    event: Parameters<typeof applyEvent>[2],
  ) => {
    const result = applyEvent(
      { template: INTAKE_TEMPLATE, authors: ['a1'], now },
      flow,
      event,
    )
    if (Result.isFailure(result)) throw new Error(result.failure.message)
    return result.success
  }
  let flow = apply(initialFlow, T0, { type: 'share_draft' })
  flow = apply(flow, T0, {
    type: 'publish_revision',
    draft: 1,
    deadline: T0 + 72 * HOUR,
    participants: COMMITTEE,
  })
  flow = apply(flow, T0 + HOUR, {
    type: 'submit_review',
    revision: 1,
    reviewerId: 'r1',
    decision: 'request_changes',
  })
  const description = approvalRecordDescription({
    template: INTAKE_TEMPLATE,
    flow,
    events: [
      { type: 'revision_published', revision: 1, at: T0 },
      {
        type: 'review',
        id: 'x1',
        reviewerId: 'r1',
        revision: 1,
        decision: 'request_changes',
        hasComments: true,
        at: T0 + HOUR,
      },
    ],
    authors: ['a1'],
    accountNames: { r1: 'Rosa Reviewer', r2: 'Rui Reviewer' },
    caseFile: CASE,
    theme: DEFAULT_THEME,
    reportName: 'Synthetic report',
    date: '2026-11-12',
  })
  const strings = documentStrings(description).join('\n')
  const cells = allBlocks(description).flatMap(b =>
    b.type === 'table'
      ? b.rows.map(row =>
          row.map(cell =>
            cell.blocks
              .flatMap(x =>
                x.type === 'paragraph'
                  ? [x.runs.map(r => r.text).join('')]
                  : [],
              )
              .join(''),
          ),
        )
      : [],
  )

  test('one heading per revision with who decided what and when', () => {
    expect(headingsOf(description).map(h => h.text)).toEqual(['Revision 1'])
    expect(cells).toEqual([
      ['Reviewer', 'Role', 'Decision', 'Time'],
      [
        'Rosa Reviewer',
        'Committee',
        'Requested changes',
        formatInstant(T0 + HOUR),
      ],
      ['Rui Reviewer', 'Committee', 'No decision', ''],
    ])
    expect(strings).toContain('Based on Draft 1')
    expect(strings).toContain('Open')
    expect(strings).toContain(
      `Rosa Reviewer: Requested changes, ${formatInstant(T0 + HOUR)}, with comments (standing decision)`,
    )
  })

  test('it is a document of its own with the theme furniture, not marked redacted', () => {
    expect(description.info.title).toBe('Approval record - Synthetic report')
    expect(description.redactionLabel).toBeUndefined()
    expect(description.parts.map(p => p.kind)).toEqual(['cover', 'body'])
    expect(strings).toContain('Approval record')
  })

  test('nothing published yet', () => {
    const empty = approvalRecordDescription({
      template: INTAKE_TEMPLATE,
      flow: initialFlow,
      events: [],
      authors: ['a1'],
      accountNames: {},
      caseFile: CASE,
      theme: DEFAULT_THEME,
      reportName: 'Synthetic report',
      date: '2026-11-12',
    })
    expect(documentStrings(empty)).toContain(
      'No revision has been published yet.',
    )
  })
})

describe('dates', () => {
  test('formatting', () => {
    expect(formatDate('2026-11-12')).toBe('12 Nov 2026')
    expect(formatDate('2026-01-02')).toBe('2 Jan 2026')
    expect(formatDate('2026-11')).toBe('Nov 2026')
    expect(formatDate('soon')).toBe('soon')
    expect(formatInstant(Date.UTC(2026, 10, 12, 14, 5))).toBe(
      '2026-11-12 14:05 UTC',
    )
  })
})

test('the description is plain data: the same input gives the same output', () => {
  fc.assert(
    fc.property(templateWithContentArbitrary, ({ template, content }) => {
      const a = documentDescription(input(template, content))
      const b = documentDescription(input(template, content))
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    }),
    { numRuns: 30 },
  )
})
