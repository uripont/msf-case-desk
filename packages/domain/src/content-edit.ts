import {
  type ItemValue,
  type ItemValues,
  type SectionContent,
  type SectionContents,
} from './content'
import { type Section, type Template } from './template'

// NOTE: Editing report content one value at a time, as the drafting screen
// does. Content stays sparse (content.ts): clearing a value removes it, and a
// section left with nothing in it is removed from its parent, so an edit that
// is undone leaves the content exactly as it was.
//
// A section is addressed by its key as `numberSections` writes it:
// `parent/child`. The first part is the top-level section, which is the unit
// of saving. A key with an entry (`#entry`) belongs to a repeatable section,
// whose entries are edited elsewhere; these functions do not address them.

export const isEntryKey = (key: string): boolean => key.includes('#')

export const sectionIdsOfKey = (key: string): ReadonlyArray<string> =>
  key.split('/')

export const topSectionIdOfKey = (key: string): string =>
  sectionIdsOfKey(key)[0] ?? key

export const sectionOfKey = (
  template: Template,
  key: string,
): Section | undefined => {
  if (isEntryKey(key)) {
    return undefined
  }
  const top =
    template.conclusion === undefined
      ? template.sections
      : [...template.sections, template.conclusion]
  return sectionIdsOfKey(key).reduce<{
    sections: ReadonlyArray<Section>
    found: Section | undefined
  }>(
    (walk, id) => {
      const found = walk.sections.find(section => section.id === id)
      return { sections: found?.sections ?? [], found }
    },
    { sections: top, found: undefined },
  ).found
}

const EMPTY_CONTENT: SectionContent = { values: {}, sections: {} }

export const contentOfKey = (
  contents: SectionContents,
  key: string,
): SectionContent => {
  if (isEntryKey(key)) {
    return EMPTY_CONTENT
  }
  return sectionIdsOfKey(key).reduce<SectionContent>(
    (content, id) => content.sections[id] ?? EMPTY_CONTENT,
    { values: {}, sections: contents },
  )
}

const isEmptyContent = (content: SectionContent): boolean =>
  content.notApplicable === undefined &&
  (content.entries === undefined || content.entries.length === 0) &&
  Object.keys(content.values).length === 0 &&
  Object.keys(content.sections).length === 0

const without = <A>(
  record: { readonly [key: string]: A },
  key: string,
): { readonly [key: string]: A } =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))

const updateAt = (
  contents: SectionContents,
  ids: ReadonlyArray<string>,
  change: (content: SectionContent) => SectionContent,
): SectionContents => {
  const [head, ...rest] = ids
  if (head === undefined) {
    return contents
  }
  const current = contents[head] ?? EMPTY_CONTENT
  const next =
    rest.length === 0
      ? change(current)
      : { ...current, sections: updateAt(current.sections, rest, change) }
  return isEmptyContent(next)
    ? without(contents, head)
    : { ...contents, [head]: next }
}

// NOTE: Sets the value of one item of a section, or clears it with
// `undefined`. Contents is the record of top-level sections, as in
// `ReportContent.sections`.
export const withItemValue = (
  contents: SectionContents,
  key: string,
  itemId: string,
  value: ItemValue | undefined,
): SectionContents =>
  isEntryKey(key)
    ? contents
    : updateAt(contents, sectionIdsOfKey(key), content => {
        const values: ItemValues =
          value === undefined
            ? without(content.values, itemId)
            : { ...content.values, [itemId]: value }
        return { ...content, values }
      })
