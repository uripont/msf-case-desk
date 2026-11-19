import { Array, Option } from 'effect'

import type {
  Comparison,
  Item,
  Person,
  Section,
  Template,
} from '@quoroom/domain'

// NOTE: Plain-language names for what the sharing, comparison and history
// screens talk about: the time of a save, and the place of a unit of a draft
// (a conflict key such as `s:allegations/s:allegation/e:7f3a/i:summary`) in
// the template. Pure, so each is tested without a screen.

// NOTE: neither throws: a time no date can hold reads as an unknown time.
export const timeText = (epochMs: number): string => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(epochMs))
  } catch {
    return 'an unknown time'
  }
}

// NOTE: the same moment with the name of the zone it is shown in (the
// viewer's own), for the places where a time stands alone, such as a log.
export const momentWithZone = (epochMs: number): string => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(new Date(epochMs))
  } catch {
    return 'an unknown time'
  }
}

export const momentText = (epochMs: number): string => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(epochMs))
  } catch {
    return 'an unknown time'
  }
}

export const topLevelSections = (template: Template): ReadonlyArray<Section> =>
  template.conclusion === undefined
    ? template.sections
    : [...template.sections, template.conclusion]

export const findSection = (
  sections: ReadonlyArray<Section>,
  id: string,
): Option.Option<Section> => {
  for (const section of sections) {
    if (section.id === id) {
      return Option.some(section)
    }
    const inner = findSection(section.sections, id)
    if (Option.isSome(inner)) {
      return inner
    }
  }
  return Option.none()
}

export const findItemIn = (
  items: ReadonlyArray<Item>,
  id: string,
): Option.Option<Item> => {
  for (const item of items) {
    if (item.id === id) {
      return Option.some(item)
    }
    if (item.type === 'repeated') {
      const inner = findItemIn(item.items, id)
      if (Option.isSome(inner)) {
        return inner
      }
    }
  }
  return Option.none()
}

// NOTE: The item `id` anywhere in the section (and the repeated items in it).
export const findItem = (section: Section, id: string): Option.Option<Item> =>
  findItemIn(section.items, id)

const SUFFIXES: Readonly<Record<string, string>> = {
  title: 'title',
  status: 'not applicable mark',
  order: 'order',
  limit: 'entries',
  name: 'name',
  label: 'label',
}

// NOTE: "Allegations › Allegation › Smith matter › Description". An entry is
// named by its title when the comparison carries one (`titles`), else by its
// kind. Unknown parts are shown as they are, never failing.
export const keyLabel = (
  template: Template,
  key: string,
  titles: Readonly<Record<string, string>> = {},
  people: ReadonlyArray<Person> = [],
): string => {
  if (key.startsWith('image:')) {
    return 'Image: safe to share'
  }
  if (key.startsWith('person:')) {
    const [head, rest] = key.split('/')
    const id = (head ?? '').slice('person:'.length)
    const person = Array.findFirst(people, candidate => candidate.id === id)
    const name = Option.match(person, {
      onNone: () => 'A person',
      onSome: found => found.name,
    })
    return rest === undefined ? name : `${name} › ${SUFFIXES[rest] ?? rest}`
  }
  const parts: Array<string> = []
  let sections: ReadonlyArray<Section> = topLevelSections(template)
  let items: ReadonlyArray<Item> = []
  for (const segment of key.split('/')) {
    if (segment.startsWith('s:')) {
      const found = Array.findFirst(
        sections,
        section => section.id === segment.slice(2),
      )
      if (Option.isSome(found)) {
        parts.push(found.value.title)
        sections = found.value.sections
        items = found.value.items
      } else {
        parts.push(segment.slice(2))
      }
    } else if (segment.startsWith('i:')) {
      const found = Array.findFirst(items, item => item.id === segment.slice(2))
      if (Option.isSome(found)) {
        parts.push(found.value.label)
        items = found.value.type === 'repeated' ? found.value.items : []
        sections = []
      } else {
        parts.push(segment.slice(2))
      }
    } else if (segment.startsWith('e:')) {
      const id = segment.slice(2)
      parts.push(titles[id] ?? 'an entry')
    } else {
      parts.push(SUFFIXES[segment] ?? segment)
    }
  }
  return parts.join(' › ')
}

// NOTE: The item with this ID in any top-level section (item IDs are unique
// inside the template).
export const findItemAnywhere = (
  template: Template,
  id: string,
): Option.Option<Item> => {
  const search = (sections: ReadonlyArray<Section>): Option.Option<Item> => {
    for (const section of sections) {
      const own = findItemIn(section.items, id)
      if (Option.isSome(own)) {
        return own
      }
      const inner = search(section.sections)
      if (Option.isSome(inner)) {
        return inner
      }
    }
    return Option.none()
  }
  return search(topLevelSections(template))
}

const lastEntryId = (key: string): string | undefined => {
  const parts = key.split('/').filter(part => part.startsWith('e:'))
  return parts[parts.length - 1]?.slice(2)
}

// NOTE: The titles of the entries a comparison mentions, by entry ID, taken
// from the entries themselves and from the automatic changes.
export const entryTitles = (
  comparison: Pick<Comparison, 'conflicts' | 'automatic'>,
): Readonly<Record<string, string>> => {
  const titles: Record<string, string> = {}
  for (const conflict of comparison.conflicts) {
    if (conflict.kind === 'entries_limit' || conflict.kind === 'entry_order') {
      Object.assign(titles, conflict.titles ?? {})
    }
    if (conflict.kind === 'entry') {
      for (const entry of [conflict.ours, conflict.theirs, conflict.base]) {
        if (entry?.title !== undefined) {
          titles[entry.id] ??= entry.title
        }
      }
    }
  }
  for (const change of comparison.automatic ?? []) {
    const id = lastEntryId(change.key)
    if (id !== undefined && change.title !== undefined) {
      titles[id] ??= change.title
    }
  }
  return titles
}
