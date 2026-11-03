import { Result } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import { type Case, CaseId, DEMO_START } from '@case-desk/domain'

import {
  emptyEntryForm,
  entryOf,
  fromDateTimeInput,
  toDateTimeInput,
} from './entryForm'
import { loadedModel } from './fixtures'
import { CreateCase, FocusElement, Message, update } from './main'

const created: Case = {
  id: CaseId.make('CD-NEW00001'),
  summary: 'Synthetic report entered in a test.',
  centre: 'OCP',
  receivedAt: DEMO_START,
  scope: 'Team',
  risk: 'High',
  urgency: 'Elevated',
  fastTrackSignals: [],
  channel: 'Email',
  details: '',
  location: '',
  reference: '',
  enteredAt: DEMO_START,
  enteredByName: 'Synthetic Tester',
  schemaVersion: 1,
}

describe('case entry form', () => {
  test('the date field round-trips in UTC', () => {
    expect(toDateTimeInput(DEMO_START)).toBe('2026-11-02T09:00')
    expect(fromDateTimeInput('2026-11-02T09:00')).toEqual(
      expect.objectContaining({ value: DEMO_START }),
    )
  })

  test('an empty summary is refused and the form shows why', () => {
    expect(
      Result.isFailure(entryOf(emptyEntryForm(DEMO_START), DEMO_START)),
    ).toBe(true)
    story(
      update,
      given(loadedModel),
      message(Message.ClickedPage({ page: 'NewCase' })),
      Command.resolve(FocusElement, Message.CompletedFocusElement()),
      message(Message.SubmittedEntry()),
      model(next => {
        expect(next.entryForm.isShowingErrors).toBe(true)
        expect(next.entryForm.submission._tag).toBe('Editing')
      }),
      Command.expectHas(FocusElement({ selector: '#entry-summary' })),
      Command.resolve(FocusElement, Message.CompletedFocusElement()),
    )
  })

  test('a valid entry is saved and opens on the desk', () => {
    story(
      update,
      given(loadedModel),
      message(Message.ClickedPage({ page: 'NewCase' })),
      Command.resolve(FocusElement, Message.CompletedFocusElement()),
      message(
        Message.UpdatedEntryField({
          field: 'summary',
          value: `  ${created.summary}  `,
        }),
      ),
      message(Message.UpdatedEntryField({ field: 'centre', value: 'OCP' })),
      message(Message.UpdatedEntryField({ field: 'channel', value: 'Email' })),
      message(Message.UpdatedEntryField({ field: 'risk', value: 'High' })),
      message(Message.UpdatedEntryField({ field: 'risk', value: 'Enormous' })),
      message(
        Message.UpdatedEntryField({ field: 'urgency', value: 'Elevated' }),
      ),
      message(Message.UpdatedEntryField({ field: 'scope', value: 'Team' })),
      message(Message.ToggledEntrySignal({ signal: 'Retaliation' })),
      message(Message.ToggledEntrySignal({ signal: 'Retaliation' })),
      message(Message.SubmittedEntry()),
      model(next => {
        expect(next.entryForm.submission._tag).toBe('Submitting')
      }),
      Command.expectHas(
        CreateCase({
          entry: {
            centre: 'OCP',
            channel: 'Email',
            receivedAt: DEMO_START,
            summary: created.summary,
            scope: 'Team',
            risk: 'High',
            urgency: 'Elevated',
            fastTrackSignals: [],
          },
        }),
      ),
      Command.resolve(CreateCase, Message.SucceededCreateCase({ created })),
      Command.resolve(FocusElement, Message.CompletedFocusElement()),
      model(next => {
        expect(next.page).toBe('Desk')
        expect(next.isDetailSheetOpen).toBe(true)
        expect(next.cases).toContainEqual(created)
        expect(next.maybeSelectedCaseId).toEqual(
          expect.objectContaining({ value: created.id }),
        )
        expect(next.entryForm.summary).toBe('')
      }),
    )
  })

  test('a failed save keeps the draft and says so', () => {
    story(
      update,
      given(loadedModel),
      message(
        Message.UpdatedEntryField({ field: 'summary', value: created.summary }),
      ),
      message(Message.SubmittedEntry()),
      Command.resolve(
        CreateCase,
        Message.FailedCreateCase({ failure: 'Unavailable' }),
      ),
      model(next => {
        expect(next.entryForm.summary).toBe(created.summary)
        expect(next.entryForm.submission).toEqual({
          _tag: 'Failed',
          failure: 'Unavailable',
        })
      }),
    )
  })
})
