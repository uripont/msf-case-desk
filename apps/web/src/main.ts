import {
  Array,
  Clock,
  Duration,
  Effect,
  Option,
  Redacted,
  Schema,
  Stream,
  pipe,
} from 'effect'
import { Command, Dom, Runtime, Subscription, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  Case,
  CaseId,
  DEMO_START,
  RuleSet,
  type TriageRules,
  type TriagedCase,
  User,
  prioritiseByCentre,
  rulesFor,
} from '@case-desk/domain'

import {
  ApiFailure,
  SignInRejection,
  failureOf,
  fetchSession,
  postSignIn,
  postSignOut,
  withApi,
} from './api'
import {
  HeroLayout,
  LAYOUT_SETTLE_MS,
  NARROW_VIEWPORT_QUERY,
  heroLayoutForViewport,
  isAnimatedLayoutChange,
  markDomId,
} from './axisLayout'
import { hoursToMs } from './format'

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
  SignedIn: { user: User },
})
export type Session = typeof Session.Type

export const LoginSubmission = defineTaggedUnion({
  NotSubmitted: {},
  Submitting: {},
  Rejected: { rejection: SignInRejection },
})
export type LoginSubmission = typeof LoginSubmission.Type

export const LoginForm = Schema.Struct({
  email: Schema.String,
  password: Schema.Redacted(Schema.String),
  submission: LoginSubmission,
})
export type LoginForm = typeof LoginForm.Type

export const Model = Schema.Struct({
  session: Session,
  loginForm: LoginForm,
  deskLoad: DeskLoad,
  ruleSets: Schema.Array(RuleSet),
  cases: Schema.Array(Case),
  startedAt: Schema.Int,
  now: Schema.Int,
  maybeSelectedCaseId: Schema.Option(CaseId),
  maybeHighlightedCaseId: Schema.Option(CaseId),
  maybeFocusedMarkId: Schema.Option(CaseId),
  heroLayout: HeroLayout,
  isDetailSheetOpen: Schema.Boolean,
  isDemoControlsOpen: Schema.Boolean,
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
  ClickedAdvanceClock: { hours: Schema.Int },
  ClickedResetClock: {},
  ClickedToggleDemoControls: {},
  SelectedCentreFilter: { centreFilter: CentreFilter },
  CompletedGetCurrentTime: { now: Schema.Int },
  SucceededLoadDesk: {
    cases: Schema.Array(Case),
    ruleSets: Schema.Array(RuleSet),
  },
  FailedLoadDesk: { failure: ApiFailure },
  ClickedRetryLoad: {},
  SucceededCheckSession: { user: User },
  FailedCheckSession: {},
  UpdatedLoginEmail: { value: Schema.String },
  UpdatedLoginPassword: { value: Schema.Redacted(Schema.String) },
  SubmittedLogin: {},
  SucceededSignIn: { user: User },
  FailedSignIn: { rejection: SignInRejection },
  ClickedSignOut: {},
  CompletedSignOut: {},
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
  session: Session.Checking(),
  loginForm: emptyLoginForm,
  deskLoad: DeskLoad.Loading(),
  ruleSets: [],
  cases: [],
  startedAt: DEMO_START,
  now: DEMO_START,
  maybeSelectedCaseId: Option.none(),
  maybeHighlightedCaseId: Option.none(),
  maybeFocusedMarkId: Option.none(),
  heroLayout: 'Responsive',
  isDetailSheetOpen: false,
  isDemoControlsOpen: false,
  centreFilter: 'All',
})

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: initialModel,
  commands: [GetCurrentTime(), CheckSession()],
})

// COMMAND

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

export const CheckSession = Command.define('CheckSession', {
  messages: [Message.SucceededCheckSession, Message.FailedCheckSession],
  execute: fetchSession.pipe(
    Effect.map(maybeUser =>
      Option.match(maybeUser, {
        onNone: () => Message.FailedCheckSession(),
        onSome: user => Message.SucceededCheckSession({ user }),
      }),
    ),
    Effect.catch(() => Effect.succeed(Message.FailedCheckSession())),
  ),
})

export const SignIn = Command.define('SignIn', {
  args: { email: Schema.String, password: Schema.Redacted(Schema.String) },
  messages: [Message.SucceededSignIn, Message.FailedSignIn],
  execute: ({ email, password }) =>
    postSignIn(email, password).pipe(
      Effect.map(user => Message.SucceededSignIn({ user })),
      Effect.catch(rejection =>
        Effect.succeed(Message.FailedSignIn({ rejection })),
      ),
    ),
})

export const SignOut = Command.define('SignOut', {
  messages: [Message.CompletedSignOut],
  execute: Effect.as(postSignOut, Message.CompletedSignOut()),
})

const signedOut = (model: Model): Model =>
  modifyFields(model, {
    session: () => Session.SignedOut(),
    deskLoad: () => DeskLoad.Loading(),
    cases: () => [],
    ruleSets: () => [],
    maybeSelectedCaseId: () => Option.none(),
    maybeHighlightedCaseId: () => Option.none(),
    isDetailSheetOpen: () => false,
  })

const loadingDesk = (model: Model, user: User): Model =>
  modifyFields(model, {
    session: () => Session.SignedIn({ user }),
    loginForm: () => emptyLoginForm,
    deskLoad: () => DeskLoad.Loading(),
  })

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
    ClickedAdvanceClock: ({ hours }) => ({
      model: modifyFields(model, { now: now => now + hoursToMs(hours) }),
    }),
    ClickedToggleDemoControls: () => ({
      model: modifyFields(model, {
        isDemoControlsOpen: isOpen => !isOpen,
      }),
    }),
    ClickedResetClock: () => ({
      model: modifyFields(model, { now: () => model.startedAt }),
    }),
    SelectedCentreFilter: ({ centreFilter }) => ({
      model: modifyFields(model, { centreFilter: () => centreFilter }),
    }),
    CompletedGetCurrentTime: ({ now }) => ({
      model: modifyFields(model, { startedAt: () => now, now: () => now }),
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
    SucceededCheckSession: ({ user }) => ({
      model: loadingDesk(model, user),
      commands: [LoadDesk()],
    }),
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
    SucceededSignIn: ({ user }) => ({
      model: loadingDesk(model, user),
      commands: [LoadDesk()],
    }),
    FailedSignIn: ({ rejection }) => ({
      model: modifyFields(model, {
        loginForm: form =>
          modifyFields(form, {
            password: () => Redacted.make(''),
            submission: () => LoginSubmission.Rejected({ rejection }),
          }),
      }),
    }),
    ClickedSignOut: () => ({
      model: signedOut(model),
      commands: [SignOut()],
    }),
    CompletedSignOut: () => ({ model }),
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

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  heroLayout: Subscription.persistentEntry(
    Dom.streamFromMediaQuery({
      query: NARROW_VIEWPORT_QUERY,
      mapMatches: isNarrow =>
        Message.UpdatedHeroLayout({ layout: heroLayoutForViewport(isNarrow) }),
    }).pipe(Stream.debounce(Duration.millis(LAYOUT_SETTLE_MS))),
  ),
}))

// VIEW TRANSITION

export const heroLayoutTransition = ({
  previousModel,
  model,
}: Readonly<{ previousModel: Model; model: Model }>): boolean =>
  isAnimatedLayoutChange(previousModel.heroLayout, model.heroLayout)
