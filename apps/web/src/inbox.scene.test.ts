import { expect, given, role, scene, selector, text } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { NOW } from './publish.fixtures'
import { authorModel } from './quoroom.fixtures'
import * as Inbox from './quoroom/inbox'
import { view } from './view'

// NOTE: Stage 6b: the reviewer's inbox, with invented reports. Deadlines are
// told in the reader's own time zone and name the zone they were set in.

const item = (
  revision: number,
  status: 'open' | 'decided' | 'superseded',
  overrides: Record<string, unknown> = {},
) => ({
  reportId: `report-${revision}`,
  revision,
  label: `Revision ${revision}`,
  caseReference: `SYN-${revision}`,
  reportName: 'Synthetic report',
  deadline: { at: NOW + 3 * 86_400_000, timeZone: 'Europe/Madrid' },
  status,
  sentAt: NOW - 86_400_000,
  hasPending: false,
  ...overrides,
})

const inboxScreen = (zone: string, items: ReadonlyArray<ReturnType<typeof item>>) =>
  [
    clickedLinkTo('/inbox'),
    Message.GotInboxMessage({
      message: Inbox.Message.SucceededLoadInbox({
        scope: { reportId: '', generation: 1 },
        page: { items },
        zone,
        nowMs: NOW,
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

describe('the inbox', () => {
  test('lists the rounds waiting for a review before the others', () => {
    scene(
      { update, view },
      given(
        inboxScreen('Europe/Madrid', [
          item(1, 'decided', { myDecision: 'approve' }),
          item(2, 'open', { hasPending: true }),
          item(3, 'superseded'),
        ]),
      ),
      expect(role('heading', { name: 'Inbox' })).toExist(),
      expect(role('heading', { name: 'Waiting for your review' })).toExist(),
      expect(role('heading', { name: 'Other rounds' })).toExist(),
      expect(selector('[data-inbox-item="report-2/2"][data-waiting="true"]')).toExist(),
      expect(selector('[data-inbox-item="report-1/1"][data-status="decided"]')).toExist(),
      expect(text('You have comments that are not sent yet.')).toExist(),
      expect(role('link', { name: 'Read Revision 2 of SYN-2' })).toHaveAttr(
        'href',
        '/r/report-2/rev/2',
      ),
    )
  })

  test('says in which zone a deadline was set when it is not the reader’s own', () => {
    scene(
      { update, view },
      given(inboxScreen('Africa/Nairobi', [item(2, 'open')])),
      expect(text('set in Europe/Madrid', { exact: false })).toExist(),
    )
  })

  test('an empty inbox says so', () => {
    scene(
      { update, view },
      given(inboxScreen('Europe/Madrid', [])),
      expect(role('heading', { name: 'Inbox' })).toExist(),
      expect(selector('[data-inbox-item]')).toBeAbsent(),
    )
  })
})
