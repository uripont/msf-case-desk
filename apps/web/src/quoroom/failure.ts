import { Match, Option, Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

// NOTE: What a screen can say about a refused or failed request. The
// messages of the domain's coded problems are fixed text that never repeats
// anything the person typed, so they are safe to show.
export const Failure = defineTaggedUnion({
  SignInRequired: {},
  NotAllowed: {},
  Refused: { message: Schema.String },
  LinkInvalid: {},
  InvalidCredentials: {},
  Throttled: { retryAfterSeconds: Schema.Int },
  Unavailable: {},
})
export type Failure = typeof Failure.Type

const ErrorShape = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('Unauthorised') }),
  Schema.Struct({ _tag: Schema.Literal('NotFound') }),
  Schema.Struct({ _tag: Schema.Literal('NotPermitted') }),
  Schema.Struct({ _tag: Schema.Literal('Conflict'), reason: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal('Validation'),
    problems: Schema.Array(Schema.Struct({ message: Schema.String })),
  }),
  Schema.Struct({ _tag: Schema.Literal('LinkInvalid') }),
  Schema.Struct({ _tag: Schema.Literal('InvalidCredentials') }),
  Schema.Struct({
    _tag: Schema.Literal('Throttled'),
    retryAfterSeconds: Schema.Int,
  }),
])

const decodeErrorShape = Schema.decodeUnknownOption(ErrorShape)

const conflictText = (reason: string): string =>
  Match.value(reason).pipe(
    Match.when('already_exists', () => 'That already exists.'),
    Match.when('duplicate', () => 'That is already in the list.'),
    Match.when(
      'stale_save',
      () =>
        'This report was saved from another tab or window. Reload this page to continue.',
    ),
    Match.when(
      'changed_meanwhile',
      () => 'Someone changed this meanwhile. Reload and try again.',
    ),
    Match.orElse(
      () => 'That could not be saved as it is. Reload and try again.',
    ),
  )

const StaleShape = Schema.Struct({
  _tag: Schema.Literal('Conflict'),
  reason: Schema.Literal('stale_save'),
})

// NOTE: A save refused because the working copy's save counter has moved on:
// the same author saved from another tab. It is told apart from other
// refusals because the screen keeps the unsaved edit and offers a reload.
export const isStaleSave = (error: unknown): boolean =>
  Schema.is(StaleShape)(error)

export const failureOf = (error: unknown): Failure =>
  Option.match(decodeErrorShape(error), {
    onNone: () => Failure.Unavailable(),
    onSome: shape =>
      Match.value(shape).pipe(
        Match.tagsExhaustive({
          Unauthorised: () => Failure.SignInRequired(),
          NotFound: () => Failure.NotAllowed(),
          NotPermitted: () => Failure.NotAllowed(),
          Conflict: ({ reason }) =>
            Failure.Refused({ message: conflictText(reason) }),
          Validation: ({ problems }) =>
            Failure.Refused({
              message:
                problems[0]?.message ?? 'Check what you typed and try again.',
            }),
          LinkInvalid: () => Failure.LinkInvalid(),
          InvalidCredentials: () => Failure.InvalidCredentials(),
          Throttled: ({ retryAfterSeconds }) =>
            Failure.Throttled({ retryAfterSeconds }),
        }),
      ),
  })

export const waitText = (seconds: number): string =>
  seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`

export const failureText = (failure: Failure): string =>
  Failure.match(failure, {
    SignInRequired: () => 'Your session has ended. Sign in again.',
    NotAllowed: () => 'You are not allowed to do that.',
    Refused: ({ message }) => message,
    LinkInvalid: () =>
      'This link has been used, has expired or is not valid. Ask for a new one.',
    InvalidCredentials: () =>
      'That e-mail and password do not match an account.',
    Throttled: ({ retryAfterSeconds }) =>
      `Too many attempts. Wait ${waitText(retryAfterSeconds)} before trying again.`,
    Unavailable: () => 'The server did not answer. Try again in a moment.',
  })
