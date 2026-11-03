import { Redacted } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import { SEED_CASES } from '@case-desk/domain'

import { SYNTHETIC_USER, loadedModel, signedOutModel } from './fixtures'
import {
  CheckSession,
  LoadDesk,
  Message,
  SignIn,
  SignOut,
  init,
  initialModel,
  update,
} from './main'

const password = Redacted.make('synthetic-password')

describe('sign-in', () => {
  test('starting the app checks for a session first', () => {
    const started = init()
    expect(started.model.session._tag).toBe('Checking')
    expect(started.commands?.map(command => command.name)).toContain(
      CheckSession.name,
    )
  })

  test('an existing session goes straight to the desk', () => {
    story(
      update,
      given(initialModel),
      message(Message.SucceededCheckSession({ user: SYNTHETIC_USER })),
      model(next => {
        expect(next.session).toEqual({ _tag: 'SignedIn', user: SYNTHETIC_USER })
      }),
      Command.expectHas(LoadDesk()),
      Command.resolve(
        LoadDesk,
        Message.SucceededLoadDesk({ cases: SEED_CASES, ruleSets: [] }),
      ),
    )
  })

  test('signing in sends the form, then loads the desk', () => {
    story(
      update,
      given(signedOutModel),
      message(Message.UpdatedLoginEmail({ value: SYNTHETIC_USER.email })),
      message(Message.UpdatedLoginPassword({ value: password })),
      message(Message.SubmittedLogin()),
      model(next => {
        expect(next.loginForm.submission._tag).toBe('Submitting')
      }),
      Command.expectHas(SignIn({ email: SYNTHETIC_USER.email, password })),
      Command.resolve(
        SignIn,
        Message.SucceededSignIn({ user: SYNTHETIC_USER }),
      ),
      model(next => {
        expect(next.session._tag).toBe('SignedIn')
        expect(Redacted.value(next.loginForm.password)).toBe('')
      }),
      Command.resolve(
        LoadDesk,
        Message.SucceededLoadDesk({ cases: SEED_CASES, ruleSets: [] }),
      ),
      model(next => {
        expect(next.deskLoad._tag).toBe('Loaded')
      }),
    )
  })

  test('a rejected sign-in says so and clears the password', () => {
    story(
      update,
      given(signedOutModel),
      message(Message.UpdatedLoginPassword({ value: password })),
      message(Message.SubmittedLogin()),
      Command.resolve(
        SignIn,
        Message.FailedSignIn({ rejection: 'InvalidCredentials' }),
      ),
      model(next => {
        expect(next.loginForm.submission).toEqual({
          _tag: 'Rejected',
          rejection: 'InvalidCredentials',
        })
        expect(Redacted.value(next.loginForm.password)).toBe('')
      }),
    )
  })

  test('signing out clears the desk', () => {
    story(
      update,
      given(loadedModel),
      message(Message.ClickedSignOut()),
      model(next => {
        expect(next.session._tag).toBe('SignedOut')
        expect(next.cases).toEqual([])
      }),
      Command.resolve(SignOut, Message.CompletedSignOut()),
    )
  })

  test('an expired session sends the user back to sign in', () => {
    story(
      update,
      given(loadedModel),
      message(Message.FailedLoadDesk({ failure: 'SignInRequired' })),
      model(next => {
        expect(next.session._tag).toBe('SignedOut')
      }),
    )
  })
})
