import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  INVESTIGATION_TEMPLATE,
  contentOfKey,
  entriesOfKey,
  notApplicableReasonOf,
} from '@case-desk/domain'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { authorModel } from './quoroom.fixtures'
import { Failure } from './quoroom/failure'
import { sectionTarget } from './quoroom/entryEdit'
import * as Report from './quoroom/report'
import { REPORT_ID, SAVED_AT, loadedReport } from './report.fixtures'

// NOTE: Stage 4e and 4f, as a person would drive them: entries, *not
// applicable*, and the save states, checked on the Model and the Commands.

const reportMessage = (message: Report.Message) =>
  Message.GotReportMessage({ message })

const investigation = () =>
  [
    clickedLinkTo(`/r/${REPORT_ID}`),
    reportMessage(
      Report.Message.SucceededLoadReport({
        loaded: loadedReport(INVESTIGATION_TEMPLATE, {
          state: 'drafting',
        }),
      }),
    ),
  ].reduce((model, message) => update(model, message).model, authorModel)

const names = (step: ReturnType<typeof update>): ReadonlyArray<string> =>
  (step.commands ?? []).map(command => command.name)

const BACKGROUND = 'background/background-topic'
const target = sectionTarget(BACKGROUND)

const send = (
  model: ReturnType<typeof investigation>,
  ...messages: ReadonlyArray<Report.Message>
): ReturnType<typeof update> => {
  const start: ReturnType<typeof update> = { model, commands: [] }
  return messages.reduce(
    (current, next) => update(current.model, reportMessage(next)),
    start,
  )
}

const withEntries = (...ids: ReadonlyArray<string>) =>
  send(
    investigation(),
    ...ids.flatMap(entryId => [
      Report.Message.ClickedAddEntry({ target }),
      Report.Message.GeneratedEntryId({ target, entryId }),
    ]),
  )

describe('entries of a repeatable subsection', () => {
  test('adding asks for an ID, then adds the entry, selects it and saves', () => {
    const asked = update(
      investigation(),
      reportMessage(Report.Message.ClickedAddEntry({ target })),
    )
    expect(names(asked)).toEqual([Report.NewEntryId.name])
    const added = update(
      asked.model,
      reportMessage(Report.Message.GeneratedEntryId({ target, entryId: 'b1' })),
    )
    expect(
      entriesOfKey(added.model.report.contents, BACKGROUND).map(e => e.id),
    ).toEqual(['b1'])
    expect(added.model.report.maybeSelectedKey).toEqual(
      Option.some('background/background-topic#b1'),
    )
    expect(added.model.report.dirtySectionIds).toEqual([])
    expect(names(added)).toContain(Report.SaveSection.name)
  })

  test('a failed ID adds nothing and says so', () => {
    const step = update(
      investigation(),
      reportMessage(Report.Message.GeneratedEntryId({ target, entryId: '' })),
    )
    expect(entriesOfKey(step.model.report.contents, BACKGROUND)).toEqual([])
    expect(Option.isSome(step.model.report.maybeEditNote)).toBe(true)
  })

  test('removing asks first, and nothing is removed until it is confirmed', () => {
    const base = withEntries('b1', 'b2').model
    const asked = send(
      base,
      Report.Message.ClickedRemoveEntry({
        target,
        entryId: 'b1',
        label: 'Background topic 1',
      }),
    )
    expect(Option.isSome(asked.model.report.maybeConfirmation)).toBe(true)
    expect(entriesOfKey(asked.model.report.contents, BACKGROUND)).toHaveLength(
      2,
    )
    const cancelled = send(asked.model, Report.Message.CancelledConfirmation())
    expect(Option.isNone(cancelled.model.report.maybeConfirmation)).toBe(true)
    expect(
      entriesOfKey(cancelled.model.report.contents, BACKGROUND),
    ).toHaveLength(2)
    const removed = send(asked.model, Report.Message.ConfirmedRemoveEntry())
    expect(
      entriesOfKey(removed.model.report.contents, BACKGROUND).map(e => e.id),
    ).toEqual(['b2'])
    expect(Option.isNone(removed.model.report.maybeConfirmation)).toBe(true)
  })

  test('entries move up and down, and the numbering follows', () => {
    const base = withEntries('b1', 'b2').model
    const moved = send(
      base,
      Report.Message.ClickedMoveEntry({ target, entryId: 'b2', step: -1 }),
    )
    expect(
      entriesOfKey(moved.model.report.contents, BACKGROUND).map(e => e.id),
    ).toEqual(['b2', 'b1'])
    const template = Option.getOrThrow(moved.model.report.maybeTemplate)
    const rows = Report.outlineOf(template, moved.model.report).rows
    const titles = rows
      .filter(row => row.sectionId === 'background-topic')
      .map(row => row.title)
    expect(titles).toEqual(['Background topic 1', 'Background topic 2'])
    expect(
      rows.filter(row => row.entryId !== undefined).map(row => row.entryId),
    ).toContain('b2')
  })

  test('a title the author types names the entry in the navigator', () => {
    const base = withEntries('b1').model
    const titled = send(
      base,
      Report.Message.ChangedEntryTitle({
        target,
        entryId: 'b1',
        text: 'Security context ',
      }),
    )
    const template = Option.getOrThrow(titled.model.report.maybeTemplate)
    const row = Report.outlineOf(template, titled.model.report).rows.find(
      candidate => candidate.entryId === 'b1',
    )
    expect(row?.title).toBe('Security context')
    expect(
      titled.model.report.titleDrafts['background/background-topic#b1'],
    ).toBe('Security context ')
  })

  test('removing the selected entry selects the section that held it', () => {
    const base = withEntries('b1').model
    expect(base.report.maybeSelectedKey).toEqual(
      Option.some('background/background-topic#b1'),
    )
    const removed = send(
      base,
      Report.Message.ClickedRemoveEntry({
        target,
        entryId: 'b1',
        label: 'Background topic 1',
      }),
      Report.Message.ConfirmedRemoveEntry(),
    )
    expect(removed.model.report.maybeSelectedKey).toEqual(
      Option.some('background'),
    )
  })
})

describe('not applicable', () => {
  const RECOMMEND = 'recommendation/recommend-individuals'
  const naTarget = sectionTarget(RECOMMEND)

  test('a reason is required, and the content is kept and can come back', () => {
    const base = investigation()
    const opened = send(
      base,
      Report.Message.OpenedNotApplicable({ target: naTarget, reason: '' }),
      Report.Message.SubmittedNotApplicable({ target: naTarget }),
    )
    expect(Object.values(opened.model.report.naDrafts)[0]?.isMissing).toBe(true)
    expect(
      notApplicableReasonOf(opened.model.report.contents, RECOMMEND),
    ).toBeUndefined()
    const marked = send(
      opened.model,
      Report.Message.TypedNotApplicableReason({
        target: naTarget,
        text: 'No individual is recommended.',
      }),
      Report.Message.SubmittedNotApplicable({ target: naTarget }),
    )
    expect(notApplicableReasonOf(marked.model.report.contents, RECOMMEND)).toBe(
      'No individual is recommended.',
    )
    expect(marked.model.report.naDrafts).toEqual({})
    const restored = send(
      marked.model,
      Report.Message.RestoredApplicable({ target: naTarget }),
    )
    expect(
      notApplicableReasonOf(restored.model.report.contents, RECOMMEND),
    ).toBeUndefined()
    expect(
      contentOfKey(restored.model.report.contents, RECOMMEND).notApplicable,
    ).toBeUndefined()
  })
})

describe('the save states', () => {
  const edited = () => withEntries('b1')

  test('a save refused by the guard stops sending and keeps the edit', () => {
    const stale = send(
      edited().model,
      Report.Message.StaleSaveSection({ sectionId: 'background' }),
    )
    expect(stale.model.report.save._tag).toBe('Stale')
    expect(stale.model.report.dirtySectionIds).toEqual(['background'])
    const more = send(
      stale.model,
      Report.Message.ClickedAddEntry({ target }),
      Report.Message.GeneratedEntryId({ target, entryId: 'b2' }),
    )
    expect(names(more)).not.toContain(Report.SaveSection.name)
    expect(entriesOfKey(more.model.report.contents, BACKGROUND)).toHaveLength(2)
    expect(Report.hasUnsavedEdits(more.model.report)).toBe(true)
  })

  test('reloading keeps what the server does not have, to copy or put back', () => {
    const stale = send(
      edited().model,
      Report.Message.StaleSaveSection({ sectionId: 'background' }),
    )
    const reloading = send(
      stale.model,
      Report.Message.ClickedReloadWorkingCopy(),
    )
    expect(names(reloading)).toEqual([Report.ReloadWorkingCopy.name])
    const reloaded = send(
      reloading.model,
      Report.Message.SucceededReloadWorkingCopy({
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
    expect(reloaded.model.report.saveCounter).toBe(4)
    expect(reloaded.model.report.save._tag).toBe('Saved')
    expect(reloaded.model.report.contents).toEqual({})
    expect(reloaded.model.report.keptEdits.map(edit => edit.sectionId)).toEqual(
      ['background'],
    )
    expect(reloaded.model.report.editorBase).toBeGreaterThan(
      stale.model.report.editorBase,
    )
    const reapplied = send(
      reloaded.model,
      Report.Message.ClickedReapplyEdit({ sectionId: 'background' }),
    )
    expect(
      entriesOfKey(reapplied.model.report.contents, BACKGROUND).map(e => e.id),
    ).toEqual(['b1'])
    expect(reapplied.model.report.keptEdits).toEqual([])
    expect(names(reapplied)).toContain(Report.SaveSection.name)
  })

  test('a discarded kept edit is gone', () => {
    const stale = send(
      edited().model,
      Report.Message.StaleSaveSection({ sectionId: 'background' }),
    )
    const reloaded = send(
      stale.model,
      Report.Message.SucceededReloadWorkingCopy({
        contents: {},
        saveCounter: 2,
        savedAt: SAVED_AT,
        copy: {
          baseDraft: 0,
          latestDraft: 0,
          behind: false,
          hasUnsharedChanges: false,
        },
      }),
      Report.Message.ClickedDiscardEdit({ sectionId: 'background' }),
    )
    expect(reloaded.model.report.keptEdits).toEqual([])
  })

  test('offline holds saves back, and coming online sends them in order', () => {
    const offline = send(
      investigation(),
      Report.Message.ChangedConnection({ isOnline: false }),
    )
    const added = send(
      offline.model,
      Report.Message.ClickedAddEntry({ target }),
      Report.Message.GeneratedEntryId({ target, entryId: 'b1' }),
    )
    expect(names(added)).not.toContain(Report.SaveSection.name)
    expect(added.model.report.dirtySectionIds).toEqual(['background'])
    const online = send(
      added.model,
      Report.Message.ChangedConnection({ isOnline: true }),
    )
    expect(names(online)).toEqual([Report.SaveSection.name])
  })

  test('an unavailable server shows a failure, and the tick tries again', () => {
    const failed = send(
      edited().model,
      Report.Message.FailedSaveSection({
        sectionId: 'background',
        failure: Failure.Unavailable(),
      }),
    )
    expect(failed.model.report.save._tag).toBe('Failed')
    const retried = send(failed.model, Report.Message.TickedSaveRetry())
    expect(names(retried)).toEqual([Report.SaveSection.name])
  })

  test('a save that succeeds records the time and the counter', () => {
    const saved = send(
      edited().model,
      Report.Message.SucceededSaveSection({
        sectionId: 'background',
        saveCounter: 1,
        savedAt: SAVED_AT,
      }),
    )
    expect(saved.model.report.maybeSavedAt).toEqual(Option.some(SAVED_AT))
    expect(saved.model.report.saveCounter).toBe(1)
    expect(Report.hasUnsavedEdits(saved.model.report)).toBe(false)
  })

  test('the page warns only while edits are not saved', () => {
    expect(Report.hasUnsavedEdits(investigation().report)).toBe(false)
    expect(Report.hasUnsavedEdits(edited().model.report)).toBe(true)
  })
})

describe('starting again from the latest shared draft', () => {
  test('it asks first, then replaces the working copy and loads it again', () => {
    const asked = send(investigation(), Report.Message.ClickedReplaceCopy())
    expect(Option.isSome(asked.model.report.maybeConfirmation)).toBe(true)
    expect(names(asked)).not.toContain(Report.ReplaceWorkingCopy.name)
    const confirmed = send(asked.model, Report.Message.ConfirmedReplaceCopy())
    expect(names(confirmed)).toEqual([Report.ReplaceWorkingCopy.name])
    const replaced = send(
      confirmed.model,
      Report.Message.SucceededReplaceCopy(),
    )
    expect(names(replaced)).toEqual([Report.LoadReport.name])
    expect(replaced.model.report.contents).toEqual({})
  })

  test('cancelling replaces nothing', () => {
    const asked = send(investigation(), Report.Message.ClickedReplaceCopy())
    const cancelled = send(asked.model, Report.Message.CancelledConfirmation())
    expect(Option.isNone(cancelled.model.report.maybeConfirmation)).toBe(true)
    expect(names(cancelled)).toEqual([])
  })
})
