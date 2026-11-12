import fc from 'fast-check'

import type { DraftData } from '../compare'
import type {
  ItemEntry,
  ItemValue,
  ItemValues,
  ReportContent,
  SectionContent,
  SectionContents,
  SectionEntry,
} from '../content'
import type { Person } from '../people'
import { type RichTextDoc, canonicalRichText } from '../richtext'
import type { Template } from '../template'
import { type Noise, contentArbitrary, noisyRichText } from './content'
import { validTemplateArbitrary } from './templates'

// NOTE: Test support for the comparison of drafts (1d): drafts derived from one
// base the way two authors would edit it, so that most units are shared and
// some are changed on one side, on both, or deleted.

// ---- Images ----------------------------------------------------------------------

const mapDoc = (
  doc: RichTextDoc,
  flag: (id: string) => boolean,
): RichTextDoc => ({
  type: 'doc',
  content: doc.content.map(block =>
    block.type === 'figure'
      ? {
          ...block,
          attrs: { ...block.attrs, safeToShare: flag(block.attrs.imageId) },
        }
      : block,
  ),
})

const mapValues = (
  values: ItemValues,
  fn: (value: ItemValue) => ItemValue,
): ItemValues =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]) => [
      id,
      value.type === 'repeated'
        ? {
            ...value,
            entries: value.entries.map(entry => ({
              ...entry,
              values: mapValues(entry.values, fn),
            })),
          }
        : fn(value),
    ]),
  )

const mapSections = (
  sections: SectionContents,
  fn: (value: ItemValue) => ItemValue,
): SectionContents =>
  Object.fromEntries(
    Object.entries(sections).map(([id, section]) => [
      id,
      {
        ...section,
        values: mapValues(section.values, fn),
        sections: mapSections(section.sections, fn),
        ...(section.entries === undefined
          ? {}
          : {
              entries: section.entries.map(entry => ({
                ...entry,
                values: mapValues(entry.values, fn),
                sections: mapSections(entry.sections, fn),
              })),
            }),
      },
    ]),
  )

// Gives every use of an image the flag of that image: the app keeps one flag
// per image.
export const withImageFlags = (
  content: ReportContent,
  flags: Readonly<Record<string, boolean>>,
): ReportContent => ({
  ...content,
  sections: mapSections(content.sections, value =>
    value.type === 'rich_text'
      ? {
          ...value,
          doc: mapDoc(value.doc, id => flags[id] ?? false),
        }
      : value,
  ),
})

// The same content as the editor might hand it back: every rich text item with
// split text, empty text nodes, reordered marks and default attributes.
export const withEditorNoise = (
  content: ReportContent,
  noise: Noise,
): ReportContent => ({
  ...content,
  sections: mapSections(content.sections, value =>
    value.type === 'rich_text'
      ? { ...value, doc: noisyRichText(value.doc, noise) }
      : value,
  ),
})

// The same content with every rich text item in canonical form.
export const withCanonicalText = (content: ReportContent): ReportContent => ({
  ...content,
  sections: mapSections(content.sections, value =>
    value.type === 'rich_text'
      ? { ...value, doc: canonicalRichText(value.doc) }
      : value,
  ),
})

// ---- Entry IDs ---------------------------------------------------------------------

const relabelValues = (values: ItemValues, prefix: string): ItemValues =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]) => [
      id,
      value.type === 'repeated'
        ? {
            ...value,
            entries: value.entries.map(entry => ({
              ...entry,
              id: `${prefix}${entry.id}`,
              values: relabelValues(entry.values, prefix),
            })),
          }
        : value,
    ]),
  )

const relabelSections = (
  sections: SectionContents,
  prefix: string,
): SectionContents =>
  Object.fromEntries(
    Object.entries(sections).map(([id, section]) => [
      id,
      {
        ...section,
        values: relabelValues(section.values, prefix),
        sections: relabelSections(section.sections, prefix),
        ...(section.entries === undefined
          ? {}
          : {
              entries: section.entries.map(entry => ({
                ...entry,
                id: `${prefix}${entry.id}`,
                values: relabelValues(entry.values, prefix),
                sections: relabelSections(entry.sections, prefix),
              })),
            }),
      },
    ]),
  )

export const withEntryIdPrefix = (
  content: ReportContent,
  prefix: string,
): ReportContent => ({
  ...content,
  sections: relabelSections(content.sections, prefix),
})

// ---- Unique entry IDs ---------------------------------------------------------------

const uniqueValues = (values: ItemValues, seen: Set<string>): ItemValues =>
  Object.fromEntries(
    Object.entries(values).map(([id, value]) => [
      id,
      value.type === 'repeated'
        ? {
            ...value,
            entries: value.entries.flatMap(entry => {
              if (seen.has(entry.id)) {
                return []
              }
              seen.add(entry.id)
              return [{ ...entry, values: uniqueValues(entry.values, seen) }]
            }),
          }
        : value,
    ]),
  )

const uniqueSections = (
  sections: SectionContents,
  seen: Set<string>,
): SectionContents =>
  Object.fromEntries(
    Object.entries(sections).map(([id, section]) => [
      id,
      {
        ...section,
        values: uniqueValues(section.values, seen),
        sections: uniqueSections(section.sections, seen),
        ...(section.entries === undefined
          ? {}
          : {
              entries: section.entries.flatMap(entry => {
                if (seen.has(entry.id)) {
                  return []
                }
                seen.add(entry.id)
                return [
                  {
                    ...entry,
                    values: uniqueValues(entry.values, seen),
                    sections: uniqueSections(entry.sections, seen),
                  },
                ]
              }),
            }),
      },
    ]),
  )

// Splicing may use a part of the other content twice: the first use keeps its
// entry IDs, a second one loses its entries.
const withUniqueEntryIds = (content: ReportContent): ReportContent => ({
  ...content,
  sections: uniqueSections(content.sections, new Set()),
})

// ---- Splicing -----------------------------------------------------------------------

type Plan = { next: () => number }

const planOf = (numbers: ReadonlyArray<number>): Plan => {
  let at = 0
  return {
    next: () => {
      const value = numbers[at % Math.max(numbers.length, 1)] ?? 0
      at += 1
      return value
    },
  }
}

const spliceEntries = <E extends ItemEntry | SectionEntry>(
  base: ReadonlyArray<E>,
  other: ReadonlyArray<E>,
  plan: Plan,
  modify: (b: E, x: E | undefined) => E,
): ReadonlyArray<E> => {
  const kept: Array<E> = []
  base.forEach((entry, index) => {
    const choice = plan.next() % 4
    if (choice === 1) {
      return
    }
    kept.push(choice >= 2 ? modify(entry, other[index]) : entry)
  })
  for (const entry of other) {
    if (plan.next() % 3 === 0) {
      kept.push(entry)
    }
  }
  return plan.next() % 5 === 0 ? [...kept].reverse() : kept
}

const spliceValues = (
  base: ItemValues,
  other: ItemValues,
  plan: Plan,
): ItemValues => {
  const out: Record<string, ItemValue> = {}
  for (const id of new Set([...Object.keys(base), ...Object.keys(other)])) {
    const b = base[id]
    const x = other[id]
    const choice = plan.next() % 3
    const value =
      choice === 0
        ? b
        : choice === 1
          ? x
          : b?.type === 'repeated' && x?.type === 'repeated'
            ? {
                type: 'repeated' as const,
                entries: spliceEntries(
                  b.entries,
                  x.entries,
                  plan,
                  (eb, ex) => ({
                    ...eb,
                    ...(plan.next() % 2 === 0 || ex === undefined
                      ? {}
                      : ex.title === undefined
                        ? {}
                        : { title: ex.title }),
                    values: spliceValues(eb.values, ex?.values ?? {}, plan),
                  }),
                ),
              }
            : b
    if (value !== undefined) {
      out[id] = value
    }
  }
  return out
}

const EMPTY: SectionContent = { values: {}, sections: {} }

const spliceSections = (
  base: SectionContents,
  other: SectionContents,
  plan: Plan,
): SectionContents => {
  const out: Record<string, SectionContent> = {}
  for (const id of new Set([...Object.keys(base), ...Object.keys(other)])) {
    const b = base[id]
    const x = other[id]
    const choice = plan.next() % 3
    const section =
      choice === 0
        ? b
        : choice === 1
          ? x
          : spliceSection(b ?? EMPTY, x ?? EMPTY, plan)
    if (section !== undefined) {
      out[id] = section
    }
  }
  return out
}

const spliceSection = (
  base: SectionContent,
  other: SectionContent,
  plan: Plan,
): SectionContent => {
  const notApplicable =
    plan.next() % 2 === 0 ? base.notApplicable : other.notApplicable
  const entries =
    base.entries === undefined && other.entries === undefined
      ? undefined
      : spliceEntries(
          base.entries ?? [],
          other.entries ?? [],
          plan,
          (eb, ex) => ({
            ...eb,
            ...(plan.next() % 2 === 0 || ex?.title === undefined
              ? {}
              : { title: ex.title }),
            values: spliceValues(eb.values, ex?.values ?? {}, plan),
            sections: spliceSections(eb.sections, ex?.sections ?? {}, plan),
          }),
        )
  return {
    ...(notApplicable === undefined ? {} : { notApplicable }),
    values: spliceValues(base.values, other.values, plan),
    sections: spliceSections(base.sections, other.sections, plan),
    ...(entries === undefined ? {} : { entries }),
  }
}

// NOTE: Content edited from `base` with parts of `other` (whose entry IDs
// should have another prefix): each unit is kept, replaced, or, for sections
// and repeats, mixed; entries are kept, dropped, changed, added or reordered.
export const spliceContent = (
  base: ReportContent,
  other: ReportContent,
  numbers: ReadonlyArray<number>,
): ReportContent => ({
  ...base,
  sections: spliceSections(base.sections, other.sections, planOf(numbers)),
})

// ---- People ---------------------------------------------------------------------------

const personArb = (id: string): fc.Arbitrary<Person> =>
  fc.record({
    id: fc.constant(id),
    name: fc.constantFrom('Bea', 'Ben', 'Dr Okafor', 'Ana'),
    aliases: fc.uniqueArray(fc.constantFrom('B.', 'the nurse', 'X', 'Y'), {
      maxLength: 3,
    }),
  })

export const peopleArbitrary: fc.Arbitrary<ReadonlyArray<Person>> = fc
  .tuple(
    fc.option(personArb('p1'), { nil: undefined }),
    fc.option(personArb('p2'), { nil: undefined }),
    fc.option(personArb('p3'), { nil: undefined }),
  )
  .map(list => list.filter((person): person is Person => person !== undefined))

// ---- Triples ----------------------------------------------------------------------------

const imageFlagsArb = fc.record({
  'img-1': fc.boolean(),
  'img-2': fc.boolean(),
  'img-3': fc.boolean(),
})

const planArb = fc.array(fc.integer({ min: 0, max: 11 }), {
  minLength: 30,
  maxLength: 150,
})

export type DraftTriple = Readonly<{
  template: Template
  base: DraftData
  ours: DraftData
  theirs: DraftData
}>

// A base and two drafts edited from it, for a generated template.
export const draftTripleArbitrary: fc.Arbitrary<DraftTriple> =
  validTemplateArbitrary.chain(template => draftTripleFor(template))

export const draftTripleFor = (template: Template): fc.Arbitrary<DraftTriple> =>
  fc
    .tuple(
      contentArbitrary(template),
      contentArbitrary(template),
      contentArbitrary(template),
      planArb,
      planArb,
      fc.tuple(imageFlagsArb, imageFlagsArb, imageFlagsArb),
      fc.tuple(peopleArbitrary, peopleArbitrary, peopleArbitrary),
    )
    .map(([base, xo, xt, planO, planT, [fb, fo, ft], [pb, po, pt]]) => {
      const b = withImageFlags(base, fb)
      return {
        template,
        base: { content: b, people: pb },
        ours: {
          content: withImageFlags(
            withUniqueEntryIds(
              spliceContent(b, withEntryIdPrefix(xo, 'o'), planO),
            ),
            fo,
          ),
          people: po,
        },
        theirs: {
          content: withImageFlags(
            withUniqueEntryIds(
              spliceContent(b, withEntryIdPrefix(xt, 't'), planT),
            ),
            ft,
          ),
          people: pt,
        },
      }
    })

// ---- Empty sections -------------------------------------------------------------------

const pruneSections = (sections: SectionContents): SectionContents =>
  Object.fromEntries(
    Object.entries(sections).flatMap(([id, section]) => {
      const pruned: SectionContent = {
        ...section,
        sections: pruneSections(section.sections),
        ...(section.entries === undefined
          ? {}
          : {
              entries: section.entries.map(entry => ({
                ...entry,
                sections: pruneSections(entry.sections),
              })),
            }),
      }
      const empty =
        pruned.notApplicable === undefined &&
        Object.keys(pruned.values).length === 0 &&
        Object.keys(pruned.sections).length === 0 &&
        (pruned.entries ?? []).length === 0
      return empty ? [] : [[id, pruned]]
    }),
  )

// A draft without its empty sections: the comparison treats an empty section as
// an absent one, so this is what two drafts are equal by.
export const withoutEmptySections = (draft: DraftData): DraftData => ({
  ...draft,
  content: {
    ...draft.content,
    sections: pruneSections(draft.content.sections),
  },
})
