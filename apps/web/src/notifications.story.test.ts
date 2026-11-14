import { describe, expect, test } from 'vitest'

import { clickedLinkTo } from './fixtures'
import { Message, subscriptions, update } from './main'
import { NOW } from './publish.fixtures'
import { authorModel } from './quoroom.fixtures'
import * as Notifications from './quoroom/notifications'

// NOTE: Stage 7: marking read, the unread count and its poll.

const SCOPE = { reportId: '', generation: 1 }

const got = (message: Notifications.Message) =>
  Message.GotNotificationsMessage({ message })

const item = (id: string, readAt?: number) => ({
  id,
  kind: 'review_request' as const,
  at: NOW,
  reportId: 'report-1',
  revision: 1,
  ...(readAt === undefined ? {} : { readAt }),
})

const screen = () =>
  [
    clickedLinkTo('/notifications'),
    got(
      Notifications.Message.SucceededLoadNotifications({
        scope: SCOPE,
        page: { items: [item('a'), item('b'), item('c', NOW)], unread: 2 },
        zone: 'UTC',
        nowMs: NOW,
      }),
    ),
  ].reduce((model, message) => update(model, message).model, authorModel)

const names = (step: ReturnType<typeof update>) =>
  (step.commands ?? []).map(command => command.name)

describe('notifications', () => {
  test('entering the screen loads the page', () => {
    const step = update(authorModel, clickedLinkTo('/notifications'))
    expect(names(step)).toContain('LoadNotifications')
  })

  test('marking one read sends that id once and ignores a second click meanwhile', () => {
    const first = update(
      screen(),
      got(Notifications.Message.ClickedMarkRead({ id: 'a' })),
    )
    expect(names(first)).toEqual(['MarkRead'])
    expect(JSON.stringify(first.commands)).toContain('"ids":["a"]')
    const second = update(
      first.model,
      got(Notifications.Message.ClickedMarkRead({ id: 'b' })),
    )
    expect(names(second)).toEqual([])
  })

  test('mark all sends only the ones not read', () => {
    const step = update(
      screen(),
      got(Notifications.Message.ClickedMarkAllRead()),
    )
    expect(JSON.stringify(step.commands)).toContain('"ids":["a","b"]')
  })

  test('the answer marks them read and takes the unread count from the server', () => {
    const step = update(
      screen(),
      got(
        Notifications.Message.SucceededMarkRead({
          scope: SCOPE,
          ids: ['a'],
          unread: 1,
          nowMs: NOW + 5,
        }),
      ),
    )
    const { notifications } = step.model
    expect(notifications.unread).toBe(1)
    expect(notifications.items.find(i => i.id === 'a')?.readAt).toBe(NOW + 5)
    expect(notifications.items.find(i => i.id === 'b')?.readAt).toBeUndefined()
  })

  test('an answer for a page that was left is dropped', () => {
    const step = update(
      screen(),
      got(
        Notifications.Message.SucceededMarkRead({
          scope: { reportId: '', generation: 99 },
          ids: ['a'],
          unread: 0,
          nowMs: NOW,
        }),
      ),
    )
    expect(step.model.notifications.unread).toBe(2)
  })

  test('a poll sets the count on any screen, and signing out clears it', () => {
    const polled = update(
      authorModel,
      got(Notifications.Message.PolledUnread({ unread: 4 })),
    ).model
    expect(polled.notifications.unread).toBe(4)
    const out = update(polled, Message.ClickedSignOut()).model
    expect(out.notifications.unread).toBe(0)
  })

  test('the poll runs only while signed in', () => {
    const dependenciesOf = (model: typeof authorModel) =>
      Object.entries(subscriptions)
        .filter(([key]) => key.includes('pollUnread'))
        .map(([, entry]) => JSON.stringify(entry.modelToDependencies(model)))
    const signedOutModel = update(authorModel, Message.ClickedSignOut()).model
    expect(dependenciesOf(authorModel)).toHaveLength(1)
    expect(dependenciesOf(authorModel)).not.toEqual(
      dependenciesOf(signedOutModel),
    )
  })
})
