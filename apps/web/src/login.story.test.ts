import { Redacted } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import {
  SYNTHETIC_ME,
  SYNTHETIC_USER,
  configuredModel,
  openedAt,
  signedInModel,
  signedOutModel,
} from './fixtures'
import {
  CheckSession,
  Message,
  ReplaceUrl,
  SignIn,
  SignOut,
  update,
} from './main'
import { Failure } from './quoroom/failure'

const password = Redacted.make('synthetic-password')

describe('sign-in', () => {
  test('starting the app checks for a session first', () => {
    const started = openedAt('/')
    expect(started.model.session._tag).toBe('Checking')
    expect(started.commands?.map(command => command.name)).toContain(
      CheckSession.name,
    )
  })

  test('an existing session goes straight to the home screen', () => {
    story(
      update,
      given(configuredModel),
      message(Message.SucceededCheckSession({ me: SYNTHETIC_ME })),
      model(next => {
        expect(next.session).toEqual({ _tag: 'SignedIn', me: SYNTHETIC_ME })
        expect(next.route._tag).toBe('Home')
      }),
    )
  })

  test('signing in sends the form and signs in', () => {
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
      Command.resolve(SignIn, Message.SucceededSignIn({ me: SYNTHETIC_ME })),
      model(next => {
        expect(next.session._tag).toBe('SignedIn')
        expect(Redacted.value(next.loginForm.password)).toBe('')
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
        Message.FailedSignIn({ failure: Failure.InvalidCredentials() }),
      ),
      model(next => {
        expect(next.loginForm.submission).toEqual({
          _tag: 'Rejected',
          failure: Failure.InvalidCredentials(),
        })
        expect(Redacted.value(next.loginForm.password)).toBe('')
      }),
    )
  })

  test('too many attempts says how long to wait', () => {
    story(
      update,
      given(signedOutModel),
      message(Message.SubmittedLogin()),
      Command.resolve(
        SignIn,
        Message.FailedSignIn({
          failure: Failure.Throttled({ retryAfterSeconds: 60 }),
        }),
      ),
      model(next => {
        expect(next.loginForm.submission).toEqual({
          _tag: 'Rejected',
          failure: Failure.Throttled({ retryAfterSeconds: 60 }),
        })
      }),
    )
  })

  test('signing out returns to the sign-in', () => {
    story(
      update,
      given(signedInModel),
      message(Message.ClickedSignOut()),
      model(next => {
        expect(next.session._tag).toBe('SignedOut')
        expect(next.route._tag).toBe('Home')
      }),
      Command.resolve(SignOut, Message.CompletedSignOut()),
      Command.resolve(ReplaceUrl, Message.CompletedReplaceUrl()),
    )
  })
})
