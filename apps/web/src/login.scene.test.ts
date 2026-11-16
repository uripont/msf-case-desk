import { Command, click, expect, given, role, scene, type } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { SYNTHETIC_ME, SYNTHETIC_USER, signedOutModel } from './fixtures'
import { Message, SignIn, update } from './main'
import { Failure } from './quoroom/failure'
import * as Inbox from './quoroom/inbox'
import * as Notifications from './quoroom/notifications'
import { view } from './view'

describe('sign-in scene', () => {
  test('a signed-out visitor sees only the sign-in form', () => {
    scene(
      { update, view },
      given(signedOutModel),
      expect(role('heading', { name: 'Sign in' })).toExist(),
      expect(role('textbox', { name: 'E-mail' })).toExist(),
      expect(role('navigation', { name: 'Pages' })).toBeAbsent(),
    )
  })

  test('signing in shows the home screen and the account', () => {
    scene(
      { update, view },
      given(signedOutModel),
      type(role('textbox', { name: 'E-mail' }), SYNTHETIC_USER.email),
      click(role('button', { name: 'Sign in' })),
      Command.resolve(SignIn, Message.SucceededSignIn({ me: SYNTHETIC_ME })),
      Command.resolve(
        Inbox.LoadInbox,
        Inbox.Message.SucceededLoadInbox({
          scope: { reportId: '', generation: 2 },
          page: { items: [] },
          zone: 'Europe/Madrid',
          nowMs: 0,
        }),
      ),
      Command.resolve(
        Notifications.LoadNotifications,
        Notifications.Message.SucceededLoadNotifications({
          scope: { reportId: '', generation: 2 },
          page: { items: [], unread: 0 },
          zone: 'Europe/Madrid',
          nowMs: 0,
        }),
      ),
      expect(role('heading', { name: 'Welcome to Quoroom' })).toExist(),
      expect(role('button', { name: 'Sign out' })).toExist(),
    )
  })

  test('too many attempts shows the wait', () => {
    scene(
      { update, view },
      given(signedOutModel),
      click(role('button', { name: 'Sign in' })),
      Command.resolve(
        SignIn,
        Message.FailedSignIn({
          failure: Failure.Throttled({ retryAfterSeconds: 120 }),
        }),
      ),
      expect(role('alert')).toHaveText(
        'Too many attempts. Wait 2 minutes before trying again.',
      ),
    )
  })

  test('a wrong password is explained', () => {
    scene(
      { update, view },
      given(signedOutModel),
      click(role('button', { name: 'Sign in' })),
      Command.resolve(
        SignIn,
        Message.FailedSignIn({ failure: Failure.InvalidCredentials() }),
      ),
      expect(role('alert')).toHaveText(
        'That e-mail and password do not match an account.',
      ),
    )
  })
})
