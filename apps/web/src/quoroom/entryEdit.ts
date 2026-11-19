import { Option, Result, Schema } from 'effect'

import {
  type EntryLimits,
  type EntryRefusal,
  type Item,
  type ItemStep,
  type ItemValue,
  type ItemValues,
  type Section,
  type SectionContents,
  type Template,
  addEntry,
  contentOfKey,
  entriesOfKey,
  itemEntriesOf,
  itemLimits,
  moveEntry,
  newItemEntry,
  newSectionEntry,
  refusalText,
  removeEntry,
  retitleEntry,
  sectionLimits,
  sectionOfKey,
  withItemEntries,
  withItemValueAt,
  withSectionEntries,
  withSectionNotApplicable,
} from '@quoroom/domain'

// NOTE: What the drafting screen edits when it works on a list of entries or
// marks something not applicable, named once so a Message can carry it. A
// target is either a repeatable subsection (`maybeItemId` is None, and
// `sectionKey` is the group key) or a repeated item (`sectionKey` is the
// section or entry that holds it, `steps` the repeated items above it).

export const StepSchema = Schema.Struct({
  itemId: Schema.String,
  entryId: Schema.String,
})

export const Target = Schema.Struct({
  sectionKey: Schema.String,
  steps: Schema.Array(StepSchema),
  maybeItemId: Schema.Option(Schema.String),
})
export type Target = typeof Target.Type

export const sectionTarget = (groupKey: string): Target => ({
  sectionKey: groupKey,
  steps: [],
  maybeItemId: Option.none(),
})

export const itemTarget = (
  sectionKey: string,
  steps: ReadonlyArray<ItemStep>,
  itemId: string,
): Target => ({
  sectionKey,
  steps,
  maybeItemId: Option.some(itemId),
})

// NOTE: A stable text for a target, for records keyed by it (a typed reason
// that is not yet saved).
export const targetId = (target: Target): string =>
  `${target.sectionKey}|${target.steps
    .map(step => `${step.itemId}#${step.entryId}`)
    .join('>')}|${Option.getOrElse(target.maybeItemId, () => '')}`

const findItem = (
  items: ReadonlyArray<Item>,
  steps: ReadonlyArray<ItemStep>,
  itemId: string,
): Item | undefined => {
  const [step, ...rest] = steps
  if (step === undefined) {
    return items.find(item => item.id === itemId)
  }
  const holder = items.find(item => item.id === step.itemId)
  return holder?.type === 'repeated'
    ? findItem(holder.items, rest, itemId)
    : undefined
}

type Located = Readonly<{
  limits: EntryLimits
  noun: string
}>

const locate = (template: Template, target: Target): Located | undefined => {
  const section: Section | undefined = sectionOfKey(template, target.sectionKey)
  if (section === undefined) {
    return undefined
  }
  return Option.match(target.maybeItemId, {
    onNone: () =>
      section.repeat === undefined
        ? undefined
        : { limits: sectionLimits(section), noun: section.title.toLowerCase() },
    onSome: itemId => {
      const item = findItem(section.items, target.steps, itemId)
      return item?.type === 'repeated'
        ? { limits: itemLimits(item), noun: item.entryLabel.toLowerCase() }
        : undefined
    },
  })
}

export type EntryEditResult = Result.Result<SectionContents, string>

const GONE = 'That is no longer in this report.'

// NOTE: How many entries the target holds now.
export const countOf = (contents: SectionContents, target: Target): number =>
  Option.match(target.maybeItemId, {
    onNone: () => entriesOfKey(contents, target.sectionKey).length,
    onSome: itemId =>
      itemEntriesOf(
        contentOfKey(contents, target.sectionKey).values,
        target.steps,
        itemId,
      ).length,
  })

// NOTE: Whether one more may be added: used to refuse before an ID is made.
export const addRefusal = (
  template: Template,
  contents: SectionContents,
  target: Target,
): Option.Option<string> => {
  const located = locate(template, target)
  if (located === undefined) {
    return Option.some(GONE)
  }
  const { max } = located.limits
  return max !== undefined && countOf(contents, target) >= max
    ? Option.some(refusalText('at_max', located.limits, located.noun))
    : Option.none()
}

const currentEntries = (contents: SectionContents, target: Target) =>
  Option.match(target.maybeItemId, {
    onNone: () => entriesOfKey(contents, target.sectionKey),
    onSome: itemId =>
      itemEntriesOf(
        contentOfKey(contents, target.sectionKey).values,
        target.steps,
        itemId,
      ),
  })

export const addEntryTo = (
  template: Template,
  contents: SectionContents,
  target: Target,
  entryId: string,
): EntryEditResult => {
  const located = locate(template, target)
  if (located === undefined) {
    return Result.fail(GONE)
  }
  const refused = (refusal: EntryRefusal) =>
    refusalText(refusal, located.limits, located.noun)
  return Option.match(target.maybeItemId, {
    onNone: () =>
      Result.match(
        addEntry(
          entriesOfKey(contents, target.sectionKey),
          newSectionEntry(entryId),
          located.limits,
        ),
        {
          onFailure: refusal => Result.fail(refused(refusal)),
          onSuccess: entries =>
            Result.succeed(
              withSectionEntries(contents, target.sectionKey, () => entries),
            ),
        },
      ),
    onSome: itemId =>
      Result.match(
        addEntry(
          itemEntriesOf(
            contentOfKey(contents, target.sectionKey).values,
            target.steps,
            itemId,
          ),
          newItemEntry(entryId),
          located.limits,
        ),
        {
          onFailure: refusal => Result.fail(refused(refusal)),
          onSuccess: entries =>
            Result.succeed(
              withItemEntries(
                contents,
                target.sectionKey,
                target.steps,
                itemId,
                () => entries,
              ),
            ),
        },
      ),
  })
}

export const removeEntryFrom = (
  template: Template,
  contents: SectionContents,
  target: Target,
  entryId: string,
): EntryEditResult => {
  const located = locate(template, target)
  if (located === undefined) {
    return Result.fail(GONE)
  }
  const refused = (refusal: EntryRefusal) =>
    refusalText(refusal, located.limits, located.noun)
  return Option.match(target.maybeItemId, {
    onNone: () =>
      Result.match(
        removeEntry(
          entriesOfKey(contents, target.sectionKey),
          entryId,
          located.limits,
        ),
        {
          onFailure: refusal => Result.fail(refused(refusal)),
          onSuccess: entries =>
            Result.succeed(
              withSectionEntries(contents, target.sectionKey, () => entries),
            ),
        },
      ),
    onSome: itemId =>
      Result.match(
        removeEntry(currentEntries(contents, target), entryId, located.limits),
        {
          onFailure: refusal => Result.fail(refused(refusal)),
          onSuccess: entries =>
            Result.succeed(
              withItemEntries(
                contents,
                target.sectionKey,
                target.steps,
                itemId,
                () => entries,
              ),
            ),
        },
      ),
  })
}

export const moveEntryIn = (
  contents: SectionContents,
  target: Target,
  entryId: string,
  step: -1 | 1,
): SectionContents =>
  Option.match(target.maybeItemId, {
    onNone: () =>
      withSectionEntries(contents, target.sectionKey, entries =>
        moveEntry(entries, entryId, step),
      ),
    onSome: itemId =>
      withItemEntries(
        contents,
        target.sectionKey,
        target.steps,
        itemId,
        entries => moveEntry(entries, entryId, step),
      ),
  })

// NOTE: Only the entries of a repeatable subsection have an author's title.
export const retitleEntryIn = (
  contents: SectionContents,
  target: Target,
  entryId: string,
  text: string,
): SectionContents =>
  Option.isNone(target.maybeItemId)
    ? withSectionEntries(contents, target.sectionKey, entries =>
        retitleEntry(entries, entryId, text),
      )
    : contents

// ---- Not applicable ------------------------------------------------------------------

// NOTE: Marks the target not applicable with a reason. For a section, the mark
// is stored beside what it holds. For an item it replaces the value, so the
// replaced value is returned to be kept on screen and put back on restore.
export const markNotApplicable = (
  contents: SectionContents,
  target: Target,
  reason: string,
): SectionContents =>
  Option.match(target.maybeItemId, {
    onNone: () => withSectionNotApplicable(contents, target.sectionKey, reason),
    onSome: itemId =>
      reason.trim() === ''
        ? contents
        : withItemValueAt(contents, target.sectionKey, target.steps, itemId, {
            type: 'not_applicable',
            reason: reason.trim().slice(0, 500),
          }),
  })

export const clearNotApplicable = (
  contents: SectionContents,
  target: Target,
  restored: Option.Option<ItemValue>,
): SectionContents =>
  Option.match(target.maybeItemId, {
    onNone: () =>
      withSectionNotApplicable(contents, target.sectionKey, undefined),
    onSome: itemId =>
      withItemValueAt(
        contents,
        target.sectionKey,
        target.steps,
        itemId,
        Option.getOrUndefined(restored),
      ),
  })

// NOTE: The value an item holds now, if any.
export const valueOf = (
  contents: SectionContents,
  target: Target,
): Option.Option<ItemValue> =>
  Option.flatMap(target.maybeItemId, itemId =>
    Option.fromNullishOr(
      valueIn(
        contentOfKey(contents, target.sectionKey).values,
        target.steps,
        itemId,
      ),
    ),
  )

const valueIn = (
  values: ItemValues,
  steps: ReadonlyArray<ItemStep>,
  itemId: string,
): ItemValue | undefined => {
  const [step, ...rest] = steps
  if (step === undefined) {
    return values[itemId]
  }
  const holder = values[step.itemId]
  const entry =
    holder?.type === 'repeated'
      ? holder.entries.find(candidate => candidate.id === step.entryId)
      : undefined
  return entry === undefined ? undefined : valueIn(entry.values, rest, itemId)
}

// ---- Comparing what is kept ------------------------------------------------------------

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : inner,
  )

export const sameContent = (left: unknown, right: unknown): boolean =>
  canonical(left) === canonical(right)
