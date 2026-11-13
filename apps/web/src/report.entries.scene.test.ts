import { Option } from 'effect'
import {
  Command,
  click,
  expect,
  given,
  role,
  scene,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { INVESTIGATION_TEMPLATE } from '@case-desk/domain'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { authorModel } from './quoroom.fixtures'
import * as Report from './quoroom/report'
import {
  REPORT_ID,
  SAVED_AT,
  SCOPE,
  loadedReport,
  staleSaveFacts,
} from './report.fixtures'
import { view } from './view'

const reportMessage = (message: Report.Message) =>
  Message.GotReportMessage({ message })

const model = [
  clickedLinkTo(`/r/${REPORT_ID}`),
  reportMessage(
    Report.Message.SucceededLoadReport({
      scope: SCOPE,
      loaded: loadedReport(INVESTIGATION_TEMPLATE, { state: 'drafting' }),
    }),
  ),
  reportMessage(Report.Message.SelectedSection({ key: 'background' })),
].reduce((current, next) => update(current, next).model, authorModel)

const GROUP = {
  sectionKey: 'background/background-topic',
  steps: [],
  maybeItemId: Option.none(),
}

// NOTE: Adding an entry sets four Commands going: the ID, the save, the focus
// on the new section's heading and the loading of the editor.
const addedWith = (
  saved:
    | ReturnType<typeof Report.Message.SucceededSaveSection>
    | ReturnType<typeof Report.Message.StaleSaveSection>,
) =>
  Command.resolveAll(
    [
      Report.NewEntryId,
      Report.Message.GeneratedEntryId({
        scope: SCOPE,
        target: GROUP,
        entryId: 'b1',
      }),
    ],
    [Report.SaveSection, saved],
    [Report.FocusSectionHeading, Report.Message.CompletedFocusSectionHeading()],
    [Report.LoadEditor, Report.Message.SucceededLoadEditor()],
  )

const savedAs = (saveCounter: number) =>
  Report.Message.SucceededSaveSection({
    scope: SCOPE,
    sectionId: 'background',
    saveCounter,
    savedAt: SAVED_AT,
  })

describe('entries on the screen', () => {
  test('an entry is added, titled and removed after a confirmation', () => {
    scene(
      { update, view },
      given(model),
      expect(text('0 background topic entries.')).toExist(),
      click(role('button', { name: 'Add background topic' })),
      addedWith(savedAs(1)),
      type(
        role('textbox', { name: /Title of this background topic/ }),
        'Security context',
      ),
      Command.resolve(Report.SaveSection, savedAs(2)),
      click(role('button', { name: 'Remove Security context' })),
      Command.resolve(
        Report.FocusConfirmation,
        Report.Message.CompletedFocusConfirmation(),
      ),
      expect(role('heading', { name: 'Remove Security context?' })).toExist(),
      click(role('button', { name: 'Remove' })),
      Command.resolveAll(
        [Report.SaveSection, savedAs(3)],
        [
          Report.FocusSectionHeading,
          Report.Message.CompletedFocusSectionHeading(),
        ],
      ),
      expect(
        role('heading', { name: 'Remove Security context?' }),
      ).toBeAbsent(),
      expect(text('0 background topic entries.')).toExist(),
    )
  })
})

describe('the save state is shown', () => {
  test('saved at a time, with the counter', () => {
    scene(
      { update, view },
      given(model),
      click(role('button', { name: 'Add background topic' })),
      addedWith(savedAs(1)),
      expect(text(/Saved at \d\d:\d\d/)).toExist(),
      expect(text('Save 1')).toExist(),
    )
  })

  test('the other-tab state keeps the edit and offers a reload', () => {
    scene(
      { update, view },
      given(model),
      click(role('button', { name: 'Add background topic' })),
      addedWith(
        Report.Message.StaleSaveSection({
          scope: SCOPE,
          sectionId: 'background',
          sent: { values: {}, sections: {} },
        }),
      ),
      Command.resolve(
        Report.ReadStaleSection,
        Report.Message.SucceededReadStaleSection(staleSaveFacts('background')),
      ),
      expect(
        role('heading', { name: 'This working copy changed in another tab' }),
      ).toExist(),
      expect(role('button', { name: 'Reload the saved version' })).toExist(),
      expect(
        role('textbox', { name: /Title of this background topic/ }),
      ).toExist(),
    )
  })

  test('offline is said plainly', () => {
    scene(
      { update, view },
      given(
        update(
          model,
          reportMessage(Report.Message.ChangedConnection({ isOnline: false })),
        ).model,
      ),
      expect(text('Offline')).toExist(),
    )
  })
})
