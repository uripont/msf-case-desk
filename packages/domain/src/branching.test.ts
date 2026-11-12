import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  INTAKE_TEMPLATE,
  type ReportContent,
  type Section,
  type Template,
  emptyContent,
  endState,
  numberSections,
  sectionStates,
} from './index'
import {
  MINI_TEMPLATE,
  clearNotApplicable,
  endAnswersOf,
  templateWithContentArbitrary,
  withEndAnswer,
  withItemValue,
  withoutEndAnswers,
} from './testing/content'

const answer = (
  template: Template,
  content: ReportContent,
  itemId: string,
  optionId: string,
) =>
  withItemValue(template, content, itemId, {
    type: 'select',
    optionIds: [optionId],
  })

const para = (text: string) => ({
  type: 'rich_text' as const,
  doc: {
    type: 'doc' as const,
    content: [
      {
        type: 'paragraph' as const,
        content: [{ type: 'text' as const, text }],
      },
    ],
  },
})

const flatten = (sections: ReadonlyArray<Section>): ReadonlyArray<Section> =>
  sections.flatMap(section => [section, ...flatten(section.sections)])

const parents = (
  sections: ReadonlyArray<Section>,
  parent?: Section,
): Array<[string, string | undefined]> =>
  sections.flatMap(section => [
    [section.id, parent?.id] as [string, string | undefined],
    ...parents(section.sections, section),
  ])

describe('branching in the intake', () => {
  const intake = INTAKE_TEMPLATE
  const start = emptyContent(intake)

  test('nothing ends the report until an end answer is chosen', () => {
    expect(endState(intake, start).ended).toBe(false)
    const yes = answer(intake, start, 'jurisdiction-answer', 'yes')
    expect(endState(intake, yes).ended).toBe(false)
    expect(endState(intake, yes).outcomeText).toBeUndefined()
  })

  test('the first question ending it marks the later required sections, not the sign-off', () => {
    const ended = endState(
      intake,
      answer(intake, start, 'jurisdiction-answer', 'no'),
    )
    expect(ended.ended).toBe(true)
    expect(ended.triggers).toEqual([
      {
        sectionId: 'jurisdiction',
        itemId: 'jurisdiction-answer',
        optionId: 'no',
      },
    ])
    expect(ended.outcomeText).toMatch(/referred to the behaviour lead/)
    for (const id of [
      'materiality',
      'results',
      'research-results',
      'assessment',
      'recommendation',
    ]) {
      expect(ended.endedSectionIds.has(id), id).toBe(true)
    }
    // Before the question, optional, kept in force, and the conclusion.
    for (const id of [
      'case-details',
      'summary',
      'allegations',
      'jurisdiction-materiality',
      'jurisdiction',
      'witnesses',
      'sign-off',
      'committee-conclusion',
    ]) {
      expect(ended.endedSectionIds.has(id), id).toBe(false)
    }
  })

  test('the second question only ends what follows it', () => {
    const ended = endState(
      intake,
      answer(intake, start, 'materiality-answer', 'no'),
    )
    expect(ended.endedSectionIds.has('jurisdiction')).toBe(false)
    expect(ended.endedSectionIds.has('materiality')).toBe(false)
    expect(ended.endedSectionIds.has('results')).toBe(true)
  })

  test('either answer ends it, and both together end the same sections', () => {
    const one = endState(
      intake,
      answer(intake, start, 'jurisdiction-answer', 'no'),
    )
    const both = endState(
      intake,
      answer(
        intake,
        answer(intake, start, 'jurisdiction-answer', 'no'),
        'materiality-answer',
        'no',
      ),
    )
    expect(both.triggers).toHaveLength(2)
    expect(both.endedSectionIds).toEqual(one.endedSectionIds)
  })

  test('the states show it, and changing the answer restores what the sections held', () => {
    const filled = withItemValue(
      intake,
      withItemValue(intake, start, 'research-results-text', para('Findings')),
      'summary-text',
      para('Summary'),
    )
    const before = sectionStates(intake, filled)
    expect(before.get('results/research-results')).not.toBe('ended')
    const ended = answer(intake, filled, 'jurisdiction-answer', 'no')
    const during = sectionStates(intake, ended)
    expect(during.get('results')).toBe('ended')
    expect(during.get('results/research-results')).toBe('ended')
    expect(during.get('sign-off')).not.toBe('ended')
    expect(during.get('summary')).toBe(before.get('summary'))
    // Nothing was deleted, and nothing about the numbering moved.
    expect(JSON.stringify(ended)).toContain('Findings')
    expect(numberSections(intake, ended)).toEqual(
      numberSections(intake, filled),
    )
    const restored = answer(intake, ended, 'jurisdiction-answer', 'yes')
    expect(endState(intake, restored).ended).toBe(false)
    expect(sectionStates(intake, restored)).toEqual(
      sectionStates(
        intake,
        answer(intake, filled, 'jurisdiction-answer', 'yes'),
      ),
    )
    expect(
      sectionStates(intake, restored).get('results/research-results'),
    ).toBe(before.get('results/research-results'))
  })
})

describe('branching in the mini template', () => {
  const template = MINI_TEMPLATE
  const ended = answer(template, emptyContent(template), 'proceed', 'no')

  test('required sections after the question end; optional, kept and earlier ones do not', () => {
    const state = endState(template, ended)
    // `details` holds the question: it is not after itself. `extras` is optional with a reason.
    expect([...state.endedSectionIds].sort()).toEqual(
      ['thing', 'thing-facts', 'things', 'things-summary'].sort(),
    )
  })

  test('a section that is not applicable takes no part', () => {
    const marked = {
      ...ended,
      sections: {
        ...ended.sections,
        details: {
          ...ended.sections['details']!,
          notApplicable: { reason: 'x' },
        },
      },
    }
    // The section holding the question is required here, so this content would not validate,
    // but the states still read it safely: the question is ignored.
    expect(endState(template, marked).ended).toBe(false)
  })

  test('entries of an ended repeatable subsection are all ended, and keep their content', () => {
    const content: ReportContent = {
      ...ended,
      sections: {
        ...ended.sections,
        things: {
          values: {},
          sections: {
            thing: {
              values: {},
              sections: {},
              entries: [
                {
                  id: 'e1',
                  values: { 'thing-title': { type: 'text', text: 'T' } },
                  sections: {},
                },
              ],
            },
          },
        },
      },
    }
    const states = sectionStates(template, content)
    expect(states.get('things/thing#e1')).toBe('ended')
    expect(states.get('things/thing')).toBe('ended')
    expect(states.get('things/thing#e1/thing-facts')).toBe('ended')
    expect(states.get('sign')).toBe('empty')
    const restored = answer(template, content, 'proceed', 'yes')
    expect(sectionStates(template, restored).get('things/thing#e1')).toBe(
      'in_progress',
    )
  })
})

describe('branching, generated templates', () => {
  const cases = templateWithContentArbitrary.filter(
    ({ template }) => endAnswersOf(template).length > 0,
  )

  test('every end answer marks exactly the sections D23 says, and restores them', () => {
    fc.assert(
      fc.property(cases, fc.nat(5), ({ template, content }, pick) => {
        const base = withoutEndAnswers(
          template,
          clearNotApplicable(template, content),
        )
        expect(endState(template, base).ended).toBe(false)
        const baseStates = sectionStates(template, base)
        for (const state of baseStates.values()) {
          expect(state).not.toBe('ended')
        }

        const triggered = withEndAnswer(template, base, pick)
        const state = endState(template, triggered)
        expect(state.ended).toBe(true)
        expect(state.outcomeText).toBe(template.ending?.outcomeText)

        const all = flatten(template.sections)
        const parentOf = new Map(parents(template.sections))
        const order = new Map(all.map((section, index) => [section.id, index]))
        const first = Math.min(
          ...state.triggers.map(t => order.get(t.sectionId) ?? Infinity),
        )
        const stays = new Set(template.ending?.staysInForce ?? [])
        const underStay = (id: string): boolean => {
          for (
            let current: string | undefined = id;
            current !== undefined;
            current = parentOf.get(current)
          ) {
            if (stays.has(current)) return true
          }
          return false
        }
        for (const section of all) {
          const parent = parentOf.get(section.id)
          const parentEnded =
            parent !== undefined && state.endedSectionIds.has(parent)
          const expected =
            parentEnded ||
            ((order.get(section.id) ?? 0) > first &&
              section.requirement === 'required' &&
              !underStay(section.id))
          expect(state.endedSectionIds.has(section.id), section.id).toBe(
            expected,
          )
        }
        // The sections the template keeps in force are in force, unless a parent ended.
        for (const id of stays) {
          const parent = parentOf.get(id)
          if (parent === undefined || !state.endedSectionIds.has(parent)) {
            expect(state.endedSectionIds.has(id)).toBe(false)
          }
        }
        // The conclusion is never ended.
        if (template.conclusion !== undefined) {
          expect(state.endedSectionIds.has(template.conclusion.id)).toBe(false)
        }

        // Every shown instance of an ended section reads `ended`, no other does.
        const states = sectionStates(template, triggered)
        for (const shown of numberSections(template, triggered)) {
          expect(states.get(shown.key) === 'ended', shown.key).toBe(
            state.endedSectionIds.has(shown.sectionId),
          )
        }

        // Changing the answer back restores them, with everything they held.
        const restored = withoutEndAnswers(template, triggered)
        expect(restored).toEqual(base)
        expect(endState(template, restored).ended).toBe(false)
        expect(sectionStates(template, restored)).toEqual(baseStates)
        // And the numbers never moved.
        expect(numberSections(template, triggered)).toEqual(
          numberSections(template, base),
        )
      }),
      { numRuns: 200 },
    )
  })
})
