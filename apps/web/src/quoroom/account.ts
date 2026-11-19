import { Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { MeView, ProfileView } from '@quoroom/domain'

import { withQuoroom } from './api'
import { Failure, failureOf } from './failure'
import {
  checkboxField,
  failureAlert,
  loadingText,
  pageShell,
  panel,
  statusText,
  submitButton,
} from './ui'

// NOTE: The person's own account: for authors, whether to hear about each
// single approval (D19, off by default).

// MODEL

export const Load = defineTaggedUnion({
  Loading: {},
  Loaded: { name: Schema.String, email: Schema.String },
  Failed: { failure: Failure },
})
export type Load = typeof Load.Type

export const Submission = defineTaggedUnion({
  Editing: {},
  Saving: {},
  Saved: {},
  Failed: { failure: Failure },
})
export type Submission = typeof Submission.Type

export const Model = Schema.Struct({
  load: Load,
  notifyOnApproval: Schema.Boolean,
  submission: Submission,
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  load: Load.Loading(),
  notifyOnApproval: false,
  submission: Submission.Editing(),
})

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadAccount: { me: MeView },
  FailedLoadAccount: { failure: Failure },
  ClickedRetryLoad: {},
  ToggledNotifyOnApproval: {},
  SubmittedPreferences: {},
  SucceededSetPreferences: { profile: ProfileView },
  FailedSetPreferences: { failure: Failure },
})
export type Message = typeof Message.Type

// COMMAND

export const LoadAccount = Command.define('LoadAccount', {
  messages: [Message.SucceededLoadAccount, Message.FailedLoadAccount],
  execute: withQuoroom(client => client.GetMe()).pipe(
    Effect.map(me => Message.SucceededLoadAccount({ me })),
    Effect.catch(error =>
      Effect.succeed(Message.FailedLoadAccount({ failure: failureOf(error) })),
    ),
  ),
})

export const SetPreferences = Command.define('SetPreferences', {
  args: { notifyOnApproval: Schema.Boolean },
  messages: [Message.SucceededSetPreferences, Message.FailedSetPreferences],
  execute: ({ notifyOnApproval }) =>
    withQuoroom(client =>
      client.SetNotificationPreferences({ notifyOnApproval }),
    ).pipe(
      Effect.map(profile => Message.SucceededSetPreferences({ profile })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSetPreferences({ failure: failureOf(error) }),
        ),
      ),
    ),
})

// INIT

export const enter = (model: Model): Update.Return<Model, Message> => ({
  model: modifyFields(model, { load: () => Load.Loading() }),
  commands: [LoadAccount()],
})

// UPDATE

const edited = (model: Model): Model =>
  modifyFields(model, { submission: () => Submission.Editing() })

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadAccount: ({ me }) => ({
      model: modifyFields(model, {
        load: () => Load.Loaded({ name: me.name, email: me.email }),
        notifyOnApproval: () => me.profile.notifyOnApproval,
        submission: () => Submission.Editing(),
      }),
    }),
    FailedLoadAccount: ({ failure }) => ({
      model: modifyFields(model, { load: () => Load.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => enter(model),
    ToggledNotifyOnApproval: () => ({
      model: modifyFields(edited(model), {
        notifyOnApproval: notify => !notify,
      }),
    }),
    SubmittedPreferences: () =>
      Submission.match(model.submission, {
        Saving: () => ({ model }),
        Editing: () => submit(model),
        Saved: () => submit(model),
        Failed: () => submit(model),
      }),
    SucceededSetPreferences: ({ profile }) => ({
      model: modifyFields(model, {
        notifyOnApproval: () => profile.notifyOnApproval,
        submission: () => Submission.Saved(),
      }),
    }),
    FailedSetPreferences: ({ failure }) => ({
      model: modifyFields(model, {
        submission: () => Submission.Failed({ failure }),
      }),
    }),
  })

const submit = (model: Model): Update.Return<Model, Message> => ({
  model: modifyFields(model, { submission: () => Submission.Saving() }),
  commands: [SetPreferences({ notifyOnApproval: model.notifyOnApproval })],
})

// VIEW

export const EMAIL_COMING_SOON =
  'Notifications by e-mail are coming soon. For now they appear on Home, in Quoroom.'

export const view = Submodel.defineView<Model, Message>((model, h) =>
  Load.match(model.load, {
    Loading: () =>
      pageShell(h, 'Your account', 'Your account', '', [
        loadingText(h, 'Loading your account.'),
      ]),
    Failed: ({ failure }) =>
      pageShell(h, 'Your account', 'Your account', '', [
        failureAlert(h, failure),
        h.button(
          [
            h.Type('button'),
            h.Class('self-start underline'),
            h.OnClick(Message.ClickedRetryLoad()),
          ],
          ['Try again'],
        ),
      ]),
    Loaded: ({ name, email }) =>
      pageShell(h, 'Your account', 'Your account', `${name}, ${email}.`, [
        panel(
          h,
          'Notifications',
          [
            h.form(
              [
                h.Class('flex max-w-md flex-col gap-5'),
                h.OnSubmit(Message.SubmittedPreferences()),
              ],
              [
                checkboxField(
                  h,
                  'account-notify-approval',
                  'Tell me about each single approval of my reports',
                  model.notifyOnApproval,
                  Message.ToggledNotifyOnApproval(),
                  Option.some(
                    'For authors. Reviews with comments, change requests and decided rounds always reach you.',
                  ),
                ),
                Submission.match(model.submission, {
                  Editing: () => h.empty,
                  Saving: () => statusText(h, 'Saving.'),
                  Saved: () => statusText(h, 'Saved.'),
                  Failed: ({ failure }) => failureAlert(h, failure),
                }),
                submitButton(
                  h,
                  'Save preferences',
                  Submission.guards.Saving(model.submission),
                  'Saving…',
                ),
              ],
            ),
          ],
          Option.some(EMAIL_COMING_SOON),
        ),
      ]),
  }),
)
