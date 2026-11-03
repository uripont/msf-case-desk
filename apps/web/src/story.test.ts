import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import { CaseId, DEMO_START, SEED_CASES } from '@case-desk/domain'

import { loadedModel } from './fixtures'
import {
  FocusCaseMark,
  GetCurrentTime,
  LoadDesk,
  Message,
  heroLayoutTransition,
  init,
  initialModel,
  overdueCountOf,
  update,
  visibleQueueOf,
} from './main'

describe('update', () => {
  test('selecting a case and closing the detail', () => {
    const caseId = CaseId.make('SYN-005')

    story(
      update,
      given(loadedModel),
      message(Message.ClickedCase({ caseId })),
      model(next => {
        expect(next.maybeSelectedCaseId).toEqual(Option.some(caseId))
      }),
      message(Message.ClickedCloseDetail()),
      model(next => {
        expect(next.maybeSelectedCaseId).toEqual(Option.none())
      }),
    )
  })

  test('advancing the clock creates overdue cases and reset restores it', () => {
    story(
      update,
      given(loadedModel),
      message(Message.ClickedAdvanceClock({ hours: 24 })),
      message(Message.ClickedAdvanceClock({ hours: 24 })),
      model(next => {
        expect(next.now).toBe(DEMO_START + 48 * 3_600_000)
        expect(overdueCountOf(next)).toBeGreaterThan(
          overdueCountOf(loadedModel),
        )
      }),
      message(Message.ClickedResetClock()),
      model(next => {
        expect(next.now).toBe(DEMO_START)
      }),
    )
  })

  test('the centre filter narrows the queue to one operational centre', () => {
    story(
      update,
      given(loadedModel),
      message(Message.SelectedCentreFilter({ centreFilter: 'OCG' })),
      model(next => {
        const rows = visibleQueueOf(next)
        expect(rows.length).toBeGreaterThan(0)
        rows.forEach(row => {
          expect(row.triageCase.centre).toBe('OCG')
        })
      }),
      message(Message.SelectedCentreFilter({ centreFilter: 'All' })),
      model(next => {
        expect(visibleQueueOf(next).length).toBe(next.cases.length)
      }),
    )
  })

  test('opening a case shows the detail sheet and closing hides it', () => {
    const caseId = CaseId.make('SYN-005')

    story(
      update,
      given(loadedModel),
      model(next => {
        expect(next.isDetailSheetOpen).toBe(false)
      }),
      message(Message.ClickedCase({ caseId })),
      model(next => {
        expect(next.isDetailSheetOpen).toBe(true)
        expect(next.maybeSelectedCaseId).toEqual(Option.some(caseId))
      }),
      message(Message.ClickedCloseDetail()),
      model(next => {
        expect(next.isDetailSheetOpen).toBe(false)
      }),
    )
  })

  test('pointing at a case highlights it until the pointer leaves', () => {
    const caseId = CaseId.make('SYN-003')

    story(
      update,
      given(loadedModel),
      message(Message.EnteredCase({ caseId })),
      model(next => {
        expect(next.maybeHighlightedCaseId).toEqual(Option.some(caseId))
      }),
      message(Message.LeftCase()),
      model(next => {
        expect(next.maybeHighlightedCaseId).toEqual(Option.none())
      }),
    )
  })

  test('demo controls start hidden and can be toggled', () => {
    story(
      update,
      given(loadedModel),
      model(next => {
        expect(next.isDemoControlsOpen).toBe(false)
      }),
      message(Message.ClickedToggleDemoControls()),
      model(next => {
        expect(next.isDemoControlsOpen).toBe(true)
      }),
      message(Message.ClickedToggleDemoControls()),
      model(next => {
        expect(next.isDemoControlsOpen).toBe(false)
      }),
    )
  })

  test('the first layout reading is not animated, later changes are', () => {
    story(
      update,
      given(loadedModel),
      message(Message.UpdatedHeroLayout({ layout: 'Timeline' })),
      model(next => {
        expect(next.heroLayout).toBe('Timeline')
        expect(
          heroLayoutTransition({ previousModel: loadedModel, model: next }),
        ).toBe(false)
        const wide = update(next, Message.UpdatedHeroLayout({ layout: 'Axis' }))
        expect(
          heroLayoutTransition({ previousModel: next, model: wide.model }),
        ).toBe(true)
        const hovered = update(
          next,
          Message.EnteredCase({ caseId: CaseId.make('SYN-003') }),
        )
        expect(
          heroLayoutTransition({ previousModel: next, model: hovered.model }),
        ).toBe(false)
      }),
      Command.expectNone(),
    )
  })

  test('a focused mark keeps focus when the layout changes', () => {
    const caseId = CaseId.make('SYN-003')

    story(
      update,
      given(loadedModel),
      message(Message.UpdatedHeroLayout({ layout: 'Axis' })),
      message(Message.FocusedCaseMark({ caseId })),
      message(Message.UpdatedHeroLayout({ layout: 'Timeline' })),
      model(next => {
        expect(next.maybeHighlightedCaseId).toEqual(Option.some(caseId))
        expect(next.maybeSelectedCaseId).toEqual(
          loadedModel.maybeSelectedCaseId,
        )
      }),
      Command.expectHas(FocusCaseMark({ selector: '#timeline-case-SYN-003' })),
      Command.resolve(FocusCaseMark, Message.CompletedFocusCaseMark()),
    )
  })

  test('without a focused mark the layout change moves no focus', () => {
    story(
      update,
      given(loadedModel),
      message(Message.UpdatedHeroLayout({ layout: 'Axis' })),
      message(Message.EnteredCase({ caseId: CaseId.make('SYN-003') })),
      message(Message.UpdatedHeroLayout({ layout: 'Timeline' })),
      Command.expectNone(),
    )
  })
})

describe('loading the desk', () => {
  test('starting the app reads the clock and loads the desk', () => {
    const started = init()
    expect(started.model.deskLoad._tag).toBe('Loading')
    expect(started.commands?.map(command => command.name)).toEqual([
      GetCurrentTime.name,
      LoadDesk.name,
    ])
  })

  test('loaded cases fill the queue and select the most urgent', () => {
    story(
      update,
      given(initialModel),
      message(Message.CompletedGetCurrentTime({ now: DEMO_START })),
      message(Message.SucceededLoadDesk({ cases: SEED_CASES, ruleSets: [] })),
      model(next => {
        expect(next.deskLoad._tag).toBe('Loaded')
        expect(visibleQueueOf(next).length).toBe(SEED_CASES.length)
        expect(Option.isSome(next.maybeSelectedCaseId)).toBe(true)
      }),
    )
  })

  test('a failed load can be retried', () => {
    story(
      update,
      given(initialModel),
      message(Message.FailedLoadDesk({ failure: 'Unavailable' })),
      model(next => {
        expect(next.deskLoad).toEqual({
          _tag: 'Failed',
          failure: 'Unavailable',
        })
      }),
      message(Message.ClickedRetryLoad()),
      model(next => {
        expect(next.deskLoad._tag).toBe('Loading')
      }),
      Command.expectHas(LoadDesk()),
      Command.resolve(
        LoadDesk,
        Message.SucceededLoadDesk({ cases: SEED_CASES, ruleSets: [] }),
      ),
      model(next => {
        expect(next.deskLoad._tag).toBe('Loaded')
      }),
    )
  })
})
