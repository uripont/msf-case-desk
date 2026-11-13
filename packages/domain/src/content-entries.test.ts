import { Result } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
  type SectionContents,
  addEntry,
  canAdd,
  canRemove,
  childKeyOf,
  cleanTitle,
  contentOfKey,
  countText,
  entriesOfKey,
  entryDisplayTitle,
  entryIdOfKey,
  entryKeyOf,
  groupKeyOf,
  itemEntriesOf,
  itemLimits,
  keyParts,
  moveEntry,
  newItemEntry,
  newSectionEntry,
  notApplicableReasonOf,
  numberSections,
  parentKeyOf,
  refusalText,
  removeEntry,
  retitleEntry,
  sectionLimits,
  sectionOfKey,
  sectionStates,
  validateContent,
  withItemEntries,
  withItemValue,
  withItemValueAt,
  withSectionEntries,
  withSectionNotApplicable,
  emptyContent,
} from './index'

const ids = (list: ReadonlyArray<{ readonly id: string }>) =>
  list.map(entry => entry.id)

const ALLEGATION = 'facts-findings/allegation-block'
const BACKGROUND = 'background/background-topic'

const content = (sections: SectionContents) => ({
  ...emptyContent(INVESTIGATION_TEMPLATE),
  sections,
})

const entry = (id: string) => ({ id })

describe('keys with entries', () => {
  test('a key is read into its parts and back', () => {
    const key = `${ALLEGATION}#a1/key-element#k2`
    expect(keyParts(key)).toEqual([
      { sectionId: 'facts-findings' },
      { sectionId: 'allegation-block', entryId: 'a1' },
      { sectionId: 'key-element', entryId: 'k2' },
    ])
    expect(groupKeyOf(key)).toBe(`${ALLEGATION}#a1/key-element`)
    expect(entryIdOfKey(key)).toBe('k2')
    expect(parentKeyOf(key)).toBe(`${ALLEGATION}#a1`)
    expect(parentKeyOf('summary')).toBe('')
    expect(entryKeyOf(ALLEGATION, 'a1')).toBe(`${ALLEGATION}#a1`)
    expect(childKeyOf(`${ALLEGATION}#a1`, 'facts')).toBe(
      `${ALLEGATION}#a1/facts`,
    )
  })

  test('the template section is found for an entry, its group and what is inside', () => {
    expect(sectionOfKey(INVESTIGATION_TEMPLATE, `${ALLEGATION}#a1`)?.id).toBe(
      'allegation-block',
    )
    expect(sectionOfKey(INVESTIGATION_TEMPLATE, ALLEGATION)?.id).toBe(
      'allegation-block',
    )
    expect(
      sectionOfKey(INVESTIGATION_TEMPLATE, `${ALLEGATION}#a1/facts`)?.id,
    ).toBe('facts')
    expect(
      sectionOfKey(INVESTIGATION_TEMPLATE, `${ALLEGATION}#a1/key-element#k1`)
        ?.id,
    ).toBe('key-element')
  })

  test('a key that does not fit the template names nothing', () => {
    expect(
      sectionOfKey(INVESTIGATION_TEMPLATE, 'facts-findings#a1'),
    ).toBeUndefined()
    expect(
      sectionOfKey(INVESTIGATION_TEMPLATE, `${ALLEGATION}/facts`),
    ).toBeUndefined()
  })
})

describe('entries of a repeatable section', () => {
  const limits = sectionLimits(
    sectionOfKey(INVESTIGATION_TEMPLATE, ALLEGATION) ??
      (undefined as never),
  )

  test('the limits come from the template', () => {
    expect(limits).toEqual({ min: 1 })
    expect(
      itemLimits(INTAKE_TEMPLATE.sections[2]?.items[0] ?? (undefined as never)),
    ).toEqual({ min: 1 })
  })

  test('adding creates the group, and the content fits the template', () => {
    const added = withSectionEntries({}, ALLEGATION, list => [
      ...list,
      newSectionEntry('a1'),
    ])
    expect(ids(entriesOfKey(added, ALLEGATION))).toEqual(['a1'])
    expect(
      Result.isSuccess(validateContent(INVESTIGATION_TEMPLATE, content(added))),
    ).toBe(true)
  })

  test('a value goes into an entry and into an entry inside an entry', () => {
    const base = withSectionEntries({}, ALLEGATION, list => [
      ...list,
      newSectionEntry('a1'),
    ])
    const withKeyElement = withSectionEntries(
      base,
      `${ALLEGATION}#a1/key-element`,
      list => [...list, newSectionEntry('k1')],
    )
    const text = {
      type: 'rich_text' as const,
      doc: {
        type: 'doc' as const,
        content: [
          {
            type: 'paragraph' as const,
            content: [{ type: 'text' as const, text: 'Synthetic' }],
          },
        ],
      },
    }
    const filled = withItemValue(
      withItemValue(
        withKeyElement,
        `${ALLEGATION}#a1/facts`,
        'facts-text',
        text,
      ),
      `${ALLEGATION}#a1/key-element#k1`,
      'key-element-text',
      text,
    )
    expect(
      contentOfKey(filled, `${ALLEGATION}#a1/facts`).values['facts-text'],
    ).toEqual(text)
    expect(
      contentOfKey(filled, `${ALLEGATION}#a1/key-element#k1`).values[
        'key-element-text'
      ],
    ).toEqual(text)
    expect(
      Result.isSuccess(validateContent(INVESTIGATION_TEMPLATE, content(filled))),
    ).toBe(true)
  })

  test('removing the last entry removes the group', () => {
    const added = withSectionEntries({}, BACKGROUND, () => [
      newSectionEntry('b1'),
    ])
    expect(withSectionEntries(added, BACKGROUND, () => [])).toEqual({})
  })

  test('a value for an entry that is gone changes nothing', () => {
    const base = withSectionEntries({}, ALLEGATION, () => [
      newSectionEntry('a1'),
    ])
    expect(
      withItemValue(base, `${ALLEGATION}#gone/facts`, 'facts-text', {
        type: 'text',
        text: 'x',
      }),
    ).toEqual(base)
  })

  test('numbering follows the entries and their order', () => {
    const three = withSectionEntries({}, ALLEGATION, () =>
      ['a1', 'a2', 'a3'].map(newSectionEntry),
    )
    const numbered = (contents: SectionContents) =>
      numberSections(INVESTIGATION_TEMPLATE, { sections: contents })
        .filter(row => row.sectionId === 'allegation-block')
        .map(row => [row.entryId, row.number?.own])
    expect(numbered(three)).toEqual([
      ['a1', 'A.'],
      ['a2', 'B.'],
      ['a3', 'C.'],
    ])
    const moved = withSectionEntries(three, ALLEGATION, list =>
      moveEntry(list, 'a3', -1),
    )
    expect(numbered(moved)).toEqual([
      ['a1', 'A.'],
      ['a3', 'B.'],
      ['a2', 'C.'],
    ])
    const removed = withSectionEntries(three, ALLEGATION, list =>
      list.filter(item => item.id !== 'a1'),
    )
    expect(numbered(removed)).toEqual([
      ['a2', 'A.'],
      ['a3', 'B.'],
    ])
  })

  test('the states count the minimum of entries', () => {
    const none = sectionStates(INVESTIGATION_TEMPLATE, { sections: {} })
    const one = sectionStates(INVESTIGATION_TEMPLATE, {
      sections: withSectionEntries({}, ALLEGATION, () => [
        newSectionEntry('a1'),
      ]),
    })
    expect(none.get(ALLEGATION)).toBe('empty')
    expect(one.get(ALLEGATION)).not.toBe('empty')
    expect(one.get(`${ALLEGATION}#a1`)).toBe('empty')
  })
})

describe('entries of a repeated item', () => {
  const LIST = 'allegations'
  const ITEM = 'allegation-list'

  test('an entry is added, filled and found by its path', () => {
    const added = withItemEntries({}, LIST, [], ITEM, list => [
      ...list,
      newItemEntry('x1'),
    ])
    const filled = withItemValueAt(
      added,
      LIST,
      [{ itemId: ITEM, entryId: 'x1' }],
      'allegation-type',
      { type: 'text', text: 'Synthetic type' },
    )
    expect(
      itemEntriesOf(contentOfKey(filled, LIST).values, [], ITEM)[0]?.values[
        'allegation-type'
      ],
    ).toEqual({ type: 'text', text: 'Synthetic type' })
    expect(
      Result.isSuccess(validateContent(INTAKE_TEMPLATE, {
        ...emptyContent(INTAKE_TEMPLATE),
        sections: filled,
      })),
    ).toBe(true)
  })

  test('removing the last entry removes the value and the section', () => {
    const added = withItemEntries({}, LIST, [], ITEM, () => [newItemEntry('x1')])
    expect(withItemEntries(added, LIST, [], ITEM, () => [])).toEqual({})
  })
})

describe('not applicable', () => {
  const OPTIONAL_SECTION = 'overall-findings'

  test('a reason marks the section and keeps what it held', () => {
    const held = withItemValue({}, OPTIONAL_SECTION, 'overall-findings-text', {
      type: 'text',
      text: 'kept',
    })
    const marked = withSectionNotApplicable(held, OPTIONAL_SECTION, '  Not relevant  ')
    expect(notApplicableReasonOf(marked, OPTIONAL_SECTION)).toBe('Not relevant')
    expect(contentOfKey(marked, OPTIONAL_SECTION).values).toEqual(
      contentOfKey(held, OPTIONAL_SECTION).values,
    )
    expect(withSectionNotApplicable(marked, OPTIONAL_SECTION, undefined)).toEqual(
      held,
    )
  })

  test('a blank reason changes nothing', () => {
    expect(withSectionNotApplicable({}, OPTIONAL_SECTION, '   ')).toEqual({})
  })

  test('a repeatable group is marked as a whole and its entries stay', () => {
    const base = withSectionEntries({}, BACKGROUND, () => [
      newSectionEntry('b1'),
    ])
    const marked = withSectionNotApplicable(
      base,
      `${BACKGROUND}#b1`,
      'No background',
    )
    expect(notApplicableReasonOf(marked, BACKGROUND)).toBe('No background')
    expect(ids(entriesOfKey(marked, BACKGROUND))).toEqual(['b1'])
    expect(
      sectionStates(INVESTIGATION_TEMPLATE, { sections: marked }).get(BACKGROUND),
    ).toBe('not_applicable')
  })

  test('only an optional-with-reason section accepts the mark', () => {
    const marked = withSectionNotApplicable(
      {},
      'recommendation/recommend-individuals',
      'Nothing to recommend',
    )
    expect(
      Result.isSuccess(validateContent(INVESTIGATION_TEMPLATE, content(marked))),
    ).toBe(true)
    expect(
      Result.isFailure(
        validateContent(
          INVESTIGATION_TEMPLATE,
          content(withSectionNotApplicable({}, 'overall-findings', 'No')),
        ),
      ),
    ).toBe(true)
  })

  test('the numbers do not change when a section is marked', () => {
    const base = withSectionEntries({}, BACKGROUND, () => [
      newSectionEntry('b1'),
      newSectionEntry('b2'),
    ])
    const marked = withSectionNotApplicable(base, BACKGROUND, 'None')
    expect(numberSections(INVESTIGATION_TEMPLATE, { sections: marked })).toEqual(
      numberSections(INVESTIGATION_TEMPLATE, { sections: base }),
    )
  })
})

describe('entry lists', () => {
  const limits = { min: 1, max: 3 }
  const list = (...names: ReadonlyArray<string>) => names.map(entry)

  test('adding is refused at the maximum and for a repeated ID', () => {
    expect(Result.getOrThrow(addEntry(list('a', 'b'), entry('c'), limits))).toEqual(
      list('a', 'b', 'c'),
    )
    const full = addEntry(list('a', 'b', 'c'), entry('d'), limits)
    expect(Result.isFailure(full) ? full.failure : undefined).toBe('at_max')
    expect(Result.isFailure(addEntry(list('a'), entry('a'), limits))).toBe(true)
  })

  test('removing is refused at the minimum and for an unknown entry', () => {
    expect(Result.isFailure(removeEntry(list('a'), 'a', limits))).toBe(true)
    expect(Result.isFailure(removeEntry(list('a', 'b'), 'z', limits))).toBe(true)
    expect(Result.getOrThrow(removeEntry(list('a', 'b'), 'a', limits))).toEqual(
      list('b'),
    )
  })

  test('messages are plain and say the limit', () => {
    expect(refusalText('at_max', limits, 'allegation')).toBe(
      'At most 3 allegation entries can be added here.',
    )
    expect(refusalText('at_min', limits, 'allegation')).toBe(
      'At least 1 allegation is needed here, so the last one cannot be removed.',
    )
    expect(countText(0, limits, 'allegation')).toContain('Add 1 more')
    expect(countText(3, limits, 'allegation')).toContain('most allowed (3)')
    expect(countText(1, limits, 'allegation')).toBe('1 allegation.')
  })

  test('a title is trimmed, cut, and removed when blank', () => {
    expect(cleanTitle('  Harassment  ')).toBe('Harassment')
    expect(cleanTitle('   ')).toBeUndefined()
    expect(cleanTitle('x'.repeat(300))?.length).toBe(200)
    const titled = retitleEntry(list('a', 'b'), 'b', 'Second')
    expect(titled[1]).toEqual({ id: 'b', title: 'Second' })
    expect(retitleEntry(titled, 'b', '')[1]).toEqual({ id: 'b' })
    expect(entryDisplayTitle({ id: 'a' }, 'Allegation', 1)).toBe('Allegation 2')
    expect(entryDisplayTitle({ id: 'a', title: 'Mine' }, 'Allegation', 1)).toBe(
      'Mine',
    )
  })

  test('moving at an end changes nothing', () => {
    expect(moveEntry(list('a', 'b'), 'a', -1)).toEqual(list('a', 'b'))
    expect(moveEntry(list('a', 'b'), 'b', 1)).toEqual(list('a', 'b'))
    expect(moveEntry(list('a', 'b'), 'z', 1)).toEqual(list('a', 'b'))
  })
})

describe('entry list properties', () => {
  const names = fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/), {
    minLength: 0,
    maxLength: 6,
  })
  const limitsArb = fc
    .record({
      min: fc.integer({ min: 0, max: 3 }),
      extra: fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined }),
    })
    .map(({ min, extra }) =>
      extra === undefined ? { min } : { min, max: min + extra },
    )

  test('add and remove respect the limits and undo each other', () => {
    fc.assert(
      fc.property(names, limitsArb, fc.stringMatching(/^z[a-z]{0,3}$/), (current, limits, fresh) => {
        const list = current.map(entry)
        const added = addEntry(list, entry(fresh), limits)
        if (current.includes(fresh)) {
          expect(Result.isFailure(added)).toBe(true)
          return
        }
        expect(Result.isSuccess(added)).toBe(canAdd(list.length, limits))
        if (Result.isSuccess(added)) {
          expect(added.success.length).toBe(list.length + 1)
          if (canRemove(added.success.length, limits)) {
            expect(
              Result.getOrThrow(removeEntry(added.success, fresh, limits)),
            ).toEqual(list)
          }
        }
        const first = list[0]
        if (first !== undefined) {
          expect(Result.isSuccess(removeEntry(list, first.id, limits))).toBe(
            canRemove(list.length, limits),
          )
        }
      }),
      { numRuns: 200 },
    )
  })

  test('moving keeps the same entries and moving back restores the order', () => {
    fc.assert(
      fc.property(names, fc.nat(6), fc.constantFrom(-1 as const, 1 as const), (current, at, step) => {
        const list = current.map(entry)
        const target = list[at % Math.max(list.length, 1)]
        if (target === undefined) {
          return
        }
        const moved = moveEntry(list, target.id, step)
        expect([...ids(moved)].sort()).toEqual([...ids(list)].sort())
        if (ids(moved).join() !== ids(list).join()) {
          expect(moveEntry(moved, target.id, step === 1 ? -1 : 1)).toEqual(list)
        }
      }),
      { numRuns: 200 },
    )
  })

  test('titling never changes the order or the IDs', () => {
    fc.assert(
      fc.property(names, fc.string(), (current, text) => {
        const list = current.map(entry)
        const first = list[0]
        if (first === undefined) {
          return
        }
        const retitled = retitleEntry(list, first.id, text)
        expect(ids(retitled)).toEqual(ids(list))
        const kept = retitled[0]
        const title =
          kept !== undefined && 'title' in kept && typeof kept.title === 'string'
            ? kept.title
            : undefined
        expect(title === undefined || (title.length <= 200 && title === title.trim())).toBe(true)
      }),
      { numRuns: 200 },
    )
  })
})
