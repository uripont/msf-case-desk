import { Command, click, expect, given, role, scene, type } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { SEED_CASES } from '@case-desk/domain'

import { SYNTHETIC_ME, SYNTHETIC_USER, signedOutModel } from './fixtures'
import { LoadDesk, Message, SignIn, update } from './main'
import { Failure } from './quoroom/failure'
import { view } from './view'

describe('sign-in scene', () => {
  test('a signed-out visitor sees only the sign-in form', () => {
    scene(
      { update, view },
      given(signedOutModel),
      expect(role('heading', { name: 'Sign in' })).toExist(),
      expect(role('textbox', { name: 'E-mail' })).toExist(),
      expect(role('region', { name: 'Urgent' })).toBeAbsent(),
      expect(role('navigation', { name: 'Operational centre' })).toBeAbsent(),
    )
  })

  test('signing in shows the desk and the account', () => {
    scene(
      { update, view },
      given(signedOutModel),
      type(role('textbox', { name: 'E-mail' }), SYNTHETIC_USER.email),
      click(role('button', { name: 'Sign in' })),
      Command.resolve(SignIn, Message.SucceededSignIn({ me: SYNTHETIC_ME })),
      Command.resolve(
        LoadDesk,
        Message.SucceededLoadDesk({ cases: SEED_CASES, ruleSets: [] }),
      ),
      expect(role('region', { name: 'Urgent' })).toExist(),
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
