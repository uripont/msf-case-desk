import {
  Array,
  Clock,
  Duration,
  Effect,
  Match,
  Option,
  Redacted,
  Result,
  Schema,
  Stream,
  pipe,
} from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import {
  Command,
  Dom,
  Http,
  Navigation,
  Runtime,
  Subscription,
  Update,
} from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest } from 'foldkit/navigation'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { Url, toString as urlToString } from 'foldkit/url'

import {
  AppConfig,
  CENTRES,
  CHANNELS,
  CONFIG_PATH,
  Case,
  CaseEntry,
  CaseId,
  ConfigLogo,
  DEFAULT_THEME,
  DEMO_START,
  FastTrackSignal,
  IMAGE_ROUTE,
  ImageChunkRead,
  MeView,
  RISKS,
  RuleSet,
  RuleSetScope,
  type RuntimeMode,
  SCOPES,
  type TriageRules,
  TriageRules as TriageRulesSchema,
  type TriagedCase,
  URGENCIES,
  prioritiseByCentre,
  rulesFor,
} from '@case-desk/domain'

import { ApiFailure, failureOf, withApi } from './api'
import {
  HeroLayout,
  LAYOUT_SETTLE_MS,
  NARROW_VIEWPORT_QUERY,
  heroLayoutForViewport,
  isAnimatedLayoutChange,
  markDomId,
} from './axisLayout'
import {
  EntryField,
  EntryForm,
  EntrySubmission,
  emptyEntryForm,
  entryOf,
  toggleSignal,
} from './entryForm'
import * as Account from './quoroom/account'
import * as Admin from './quoroom/admin'
import { withPublic, withQuoroom } from './quoroom/api'
import { Failure, failureOf as quoroomFailureOf } from './quoroom/failure'
import * as Comments from './quoroom/comments'
import * as History from './quoroom/history'
import * as Inbox from './quoroom/inbox'
import * as Link from './quoroom/link'
import * as Names from './quoroom/names'
import * as Publish from './quoroom/publish'
import * as Report from './quoroom/report'
import * as Review from './quoroom/review'
import * as Reports from './quoroom/reports'
import * as Share from './quoroom/share'
import * as Unit from './quoroom/unit'
import {
  AppRoute,
  originOf,
  pathOf,
  redactedFragmentOf,
  urlToAppRoute,
} from './route'
import {
  RulesField,
  RulesForm,
  RulesSubmission,
  rulesFormFor,
  rulesOfForm,
} from './rulesForm'

// MODEL

export const CentreFilter = Schema.Literals([
  'All',
  'OCA',
  'OCB',
  'OCBA',
  'OCG',
  'OCP',
])
export type CentreFilter = typeof CentreFilter.Type

export const CENTRE_FILTERS: ReadonlyArray<CentreFilter> = CentreFilter.literals

export const DeskLoad = defineTaggedUnion({
  Loading: {},
  Loaded: {},
  Failed: { failure: ApiFailure },
})
export type DeskLoad = typeof DeskLoad.Type

export const Session = defineTaggedUnion({
  Checking: {},
  SignedOut: {},
  SignedIn: { me: MeView },
})
export type Session = typeof Session.Type

export const LoginSubmission = defineTaggedUnion({
  NotSubmitted: {},
  Submitting: {},
  Rejected: { failure: Failure },
})
export type LoginSubmission = typeof LoginSubmission.Type

export const LoginForm = Schema.Struct({
  email: Schema.String,
  password: Schema.Redacted(Schema.String),
  submission: LoginSubmission,
})
export type LoginForm = typeof LoginForm.Type

export const ConfigLoad = defineTaggedUnion({
  Loading: {},
  Loaded: { config: AppConfig },
  Unavailable: {},
})
export type ConfigLoad = typeof ConfigLoad.Type

// NOTE: An address the author asked for while the report has edits that are
// not saved. The page asks first (stage 4 review): stay, wait for the save and
// then go, or go without it. Nothing leaves a report with unsaved edits
// silently.
export const Leaving = Schema.Struct({
  url: Url,
  fragment: Schema.optionalKey(Schema.Redacted(Schema.String)),
  isWaiting: Schema.Boolean,
})
export type Leaving = typeof Leaving.Type

export const LEAVE_HEADING_ID = 'leave-report-heading'

export const Model = Schema.Struct({
  maybeLeaving: Schema.Option(Leaving),
  route: AppRoute,
  config: ConfigLoad,
  maybeLogoSrc: Schema.Option(Schema.String),
  entryForm: EntryForm,
  rulesForm: RulesForm,
  session: Session,
  origin: Schema.String,
  maybeLink: Schema.Option(Link.Model),
  account: Account.Model,
  admin: Admin.Model,
  unit: Unit.Model,
  reports: Reports.Model,
  report: Report.Model,
  share: Share.Model,
  names: Names.Model,
  history: History.Model,
  inbox: Inbox.Model,
  review: Review.Model,
  comments: Comments.Model,
  publish: Publish.Model,
  loginForm: LoginForm,
  deskLoad: DeskLoad,
  ruleSets: Schema.Array(RuleSet),
  cases: Schema.Array(Case),
  now: Schema.Int,
  maybeSelectedCaseId: Schema.Option(CaseId),
  maybeHighlightedCaseId: Schema.Option(CaseId),
  maybeFocusedMarkId: Schema.Option(CaseId),
  heroLayout: HeroLayout,
  isDetailSheetOpen: Schema.Boolean,
  centreFilter: CentreFilter,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedCase: { caseId: CaseId },
  ClickedCloseDetail: {},
  EnteredCase: { caseId: CaseId },
  LeftCase: {},
  FocusedCaseMark: { caseId: CaseId },
  BlurredCaseMark: {},
  UpdatedHeroLayout: { layout: Schema.Literals(['Axis', 'Timeline']) },
  CompletedFocusCaseMark: {},
  CompletedFocusElement: {},
  SelectedCentreFilter: { centreFilter: CentreFilter },
  CompletedGetCurrentTime: { now: Schema.Int },
  UpdatedNow: { now: Schema.Int },
  SucceededLoadDesk: {
    cases: Schema.Array(Case),
    ruleSets: Schema.Array(RuleSet),
  },
  FailedLoadDesk: { failure: ApiFailure },
  ClickedRetryLoad: {},
  // NOTE: the address without its fragment, and the fragment (a link token)
  // apart and Redacted (`withoutFragment`, `entry.ts`).
  ClickedLink: {
    request: UrlRequest,
    fragment: Schema.optionalKey(Schema.Redacted(Schema.String)),
  },
  ChangedUrl: {
    url: Url,
    fragment: Schema.optionalKey(Schema.Redacted(Schema.String)),
  },
  ClickedStayOnReport: {},
  ClickedWaitToLeaveReport: {},
  ClickedLeaveReportUnsaved: {},
  CompletedPushUrl: {},
  CompletedReplaceUrl: {},
  CompletedLoadExternal: {},
  SucceededLoadConfig: { config: AppConfig },
  FailedLoadConfig: {},
  SucceededLoadLogo: { src: Schema.String },
  FailedLoadLogo: {},
  GotLinkMessage: { message: Link.Message },
  GotAccountMessage: { message: Account.Message },
  GotAdminMessage: { message: Admin.Message },
  GotUnitMessage: { message: Unit.Message },
  GotReportsMessage: { message: Reports.Message },
  GotReportMessage: { message: Report.Message },
  GotShareMessage: { message: Share.Message },
  GotNamesMessage: { message: Names.Message },
  GotHistoryMessage: { message: History.Message },
  GotInboxMessage: { message: Inbox.Message },
  GotReviewMessage: { message: Review.Message },
  GotCommentsMessage: { message: Comments.Message },
  GotPublishMessage: { message: Publish.Message },
  SucceededCheckSession: { me: MeView },
  FailedCheckSession: {},
  UpdatedLoginEmail: { value: Schema.String },
  UpdatedLoginPassword: { value: Schema.Redacted(Schema.String) },
  SubmittedLogin: {},
  SucceededSignIn: { me: MeView },
  FailedSignIn: { failure: Failure },
  ClickedSignOut: {},
  CompletedSignOut: {},
  UpdatedEntryField: { field: EntryField, value: Schema.String },
  ToggledEntrySignal: { signal: FastTrackSignal },
  SubmittedEntry: {},
  SucceededCreateCase: { created: Case },
  FailedCreateCase: { failure: ApiFailure },
  SelectedRulesScope: { scope: RuleSetScope },
  UpdatedRulesField: { field: RulesField, value: Schema.String },
  SubmittedRules: {},
  ClickedDiscardRules: {},
  SucceededPutRuleSet: { ruleSet: RuleSet },
  FailedPutRuleSet: { failure: ApiFailure },
})
export type Message = typeof Message.Type

// QUERIES

export const queueOf = (model: Model): ReadonlyArray<TriagedCase> =>
  prioritiseByCentre(model.ruleSets, model.cases, model.now)

export const rulesOf = (model: Model): TriageRules =>
  rulesFor(
    model.ruleSets,
    model.centreFilter === 'All' ? 'Default' : model.centreFilter,
  )

export const visibleQueueOf = (model: Model): ReadonlyArray<TriagedCase> =>
  pipe(
    queueOf(model),
    Array.filter(
      triaged =>
        model.centreFilter === 'All' ||
        triaged.triageCase.centre === model.centreFilter,
    ),
  )

export const maybeSelectedOf = (model: Model): Option.Option<TriagedCase> =>
  pipe(
    model.maybeSelectedCaseId,
    Option.flatMap(selectedId =>
      Array.findFirst(
        queueOf(model),
        triaged => triaged.triageCase.id === selectedId,
      ),
    ),
  )

export const overdueCountOf = (model: Model): number =>
  Array.filter(visibleQueueOf(model), triaged => triaged.sla._tag === 'Overdue')
    .length

export const dueSoonCountOf = (model: Model): number =>
  Array.filter(visibleQueueOf(model), triaged => triaged.sla._tag === 'DueSoon')
    .length

export const modeOf = (model: Model): RuntimeMode =>
  ConfigLoad.match<RuntimeMode>(model.config, {
    Loading: () => 'pilot',
    Loaded: ({ config }) => config.mode,
    Unavailable: () => 'pilot',
  })

export const themeOf = (model: Model) =>
  ConfigLoad.match(model.config, {
    Loading: () => DEFAULT_THEME,
    Loaded: ({ config }) => config.theme,
    Unavailable: () => DEFAULT_THEME,
  })

export const isConfigKnown = (model: Model): boolean =>
  !ConfigLoad.guards.Loading(model.config)

// INIT

const firstCaseIdOf = (model: Model): Option.Option<typeof CaseId.Type> =>
  pipe(
    queueOf(model),
    Array.head,
    Option.map(triaged => triaged.triageCase.id),
  )

const emptyLoginForm = LoginForm.make({
  email: '',
  password: Redacted.make(''),
  submission: LoginSubmission.NotSubmitted(),
})

export const initialModel = Model.make({
  maybeLeaving: Option.none(),
  route: AppRoute.Desk(),
  config: ConfigLoad.Loading(),
  maybeLogoSrc: Option.none(),
  entryForm: emptyEntryForm(DEMO_START),
  rulesForm: rulesFormFor([], 'Default'),
  session: Session.Checking(),
  origin: '',
  maybeLink: Option.none(),
  account: Account.initialModel,
  admin: Admin.initialModel,
  unit: Unit.initialModel,
  reports: Reports.initialModel,
  report: Report.initialModel,
  share: Share.initialModel,
  names: Names.initialModel,
  history: History.initialModel,
  inbox: Inbox.initialModel,
  review: Review.initialModel,
  comments: Comments.initialModel,
  publish: Publish.initialModel,
  loginForm: emptyLoginForm,
  deskLoad: DeskLoad.Loading(),
  ruleSets: [],
  cases: [],
  now: DEMO_START,
  maybeSelectedCaseId: Option.none(),
  maybeHighlightedCaseId: Option.none(),
  maybeFocusedMarkId: Option.none(),
  heroLayout: 'Responsive',
  isDetailSheetOpen: false,
  centreFilter: 'All',
})

const openingLink = (url: Url): Update.Return<Model, Message> =>
  startLink(initialModel, redactedFragmentOf(url))

export const init: Runtime.RoutingApplicationInit<Model, Message> = url => {
  const route = urlToAppRoute(url)
  const opened = AppRoute.guards.Link(route)
    ? openingLink(url)
    : { model: initialModel }
  return {
    model: modifyFields(opened.model, {
      route: () => route,
      origin: () => originOf(url),
    }),
    commands: [
      GetCurrentTime(),
      CheckSession(),
      LoadConfig(),
      ...(opened.commands ?? []),
    ],
  }
}

// COMMAND

export const PAGE_HEADING_ID = 'page-heading'

// NOTE: moving focus also scrolls the element into view, so a page change or
// a refused form shows the reader where to look, on a phone too.
export const FocusElement = Command.define('FocusElement', {
  args: { selector: Schema.String },
  messages: [Message.CompletedFocusElement],
  execute: ({ selector }) =>
    Dom.focus(selector, { makeFocusable: true }).pipe(
      Effect.catch(() => Effect.void),
      Effect.as(Message.CompletedFocusElement()),
    ),
})

const focusPageHeading = () => FocusElement({ selector: `#${PAGE_HEADING_ID}` })

export const FocusCaseMark = Command.define('FocusCaseMark', {
  args: { selector: Schema.String },
  messages: [Message.CompletedFocusCaseMark],
  execute: ({ selector }) =>
    Dom.focus(selector, { preventScroll: true }).pipe(
      Effect.catch(() => Effect.void),
      Effect.as(Message.CompletedFocusCaseMark()),
    ),
})

export const GetCurrentTime = Command.define('GetCurrentTime', {
  messages: [Message.CompletedGetCurrentTime],
  execute: Effect.map(Clock.currentTimeMillis, now =>
    Message.CompletedGetCurrentTime({ now }),
  ),
})

export const LoadDesk = Command.define('LoadDesk', {
  messages: [Message.SucceededLoadDesk, Message.FailedLoadDesk],
  execute: withApi(client =>
    Effect.all({
      cases: client.ListCases(),
      ruleSets: client.ListRuleSets(),
    }),
  ).pipe(
    Effect.map(({ cases, ruleSets }) =>
      Message.SucceededLoadDesk({ cases, ruleSets }),
    ),
    Effect.catch(error =>
      Effect.succeed(Message.FailedLoadDesk({ failure: failureOf(error) })),
    ),
  ),
})

// NOTE: A link is opened at `/link#<token>`. The token is read once from the
// fragment and the fragment is removed at once, so it is not left in the
// address bar, the history or a copied URL. It is only ever sent in a POST body.
export const PushUrl = Command.define('PushUrl', {
  args: { url: Schema.String },
  messages: [Message.CompletedPushUrl],
  execute: ({ url }) =>
    Navigation.pushUrl(url).pipe(Effect.as(Message.CompletedPushUrl())),
})

export const ReplaceUrl = Command.define('ReplaceUrl', {
  args: { url: Schema.String },
  messages: [Message.CompletedReplaceUrl],
  execute: ({ url }) =>
    Navigation.replaceUrl(url).pipe(Effect.as(Message.CompletedReplaceUrl())),
})

export const LoadExternal = Command.define('LoadExternal', {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) =>
    Navigation.load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
})

export const LoadConfig = Command.define('LoadConfig', {
  messages: [Message.SucceededLoadConfig, Message.FailedLoadConfig],
  execute: Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get(CONFIG_PATH)
    return yield* HttpClientResponse.schemaBodyJson(AppConfig)(response)
  }).pipe(
    Effect.map(config => Message.SucceededLoadConfig({ config })),
    Effect.catch(() => Effect.succeed(Message.FailedLoadConfig())),
    Effect.provide(Http.layer),
  ),
})

const bytesOfBase64 = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(base64)
  return Uint8Array.from({ length: binary.length }, (_, index) =>
    binary.charCodeAt(index),
  )
}

// NOTE: The logo is stored as base64 text in chunks (D5), each chunk the
// encoding of its own bytes, so the chunks are decoded one by one and joined
// as bytes. It is readable by a signed-in account only; for anyone else the
// request fails and the app shows no logo.
export const LoadLogo = Command.define('LoadLogo', {
  args: { logo: ConfigLogo },
  messages: [Message.SucceededLoadLogo, Message.FailedLoadLogo],
  execute: ({ logo }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const chunks = yield* Effect.forEach(
        Array.makeBy(logo.chunks, index => index),
        index =>
          client
            .get(
              `${IMAGE_ROUTE}/${encodeURIComponent(logo.id)}/${index}?context=theme`,
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(ImageChunkRead)),
              Effect.map(chunk => bytesOfBase64(chunk.base64)),
            ),
      )
      return URL.createObjectURL(new Blob(chunks, { type: logo.mime }))
    }).pipe(
      Effect.map(src => Message.SucceededLoadLogo({ src })),
      Effect.catch(() => Effect.succeed(Message.FailedLoadLogo())),
      Effect.provide(Http.layer),
    ),
})

export const CheckSession = Command.define('CheckSession', {
  messages: [Message.SucceededCheckSession, Message.FailedCheckSession],
  execute: withQuoroom(client => client.GetMe()).pipe(
    Effect.map(me => Message.SucceededCheckSession({ me })),
    Effect.catch(() => Effect.succeed(Message.FailedCheckSession())),
  ),
})

export const SignIn = Command.define('SignIn', {
  args: { email: Schema.String, password: Schema.Redacted(Schema.String) },
  messages: [Message.SucceededSignIn, Message.FailedSignIn],
  execute: ({ email, password }) =>
    withPublic(client =>
      client.SignIn({ email, password: Redacted.value(password) }),
    ).pipe(
      Effect.map(me => Message.SucceededSignIn({ me })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedSignIn({ failure: quoroomFailureOf(error) }),
        ),
      ),
    ),
})

export const SignOut = Command.define('SignOut', {
  messages: [Message.CompletedSignOut],
  execute: withQuoroom(client => client.SignOut()).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedSignOut()),
  ),
})

export const CreateCase = Command.define('CreateCase', {
  args: { entry: CaseEntry },
  messages: [Message.SucceededCreateCase, Message.FailedCreateCase],
  execute: ({ entry }) =>
    withApi(client => client.CreateCase({ entry })).pipe(
      Effect.map(created => Message.SucceededCreateCase({ created })),
      Effect.catch(error =>
        Effect.succeed(Message.FailedCreateCase({ failure: failureOf(error) })),
      ),
    ),
})

export const PutRuleSet = Command.define('PutRuleSet', {
  args: { scope: RuleSetScope, rules: TriageRulesSchema },
  messages: [Message.SucceededPutRuleSet, Message.FailedPutRuleSet],
  execute: ({ scope, rules }) =>
    withApi(client => client.PutRuleSet({ scope, rules })).pipe(
      Effect.map(ruleSet => Message.SucceededPutRuleSet({ ruleSet })),
      Effect.catch(error =>
        Effect.succeed(Message.FailedPutRuleSet({ failure: failureOf(error) })),
      ),
    ),
})

const withRulesField = (
  form: RulesForm,
  field: RulesField,
  value: string,
): RulesForm =>
  modifyFields(
    Match.value(field).pipe(
      Match.when('version', () => modifyFields(form, { version: () => value })),
      Match.when('p1MinScore', () =>
        modifyFields(form, { p1MinScore: () => value }),
      ),
      Match.when('p2MinScore', () =>
        modifyFields(form, { p2MinScore: () => value }),
      ),
      Match.when('fastTrackHours', () =>
        modifyFields(form, { fastTrackHours: () => value }),
      ),
      Match.when('targetP1', () =>
        modifyFields(form, { targetP1: () => value }),
      ),
      Match.when('targetP2', () =>
        modifyFields(form, { targetP2: () => value }),
      ),
      Match.when('targetP3', () =>
        modifyFields(form, { targetP3: () => value }),
      ),
      Match.exhaustive,
    ),
    { submission: () => RulesSubmission.Editing() },
  )

const submitRules = (model: Model): Update.Return<Model, Message> =>
  Result.match(rulesOfForm(model.rulesForm), {
    onFailure: errors => ({
      model: modifyFields(model, {
        rulesForm: form => modifyFields(form, { isShowingErrors: () => true }),
      }),
      commands: focusFirstInvalid(
        RULES_FIELD_ORDER,
        errors,
        field => `rules-${field}`,
      ),
    }),
    onSuccess: rules => ({
      model: modifyFields(model, {
        rulesForm: form =>
          modifyFields(form, { submission: () => RulesSubmission.Saving() }),
      }),
      commands: [PutRuleSet({ scope: model.rulesForm.scope, rules })],
    }),
  })

const isOneOf =
  <A extends string>(choices: ReadonlyArray<A>) =>
  (value: string): value is A =>
    choices.some(choice => choice === value)

const withEntryField = (
  form: EntryForm,
  field: EntryField,
  value: string,
): EntryForm =>
  Match.value(field).pipe(
    Match.when('centre', () =>
      isOneOf(CENTRES)(value)
        ? modifyFields(form, { centre: () => value })
        : form,
    ),
    Match.when('channel', () =>
      isOneOf(CHANNELS)(value)
        ? modifyFields(form, { channel: () => value })
        : form,
    ),
    Match.when('scope', () =>
      isOneOf(SCOPES)(value)
        ? modifyFields(form, { scope: () => value })
        : form,
    ),
    Match.when('risk', () =>
      isOneOf(RISKS)(value) ? modifyFields(form, { risk: () => value }) : form,
    ),
    Match.when('urgency', () =>
      isOneOf(URGENCIES)(value)
        ? modifyFields(form, { urgency: () => value })
        : form,
    ),
    Match.when('receivedAt', () =>
      modifyFields(form, { receivedAt: () => value }),
    ),
    Match.when('summary', () => modifyFields(form, { summary: () => value })),
    Match.when('details', () => modifyFields(form, { details: () => value })),
    Match.when('location', () => modifyFields(form, { location: () => value })),
    Match.when('reference', () =>
      modifyFields(form, { reference: () => value }),
    ),
    Match.when('fastTrackSignals', () => form),
    Match.exhaustive,
  )

const ENTRY_FIELD_ORDER: ReadonlyArray<EntryField> = [
  'summary',
  'receivedAt',
  'details',
  'location',
  'reference',
]

const RULES_FIELD_ORDER: ReadonlyArray<RulesField> = [
  'p1MinScore',
  'p2MinScore',
  'fastTrackHours',
  'targetP1',
  'targetP2',
  'targetP3',
  'version',
]

const focusFirstInvalid = <Field extends string>(
  order: ReadonlyArray<Field>,
  errors: Partial<Record<Field, string>>,
  idOf: (field: Field) => string,
) =>
  Option.match(
    Array.findFirst(order, field => errors[field] !== undefined),
    {
      onNone: () => [],
      onSome: field => [FocusElement({ selector: `#${idOf(field)}` })],
    },
  )

const submitEntry = (model: Model): Update.Return<Model, Message> =>
  Result.match(entryOf(model.entryForm, model.now), {
    onFailure: errors => ({
      model: modifyFields(model, {
        entryForm: form => modifyFields(form, { isShowingErrors: () => true }),
      }),
      commands: focusFirstInvalid(
        ENTRY_FIELD_ORDER,
        errors,
        field => `entry-${field}`,
      ),
    }),
    onSuccess: entry => ({
      model: modifyFields(model, {
        entryForm: form =>
          modifyFields(form, {
            submission: () => EntrySubmission.Submitting(),
          }),
      }),
      commands: [CreateCase({ entry })],
    }),
  })

const signedOut = (model: Model): Model =>
  modifyFields(model, {
    session: () => Session.SignedOut(),
    account: () => Account.initialModel,
    admin: () => Admin.initialModel,
    unit: () => Unit.initialModel,
    reports: () => Reports.initialModel,
    report: Report.cleared,
    share: Share.cleared,
    names: Names.cleared,
    history: History.cleared,
    inbox: Inbox.cleared,
    review: Review.cleared,
    comments: Comments.cleared,
    publish: Publish.cleared,
    maybeLeaving: () => Option.none(),
    deskLoad: () => DeskLoad.Loading(),
    cases: () => [],
    ruleSets: () => [],
    maybeSelectedCaseId: () => Option.none(),
    maybeHighlightedCaseId: () => Option.none(),
    isDetailSheetOpen: () => false,
    maybeLogoSrc: () => Option.none(),
  })

const loadingDesk = (model: Model, me: MeView): Model =>
  modifyFields(model, {
    session: () => Session.SignedIn({ me }),
    loginForm: () => emptyLoginForm,
    deskLoad: () => DeskLoad.Loading(),
  })

const foldLink = Update.foldChild({
  update: Link.update,
  read: (model: Model) => model.maybeLink,
  write: (model, nextLink) =>
    modifyFields(model, { maybeLink: () => Option.some(nextLink) }),
  toParentMessage: message => Message.GotLinkMessage({ message }),
  foldOutMessage: outMessage =>
    Link.OutMessage.match<Update.Step<Model, Message>>(outMessage, {
      SignedInWithLink:
        ({ me }) =>
        stepModel => {
          const home = modifyFields(loadingDesk(stepModel, me), {
            maybeLink: () => Option.none(),
            route: () => AppRoute.Desk(),
          })
          const resumed = resume(home)
          return {
            model: resumed.model,
            commands: [
              ReplaceUrl({ url: pathOf(AppRoute.Desk()) }),
              ...(resumed.commands ?? []),
            ],
          }
        },
    }),
})

const foldAccount = Update.foldChild({
  update: Account.update,
  read: (model: Model) => Option.some(model.account),
  write: (model, nextAccount) =>
    modifyFields(model, { account: () => nextAccount }),
  toParentMessage: message => Message.GotAccountMessage({ message }),
})

const foldAdmin = Update.foldChild({
  update: Admin.update,
  read: (model: Model) => Option.some(model.admin),
  write: (model, nextAdmin) => modifyFields(model, { admin: () => nextAdmin }),
  toParentMessage: message => Message.GotAdminMessage({ message }),
})

const foldUnit = Update.foldChild({
  update: Unit.update,
  read: (model: Model) => Option.some(model.unit),
  write: (model, nextUnit) => modifyFields(model, { unit: () => nextUnit }),
  toParentMessage: message => Message.GotUnitMessage({ message }),
})

const foldReports = Update.foldChild({
  update: Reports.update,
  read: (model: Model) => Option.some(model.reports),
  write: (model, nextReports) =>
    modifyFields(model, { reports: () => nextReports }),
  toParentMessage: message => Message.GotReportsMessage({ message }),
})

const foldReport = Update.foldChild({
  update: Report.update,
  read: (model: Model) => Option.some(model.report),
  write: (model, nextReport) =>
    modifyFields(model, { report: () => nextReport }),
  toParentMessage: message => Message.GotReportMessage({ message }),
})

const retryReportSave = Update.foldChildStep({
  update: Report.retrySave,
  read: (model: Model) => Option.some(model.report),
  write: (model, nextReport) =>
    modifyFields(model, { report: () => nextReport }),
  toParentMessage: message => Message.GotReportMessage({ message }),
})

const enterAccount = Update.foldChildStep({
  update: Account.enter,
  read: (model: Model) => Option.some(model.account),
  write: (model, nextAccount) =>
    modifyFields(model, { account: () => nextAccount }),
  toParentMessage: message => Message.GotAccountMessage({ message }),
})

const enterAdmin = (origin: string) =>
  Update.foldChildStep({
    update: (child: Admin.Model) => Admin.enter(child, origin),
    read: (model: Model) => Option.some(model.admin),
    write: (model, nextAdmin) =>
      modifyFields(model, { admin: () => nextAdmin }),
    toParentMessage: message => Message.GotAdminMessage({ message }),
  })

const enterUnit = (origin: string) =>
  Update.foldChildStep({
    update: (child: Unit.Model) => Unit.enter(child, origin),
    read: (model: Model) => Option.some(model.unit),
    write: (model, nextUnit) => modifyFields(model, { unit: () => nextUnit }),
    toParentMessage: message => Message.GotUnitMessage({ message }),
  })

const foldShare = Update.foldChild({
  update: Share.update,
  read: (model: Model) => Option.some(model.share),
  write: (model, nextShare) => modifyFields(model, { share: () => nextShare }),
  toParentMessage: message => Message.GotShareMessage({ message }),
})

const foldNames = Update.foldChild({
  update: Names.update,
  read: (model: Model) => Option.some(model.names),
  write: (model, nextNames) => modifyFields(model, { names: () => nextNames }),
  toParentMessage: message => Message.GotNamesMessage({ message }),
})

const foldHistory = Update.foldChild({
  update: History.update,
  read: (model: Model) => Option.some(model.history),
  write: (model, nextHistory) =>
    modifyFields(model, { history: () => nextHistory }),
  toParentMessage: message => Message.GotHistoryMessage({ message }),
})

const foldInbox = Update.foldChild({
  update: Inbox.update,
  read: (model: Model) => Option.some(model.inbox),
  write: (model, nextInbox) => modifyFields(model, { inbox: () => nextInbox }),
  toParentMessage: message => Message.GotInboxMessage({ message }),
})

const enterInbox = (origin: string) =>
  Update.foldChildStep({
    update: (child: Inbox.Model) => Inbox.enter(origin, child.generation + 1),
    read: (model: Model) => Option.some(model.inbox),
    write: (model, nextInbox) => modifyFields(model, { inbox: () => nextInbox }),
    toParentMessage: message => Message.GotInboxMessage({ message }),
  })

const foldReview = Update.foldChild({
  update: Review.update,
  read: (model: Model) => Option.some(model.review),
  write: (model, nextReview) =>
    modifyFields(model, { review: () => nextReview }),
  toParentMessage: message => Message.GotReviewMessage({ message }),
})

const enterReview = (origin: string, reportId: string, revision: number) =>
  Update.foldChildStep({
    update: (child: Review.Model) =>
      Review.enter(origin, reportId, revision, child.generation + 1),
    read: (model: Model) => Option.some(model.review),
    write: (model, nextReview) =>
      modifyFields(model, { review: () => nextReview }),
    toParentMessage: message => Message.GotReviewMessage({ message }),
  })

const foldComments = Update.foldChild({
  update: Comments.update,
  read: (model: Model) => Option.some(model.comments),
  write: (model, nextComments) =>
    modifyFields(model, { comments: () => nextComments }),
  toParentMessage: message => Message.GotCommentsMessage({ message }),
})

const enterComments = (origin: string, reportId: string) =>
  Update.foldChildStep({
    update: (child: Comments.Model) =>
      Comments.enter(origin, reportId, child.generation + 1),
    read: (model: Model) => Option.some(model.comments),
    write: (model, nextComments) =>
      modifyFields(model, { comments: () => nextComments }),
    toParentMessage: message => Message.GotCommentsMessage({ message }),
  })

const foldPublish = Update.foldChild({
  update: Publish.update,
  read: (model: Model) => Option.some(model.publish),
  write: (model, nextPublish) =>
    modifyFields(model, { publish: () => nextPublish }),
  toParentMessage: message => Message.GotPublishMessage({ message }),
})

const enterPublish = (origin: string, reportId: string) =>
  Update.foldChildStep({
    update: (child: Publish.Model) =>
      Publish.enter(origin, reportId, child.generation + 1),
    read: (model: Model) => Option.some(model.publish),
    write: (model, nextPublish) =>
      modifyFields(model, { publish: () => nextPublish }),
    toParentMessage: message => Message.GotPublishMessage({ message }),
  })

const enterReports = Update.foldChildStep({
  update: Reports.enter,
  read: (model: Model) => Option.some(model.reports),
  write: (model, nextReports) =>
    modifyFields(model, { reports: () => nextReports }),
  toParentMessage: message => Message.GotReportsMessage({ message }),
})

const enterShare = (origin: string, reportId: string) =>
  Update.foldChildStep({
    update: (child: Share.Model) =>
      Share.enter(origin, reportId, child.generation + 1),
    read: (model: Model) => Option.some(model.share),
    write: (model, nextShare) =>
      modifyFields(model, { share: () => nextShare }),
    toParentMessage: message => Message.GotShareMessage({ message }),
  })

const enterNames = (origin: string, reportId: string) =>
  Update.foldChildStep({
    update: (child: Names.Model) =>
      Names.enter(origin, reportId, child.generation + 1),
    read: (model: Model) => Option.some(model.names),
    write: (model, nextNames) =>
      modifyFields(model, { names: () => nextNames }),
    toParentMessage: message => Message.GotNamesMessage({ message }),
  })

const enterHistory = (
  origin: string,
  reportId: string,
  maybeDraft: Option.Option<number>,
) =>
  Update.foldChildStep({
    update: (child: History.Model) =>
      History.enter(origin, reportId, child.generation + 1, maybeDraft),
    read: (model: Model) => Option.some(model.history),
    write: (model, nextHistory) =>
      modifyFields(model, { history: () => nextHistory }),
    toParentMessage: message => Message.GotHistoryMessage({ message }),
  })

// NOTE: The same report entered again keeps its Model while that holds edits
// that are not saved; anything else starts over, as a new entry.
const enterReport = (origin: string, reportId: string) =>
  Update.foldChildStep({
    update: (child: Report.Model) =>
      child.reportId === reportId && Report.hasUnsavedEdits(child)
        ? { model: child }
        : Report.enter(origin, reportId, child.generation + 1),
    read: (model: Model) => Option.some(model.report),
    write: (model, nextReport) =>
      modifyFields(model, { report: () => nextReport }),
    toParentMessage: message => Message.GotReportMessage({ message }),
  })

const enterRoute = (
  model: Model,
  route: AppRoute,
): Update.Return<Model, Message> =>
  AppRoute.match<Update.Return<Model, Message>>(route, {
    Desk: () => ({ model }),
    NewCase: () => ({ model }),
    Rules: () => ({ model }),
    Account: () => enterAccount(model),
    Admin: () => enterAdmin(model.origin)(model),
    Unit: () => enterUnit(model.origin)(model),
    Reports: () => enterReports(model),
    Link: () => ({ model }),
    Report: ({ reportId }) => enterReport(model.origin, reportId)(model),
    Share: ({ reportId }) => enterShare(model.origin, reportId)(model),
    Names: ({ reportId }) => enterNames(model.origin, reportId)(model),
    Publish: ({ reportId }) => enterPublish(model.origin, reportId)(model),
    Drafts: ({ reportId }) =>
      enterHistory(model.origin, reportId, Option.none())(model),
    Draft: ({ reportId, draft }) =>
      enterHistory(model.origin, reportId, Option.some(draft))(model),
    Inbox: () => enterInbox(model.origin)(model),
    Comments: ({ reportId }) => enterComments(model.origin, reportId)(model),
    Revision: ({ reportId, revision }) =>
      enterReview(model.origin, reportId, revision)(model),
    NotFound: () => ({ model }),
  })

const logoCommands = (model: Model) =>
  ConfigLoad.match(model.config, {
    Loading: () => [],
    Unavailable: () => [],
    Loaded: ({ config }) =>
      config.logo === undefined || Option.isSome(model.maybeLogoSrc)
        ? []
        : [LoadLogo({ logo: config.logo })],
  })

// NOTE: A signed-in account and a known configuration are both needed before
// a screen can load its data: the triage desk only in the demo, never in a
// pilot, and the logo only for someone signed in. Whichever of the two
// arrives last starts it, so it runs once.
const resume = (model: Model): Update.Return<Model, Message> =>
  Session.match(model.session, {
    Checking: () => ({ model }),
    SignedOut: () => ({ model }),
    SignedIn: () => {
      if (!isConfigKnown(model)) {
        return { model }
      }
      const entered = enterRoute(model, model.route)
      const desk = modeOf(model) === 'demo' ? [LoadDesk()] : []
      return {
        model: entered.model,
        commands: [
          ...desk,
          ...logoCommands(model),
          ...(entered.commands ?? []),
        ],
      }
    },
  })

// NOTE: a link opened: a new model for the token (the old one, with whatever
// was typed in it, is replaced), and the fragment removed from the address.
const startLink = (
  model: Model,
  fragment: Option.Option<Redacted.Redacted<string>>,
): Update.Return<Model, Message> => {
  const linkInit = Link.init(fragment)
  return {
    model: modifyFields(model, {
      maybeLink: () => Option.some(linkInit.model),
    }),
    commands: [
      ...Command.mapMessages(linkInit.commands ?? [], message =>
        Message.GotLinkMessage({ message }),
      ),
      ReplaceUrl({ url: pathOf(AppRoute.Link()) }),
    ],
  }
}

const goTo = (
  model: Model,
  url: Url,
  fragment: Option.Option<Redacted.Redacted<string>>,
): Update.Return<Model, Message> => {
  const route = urlToAppRoute(url)
  // NOTE: a link with a token always starts over, also when a link page is
  // already open: the new token wins.
  const linked: Update.Return<Model, Message> = AppRoute.guards.Link(route)
    ? Option.isNone(fragment) && Option.isSome(model.maybeLink)
      ? { model }
      : startLink(model, fragment)
    : { model: modifyFields(model, { maybeLink: () => Option.none() }) }
  const routed = modifyFields(linked.model, {
    route: () => route,
    isDetailSheetOpen: () => false,
    rulesForm: form =>
      AppRoute.guards.Rules(route) &&
      !RulesSubmission.guards.Saving(form.submission)
        ? rulesFormFor(model.ruleSets, form.scope)
        : form,
  })
  const entered: Update.Return<Model, Message> = Session.guards.SignedIn(
    routed.session,
  )
    ? enterRoute(routed, route)
    : { model: routed }
  return {
    model: entered.model,
    commands: [
      ...(linked.commands ?? []),
      ...(entered.commands ?? []),
      focusPageHeading(),
    ],
  }
}

const isSameRoute = (a: AppRoute, b: AppRoute): boolean =>
  pathOf(a) === pathOf(b)

const mustAskBeforeLeaving = (model: Model, url: Url): boolean =>
  AppRoute.guards.Report(model.route) &&
  Report.hasUnsavedEdits(model.report) &&
  !isSameRoute(urlToAppRoute(url), model.route)

const askBeforeLeaving = (
  model: Model,
  url: Url,
  fragment: Redacted.Redacted<string> | undefined,
): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    maybeLeaving: () =>
      Option.some(
        fragment === undefined
          ? { url, isWaiting: false }
          : { url, fragment, isWaiting: false },
      ),
  }),
  commands: [FocusElement({ selector: `#${LEAVE_HEADING_ID}` })],
})

// NOTE: Gives up the report's Model only when the author chose to leave
// without the save; once everything is saved it is kept as it is.
const leaveNow = (
  model: Model,
  leaving: Leaving,
  isGivingUp: boolean,
): Update.Return<Model, Message> => {
  const went = goTo(
    modifyFields(model, {
      maybeLeaving: () => Option.none(),
      report: report => (isGivingUp ? Report.cleared(report) : report),
    }),
    leaving.url,
    Option.fromNullishOr(leaving.fragment),
  )
  return {
    model: went.model,
    commands: [
      PushUrl({ url: urlToString(leaving.url) }),
      ...(went.commands ?? []),
    ],
  }
}

// NOTE: Waiting to leave ends on its own when the report is saved.
const leaveWhenSaved = (
  step: Update.Return<Model, Message>,
): Update.Return<Model, Message> =>
  Option.match(step.model.maybeLeaving, {
    onNone: () => step,
    onSome: leaving => {
      if (!leaving.isWaiting || Report.hasUnsavedEdits(step.model.report)) {
        return step
      }
      const left = leaveNow(step.model, leaving, false)
      return {
        model: left.model,
        commands: [...(step.commands ?? []), ...(left.commands ?? [])],
      }
    },
  })

// NOTE: an address that carries a token, on the link page.
const opensLink = (
  url: Url,
  fragment: Redacted.Redacted<string> | undefined,
): boolean =>
  AppRoute.guards.Link(urlToAppRoute(url)) &&
  fragment !== undefined &&
  Redacted.value(fragment).length > 0

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedCase: ({ caseId }) => ({
      model: modifyFields(model, {
        maybeSelectedCaseId: () => Option.some(caseId),
        isDetailSheetOpen: () => true,
      }),
    }),
    ClickedCloseDetail: () => ({
      model: modifyFields(model, {
        maybeSelectedCaseId: () => Option.none(),
        maybeHighlightedCaseId: () => Option.none(),
        isDetailSheetOpen: () => false,
      }),
    }),
    EnteredCase: ({ caseId }) => ({
      model: modifyFields(model, {
        maybeHighlightedCaseId: () => Option.some(caseId),
      }),
    }),
    LeftCase: () => ({
      model: modifyFields(model, {
        maybeHighlightedCaseId: () => Option.none(),
      }),
    }),
    FocusedCaseMark: ({ caseId }) => ({
      model: modifyFields(model, {
        maybeHighlightedCaseId: () => Option.some(caseId),
        maybeFocusedMarkId: () => Option.some(caseId),
      }),
    }),
    BlurredCaseMark: () => ({
      model: modifyFields(model, {
        maybeHighlightedCaseId: () => Option.none(),
        maybeFocusedMarkId: () => Option.none(),
      }),
    }),
    UpdatedHeroLayout: ({ layout }) => {
      const nextModel = modifyFields(model, { heroLayout: () => layout })
      if (model.heroLayout === layout) {
        return { model }
      }
      return Option.match(model.maybeFocusedMarkId, {
        onNone: () => ({ model: nextModel }),
        onSome: caseId => ({
          model: nextModel,
          commands: [
            FocusCaseMark({ selector: `#${markDomId(layout, caseId)}` }),
          ],
        }),
      })
    },
    CompletedFocusCaseMark: () => ({ model }),
    CompletedFocusElement: () => ({ model }),
    UpdatedNow: ({ now }) => ({
      model: modifyFields(model, { now: () => now }),
    }),
    SelectedCentreFilter: ({ centreFilter }) => ({
      model: modifyFields(model, { centreFilter: () => centreFilter }),
    }),
    CompletedGetCurrentTime: ({ now }) => ({
      model: modifyFields(model, {
        now: () => now,
        entryForm: () => emptyEntryForm(now),
      }),
    }),
    SucceededLoadDesk: ({ cases, ruleSets }) => {
      const loaded = modifyFields(model, {
        deskLoad: () => DeskLoad.Loaded(),
        cases: () => cases,
        ruleSets: () => ruleSets,
      })
      return {
        model: modifyFields(loaded, {
          maybeSelectedCaseId: maybeSelected =>
            Option.orElse(maybeSelected, () => firstCaseIdOf(loaded)),
        }),
      }
    },
    FailedLoadDesk: ({ failure }) => ({
      model:
        failure === 'SignInRequired'
          ? signedOut(model)
          : modifyFields(model, {
              deskLoad: () => DeskLoad.Failed({ failure }),
            }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { deskLoad: () => DeskLoad.Loading() }),
      commands: [LoadDesk()],
    }),
    ClickedLink: ({ request, fragment }) =>
      UrlRequest.match<Update.Return<Model, Message>>(request, {
        Internal: ({ url }) => {
          if (
            isSameRoute(urlToAppRoute(url), model.route) &&
            !opensLink(url, fragment)
          ) {
            return { model }
          }
          if (mustAskBeforeLeaving(model, url)) {
            return askBeforeLeaving(model, url, fragment)
          }
          const went = goTo(model, url, Option.fromNullishOr(fragment))
          return {
            model: went.model,
            commands: [
              PushUrl({ url: urlToString(url) }),
              ...(went.commands ?? []),
            ],
          }
        },
        External: ({ href }) => ({
          model,
          commands: [LoadExternal({ href })],
        }),
      }),
    ChangedUrl: ({ url, fragment }) => {
      if (
        isSameRoute(urlToAppRoute(url), model.route) &&
        !opensLink(url, fragment)
      ) {
        return { model }
      }
      if (mustAskBeforeLeaving(model, url)) {
        const asked = askBeforeLeaving(model, url, fragment)
        return {
          model: asked.model,
          commands: [
            PushUrl({ url: pathOf(model.route) }),
            ...(asked.commands ?? []),
          ],
        }
      }
      return goTo(model, url, Option.fromNullishOr(fragment))
    },
    ClickedStayOnReport: () => ({
      model: modifyFields(model, { maybeLeaving: () => Option.none() }),
    }),
    ClickedWaitToLeaveReport: () =>
      Option.match(model.maybeLeaving, {
        onNone: () => ({ model }),
        onSome: leaving =>
          leaveWhenSaved(
            retryReportSave(
              modifyFields(model, {
                maybeLeaving: () =>
                  Option.some({ ...leaving, isWaiting: true }),
              }),
            ),
          ),
      }),
    ClickedLeaveReportUnsaved: () =>
      Option.match(model.maybeLeaving, {
        onNone: () => ({ model }),
        onSome: leaving => leaveNow(model, leaving, true),
      }),
    CompletedPushUrl: () => ({ model }),
    CompletedReplaceUrl: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    SucceededLoadConfig: ({ config }) =>
      resume(
        modifyFields(model, { config: () => ConfigLoad.Loaded({ config }) }),
      ),
    FailedLoadConfig: () =>
      resume(modifyFields(model, { config: () => ConfigLoad.Unavailable() })),
    SucceededLoadLogo: ({ src }) => ({
      model: modifyFields(model, { maybeLogoSrc: () => Option.some(src) }),
    }),
    FailedLoadLogo: () => ({ model }),
    GotLinkMessage: ({ message }) => foldLink(model, message),
    GotAccountMessage: ({ message }) => foldAccount(model, message),
    GotAdminMessage: ({ message }) => foldAdmin(model, message),
    GotUnitMessage: ({ message }) => foldUnit(model, message),
    GotReportsMessage: ({ message }) => foldReports(model, message),
    GotReportMessage: ({ message }) =>
      leaveWhenSaved(foldReport(model, message)),
    GotShareMessage: ({ message }) => foldShare(model, message),
    GotNamesMessage: ({ message }) => foldNames(model, message),
    GotHistoryMessage: ({ message }) => foldHistory(model, message),
    GotPublishMessage: ({ message }) => foldPublish(model, message),
    GotInboxMessage: ({ message }) => foldInbox(model, message),
    GotReviewMessage: ({ message }) => foldReview(model, message),
    GotCommentsMessage: ({ message }) => foldComments(model, message),
    SucceededCheckSession: ({ me }) => resume(loadingDesk(model, me)),
    FailedCheckSession: () => ({ model: signedOut(model) }),
    UpdatedLoginEmail: ({ value }) => ({
      model: modifyFields(model, {
        loginForm: form => modifyFields(form, { email: () => value }),
      }),
    }),
    UpdatedLoginPassword: ({ value }) => ({
      model: modifyFields(model, {
        loginForm: form => modifyFields(form, { password: () => value }),
      }),
    }),
    SubmittedLogin: () =>
      LoginSubmission.match(model.loginForm.submission, {
        Submitting: () => ({ model }),
        NotSubmitted: () => submitLogin(model),
        Rejected: () => submitLogin(model),
      }),
    SucceededSignIn: ({ me }) => resume(loadingDesk(model, me)),
    FailedSignIn: ({ failure }) => ({
      model: modifyFields(model, {
        loginForm: form =>
          modifyFields(form, {
            password: () => Redacted.make(''),
            submission: () => LoginSubmission.Rejected({ failure }),
          }),
      }),
    }),
    ClickedSignOut: () => ({
      model: modifyFields(signedOut(model), { route: () => AppRoute.Desk() }),
      commands: [SignOut(), ReplaceUrl({ url: pathOf(AppRoute.Desk()) })],
    }),
    CompletedSignOut: () => ({ model }),
    SelectedRulesScope: ({ scope }) => ({
      model: modifyFields(model, {
        rulesForm: () => rulesFormFor(model.ruleSets, scope),
      }),
    }),
    UpdatedRulesField: ({ field, value }) => ({
      model: modifyFields(model, {
        rulesForm: form => withRulesField(form, field, value),
      }),
    }),
    SubmittedRules: () =>
      RulesSubmission.match(model.rulesForm.submission, {
        Saving: () => ({ model }),
        Editing: () => submitRules(model),
        Saved: () => submitRules(model),
        Failed: () => submitRules(model),
      }),
    ClickedDiscardRules: () => ({
      model: modifyFields(model, {
        rulesForm: form => rulesFormFor(model.ruleSets, form.scope),
      }),
    }),
    SucceededPutRuleSet: ({ ruleSet }) => {
      const ruleSets = Array.append(
        Array.filter(
          model.ruleSets,
          existing => existing.scope !== ruleSet.scope,
        ),
        ruleSet,
      )
      return {
        model: modifyFields(model, {
          ruleSets: () => ruleSets,
          rulesForm: form =>
            modifyFields(rulesFormFor(ruleSets, form.scope), {
              submission: () => RulesSubmission.Saved(),
            }),
        }),
      }
    },
    FailedPutRuleSet: ({ failure }) => ({
      model:
        failure === 'SignInRequired'
          ? signedOut(model)
          : modifyFields(model, {
              rulesForm: form =>
                modifyFields(form, {
                  submission: () => RulesSubmission.Failed({ failure }),
                }),
            }),
    }),
    UpdatedEntryField: ({ field, value }) => ({
      model: modifyFields(model, {
        entryForm: form => withEntryField(form, field, value),
      }),
    }),
    ToggledEntrySignal: ({ signal }) => ({
      model: modifyFields(model, {
        entryForm: form => toggleSignal(form, signal),
      }),
    }),
    SubmittedEntry: () =>
      EntrySubmission.match(model.entryForm.submission, {
        Submitting: () => ({ model }),
        Editing: () => submitEntry(model),
        Failed: () => submitEntry(model),
      }),
    SucceededCreateCase: ({ created }) => ({
      model: modifyFields(model, {
        cases: cases => Array.append(cases, created),
        entryForm: () => emptyEntryForm(model.now),
        route: () => AppRoute.Desk(),
        centreFilter: () => 'All',
        maybeSelectedCaseId: () => Option.some(created.id),
        isDetailSheetOpen: () => true,
      }),
      commands: [PushUrl({ url: pathOf(AppRoute.Desk()) }), focusPageHeading()],
    }),
    FailedCreateCase: ({ failure }) => ({
      model:
        failure === 'SignInRequired'
          ? signedOut(model)
          : modifyFields(model, {
              entryForm: form =>
                modifyFields(form, {
                  submission: () => EntrySubmission.Failed({ failure }),
                }),
            }),
    }),
  })

const submitLogin = (model: Model) => ({
  model: modifyFields(model, {
    loginForm: form =>
      modifyFields(form, { submission: () => LoginSubmission.Submitting() }),
  }),
  commands: [
    SignIn({
      email: model.loginForm.email,
      password: model.loginForm.password,
    }),
  ],
})

// SUBSCRIPTION

export const CLOCK_TICK_MINUTES = 1

const appSubscriptions = Subscription.make<Model, Message>()(_entry => ({
  clock: Subscription.persistentEntry(
    Stream.tick(Duration.minutes(CLOCK_TICK_MINUTES)).pipe(
      Stream.mapEffect(() => Clock.currentTimeMillis),
      Stream.map(now => Message.UpdatedNow({ now })),
    ),
  ),
  heroLayout: Subscription.persistentEntry(
    Dom.streamFromMediaQuery({
      query: NARROW_VIEWPORT_QUERY,
      mapMatches: isNarrow =>
        Message.UpdatedHeroLayout({ layout: heroLayoutForViewport(isNarrow) }),
    }).pipe(Stream.debounce(Duration.millis(LAYOUT_SETTLE_MS))),
  ),
}))

// NOTE: Polling "who is drafting" and retrying a save belong to the report
// screen and run only while it is shown. The warning before the tab closes
// stays on for as long as the report holds edits that are not saved, and the
// window events an editor sends as it goes away must be heard at the very
// moment the screen changes, so those do not wait for the route.
const reportSubscriptions = Subscription.lift(Report.subscriptions)<
  Model,
  Message
>({
  read: model => Option.some(model.report),
  toParentMessage: message => Message.GotReportMessage({ message }),
  when: {
    drafting: model => AppRoute.guards.Report(model.route),
    saveRetry: model => AppRoute.guards.Report(model.route),
  },
})

const historySubscriptions = Subscription.lift(History.subscriptions)<
  Model,
  Message
>({
  read: model => Option.some(model.history),
  toParentMessage: message => Message.GotHistoryMessage({ message }),
  when: model =>
    AppRoute.guards.Drafts(model.route) || AppRoute.guards.Draft(model.route),
})

const publishSubscriptions = Subscription.lift(Publish.subscriptions)<
  Model,
  Message
>({
  read: model => Option.some(model.publish),
  toParentMessage: message => Message.GotPublishMessage({ message }),
  when: model => AppRoute.guards.Publish(model.route),
})

const reviewSubscriptions = Subscription.lift(Review.subscriptions)<
  Model,
  Message
>({
  read: model => Option.some(model.review),
  toParentMessage: message => Message.GotReviewMessage({ message }),
  when: model => AppRoute.guards.Revision(model.route),
})

export const subscriptions = Subscription.aggregate(
  appSubscriptions,
  reportSubscriptions,
  historySubscriptions,
  publishSubscriptions,
  reviewSubscriptions,
)

// VIEW TRANSITION

export const heroLayoutTransition = ({
  previousModel,
  model,
}: Readonly<{ previousModel: Model; model: Model }>): boolean =>
  isAnimatedLayoutChange(previousModel.heroLayout, model.heroLayout)
