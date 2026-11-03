import { Command, click, expect, given, role, scene, type } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { SEED_CASES } from '@case-desk/domain'

import { SYNTHETIC_USER, signedOutModel } from './fixtures'
import { LoadDesk, Message, SignIn, update } from './main'
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
      Command.resolve(
        SignIn,
        Message.SucceededSignIn({ user: SYNTHETIC_USER }),
      ),
      Command.resolve(
        LoadDesk,
        Message.SucceededLoadDesk({ cases: SEED_CASES, ruleSets: [] }),
      ),
      expect(role('region', { name: 'Urgent' })).toExist(),
      expect(role('button', { name: 'Sign out' })).toExist(),
    )
  })

  test('a wrong password is explained', () => {
    scene(
      { update, view },
      given(signedOutModel),
      click(role('button', { name: 'Sign in' })),
      Command.resolve(
        SignIn,
        Message.FailedSignIn({ rejection: 'InvalidCredentials' }),
      ),
      expect(role('alert')).toHaveText(
        'That e-mail and password do not match an account.',
      ),
    )
  })
})
