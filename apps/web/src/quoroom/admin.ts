import { Array, Effect, Option, Schema, pipe } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { AccountRow, CapabilityName, Unit } from '@case-desk/domain'

import { withQuoroom } from './api'
import { Failure, failureOf } from './failure'
import { FormState, formStatus, isSubmitting } from './formState'
import {
  GivenLink,
  IssuedLink,
  copyToClipboard,
  givenLinkOf,
  issuedLinkOf,
  issuedLinkPanel,
  maybeGivenLinkOf,
} from './issuedLink'
import {
  failureAlert,
  formatMoment,
  loadingText,
  pageShell,
  panel,
  selectField,
  smallButton,
  submitButton,
  textField,
} from './ui'

// NOTE: The administrator's screen: units, who holds which capability, and
// resets. A link is shown once to the administrator, to hand over (D13); it
// is not kept anywhere once dismissed.

export const UNIT_CODE_FORMAT = /^[A-Za-z0-9][A-Za-z0-9-]{0,15}$/
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+$/

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
  accounts: Schema.Array(AccountRow),
  unitName: Schema.String,
  unitCode: Schema.String,
  unitForm: FormState,
  grantEmail: Schema.String,
  grantName: Schema.String,
  grantCapability: CapabilityName,
  grantUnit: Schema.String,
  grantForm: FormState,
  maybeLink: Schema.Option(IssuedLink),
  maybeNotice: Schema.Option(Schema.String),
  maybeActionFailure: Schema.Option(Failure),
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  load: LoadState.Loading(),
  units: [],
  accounts: [],
  unitName: '',
  unitCode: '',
  unitForm: FormState.Editing(),
  grantEmail: '',
  grantName: '',
  grantCapability: 'author',
  grantUnit: '',
  grantForm: FormState.Editing(),
  maybeLink: Option.none(),
  maybeNotice: Option.none(),
  maybeActionFailure: Option.none(),
})

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadAdmin: {
    units: Schema.Array(Unit),
    accounts: Schema.Array(AccountRow),
  },
  FailedLoadAdmin: { failure: Failure },
  ClickedRetryLoad: {},
  UpdatedUnitName: { value: Schema.String },
  UpdatedUnitCode: { value: Schema.String },
  SubmittedUnit: {},
  SucceededCreateUnit: { unit: Unit },
  FailedCreateUnit: { failure: Failure },
  UpdatedGrantEmail: { value: Schema.String },
  UpdatedGrantName: { value: Schema.String },
  SelectedGrantCapability: { value: Schema.String },
  SelectedGrantUnit: { value: Schema.String },
  SubmittedGrant: {},
  SucceededGrantCapability: {
    account: AccountRow,
    link: Schema.Option(GivenLink),
  },
  FailedGrantCapability: { failure: Failure },
  ClickedRevoke: {
    accountId: Schema.String,
    capability: CapabilityName,
    unit: Schema.Option(Schema.String),
  },
  SucceededRevokeCapability: { account: AccountRow },
  FailedRevokeCapability: { failure: Failure },
  ClickedIssueReset: { accountId: Schema.String, name: Schema.String },
  SucceededIssueReset: { name: Schema.String, link: GivenLink },
  FailedIssueReset: { failure: Failure },
  ClickedCopyLink: {},
  CompletedCopyLink: {},
  FailedCopyLink: {},
  ClickedDismissLink: {},
})
export type Message = typeof Message.Type

// COMMAND

export const LoadAdmin = Command.define('LoadAdmin', {
  messages: [Message.SucceededLoadAdmin, Message.FailedLoadAdmin],
  execute: withQuoroom(client =>
    Effect.all({ units: client.ListUnits(), accounts: client.ListAccounts() }),
  ).pipe(
    Effect.map(({ units, accounts }) =>
      Message.SucceededLoadAdmin({ units, accounts }),
    ),
    Effect.catch(error =>
      Effect.succeed(Message.FailedLoadAdmin({ failure: failureOf(error) })),
    ),
  ),
})

export const CreateUnit = Command.define('CreateUnit', {
  args: { name: Schema.String, code: Schema.String },
  messages: [Message.SucceededCreateUnit, Message.FailedCreateUnit],
  execute: ({ name, code }) =>
    withQuoroom(client => client.CreateUnit({ name, code })).pipe(
      Effect.map(unit => Message.SucceededCreateUnit({ unit })),
      Effect.catch(error =>
        Effect.succeed(Message.FailedCreateUnit({ failure: failureOf(error) })),
      ),
    ),
})

export const GrantCapability = Command.define('GrantCapability', {
  args: {
    email: Schema.String,
    name: Schema.Option(Schema.String),
    capability: CapabilityName,
    unit: Schema.Option(Schema.String),
  },
  messages: [Message.SucceededGrantCapability, Message.FailedGrantCapability],
  execute: ({ email, name, capability, unit }) =>
    withQuoroom(client =>
      client.GrantCapability({
        email,
        capability,
        ...Option.match(name, {
          onNone: () => ({}),
          onSome: value => ({ name: value }),
        }),
        ...Option.match(unit, {
          onNone: () => ({}),
          onSome: value => ({ unit: value }),
        }),
      }),
    ).pipe(
      Effect.map(result =>
        Message.SucceededGrantCapability({
          account: result.account,
          link: maybeGivenLinkOf(result.link),
        }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedGrantCapability({ failure: failureOf(error) }),
        ),
      ),
    ),
})

export const RevokeCapability = Command.define('RevokeCapability', {
  args: {
    accountId: Schema.String,
    capability: CapabilityName,
    unit: Schema.Option(Schema.String),
  },
  messages: [Message.SucceededRevokeCapability, Message.FailedRevokeCapability],
  execute: ({ accountId, capability, unit }) =>
    withQuoroom(client =>
      client.RevokeCapability({
        accountId,
        capability,
        ...Option.match(unit, {
          onNone: () => ({}),
          onSome: value => ({ unit: value }),
        }),
      }),
    ).pipe(
      Effect.map(account => Message.SucceededRevokeCapability({ account })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedRevokeCapability({ failure: failureOf(error) }),
        ),
      ),
    ),
})

export const IssueReset = Command.define('IssueReset', {
  args: { accountId: Schema.String, name: Schema.String },
  messages: [Message.SucceededIssueReset, Message.FailedIssueReset],
  execute: ({ accountId, name }) =>
    withQuoroom(client => client.IssueReset({ accountId })).pipe(
      Effect.map(link =>
        Message.SucceededIssueReset({ name, link: givenLinkOf(link) }),
      ),
      Effect.catch(error =>
        Effect.succeed(Message.FailedIssueReset({ failure: failureOf(error) })),
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
  commands: [LoadAdmin()],
})

// UPDATE

const replaceAccount = (
  accounts: ReadonlyArray<AccountRow>,
  account: AccountRow,
): ReadonlyArray<AccountRow> =>
  Array.some(accounts, existing => existing.id === account.id)
    ? Array.map(accounts, existing =>
        existing.id === account.id ? account : existing,
      )
    : Array.append(accounts, account)

const linkOf = (
  model: Model,
  name: string,
  link: GivenLink,
): Option.Option<IssuedLink> =>
  Option.some(issuedLinkOf(model.origin, name, link))

const clearedNotices = (model: Model): Model =>
  modifyFields(model, {
    maybeNotice: () => Option.none(),
    maybeActionFailure: () => Option.none(),
  })

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadAdmin: ({ units, accounts }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        units: () => units,
        accounts: () => accounts,
        grantUnit: unit => (unit === '' ? (units[0]?.id ?? '') : unit),
      }),
    }),
    FailedLoadAdmin: ({ failure }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Failed({ failure }),
      }),
    }),
    ClickedRetryLoad: () => enter(model, model.origin),
    UpdatedUnitName: ({ value }) => ({
      model: modifyFields(model, {
        unitName: () => value,
        unitForm: () => FormState.Editing(),
      }),
    }),
    UpdatedUnitCode: ({ value }) => ({
      model: modifyFields(model, {
        unitCode: () => value,
        unitForm: () => FormState.Editing(),
      }),
    }),
    SubmittedUnit: () => submitUnit(model),
    SucceededCreateUnit: ({ unit }) => ({
      model: modifyFields(model, {
        units: units => Array.append(units, unit),
        unitName: () => '',
        unitCode: () => '',
        unitForm: () => FormState.Editing(),
        grantUnit: current => (current === '' ? unit.id : current),
      }),
    }),
    FailedCreateUnit: ({ failure }) => ({
      model: modifyFields(model, {
        unitForm: () => FormState.Failed({ failure }),
      }),
    }),
    UpdatedGrantEmail: ({ value }) => ({
      model: modifyFields(model, {
        grantEmail: () => value,
        grantForm: () => FormState.Editing(),
      }),
    }),
    UpdatedGrantName: ({ value }) => ({
      model: modifyFields(model, {
        grantName: () => value,
        grantForm: () => FormState.Editing(),
      }),
    }),
    SelectedGrantCapability: ({ value }) => ({
      model: Schema.is(CapabilityName)(value)
        ? modifyFields(model, {
            grantCapability: () => value,
            grantForm: () => FormState.Editing(),
          })
        : model,
    }),
    SelectedGrantUnit: ({ value }) => ({
      model: modifyFields(model, {
        grantUnit: () => value,
        grantForm: () => FormState.Editing(),
      }),
    }),
    SubmittedGrant: () => submitGrant(model),
    SucceededGrantCapability: ({ account, link }) => ({
      model: modifyFields(clearedNotices(model), {
        accounts: accounts => replaceAccount(accounts, account),
        grantEmail: () => '',
        grantName: () => '',
        grantForm: () => FormState.Editing(),
        maybeLink: () =>
          Option.flatMap(link, given => linkOf(model, account.name, given)),
        maybeNotice: () =>
          Option.isNone(link)
            ? Option.some(
                `${account.name} already had an account, so no link was made. They now hold the capability.`,
              )
            : Option.none(),
      }),
    }),
    FailedGrantCapability: ({ failure }) => ({
      model: modifyFields(model, {
        grantForm: () => FormState.Failed({ failure }),
      }),
    }),
    ClickedRevoke: ({ accountId, capability, unit }) => ({
      model: clearedNotices(model),
      commands: [RevokeCapability({ accountId, capability, unit })],
    }),
    SucceededRevokeCapability: ({ account }) => ({
      model: modifyFields(model, {
        accounts: accounts => replaceAccount(accounts, account),
      }),
    }),
    FailedRevokeCapability: ({ failure }) => ({
      model: modifyFields(model, {
        maybeActionFailure: () => Option.some(failure),
      }),
    }),
    ClickedIssueReset: ({ accountId, name }) => ({
      model: clearedNotices(model),
      commands: [IssueReset({ accountId, name })],
    }),
    SucceededIssueReset: ({ name, link }) => ({
      model: modifyFields(model, {
        maybeLink: () => linkOf(model, name, link),
      }),
    }),
    FailedIssueReset: ({ failure }) => ({
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

const submitUnit = (model: Model): Update.Return<Model, Message> => {
  if (isSubmitting(model.unitForm)) {
    return { model }
  }
  const name = model.unitName.trim()
  const code = model.unitCode.trim()
  if (name === '') {
    return {
      model: modifyFields(model, {
        unitForm: () => FormState.Invalid({ message: 'Give the unit a name.' }),
      }),
    }
  }
  if (!UNIT_CODE_FORMAT.test(code)) {
    return {
      model: modifyFields(model, {
        unitForm: () =>
          FormState.Invalid({
            message:
              'The code is up to 16 letters, digits or hyphens, starting with a letter or digit.',
          }),
      }),
    }
  }
  return {
    model: modifyFields(model, { unitForm: () => FormState.Submitting() }),
    commands: [CreateUnit({ name, code })],
  }
}

const submitGrant = (model: Model): Update.Return<Model, Message> => {
  if (isSubmitting(model.grantForm)) {
    return { model }
  }
  const email = model.grantEmail.trim()
  const invalid = (message: string): Update.Return<Model, Message> => ({
    model: modifyFields(model, {
      grantForm: () => FormState.Invalid({ message }),
    }),
  })
  if (!EMAIL_FORMAT.test(email)) {
    return invalid('Write the e-mail address of the person.')
  }
  if (model.grantCapability === 'author' && model.grantUnit === '') {
    return invalid('Create a unit first, then choose it.')
  }
  const name = model.grantName.trim()
  return {
    model: modifyFields(model, { grantForm: () => FormState.Submitting() }),
    commands: [
      GrantCapability({
        email,
        name: name === '' ? Option.none() : Option.some(name),
        capability: model.grantCapability,
        unit:
          model.grantCapability === 'author'
            ? Option.some(model.grantUnit)
            : Option.none(),
      }),
    ],
  }
}

// VIEW

export const capabilityLabel = (
  capability: typeof CapabilityName.Type,
  unitName: Option.Option<string>,
): string => {
  if (capability === 'admin') {
    return 'Administrator'
  }
  if (capability === 'template_editor') {
    return 'Template editor'
  }
  return `Author in ${Option.getOrElse(unitName, () => 'a unit')}`
}

const CAPABILITY_CHOICES = [
  { value: 'author', label: 'Author in a unit' },
  { value: 'template_editor', label: 'Template editor' },
  { value: 'admin', label: 'Administrator' },
]

const unitNameOf = (
  units: ReadonlyArray<Unit>,
  unitId: string | undefined,
): Option.Option<string> =>
  pipe(
    units,
    Array.findFirst(unit => unit.id === unitId),
    Option.map(unit => unit.name),
  )

const accountRow = (
  model: Model,
  account: AccountRow,
  h: HtmlBuilder<Message>,
) =>
  h.keyed('li')(
    account.id,
    [h.Class('flex flex-col gap-3 py-4')],
    [
      h.div(
        [h.Class('flex flex-col')],
        [
          h.p([h.Class('text-lg font-medium text-msf-black')], [account.name]),
          h.p([h.Class('text-base text-msf-grey')], [account.email]),
          h.p(
            [h.Class('text-sm text-msf-grey')],
            [
              account.passwordSetAt === undefined
                ? 'Not activated yet'
                : `Password set ${formatMoment(account.passwordSetAt)}`,
            ],
          ),
        ],
      ),
      Array.match(account.grants, {
        onEmpty: () =>
          h.p([h.Class('text-sm text-msf-grey')], ['No capabilities.']),
        onNonEmpty: grants =>
          h.ul(
            [
              h.AriaLabel(`Capabilities of ${account.name}`),
              h.Class('flex flex-wrap gap-2'),
            ],
            Array.map(grants, grant => {
              const label = capabilityLabel(
                grant.capability,
                unitNameOf(model.units, grant.unit),
              )
              return h.keyed('li')(
                `${grant.capability}:${grant.unit ?? ''}`,
                [h.Class('flex items-center gap-2 bg-msf-mist pl-3 text-base')],
                [
                  label,
                  smallButton(
                    h,
                    'Remove',
                    Message.ClickedRevoke({
                      accountId: account.id,
                      capability: grant.capability,
                      unit: Option.fromNullishOr(grant.unit),
                    }),
                    Option.some(`Remove ${label} from ${account.name}`),
                  ),
                ],
              )
            }),
          ),
      }),
      h.div(
        [],
        [
          smallButton(
            h,
            'Issue reset link',
            Message.ClickedIssueReset({
              accountId: account.id,
              name: account.name,
            }),
            Option.some(`Issue reset link for ${account.name}`),
          ),
        ],
      ),
    ],
  )

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const loaded = () =>
    pageShell(
      h,
      'Administration',
      'Administration',
      'Create the units, and decide who may do what. Nobody is given a password: a new person gets a one-time link, which you hand over.',
      [
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
        panel(h, 'Units', [
          Array.match(model.units, {
            onEmpty: () =>
              h.p([h.Class('text-lg text-msf-grey')], ['No units yet.']),
            onNonEmpty: units =>
              h.ul(
                [
                  h.AriaLabel('Units'),
                  h.Class(
                    'flex flex-col divide-y divide-msf-line border-y border-msf-line',
                  ),
                ],
                Array.map(units, unit =>
                  h.keyed('li')(
                    unit.id,
                    [
                      h.Class(
                        'flex items-baseline justify-between gap-4 py-3 text-lg',
                      ),
                    ],
                    [
                      h.span([h.Class('font-medium')], [unit.name]),
                      h.span([h.Class('text-base text-msf-grey')], [unit.code]),
                    ],
                  ),
                ),
              ),
          }),
          h.form(
            [
              h.Class('flex max-w-md flex-col gap-4'),
              h.AriaLabel('New unit'),
              h.OnSubmit(Message.SubmittedUnit()),
            ],
            [
              textField(h, {
                id: 'unit-name',
                label: 'Unit name',
                value: model.unitName,
                onInput: value => Message.UpdatedUnitName({ value }),
              }),
              textField(h, {
                id: 'unit-code',
                label: 'Unit code',
                hint: 'Short, for example OCA.',
                value: model.unitCode,
                onInput: value => Message.UpdatedUnitCode({ value }),
              }),
              formStatus(h, model.unitForm, 'Creating the unit.'),
              submitButton(
                h,
                'Create unit',
                isSubmitting(model.unitForm),
                'Creating…',
              ),
            ],
          ),
        ]),
        panel(
          h,
          'Give a capability',
          [
            h.form(
              [
                h.Class('flex max-w-md flex-col gap-4'),
                h.AriaLabel('Give a capability'),
                h.OnSubmit(Message.SubmittedGrant()),
              ],
              [
                textField(h, {
                  id: 'grant-email',
                  label: 'E-mail',
                  type: 'email',
                  autocomplete: 'off',
                  value: model.grantEmail,
                  onInput: value => Message.UpdatedGrantEmail({ value }),
                }),
                textField(h, {
                  id: 'grant-name',
                  label: 'Name',
                  hint: 'Needed for a new person. Ignored for someone who already has an account.',
                  value: model.grantName,
                  onInput: value => Message.UpdatedGrantName({ value }),
                }),
                selectField(
                  h,
                  'grant-capability',
                  'Capability',
                  model.grantCapability,
                  CAPABILITY_CHOICES,
                  value => Message.SelectedGrantCapability({ value }),
                ),
                model.grantCapability === 'author'
                  ? selectField(
                      h,
                      'grant-unit',
                      'Unit',
                      model.grantUnit,
                      Array.map(model.units, unit => ({
                        value: unit.id,
                        label: `${unit.name} (${unit.code})`,
                      })),
                      value => Message.SelectedGrantUnit({ value }),
                    )
                  : h.empty,
                formStatus(h, model.grantForm, 'Saving.'),
                submitButton(
                  h,
                  'Give capability',
                  isSubmitting(model.grantForm),
                  'Saving…',
                ),
              ],
            ),
          ],
          Option.some(
            'A person with no account gets one, and a one-time link to open it. Someone who already has an account only gets the capability.',
          ),
        ),
        panel(h, 'Accounts', [
          Array.match(model.accounts, {
            onEmpty: () =>
              h.p([h.Class('text-lg text-msf-grey')], ['No accounts.']),
            onNonEmpty: accounts =>
              h.ul(
                [
                  h.AriaLabel('Accounts'),
                  h.Class(
                    'flex flex-col divide-y divide-msf-line border-y border-msf-line',
                  ),
                ],
                Array.map(accounts, account => accountRow(model, account, h)),
              ),
          }),
        ]),
      ],
    )
  return LoadState.match(model.load, {
    Loaded: loaded,
    Loading: () =>
      pageShell(h, 'Administration', 'Administration', '', [
        loadingText(h, 'Loading.'),
      ]),
    Failed: ({ failure }) =>
      pageShell(h, 'Administration', 'Administration', '', [
        failureAlert(h, failure),
        smallButton(h, 'Try again', Message.ClickedRetryLoad()),
      ]),
  })
})
