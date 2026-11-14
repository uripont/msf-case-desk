import { Array, Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { CommitteeRecord, Reviewer, Unit, UnitMember } from '@case-desk/domain'

import { withQuoroom } from './api'
import { Failure, failureOf, failureText } from './failure'
import { FormState, formStatus, isSubmitting } from './formState'
import {
  GivenLink,
  IssuedLink,
  copyToClipboard,
  issuedLinkOf,
  issuedLinkPanel,
  maybeGivenLinkOf,
} from './issuedLink'
import {
  checkboxField,
  failureAlert,
  loadingText,
  pageShell,
  panel,
  selectField,
  smallButton,
  submitButton,
  textField,
} from './ui'

// NOTE: The author's unit screens (D13). Co-authors of a
// report are existing authors of its unit, chosen by ID: an author cannot
// create one here, and an administrator grants the author capability. What an
// author can do here is invite a person to take part in the unit's reviews,
// register reviewers (the unit's own entry: name, number, and whether WhatsApp
// consent is requested, which only the person can give) and group them into
// committees.

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+$/
const PHONE_FORMAT = /^\+[1-9]\d{6,14}$/

export const normalisePhone = (typed: string): string =>
  typed.replaceAll(/[\s\-().]/g, '')

// MODEL

export const LoadState = defineTaggedUnion({
  Loading: {},
  Loaded: {},
  Failed: { failure: Failure },
})
export type LoadState = typeof LoadState.Type

export const Model = Schema.Struct({
  origin: Schema.String,
  load: LoadState,
  units: Schema.Array(Unit),
  selectedUnit: Schema.String,
  dataLoad: LoadState,
  members: Schema.Array(UnitMember),
  reviewers: Schema.Array(Reviewer),
  committees: Schema.Array(CommitteeRecord),
  inviteName: Schema.String,
  inviteEmail: Schema.String,
  inviteForm: FormState,
  reviewerName: Schema.String,
  reviewerEmail: Schema.String,
  reviewerPhone: Schema.String,
  reviewerConsent: Schema.Boolean,
  reviewerForm: FormState,
  committeeName: Schema.String,
  committeeForm: FormState,
  maybeLink: Schema.Option(IssuedLink),
  maybeNotice: Schema.Option(Schema.String),
  maybeActionFailure: Schema.Option(Failure),
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  load: LoadState.Loading(),
  units: [],
  selectedUnit: '',
  dataLoad: LoadState.Loading(),
  members: [],
  reviewers: [],
  committees: [],
  inviteName: '',
  inviteEmail: '',
  inviteForm: FormState.Editing(),
  reviewerName: '',
  reviewerEmail: '',
  reviewerPhone: '',
  reviewerConsent: false,
  reviewerForm: FormState.Editing(),
  committeeName: '',
  committeeForm: FormState.Editing(),
  maybeLink: Option.none(),
  maybeNotice: Option.none(),
  maybeActionFailure: Option.none(),
})

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadUnits: { units: Schema.Array(Unit) },
  FailedLoadUnits: { failure: Failure },
  ClickedRetryLoad: {},
  SelectedUnit: { value: Schema.String },
  SucceededLoadUnitData: {
    unit: Schema.String,
    members: Schema.Array(UnitMember),
    reviewers: Schema.Array(Reviewer),
    committees: Schema.Array(CommitteeRecord),
  },
  FailedLoadUnitData: { unit: Schema.String, failure: Failure },
  UpdatedInviteName: { value: Schema.String },
  UpdatedInviteEmail: { value: Schema.String },
  SubmittedInvite: {},
  SucceededInviteToUnit: {
    name: Schema.String,
    link: Schema.Option(GivenLink),
  },
  FailedInviteToUnit: { failure: Failure },
  UpdatedReviewerName: { value: Schema.String },
  UpdatedReviewerEmail: { value: Schema.String },
  UpdatedReviewerPhone: { value: Schema.String },
  ToggledReviewerConsent: {},
  SubmittedReviewer: {},
  SucceededAddReviewer: {
    name: Schema.String,
    link: Schema.Option(GivenLink),
  },
  FailedAddReviewer: { failure: Failure },
  UpdatedCommitteeName: { value: Schema.String },
  SubmittedCommittee: {},
  SucceededCreateCommittee: { committee: CommitteeRecord },
  FailedCreateCommittee: { failure: Failure },
  ToggledCommitteeMember: {
    committeeId: Schema.String,
    accountId: Schema.String,
  },
  ClickedRetireCommittee: { committeeId: Schema.String },
  SucceededUpdateCommittee: { committee: CommitteeRecord },
  FailedUpdateCommittee: { failure: Failure },
  ClickedCopyLink: {},
  CompletedCopyLink: {},
  FailedCopyLink: {},
  ClickedDismissLink: {},
})
export type Message = typeof Message.Type

// COMMAND

export const LoadUnits = Command.define('LoadUnits', {
  messages: [Message.SucceededLoadUnits, Message.FailedLoadUnits],
  execute: withQuoroom(client => client.ListUnits()).pipe(
    Effect.map(units => Message.SucceededLoadUnits({ units })),
    Effect.catch(error =>
      Effect.succeed(Message.FailedLoadUnits({ failure: failureOf(error) })),
    ),
  ),
})

export const LoadUnitData = Command.define('LoadUnitData', {
  args: { unit: Schema.String },
  messages: [Message.SucceededLoadUnitData, Message.FailedLoadUnitData],
  execute: ({ unit }) =>
    withQuoroom(client =>
      Effect.all({
        members: client.ListUnitMembers({ unit }),
        reviewers: client.ListReviewers({ unit }),
        committees: client.ListCommittees({ unit }),
      }),
    ).pipe(
      Effect.map(({ members, reviewers, committees }) =>
        Message.SucceededLoadUnitData({ unit, members, reviewers, committees }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadUnitData({ unit, failure: failureOf(error) }),
        ),
      ),
    ),
})

export const InviteToUnit = Command.define('InviteToUnit', {
  args: { unit: Schema.String, name: Schema.String, email: Schema.String },
  messages: [Message.SucceededInviteToUnit, Message.FailedInviteToUnit],
  execute: ({ unit, name, email }) =>
    withQuoroom(client => client.InviteToUnit({ unit, name, email })).pipe(
      Effect.map(result =>
        Message.SucceededInviteToUnit({
          name,
          link: maybeGivenLinkOf(result.link),
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedInviteToUnit({ failure: failureOf(error) }),
        ),
      ),
    ),
})

export const AddReviewer = Command.define('AddReviewer', {
  args: {
    unit: Schema.String,
    name: Schema.String,
    email: Schema.String,
    phone: Schema.Option(Schema.String),
    whatsappConsent: Schema.Boolean,
  },
  messages: [Message.SucceededAddReviewer, Message.FailedAddReviewer],
  execute: ({ unit, name, email, phone, whatsappConsent }) =>
    withQuoroom(client =>
      client.AddReviewer({
        unit,
        name,
        email,
        whatsappConsent,
        ...Option.match(phone, {
          onNone: () => ({}),
          onSome: value => ({ phone: value }),
        }),
      }),
    ).pipe(
      Effect.map(added =>
        Message.SucceededAddReviewer({
          name: added.name,
          link: maybeGivenLinkOf(added.link),
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedAddReviewer({ failure: failureOf(error) }),
        ),
      ),
    ),
})

export const CreateCommittee = Command.define('CreateCommittee', {
  args: { unit: Schema.String, name: Schema.String },
  messages: [Message.SucceededCreateCommittee, Message.FailedCreateCommittee],
  execute: ({ unit, name }) =>
    withQuoroom(client =>
      client.CreateCommittee({ unit, name, memberIds: [] }),
    ).pipe(
      Effect.map(committee => Message.SucceededCreateCommittee({ committee })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedCreateCommittee({ failure: failureOf(error) }),
        ),
      ),
    ),
})

export const UpdateCommittee = Command.define('UpdateCommittee', {
  args: {
    committeeId: Schema.String,
    // NOTE: a member change is one operation on the stored list, never a whole
    // list from a screen that may be a step behind.
    maybeAdd: Schema.Option(Schema.String),
    maybeRemove: Schema.Option(Schema.String),
    retired: Schema.Option(Schema.Boolean),
  },
  messages: [Message.SucceededUpdateCommittee, Message.FailedUpdateCommittee],
  execute: ({ committeeId, maybeAdd, maybeRemove, retired }) =>
    withQuoroom(client =>
      client.UpdateCommittee({
        committeeId,
        ...Option.match(maybeAdd, {
          onNone: () => ({}),
          onSome: value => ({ addMemberIds: [value] }),
        }),
        ...Option.match(maybeRemove, {
          onNone: () => ({}),
          onSome: value => ({ removeMemberIds: [value] }),
        }),
        ...Option.match(retired, {
          onNone: () => ({}),
          onSome: value => ({ retired: value }),
        }),
      }),
    ).pipe(
      Effect.map(committee => Message.SucceededUpdateCommittee({ committee })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedUpdateCommittee({ failure: failureOf(error) }),
        ),
      ),
    ),
})

export const CopyLink = Command.define('CopyLink', {
  args: { url: Schema.Redacted(Schema.String) },
  messages: [Message.CompletedCopyLink, Message.FailedCopyLink],
  execute: ({ url }) =>
    copyToClipboard(url).pipe(
      Effect.as(Message.CompletedCopyLink()),
      Effect.catch(() => Effect.succeed(Message.FailedCopyLink())),
    ),
})

// INIT

export const enter = (
  model: Model,
  origin: string,
): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    origin: () => origin,
    load: () => LoadState.Loading(),
  }),
  commands: [LoadUnits()],
})

// UPDATE

const noticesCleared = (model: Model): Model =>
  modifyFields(model, {
    maybeLink: () => Option.none(),
    maybeNotice: () => Option.none(),
    maybeActionFailure: () => Option.none(),
  })

const replaceCommittee = (
  committees: ReadonlyArray<CommitteeRecord>,
  committee: CommitteeRecord,
): ReadonlyArray<CommitteeRecord> =>
  Array.some(committees, existing => existing.id === committee.id)
    ? Array.map(committees, existing =>
        existing.id === committee.id ? committee : existing,
      )
    : Array.append(committees, committee)

const withEditedForm = (
  model: Model,
  form: 'inviteForm' | 'reviewerForm' | 'committeeForm',
): Model => ({ ...model, [form]: FormState.Editing() })

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadUnits: ({ units }) => {
      const selectedUnit = Array.some(
        units,
        unit => unit.id === model.selectedUnit,
      )
        ? model.selectedUnit
        : (units[0]?.id ?? '')
      const loaded = modifyFields(model, {
        load: () => LoadState.Loaded(),
        units: () => units,
        selectedUnit: () => selectedUnit,
        dataLoad: () => LoadState.Loading(),
      })
      return selectedUnit === ''
        ? { model: loaded }
        : { model: loaded, commands: [LoadUnitData({ unit: selectedUnit })] }
    },
    FailedLoadUnits: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => enter(model, model.origin),
    SelectedUnit: ({ value }) => ({
      model: modifyFields(noticesCleared(model), {
        selectedUnit: () => value,
        dataLoad: () => LoadState.Loading(),
        members: () => [],
        reviewers: () => [],
        committees: () => [],
      }),
      commands: [LoadUnitData({ unit: value })],
    }),
    SucceededLoadUnitData: ({ unit, members, reviewers, committees }) =>
      unit !== model.selectedUnit
        ? { model }
        : {
            model: modifyFields(model, {
              dataLoad: () => LoadState.Loaded(),
              members: () => members,
              reviewers: () => reviewers,
              committees: () => committees,
            }),
          },
    FailedLoadUnitData: ({ unit, failure }) =>
      unit !== model.selectedUnit
        ? { model }
        : {
            model: modifyFields(model, {
              dataLoad: () => LoadState.Failed({ failure }),
            }),
          },
    UpdatedInviteName: ({ value }) => ({
      model: modifyFields(withEditedForm(model, 'inviteForm'), {
        inviteName: () => value,
      }),
    }),
    UpdatedInviteEmail: ({ value }) => ({
      model: modifyFields(withEditedForm(model, 'inviteForm'), {
        inviteEmail: () => value,
      }),
    }),
    SubmittedInvite: () => submitInvite(model),
    SucceededInviteToUnit: ({ name, link: given }) => ({
      model: modifyFields(noticesCleared(model), {
        inviteName: () => '',
        inviteEmail: () => '',
        inviteForm: () => FormState.Editing(),
        maybeLink: () =>
          Option.map(given, link => issuedLinkOf(model.origin, name, link)),
        maybeNotice: () =>
          Option.isNone(given)
            ? Option.some(
                `${name} already has an account, so no link was made. They are now part of this unit.`,
              )
            : Option.none(),
      }),
      commands: [LoadUnitData({ unit: model.selectedUnit })],
    }),
    FailedInviteToUnit: ({ failure }) => ({
      model: modifyFields(model, {
        inviteForm: () => FormState.Failed({ failure }),
      }),
    }),
    UpdatedReviewerName: ({ value }) => ({
      model: modifyFields(withEditedForm(model, 'reviewerForm'), {
        reviewerName: () => value,
      }),
    }),
    UpdatedReviewerEmail: ({ value }) => ({
      model: modifyFields(withEditedForm(model, 'reviewerForm'), {
        reviewerEmail: () => value,
      }),
    }),
    UpdatedReviewerPhone: ({ value }) => ({
      model: modifyFields(withEditedForm(model, 'reviewerForm'), {
        reviewerPhone: () => value,
      }),
    }),
    ToggledReviewerConsent: () => ({
      model: modifyFields(withEditedForm(model, 'reviewerForm'), {
        reviewerConsent: consent => !consent,
      }),
    }),
    SubmittedReviewer: () => submitReviewer(model),
    SucceededAddReviewer: ({ name, link: given }) => ({
      model: modifyFields(noticesCleared(model), {
        reviewerName: () => '',
        reviewerEmail: () => '',
        reviewerPhone: () => '',
        reviewerConsent: () => false,
        reviewerForm: () => FormState.Editing(),
        maybeLink: () =>
          Option.map(given, link => issuedLinkOf(model.origin, name, link)),
        maybeNotice: () =>
          Option.isNone(given)
            ? Option.some(
                `${name} already has an account, so no link was made. They are now registered as a reviewer in this unit.`,
              )
            : Option.none(),
      }),
      commands: [LoadUnitData({ unit: model.selectedUnit })],
    }),
    FailedAddReviewer: ({ failure }) => ({
      model: modifyFields(model, {
        reviewerForm: () => FormState.Failed({ failure }),
      }),
    }),
    UpdatedCommitteeName: ({ value }) => ({
      model: modifyFields(withEditedForm(model, 'committeeForm'), {
        committeeName: () => value,
      }),
    }),
    SubmittedCommittee: () => submitCommittee(model),
    SucceededCreateCommittee: ({ committee }) => ({
      model: modifyFields(model, {
        committees: committees => replaceCommittee(committees, committee),
        committeeName: () => '',
        committeeForm: () => FormState.Editing(),
      }),
    }),
    FailedCreateCommittee: ({ failure }) => ({
      model: modifyFields(model, {
        committeeForm: () => FormState.Failed({ failure }),
      }),
    }),
    ToggledCommitteeMember: ({ committeeId, accountId }) =>
      Option.match(
        Array.findFirst(
          model.committees,
          committee => committee.id === committeeId,
        ),
        {
          onNone: () => ({ model }),
          onSome: committee => ({
            model: noticesCleared(model),
            commands: [
              UpdateCommittee({
                committeeId,
                ...(Array.contains(committee.memberIds, accountId)
                  ? {
                      maybeAdd: Option.none(),
                      maybeRemove: Option.some(accountId),
                    }
                  : {
                      maybeAdd: Option.some(accountId),
                      maybeRemove: Option.none(),
                    }),
                retired: Option.none(),
              }),
            ],
          }),
        },
      ),
    ClickedRetireCommittee: ({ committeeId }) => ({
      model: noticesCleared(model),
      commands: [
        UpdateCommittee({
          committeeId,
          maybeAdd: Option.none(),
          maybeRemove: Option.none(),
          retired: Option.some(true),
        }),
      ],
    }),
    SucceededUpdateCommittee: ({ committee }) => ({
      model: modifyFields(model, {
        committees: committees => replaceCommittee(committees, committee),
      }),
    }),
    FailedUpdateCommittee: ({ failure }) => ({
      model: modifyFields(model, {
        maybeActionFailure: () => Option.some(failure),
      }),
    }),
    ClickedCopyLink: () =>
      Option.match(model.maybeLink, {
        onNone: () => ({ model }),
        onSome: link => ({ model, commands: [CopyLink({ url: link.url })] }),
      }),
    CompletedCopyLink: () => ({
      model: modifyFields(model, {
        maybeNotice: () => Option.some('Link copied.'),
      }),
    }),
    FailedCopyLink: () => ({
      model: modifyFields(model, {
        maybeNotice: () =>
          Option.some('Could not copy. Select the link and copy it by hand.'),
      }),
    }),
    ClickedDismissLink: () => ({
      model: modifyFields(model, {
        maybeLink: () => Option.none(),
        maybeNotice: () => Option.none(),
      }),
    }),
  })

const invalid = (
  model: Model,
  form: 'inviteForm' | 'reviewerForm' | 'committeeForm',
  message: string,
): Update.Return<Model, Message> => ({
  model: { ...model, [form]: FormState.Invalid({ message }) },
})

const submitInvite = (model: Model): Update.Return<Model, Message> => {
  if (isSubmitting(model.inviteForm)) {
    return { model }
  }
  const name = model.inviteName.trim()
  const email = model.inviteEmail.trim()
  if (name === '') {
    return invalid(model, 'inviteForm', 'Write the name of the person.')
  }
  if (!EMAIL_FORMAT.test(email)) {
    return invalid(
      model,
      'inviteForm',
      'Write the e-mail address of the person.',
    )
  }
  return {
    model: modifyFields(model, { inviteForm: () => FormState.Submitting() }),
    commands: [InviteToUnit({ unit: model.selectedUnit, name, email })],
  }
}

const submitReviewer = (model: Model): Update.Return<Model, Message> => {
  if (isSubmitting(model.reviewerForm)) {
    return { model }
  }
  const name = model.reviewerName.trim()
  const email = model.reviewerEmail.trim()
  const phone = normalisePhone(model.reviewerPhone)
  if (name === '') {
    return invalid(model, 'reviewerForm', 'Write the name of the reviewer.')
  }
  if (!EMAIL_FORMAT.test(email)) {
    return invalid(
      model,
      'reviewerForm',
      'Write the e-mail address of the reviewer.',
    )
  }
  if (phone !== '' && !PHONE_FORMAT.test(phone)) {
    return invalid(
      model,
      'reviewerForm',
      'Write the number with its country code, for example +34 600 000 000.',
    )
  }
  if (phone === '' && model.reviewerConsent) {
    return invalid(
      model,
      'reviewerForm',
      'Add a number to ask for WhatsApp consent.',
    )
  }
  return {
    model: modifyFields(model, { reviewerForm: () => FormState.Submitting() }),
    commands: [
      AddReviewer({
        unit: model.selectedUnit,
        name,
        email,
        phone: phone === '' ? Option.none() : Option.some(phone),
        whatsappConsent: model.reviewerConsent,
      }),
    ],
  }
}

const submitCommittee = (model: Model): Update.Return<Model, Message> => {
  if (isSubmitting(model.committeeForm)) {
    return { model }
  }
  const name = model.committeeName.trim()
  return name === ''
    ? invalid(model, 'committeeForm', 'Give the committee a name.')
    : {
        model: modifyFields(model, {
          committeeForm: () => FormState.Submitting(),
        }),
        commands: [CreateCommittee({ unit: model.selectedUnit, name })],
      }
}

// VIEW

const noticeBlock = (model: Model, h: HtmlBuilder<Message>) => [
  Option.match(model.maybeLink, {
    onNone: () => h.empty,
    onSome: link =>
      issuedLinkPanel(
        h,
        link,
        Message.ClickedCopyLink(),
        Message.ClickedDismissLink(),
      ),
  }),
  Option.match(model.maybeNotice, {
    onNone: () => h.empty,
    onSome: notice =>
      h.p(
        [h.Role('status'), h.Class('text-base font-medium text-msf-ink')],
        [notice],
      ),
  }),
  Option.match(model.maybeActionFailure, {
    onNone: () => h.empty,
    onSome: failure => failureAlert(h, failure),
  }),
]

const authorsPanel = (model: Model, h: HtmlBuilder<Message>) =>
  panel(
    h,
    'Authors in this unit',
    [
      Array.match(
        Array.filter(model.members, member => member.isAuthor),
        {
          onEmpty: () =>
            h.p([h.Class('text-lg text-msf-grey')], ['No authors.']),
          onNonEmpty: authors =>
            h.ul(
              [
                h.AriaLabel('Authors in this unit'),
                h.Class(
                  'flex flex-col divide-y divide-msf-line border-y border-msf-line',
                ),
              ],
              Array.map(authors, author =>
                h.keyed('li')(
                  author.accountId,
                  [h.Class('flex flex-col py-3')],
                  [
                    h.span([h.Class('text-lg font-medium')], [author.name]),
                    h.span(
                      [h.Class('text-base text-msf-grey')],
                      [author.email],
                    ),
                  ],
                ),
              ),
            ),
        },
      ),
    ],
    Option.some(
      'Co-authors of a report are chosen from this list, by an author of the report. An administrator grants the author capability.',
    ),
  )

const invitePanel = (model: Model, h: HtmlBuilder<Message>) =>
  panel(
    h,
    'Invite someone',
    [
      h.form(
        [
          h.Class('flex max-w-md flex-col gap-4'),
          h.AriaLabel('Invite someone'),
          h.OnSubmit(Message.SubmittedInvite()),
        ],
        [
          textField(h, {
            id: 'invite-name',
            label: 'Name',
            value: model.inviteName,
            onInput: value => Message.UpdatedInviteName({ value }),
          }),
          textField(h, {
            id: 'invite-email',
            label: 'E-mail',
            type: 'email',
            value: model.inviteEmail,
            onInput: value => Message.UpdatedInviteEmail({ value }),
          }),
          formStatus(h, model.inviteForm, 'Inviting.'),
          submitButton(
            h,
            'Invite',
            isSubmitting(model.inviteForm),
            'Inviting…',
          ),
        ],
      ),
    ],
    Option.some(
      'A new person gets a one-time link to open their account, which you hand over. Someone who already has an account is only added to the unit.',
    ),
  )

const reviewerRow = (reviewer: Reviewer, h: HtmlBuilder<Message>) =>
  h.keyed('li')(
    reviewer.accountId,
    [h.Class('flex flex-col py-3')],
    [
      h.span([h.Class('text-lg font-medium')], [reviewer.name]),
      h.span([h.Class('text-base text-msf-grey')], [reviewer.email]),
      h.span(
        [h.Class('text-sm text-msf-grey')],
        [
          [
            reviewer.phone ?? 'No number',
            reviewer.consentRequested
              ? 'WhatsApp consent requested'
              : 'No WhatsApp consent requested',
            reviewer.active ? 'Active' : 'Inactive',
          ].join(' · '),
        ],
      ),
    ],
  )

const reviewersPanel = (model: Model, h: HtmlBuilder<Message>) =>
  panel(
    h,
    'Reviewers',
    [
      Array.match(model.reviewers, {
        onEmpty: () =>
          h.p([h.Class('text-lg text-msf-grey')], ['No reviewers yet.']),
        onNonEmpty: reviewers =>
          h.ul(
            [
              h.AriaLabel('Reviewers'),
              h.Class(
                'flex flex-col divide-y divide-msf-line border-y border-msf-line',
              ),
            ],
            Array.map(reviewers, reviewer => reviewerRow(reviewer, h)),
          ),
      }),
      h.form(
        [
          h.Class('flex max-w-md flex-col gap-4'),
          h.AriaLabel('Register a reviewer'),
          h.OnSubmit(Message.SubmittedReviewer()),
        ],
        [
          h.h3([h.Class('text-xl font-bold')], ['Register a reviewer']),
          textField(h, {
            id: 'reviewer-name',
            label: 'Reviewer name',
            value: model.reviewerName,
            onInput: value => Message.UpdatedReviewerName({ value }),
          }),
          textField(h, {
            id: 'reviewer-email',
            label: 'Reviewer e-mail',
            type: 'email',
            value: model.reviewerEmail,
            onInput: value => Message.UpdatedReviewerEmail({ value }),
          }),
          textField(h, {
            id: 'reviewer-phone',
            label: 'Reviewer phone number',
            type: 'tel',
            hint: 'Optional, with the country code.',
            value: model.reviewerPhone,
            onInput: value => Message.UpdatedReviewerPhone({ value }),
          }),
          checkboxField(
            h,
            'reviewer-consent',
            'Ask for WhatsApp consent',
            model.reviewerConsent,
            Message.ToggledReviewerConsent(),
            Option.some(
              'This asks. Only the reviewer can give consent, on their own account.',
            ),
          ),
          formStatus(h, model.reviewerForm, 'Registering.'),
          submitButton(
            h,
            'Register reviewer',
            isSubmitting(model.reviewerForm),
            'Registering…',
          ),
        ],
      ),
    ],
    Option.some(
      'The name and number are the ones you typed. A reviewer who has no account yet gets a one-time link, which you hand over.',
    ),
  )

const committeeCard = (
  committee: CommitteeRecord,
  reviewers: ReadonlyArray<Reviewer>,
  h: HtmlBuilder<Message>,
) =>
  h.keyed('li')(
    committee.id,
    [h.Class('flex flex-col gap-3 py-4')],
    [
      h.div(
        [h.Class('flex items-baseline justify-between gap-4')],
        [
          h.h3([h.Class('text-xl font-bold')], [committee.name]),
          smallButton(
            h,
            'Retire',
            Message.ClickedRetireCommittee({ committeeId: committee.id }),
            Option.some(`Retire committee ${committee.name}`),
          ),
        ],
      ),
      Array.match(reviewers, {
        onEmpty: () =>
          h.p(
            [h.Class('text-base text-msf-grey')],
            ['Register reviewers to add them.'],
          ),
        onNonEmpty: people =>
          h.div(
            [h.Class('flex flex-col gap-2')],
            Array.map(people, reviewer =>
              checkboxField(
                h,
                `committee-${committee.id}-${reviewer.accountId}`,
                `${reviewer.name} in ${committee.name}`,
                Array.contains(committee.memberIds, reviewer.accountId),
                Message.ToggledCommitteeMember({
                  committeeId: committee.id,
                  accountId: reviewer.accountId,
                }),
              ),
            ),
          ),
      }),
    ],
  )

const committeesPanel = (model: Model, h: HtmlBuilder<Message>) =>
  panel(
    h,
    'Committees',
    [
      Array.match(
        Array.filter(model.committees, committee => !committee.retired),
        {
          onEmpty: () =>
            h.p([h.Class('text-lg text-msf-grey')], ['No committees yet.']),
          onNonEmpty: committees =>
            h.ul(
              [
                h.AriaLabel('Committees'),
                h.Class(
                  'flex flex-col divide-y divide-msf-line border-y border-msf-line',
                ),
              ],
              Array.map(committees, committee =>
                committeeCard(committee, model.reviewers, h),
              ),
            ),
        },
      ),
      h.form(
        [
          h.Class('flex max-w-md flex-col gap-4'),
          h.AriaLabel('New committee'),
          h.OnSubmit(Message.SubmittedCommittee()),
        ],
        [
          textField(h, {
            id: 'committee-name',
            label: 'Committee name',
            value: model.committeeName,
            onInput: value => Message.UpdatedCommitteeName({ value }),
          }),
          formStatus(h, model.committeeForm, 'Creating the committee.'),
          submitButton(
            h,
            'Create committee',
            isSubmitting(model.committeeForm),
            'Creating…',
          ),
        ],
      ),
    ],
    Option.some('A committee is a reusable group of reviewers of this unit.'),
  )

const unitChooser = (model: Model, h: HtmlBuilder<Message>) =>
  Array.length(model.units) > 1
    ? selectField(
        h,
        'unit-choice',
        'Unit',
        model.selectedUnit,
        Array.map(model.units, unit => ({
          value: unit.id,
          label: `${unit.name} (${unit.code})`,
        })),
        value => Message.SelectedUnit({ value }),
      )
    : h.empty

const dataView = (model: Model, h: HtmlBuilder<Message>) =>
  LoadState.match(model.dataLoad, {
    Loading: () => [loadingText(h, 'Loading the unit.')],
    Failed: ({ failure }) =>
      failure._tag === 'NotAllowed'
        ? [
            h.p(
              [h.Role('alert'), h.Class('text-lg font-medium text-msf-alert')],
              [
                'You are not an author in this unit. An administrator can grant you that.',
              ],
            ),
          ]
        : [
            h.p(
              [
                h.Role('alert'),
                h.Class('text-base font-medium text-msf-alert'),
              ],
              [failureText(failure)],
            ),
          ],
    Loaded: () => [
      ...noticeBlock(model, h),
      authorsPanel(model, h),
      invitePanel(model, h),
      reviewersPanel(model, h),
      committeesPanel(model, h),
    ],
  })

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LoadState.match(model.load, {
    Loading: () =>
      pageShell(h, 'My unit', 'My unit', '', [loadingText(h, 'Loading.')]),
    Failed: ({ failure }) =>
      pageShell(h, 'My unit', 'My unit', '', [
        failureAlert(h, failure),
        smallButton(h, 'Try again', Message.ClickedRetryLoad()),
      ]),
    Loaded: () =>
      Array.isReadonlyArrayEmpty(model.units)
        ? pageShell(h, 'My unit', 'My unit', '', [
            h.p(
              [h.Class('text-lg text-msf-ink')],
              [
                'There is no unit yet. An administrator creates units and grants the author capability.',
              ],
            ),
          ])
        : pageShell(
            h,
            'My unit',
            'My unit',
            'Invite people, register reviewers and group them into committees.',
            [unitChooser(model, h), ...dataView(model, h)],
          ),
  }),
)
