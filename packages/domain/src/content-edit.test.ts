import { Result } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  INTAKE_TEMPLATE,
  type ItemValue,
  type SectionContents,
  contentOfKey,
  emptyContent,
  endState,
  isEntryKey,
  sectionOfKey,
  topSectionIdOfKey,
  validateContent,
  withItemValue,
} from './index'
import { PANEL_TEMPLATE } from './testing/templates'

const choose = (optionId: string): ItemValue => ({
  type: 'select',
  optionIds: [optionId],
})

const reportOf = (sections: SectionContents) => ({
  ...emptyContent(INTAKE_TEMPLATE),
  sections,
})

describe('section keys', () => {
  test('a key names a top-level section or a subsection', () => {
    expect(topSectionIdOfKey('jurisdiction-materiality/jurisdiction')).toBe(
      'jurisdiction-materiality',
    )
    expect(
      sectionOfKey(INTAKE_TEMPLATE, 'jurisdiction-materiality/jurisdiction')
        ?.id,
    ).toBe('jurisdiction')
    expect(sectionOfKey(INTAKE_TEMPLATE, 'summary')?.title).toBe(
      'Summary of the complaint',
    )
    expect(sectionOfKey(INTAKE_TEMPLATE, 'jurisdiction')).toBeUndefined()
    expect(sectionOfKey(PANEL_TEMPLATE, 'items-reviewed/remarks')?.id).toBe(
      'remarks',
    )
  })

  test('an entry key is not addressed here', () => {
    expect(isEntryKey('allegations#a1')).toBe(true)
    expect(sectionOfKey(INTAKE_TEMPLATE, 'allegations#a1')).toBeUndefined()
    const contents = withItemValue(
      {},
      'allegations#a1',
      'x',
      { type: 'text', text: 'x' },
    )
    expect(contents).toEqual({})
  })
})

describe('editing one value', () => {
  test('a value is set in a top-level section and in a subsection', () => {
    const top = withItemValue({}, 'case-details', 'investigator', {
      type: 'text',
      text: 'Synthetic Investigator',
    })
    expect(contentOfKey(top, 'case-details').values['investigator']).toEqual({
      type: 'text',
      text: 'Synthetic Investigator',
    })
    const nested = withItemValue(
      top,
      'jurisdiction-materiality/jurisdiction',
      'jurisdiction-answer',
      choose('yes'),
    )
    expect(
      contentOfKey(nested, 'jurisdiction-materiality/jurisdiction').values[
        'jurisdiction-answer'
      ],
    ).toEqual(choose('yes'))
    expect(
      Result.isSuccess(validateContent(INTAKE_TEMPLATE, reportOf(nested))),
    ).toBe(true)
  })

  test('clearing a value leaves the content as it was, sparse', () => {
    const edited = withItemValue(
      {},
      'jurisdiction-materiality/jurisdiction',
      'jurisdiction-answer',
      choose('no'),
    )
    expect(Object.keys(edited)).toEqual(['jurisdiction-materiality'])
    const cleared = withItemValue(
      edited,
      'jurisdiction-materiality/jurisdiction',
      'jurisdiction-answer',
      undefined,
    )
    expect(cleared).toEqual({})
  })

  test('other values and sections stay when one is cleared', () => {
    const base = withItemValue({}, 'case-details', 'investigator', {
      type: 'text',
      text: 'Synthetic Investigator',
    })
    const both = withItemValue(
      base,
      'jurisdiction-materiality/materiality',
      'materiality-answer',
      choose('yes'),
    )
    const cleared = withItemValue(
      both,
      'jurisdiction-materiality/materiality',
      'materiality-answer',
      undefined,
    )
    expect(cleared).toEqual(base)
  })

  test('the original content is not changed', () => {
    const original: SectionContents = {}
    withItemValue(original, 'case-details', 'investigator', {
      type: 'text',
      text: 'x',
    })
    expect(original).toEqual({})
  })
})

describe('branching follows the edit', () => {
  test('choosing the end answer ends the report and changing it back restores', () => {
    const ended = withItemValue(
      {},
      'jurisdiction-materiality/jurisdiction',
      'jurisdiction-answer',
      choose('no'),
    )
    expect(endState(INTAKE_TEMPLATE, { sections: ended }).ended).toBe(true)
    const restored = withItemValue(
      ended,
      'jurisdiction-materiality/jurisdiction',
      'jurisdiction-answer',
      choose('yes'),
    )
    expect(endState(INTAKE_TEMPLATE, { sections: restored }).ended).toBe(false)
  })
})
