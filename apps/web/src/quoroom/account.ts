import { Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { MeView, ProfileView } from '@case-desk/domain'

import { withQuoroom } from './api'
import { Failure, failureOf } from './failure'
import {
  alertText,
  checkboxField,
  failureAlert,
  loadingText,
  pageShell,
  panel,
  statusText,
  submitButton,
  textField,
} from './ui'

// NOTE: The person's own account: the number they can be reached on, their
// WhatsApp consent and, for authors, whether to hear about each single
// approval (D19, off by default). Only the person sets a number's consent:
// an author who registered them can only ask for it (D13).

// MODEL

export const Load = defineTaggedUnion({
  Loading: {},
  Loaded: { name: Schema.String, email: Schema.String },
  Failed: { failure: Failure },
})
export type Load = typeof Load.Type

export const FormProblem = Schema.Literals(['BadPhone', 'ConsentNeedsPhone'])
export type FormProblem = typeof FormProblem.Type

export const Submission = defineTaggedUnion({
  Editing: {},
  Saving: {},
  Saved: {},
  Invalid: { problem: FormProblem },
  Failed: { failure: Failure },
})
export type Submission = typeof Submission.Type

export const Model = Schema.Struct({
  load: Load,
  phone: Schema.String,
  whatsappConsent: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  submission: Submission,
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  load: Load.Loading(),
  phone: '',
  whatsappConsent: false,
  notifyOnApproval: false,
  submission: Submission.Editing(),
})

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadAccount: { me: MeView },
  FailedLoadAccount: { failure: Failure },
  ClickedRetryLoad: {},
  UpdatedPhone: { value: Schema.String },
  ToggledWhatsAppConsent: {},
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
  args: {
    phone: Schema.NullOr(Schema.String),
    whatsappConsent: Schema.Boolean,
    notifyOnApproval: Schema.Boolean,
  },
  messages: [Message.SucceededSetPreferences, Message.FailedSetPreferences],
  execute: ({ phone, whatsappConsent, notifyOnApproval }) =>
    withQuoroom(client =>
      client.SetNotificationPreferences({
        phone,
        whatsappConsent,
        notifyOnApproval,
      }),
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

const PHONE_FORMAT = /^\+[1-9]\d{6,14}$/

export const normalisePhone = (typed: string): string =>
  typed.replaceAll(/[\s\-().]/g, '')

export const formOf = (
  model: Model,
): Option.Option<Readonly<{ phone: string | null }>> =>
  normalisePhone(model.phone) === ''
    ? Option.some({ phone: null })
    : PHONE_FORMAT.test(normalisePhone(model.phone))
      ? Option.some({ phone: normalisePhone(model.phone) })
      : Option.none()

export const problemOf = (model: Model): Option.Option<FormProblem> => {
  const phone = normalisePhone(model.phone)
  if (phone !== '' && !PHONE_FORMAT.test(phone)) {
    return Option.some('BadPhone')
  }
  return phone === '' && model.whatsappConsent
    ? Option.some('ConsentNeedsPhone')
    : Option.none()
}

const edited = (model: Model): Model =>
  modifyFields(model, { submission: () => Submission.Editing() })

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadAccount: ({ me }) => ({
      model: modifyFields(model, {
        load: () => Load.Loaded({ name: me.name, email: me.email }),
        phone: () => me.profile.phone ?? '',
        whatsappConsent: () => me.profile.whatsappConsent,
        notifyOnApproval: () => me.profile.notifyOnApproval,
        submission: () => Submission.Editing(),
      }),
    }),
    FailedLoadAccount: ({ failure }) => ({
      model: modifyFields(model, { load: () => Load.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => enter(model),
    UpdatedPhone: ({ value }) => ({
      model: modifyFields(edited(model), { phone: () => value }),
    }),
    ToggledWhatsAppConsent: () => ({
      model: modifyFields(edited(model), {
        whatsappConsent: consent => !consent,
      }),
    }),
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
        Invalid: () => submit(model),
        Failed: () => submit(model),
      }),
    SucceededSetPreferences: ({ profile }) => ({
      model: modifyFields(model, {
        phone: () => profile.phone ?? '',
        whatsappConsent: () => profile.whatsappConsent,
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

const submit = (model: Model): Update.Return<Model, Message> =>
  Option.match(problemOf(model), {
    onSome: problem => ({
      model: modifyFields(model, {
        submission: () => Submission.Invalid({ problem }),
      }),
    }),
    onNone: () => ({
      model: modifyFields(model, { submission: () => Submission.Saving() }),
      commands: [
        SetPreferences({
          phone: Option.getOrElse(
            Option.map(formOf(model), form => form.phone),
            () => null,
          ),
          whatsappConsent: model.whatsappConsent,
          notifyOnApproval: model.notifyOnApproval,
        }),
      ],
    }),
  })

// VIEW

const problemText = (problem: FormProblem): string =>
  problem === 'BadPhone'
    ? 'Write the number with its country code, for example +34 600 000 000.'
    : 'Add your number to give WhatsApp consent.'

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
        panel(h, 'Notifications', [
          h.form(
            [
              h.Class('flex max-w-md flex-col gap-5'),
              h.OnSubmit(Message.SubmittedPreferences()),
            ],
            [
              textField(h, {
                id: 'account-phone',
                label: 'Phone number',
                type: 'tel',
                autocomplete: 'tel',
                hint: 'With the country code. Used only to reach you about reports.',
                value: model.phone,
                onInput: value => Message.UpdatedPhone({ value }),
              }),
              checkboxField(
                h,
                'account-whatsapp-consent',
                'I agree to receive messages from Quoroom on WhatsApp at this number',
                model.whatsappConsent,
                Message.ToggledWhatsAppConsent(),
                Option.some(
                  'Only you can give this. Nobody who registered you can do it for you, and you can withdraw it here at any time.',
                ),
              ),
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
                Invalid: ({ problem }) => alertText(h, problemText(problem)),
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
        ]),
      ]),
  }),
)
