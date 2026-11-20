import { type NotificationEntry } from '@quoroom/domain'
import { expect, given, role, scene, selector, text } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { NOW } from './publish.fixtures'
import { authorModel } from './quoroom.fixtures'
import * as Notifications from './quoroom/notifications'
import { view } from './view'

// NOTE: The in-app notifications, with invented reports. The lines
// are the generic words of D12 and D19, never a case title.

type Entry = typeof NotificationEntry.Type

const entry = (
  id: string,
  kind: Entry['kind'],
  overrides: Partial<Entry> = {},
): Entry => ({
  id,
  kind,
  at: NOW - 3_600_000,
  reportId: 'report-1',
  revision: 2,
  ...overrides,
})

const notificationsScreen = (
  items: ReadonlyArray<Entry>,
  unread: number,
) =>
  [
    clickedLinkTo('/notifications'),
    Message.GotNotificationsMessage({
      message: Notifications.Message.SucceededLoadNotifications({
        scope: { reportId: '', generation: 2 },
        page: { items, unread },
        zone: 'Europe/Madrid',
        nowMs: NOW,
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

describe('the notifications screen', () => {
  test('shows each line with its link to the right screen and marks the unread ones', () => {
    scene(
      { update, view },
      given(
        notificationsScreen(
          [
            entry('n1', 'review_request', {
              deadline: { at: NOW + 86_400_000, timeZone: 'Europe/Madrid' },
            }),
            entry('n2', 'round_decided', { readAt: NOW - 1000 }),
          ],
          1,
        ),
      ),
      expect(role('heading', { name: 'Notifications' })).toExist(),
      expect(text('Unread. A report is waiting for your review.')).toExist(),
      expect(text('Due ', { exact: false })).toExist(),
      expect(text('The review round is decided.')).toExist(),
      expect(selector('[data-notification="n1"][data-unread="true"]')).toExist(),
      expect(selector('[data-notification="n2"][data-unread="false"]')).toExist(),
      expect(
        role('link', { name: 'Open: A report is waiting for your review.' }),
      ).toHaveAttr('href', '/r/report-1/rev/2'),
      expect(role('link', { name: 'Open: The review round is decided.' })).toHaveAttr(
        'href',
        '/r/report-1',
      ),
      expect(text('1 not read yet.')).toExist(),
    )
  })

  test('Home says notifications stay in the app, as plain text', () => {
    scene(
      { update, view },
      given(notificationsScreen([entry('n1', 'review_request')], 1)),
      expect(text(Notifications.IN_APP_ONLY)).toExist(),
      expect(
        text(
          'Notifications appear here, in Quoroom. Quoroom sends no e-mail or other messages.',
        ),
      ).toExist(),
      expect(role('textbox')).toBeAbsent(),
    )
  })

  test('the Home tab shows how many are not read', () => {
    scene(
      { update, view },
      given(notificationsScreen([entry('n1', 'review_request')], 3)),
      expect(role('link', { name: 'Home (3)' })).toHaveAttr('href', '/'),
    )
  })

  test('with none unread the Home tab has no number and the screen says so', () => {
    scene(
      { update, view },
      given(
        notificationsScreen([entry('n1', 'round_decided', { readAt: NOW })], 0),
      ),
      expect(role('link', { name: 'Home' })).toExist(),
      expect(text('You have read everything.')).toExist(),
    )
  })

  test('mark all shows while any are unread, even when none of the loaded ones are', () => {
    scene(
      { update, view },
      given(
        notificationsScreen([entry('n1', 'round_decided', { readAt: NOW })], 2),
      ),
      expect(
        role('button', { name: 'Mark all notifications as read' }),
      ).toExist(),
    )
  })

  test('mark all is hidden when nothing is unread', () => {
    scene(
      { update, view },
      given(
        notificationsScreen([entry('n1', 'round_decided', { readAt: NOW })], 0),
      ),
      expect(
        role('button', { name: 'Mark all notifications as read' }),
      ).toBeAbsent(),
    )
  })

  test('an empty list says what will appear', () => {
    scene(
      { update, view },
      given(notificationsScreen([], 0)),
      expect(selector('[data-notification]')).toBeAbsent(),
      expect(text('Nothing yet.', { exact: false })).toExist(),
    )
  })
})
