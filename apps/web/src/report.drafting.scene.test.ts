import { expect, given, role, scene, text } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { INTAKE_TEMPLATE } from '@case-desk/domain'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { authorModel } from './quoroom.fixtures'
import * as Report from './quoroom/report'
import {
  REPORT_ID,
  SAVED_AT,
  SCOPE,
  SECOND_AUTHOR,
  loadedReport,
} from './report.fixtures'
import { view } from './view'

const modelWith = (drafting: Report.LoadedReport['drafting']) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}`),
    Message.GotReportMessage({
      message: Report.Message.SucceededLoadReport({
        scope: SCOPE,
        loaded: {
          ...loadedReport(INTAKE_TEMPLATE, {
            permissions: ['edit', 'share', 'manage_people'],
          }),
          drafting,
        },
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

describe('who is drafting', () => {
  test('another author with a working copy is named with the draft and the time', () => {
    scene(
      { update, view },
      given(
        modelWith([
          {
            accountId: SECOND_AUTHOR.accountId,
            name: SECOND_AUTHOR.name,
            baseDraft: 2,
            lastSavedAt: SAVED_AT,
            hasUnsharedChanges: true,
          },
        ]),
      ),
      expect(role('heading', { name: 'Who is drafting' })).toExist(),
      expect(
        text(/Second Author is working from Draft 2, last saved \d\d:\d\d\./),
      ).toExist(),
    )
  })

  test('with nobody else drafting the panel says so, and the share link is offered', () => {
    scene(
      { update, view },
      given(modelWith([])),
      expect(
        text('No other author has a working copy of this report.'),
      ).toExist(),
      expect(role('link', { name: 'Share as Draft 1' })).toExist(),
    )
  })
})
