import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  type ConflictChoice,
  type DraftConflict,
  type DraftData,
  type ItemValue,
  type Person,
  type ReportContent,
  type RichTextDoc,
  type SectionContent,
  type SectionEntry,
  canonicalRichText,
  compareDrafts,
  emptyContent,
  resolveMerge,
} from './index'
import {
  MINI_TEMPLATE,
  noiseArbitrary,
  templateWithContentArbitrary,
} from './testing/content'
import {
  type DraftTriple,
  draftTripleArbitrary,
  withEditorNoise,
  withImageFlags,
  withCanonicalText,
  withoutEmptySections,
} from './testing/drafts'

// ---- An independent reading of drafts, to check the comparison against ----------

type Units = Map<string, string>

const doc = (...texts: ReadonlyArray<string>): RichTextDoc => ({
  type: 'doc',
  content: texts.map(text => ({
    type: 'paragraph' as const,
    content: [{ type: 'text' as const, text }],
  })),
})

const neutral = (value: RichTextDoc): unknown => ({
  type: 'doc',
  content: canonicalRichText(value).content.map(block =>
    block.type === 'figure'
      ? { ...block, attrs: { ...block.attrs, safeToShare: false } }
      : block,
  ),
})

const leaf = (value: ItemValue): string => {
  switch (value.type) {
    case 'rich_text':
      return JSON.stringify(neutral(value.doc))
    case 'select':
      return JSON.stringify([value.type, [...value.optionIds].sort()])
    case 'people':
      return JSON.stringify([value.type, [...value.personIds].sort()])
    case 'repeated':
      return 'repeated'
    default:
      return JSON.stringify(value)
  }
}

const readValues = (
  units: Units,
  prefix: string,
  values: Readonly<Record<string, ItemValue>>,
): void => {
  for (const [id, value] of Object.entries(values)) {
    const key = `${prefix}i:${id}`
    units.set(key, leaf(value))
    if (value.type === 'repeated') {
      for (const entry of value.entries) {
        const entryKey = `${key}/e:${entry.id}`
        units.set(entryKey, 'present')
        if (entry.title !== undefined) {
          units.set(`${entryKey}/title`, entry.title)
        }
        readValues(units, `${entryKey}/`, entry.values)
      }
    }
  }
}

const readSections = (
  units: Units,
  prefix: string,
  sections: Readonly<Record<string, SectionContent>>,
): void => {
  for (const [id, section] of Object.entries(sections)) {
    const key = `${prefix}s:${id}`
    if (section.notApplicable !== undefined) {
      units.set(`${key}/status`, section.notApplicable.reason)
    }
    readValues(units, `${key}/`, section.values)
    readSections(units, `${key}/`, section.sections)
    for (const entry of section.entries ?? []) {
      const entryKey = `${key}/e:${entry.id}`
      units.set(entryKey, 'present')
      if (entry.title !== undefined) {
        units.set(`${entryKey}/title`, entry.title)
      }
      readValues(units, `${entryKey}/`, entry.values)
      readSections(units, `${entryKey}/`, entry.sections)
    }
  }
}

const unitsOf = (content: ReportContent): Units => {
  const units: Units = new Map()
  readSections(units, '', content.sections)
  return units
}

const entryPrefixes = (key: string): ReadonlyArray<string> => {
  const parts = key.split('/')
  const out: Array<string> = []
  parts.slice(0, -1).forEach((part, index) => {
    if (part.startsWith('e:')) {
      out.push(parts.slice(0, index + 1).join('/'))
    }
  })
  return out
}

const isEntryKey = (key: string): boolean => /(^|\/)e:[^/]+$/.test(key)

const subtree = (units: Units, entry: string): string =>
  JSON.stringify(
    [...units.entries()]
      .filter(([key]) => key.startsWith(`${entry}/`))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  )

type Verdict = Readonly<{ problems: ReadonlyArray<string> }>

// For every unit: what must be in the merged draft, and which conflicts must be
// offered.
const check = (
  triple: DraftTriple,
  conflictKeys: Set<string>,
  merged: Units,
): Verdict => {
  const [b, o, t] = [
    unitsOf(triple.base.content),
    unitsOf(triple.ours.content),
    unitsOf(triple.theirs.content),
  ]
  const problems: Array<string> = []
  // An entry of an item that is a list on one side and something else on the
  // other (not applicable) is decided with the item.
  const mixedParent = (entry: string): boolean => {
    const item = entry.slice(0, entry.lastIndexOf('/'))
    return (
      item.split('/').pop()?.startsWith('i:') === true &&
      [b, o, t].some(u => ![undefined, 'repeated'].includes(u.get(item)))
    )
  }
  const expectEqual = (
    key: string,
    expected: string | undefined,
    why: string,
  ) => {
    if (merged.get(key) !== expected) {
      problems.push(`${why}: ${key}`)
    }
  }
  const expectConflict = (key: string, why: string) => {
    if (!conflictKeys.has(key)) {
      problems.push(`missing conflict (${why}): ${key}`)
    }
  }
  for (const key of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
    if (isEntryKey(key)) {
      continue
    }
    const [vb, vo, vt] = [b.get(key), o.get(key), t.get(key)]
    if ([vb, vo, vt].includes('repeated') && !(vb === vo && vo === vt)) {
      continue
    }
    const entries = entryPrefixes(key)
    if (entries.some(mixedParent)) {
      continue
    }
    const everywhere = (units: Units) =>
      entries.every(entry => units.get(entry) === 'present')
    const inB = everywhere(b)
    const inO = everywhere(o)
    const inT = everywhere(t)
    if (!inB) {
      const known = entries.filter(entry => b.get(entry) === 'present')
      const rootsKept = known.every(
        entry => o.get(entry) === 'present' && t.get(entry) === 'present',
      )
      if (rootsKept && inO !== inT) {
        expectEqual(
          key,
          inO ? vo : vt,
          'taken from the side that added the entry',
        )
      }
      continue
    }
    if (!(inO && inT)) {
      continue
    }
    if (vo === vt) {
      expectEqual(key, vo, 'identical change')
    } else if (vo === vb) {
      expectEqual(key, vt, "theirs' change dropped")
    } else if (vt === vb) {
      expectEqual(key, vo, "ours' change dropped")
    } else {
      expectConflict(key, 'both changed')
      expectEqual(key, vo, 'default is ours')
    }
  }
  // Entries: added on one side, or deleted on one side.
  for (const key of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
    if (!isEntryKey(key)) {
      continue
    }
    if ([...entryPrefixes(key), key].some(mixedParent)) {
      continue
    }
    const parents = entryPrefixes(key)
    if (
      !parents.every(entry => [b, o, t].every(u => u.get(entry) === 'present'))
    ) {
      continue
    }
    const [pb, po, pt] = [
      b.get(key) === 'present',
      o.get(key) === 'present',
      t.get(key) === 'present',
    ]
    if (!pb) {
      if (po !== pt) {
        expectEqual(key, 'present', 'an added entry is kept')
      }
      continue
    }
    if (po && pt) {
      continue
    }
    if (!po && !pt) {
      expectEqual(key, undefined, 'deleted on both sides')
      continue
    }
    const changed = subtree(po ? o : t, key) !== subtree(b, key)
    if (changed) {
      expectConflict(key, 'deleted on one side, changed on the other')
      expectEqual(key, o.get(key), 'default is ours')
    } else {
      expectEqual(key, undefined, 'deleted on one side, unchanged on the other')
    }
  }
  return { problems }
}

const keysOf = (conflicts: ReadonlyArray<DraftConflict>) =>
  new Set(conflicts.map(conflict => conflict.key))

const peopleData = (people: ReadonlyArray<Person>) =>
  JSON.stringify(
    people
      .map(person => [person.id, person.name, [...person.aliases].sort()])
      .sort(),
  )

// Equal as the comparison sees drafts: an empty section is an absent one and the
// order of a person's aliases and the editor's
// variations of rich text are not changes.
const normal = (draft: DraftData): DraftData => ({
  ...withoutEmptySections({
    ...draft,
    content: withCanonicalText(draft.content),
  }),
  people: draft.people.map(person => ({
    ...person,
    aliases: [...person.aliases].sort(),
  })),
})

const sameDraft = (actual: DraftData, expected: DraftData) =>
  expect(normal(actual)).toEqual(normal(expected))

const RUNS = { numRuns: 150 }

// ---- Properties ---------------------------------------------------------------------

describe('comparing drafts: properties', () => {
  test('no change from either side is dropped, and every real conflict is offered', () => {
    fc.assert(
      fc.property(draftTripleArbitrary, triple => {
        const merge = compareDrafts(triple.template, triple)
        const verdict = check(
          triple,
          keysOf(merge.conflicts),
          unitsOf(merge.draft.content),
        )
        expect(verdict.problems).toEqual([])
      }),
      RUNS,
    )
  })

  test('only real conflicts are offered', () => {
    fc.assert(
      fc.property(draftTripleArbitrary, triple => {
        const merge = compareDrafts(triple.template, triple)
        const [b, o, t] = [
          unitsOf(triple.base.content),
          unitsOf(triple.ours.content),
          unitsOf(triple.theirs.content),
        ]
        for (const conflict of merge.conflicts) {
          if (
            conflict.kind === 'value' ||
            conflict.kind === 'entry_title' ||
            conflict.kind === 'section_status'
          ) {
            const [vb, vo, vt] = [
              b.get(conflict.key),
              o.get(conflict.key),
              t.get(conflict.key),
            ]
            if (![vb, vo, vt].includes('repeated')) {
              expect(vo).not.toBe(vt)
              expect(vb).not.toBe(vo)
              expect(vb).not.toBe(vt)
            }
          }
          if (conflict.kind === 'entry') {
            expect(
              (conflict.ours === undefined) !== (conflict.theirs === undefined),
            ).toBe(true)
            expect(conflict.base).toBeDefined()
          }
          if (conflict.kind === 'image_flag') {
            expect(conflict.ours).not.toBe(conflict.theirs)
          }
        }
        expect(new Set(merge.conflicts.map(c => c.key)).size).toBe(
          merge.conflicts.length,
        )
      }),
      RUNS,
    )
  })

  test('people and aliases: one-sided changes are kept, aliases never conflict', () => {
    fc.assert(
      fc.property(draftTripleArbitrary, triple => {
        const merge = compareDrafts(triple.template, triple)
        const byId = (people: ReadonlyArray<Person>) =>
          new Map(people.map(person => [person.id, person]))
        const [b, o, t, m] = [
          byId(triple.base.people),
          byId(triple.ours.people),
          byId(triple.theirs.people),
          byId(merge.draft.people),
        ]
        for (const id of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
          const [pb, po, pt, pm] = [b.get(id), o.get(id), t.get(id), m.get(id)]
          if (po && pt) {
            const merged = new Set(pm?.aliases)
            for (const alias of new Set([...po.aliases, ...pt.aliases])) {
              const wasInBase = pb?.aliases.includes(alias) === true
              const inBoth =
                po.aliases.includes(alias) && pt.aliases.includes(alias)
              expect(merged.has(alias)).toBe(wasInBase ? inBoth : true)
            }
          }
          if (po === undefined && pt === undefined) {
            expect(pm).toBeUndefined()
          }
          if (pb === undefined && po !== undefined && pt === undefined) {
            expect(pm).toEqual(po)
          }
        }
        expect(
          merge.conflicts.every(
            c => c.kind !== 'person' || c.key.startsWith('person:'),
          ),
        ).toBe(true)
      }),
      RUNS,
    )
  })

  test('identical changes on both sides leave no conflict', () => {
    fc.assert(
      fc.property(
        templateWithContentArbitrary,
        noiseArbitrary,
        ({ template, content }, noise) => {
          const base: DraftData = {
            content: emptyContent(template),
            people: [],
          }
          const changed: DraftData = {
            content: withImageFlags(content, { 'img-1': true, 'img-3': true }),
            people: [{ id: 'p1', name: 'Bea', aliases: ['B.'] }],
          }
          const merge = compareDrafts(template, {
            base,
            ours: changed,
            theirs: {
              content: withEditorNoise(changed.content, noise),
              people: [{ id: 'p1', name: 'Bea', aliases: ['B.'] }],
            },
          })
          expect(merge.conflicts).toEqual([])
          sameDraft(merge.draft, changed)
        },
      ),
      RUNS,
    )
  })

  test('no change on one side returns the other side unchanged', () => {
    fc.assert(
      fc.property(draftTripleArbitrary, triple => {
        const theirsSame = compareDrafts(triple.template, {
          base: triple.base,
          ours: triple.ours,
          theirs: triple.base,
        })
        expect(theirsSame.conflicts).toEqual([])
        sameDraft(theirsSame.draft, triple.ours)
        const oursSame = compareDrafts(triple.template, {
          base: triple.base,
          ours: triple.base,
          theirs: triple.theirs,
        })
        expect(oursSame.conflicts).toEqual([])
        sameDraft(oursSame.draft, triple.theirs)
      }),
      RUNS,
    )
  })

  test('editor noise never produces a change', () => {
    fc.assert(
      fc.property(draftTripleArbitrary, noiseArbitrary, (triple, noise) => {
        const noisy = (draft: DraftData): DraftData => ({
          ...draft,
          content: withEditorNoise(draft.content, noise),
        })
        // Ours is the base plus noise: theirs is taken entirely.
        const a = compareDrafts(triple.template, {
          base: triple.base,
          ours: noisy(triple.base),
          theirs: triple.theirs,
        })
        expect(a.conflicts).toEqual([])
        sameDraft(a.draft, triple.theirs)
        // Theirs is the base plus noise: ours is taken entirely.
        const b = compareDrafts(triple.template, {
          base: triple.base,
          ours: triple.ours,
          theirs: noisy(triple.base),
        })
        expect(b.conflicts).toEqual([])
        sameDraft(b.draft, triple.ours)
        // Noise on top of a real change does not change what conflicts.
        const plain = compareDrafts(triple.template, triple)
        const noised = compareDrafts(triple.template, {
          base: noisy(triple.base),
          ours: noisy(triple.ours),
          theirs: triple.theirs,
        })
        expect(noised.conflicts.map(c => c.key)).toEqual(
          plain.conflicts.map(c => c.key),
        )
      }),
      RUNS,
    )
  })

  test('swapping the two sides gives the same conflicts and, without conflicts, the same draft', () => {
    fc.assert(
      fc.property(draftTripleArbitrary, triple => {
        const forward = compareDrafts(triple.template, triple)
        const backward = compareDrafts(triple.template, {
          base: triple.base,
          ours: triple.theirs,
          theirs: triple.ours,
        })
        expect([...keysOf(backward.conflicts)].sort()).toEqual(
          [...keysOf(forward.conflicts)].sort(),
        )
        for (const conflict of forward.conflicts) {
          const other = backward.conflicts.find(c => c.key === conflict.key)
          expect(other?.kind).toBe(conflict.kind)
          expect(JSON.stringify(other?.ours)).toBe(
            JSON.stringify(conflict.theirs),
          )
          expect(JSON.stringify(other?.theirs)).toBe(
            JSON.stringify(conflict.ours),
          )
        }
        if (forward.conflicts.length === 0) {
          const [f, b] = [
            unitsOf(forward.draft.content),
            unitsOf(backward.draft.content),
          ]
          expect([...f.entries()].sort()).toEqual([...b.entries()].sort())
          expect(peopleData(forward.draft.people)).toBe(
            peopleData(backward.draft.people),
          )
        }
      }),
      RUNS,
    )
  })

  test('resolving every conflict gives content that fits the template', () => {
    fc.assert(
      fc.property(
        draftTripleArbitrary,
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        (triple, picks) => {
          const merge = compareDrafts(triple.template, triple)
          const choices: Record<string, ConflictChoice> = {}
          merge.conflicts.forEach((conflict, index) => {
            choices[conflict.key] =
              picks[index % picks.length] === true ? 'ours' : 'theirs'
          })
          const result = resolveMerge(merge, choices)
          if (Result.isFailure(result)) {
            // Both sides may have added entries beyond a repeat limit.
            expect(
              result.failure.every(
                problem => problem.code === 'too-many-entries',
              ),
            ).toBe(true)
            expect(
              merge.problems.filter(
                problem => problem.code !== 'too-many-entries',
              ),
            ).toEqual([])
          }
        },
      ),
      RUNS,
    )
  })

  test('choosing "ours" everywhere is the default draft', () => {
    fc.assert(
      fc.property(draftTripleArbitrary, triple => {
        const merge = compareDrafts(triple.template, triple)
        const choices = Object.fromEntries(
          merge.conflicts.map(conflict => [conflict.key, 'ours' as const]),
        )
        const result = resolveMerge(merge, choices)
        if (Result.isSuccess(result)) {
          expect(result.success).toEqual(merge.draft)
        }
      }),
      RUNS,
    )
  })

  test('choosing "theirs" for a conflict gives their unit', () => {
    fc.assert(
      fc.property(draftTripleArbitrary, triple => {
        const merge = compareDrafts(triple.template, triple)
        const choices = Object.fromEntries(
          merge.conflicts.map(conflict => [conflict.key, 'theirs' as const]),
        )
        const result = resolveMerge(merge, choices)
        if (Result.isFailure(result)) {
          return
        }
        const units = unitsOf(result.success.content)
        for (const conflict of merge.conflicts) {
          if (
            conflict.kind === 'value' &&
            conflict.theirs?.type !== 'repeated'
          ) {
            expect(units.get(conflict.key)).toBe(
              conflict.theirs === undefined ? undefined : leaf(conflict.theirs),
            )
          }
        }
      }),
      RUNS,
    )
  })
})

// ---- Examples -----------------------------------------------------------------------

const T = MINI_TEMPLATE

const thing = (
  id: string,
  title: string,
  body?: RichTextDoc,
  refs?: ReadonlyArray<string>,
): SectionEntry => ({
  id,
  title,
  values: {
    'thing-title': { type: 'text', text: title },
    ...(body === undefined
      ? {}
      : { 'thing-body': { type: 'rich_text', doc: body } }),
    ...(refs === undefined
      ? {}
      : {
          'thing-refs': {
            type: 'repeated',
            entries: refs.map(text => ({
              id: `r-${text}`,
              values: { 'ref-text': { type: 'text', text } },
            })),
          },
        }),
  },
  sections: {},
})

const draft = (
  entries: ReadonlyArray<SectionEntry>,
  extra: Partial<ReportContent['sections']> = {},
  people: ReadonlyArray<Person> = [],
): DraftData => ({
  content: {
    ...emptyContent(T),
    sections: {
      things: {
        values: {},
        sections: {
          thing: { values: {}, sections: {}, entries },
        },
      },
      ...extra,
    },
  },
  people,
})

const thingKey = (entry: string, rest = '') =>
  `s:things/s:thing/e:${entry}${rest}`

const entriesOf = (result: DraftData): ReadonlyArray<SectionEntry> =>
  result.content.sections.things?.sections.thing?.entries ?? []

describe('comparing drafts: examples', () => {
  test('entries added on both sides are both kept', () => {
    const base = draft([thing('a', 'A')])
    const ours = draft([thing('a', 'A'), thing('o1', 'Ours')])
    const theirs = draft([thing('a', 'A'), thing('t1', 'Theirs')])
    const merge = compareDrafts(T, { base, ours, theirs })
    expect(merge.conflicts).toEqual([])
    expect(
      entriesOf(merge.draft)
        .map(e => e.id)
        .sort(),
    ).toEqual(['a', 'o1', 't1'])
    expect(merge.problems).toEqual([])
  })

  test('deleted on one side and unchanged on the other is deleted', () => {
    const base = draft([thing('a', 'A'), thing('b', 'B')])
    const ours = draft([thing('b', 'B')])
    const theirs = draft([thing('a', 'A'), thing('b', 'B', doc('new'))])
    const merge = compareDrafts(T, { base, ours, theirs })
    expect(merge.conflicts).toEqual([])
    expect(entriesOf(merge.draft)).toEqual([thing('b', 'B', doc('new'))])
  })

  test('deleted on one side and changed on the other is a conflict', () => {
    const base = draft([thing('a', 'A')])
    const ours = draft([])
    const theirs = draft([thing('a', 'A', doc('changed'))])
    const merge = compareDrafts(T, { base, ours, theirs })
    expect(merge.conflicts.map(c => [c.key, c.kind])).toEqual([
      [thingKey('a'), 'entry'],
    ])
    expect(entriesOf(merge.draft)).toEqual([])
    const kept = resolveMerge(merge, { [thingKey('a')]: 'theirs' })
    expect(Result.isSuccess(kept) && entriesOf(kept.success)).toEqual([
      thing('a', 'A', doc('changed')),
    ])
    const dropped = resolveMerge(merge, { [thingKey('a')]: 'ours' })
    expect(Result.isSuccess(dropped) && entriesOf(dropped.success)).toEqual([])
  })

  test('the same rich text item changed on both sides is one conflict, and the author may edit it', () => {
    const base = draft([thing('a', 'A', doc('one'))])
    const ours = draft([thing('a', 'A', doc('one', 'two'))])
    const theirs = draft([thing('a', 'A', doc('one', 'three'))])
    const merge = compareDrafts(T, { base, ours, theirs })
    const key = thingKey('a', '/i:thing-body')
    expect(merge.conflicts).toHaveLength(1)
    const conflict = merge.conflicts[0]
    expect(conflict).toMatchObject({ key, kind: 'value', richText: true })
    expect(conflict?.kind === 'value' && conflict.base).toEqual({
      type: 'rich_text',
      doc: doc('one'),
    })
    const edited = doc('one', 'two and three')
    const result = resolveMerge(merge, { [key]: { edited } })
    expect(Result.isSuccess(result) && entriesOf(result.success)).toEqual([
      thing('a', 'A', edited),
    ])
  })

  test('a change to the title and a change to a value in the same entry combine', () => {
    const base = draft([thing('a', 'A', doc('x'))])
    const ours = draft([thing('a', 'A2', doc('x'))])
    const theirs = draft([thing('a', 'A', doc('y'))])
    const merge = compareDrafts(T, { base, ours, theirs })
    expect(merge.conflicts).toEqual([])
    expect(entriesOf(merge.draft)[0]).toMatchObject({
      title: 'A2',
      values: { 'thing-body': { type: 'rich_text', doc: doc('y') } },
    })
  })

  test('titles changed differently conflict', () => {
    const merge = compareDrafts(T, {
      base: draft([thing('a', 'A')]),
      ours: draft([thing('a', 'A1')]),
      theirs: draft([thing('a', 'A2')]),
    })
    const titleConflicts = merge.conflicts.filter(c => c.kind === 'entry_title')
    expect(titleConflicts.map(c => c.key)).toEqual([thingKey('a', '/title')])
    const result = resolveMerge(
      merge,
      Object.fromEntries(merge.conflicts.map(c => [c.key, 'theirs' as const])),
    )
    expect(
      Result.isSuccess(result) && entriesOf(result.success)[0]?.title,
    ).toBe('A2')
  })

  test('order: one side moving is taken, both moving differently is a conflict', () => {
    const [a, b, c] = [thing('a', 'A'), thing('b', 'B'), thing('c', 'C')]
    const base = draft([a, b, c])
    const moved = compareDrafts(T, {
      base,
      ours: draft([c, a, b]),
      theirs: draft([a, b, c, thing('t', 'T')]),
    })
    expect(moved.conflicts).toEqual([])
    expect(entriesOf(moved.draft).map(e => e.id)).toEqual(['c', 't', 'a', 'b'])
    const both = compareDrafts(T, {
      base,
      ours: draft([c, a, b]),
      theirs: draft([b, c, a]),
    })
    expect(both.conflicts.map(x => [x.key, x.kind])).toEqual([
      ['s:things/s:thing/order', 'entry_order'],
    ])
    const result = resolveMerge(both, { 's:things/s:thing/order': 'theirs' })
    expect(
      Result.isSuccess(result) && entriesOf(result.success).map(e => e.id),
    ).toEqual(['b', 'c', 'a'])
    const same = compareDrafts(T, {
      base,
      ours: draft([c, a, b]),
      theirs: draft([c, a, b]),
    })
    expect(same.conflicts).toEqual([])
  })

  test('repeated item entries merge by ID like repeated sections', () => {
    const base = draft([thing('a', 'A', undefined, ['x'])])
    const ours = draft([thing('a', 'A', undefined, ['x', 'o'])])
    const theirs = draft([thing('a', 'A', undefined, ['x', 't'])])
    const merge = compareDrafts(T, { base, ours, theirs })
    expect(merge.conflicts).toEqual([])
    const refs = entriesOf(merge.draft)[0]?.values['thing-refs']
    expect(
      refs?.type === 'repeated' && refs.entries.map(e => e.id).sort(),
    ).toEqual(['r-o', 'r-t', 'r-x'])
    const del = compareDrafts(T, {
      base,
      ours: draft([thing('a', 'A', undefined, [])]),
      theirs: draft([
        {
          ...thing('a', 'A', undefined, ['x']),
          values: {
            ...thing('a', 'A', undefined, ['x']).values,
            'thing-refs': {
              type: 'repeated',
              entries: [
                {
                  id: 'r-x',
                  values: { 'ref-text': { type: 'text', text: 'changed' } },
                },
              ],
            },
          },
        },
      ]),
    })
    expect(del.conflicts.map(c => [c.key, c.kind])).toEqual([
      [thingKey('a', '/i:thing-refs/e:r-x'), 'entry'],
    ])
  })

  test('section status: not applicable with a reason', () => {
    const extras = (reason?: string): ReportContent['sections'] => ({
      extras: {
        ...(reason === undefined ? {} : { notApplicable: { reason } }),
        values: {},
        sections: {},
      },
    })
    const base = draft([], extras())
    const one = compareDrafts(T, {
      base,
      ours: draft([], extras('not relevant')),
      theirs: base,
    })
    expect(one.conflicts).toEqual([])
    expect(one.draft.content.sections.extras?.notApplicable).toEqual({
      reason: 'not relevant',
    })
    const both = compareDrafts(T, {
      base,
      ours: draft([], extras('not relevant')),
      theirs: draft([], extras('out of scope')),
    })
    expect(both.conflicts.map(c => [c.key, c.kind])).toEqual([
      ['s:extras/status', 'section_status'],
    ])
    const same = compareDrafts(T, {
      base,
      ours: draft([], extras('not relevant')),
      theirs: draft([], extras(' not relevant ')),
    })
    expect(same.conflicts).toEqual([])
  })

  test('image flags merge apart from the text around them', () => {
    const figure = (safeToShare: boolean, text: string): RichTextDoc => ({
      type: 'doc',
      content: [
        {
          type: 'figure',
          attrs: { imageId: 'img-1', alt: '', safeToShare },
        },
        { type: 'paragraph', content: [{ type: 'text', text }] },
      ],
    })
    const withBody = (body: RichTextDoc) => draft([thing('a', 'A', body)])
    const base = withBody(figure(false, 'x'))
    // Ours marks the image safe; theirs edits the text.
    const merge = compareDrafts(T, {
      base,
      ours: withBody(figure(true, 'x')),
      theirs: withBody(figure(false, 'y')),
    })
    expect(merge.conflicts).toEqual([])
    expect(entriesOf(merge.draft)[0]?.values['thing-body']).toEqual({
      type: 'rich_text',
      doc: figure(true, 'y'),
    })
    // Both set it, differently from the base.
    const clash = compareDrafts(T, {
      base: withBody(doc('none')),
      ours: withBody(figure(true, 'x')),
      theirs: withBody(figure(false, 'x')),
    })
    expect(clash.conflicts.map(c => [c.key, c.kind])).toEqual([
      ['image:img-1', 'image_flag'],
    ])
    const flipped = compareDrafts(T, {
      base,
      ours: withBody(figure(true, 'x')),
      theirs: withBody(figure(true, 'x')),
    })
    expect(flipped.conflicts).toEqual([])
  })

  test('people: aliases combine, renames and deletions can conflict', () => {
    const p = (name: string, aliases: ReadonlyArray<string>): Person => ({
      id: 'p1',
      name,
      aliases,
    })
    const base = draft([], {}, [p('Bea', ['B.'])])
    const merge = compareDrafts(T, {
      base,
      ours: draft([], {}, [p('Bea', ['B.', 'the nurse'])]),
      theirs: draft([], {}, [
        p('Bea', []),
        { id: 'p2', name: 'Ben', aliases: [] },
      ]),
    })
    expect(merge.conflicts).toEqual([])
    expect(merge.draft.people).toEqual([
      p('Bea', ['the nurse']),
      { id: 'p2', name: 'Ben', aliases: [] },
    ])
    const rename = compareDrafts(T, {
      base,
      ours: draft([], {}, [p('Beatrice', ['B.', 'X'])]),
      theirs: draft([], {}, [p('Bea K.', ['B.', 'Y'])]),
    })
    expect(rename.conflicts.map(c => [c.key, c.kind])).toEqual([
      ['person:p1/name', 'person_name'],
    ])
    const result = resolveMerge(rename, { 'person:p1/name': 'theirs' })
    expect(Result.isSuccess(result) && result.success.people).toEqual([
      p('Bea K.', ['B.', 'X', 'Y']),
    ])
    const removed = compareDrafts(T, {
      base,
      ours: draft([], {}, []),
      theirs: draft([], {}, [p('Bea', ['B.', 'X'])]),
    })
    expect(removed.conflicts.map(c => [c.key, c.kind])).toEqual([
      ['person:p1', 'person'],
    ])
    const unchanged = compareDrafts(T, {
      base,
      ours: draft([], {}, []),
      theirs: base,
    })
    expect(unchanged.conflicts).toEqual([])
    expect(unchanged.draft.people).toEqual([])
  })

  test('resolving refuses missing, unknown and unfit choices', () => {
    const base = draft([thing('a', 'A', doc('one'))])
    const merge = compareDrafts(T, {
      base,
      ours: draft([thing('a', 'A', doc('two'))]),
      theirs: draft([thing('a', 'A', doc('three'))]),
    })
    const key = thingKey('a', '/i:thing-body')
    const codes = (choices: Record<string, ConflictChoice>) => {
      const result = resolveMerge(merge, choices)
      return Result.isFailure(result) ? result.failure.map(p => p.code) : []
    }
    expect(codes({})).toEqual(['unresolved'])
    expect(codes({ [key]: 'ours', nope: 'ours' })).toEqual(['unknown-conflict'])
    expect(
      codes({
        [key]: { edited: { type: 'doc', content: [{ type: 'x' }] } as never },
      }),
    ).toEqual(['invalid-edit'])
    const named = (name: string): DraftData => ({
      people: [],
      content: {
        ...emptyContent(T),
        sections: {
          details: {
            values: { name: { type: 'text', text: name } },
            sections: {},
          },
        },
      },
    })
    const textMerge = compareDrafts(T, {
      base: draft([]),
      ours: named('ours'),
      theirs: named('theirs'),
    })
    expect(textMerge.conflicts.map(c => [c.key, c.kind])).toEqual([
      ['s:details/i:name', 'value'],
    ])
    expect(textMerge.conflicts[0]).toMatchObject({ richText: false })
    const edit = resolveMerge(textMerge, {
      's:details/i:name': { edited: doc('x') },
    })
    expect(Result.isFailure(edit) && edit.failure.map(p => p.code)).toEqual([
      'edit-not-allowed',
    ])
  })

  test('the result is checked against the template', () => {
    const entries = (prefix: string) =>
      [1, 2].map(n => thing(`${prefix}${n}`, `${prefix}${n}`))
    const merge = compareDrafts(T, {
      base: draft([]),
      ours: draft(entries('o')),
      theirs: draft(entries('t')),
    })
    // The repeat allows at most three entries.
    expect(merge.conflicts).toEqual([])
    expect(merge.problems.map(p => p.code)).toEqual(['too-many-entries'])
    const result = resolveMerge(merge, {})
    expect(Result.isFailure(result) && result.failure.map(p => p.code)).toEqual(
      ['too-many-entries'],
    )
  })
})
