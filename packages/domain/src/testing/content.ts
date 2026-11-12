import fc from 'fast-check'

import {
  CONTENT_SCHEMA_VERSION,
  type ItemEntry,
  type ItemValue,
  type ItemValues,
  type ReportContent,
  type SectionContent,
  type SectionContents,
  type SectionEntry,
} from '../content'
import type {
  BlockNode,
  InlineNode,
  ListBlock,
  ListItemNode,
  Mark,
  RichTextDoc,
  TableCellNode,
  TableHeaderNode,
} from '../richtext'
import type { Item, Section, Template } from '../template'
import {
  dateItem,
  option,
  repeatedItem,
  richTextItem,
  section,
  selectItem,
  signatureItem,
  textItem,
} from '../template-builders'
import { PANEL_TEMPLATE, validTemplateArbitrary } from './templates'

// NOTE: Test support for every later stage: generators of rich text and of
// report content that fits a given template, a generator of a template with
// content, and small helpers that change content the way the app will.

// ---- Rich text --------------------------------------------------------------

const WORDS = ['alpha', 'beta', 'équipe', 'Ödön', 'one two', 'report', 'x']
const word = fc.constantFrom(...WORDS)

const markArb: fc.Arbitrary<Mark> = fc.oneof(
  fc.constant<Mark>({ type: 'bold' }),
  fc.constant<Mark>({ type: 'italic' }),
  fc.constant<Mark>({ type: 'underline' }),
  fc
    .record({
      href: fc.constantFrom('https://example.org/a', 'mailto:a@example.org'),
      title: fc.option(word, { nil: undefined }),
    })
    .map(({ href, title }): Mark => ({
      type: 'link',
      attrs: title === undefined ? { href } : { href, title },
    })),
)

const inlineArb: fc.Arbitrary<ReadonlyArray<InlineNode>> = fc.array(
  fc.oneof(
    {
      weight: 4,
      arbitrary: fc
        .record({
          text: word,
          marks: fc.option(fc.array(markArb, { maxLength: 3 }), {
            nil: undefined,
          }),
        })
        .map(({ text, marks }): InlineNode =>
          marks === undefined
            ? { type: 'text', text }
            : { type: 'text', text, marks },
        ),
    },
    { weight: 1, arbitrary: fc.constant<InlineNode>({ type: 'hardBreak' }) },
  ),
  { maxLength: 4 },
)

const withInline = <A extends { type: string }>(
  node: A,
  content: ReadonlyArray<InlineNode>,
) => (content.length === 0 ? node : { ...node, content })

const paragraphArb: fc.Arbitrary<ListBlock> = inlineArb.map(content =>
  withInline({ type: 'paragraph' as const }, content),
)

const headingArb: fc.Arbitrary<ListBlock> = fc
  .record({ level: fc.integer({ min: 1, max: 4 }), content: inlineArb })
  .map(({ level, content }) =>
    withInline({ type: 'heading' as const, attrs: { level } }, content),
  )

const listArb = (depth: number): fc.Arbitrary<ListBlock> => {
  const item: fc.Arbitrary<ListItemNode> = fc
    .tuple(
      paragraphArb,
      depth > 0
        ? fc.option(listArb(depth - 1), { nil: undefined })
        : fc.constant(undefined),
    )
    .map(([first, nested]) => ({
      type: 'listItem' as const,
      content: nested === undefined ? [first] : [first, nested],
    }))
  const items = fc.array(item, { minLength: 1, maxLength: 3 })
  return fc.oneof(
    items.map((content): ListBlock => ({ type: 'bulletList', content })),
    fc
      .record({
        content: items,
        start: fc.option(fc.integer({ min: 2, max: 9 }), { nil: undefined }),
      })
      .map(({ content, start }): ListBlock =>
        start === undefined
          ? { type: 'orderedList', content }
          : { type: 'orderedList', attrs: { start }, content },
      ),
  )
}

const cellBlockArb: fc.Arbitrary<ListBlock> = fc.oneof(
  { weight: 4, arbitrary: paragraphArb },
  { weight: 1, arbitrary: listArb(0) },
)

const cellArb: fc.Arbitrary<TableCellNode | TableHeaderNode> = fc
  .record({
    header: fc.boolean(),
    content: fc.array(cellBlockArb, { minLength: 1, maxLength: 2 }),
    colspan: fc.option(fc.integer({ min: 2, max: 3 }), { nil: undefined }),
    rowspan: fc.option(fc.integer({ min: 2, max: 3 }), { nil: undefined }),
    colwidth: fc.option(
      fc.array(fc.integer({ min: 40, max: 400 }), {
        minLength: 1,
        maxLength: 2,
      }),
      { nil: undefined },
    ),
  })
  .map(({ header, content, colspan, rowspan, colwidth }) => {
    const attrs = {
      ...(colspan === undefined ? {} : { colspan }),
      ...(rowspan === undefined ? {} : { rowspan }),
      ...(colwidth === undefined ? {} : { colwidth }),
    }
    return {
      type: header ? ('tableHeader' as const) : ('tableCell' as const),
      ...(Object.keys(attrs).length === 0 ? {} : { attrs }),
      content,
    }
  })

const tableArb: fc.Arbitrary<BlockNode> = fc
  .array(fc.array(cellArb, { minLength: 1, maxLength: 3 }), {
    minLength: 1,
    maxLength: 3,
  })
  .map(rows => ({
    type: 'table' as const,
    content: rows.map(content => ({ type: 'tableRow' as const, content })),
  }))

const figureArb: fc.Arbitrary<BlockNode> = fc
  .record({
    imageId: fc.constantFrom('img-1', 'img-2', 'img-3'),
    alt: fc.constantFrom('', 'a chart', 'a photo'),
    safeToShare: fc.boolean(),
    caption: inlineArb,
  })
  .map(({ caption, ...attrs }) =>
    withInline({ type: 'figure' as const, attrs }, caption),
  )

const blockArb: fc.Arbitrary<BlockNode> = fc.oneof(
  { weight: 4, arbitrary: paragraphArb as fc.Arbitrary<BlockNode> },
  { weight: 1, arbitrary: headingArb as fc.Arbitrary<BlockNode> },
  { weight: 1, arbitrary: listArb(1) as fc.Arbitrary<BlockNode> },
  { weight: 1, arbitrary: tableArb },
  { weight: 1, arbitrary: figureArb },
)

// A valid rich text document with every node and mark of the subset. It is not
// canonical: marks may repeat or come in any order, and text nodes may be
// adjacent with the same marks.
export const richTextArbitrary: fc.Arbitrary<RichTextDoc> = fc
  .array(blockArb, { minLength: 1, maxLength: 4 })
  .map(content => ({ type: 'doc' as const, content }))

// ---- Editor noise -------------------------------------------------------------

export type Noise = Readonly<{
  split: boolean
  empty: boolean
  reverseMarks: boolean
  defaults: boolean
}>

export const noiseArbitrary: fc.Arbitrary<Noise> = fc.record({
  split: fc.boolean(),
  empty: fc.boolean(),
  reverseMarks: fc.boolean(),
  defaults: fc.boolean(),
})

const noisyInline = (
  nodes: ReadonlyArray<InlineNode> | undefined,
  noise: Noise,
): ReadonlyArray<InlineNode> | undefined => {
  if (nodes === undefined) {
    return undefined
  }
  const out: Array<InlineNode> = []
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      out.push(node)
      continue
    }
    const marks =
      node.marks === undefined
        ? undefined
        : noise.reverseMarks
          ? [...node.marks].reverse().map(mark =>
              mark.type === 'link' && noise.defaults
                ? ({
                    ...mark,
                    attrs: {
                      ...mark.attrs,
                      target: '_blank',
                      rel: null,
                      class: null,
                    },
                  } as Mark)
                : mark,
            )
          : node.marks
    const base = (text: string): InlineNode =>
      marks === undefined
        ? { type: 'text', text }
        : { type: 'text', text, marks }
    if (noise.split && node.text.length > 1) {
      const middle = Math.floor(node.text.length / 2)
      out.push(base(node.text.slice(0, middle)), base(node.text.slice(middle)))
    } else {
      out.push(base(node.text))
    }
    if (noise.empty) {
      out.push(base(''))
    }
  }
  return out
}

const noisyBlock = <B extends BlockNode | ListBlock>(
  block: B,
  noise: Noise,
): B => {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'figure': {
      const content = noisyInline(block.content, noise)
      return (content === undefined ? block : { ...block, content }) as B
    }
    case 'bulletList':
    case 'orderedList':
      return {
        ...block,
        ...(block.type === 'orderedList' && noise.defaults
          ? {
              attrs: {
                ...block.attrs,
                start: block.attrs?.start ?? 1,
                type: null,
              },
            }
          : {}),
        content: block.content.map(item => ({
          ...item,
          content: item.content.map(child => noisyBlock(child, noise)),
        })),
      } as B
    case 'table':
      return {
        ...block,
        content: block.content.map(row => ({
          ...row,
          content: row.content.map(cell => ({
            ...cell,
            ...(noise.defaults
              ? {
                  attrs: {
                    colspan: cell.attrs?.colspan ?? 1,
                    rowspan: cell.attrs?.rowspan ?? 1,
                    colwidth: cell.attrs?.colwidth ?? null,
                  },
                }
              : {}),
            content: cell.content.map(child => noisyBlock(child, noise)),
          })),
        })),
      } as B
  }
}

// The same document as the editor might return it: split text, empty text
// nodes, marks in another order, attributes at their defaults. Its canonical
// form is the canonical form of the original.
export const noisyRichText = (doc: RichTextDoc, noise: Noise): RichTextDoc => ({
  type: 'doc',
  content: doc.content.map(block => noisyBlock(block, noise)),
})

// ---- Content ------------------------------------------------------------------

const PEOPLE = ['p1', 'p2', 'p3']

const dateArb = (precision: 'day' | 'month'): fc.Arbitrary<string> =>
  fc
    .record({
      year: fc.integer({ min: 2000, max: 2030 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
    })
    .map(({ year, month, day }) => {
      const base = `${year}-${String(month).padStart(2, '0')}`
      return precision === 'month'
        ? base
        : `${base}-${String(day).padStart(2, '0')}`
    })

const reasonArb = fc.constantFrom(
  'not relevant',
  'no such person',
  'out of scope',
)

const concreteValueArb = (item: Item): fc.Arbitrary<ItemValue | undefined> => {
  switch (item.type) {
    case 'text':
      return fc
        .oneof(word, fc.constant(''))
        .map(text => ({ type: 'text' as const, text }))
    case 'rich_text':
      return richTextArbitrary.map(doc => ({ type: 'rich_text' as const, doc }))
    case 'date':
      return dateArb(item.precision).map(date => ({
        type: 'date' as const,
        date,
      }))
    case 'select': {
      const ids = item.options.map(option => option.id)
      return (
        item.multiple
          ? fc.subarray(ids)
          : fc
              .option(fc.constantFrom(...ids), { nil: undefined })
              .map(id => (id === undefined ? [] : [id]))
      ).map(optionIds => ({ type: 'select' as const, optionIds }))
    }
    case 'people':
      return (
        item.multiple
          ? fc.subarray(PEOPLE)
          : fc
              .option(fc.constantFrom(...PEOPLE), { nil: undefined })
              .map(id => (id === undefined ? [] : [id]))
      ).map(personIds => ({ type: 'people' as const, personIds }))
    case 'signature':
      return fc
        .record({
          name: fc.oneof(word, fc.constant('')),
          date: fc.option(dateArb('day'), { nil: undefined }),
        })
        .map(({ name, date }) => ({
          type: 'signature' as const,
          name,
          ...(date === undefined ? {} : { date }),
        }))
    case 'case_value':
      return fc.constant(undefined)
    case 'repeated':
      return fc
        .array(entryArb(item.items), {
          maxLength: Math.min(item.max ?? 2, 2),
        })
        .map(entries => ({ type: 'repeated' as const, entries }))
  }
}

const valueArb = (item: Item): fc.Arbitrary<ItemValue | undefined> => {
  const concrete = concreteValueArb(item)
  if (
    item.requirement === 'optional_with_reason' &&
    item.type !== 'case_value'
  ) {
    return fc.oneof(
      { weight: 3, arbitrary: concrete },
      {
        weight: 1,
        arbitrary: reasonArb.map((reason): ItemValue => ({
          type: 'not_applicable',
          reason,
        })),
      },
    )
  }
  return concrete
}

const valuesArb = (items: ReadonlyArray<Item>): fc.Arbitrary<ItemValues> =>
  fc
    .tuple(
      ...items.map(item =>
        fc
          .option(valueArb(item), { nil: undefined, freq: 4 })
          .map(value => value ?? undefined),
      ),
    )
    .map(list => {
      const out: Record<string, ItemValue> = {}
      items.forEach((item, index) => {
        const value = list[index]
        if (value !== undefined) {
          out[item.id] = value
        }
      })
      return out
    })

// NOTE: Entry IDs are placeholders (`''`) until `withEntryIds` runs.
const entryArb = (items: ReadonlyArray<Item>): fc.Arbitrary<ItemEntry> =>
  fc
    .record({
      title: fc.option(word, { nil: undefined }),
      values: valuesArb(items),
    })
    .map(({ title, values }) => ({
      id: '',
      ...(title === undefined ? {} : { title }),
      values,
    }))

const sectionsArb = (
  sections: ReadonlyArray<Section>,
): fc.Arbitrary<SectionContents> =>
  fc
    .tuple(
      ...sections.map(section =>
        fc
          .option(sectionArb(section), { nil: undefined, freq: 5 })
          .map(value => value ?? undefined),
      ),
    )
    .map(list => {
      const out: Record<string, SectionContent> = {}
      sections.forEach((section, index) => {
        const value = list[index]
        if (value !== undefined) {
          out[section.id] = value
        }
      })
      return out
    })

const sectionArb = (section: Section): fc.Arbitrary<SectionContent> => {
  const na =
    section.requirement === 'optional_with_reason'
      ? fc.option(reasonArb, { nil: undefined, freq: 4 })
      : fc.constant(undefined)
  if (section.repeat === undefined) {
    return fc
      .record({
        na,
        values: valuesArb(section.items),
        sections: sectionsArb(section.sections),
      })
      .map(({ na: reason, values, sections }) => ({
        ...(reason === undefined ? {} : { notApplicable: { reason } }),
        values,
        sections,
      }))
  }
  const entry: fc.Arbitrary<SectionEntry> = fc
    .record({
      title: fc.option(word, { nil: undefined }),
      values: valuesArb(section.items),
      sections: sectionsArb(section.sections),
    })
    .map(({ title, values, sections }) => ({
      id: '',
      ...(title === undefined ? {} : { title }),
      values,
      sections,
    }))
  return fc
    .record({
      na,
      entries: fc.array(entry, {
        maxLength: Math.min(section.repeat.max ?? 2, 2),
      }),
    })
    .map(({ na: reason, entries }) => ({
      ...(reason === undefined ? {} : { notApplicable: { reason } }),
      values: {},
      sections: {},
      entries,
    }))
}

// ---- Entry IDs ----------------------------------------------------------------

type Counter = { next: number }

const idItemValues = (values: ItemValues, counter: Counter): ItemValues =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]) => [
      id,
      value.type === 'repeated'
        ? {
            ...value,
            entries: value.entries.map(entry => ({
              ...entry,
              id: `e${++counter.next}`,
              values: idItemValues(entry.values, counter),
            })),
          }
        : value,
    ]),
  )

const idSections = (
  sections: SectionContents,
  counter: Counter,
): SectionContents =>
  Object.fromEntries(
    Object.entries(sections).map(([id, section]) => [
      id,
      {
        ...section,
        values: idItemValues(section.values, counter),
        sections: idSections(section.sections, counter),
        ...(section.entries === undefined
          ? {}
          : {
              entries: section.entries.map(entry => ({
                ...entry,
                id: `e${++counter.next}`,
                values: idItemValues(entry.values, counter),
                sections: idSections(entry.sections, counter),
              })),
            }),
      },
    ]),
  )

// Gives every entry its own stable ID (`e1`, `e2`, ...).
export const withEntryIds = (content: ReportContent): ReportContent => ({
  ...content,
  sections: idSections(content.sections, { next: 0 }),
})

// Valid content for the template: it fits (`validateContent` accepts it), with
// sections, items, entries and *not applicable* marks chosen at random, and end
// answers chosen now and then.
export const contentArbitrary = (
  template: Template,
): fc.Arbitrary<ReportContent> => {
  const top =
    template.conclusion === undefined
      ? template.sections
      : [...template.sections, template.conclusion]
  return sectionsArb(top).map(sections =>
    withEntryIds({
      schemaVersion: CONTENT_SCHEMA_VERSION,
      templateId: template.id,
      templateVersion: template.version,
      sections,
    }),
  )
}

export const templateWithContentArbitrary: fc.Arbitrary<{
  template: Template
  content: ReportContent
}> = validTemplateArbitrary.chain(template =>
  contentArbitrary(template).map(content => ({ template, content })),
)

// ---- Editing helpers ------------------------------------------------------------

const mapSections = (
  sections: ReadonlyArray<Section>,
  contents: SectionContents,
  change: (section: Section, content: SectionContent) => SectionContent,
): SectionContents =>
  Object.fromEntries(
    Object.entries(contents).map(([id, content]) => {
      const section = sections.find(candidate => candidate.id === id)
      if (section === undefined) {
        return [id, content]
      }
      const changed = change(section, content)
      return [
        id,
        {
          ...changed,
          sections: mapSections(section.sections, changed.sections, change),
          ...(changed.entries === undefined
            ? {}
            : {
                entries: changed.entries.map(entry => ({
                  ...entry,
                  sections: mapSections(
                    section.sections,
                    entry.sections,
                    change,
                  ),
                })),
              }),
        },
      ]
    }),
  )

const topSections = (template: Template): ReadonlyArray<Section> =>
  template.conclusion === undefined
    ? template.sections
    : [...template.sections, template.conclusion]

// Marks every section that may be not applicable as not applicable, keeping
// whatever it held.
export const markAllNotApplicable = (
  template: Template,
  content: ReportContent,
): ReportContent => ({
  ...content,
  sections: mapSections(
    topSections(template),
    content.sections,
    (section, sectionContent) =>
      section.requirement === 'optional_with_reason'
        ? { ...sectionContent, notApplicable: { reason: 'not relevant' } }
        : sectionContent,
  ),
})

// Removes every not applicable mark of sections.
export const clearNotApplicable = (
  template: Template,
  content: ReportContent,
): ReportContent => ({
  ...content,
  sections: mapSections(
    topSections(template),
    content.sections,
    (_section, sectionContent) => {
      const { notApplicable: _removed, ...rest } = sectionContent
      return rest
    },
  ),
})

const setValueIn = (
  sections: ReadonlyArray<Section>,
  contents: SectionContents,
  itemId: string,
  value: ItemValue | undefined,
): SectionContents | undefined => {
  for (const section of sections) {
    if (section.repeat !== undefined) {
      continue
    }
    const current = contents[section.id] ?? { values: {}, sections: {} }
    if (section.items.some(item => item.id === itemId)) {
      const { [itemId]: _old, ...rest } = current.values
      return {
        ...contents,
        [section.id]: {
          ...current,
          values: value === undefined ? rest : { ...rest, [itemId]: value },
        },
      }
    }
    const inner = setValueIn(section.sections, current.sections, itemId, value)
    if (inner !== undefined) {
      return { ...contents, [section.id]: { ...current, sections: inner } }
    }
  }
  return undefined
}

// Sets (or, with `undefined`, removes) the value of an item that is not inside
// a repeat, creating the sections on the way. Content is returned unchanged if
// there is no such item.
export const withItemValue = (
  template: Template,
  content: ReportContent,
  itemId: string,
  value: ItemValue | undefined,
): ReportContent => {
  const sections = setValueIn(
    topSections(template),
    content.sections,
    itemId,
    value,
  )
  return sections === undefined ? content : { ...content, sections }
}

// Every end answer of the template, as `[itemId, optionId]`.
export const endAnswersOf = (
  template: Template,
): ReadonlyArray<readonly [string, string]> => {
  const out: Array<readonly [string, string]> = []
  const visit = (sections: ReadonlyArray<Section>) => {
    for (const section of sections) {
      for (const item of section.items) {
        if (item.type === 'select' && item.endOptionId !== undefined) {
          out.push([item.id, item.endOptionId])
        }
      }
      visit(section.sections)
    }
  }
  visit(template.sections)
  return out
}

// Chooses the end answer of one select (`pick` counts from 0) on top of the content.
export const withEndAnswer = (
  template: Template,
  content: ReportContent,
  pick: number,
): ReportContent => {
  const answers = endAnswersOf(template)
  const answer = answers[pick % Math.max(answers.length, 1)]
  return answer === undefined
    ? content
    : withItemValue(template, content, answer[0], {
        type: 'select',
        optionIds: [answer[1]],
      })
}

// Removes the end answer of every select (the answer becomes none).
export const withoutEndAnswers = (
  template: Template,
  content: ReportContent,
): ReportContent =>
  endAnswersOf(template).reduce(
    (current, [itemId]) =>
      withItemValue(template, current, itemId, {
        type: 'select',
        optionIds: [],
      }),
    content,
  )

// ---- A small template with every kind of section ---------------------------------

// An invented template for exact examples: a front matter section, a required
// section with an end answer, an optional section with a reason, a section
// holding a repeatable subsection (which has a subsection of its own), and an
// unnumbered sign-off that stays in force. Numbering: I., a), 1.
export const MINI_TEMPLATE: Template = {
  ...PANEL_TEMPLATE,
  id: 'test-mini',
  name: 'Mini report',
  shortName: 'mini',
  numbering: [
    { style: 'roman', letterCase: 'upper', suffix: '.' },
    { style: 'letters', letterCase: 'lower', suffix: ')' },
    { style: 'arabic', suffix: '.' },
  ],
  sections: [
    section('cover', 'Cover', [textItem('cover-title', 'Title')], {
      frontMatter: true,
    }),
    section('details', 'Details', [
      textItem('name', 'Name'),
      textItem('nick', 'Nickname', { requirement: 'optional' }),
      dateItem('when', 'When'),
      selectItem(
        'proceed',
        'Proceed?',
        [option('yes', 'Yes'), option('no', 'No')],
        { endOptionId: 'no' },
      ),
    ]),
    section(
      'extras',
      'Extras',
      [richTextItem('extras-text', 'Extras', { requirement: 'optional' })],
      { requirement: 'optional_with_reason' },
    ),
    section(
      'things',
      'Things',
      [textItem('things-intro', 'Introduction', { requirement: 'optional' })],
      {
        sections: [
          section(
            'thing',
            'Thing',
            [
              textItem('thing-title', 'Thing title'),
              richTextItem('thing-body', 'Body', { requirement: 'optional' }),
              repeatedItem(
                'thing-refs',
                'References',
                'Reference',
                [textItem('ref-text', 'Reference')],
                { requirement: 'optional', min: 0, max: 3 },
              ),
            ],
            {
              repeat: { min: 1, max: 3 },
              sections: [
                section('thing-facts', 'Facts', [
                  richTextItem('thing-facts-text', 'Facts'),
                ]),
              ],
            },
          ),
          section('things-summary', 'Summary', [
            richTextItem('things-summary-text', 'Summary'),
          ]),
        ],
      },
    ),
    section('sign', 'Sign-off', [signatureItem('signature', 'Signed')], {
      numbered: false,
    }),
  ],
  ending: {
    outcomeText: 'The report ended early.',
    staysInForce: ['sign'],
  },
  contentsDepth: 2,
  pageNumbering: 'restart_after_front_matter',
}
