import { Array, Duration, Effect, Option, Schema, Stream, pipe } from 'effect'
import { Command, Dom, Runtime, Subscription, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import {
  Case,
  CaseId,
  DEFAULT_RULES,
  DEMO_START,
  SEED_CASES,
  TriageRules,
  type TriagedCase,
  prioritise,
} from '@case-desk/domain'

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

export const Model = Schema.Struct({
  rules: TriageRules,
  cases: Schema.Array(Case),
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
})
export type Message = typeof Message.Type

// QUERIES

export const queueOf = (model: Model): ReadonlyArray<TriagedCase> =>
  prioritise(model.rules, model.cases, model.now)

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

const firstCaseId = (
  cases: ReadonlyArray<Case>,
): Option.Option<typeof CaseId.Type> =>
  pipe(
    prioritise(DEFAULT_RULES, cases, DEMO_START),
    Array.head,
    Option.map(triaged => triaged.triageCase.id),
  )

export const initialModel = Model.make({
  rules: DEFAULT_RULES,
  cases: SEED_CASES,
  now: DEMO_START,
  maybeSelectedCaseId: firstCaseId(SEED_CASES),
  maybeHighlightedCaseId: Option.none(),
  maybeFocusedMarkId: Option.none(),
  heroLayout: 'Responsive',
  isDetailSheetOpen: false,
  isDemoControlsOpen: false,
  centreFilter: 'All',
})

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: initialModel,
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
      model: modifyFields(model, { now: () => DEMO_START }),
    }),
    SelectedCentreFilter: ({ centreFilter }) => ({
      model: modifyFields(model, { centreFilter: () => centreFilter }),
    }),
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
