import { Option } from 'effect'
import {
  click,
  expect,
  given,
  role,
  scene,
  selector,
  text,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import {
  CHOICES,
  LINK,
  ROUND,
  SCOPE,
  loaded,
  revision,
} from './publish.fixtures'
import { authorModel } from './quoroom.fixtures'
import * as Publish from './quoroom/publish'
import { REPORT_ID } from './report.fixtures'
import { view } from './view'

const publishScreen = (options: Parameters<typeof loaded>[0] = {}) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}/publish`),
    Message.GotPublishMessage({
      message: Publish.Message.SucceededLoadPublish({
        scope: SCOPE,
        loaded: loaded(options),
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

// NOTE: Stage 6a: the publishing dialog and the round display, with invented
// people. The screen is `/r/:id/publish`.

const REVIEWERS = [
  { accountId: 'reviewer-1', name: 'Reviewer One', roleName: 'Committee' },
  { accountId: 'reviewer-2', name: 'Reviewer Two', roleName: 'Committee' },
]

describe('the publishing dialog', () => {
  test('shows the next revision, the deadline fields and, for each role, its rule and its view', () => {
    scene(
      { update, view },
      given(publishScreen()),
      expect(role('heading', { name: 'Publish Revision 1' })).toExist(),
      expect(
        text('Approval rule: every person chosen must approve.'),
      ).toExist(),
      expect(
        text('Reads only the redacted text, with the names replaced.'),
      ).toExist(),
      expect(role('checkbox', { name: /Ethics committee/ })).toExist(),
      expect(role('checkbox', { name: /Reviewer Three/ })).toExist(),
      expect(selector('#publish-date')).toExist(),
      expect(selector('#publish-zone')).toExist(),
    )
  })

  test('a choice that cannot meet the rule is refused in words, before anything is sent', () => {
    scene(
      { update, view },
      given(publishScreen()),
      click(role('button', { name: 'Publish Revision 1' })),
      expect(text(/votes but has no one chosen/)).toExist(),
    )
  })

  test('a person of the unit is chosen by name, and the count follows', () => {
    scene(
      { update, view },
      given(publishScreen()),
      expect(text('0 people chosen.')).toExist(),
      click(role('checkbox', { name: /Ethics committee/ })),
      expect(text('2 people chosen.')).toExist(),
      click(role('checkbox', { name: /Reviewer Three/ })),
      expect(text('3 people chosen.')).toExist(),
    )
  })

  test('a draft whose redacted version was not confirmed explains why and links to it', () => {
    scene(
      { update, view },
      given(
        publishScreen({
          choices: { ...CHOICES, redactionConfirmed: false },
        }),
      ),
      click(role('checkbox', { name: /Ethics committee/ })),
      expect(selector('[data-preview-needed="true"]')).toExist(),
      expect(text(/has to be checked first/)).toExist(),
      expect(role('link', { name: 'Read Draft 2' })).toExist(),
    )
  })

  test('changes that are not shared offer share and publish', () => {
    scene(
      { update, view },
      given(
        publishScreen({ choices: { ...CHOICES, hasUnsharedChanges: true } }),
      ),
      expect(text(/not shared/)).toExist(),
      expect(
        role('link', { name: 'Share and publish my working copy' }),
      ).toExist(),
    )
  })
})

describe('the round display', () => {
  const rounds = [revision(1, 'superseded', 2), revision(2, 'open')]

  test('shows the open round with its deadline in its own time zone and a countdown, and each revision with its status', () => {
    scene(
      { update, view },
      given(publishScreen({ revisions: rounds, round: ROUND })),
      expect(selector('[data-current-round="2"]')).toExist(),
      expect(
        text(
          /Revision 2 is open\. Due 16 Nov, 14:00 Madrid time\. 3d 4h left\./,
        ),
      ).toExist(),
      expect(
        selector('[data-revision="1"][data-status="superseded"]'),
      ).toExist(),
      expect(text('Superseded by Revision 2')).toExist(),
      expect(selector('[data-revision="2"][data-status="open"]')).toExist(),
      expect(
        text('Publishing it replaces the open round.', { exact: false }),
      ).toExist(),
      expect(role('heading', { name: 'Publish Revision 3' })).toExist(),
    )
  })

  test('with no round open it says so', () => {
    scene(
      { update, view },
      given(publishScreen({ revisions: [revision(1, 'decided')] })),
      expect(text('No round is open.')).toExist(),
      expect(text('Decided, the approval rule was met')).toExist(),
    )
  })
})

describe('the WhatsApp requests', () => {
  test('one link per reviewer with a number and consent, holding the deadline and no report content', () => {
    scene(
      { update, view },
      given(
        publishScreen({
          revisions: [revision(2, 'open')],
          round: ROUND,
          whatsapp: [
            {
              ...REVIEWERS[0]!,
              maybeLink: Option.some(LINK),
              isOpened: false,
            },
            {
              ...REVIEWERS[1]!,
              maybeLink: Option.none(),
              isOpened: false,
            },
          ],
        }),
      ),
      expect(
        role('heading', { name: 'Send the first request on WhatsApp' }),
      ).toExist(),
      expect(
        role('link', { name: 'Send on WhatsApp to Reviewer One' }),
      ).toExist(),
      expect(selector('a[href^="https://wa.me/34600000001?text="]')).toExist(),
      expect(
        text('No WhatsApp number or consent. They are told in Quoroom only.'),
      ).toExist(),
    )
  })
})
