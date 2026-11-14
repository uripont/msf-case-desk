import { Option } from 'effect'
import { Command, click, expect, given, role, scene, text } from 'foldkit/scene'
import { expect as check, describe, test } from 'vitest'

import type { DownloadSet } from '@case-desk/domain'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { NOW } from './publish.fixtures'
import { authorModel } from './quoroom.fixtures'
import * as Downloads from './quoroom/downloads'
import { Failure } from './quoroom/failure'
import { REPORT_ID } from './report.fixtures'
import { view } from './view'

// NOTE: With invented data: the downloads screen lists every draft
// and revision in the views the server allows, and asks for one PDF, the
// approval record, or all of them as one zip, one at a time.

const SCOPE = { reportId: REPORT_ID, generation: 1 }

const version = (
  kind: 'draft' | 'revision',
  number: number,
  view: 'original' | 'redacted',
) => ({
  kind,
  number,
  label: `${kind === 'draft' ? 'Draft' : 'Revision'} ${number}`,
  view,
  closing: false,
  at: NOW,
})

const DOWNLOADS: typeof DownloadSet.Type = {
  reportName: 'Intake report',
  caseReference: 'IL-2026-0042',
  versions: [
    version('draft', 1, 'original'),
    version('draft', 1, 'redacted'),
    version('revision', 1, 'original'),
    version('revision', 1, 'redacted'),
  ],
  approvalRecord: true,
}

const screen = [
  clickedLinkTo(`/r/${REPORT_ID}/downloads`),
  Message.GotDownloadsMessage({
    message: Downloads.Message.SucceededLoadDownloads({
      scope: SCOPE,
      downloads: DOWNLOADS,
    }),
  }),
].reduce((model, message) => update(model, message).model, authorModel)

describe('the downloads screen', () => {
  test('asks the server for the versions when it is opened', () => {
    const opened = update(
      authorModel,
      clickedLinkTo(`/r/${REPORT_ID}/downloads`),
    )
    check(opened.commands?.map(command => command.name)).toContain(
      'LoadDownloads',
    )
  })

  test('lists each version with a button for each view the server allows', () => {
    scene(
      { update, view },
      given(screen),
      expect(role('heading', { name: 'Downloads' })).toExist(),
      expect(
        role('button', { name: 'Download PDF of Draft 1, original' }),
      ).toExist(),
      expect(
        role('button', { name: 'Download PDF of Draft 1, redacted' }),
      ).toExist(),
      expect(
        role('button', { name: 'Download PDF of Revision 1, original' }),
      ).toExist(),
      expect(
        role('button', { name: 'Download PDF of Revision 1, redacted' }),
      ).toExist(),
      expect(
        role('button', { name: 'Download the approval record PDF' }),
      ).toExist(),
      expect(
        role('button', {
          name: 'Download all drafts, revisions and approval records as one zip',
        }),
      ).toExist(),
    )
  })

  test('without a decided round there is no approval record to download', () => {
    const none = update(
      screen,
      Message.GotDownloadsMessage({
        message: Downloads.Message.SucceededLoadDownloads({
          scope: SCOPE,
          downloads: { ...DOWNLOADS, approvalRecord: false },
        }),
      }),
    ).model
    scene(
      { update, view },
      given(none),
      expect(
        role('button', { name: 'Download the approval record PDF' }),
      ).toBeAbsent(),
    )
  })

  test('one version asks for one file and blocks the others until it is made', () => {
    scene(
      { update, view },
      given(screen),
      click(role('button', { name: 'Download PDF of Revision 1, redacted' })),
      Command.expectHas(Downloads.MakeFile),
      expect(text('Making the file. This can take a few seconds.')).toExist(),
      expect(
        role('button', { name: 'Download PDF of Draft 1, original' }),
      ).toBeDisabled(),
      Command.resolve(
        Downloads.MakeFile,
        Downloads.Message.SucceededMakeFile({ scope: SCOPE }),
      ),
      expect(
        role('button', { name: 'Download PDF of Draft 1, original' }),
      ).toBeEnabled(),
    )
  })

  test('download all asks for every version and the approval record', () => {
    const asked = update(
      screen,
      Message.GotDownloadsMessage({
        message: Downloads.Message.ClickedMake({
          target: Downloads.MakeTarget.All(),
        }),
      }),
    )
    const [command] = asked.commands ?? []
    check(command?.name).toBe('MakeFile')
    check(command?.args).toMatchObject({ target: { _tag: 'All' } })
    check(asked.model.downloads.maybeBusy).toEqual(Option.some('all'))
  })

  test('a failure is shown and the buttons come back; an answer for another report is dropped', () => {
    const busy = update(
      screen,
      Message.GotDownloadsMessage({
        message: Downloads.Message.ClickedMake({
          target: Downloads.MakeTarget.Approval(),
        }),
      }),
    ).model
    const late = update(
      busy,
      Message.GotDownloadsMessage({
        message: Downloads.Message.SucceededMakeFile({
          scope: { reportId: 'other', generation: 1 },
        }),
      }),
    ).model
    check(late.downloads.maybeBusy).toEqual(Option.some('approval'))
    const failed = update(
      busy,
      Message.GotDownloadsMessage({
        message: Downloads.Message.FailedMakeFile({
          scope: SCOPE,
          failure: Failure.Unavailable(),
        }),
      }),
    ).model
    check(failed.downloads.maybeBusy).toEqual(Option.none())
    check(Option.isSome(failed.downloads.maybeNotice)).toBe(true)
  })
})
