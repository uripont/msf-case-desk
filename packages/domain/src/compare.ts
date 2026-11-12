import { Result } from 'effect'

import {
  type ContentProblem,
  type ItemEntry,
  type ItemValue,
  type ItemValues,
  type ReportContent,
  type SectionContent,
  type SectionContents,
  type SectionEntry,
  contentProblems,
  validateContent,
} from './content'
import { type Person, aliasKey, peopleListProblems } from './people'
import {
  type RichTextDoc,
  canonicalRichText,
  decodeRichText,
  richTextFigures,
} from './richtext'
import type { Item, Section, Template } from './template'

// NOTE: Three-way comparison of two drafts against their common base (stage 1d,
// used by sharing in stage 4g). "Ours" is the working copy being shared,
// "theirs" the draft shared in the meantime, "base" the draft both started
// from.
//
// Units of comparison, each decided on its own:
// - an item value (`s:<section>/i:<item>`). Rich text is compared as a whole
//   item on its canonical form (`canonicalRichText`, with image flags left
//   out), never merged character by character. Select and people answers are
//   compared as sets;
// - a repeat entry, by its stable ID (`s:<section>/e:<entry>`), both for
//   repeatable subsections and for repeated items (`.../i:<item>/e:<entry>`).
//   Entries added on either side are all kept. An entry deleted on one side
//   and unchanged on the other is deleted. An entry deleted on one side and
//   changed on the other is a conflict (kind `entry`). Inside an entry that
//   exists on both sides, its title (`<entry>/title`) and its items are units;
// - the order of the entries both sides know (`<parent>/order`);
// - a section's *not applicable* mark with its reason (`<section>/status`);
// - the flag `safeToShare` of an image (`image:<imageId>`). The flag belongs to
//   the image, not to a place in a text, so it is merged on its own and then
//   applied to every use of the image. A draft that uses one image with
//   different flags counts as not safe (the careful reading);
// - the people list, by person ID (`person:<id>`): the name (`person:<id>/name`)
//   and the aliases, merged as a set. An alias added or removed on one side is
//   taken, and the two sides never conflict over aliases.
//
// A unit that only one side changed is taken from that side. A unit changed
// identically on both sides is taken as is. Only a unit changed differently on
// both sides is a conflict, and it carries base, ours and theirs (`undefined`
// means absent or deleted). Where nothing is in conflict the result is exactly
// the other side when one side made no change.
//
// An empty section equals an absent one. An empty rich text document is a
// value like any other.

// ---- Types --------------------------------------------------------------------

export type DraftData = Readonly<{
  content: ReportContent
  people: ReadonlyArray<Person>
}>

export type Sides<T> = Readonly<{
  base: T | undefined
  ours: T | undefined
  theirs: T | undefined
}>

export type DraftConflict =
  | (Readonly<{ key: string; kind: 'value'; richText: boolean }> &
      Sides<ItemValue>)
  | (Readonly<{ key: string; kind: 'entry' }> & Sides<SectionEntry | ItemEntry>)
  | (Readonly<{ key: string; kind: 'entry_title' }> & Sides<string>)
  | (Readonly<{ key: string; kind: 'entry_order' }> &
      Sides<ReadonlyArray<string>>)
  | (Readonly<{ key: string; kind: 'section_status' }> &
      Sides<Readonly<{ reason: string }>>)
  | (Readonly<{ key: string; kind: 'image_flag' }> & Sides<boolean>)
  | (Readonly<{ key: string; kind: 'person' }> & Sides<Person>)
  | (Readonly<{ key: string; kind: 'person_name' }> & Sides<string>)
  // The label of a person: changed differently on both sides, or (also when
  // `clash` is true) left duplicate or matching an alias by the merge.
  | (Readonly<{ key: string; kind: 'person_label'; clash: boolean }> &
      Sides<string>)
  // Both sides added entries and together exceed the limit of the repeat: the
  // author picks which entries stay. `merged` holds every entry, in order.
  | (Readonly<{
      key: string
      kind: 'entries_limit'
      max: number
      merged: ReadonlyArray<string>
    }> &
      Sides<ReadonlyArray<string>>)

export type ConflictKind = DraftConflict['kind']

// NOTE: `edited` is allowed only for a `value` conflict whose `richText` is
// true: the author's own version of the rich text item.
//
// A `person_label` conflict also takes `{ label }`, a label the author types. An
// `entries_limit` conflict takes `{ keep }`, the IDs of the entries that stay (in
// the merged order); `ours` and `theirs` keep the entries that side has.
export type ConflictChoice =
  | 'ours'
  | 'theirs'
  | Readonly<{ edited: RichTextDoc }>
  | Readonly<{ label: string }>
  | Readonly<{ keep: ReadonlyArray<string> }>

export type MergeProblemCode =
  | ContentProblem['code']
  | 'people'
  | 'people-label'
  | 'unresolved'
  | 'unknown-conflict'
  | 'edit-not-allowed'
  | 'invalid-edit'

export type MergeProblem = Readonly<{
  code: MergeProblemCode
  path: ReadonlyArray<string | number>
  message: string
}>

export type Merge = Readonly<{
  template: Template
  base: DraftData
  ours: DraftData
  theirs: DraftData
  // NOTE: Only the true conflicts, in a stable order, each with a stable key.
  conflicts: ReadonlyArray<DraftConflict>
  // NOTE: The merged draft with every conflict still at "ours". It is final
  // when `conflicts` is empty.
  draft: DraftData
  // NOTE: What is wrong with `draft` for the template, if anything (for
  // example both sides added entries beyond a repeat limit).
  problems: ReadonlyArray<MergeProblem>
}>

// ---- Canonical forms ------------------------------------------------------------

const sortKeys = (_key: string, value: unknown): unknown =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      )
    : value

const stable = (value: unknown): string => JSON.stringify(value, sortKeys)

const withFlag = (
  doc: RichTextDoc,
  flag: (id: string) => boolean | undefined,
) =>
  ({
    type: 'doc',
    content: doc.content.map(block => {
      if (block.type !== 'figure') {
        return block
      }
      const value = flag(block.attrs.imageId)
      return value === undefined
        ? block
        : { ...block, attrs: { ...block.attrs, safeToShare: value } }
    }),
  }) as RichTextDoc

// NOTE: Rich text with the editor's variations removed and the image flags
// neutralised, as plain data.
const docData = (doc: RichTextDoc): unknown =>
  withFlag(canonicalRichText(doc), () => false)

const valueData = (value: ItemValue): unknown => {
  switch (value.type) {
    case 'rich_text':
      return { type: value.type, doc: docData(value.doc) }
    case 'select':
      return { type: value.type, optionIds: [...value.optionIds].sort() }
    case 'people':
      return { type: value.type, personIds: [...value.personIds].sort() }
    case 'not_applicable':
      return { type: value.type, reason: value.reason.trim() }
    case 'repeated':
      return { type: value.type, entries: value.entries.map(itemEntryData) }
    default:
      return value
  }
}

const valuesData = (values: ItemValues): unknown =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]) => [id, valueData(value)]),
  )

const itemEntryData = (entry: ItemEntry): unknown => ({
  id: entry.id,
  title: entry.title,
  values: valuesData(entry.values),
})

const sectionEntryData = (entry: SectionEntry): unknown => ({
  id: entry.id,
  title: entry.title,
  values: valuesData(entry.values),
  sections: sectionsData(entry.sections),
})

const sectionsData = (sections: SectionContents): unknown =>
  Object.fromEntries(
    Object.entries(sections).flatMap(([id, section]) => {
      const data = sectionData(section)
      return data === undefined ? [] : [[id, data]]
    }),
  )

// NOTE: `undefined` for an empty section: it equals an absent one.
const sectionData = (section: SectionContent): unknown => {
  const values = valuesData(section.values) as object
  const sections = sectionsData(section.sections) as object
  const entries = (section.entries ?? []).map(sectionEntryData)
  const reason = section.notApplicable?.reason.trim()
  if (
    reason === undefined &&
    Object.keys(values).length === 0 &&
    Object.keys(sections).length === 0 &&
    entries.length === 0
  ) {
    return undefined
  }
  return {
    reason,
    values,
    sections,
    entries: entries.length === 0 ? undefined : entries,
  }
}

const canonOf = (data: unknown): string | undefined =>
  data === undefined ? undefined : stable(data)

type Side3 = 'ours' | 'theirs' | 'conflict'

// NOTE: Who changed what, on canonical forms. Identical changes resolve
// themselves (`ours`); a unit one side did not change is taken from the other.
const side3 = (
  base: string | undefined,
  ours: string | undefined,
  theirs: string | undefined,
): Side3 =>
  ours === theirs
    ? 'ours'
    : base === ours
      ? 'theirs'
      : base === theirs
        ? 'ours'
        : 'conflict'

// ---- Context ----------------------------------------------------------------------

type Context = {
  readonly choices: ReadonlyMap<string, ConflictChoice> | undefined
  readonly conflicts: Array<DraftConflict>
  readonly problems: Array<MergeProblem>
  readonly template: Template
}

const join = (prefix: string, segment: string): string =>
  prefix === '' ? segment : `${prefix}/${segment}`

const pick = (context: Context, conflict: DraftConflict): ConflictChoice => {
  context.conflicts.push(conflict)
  return context.choices?.get(conflict.key) ?? 'ours'
}

const pickSide = (
  context: Context,
  conflict: DraftConflict,
): 'ours' | 'theirs' => {
  const choice = pick(context, conflict)
  if (typeof choice === 'object') {
    context.problems.push({
      code: 'edit-not-allowed',
      path: [conflict.key],
      message: `"${conflict.key}" cannot be edited, only taken from one side`,
    })
    return 'ours'
  }
  return choice
}

// ---- Repeat limits ----------------------------------------------------------------

// NOTE: The most entries the repeat at `prefix` (a key of sections and items,
// entry segments ignored) may hold, from the template.
const maxEntriesAt = (
  template: Template,
  prefix: string,
): number | undefined => {
  let sections: ReadonlyArray<Section> =
    template.conclusion === undefined
      ? template.sections
      : [...template.sections, template.conclusion]
  let items: ReadonlyArray<Item> = []
  let max: number | undefined
  for (const segment of prefix.split('/')) {
    if (segment.startsWith('s:')) {
      const section = sections.find(s => s.id === segment.slice(2))
      if (section === undefined) {
        return undefined
      }
      sections = section.sections
      items = section.items
      max = section.repeat?.max
    } else if (segment.startsWith('i:')) {
      const item = items.find(i => i.id === segment.slice(2))
      if (item === undefined || item.type !== 'repeated') {
        return undefined
      }
      items = item.items
      sections = []
      max = item.max
    }
  }
  return max
}

// ---- Values -----------------------------------------------------------------------

const isRichTextOrAbsent = (value: ItemValue | undefined): boolean =>
  value === undefined || value.type === 'rich_text'

const mergeValue = (
  context: Context,
  key: string,
  base: ItemValue | undefined,
  ours: ItemValue | undefined,
  theirs: ItemValue | undefined,
): ItemValue | undefined => {
  const decision = side3(
    canonOf(base && valueData(base)),
    canonOf(ours && valueData(ours)),
    canonOf(theirs && valueData(theirs)),
  )
  if (decision === 'ours') {
    return ours
  }
  if (decision === 'theirs') {
    return theirs
  }
  const entriesOf = (value: ItemValue | undefined) =>
    value?.type === 'repeated' ? value.entries : []
  const isList = (value: ItemValue | undefined) =>
    value === undefined || value.type === 'repeated'
  // A repeated item and an absent one (nothing in it) merge entry by entry.
  if (
    isList(ours) &&
    isList(theirs) &&
    (ours !== undefined || theirs !== undefined)
  ) {
    const entries = mergeEntries(
      context,
      key,
      entriesOf(base),
      entriesOf(ours),
      entriesOf(theirs),
      entry => canonOf(itemEntryData(entry)),
      (entryKey, b, o, t) => ({
        id: o.id,
        ...mergeTitle(context, entryKey, b?.title, o.title, t.title),
        values: mergeValues(
          context,
          entryKey,
          b?.values ?? {},
          o.values,
          t.values,
        ),
      }),
    )
    return entries.length === 0 && (ours === undefined || theirs === undefined)
      ? undefined
      : { type: 'repeated', entries }
  }
  const richText =
    isRichTextOrAbsent(ours) &&
    isRichTextOrAbsent(theirs) &&
    (ours !== undefined || theirs !== undefined)
  const choice = pick(context, {
    key,
    kind: 'value',
    richText,
    base,
    ours,
    theirs,
  })
  if (choice === 'ours') {
    return ours
  }
  if (choice === 'theirs') {
    return theirs
  }
  const decoded =
    richText && 'edited' in choice ? decodeRichText(choice.edited) : undefined
  if (decoded === undefined || Result.isFailure(decoded)) {
    context.problems.push({
      code: decoded === undefined ? 'edit-not-allowed' : 'invalid-edit',
      path: [key],
      message:
        decoded === undefined
          ? `"${key}" is not a rich text item and cannot be edited`
          : `The edited rich text of "${key}" is not a valid document`,
    })
    return ours
  }
  return { type: 'rich_text', doc: canonicalRichText(decoded.success) }
}

const mergeValues = (
  context: Context,
  prefix: string,
  base: ItemValues,
  ours: ItemValues,
  theirs: ItemValues,
): ItemValues => {
  const ids = [
    ...new Set([
      ...Object.keys(ours),
      ...Object.keys(theirs),
      ...Object.keys(base),
    ]),
  ]
  const out: Record<string, ItemValue> = {}
  for (const id of ids) {
    const value = mergeValue(
      context,
      join(prefix, `i:${id}`),
      base[id],
      ours[id],
      theirs[id],
    )
    if (value !== undefined) {
      out[id] = value
    }
  }
  return out
}

const mergeTitle = (
  context: Context,
  entryKey: string,
  base: string | undefined,
  ours: string | undefined,
  theirs: string | undefined,
): { title?: string } => {
  const key = `${entryKey}/title`
  const decision = side3(base, ours, theirs)
  const title =
    decision === 'ours'
      ? ours
      : decision === 'theirs'
        ? theirs
        : pickSide(context, {
              key,
              kind: 'entry_title',
              base,
              ours,
              theirs,
            }) === 'ours'
          ? ours
          : theirs
  return title === undefined ? {} : { title }
}

// ---- Entries ----------------------------------------------------------------------

const mergeEntries = <E extends ItemEntry | SectionEntry>(
  context: Context,
  prefix: string,
  base: ReadonlyArray<E>,
  ours: ReadonlyArray<E>,
  theirs: ReadonlyArray<E>,
  canon: (entry: E) => string | undefined,
  mergeOne: (entryKey: string, base: E | undefined, ours: E, theirs: E) => E,
): ReadonlyArray<E> => {
  const byId = (list: ReadonlyArray<E>) =>
    new Map(list.map(entry => [entry.id, entry]))
  const b = byId(base)
  const o = byId(ours)
  const t = byId(theirs)
  const survivors = new Map<string, E>()
  // Entries a side deleted and the other changed that the choice dropped. They
  // count towards the limit, so whether the limit is a conflict never depends
  // on how another conflict was chosen.
  let undecided = 0
  const ids = [
    ...new Set([...ours.map(e => e.id), ...theirs.map(e => e.id), ...b.keys()]),
  ]
  for (const id of ids) {
    const eb = b.get(id)
    const eo = o.get(id)
    const et = t.get(id)
    const key = join(prefix, `e:${id}`)
    if (eo !== undefined && et !== undefined) {
      const decision = side3(eb && canon(eb), canon(eo), canon(et))
      survivors.set(
        id,
        decision === 'ours'
          ? eo
          : decision === 'theirs'
            ? et
            : mergeOne(key, eb, eo, et),
      )
      continue
    }
    const present = eo ?? et
    if (present === undefined) {
      continue
    }
    if (eb === undefined) {
      survivors.set(id, present)
      continue
    }
    if (canon(eb) === canon(present)) {
      continue
    }
    // Deleted on one side, changed on the other.
    const side = pickSide(context, {
      key,
      kind: 'entry',
      base: eb,
      ours: eo,
      theirs: et,
    })
    const kept = side === 'ours' ? eo : et
    if (kept !== undefined) {
      survivors.set(id, kept)
    } else {
      undecided++
    }
  }

  // Order: the entries all three know are ordered by whoever moved them.
  const known = new Set(
    base.map(e => e.id).filter(id => o.has(id) && t.has(id)),
  )
  const sequence = (list: ReadonlyArray<E>) =>
    list.map(e => e.id).filter(id => known.has(id))
  const [sb, so, st] = [sequence(base), sequence(ours), sequence(theirs)]
  const decision = side3(sb.join('\n'), so.join('\n'), st.join('\n'))
  const primary =
    decision === 'ours'
      ? 'ours'
      : decision === 'theirs'
        ? 'theirs'
        : pickSide(context, {
            key: `${prefix}/order`,
            kind: 'entry_order',
            base: sb,
            ours: so,
            theirs: st,
          })
  const [first, second] = primary === 'ours' ? [ours, theirs] : [theirs, ours]
  const result = first.map(e => e.id).filter(id => survivors.has(id))
  const secondIds = second.map(e => e.id).filter(id => survivors.has(id))
  secondIds.forEach((id, index) => {
    if (result.includes(id)) {
      return
    }
    let at = 0
    for (let back = index - 1; back >= 0; back--) {
      const found = result.indexOf(secondIds[back] as string)
      if (found >= 0) {
        at = found + 1
        break
      }
    }
    result.splice(at, 0, id)
  })
  const max = maxEntriesAt(context.template, prefix)
  if (max === undefined || result.length + undecided <= max) {
    return result.map(id => survivors.get(id) as E)
  }
  const conflict: DraftConflict = {
    key: `${prefix}/limit`,
    kind: 'entries_limit',
    max,
    merged: result,
    base: base.map(e => e.id),
    ours: ours.map(e => e.id),
    theirs: theirs.map(e => e.id),
  }
  // Until the author chooses, every entry stays (and `problems` says the repeat
  // is over its limit), so nothing either side added is lost.
  context.conflicts.push(conflict)
  const choice = context.choices?.get(conflict.key)
  if (choice === undefined) {
    return result.map(id => survivors.get(id) as E)
  }
  const kept =
    choice === 'ours' || choice === 'theirs'
      ? new Set((choice === 'ours' ? ours : theirs).map(e => e.id))
      : 'keep' in choice
        ? new Set(choice.keep)
        : undefined
  if (kept === undefined) {
    context.problems.push({
      code: 'edit-not-allowed',
      path: [conflict.key],
      message: `"${conflict.key}" takes a side or a list of entries to keep`,
    })
    return result.map(id => survivors.get(id) as E)
  }
  return result.filter(id => kept.has(id)).map(id => survivors.get(id) as E)
}

// ---- Sections ---------------------------------------------------------------------

const EMPTY_SECTION: SectionContent = { values: {}, sections: {} }

const mergeSections = (
  context: Context,
  prefix: string,
  base: SectionContents,
  ours: SectionContents,
  theirs: SectionContents,
): SectionContents => {
  const ids = [
    ...new Set([
      ...Object.keys(ours),
      ...Object.keys(theirs),
      ...Object.keys(base),
    ]),
  ]
  const out: Record<string, SectionContent> = {}
  for (const id of ids) {
    const section = mergeSection(
      context,
      join(prefix, `s:${id}`),
      base[id],
      ours[id],
      theirs[id],
    )
    if (section !== undefined) {
      out[id] = section
    }
  }
  return out
}

const mergeSection = (
  context: Context,
  key: string,
  base: SectionContent | undefined,
  ours: SectionContent | undefined,
  theirs: SectionContent | undefined,
): SectionContent | undefined => {
  const decision = side3(
    canonOf(base && sectionData(base)),
    canonOf(ours && sectionData(ours)),
    canonOf(theirs && sectionData(theirs)),
  )
  if (decision === 'ours') {
    return ours
  }
  if (decision === 'theirs') {
    return theirs
  }
  const [b, o, t] = [
    base ?? EMPTY_SECTION,
    ours ?? EMPTY_SECTION,
    theirs ?? EMPTY_SECTION,
  ]
  const statusDecision = side3(
    b.notApplicable?.reason.trim(),
    o.notApplicable?.reason.trim(),
    t.notApplicable?.reason.trim(),
  )
  const notApplicable =
    statusDecision === 'ours'
      ? o.notApplicable
      : statusDecision === 'theirs'
        ? t.notApplicable
        : pickSide(context, {
              key: `${key}/status`,
              kind: 'section_status',
              base: b.notApplicable,
              ours: o.notApplicable,
              theirs: t.notApplicable,
            }) === 'ours'
          ? o.notApplicable
          : t.notApplicable
  const values = mergeValues(context, key, b.values, o.values, t.values)
  const sections = mergeSections(
    context,
    key,
    b.sections,
    o.sections,
    t.sections,
  )
  const entries = mergeEntries(
    context,
    key,
    b.entries ?? [],
    o.entries ?? [],
    t.entries ?? [],
    entry => canonOf(sectionEntryData(entry)),
    (entryKey, eb, eo, et) => ({
      id: eo.id,
      ...mergeTitle(context, entryKey, eb?.title, eo.title, et.title),
      values: mergeValues(
        context,
        entryKey,
        eb?.values ?? {},
        eo.values,
        et.values,
      ),
      sections: mergeSections(
        context,
        entryKey,
        eb?.sections ?? {},
        eo.sections,
        et.sections,
      ),
    }),
  )
  return {
    ...(notApplicable === undefined ? {} : { notApplicable }),
    values,
    sections,
    ...(entries.length > 0 || o.entries !== undefined || t.entries !== undefined
      ? { entries }
      : {}),
  }
}

// ---- Image flags ------------------------------------------------------------------

const mapValueDocs = (
  values: ItemValues,
  fn: (doc: RichTextDoc) => RichTextDoc,
): ItemValues =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]): [string, ItemValue] => [
      id,
      value.type === 'rich_text'
        ? { ...value, doc: fn(value.doc) }
        : value.type === 'repeated'
          ? {
              ...value,
              entries: value.entries.map(entry => ({
                ...entry,
                values: mapValueDocs(entry.values, fn),
              })),
            }
          : value,
    ]),
  )

const mapDocs = (
  sections: SectionContents,
  fn: (doc: RichTextDoc) => RichTextDoc,
): SectionContents =>
  Object.fromEntries(
    Object.entries(sections).map(([id, section]) => [
      id,
      {
        ...section,
        values: mapValueDocs(section.values, fn),
        sections: mapDocs(section.sections, fn),
        ...(section.entries === undefined
          ? {}
          : {
              entries: section.entries.map(entry => ({
                ...entry,
                values: mapValueDocs(entry.values, fn),
                sections: mapDocs(entry.sections, fn),
              })),
            }),
      },
    ]),
  )

// NOTE: One flag per image ID. An image used with different flags is not safe.
const imageFlags = (content: ReportContent): Map<string, boolean> => {
  const flags = new Map<string, boolean>()
  mapDocs(content.sections, doc => {
    for (const figure of richTextFigures(doc)) {
      flags.set(
        figure.imageId,
        (flags.get(figure.imageId) ?? true) && figure.safeToShare,
      )
    }
    return doc
  })
  return flags
}

const mergeFlags = (
  context: Context,
  base: ReportContent,
  ours: ReportContent,
  theirs: ReportContent,
): Map<string, boolean> => {
  const [fb, fo, ft] = [imageFlags(base), imageFlags(ours), imageFlags(theirs)]
  const merged = new Map<string, boolean>()
  for (const id of new Set([...fo.keys(), ...ft.keys()])) {
    const [b, o, t] = [fb.get(id), fo.get(id), ft.get(id)]
    if (o === undefined || t === undefined || o === t) {
      merged.set(id, (o ?? t) as boolean)
    } else if (b === o) {
      merged.set(id, t)
    } else if (b === t) {
      merged.set(id, o)
    } else {
      const side = pickSide(context, {
        key: `image:${id}`,
        kind: 'image_flag',
        base: b,
        ours: o,
        theirs: t,
      })
      merged.set(id, side === 'ours' ? o : t)
    }
  }
  return merged
}

// ---- People -----------------------------------------------------------------------

const personData = (person: Person): unknown => ({
  name: person.name.normalize('NFC').trim(),
  label: person.label.normalize('NFC').trim(),
  aliases: [...new Set(person.aliases.map(aliasKey))].sort(),
})

const mergeAliases = (
  base: ReadonlyArray<string>,
  ours: ReadonlyArray<string>,
  theirs: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const [b, o, t] = [base, ours, theirs].map(
    list => new Set(list.map(aliasKey)),
  ) as [Set<string>, Set<string>, Set<string>]
  const out: Array<string> = []
  const seen = new Set<string>()
  // The order is not a unit: whoever changed the aliases first decides it.
  const oursUnchanged = o.size === b.size && [...o].every(key => b.has(key))
  for (const alias of oursUnchanged
    ? [...theirs, ...ours]
    : [...ours, ...theirs]) {
    const key = aliasKey(alias)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    if (b.has(key) ? o.has(key) && t.has(key) : true) {
      out.push(alias)
    }
  }
  return out
}

// NOTE: Takes a side or a label the author typed.
const pickLabel = (context: Context, conflict: DraftConflict): string => {
  const choice = pick(context, conflict)
  if (choice === 'ours' || choice === 'theirs') {
    return (conflict[choice] ?? conflict.ours ?? '') as string
  }
  if ('label' in choice) {
    return choice.label.trim()
  }
  context.problems.push({
    code: 'edit-not-allowed',
    path: [conflict.key],
    message: `"${conflict.key}" takes a side or a label`,
  })
  return (conflict as { ours?: string }).ours ?? ''
}

// NOTE: After the merge, a person whose label is a copy of an earlier person's
// (two authors both added "Person 3") or matches an alias gets a conflict, so
// the author can type another label.
const settleLabels = (
  context: Context,
  merged: ReadonlyArray<Person>,
  sides: Readonly<{
    base: ReadonlyArray<Person>
    ours: ReadonlyArray<Person>
    theirs: ReadonlyArray<Person>
  }>,
): ReadonlyArray<Person> => {
  const flagged = new Set(
    peopleListProblems(merged)
      .filter(
        problem =>
          problem.code === 'duplicate-label' ||
          problem.code === 'label-matches-alias',
      )
      .map(problem => problem.path[0] as string),
  )
  if (flagged.size === 0) {
    return merged
  }
  const labelOf = (list: ReadonlyArray<Person>, id: string) =>
    list.find(person => person.id === id)?.label
  return merged.map(person => {
    const key = `person:${person.id}/label`
    if (
      !flagged.has(person.id) ||
      context.conflicts.some(conflict => conflict.key === key)
    ) {
      return person
    }
    const label = pickLabel(context, {
      key,
      kind: 'person_label',
      clash: true,
      base: labelOf(sides.base, person.id),
      ours: person.label,
      theirs: labelOf(sides.theirs, person.id),
    })
    return { ...person, label }
  })
}

const mergePeople = (
  context: Context,
  base: ReadonlyArray<Person>,
  ours: ReadonlyArray<Person>,
  theirs: ReadonlyArray<Person>,
): ReadonlyArray<Person> => {
  const b = new Map(base.map(p => [p.id, p]))
  const o = new Map(ours.map(p => [p.id, p]))
  const t = new Map(theirs.map(p => [p.id, p]))
  const out: Array<Person> = []
  // The order is not a unit: whoever moved people first decides it.
  const sameOrder =
    ours.map(p => p.id).join('\n') === base.map(p => p.id).join('\n')
  const ordered = sameOrder
    ? [...t.keys(), ...o.keys()]
    : [...o.keys(), ...t.keys()]
  for (const id of new Set(ordered)) {
    const [pb, po, pt] = [b.get(id), o.get(id), t.get(id)]
    const key = `person:${id}`
    if (po !== undefined && pt !== undefined) {
      const decision = side3(
        canonOf(pb && personData(pb)),
        canonOf(personData(po)),
        canonOf(personData(pt)),
      )
      if (decision === 'ours') {
        out.push(po)
      } else if (decision === 'theirs') {
        out.push(pt)
      } else {
        const nameDecision = side3(pb?.name, po.name, pt.name)
        const name =
          nameDecision === 'ours'
            ? po.name
            : nameDecision === 'theirs'
              ? pt.name
              : pickSide(context, {
                    key: `${key}/name`,
                    kind: 'person_name',
                    base: pb?.name,
                    ours: po.name,
                    theirs: pt.name,
                  }) === 'ours'
                ? po.name
                : pt.name
        const labelDecision = side3(pb?.label, po.label, pt.label)
        const label =
          labelDecision === 'ours'
            ? po.label
            : labelDecision === 'theirs'
              ? pt.label
              : pickLabel(context, {
                  key: `${key}/label`,
                  kind: 'person_label',
                  clash: false,
                  base: pb?.label,
                  ours: po.label,
                  theirs: pt.label,
                })
        out.push({
          id,
          name,
          label,
          aliases: mergeAliases(pb?.aliases ?? [], po.aliases, pt.aliases),
        })
      }
      continue
    }
    const present = po ?? pt
    if (present === undefined) {
      continue
    }
    if (pb === undefined) {
      out.push(present)
    } else if (canonOf(personData(pb)) !== canonOf(personData(present))) {
      const side = pickSide(context, {
        key,
        kind: 'person',
        base: pb,
        ours: po,
        theirs: pt,
      })
      const kept = side === 'ours' ? po : pt
      if (kept !== undefined) {
        out.push(kept)
      }
    }
  }
  return out
}

// ---- Putting it together ------------------------------------------------------------

const run = (
  context: Context,
  base: DraftData,
  ours: DraftData,
  theirs: DraftData,
): DraftData => {
  const sections = mergeSections(
    context,
    '',
    base.content.sections,
    ours.content.sections,
    theirs.content.sections,
  )
  const flags = mergeFlags(context, base.content, ours.content, theirs.content)
  const flagged = mapDocs(sections, doc => withFlag(doc, id => flags.get(id)))
  const people = settleLabels(
    context,
    mergePeople(context, base.people, ours.people, theirs.people),
    { base: base.people, ours: ours.people, theirs: theirs.people },
  )
  return { content: { ...ours.content, sections: flagged }, people }
}

const peopleProblems = (
  people: ReadonlyArray<Person>,
): ReadonlyArray<MergeProblem> =>
  peopleListProblems(people).map(problem => ({
    code: problem.code === 'duplicate-id' ? 'people' : 'people-label',
    path: problem.path,
    message: problem.message,
  }))

// NOTE: Compares two drafts against their base and returns the merged draft
// with every true conflict at "ours" and the conflicts for the author to
// resolve with `resolveMerge`. All three drafts must be for `template`.
export const compareDrafts = (
  template: Template,
  drafts: Readonly<{ base: DraftData; ours: DraftData; theirs: DraftData }>,
): Merge => {
  const { base, ours, theirs } = drafts
  const context: Context = {
    template,
    choices: undefined,
    conflicts: [],
    problems: [],
  }
  const draft = run(context, base, ours, theirs)
  return {
    template,
    base,
    ours,
    theirs,
    conflicts: context.conflicts,
    draft,
    problems: [
      ...contentProblems(template, draft.content),
      ...peopleProblems(draft.people),
    ],
  }
}

// NOTE: The merged draft once every conflict has a choice. It fails, with every
// problem, if a conflict has no choice, a choice names no conflict, an edit is
// not allowed or not a valid document, or the result does not fit the template.
export const resolveMerge = (
  merge: Merge,
  choices: Readonly<Record<string, ConflictChoice>>,
): Result.Result<DraftData, ReadonlyArray<MergeProblem>> => {
  const context: Context = {
    template: merge.template,
    choices: new Map(Object.entries(choices)),
    conflicts: [],
    problems: [],
  }
  const draft = run(context, merge.base, merge.ours, merge.theirs)
  const keys = new Set(context.conflicts.map(conflict => conflict.key))
  const problems: Array<MergeProblem> = [
    ...context.conflicts
      .filter(conflict => !(conflict.key in choices))
      .map(conflict => ({
        code: 'unresolved' as const,
        path: [conflict.key],
        message: `"${conflict.key}" needs a choice`,
      })),
    ...Object.keys(choices)
      .filter(key => !keys.has(key))
      .map(key => ({
        code: 'unknown-conflict' as const,
        path: [key],
        message: `There is no conflict "${key}"`,
      })),
    ...context.problems,
  ]
  if (problems.length > 0) {
    return Result.fail(problems)
  }
  const validated = validateContent(merge.template, draft.content)
  const people = peopleProblems(draft.people)
  if (Result.isFailure(validated) || people.length > 0) {
    return Result.fail([
      ...(Result.isFailure(validated) ? validated.failure : []),
      ...people,
    ])
  }
  return Result.succeed({ content: validated.success, people: draft.people })
}
