import { clsx } from 'clsx'
import { Array, Effect, Option, Order, Schema, pipe } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import { AccountRow, CapabilityName, Unit } from '@quoroom/domain'

import { focusRing } from '../style'
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

// NOTE: The People screen: every account, in a folder per unit (its authors
// and its registered reviewers) and one for those with no unit, each with a
// toggle per capability that saves at once. A unit's reviewers are shown
// greyed, with toggles only for what they already hold. A link is shown once,
// to hand over (D13); it is not kept anywhere once dismissed.

export const UNIT_CODE_FORMAT = /^[A-Za-z0-9][A-Za-z0-9-]{0,15}$/
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+$/
const NO_UNIT_FOLDER = 'none'

export const DeploymentCapability = Schema.Literals([
  'people',
  'theme',
  'template_editor',
])
export type DeploymentCapability = typeof DeploymentCapability.Type

const DEPLOYMENT_CAPABILITIES: ReadonlyArray<DeploymentCapability> = [
  'people',
  'theme',
  'template_editor',
]

export const capabilityLabel = (capability: DeploymentCapability): string =>
  capability === 'people'
    ? 'People'
    : capability === 'theme'
      ? 'Theme'
      : 'Templates'

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
  collapsed: Schema.Array(Schema.String),
  pending: Schema.Array(Schema.String),
  unitName: Schema.String,
  unitCode: Schema.String,
  unitForm: FormState,
  personEmail: Schema.String,
  personName: Schema.String,
  personUnit: Schema.String,
  personCapabilities: Schema.Array(DeploymentCapability),
  personForm: FormState,
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
  collapsed: [],
  pending: [],
  unitName: '',
  unitCode: '',
  unitForm: FormState.Editing(),
  personEmail: '',
  personName: '',
  personUnit: '',
  personCapabilities: [],
  personForm: FormState.Editing(),
  maybeLink: Option.none(),
  maybeNotice: Option.none(),
  maybeActionFailure: Option.none(),
})

const NewGrant = Schema.Struct({
  capability: CapabilityName,
  unit: Schema.Option(Schema.String),
})
type NewGrant = typeof NewGrant.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadPeople: {
    units: Schema.Array(Unit),
    accounts: Schema.Array(AccountRow),
  },
  FailedLoadPeople: { failure: Failure },
  ClickedRetryLoad: {},
  ClickedFolder: { key: Schema.String },
  ClickedToggle: {
    accountId: Schema.String,
    capability: CapabilityName,
    unit: Schema.Option(Schema.String),
  },
  SucceededChangeCapability: { key: Schema.String, account: AccountRow },
  FailedChangeCapability: { key: Schema.String, failure: Failure },
  UpdatedUnitName: { value: Schema.String },
  UpdatedUnitCode: { value: Schema.String },
  SubmittedUnit: {},
  SucceededCreateUnit: { unit: Unit },
  FailedCreateUnit: { failure: Failure },
  UpdatedPersonEmail: { value: Schema.String },
  UpdatedPersonName: { value: Schema.String },
  SelectedPersonUnit: { value: Schema.String },
  ToggledPersonCapability: { capability: DeploymentCapability },
  SubmittedPerson: {},
  SucceededAddPerson: {
    account: AccountRow,
    link: Schema.Option(GivenLink),
    missed: Schema.Array(NewGrant),
  },
  FailedAddPerson: { failure: Failure },
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

const unitField = (unit: Option.Option<string>) =>
  Option.match(unit, {
    onNone: () => ({}),
    onSome: value => ({ unit: value }),
  })

export const LoadPeople = Command.define('LoadPeople', {
  messages: [Message.SucceededLoadPeople, Message.FailedLoadPeople],
  execute: withQuoroom(client =>
    Effect.all({ units: client.ListUnits(), accounts: client.ListAccounts() }),
  ).pipe(
    Effect.map(({ units, accounts }) =>
      Message.SucceededLoadPeople({ units, accounts }),
    ),
    Effect.catch(error =>
      Effect.succeed(Message.FailedLoadPeople({ failure: failureOf(error) })),
    ),
  ),
})

export const ChangeCapability = Command.define('ChangeCapability', {
  args: {
    key: Schema.String,
    accountId: Schema.String,
    email: Schema.String,
    capability: CapabilityName,
    unit: Schema.Option(Schema.String),
    isGranting: Schema.Boolean,
  },
  messages: [
    Message.SucceededChangeCapability,
    Message.FailedChangeCapability,
  ],
  execute: ({ key, accountId, email, capability, unit, isGranting }) =>
    withQuoroom(client =>
      isGranting
        ? client
            .GrantCapability({ email, capability, ...unitField(unit) })
            .pipe(Effect.map(result => result.account))
        : client.RevokeCapability({ accountId, capability, ...unitField(unit) }),
    ).pipe(
      Effect.map(account =>
        Message.SucceededChangeCapability({ key, account }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedChangeCapability({ key, failure: failureOf(error) }),
        ),
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

// NOTE: The first grant makes the account (and its link) for a new e-mail;
// the others are given to it one by one, by e-mail.
export const AddPerson = Command.define('AddPerson', {
  args: {
    email: Schema.String,
    name: Schema.String,
    first: NewGrant,
    rest: Schema.Array(NewGrant),
  },
  messages: [Message.SucceededAddPerson, Message.FailedAddPerson],
  execute: ({ email, name, first, rest }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        // NOTE: the name is optional (ignored for an existing account), and
        // an empty one is not a name.
        const created = yield* client.GrantCapability({
          email,
          ...(name === '' ? {} : { name }),
          capability: first.capability,
          ...unitField(first.unit),
        })
        // NOTE: a grant that fails is kept in `missed`, so the link from the
        // first grant is still given and the others can be added again.
        const outcomes = yield* Effect.forEach(rest, grant =>
          client
            .GrantCapability({
              email,
              capability: grant.capability,
              ...unitField(grant.unit),
            })
            .pipe(
              Effect.map(({ account }) => ({ grant, account })),
              Effect.catch(() =>
                Effect.succeed({ grant, account: undefined }),
              ),
            ),
        )
        return {
          account: Array.reduce(
            outcomes,
            created.account,
            (latest, outcome) => outcome.account ?? latest,
          ),
          link: maybeGivenLinkOf(created.link),
          missed: Array.map(
            Array.filter(outcomes, outcome => outcome.account === undefined),
            outcome => outcome.grant,
          ),
        }
      }),
    ).pipe(
      Effect.map(({ account, link, missed }) =>
        Message.SucceededAddPerson({ account, link, missed }),
      ),
      Effect.catch(error =>
        Effect.succeed(Message.FailedAddPerson({ failure: failureOf(error) })),
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
    pending: () => [],
  }),
  commands: [LoadPeople()],
})

// QUERIES

export const toggleKey = (
  accountId: string,
  capability: string,
  unit: Option.Option<string>,
): string =>
  `${accountId}|${capability}|${Option.getOrElse(unit, () => '')}`

const holds = (
  account: AccountRow,
  capability: string,
  unit: Option.Option<string>,
): boolean =>
  Array.some(
    account.grants,
    grant =>
      grant.capability === capability &&
      (grant.unit ?? '') === Option.getOrElse(unit, () => ''),
  )

const isAuthorIn = (account: AccountRow, unitId: string): boolean =>
  holds(account, 'author', Option.some(unitId))

const byName: Order.Order<AccountRow> = Order.mapInput(
  Order.String,
  (account: AccountRow) => account.name,
)

export type Folder = Readonly<{
  key: string
  heading: string
  maybeUnit: Option.Option<Unit>
  accounts: ReadonlyArray<AccountRow>
}>

// NOTE: A unit's folder holds its authors and its registered reviewers; a
// person in two units is in both. Whoever is in no unit is in the last one.
export const foldersOf = (model: Model): ReadonlyArray<Folder> => {
  const unitFolders = Array.map(
    model.units,
    (unit): Folder => ({
      key: `unit:${unit.id}`,
      heading: `${unit.name} (${unit.code})`,
      maybeUnit: Option.some(unit),
      accounts: pipe(
        model.accounts,
        Array.filter(
          account =>
            isAuthorIn(account, unit.id) ||
            Array.contains(account.reviewerIn, unit.id),
        ),
        Array.sort(byName),
      ),
    }),
  )
  const unitIds = Array.map(model.units, unit => unit.id)
  const unplaced = pipe(
    model.accounts,
    Array.filter(
      account =>
        !Array.some(unitIds, unitId => isAuthorIn(account, unitId)) &&
        !Array.some(account.reviewerIn, unitId =>
          Array.contains(unitIds, unitId),
        ),
    ),
    Array.sort(byName),
  )
  return Array.isReadonlyArrayEmpty(unplaced)
    ? unitFolders
    : Array.append(unitFolders, {
        key: NO_UNIT_FOLDER,
        heading: 'No unit',
        maybeUnit: Option.none(),
        accounts: unplaced,
      })
}

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

const grantLabel = (model: Model, grant: NewGrant): string =>
  Option.match(grant.unit, {
    onNone: () =>
      grant.capability === 'author'
        ? 'Reports in a unit'
        : capabilityLabel(grant.capability),
    onSome: unitId =>
      Option.match(Array.findFirst(model.units, unit => unit.id === unitId), {
        onNone: () => 'Reports in a unit',
        onSome: unit => `Reports in ${unit.name}`,
      }),
  })

const clearedNotices = (model: Model): Model =>
  modifyFields(model, {
    maybeNotice: () => Option.none(),
    maybeActionFailure: () => Option.none(),
  })

const withoutPending = (model: Model, key: string): Model =>
  modifyFields(model, {
    pending: pending => Array.filter(pending, existing => existing !== key),
  })

const toggle = (
  model: Model,
  accountId: string,
  capability: typeof CapabilityName.Type,
  unit: Option.Option<string>,
): Update.Return<Model, Message> => {
  const key = toggleKey(accountId, capability, unit)
  return Option.match(
    Array.findFirst(model.accounts, account => account.id === accountId),
    {
      onNone: () => ({ model }),
      onSome: account =>
        Array.contains(model.pending, key)
          ? { model }
          : {
              model: modifyFields(clearedNotices(model), {
                pending: pending => Array.append(pending, key),
              }),
              commands: [
                ChangeCapability({
                  key,
                  accountId,
                  email: account.email,
                  capability,
                  unit,
                  isGranting: !holds(account, capability, unit),
                }),
              ],
            },
    },
  )
}

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadPeople: ({ units, accounts }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        units: () => units,
        accounts: () => accounts,
      }),
    }),
    FailedLoadPeople: ({ failure }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Failed({ failure }),
      }),
    }),
    ClickedRetryLoad: () => enter(model, model.origin),
    ClickedFolder: ({ key }) => ({
      model: modifyFields(model, {
        collapsed: collapsed =>
          Array.contains(collapsed, key)
            ? Array.filter(collapsed, existing => existing !== key)
            : Array.append(collapsed, key),
      }),
    }),
    ClickedToggle: ({ accountId, capability, unit }) =>
      toggle(model, accountId, capability, unit),
    SucceededChangeCapability: ({ key, account }) => ({
      model: modifyFields(withoutPending(model, key), {
        accounts: accounts => replaceAccount(accounts, account),
      }),
    }),
    FailedChangeCapability: ({ key, failure }) => ({
      model: modifyFields(withoutPending(model, key), {
        maybeActionFailure: () => Option.some(failure),
      }),
    }),
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
      }),
    }),
    FailedCreateUnit: ({ failure }) => ({
      model: modifyFields(model, {
        unitForm: () => FormState.Failed({ failure }),
      }),
    }),
    UpdatedPersonEmail: ({ value }) => ({
      model: modifyFields(model, {
        personEmail: () => value,
        personForm: () => FormState.Editing(),
      }),
    }),
    UpdatedPersonName: ({ value }) => ({
      model: modifyFields(model, {
        personName: () => value,
        personForm: () => FormState.Editing(),
      }),
    }),
    SelectedPersonUnit: ({ value }) => ({
      model: modifyFields(model, {
        personUnit: () => value,
        personForm: () => FormState.Editing(),
      }),
    }),
    ToggledPersonCapability: ({ capability }) => ({
      model: modifyFields(model, {
        personCapabilities: chosen =>
          Array.contains(chosen, capability)
            ? Array.filter(chosen, existing => existing !== capability)
            : Array.append(chosen, capability),
        personForm: () => FormState.Editing(),
      }),
    }),
    SubmittedPerson: () => submitPerson(model),
    SucceededAddPerson: ({ account, link, missed }) => ({
      model: modifyFields(clearedNotices(model), {
        accounts: accounts => replaceAccount(accounts, account),
        personEmail: () => '',
        personName: () => '',
        personUnit: () => '',
        personCapabilities: () => [],
        personForm: () => FormState.Editing(),
        maybeLink: () =>
          Option.flatMap(link, given => linkOf(model, account.name, given)),
        maybeNotice: () =>
          Array.isReadonlyArrayNonEmpty(missed)
            ? Option.some(
                `Not given to ${account.name} yet: ${Array.map(missed, grant => grantLabel(model, grant)).join(', ')}. Tick them in the list to add them again.`,
              )
            : Option.isNone(link)
              ? Option.some(
                  `${account.name} already had an account, so no link was made. They now have what you chose.`,
                )
              : Option.none(),
      }),
    }),
    FailedAddPerson: ({ failure }) => ({
      model: modifyFields(model, {
        personForm: () => FormState.Failed({ failure }),
      }),
      commands: [LoadPeople()],
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

const chosenGrantsOf = (model: Model): ReadonlyArray<NewGrant> => [
  ...(model.personUnit === ''
    ? []
    : [{ capability: 'author' as const, unit: Option.some(model.personUnit) }]),
  ...pipe(
    DEPLOYMENT_CAPABILITIES,
    Array.filter(capability =>
      Array.contains(model.personCapabilities, capability),
    ),
    Array.map(capability => ({ capability, unit: Option.none<string>() })),
  ),
]

const submitPerson = (model: Model): Update.Return<Model, Message> => {
  if (isSubmitting(model.personForm)) {
    return { model }
  }
  const invalid = (message: string): Update.Return<Model, Message> => ({
    model: modifyFields(model, {
      personForm: () => FormState.Invalid({ message }),
    }),
  })
  const email = model.personEmail.trim()
  if (!EMAIL_FORMAT.test(email)) {
    return invalid('Write the e-mail address of the person.')
  }
  return Array.match(chosenGrantsOf(model), {
    onEmpty: () => invalid('Choose a unit or at least one of People, Theme and Templates.'),
    onNonEmpty: ([first, ...rest]) => ({
      model: modifyFields(model, { personForm: () => FormState.Submitting() }),
      commands: [AddPerson({ email, name: model.personName.trim(), first, rest })],
    }),
  })
}

// VIEW

const statusOf = (account: AccountRow): string =>
  !account.active
    ? 'Disabled'
    : account.passwordSetAt === undefined
      ? 'Invited, not activated yet'
      : 'Active'

const toggleBox = (
  model: Model,
  h: HtmlBuilder<Message>,
  folderKey: string,
  account: AccountRow,
  capability: typeof CapabilityName.Type,
  unit: Option.Option<string>,
  visibleLabel: string,
  accessibleLabel: string,
): Html => {
  const key = toggleKey(account.id, capability, unit)
  const isPending = Array.contains(model.pending, key)
  const isHeld = holds(account, capability, unit)
  const id = `toggle-${folderKey}-${key}`.replaceAll(/[^A-Za-z0-9_-]/g, '-')
  return h.label(
    [
      h.For(id),
      h.Class(
        clsx(
          'flex min-h-11 cursor-pointer items-center gap-2 text-base',
          isPending ? 'text-brand-grey' : 'text-brand-ink',
        ),
      ),
    ],
    [
      h.input([
        h.Id(id),
        h.Type('checkbox'),
        h.AriaLabel(accessibleLabel),
        h.Class('size-5 shrink-0 accent-brand-primary'),
        h.Checked(isPending ? !isHeld : isHeld),
        ...(isPending ? [h.Disabled(true), h.AriaBusy(true)] : []),
        h.OnClick(Message.ClickedToggle({ accountId: account.id, capability, unit })),
      ]),
      isPending ? `${visibleLabel} (saving…)` : visibleLabel,
    ],
  )
}

const personRow = (
  model: Model,
  h: HtmlBuilder<Message>,
  folder: Folder,
  account: AccountRow,
): Html => {
  const isReviewerHere = Option.match(folder.maybeUnit, {
    onNone: () => false,
    onSome: unit => !isAuthorIn(account, unit.id),
  })
  const deploymentToggles = pipe(
    DEPLOYMENT_CAPABILITIES,
    Array.filter(
      capability =>
        !isReviewerHere || holds(account, capability, Option.none()),
    ),
    Array.map(capability =>
            toggleBox(
              model,
              h,
              folder.key,
              account,
              capability,
              Option.none(),
              capabilityLabel(capability),
              `${capabilityLabel(capability)} for ${account.name}`,
            ),
          ),
  )
  const reportsToggle = Option.match(folder.maybeUnit, {
    onNone: () => [],
    onSome: unit =>
      isReviewerHere
        ? []
        : [
            toggleBox(
              model,
              h,
              folder.key,
              account,
              'author',
              Option.some(unit.id),
              'Reports in this unit',
              `Reports in ${unit.name} for ${account.name}`,
            ),
          ],
  })
  return h.keyed('li')(
    account.id,
    [
      h.Class(
        clsx(
          'flex flex-col gap-2 py-4',
          isReviewerHere ? 'text-brand-grey' : 'text-brand-ink',
        ),
      ),
    ],
    [
      h.div(
        [h.Class('flex flex-wrap items-baseline gap-x-3')],
        [
          h.p(
            [
              h.Class(
                clsx(
                  'text-lg font-medium',
                  isReviewerHere ? 'text-brand-grey' : 'text-brand-ink',
                ),
              ),
            ],
            [account.name],
          ),
          isReviewerHere
            ? h.span(
                [h.Class('bg-brand-mist px-2 text-sm text-brand-grey')],
                ['Reviewer'],
              )
            : h.empty,
        ],
      ),
      h.p([h.Class('text-base text-brand-grey')], [account.email]),
      h.p([h.Class('text-sm text-brand-grey')], [statusOf(account)]),
      Array.match([...deploymentToggles, ...reportsToggle], {
        onEmpty: () => h.empty,
        onNonEmpty: toggles =>
          h.div(
            [
              h.Role('group'),
              h.AriaLabel(`Permissions of ${account.name}`),
              h.Class('flex flex-wrap gap-x-6'),
            ],
            toggles,
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
}

const folderView = (
  model: Model,
  h: HtmlBuilder<Message>,
  folder: Folder,
): Html => {
  const isOpen = !Array.contains(model.collapsed, folder.key)
  const count = Array.length(folder.accounts)
  return h.keyed('section')(
    folder.key,
    [
      h.AriaLabel(folder.heading),
      h.DataAttribute('folder', folder.key),
      h.Class('flex flex-col border-b border-brand-line'),
    ],
    [
      h.h3(
        [],
        [
          h.button(
            [
              h.Type('button'),
              h.AriaExpanded(isOpen),
              h.Class(
                clsx(
                  'flex min-h-11 w-full cursor-pointer items-baseline justify-between gap-4 py-2 text-left text-xl font-black',
                  focusRing,
                ),
              ),
              h.OnClick(Message.ClickedFolder({ key: folder.key })),
            ],
            [
              `${isOpen ? '▾' : '▸'} ${folder.heading}`,
              h.span(
                [h.Class('text-base font-normal text-brand-grey')],
                [count === 1 ? '1 person' : `${count} people`],
              ),
            ],
          ),
        ],
      ),
      isOpen
        ? Array.match(folder.accounts, {
            onEmpty: () =>
              h.p(
                [h.Class('pb-4 text-base text-brand-grey')],
                ['Nobody in this unit yet.'],
              ),
            onNonEmpty: accounts =>
              h.ul(
                [
                  h.AriaLabel(`People in ${folder.heading}`),
                  h.Class('flex flex-col divide-y divide-brand-line'),
                ],
                Array.map(accounts, account =>
                  personRow(model, h, folder, account),
                ),
              ),
          })
        : h.empty,
    ],
  )
}

const addPersonPanel = (model: Model, h: HtmlBuilder<Message>): Html =>
  panel(
    h,
    'Add person',
    [
      h.form(
        [
          h.Class('flex max-w-md flex-col gap-4'),
          h.AriaLabel('Add person'),
          h.OnSubmit(Message.SubmittedPerson()),
        ],
        [
          textField(h, {
            id: 'person-email',
            label: 'E-mail',
            type: 'email',
            autocomplete: 'off',
            value: model.personEmail,
            onInput: value => Message.UpdatedPersonEmail({ value }),
          }),
          textField(h, {
            id: 'person-name',
            label: 'Name',
            hint: 'Needed for a new person. Ignored for someone who already has an account.',
            value: model.personName,
            onInput: value => Message.UpdatedPersonName({ value }),
          }),
          selectField(
            h,
            'person-unit',
            'Reports in unit',
            model.personUnit,
            [
              { value: '', label: 'No unit' },
              ...Array.map(model.units, unit => ({
                value: unit.id,
                label: `${unit.name} (${unit.code})`,
              })),
            ],
            value => Message.SelectedPersonUnit({ value }),
          ),
          ...Array.map(DEPLOYMENT_CAPABILITIES, capability =>
            checkboxField(
              h,
              `person-${capability}`,
              capabilityLabel(capability),
              Array.contains(model.personCapabilities, capability),
              Message.ToggledPersonCapability({ capability }),
            ),
          ),
          formStatus(h, model.personForm, 'Saving.'),
          submitButton(
            h,
            'Add person',
            isSubmitting(model.personForm),
            'Saving…',
          ),
        ],
      ),
    ],
    Option.some(
      'A person with no account gets one, and a one-time link to open it. Someone who already has an account only gets what you chose.',
    ),
  )

const newUnitPanel = (model: Model, h: HtmlBuilder<Message>): Html =>
  panel(h, 'New unit', [
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
        submitButton(h, 'Create unit', isSubmitting(model.unitForm), 'Creating…'),
      ],
    ),
  ])

const LEDE =
  'Everyone, by unit. A tick saves at once: People manages this page, Theme the look, Templates the templates, and Reports in a unit lets them write reports there. Nobody is given a password: a new person gets a one-time link, which you hand over.'

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const loaded = () =>
    pageShell(h, 'People', 'People', LEDE, [
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
            [h.Role('status'), h.Class('text-base font-medium text-brand-ink')],
            [notice],
          ),
      }),
      Option.match(model.maybeActionFailure, {
        onNone: () => h.empty,
        onSome: failure => failureAlert(h, failure),
      }),
      panel(h, 'Everyone', [
        Array.match(foldersOf(model), {
          onEmpty: () =>
            h.p([h.Class('text-lg text-brand-grey')], ['No units yet.']),
          onNonEmpty: folders =>
            h.div(
              [h.Class('flex flex-col border-t border-brand-line')],
              Array.map(folders, folder => folderView(model, h, folder)),
            ),
        }),
      ]),
      addPersonPanel(model, h),
      newUnitPanel(model, h),
    ])
  return LoadState.match(model.load, {
    Loaded: loaded,
    Loading: () =>
      pageShell(h, 'People', 'People', '', [loadingText(h, 'Loading.')]),
    Failed: ({ failure }) =>
      pageShell(h, 'People', 'People', '', [
        failureAlert(h, failure),
        smallButton(h, 'Try again', Message.ClickedRetryLoad()),
      ]),
  })
})
