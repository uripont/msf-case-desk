import { Result } from 'effect'
import fc from 'fast-check'

import { type Participant, type ReviewDecision } from '../approval'
import { INTAKE_TEMPLATE, INVESTIGATION_TEMPLATE } from '../builtin-templates'
import type { ReportAccess } from '../permissions'
import {
  type EventKind,
  type FlowContext,
  type FlowError,
  type FlowEvent,
  type ReportFlow,
  applyEvent,
  initialFlow,
  latestRound,
  settle,
} from '../report-flow'
import type { Template } from '../template'
import { reviewingRolesOf } from '../template'
import { PANEL_TEMPLATE, validTemplateArbitrary } from './templates'

// NOTE: Test support for every later stage: generators of the people chosen
// for a round, and of event sequences for the report lifecycle, with a runner
// that turns each generated intent into an event against the current report
// (so most sequences make progress) and records every step.

export const AUTHOR_IDS: ReadonlyArray<string> = ['author-1', 'author-2']
export const reviewerId = (n: number): string => `reviewer-${n}`
export const TEST_UNIT = 'unit-a'

// The three hand-written templates and generated ones.
export const flowTemplateArbitrary: fc.Arbitrary<Template> = fc.oneof(
  fc.constantFrom(INTAKE_TEMPLATE, INVESTIGATION_TEMPLATE, PANEL_TEMPLATE),
  validTemplateArbitrary,
)

// ---- People -----------------------------------------------------------------

type Sizing = Readonly<{ min: number; max: number }>

const votesOf = (template: Template, roleId: string): boolean =>
  template.roles.find(r => r.id === roleId)?.permissions.includes('vote') ??
  false

// NOTE: The fewest people a role needs so that its rule can be met.
const fewestFor = (template: Template, roleId: string): number => {
  const role = template.roles.find(r => r.id === roleId)
  if (role === undefined || !votesOf(template, roleId)) return 0
  return role.approval?.kind === 'at_least' ? role.approval.count : 1
}

const sizingOf = (template: Template): ReadonlyArray<Sizing> =>
  reviewingRolesOf(template).map(role => {
    const min = fewestFor(template, role.id)
    return { min, max: min + 3 }
  })

const participantsFrom = (
  template: Template,
  sizes: ReadonlyArray<number>,
): ReadonlyArray<Participant> => {
  let next = 1
  return reviewingRolesOf(template).flatMap((role, index) =>
    Array.from({ length: sizes[index] ?? 0 }, () => ({
      accountId: reviewerId(next++),
      roleId: role.id,
    })),
  )
}

// People for whom every voting role's rule can be met.
export const satisfiableParticipants = (
  template: Template,
): fc.Arbitrary<ReadonlyArray<Participant>> =>
  fc
    .tuple(...sizingOf(template).map(s => fc.integer(s)))
    .map(sizes => participantsFrom(template, sizes))

// People for whom exactly one voting role's rule cannot be met: no voter, or
// one fewer than `at least N` needs.
export const unsatisfiableParticipants = (
  template: Template,
): fc.Arbitrary<ReadonlyArray<Participant>> => {
  const roles = reviewingRolesOf(template)
  const voting = roles
    .map((role, index) => ({ role, index }))
    .filter(({ role }) => role.permissions.includes('vote'))
  return fc
    .tuple(
      fc.tuple(...sizingOf(template).map(s => fc.integer(s))),
      fc.nat(Math.max(0, voting.length - 1)),
    )
    .map(([sizes, pick]) => {
      const target = voting[pick]
      return participantsFrom(
        template,
        sizes.map((size, index) =>
          target?.index !== index
            ? size
            : target.role.approval?.kind === 'at_least' &&
                target.role.approval.count >= 2
              ? target.role.approval.count - 1
              : 0,
        ),
      )
    })
}

// ---- Scripts ----------------------------------------------------------------

export type Intent = Readonly<{
  kind: EventKind
  // Time that passes before the event, and how far its deadline is.
  dt: number
  span: number
  pick: number
  decision: ReviewDecision
  people: ReadonlyArray<Participant>
}>

const kindArbitrary: fc.Arbitrary<EventKind> = fc.constantFrom<EventKind>(
  'share_draft',
  'share_draft',
  'share_draft',
  'publish_revision',
  'publish_revision',
  'publish_revision',
  'publish_closing_revision',
  'publish_closing_revision',
  'submit_review',
  'submit_review',
  'submit_review',
  'submit_review',
  'submit_review',
  'submit_review',
  'extend_deadline',
  'remove_reviewer',
  'start_conclusion',
  'start_conclusion',
)

const decisionArbitrary: fc.Arbitrary<ReviewDecision> =
  fc.constantFrom<ReviewDecision>(
    'approve',
    'approve',
    'approve',
    'approve',
    'request_changes',
    'comment',
  )

export const intentArbitrary = (template: Template): fc.Arbitrary<Intent> => {
  const withAnAuthor = satisfiableParticipants(template).map(
    (people): ReadonlyArray<Participant> =>
      people.map((p, index) =>
        index === 0 ? { ...p, accountId: AUTHOR_IDS[0] ?? 'author-1' } : p,
      ),
  )
  return fc.record({
    kind: kindArbitrary,
    dt: fc.integer({ min: 0, max: 4 }),
    span: fc.integer({ min: 1, max: 6 }),
    pick: fc.nat(1000),
    decision: decisionArbitrary,
    people: fc.oneof(
      { weight: 8, arbitrary: satisfiableParticipants(template) },
      { weight: 1, arbitrary: unsatisfiableParticipants(template) },
      { weight: 1, arbitrary: withAnAuthor },
    ),
  })
}

export const scriptArbitrary = (
  template: Template,
  maxLength = 40,
): fc.Arbitrary<ReadonlyArray<Intent>> =>
  fc.array(intentArbitrary(template), { minLength: 1, maxLength })

// NOTE: Turns an intent into an event for the report as it is now. About one
// in several intents is deliberately wrong (a draft that does not exist, a
// stranger as reviewer, a deadline that is not later), so refusals are
// exercised as much as successes.
export const resolveIntent = (
  flow: ReportFlow,
  now: number,
  intent: Intent,
): FlowEvent => {
  const round = latestRound(flow)
  const { pick } = intent
  switch (intent.kind) {
    case 'share_draft':
      return { type: 'share_draft' }
    case 'publish_revision':
    case 'publish_closing_revision':
      return {
        type: intent.kind,
        // NOTE: one in five is not the latest draft (or not shared at all).
        draft: pick % 5 === 0 ? pick % (flow.draftCount + 1) : flow.draftCount,
        deadline: now + intent.span,
        participants: intent.people,
      }
    case 'submit_review': {
      const people = round?.participants ?? []
      const chosen = people[pick % Math.max(1, people.length)]
      return {
        type: 'submit_review',
        // NOTE: one in four reviews was written on an older revision.
        revision:
          round === undefined
            ? 1
            : pick % 4 === 1 && round.revision > 1
              ? Math.max(1, round.revision - 1 - (pick % 3))
              : round.revision,
        reviewerId:
          chosen === undefined || pick % 13 === 0
            ? 'stranger'
            : chosen.accountId,
        decision: intent.decision,
      }
    }
    case 'extend_deadline':
      return {
        type: 'extend_deadline',
        deadline:
          pick % 5 === 0
            ? (round?.deadline ?? now) - 1
            : Math.max(round?.deadline ?? now, now) + intent.span,
      }
    case 'remove_reviewer': {
      const people = round?.participants ?? []
      const chosen = people[pick % Math.max(1, people.length)]
      return {
        type: 'remove_reviewer',
        accountId: chosen === undefined ? 'stranger' : chosen.accountId,
      }
    }
    case 'start_conclusion':
      return { type: 'start_conclusion' }
  }
}

export type Step = Readonly<{
  now: number
  event: FlowEvent
  // The report as stored before the event, and after it was settled for `now`.
  before: ReportFlow
  settledBefore: ReportFlow
  result: Result.Result<ReportFlow, FlowError>
}>

export type Run = Readonly<{
  steps: ReadonlyArray<Step>
  final: ReportFlow
}>

export const contextFor = (
  template: Template,
  now: number,
  authors: ReadonlyArray<string> = AUTHOR_IDS,
): FlowContext => ({ template, authors, now })

// NOTE: Runs the intents in order from `start`. A refused event leaves the
// report as it was, settled for the time that has passed, like a server that
// stores the decision of a late round even when it refuses the request.
export const runScript = (
  template: Template,
  intents: ReadonlyArray<Intent>,
  start: ReportFlow = initialFlow,
  authors: ReadonlyArray<string> = AUTHOR_IDS,
): Run => {
  let flow = start
  let now = 1000
  const steps: Array<Step> = []
  for (const intent of intents) {
    now += intent.dt
    const context = contextFor(template, now, authors)
    const event = resolveIntent(flow, now, intent)
    const settledBefore = settle(context, flow)
    const result = applyEvent(context, flow, event)
    steps.push({ now, event, before: flow, settledBefore, result })
    flow = Result.isSuccess(result) ? result.success : settledBefore
  }
  return { steps, final: flow }
}

export const reportAccessOf = (
  template: Template,
  flow: ReportFlow,
  authors: ReadonlyArray<string> = AUTHOR_IDS,
  unit: string = TEST_UNIT,
): ReportAccess => ({ id: 'report-1', unit, template, authors, flow })
