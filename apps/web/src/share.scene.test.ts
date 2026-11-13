import { Option } from 'effect'
import { expect, given, role, scene, text } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { INTAKE_TEMPLATE } from '@case-desk/domain'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { authorModel } from './quoroom.fixtures'
import * as Share from './quoroom/share'
import { REPORT_ID, detailOf } from './report.fixtures'
import { view } from './view'

// NOTE: Stage 4 review: a comparison whose list of automatic changes was
// capped says how many more there were.

const comparisonScreen = (automaticOmitted: number | undefined) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}/share`),
    Message.GotShareMessage({
      message: Share.Message.SucceededLoadShare({
        scope: { reportId: REPORT_ID, generation: 1 },
        loaded: {
          detail: detailOf(INTAKE_TEMPLATE),
          template: INTAKE_TEMPLATE,
          people: [],
          copy: {
            saveCounter: 4,
            baseDraft: 0,
            latestDraft: 1,
            behind: true,
            hasUnsharedChanges: true,
            sectionIds: [],
          },
          maybeComparison: Option.some({
            baseDraft: 0,
            theirsDraft: 1,
            conflicts: [],
            automatic: [{ key: 'a', side: 'ours', change: 'changed' }],
            ...(automaticOmitted === undefined ? {} : { automaticOmitted }),
            problems: [],
          }),
        },
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

describe('the comparison of a share', () => {
  test('a capped list of automatic changes says how many more there were', () => {
    scene(
      { update, view },
      given(comparisonScreen(7)),
      expect(role('heading', { name: 'Taken automatically' })).toExist(),
      expect(text('and 7 more changes')).toExist(),
    )
  })

  test('one more change is said in the singular', () => {
    scene(
      { update, view },
      given(comparisonScreen(1)),
      expect(text('and 1 more change')).toExist(),
    )
  })

  test('a list that was not capped says nothing about more', () => {
    scene(
      { update, view },
      given(comparisonScreen(undefined)),
      expect(text(/more change/)).toBeAbsent(),
    )
  })
})
