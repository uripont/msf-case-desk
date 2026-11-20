import { Effect, Option, Redacted, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { LinkInfo, MeView } from '@quoroom/domain'

import { withPublic } from './api'
import { Failure, failureOf } from './failure'
import {
  alertText,
  failureAlert,
  loadingText,
  pageShell,
  passwordField,
  statusText,
  submitButton,
} from './ui'

// NOTE: Activation and reset by link (D13). The token is in the URL fragment,
// read once by the parent and sent only in a POST body. It is held as
// `Redacted`, and the passwords too. A link that is used, expired or unknown
// all read the same.

export const MIN_PASSWORD_LENGTH = 10

// MODEL

export const LinkState = defineTaggedUnion({
  Inspecting: {},
  Ready: { info: LinkInfo },
  Unusable: { failure: Failure },
})
export type LinkState = typeof LinkState.Type

export const PasswordProblem = Schema.Literals(['TooShort', 'Mismatch'])
export type PasswordProblem = typeof PasswordProblem.Type

export const Submission = defineTaggedUnion({
  Editing: {},
  Submitting: {},
  Invalid: { problem: PasswordProblem },
  Rejected: { failure: Failure },
})
export type Submission = typeof Submission.Type

export const Model = Schema.Struct({
  token: Schema.Redacted(Schema.String),
  state: LinkState,
  password: Schema.Redacted(Schema.String),
  confirmation: Schema.Redacted(Schema.String),
  submission: Submission,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededInspectLink: { info: LinkInfo },
  FailedInspectLink: { failure: Failure },
  UpdatedPassword: { value: Schema.Redacted(Schema.String) },
  UpdatedConfirmation: { value: Schema.Redacted(Schema.String) },
  SubmittedPassword: {},
  SucceededConsumeLink: { me: MeView },
  FailedConsumeLink: { failure: Failure },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  SignedInWithLink: { me: MeView },
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

export const InspectLink = Command.define('InspectLink', {
  args: { token: Schema.Redacted(Schema.String) },
  messages: [Message.SucceededInspectLink, Message.FailedInspectLink],
  execute: ({ token }) =>
    withPublic(client =>
      client.InspectLink({ token: Redacted.value(token) }),
    ).pipe(
      Effect.map(info => Message.SucceededInspectLink({ info })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedInspectLink({ failure: failureOf(error) }),
        ),
      ),
    ),
})

export const ConsumeLink = Command.define('ConsumeLink', {
  args: {
    token: Schema.Redacted(Schema.String),
    password: Schema.Redacted(Schema.String),
  },
  messages: [Message.SucceededConsumeLink, Message.FailedConsumeLink],
  execute: ({ token, password }) =>
    withPublic(client =>
      client.ConsumeLink({
        token: Redacted.value(token),
        password: Redacted.value(password),
      }),
    ).pipe(
      Effect.map(me => Message.SucceededConsumeLink({ me })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedConsumeLink({ failure: failureOf(error) }),
        ),
      ),
    ),
})

// INIT

const blank = Redacted.make('')

export const init = (
  maybeToken: Option.Option<Redacted.Redacted<string>>,
): Update.Return<Model, Message> =>
  Option.match(maybeToken, {
    onNone: () => ({
      model: Model.make({
        token: blank,
        state: LinkState.Unusable({ failure: Failure.LinkInvalid() }),
        password: blank,
        confirmation: blank,
        submission: Submission.Editing(),
      }),
    }),
    onSome: token => ({
      model: Model.make({
        token,
        state: LinkState.Inspecting(),
        password: blank,
        confirmation: blank,
        submission: Submission.Editing(),
      }),
      commands: [InspectLink({ token })],
    }),
  })

// UPDATE

export const passwordProblemOf = (
  password: Redacted.Redacted<string>,
  confirmation: Redacted.Redacted<string>,
): Option.Option<PasswordProblem> => {
  if (Redacted.value(password).length < MIN_PASSWORD_LENGTH) {
    return Option.some('TooShort')
  }
  return Redacted.value(password) === Redacted.value(confirmation)
    ? Option.none()
    : Option.some('Mismatch')
}

const editing = (model: Model): Model =>
  modifyFields(model, { submission: () => Submission.Editing() })

export const update = (model: Model, message: Message) =>
  Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(
    message,
    {
      SucceededInspectLink: ({ info }) => ({
        model: modifyFields(model, { state: () => LinkState.Ready({ info }) }),
      }),
      FailedInspectLink: ({ failure }) => ({
        model: modifyFields(model, {
          state: () => LinkState.Unusable({ failure }),
        }),
      }),
      UpdatedPassword: ({ value }) => ({
        model: modifyFields(editing(model), { password: () => value }),
      }),
      UpdatedConfirmation: ({ value }) => ({
        model: modifyFields(editing(model), { confirmation: () => value }),
      }),
      SubmittedPassword: () =>
        Submission.match(model.submission, {
          Submitting: () => ({ model }),
          Editing: () => submit(model),
          Invalid: () => submit(model),
          Rejected: () => submit(model),
        }),
      SucceededConsumeLink: ({ me }) => ({
        model: modifyFields(model, {
          token: () => blank,
          password: () => blank,
          confirmation: () => blank,
        }),
        outMessage: OutMessage.SignedInWithLink({ me }),
      }),
      FailedConsumeLink: ({ failure }) => ({
        model: modifyFields(model, {
          password: () => blank,
          confirmation: () => blank,
          submission: () => Submission.Rejected({ failure }),
        }),
      }),
    },
  )

const submit = (
  model: Model,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> =>
  Option.match(passwordProblemOf(model.password, model.confirmation), {
    onSome: problem => ({
      model: modifyFields(model, {
        submission: () => Submission.Invalid({ problem }),
      }),
    }),
    onNone: () => ({
      model: modifyFields(model, {
        submission: () => Submission.Submitting(),
      }),
      commands: [ConsumeLink({ token: model.token, password: model.password })],
    }),
  })

// VIEW

const problemText = (problem: PasswordProblem): string =>
  problem === 'TooShort'
    ? `Use at least ${MIN_PASSWORD_LENGTH} characters.`
    : 'The two passwords do not match.'

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LinkState.match(model.state, {
    Inspecting: () =>
      pageShell(h, 'Link', 'Checking your link', '', [
        loadingText(h, 'One moment.'),
      ]),
    Unusable: ({ failure }) =>
      pageShell(h, 'Link', 'This link does not work', '', [
        failureAlert(h, failure),
        h.p(
          [h.Class('text-lg text-brand-ink')],
          ['Ask the person who gave it to you for a new one.'],
        ),
      ]),
    Ready: ({ info }) => {
      const isSubmitting = Submission.guards.Submitting(model.submission)
      return pageShell(
        h,
        'Set password',
        info.purpose === 'activate'
          ? 'Set your password'
          : 'Choose a new password',
        info.purpose === 'activate'
          ? `Welcome, ${info.name}. Choose a password to open your account (${info.email}).`
          : `Choose a new password for ${info.email}. Every other session of yours ends.`,
        [
          h.form(
            [
              h.Class('flex max-w-md flex-col gap-5'),
              h.OnSubmit(Message.SubmittedPassword()),
            ],
            [
              h.input([
                h.Type('email'),
                h.Name('email'),
                h.Autocomplete('username'),
                h.Value(info.email),
                h.Readonly(true),
                h.Class('sr-only'),
                h.AriaHidden(true),
                h.Tabindex(-1),
              ]),
              passwordField(
                h,
                'link-password',
                'New password',
                model.password,
                value =>
                  Message.UpdatedPassword({ value: Redacted.make(value) }),
              ),
              passwordField(
                h,
                'link-confirmation',
                'Type it again',
                model.confirmation,
                value =>
                  Message.UpdatedConfirmation({ value: Redacted.make(value) }),
              ),
              Submission.match(model.submission, {
                Editing: () => h.empty,
                Submitting: () => statusText(h, 'Saving your password.'),
                Invalid: ({ problem }) => alertText(h, problemText(problem)),
                Rejected: ({ failure }) => failureAlert(h, failure),
              }),
              submitButton(
                h,
                info.purpose === 'activate'
                  ? 'Set password and sign in'
                  : 'Save new password',
                isSubmitting,
                'Saving…',
              ),
            ],
          ),
        ],
      )
    },
  }),
)
