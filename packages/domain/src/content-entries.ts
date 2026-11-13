import { Result } from 'effect'

// NOTE: Editing a list of repeated entries (D23): the entries of a repeatable
// subsection, or of a repeated item. Pure functions over any list of entries
// that have an `id` and an optional author `title`. Limits are the template's
// `min` and `max`.
//
// - Adding is refused at the maximum, removing is refused at the minimum (a
//   list that must hold one entry never loses its last one), and both answer
//   with a fixed, plain message for the screen.
// - Entries keep their order, and a number is never stored: numbering counts
//   the entries in order (numbering.ts), so moving or removing one renumbers
//   the ones after it.
// - A title is the author's own text. Blank means none, and a title is cut to
//   the 200 characters content.ts allows.

export const MAX_ENTRY_TITLE = 200

export type EntryLimits = Readonly<{ min: number; max?: number }>

export type EntryRefusal = 'at_max' | 'at_min' | 'unknown_entry' | 'duplicate_id'

type Entry = Readonly<{ id: string; title?: string }>

export const refusalText = (
  refusal: EntryRefusal,
  limits: EntryLimits,
  noun: string,
): string => {
  switch (refusal) {
    case 'at_max':
      return `At most ${limits.max ?? 0} ${plural(noun, limits.max ?? 0)} can be added here.`
    case 'at_min':
      return `At least ${limits.min} ${plural(noun, limits.min)} ${limits.min === 1 ? 'is' : 'are'} needed here, so the last ${limits.min === 1 ? 'one' : `${limits.min}`} cannot be removed.`
    case 'unknown_entry':
      return `That ${noun} is no longer in the list.`
    case 'duplicate_id':
      return `That ${noun} already exists.`
  }
}

const plural = (noun: string, count: number): string =>
  count === 1 ? noun : `${noun} entries`

export const canAdd = (count: number, limits: EntryLimits): boolean =>
  limits.max === undefined || count < limits.max

export const canRemove = (count: number, limits: EntryLimits): boolean =>
  count > limits.min

// NOTE: One line for the list: how many there are and what is still asked.
export const countText = (
  count: number,
  limits: EntryLimits,
  noun: string,
): string => {
  const have = `${count} ${count === 1 ? noun : `${noun} entries`}.`
  if (count < limits.min) {
    const missing = limits.min - count
    return `${have} Add ${missing} more: at least ${limits.min} ${limits.min === 1 ? 'is' : 'are'} needed.`
  }
  if (limits.max !== undefined && count >= limits.max) {
    return `${have} That is the most allowed (${limits.max}).`
  }
  return have
}

export const addEntry = <E extends Entry>(
  entries: ReadonlyArray<E>,
  entry: E,
  limits: EntryLimits,
): Result.Result<ReadonlyArray<E>, EntryRefusal> => {
  if (entries.some(existing => existing.id === entry.id)) {
    return Result.fail('duplicate_id')
  }
  if (!canAdd(entries.length, limits)) {
    return Result.fail('at_max')
  }
  return Result.succeed([...entries, entry])
}

export const removeEntry = <E extends Entry>(
  entries: ReadonlyArray<E>,
  id: string,
  limits: EntryLimits,
): Result.Result<ReadonlyArray<E>, EntryRefusal> => {
  if (!entries.some(entry => entry.id === id)) {
    return Result.fail('unknown_entry')
  }
  if (!canRemove(entries.length, limits)) {
    return Result.fail('at_min')
  }
  return Result.succeed(entries.filter(entry => entry.id !== id))
}

// NOTE: Moves one entry a step up (`-1`) or down (`1`). At either end, or for
// an unknown entry, the list is returned as it was.
export const moveEntry = <E extends Entry>(
  entries: ReadonlyArray<E>,
  id: string,
  step: -1 | 1,
): ReadonlyArray<E> => {
  const from = entries.findIndex(entry => entry.id === id)
  const to = from + step
  const moving = entries[from]
  const other = entries[to]
  if (from < 0 || moving === undefined || other === undefined) {
    return entries
  }
  return entries.map((entry, index) =>
    index === from ? other : index === to ? moving : entry,
  )
}

export const cleanTitle = (text: string): string | undefined => {
  const trimmed = text.trim().slice(0, MAX_ENTRY_TITLE).trim()
  return trimmed === '' ? undefined : trimmed
}

// NOTE: Sets the author's title of an entry. Blank removes it.
export const retitleEntry = <E extends Entry>(
  entries: ReadonlyArray<E>,
  id: string,
  text: string,
): ReadonlyArray<E> => {
  const title = cleanTitle(text)
  return entries.map(entry => {
    if (entry.id !== id) {
      return entry
    }
    const { title: _old, ...rest } = entry
    // The rest of an entry of type E is still an E without its title.
    return Object.assign(rest, title === undefined ? {} : { title }) as E
  })
}

// NOTE: The text of a list row: the author's title, otherwise the template's
// label with the number of the entry ("Allegation 2").
export const entryDisplayTitle = (
  entry: Entry,
  label: string,
  index: number,
): string => entry.title ?? `${label} ${index + 1}`
