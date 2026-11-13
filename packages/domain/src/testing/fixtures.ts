import {
  CONTENT_SCHEMA_VERSION,
  type Item,
  type ItemEntry,
  type ItemValue,
  type ItemValues,
  type ReportContent,
  type Section,
  type SectionContent,
  type SectionContents,
  type SectionEntry,
  type Template,
} from '../index'

// NOTE: A fixture that fills every item of a template (stage 4e). It is
// deterministic: the same template always gives the same JSON, with entry IDs
// `e1`, `e2`, ... in document order. Text is `Synthetic text for <item ID>`,
// so a scan can tell it from any instruction text of the template.
//
// - Select items get their first option that does not end the report, so the
//   whole template stays in force; a multiple select gets its first two.
// - A repeatable section or repeated item gets its minimum number of entries,
//   and at least two where the template allows it, each filled, with an author
//   title for a section.
// - Case-file values hold nothing, as the content schema says.
// - `notApplicable` marks the optional-with-reason sections it is asked to
//   mark, keeping what they hold.

const paragraph = (text: string): ItemValue => ({
  type: 'rich_text',
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  },
})

type Counter = { next: number }

const entryCount = (min: number, max: number | undefined): number =>
  Math.max(min, Math.min(2, max ?? 2))

const valueOf = (item: Item, counter: Counter): ItemValue | undefined => {
  switch (item.type) {
    case 'case_value':
      return undefined
    case 'text':
      return { type: 'text', text: `Synthetic text for ${item.id}` }
    case 'date':
      return {
        type: 'date',
        date: item.precision === 'day' ? '2026-03-04' : '2026-03',
      }
    case 'select': {
      const usable = item.options.filter(
        option => option.id !== item.endOptionId,
      )
      return {
        type: 'select',
        optionIds: usable
          .slice(0, item.multiple ? 2 : 1)
          .map(option => option.id),
      }
    }
    case 'people':
      return {
        type: 'people',
        personIds: item.multiple ? ['person-1', 'person-2'] : ['person-1'],
      }
    case 'rich_text':
      return paragraph(`Synthetic text for ${item.id}`)
    case 'signature':
      return {
        type: 'signature',
        name: `Synthetic Signer ${item.id}`,
        date: '2026-03-05',
      }
    case 'repeated': {
      const entries: Array<ItemEntry> = []
      for (let index = 0; index < entryCount(item.min, item.max); index += 1) {
        counter.next += 1
        entries.push({
          id: `e${counter.next}`,
          values: valuesOf(item.items, counter),
        })
      }
      return { type: 'repeated', entries }
    }
  }
}

const valuesOf = (
  items: ReadonlyArray<Item>,
  counter: Counter,
): ItemValues =>
  Object.fromEntries(
    items.flatMap(item => {
      const value = valueOf(item, counter)
      return value === undefined ? [] : [[item.id, value] as const]
    }),
  )

const sectionContent = (
  section: Section,
  counter: Counter,
  marked: ReadonlySet<string>,
): SectionContent => {
  const notApplicable = marked.has(section.id)
    ? { notApplicable: { reason: `Synthetic reason for ${section.id}` } }
    : {}
  if (section.repeat === undefined) {
    return {
      ...notApplicable,
      values: valuesOf(section.items, counter),
      sections: sectionsContent(section.sections, counter, marked),
    }
  }
  const entries: Array<SectionEntry> = []
  const count = entryCount(section.repeat.min, section.repeat.max)
  for (let index = 0; index < count; index += 1) {
    counter.next += 1
    entries.push({
      id: `e${counter.next}`,
      title: `Synthetic ${section.title} ${index + 1}`,
      values: valuesOf(section.items, counter),
      sections: sectionsContent(section.sections, counter, marked),
    })
  }
  return { ...notApplicable, values: {}, sections: {}, entries }
}

const sectionsContent = (
  sections: ReadonlyArray<Section>,
  counter: Counter,
  marked: ReadonlySet<string>,
): SectionContents =>
  Object.fromEntries(
    sections.map(section => [
      section.id,
      sectionContent(section, counter, marked),
    ]),
  )

export const fullContent = (
  template: Template,
  options: Readonly<{ notApplicable?: ReadonlyArray<string> }> = {},
): ReportContent => ({
  schemaVersion: CONTENT_SCHEMA_VERSION,
  templateId: template.id,
  templateVersion: template.version,
  sections: sectionsContent(
    template.conclusion === undefined
      ? template.sections
      : [...template.sections, template.conclusion],
    { next: 0 },
    new Set(options.notApplicable ?? []),
  ),
})

// NOTE: Every text the template carries as guidance: section and item
// instructions. A scan of stored content must find none of them.
export const instructionTexts = (template: Template): ReadonlyArray<string> => {
  const out: Array<string> = []
  const items = (list: ReadonlyArray<Item>): void => {
    for (const item of list) {
      if (item.instruction !== undefined) {
        out.push(item.instruction)
      }
      if (item.type === 'repeated') {
        items(item.items)
      }
    }
  }
  const sections = (list: ReadonlyArray<Section>): void => {
    for (const section of list) {
      if (section.instruction !== undefined) {
        out.push(section.instruction)
      }
      items(section.items)
      sections(section.sections)
    }
  }
  sections(
    template.conclusion === undefined
      ? template.sections
      : [...template.sections, template.conclusion],
  )
  return out
}
