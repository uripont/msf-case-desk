import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { INVESTIGATION_TEMPLATE, entriesOfKey } from '@case-desk/domain'

import { clickedLinkTo, clickedPage } from './fixtures'
import { Message, update } from './main'
import { authorModel } from './quoroom.fixtures'
import { sectionTarget } from './quoroom/entryEdit'
import { Failure } from './quoroom/failure'
import * as History from './quoroom/history'
import * as Report from './quoroom/report'
import {
  REPORT_ID,
  SAVED_AT,
  SCOPE,
  loadedReport,
  staleSaveFacts,
} from './report.fixtures'

// NOTE: The regression tests of the stage 4 review: every answer carries the
// identity of the page that asked, nothing leaves a report with unsaved edits
// silently, and a save that only lost its answer is not a conflict.

type Step = ReturnType<typeof update>

const reportMessage = (message: Report.Message) =>
  Message.GotReportMessage({ message })

const names = (step: Step): ReadonlyArray<string> =>
  (step.commands ?? []).map(command => command.name)

const BACKGROUND = 'background/background-topic'
const target = sectionTarget(BACKGROUND)

const investigation = () =>
  [
    clickedLinkTo(`/r/${REPORT_ID}`),
    reportMessage(
      Report.Message.SucceededLoadReport({
        scope: SCOPE,
        loaded: loadedReport(INVESTIGATION_TEMPLATE, { state: 'drafting' }),
      }),
    ),
  ].reduce((model, message) => update(model, message).model, authorModel)

const send = (
  model: ReturnType<typeof investigation>,
  ...messages: ReadonlyArray<Message>
): Step =>
  messages.reduce<Step>((current, next) => update(current.model, next), {
    model,
    commands: [],
  })

const reportSends = (
  model: ReturnType<typeof investigation>,
  ...messages: ReadonlyArray<Report.Message>
): Step => send(model, ...messages.map(reportMessage))

const edited = () =>
  reportSends(
    investigation(),
    Report.Message.ClickedAddEntry({ target }),
    Report.Message.GeneratedEntryId({ scope: SCOPE, target, entryId: 'b1' }),
  )

const savedAs = (saveCounter: number) =>
  Report.Message.SucceededSaveSection({
    scope: SCOPE,
    sectionId: 'background',
    saveCounter,
    savedAt: SAVED_AT,
  })

describe('every answer is for the page that asked', () => {
  test('an answer for another report or an earlier entry changes nothing', () => {
    const model = edited().model
    const answers = [
      { ...SCOPE, reportId: 'report-2' },
      { ...SCOPE, generation: SCOPE.generation + 1 },
      { ...SCOPE, generation: 0 },
      { ...SCOPE, epoch: SCOPE.epoch + 1 },
    ].map(scope =>
      reportSends(
        model,
        Report.Message.SucceededSaveSection({
          scope,
          sectionId: 'background',
          saveCounter: 9,
          savedAt: SAVED_AT,
        }),
      ),
    )
    answers.forEach(answer => {
      expect(answer.model.report).toBe(model.report)
      expect(names(answer)).toEqual([])
    })
    const current = reportSends(model, savedAs(9))
    expect(current.model.report.saveCounter).toBe(9)
  })

  test('a late load of a report left meanwhile does not replace the next one', () => {
    const left = send(investigation(), clickedPage('Reports'))
    const again = send(left.model, clickedLinkTo('/r/report-2'))
    expect(again.model.report.reportId).toBe('report-2')
    const late = reportSends(
      again.model,
      Report.Message.SucceededLoadReport({
        scope: SCOPE,
        loaded: loadedReport(INVESTIGATION_TEMPLATE),
      }),
    )
    expect(late.model.report).toBe(again.model.report)
  })
})

describe('leaving a report with unsaved edits', () => {
  test('a link to another page asks first and keeps the report', () => {
    const asked = send(edited().model, clickedPage('Reports'))
    expect(Option.isSome(asked.model.maybeLeaving)).toBe(true)
    expect(asked.model.route._tag).toBe('Report')
    expect(asked.model.report.contents).toEqual(edited().model.report.contents)
  })

  test('staying closes the question and keeps the edits', () => {
    const asked = send(edited().model, clickedPage('Reports'))
    const stayed = send(asked.model, Message.ClickedStayOnReport())
    expect(Option.isNone(stayed.model.maybeLeaving)).toBe(true)
    expect(stayed.model.route._tag).toBe('Report')
    expect(Report.hasUnsavedEdits(stayed.model.report)).toBe(true)
  })

  test('leaving without the save gives the edits up', () => {
    const asked = send(edited().model, clickedPage('Reports'))
    const left = send(asked.model, Message.ClickedLeaveReportUnsaved())
    expect(left.model.route._tag).toBe('Reports')
    expect(Option.isNone(left.model.maybeLeaving)).toBe(true)
    expect(Report.hasUnsavedEdits(left.model.report)).toBe(false)
  })

  test('waiting leaves by itself once the save is done', () => {
    const asked = send(edited().model, clickedPage('Reports'))
    const waiting = send(asked.model, Message.ClickedWaitToLeaveReport())
    expect(waiting.model.route._tag).toBe('Report')
    const done = reportSends(waiting.model, savedAs(2))
    expect(done.model.route._tag).toBe('Reports')
    expect(Option.isNone(done.model.maybeLeaving)).toBe(true)
  })

  test('a saved report is left without a question', () => {
    const saved = reportSends(edited().model, savedAs(2))
    const left = send(saved.model, clickedPage('Reports'))
    expect(Option.isNone(left.model.maybeLeaving)).toBe(true)
    expect(left.model.route._tag).toBe('Reports')
  })

  test('entering the same report again keeps the unsaved model', () => {
    const model = edited().model
    const again = send(model, clickedLinkTo(`/r/${REPORT_ID}`))
    expect(again.model.report).toBe(model.report)
    expect(names(again)).not.toContain(Report.LoadReport.name)
    const saved = reportSends(
      again.model,
      Report.Message.SucceededSaveSection({
        scope: SCOPE,
        sectionId: 'background',
        saveCounter: 2,
        savedAt: SAVED_AT,
      }),
    )
    expect(
      entriesOfKey(saved.model.report.contents, BACKGROUND).map(e => e.id),
    ).toEqual(['b1'])
  })
})

describe('saves and replacing the copy', () => {
  test('replacing the working copy waits for a save that is under way', () => {
    const asked = reportSends(
      edited().model,
      Report.Message.ClickedReplaceCopy(),
    )
    expect(Report.hasUnsavedEdits(asked.model.report)).toBe(true)
    const confirmed = reportSends(
      asked.model,
      Report.Message.ConfirmedReplaceCopy(),
    )
    expect(names(confirmed)).not.toContain(Report.ReplaceWorkingCopy.name)
    expect(Option.isNone(confirmed.model.report.maybeConfirmation)).toBe(true)
    expect(Option.isSome(confirmed.model.report.maybeEditNote)).toBe(true)
  })

  test('a save that only lost its answer is not an other-tab conflict', () => {
    const stale = reportSends(
      edited().model,
      Report.Message.StaleSaveSection({
        scope: SCOPE,
        sectionId: 'background',
        sent: { values: {}, sections: {} },
      }),
    )
    expect(names(stale)).toEqual([Report.ReadStaleSection.name])
    const same = reportSends(
      stale.model,
      Report.Message.SucceededReadStaleSection({
        ...staleSaveFacts('background'),
        saved: { values: {}, sections: {} },
      }),
    )
    expect(same.model.report.save._tag).not.toBe('Stale')
    expect(same.model.report.saveCounter).toBe(3)
  })

  test('a save that really differs from the server is the other-tab state', () => {
    const differs = reportSends(
      edited().model,
      Report.Message.SucceededReadStaleSection(staleSaveFacts('background')),
    )
    expect(differs.model.report.save._tag).toBe('Stale')
    expect(differs.model.report.dirtySectionIds).toEqual(['background'])
  })

  test('putting a kept edit back asks first', () => {
    const reloaded = reportSends(
      edited().model,
      Report.Message.SucceededReadStaleSection(staleSaveFacts('background')),
      Report.Message.SucceededReloadWorkingCopy({
        scope: SCOPE,
        contents: {},
        saveCounter: 4,
        savedAt: SAVED_AT,
        copy: {
          baseDraft: 0,
          latestDraft: 0,
          behind: false,
          hasUnsharedChanges: false,
        },
      }),
    )
    const asked = reportSends(
      reloaded.model,
      Report.Message.ClickedReapplyEdit({ sectionId: 'background' }),
    )
    expect(Option.isSome(asked.model.report.maybeConfirmation)).toBe(true)
    expect(asked.model.report.keptEdits).toEqual(
      reloaded.model.report.keptEdits,
    )
    expect(names(asked)).not.toContain(Report.SaveSection.name)
  })
})

describe('the history and share screens ignore answers of another entry', () => {
  test('a late history answer for another report or entry changes nothing', () => {
    const entered = send(authorModel, clickedLinkTo(`/r/${REPORT_ID}/drafts`))
    const answer = (reportId: string, generation: number) =>
      send(
        entered.model,
        Message.GotHistoryMessage({
          message: History.Message.FailedLoadHistory({
            scope: { reportId, generation },
            failure: Failure.Unavailable(),
          }),
        }),
      )
    const generation = entered.model.history.generation
    expect(answer('report-2', generation).model.history).toBe(
      entered.model.history,
    )
    expect(answer(REPORT_ID, generation - 1).model.history).toBe(
      entered.model.history,
    )
    expect(answer(REPORT_ID, generation).model.history.load._tag).toBe('Failed')
  })
})
