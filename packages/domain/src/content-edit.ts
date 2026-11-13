import {
  type ItemEntry,
  type ItemValue,
  type ItemValues,
  type SectionContent,
  type SectionContents,
  type SectionEntry,
} from './content'
import { type EntryLimits } from './content-entries'
import { type Item, type Section, type Template } from './template'

// NOTE: Editing report content one value at a time, as the drafting screen
// does. Content stays sparse (content.ts): clearing a value removes it, and a
// section left with nothing in it is removed from its parent, so an edit that
// is undone leaves the content exactly as it was. An entry is the exception:
// an entry the author added stays, even when it is still empty.
//
// A section is addressed by its key as `numberSections` writes it: parts
// separated by `/`, one for each level, from the top-level section down. A
// part is a section ID, or, for one entry of a repeatable section,
// `id#entry`: `facts-findings/allegation-block#a1/key-element#k2`. The first
// part is the top-level section, which is the unit of saving. The key without
// `#entry` on its last part is the group: the repeatable section as a whole,
// which holds its entries and its *not applicable* mark.
//
// A repeated item inside a section or an entry is addressed by a path of
// `{ itemId, entryId }` steps (a repeated item can hold repeated items).

export type KeyPart = Readonly<{ sectionId: string; entryId?: string }>

export const keyParts = (key: string): ReadonlyArray<KeyPart> =>
  key.split('/').map(part => {
    const at = part.indexOf('#')
    return at < 0
      ? { sectionId: part }
      : { sectionId: part.slice(0, at), entryId: part.slice(at + 1) }
  })

const partText = (part: KeyPart): string =>
  part.entryId === undefined ? part.sectionId : `${part.sectionId}#${part.entryId}`

const keyOf = (parts: ReadonlyArray<KeyPart>): string =>
  parts.map(partText).join('/')

export const isEntryKey = (key: string): boolean => key.includes('#')

export const sectionIdsOfKey = (key: string): ReadonlyArray<string> =>
  keyParts(key).map(part => part.sectionId)

export const topSectionIdOfKey = (key: string): string =>
  keyParts(key)[0]?.sectionId ?? key

// NOTE: The group of a key: the same section without its entry. A key of a
// section that is not repeatable is its own group.
export const groupKeyOf = (key: string): string => {
  const parts = keyParts(key)
  const last = parts[parts.length - 1]
  return last === undefined
    ? key
    : keyOf([...parts.slice(0, -1), { sectionId: last.sectionId }])
}

export const entryIdOfKey = (key: string): string | undefined =>
  keyParts(key).at(-1)?.entryId

// NOTE: The key of the section that holds this one: for an entry, its group's
// parent; for a section, the key without its last part. Empty for a top-level
// section.
export const parentKeyOf = (key: string): string =>
  keyOf(keyParts(key).slice(0, -1))

// NOTE: The entry key of a repeatable group.
export const entryKeyOf = (groupKey: string, entryId: string): string => {
  const parts = keyParts(groupKey)
  const last = parts[parts.length - 1]
  return last === undefined
    ? groupKey
    : keyOf([...parts.slice(0, -1), { sectionId: last.sectionId, entryId }])
}

export const childKeyOf = (parentKey: string, sectionId: string): string =>
  parentKey === '' ? sectionId : `${parentKey}/${sectionId}`

const topSections = (template: Template): ReadonlyArray<Section> =>
  template.conclusion === undefined
    ? template.sections
    : [...template.sections, template.conclusion]

// NOTE: The template section a key names. An entry mark belongs only to a
// repeatable section, and a repeatable section is named with it or as a group
// (no mark on its last part), never a repeatable one without a mark in the
// middle of a key.
export const sectionOfKey = (
  template: Template,
  key: string,
): Section | undefined => {
  const parts = keyParts(key)
  let sections: ReadonlyArray<Section> = topSections(template)
  let found: Section | undefined
  for (const [index, part] of parts.entries()) {
    found = sections.find(section => section.id === part.sectionId)
    if (found === undefined) {
      return undefined
    }
    const isRepeatable = found.repeat !== undefined
    const isLast = index === parts.length - 1
    if (part.entryId !== undefined && !isRepeatable) {
      return undefined
    }
    if (part.entryId === undefined && isRepeatable && !isLast) {
      return undefined
    }
    sections = found.sections
  }
  return found
}

const EMPTY_CONTENT: SectionContent = { values: {}, sections: {} }

// NOTE: What a key holds: the content of a section, the content of a group
// (with its entries and its mark), or the values and subsections of one entry.
export const contentOfKey = (
  contents: SectionContents,
  key: string,
): SectionContent => {
  let scope: SectionContent = { values: {}, sections: contents }
  for (const part of keyParts(key)) {
    const content: SectionContent =
      scope.sections[part.sectionId] ?? EMPTY_CONTENT
    if (part.entryId === undefined) {
      scope = content
    } else {
      const entry: SectionEntry | undefined = content.entries?.find(
        candidate => candidate.id === part.entryId,
      )
      scope = entry ?? EMPTY_CONTENT
    }
  }
  return scope
}

export const entriesOfKey = (
  contents: SectionContents,
  groupKey: string,
): ReadonlyArray<SectionEntry> =>
  contentOfKey(contents, groupKey).entries ?? []

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

const compact = (content: SectionContent): SectionContent => {
  const { entries, ...rest } = content
  return entries === undefined || entries.length === 0
    ? rest
    : { ...rest, entries }
}

// NOTE: Applies `change` to what the last part of the key names, rebuilding
// the content above it. A path that does not exist (an entry that is gone)
// leaves the contents as they were, so a late message cannot invent one.
const updateAt = (
  contents: SectionContents,
  parts: ReadonlyArray<KeyPart>,
  change: (content: SectionContent) => SectionContent,
): SectionContents => {
  const [head, ...rest] = parts
  if (head === undefined) {
    return contents
  }
  const current = contents[head.sectionId]
  let next: SectionContent
  if (head.entryId === undefined) {
    next =
      rest.length === 0
        ? change(current ?? EMPTY_CONTENT)
        : {
            ...(current ?? EMPTY_CONTENT),
            sections: updateAt(
              (current ?? EMPTY_CONTENT).sections,
              rest,
              change,
            ),
          }
  } else {
    const entries = current?.entries
    const at = entries?.findIndex(entry => entry.id === head.entryId) ?? -1
    const entry = entries?.[at]
    if (current === undefined || entries === undefined || entry === undefined) {
      return contents
    }
    let updated: SectionEntry
    if (rest.length === 0) {
      const changed = change({ values: entry.values, sections: entry.sections })
      updated = { ...entry, values: changed.values, sections: changed.sections }
    } else {
      updated = {
        ...entry,
        sections: updateAt(entry.sections, rest, change),
      }
    }
    next = {
      ...current,
      entries: entries.map((existing, index) =>
        index === at ? updated : existing,
      ),
    }
  }
  const tidy = compact(next)
  return isEmptyContent(tidy)
    ? without(contents, head.sectionId)
    : { ...contents, [head.sectionId]: tidy }
}

// NOTE: One step into a repeated item: the item and the entry of it.
export type ItemStep = Readonly<{ itemId: string; entryId: string }>

const setIn = (
  values: ItemValues,
  steps: ReadonlyArray<ItemStep>,
  itemId: string,
  value: ItemValue | undefined,
): ItemValues => {
  const [step, ...rest] = steps
  if (step === undefined) {
    return value === undefined
      ? without(values, itemId)
      : { ...values, [itemId]: value }
  }
  const holder = values[step.itemId]
  if (holder === undefined || holder.type !== 'repeated') {
    return values
  }
  return {
    ...values,
    [step.itemId]: {
      ...holder,
      entries: holder.entries.map(entry =>
        entry.id === step.entryId
          ? { ...entry, values: setIn(entry.values, rest, itemId, value) }
          : entry,
      ),
    },
  }
}

// NOTE: Sets the value of one item of a section or of an entry of a
// repeatable section, or clears it with `undefined`. Contents is the record of
// top-level sections, as in `ReportContent.sections`.
export const withItemValue = (
  contents: SectionContents,
  key: string,
  itemId: string,
  value: ItemValue | undefined,
): SectionContents => withItemValueAt(contents, key, [], itemId, value)

// NOTE: The same inside the entries of repeated items, `steps` from the
// outermost down.
export const withItemValueAt = (
  contents: SectionContents,
  key: string,
  steps: ReadonlyArray<ItemStep>,
  itemId: string,
  value: ItemValue | undefined,
): SectionContents =>
  updateAt(contents, keyParts(key), content => ({
    ...content,
    values: setIn(content.values, steps, itemId, value),
  }))

// ---- Entries of a repeatable section --------------------------------------------

// NOTE: Changes the entries of the repeatable section `groupKey`. The group
// content is created when the first entry is added and removed with the last.
export const withSectionEntries = (
  contents: SectionContents,
  groupKey: string,
  change: (entries: ReadonlyArray<SectionEntry>) => ReadonlyArray<SectionEntry>,
): SectionContents =>
  updateAt(contents, keyParts(groupKey), content => ({
    ...content,
    entries: change(content.entries ?? []),
  }))

// NOTE: Changes the entries of the repeated item `itemId`, `steps` deep. The
// item's value is created with the first entry and removed with the last.
export const withItemEntries = (
  contents: SectionContents,
  key: string,
  steps: ReadonlyArray<ItemStep>,
  itemId: string,
  change: (entries: ReadonlyArray<ItemEntry>) => ReadonlyArray<ItemEntry>,
): SectionContents => {
  const current = itemEntriesOf(contentOfKey(contents, key).values, steps, itemId)
  const next = change(current)
  return withItemValueAt(
    contents,
    key,
    steps,
    itemId,
    next.length === 0 ? undefined : { type: 'repeated', entries: next },
  )
}

export const itemEntriesOf = (
  values: ItemValues,
  steps: ReadonlyArray<ItemStep>,
  itemId: string,
): ReadonlyArray<ItemEntry> => {
  const [step, ...rest] = steps
  if (step === undefined) {
    const value = values[itemId]
    return value?.type === 'repeated' ? value.entries : []
  }
  const holder = values[step.itemId]
  const entry =
    holder?.type === 'repeated'
      ? holder.entries.find(candidate => candidate.id === step.entryId)
      : undefined
  return entry === undefined ? [] : itemEntriesOf(entry.values, rest, itemId)
}

// NOTE: A new, empty entry of a repeatable section.
export const newSectionEntry = (id: string): SectionEntry => ({
  id,
  values: {},
  sections: {},
})

export const newItemEntry = (id: string): ItemEntry => ({ id, values: {} })

export const sectionLimits = (section: Section): EntryLimits =>
  section.repeat === undefined
    ? { min: 0, max: 0 }
    : section.repeat.max === undefined
      ? { min: section.repeat.min }
      : { min: section.repeat.min, max: section.repeat.max }

export const itemLimits = (item: Item): EntryLimits =>
  item.type !== 'repeated'
    ? { min: 0, max: 0 }
    : item.max === undefined
      ? { min: item.min }
      : { min: item.min, max: item.max }

// ---- Not applicable ----------------------------------------------------------------

// NOTE: Marks the section (or the repeatable group) `key` as not applicable
// with the author's reason, or, with `undefined`, takes the mark off. What the
// section held stays, as it does for an end answer. A blank reason is not a
// reason: the contents come back as they were.
export const withSectionNotApplicable = (
  contents: SectionContents,
  key: string,
  reason: string | undefined,
): SectionContents => {
  const trimmed = reason?.trim()
  if (trimmed === '') {
    return contents
  }
  return updateAt(contents, keyParts(groupKeyOf(key)), content => {
    const { notApplicable: _old, ...rest } = content
    return trimmed === undefined
      ? rest
      : { ...rest, notApplicable: { reason: trimmed.slice(0, 500) } }
  })
}

// NOTE: The reason of the section `key` (its group for an entry), if the
// author marked it not applicable.
export const notApplicableReasonOf = (
  contents: SectionContents,
  key: string,
): string | undefined =>
  contentOfKey(contents, groupKeyOf(key)).notApplicable?.reason
