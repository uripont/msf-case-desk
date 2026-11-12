import { Result } from 'effect'

import {
  type Participant,
  type PublishProblem,
  type ReviewDecision,
  type ReviewRecord,
  checkPublishable,
  tallyRound,
  voterProblems,
} from './approval'
import { type Template, templateNodes } from './template'

// NOTE: The lifecycle of a report, D18 as code. Pure: time arrives as the
// `now` of the context (milliseconds since the epoch) and every deadline is a
// number carried in the data. The domain never reads a clock.
//
// States: drafting, in_review, decided, concluding, archived. The transitions
// are in `TRANSITIONS`, the events each state accepts in `ALLOWED_EVENTS`;
// anything else fails with a typed error and changes nothing.
//
// Rounds: every revision opens a round. A round is open, superseded (a newer
// revision replaced it) or decided, by its rule or by its deadline. Both
// states `in_review` and `concluding` hold an open round, except `concluding`
// right after a closing round was decided by its deadline, or before the first
// closing revision.
//
// Deadlines: a round is past its deadline when `now >= deadline`. Deadlines
// are checked on every event: `applyEvent` settles the report first, so a late
// cron never lets a review in. `settle` is public so a caller can persist the
// decision even when the event itself is refused.

export const REPORT_STATES = [
  'drafting',
  'in_review',
  'decided',
  'concluding',
  'archived',
] as const
export type ReportState = (typeof REPORT_STATES)[number]

export type RoundStatus = 'open' | 'superseded' | 'decided'
export type DecidedBy = 'rule_met' | 'deadline'

export type Round = Readonly<{
  revision: number
  draft: number
  closing: boolean
  deadline: number
  participants: ReadonlyArray<Participant>
  removed: ReadonlyArray<Participant>
  reviews: ReadonlyArray<ReviewRecord>
  status: RoundStatus
  decidedBy?: DecidedBy
}>

export type ReportFlow = Readonly<{
  state: ReportState
  // NOTE: The highest shared draft number. Draft 0 exists from the start.
  draftCount: number
  rounds: ReadonlyArray<Round>
}>

export const initialFlow: ReportFlow = {
  state: 'drafting',
  draftCount: 0,
  rounds: [],
}

export type FlowContext = Readonly<{
  template: Template
  authors: ReadonlyArray<string>
  now: number
}>

export type FlowEvent =
  | Readonly<{ type: 'share_draft' }>
  | Readonly<{
      type: 'publish_revision'
      draft: number
      deadline: number
      participants: ReadonlyArray<Participant>
    }>
  | Readonly<{
      type: 'publish_closing_revision'
      draft: number
      deadline: number
      participants: ReadonlyArray<Participant>
    }>
  | Readonly<{
      type: 'submit_review'
      reviewerId: string
      decision: ReviewDecision
    }>
  | Readonly<{ type: 'extend_deadline'; deadline: number }>
  | Readonly<{ type: 'remove_reviewer'; accountId: string }>
  | Readonly<{ type: 'start_conclusion' }>
  | Readonly<{ type: 'archive' }>

export type EventKind = FlowEvent['type']

export const EVENT_KINDS: ReadonlyArray<EventKind> = [
  'share_draft',
  'publish_revision',
  'publish_closing_revision',
  'submit_review',
  'extend_deadline',
  'remove_reviewer',
  'start_conclusion',
  'archive',
]

// NOTE: The events each state accepts. Everything else is refused with
// `not_allowed_in_state`. Drafting continues in every state but archived
// (D18), so sharing a draft is accepted everywhere except there.
export const ALLOWED_EVENTS: Readonly<
  Record<ReportState, ReadonlyArray<EventKind>>
> = {
  drafting: ['share_draft', 'publish_revision'],
  in_review: [
    'share_draft',
    'publish_revision',
    'submit_review',
    'extend_deadline',
    'remove_reviewer',
  ],
  decided: ['share_draft', 'publish_revision', 'start_conclusion', 'archive'],
  concluding: [
    'share_draft',
    'publish_closing_revision',
    'submit_review',
    'extend_deadline',
    'remove_reviewer',
  ],
  archived: [],
}

export type Cause = EventKind | DecidedBy

export type Transition = Readonly<{
  from: ReportState
  to: ReportState
  on: Cause
}>

// NOTE: Every change of state, with its cause. `in_review` to `in_review` is
// a new revision replacing the open round (D11), and the two `concluding`
// rows are closing revisions and a closing round decided by its deadline.
export const TRANSITIONS: ReadonlyArray<Transition> = [
  { from: 'drafting', to: 'in_review', on: 'publish_revision' },
  { from: 'in_review', to: 'in_review', on: 'publish_revision' },
  { from: 'in_review', to: 'decided', on: 'rule_met' },
  { from: 'in_review', to: 'decided', on: 'deadline' },
  { from: 'decided', to: 'in_review', on: 'publish_revision' },
  { from: 'decided', to: 'archived', on: 'archive' },
  { from: 'decided', to: 'concluding', on: 'start_conclusion' },
  { from: 'concluding', to: 'concluding', on: 'publish_closing_revision' },
  { from: 'concluding', to: 'archived', on: 'rule_met' },
  { from: 'concluding', to: 'concluding', on: 'deadline' },
]

export type FlowErrorCode =
  | 'not_allowed_in_state'
  | 'conclusion_not_in_template'
  | 'round_not_open'
  | 'not_a_participant'
  | 'not_permitted_decision'
  | 'deadline_not_in_future'
  | 'deadline_not_extended'
  | 'draft_not_shared'
  | 'unpublishable'
  | 'removal_makes_rule_unmeetable'
  | 'cannot_archive'

export type FlowError = Readonly<{
  code: FlowErrorCode
  state: ReportState
  event: EventKind
  message: string
  problems?: ReadonlyArray<PublishProblem>
}>

const fail = (
  code: FlowErrorCode,
  flow: ReportFlow,
  event: FlowEvent,
  message: string,
  problems?: ReadonlyArray<PublishProblem>,
): Result.Result<ReportFlow, FlowError> =>
  Result.fail({
    code,
    state: flow.state,
    event: event.type,
    message,
    ...(problems === undefined ? {} : { problems }),
  })

export const latestRound = (flow: ReportFlow): Round | undefined =>
  flow.rounds[flow.rounds.length - 1]

export const openRound = (flow: ReportFlow): Round | undefined => {
  const round = latestRound(flow)
  return round?.status === 'open' ? round : undefined
}

export const hasConclusion = (template: Template): boolean =>
  template.conclusion !== undefined

const replaceLatest = (flow: ReportFlow, round: Round): ReportFlow => ({
  ...flow,
  rounds: [...flow.rounds.slice(0, -1), round],
})

// NOTE: Decides the open round if its rule is met or its deadline has passed,
// whichever is the case, and moves the report as D18 says. A report with no
// open round is returned unchanged.
export const settle = (context: FlowContext, flow: ReportFlow): ReportFlow => {
  const round = openRound(flow)
  if (round === undefined) return flow
  const met = tallyRound(context.template, round).met
  const decidedBy: DecidedBy | undefined = met
    ? 'rule_met'
    : context.now >= round.deadline
      ? 'deadline'
      : undefined
  if (decidedBy === undefined) return flow
  const decided: Round = { ...round, status: 'decided', decidedBy }
  const next = replaceLatest(flow, decided)
  if (flow.state === 'concluding') {
    return decidedBy === 'rule_met' ? { ...next, state: 'archived' } : next
  }
  // NOTE: a template without a conclusion is archived as soon as a round
  // meets its rule (decided, then archived).
  return decidedBy === 'rule_met' && !hasConclusion(context.template)
    ? { ...next, state: 'archived' }
    : { ...next, state: 'decided' }
}

const publish = (
  context: FlowContext,
  flow: ReportFlow,
  event: Extract<
    FlowEvent,
    { type: 'publish_revision' | 'publish_closing_revision' }
  >,
): Result.Result<ReportFlow, FlowError> => {
  if (
    !Number.isInteger(event.draft) ||
    event.draft < 1 ||
    event.draft > flow.draftCount
  ) {
    return fail(
      'draft_not_shared',
      flow,
      event,
      'Only a shared draft can be published; Draft 0 is the empty template.',
    )
  }
  if (!(event.deadline > context.now)) {
    return fail(
      'deadline_not_in_future',
      flow,
      event,
      'The deadline must be in the future.',
    )
  }
  const chosen = checkPublishable(
    context.template,
    event.participants,
    context.authors,
  )
  if (Result.isFailure(chosen)) {
    return fail(
      'unpublishable',
      flow,
      event,
      'The people chosen cannot decide this round.',
      chosen.failure,
    )
  }
  const closing = event.type === 'publish_closing_revision'
  const superseded = flow.rounds.map((round): Round =>
    round.status === 'open' ? { ...round, status: 'superseded' } : round,
  )
  const round: Round = {
    revision: flow.rounds.length + 1,
    draft: event.draft,
    closing,
    deadline: event.deadline,
    participants: event.participants,
    removed: [],
    reviews: [],
    status: 'open',
  }
  return Result.succeed({
    ...flow,
    state: closing ? 'concluding' : 'in_review',
    rounds: [...superseded, round],
  })
}

const handle = (
  context: FlowContext,
  flow: ReportFlow,
  event: FlowEvent,
): Result.Result<ReportFlow, FlowError> => {
  const { template } = context
  switch (event.type) {
    case 'share_draft':
      return Result.succeed({ ...flow, draftCount: flow.draftCount + 1 })
    case 'publish_revision':
    case 'publish_closing_revision':
      return publish(context, flow, event)
    case 'start_conclusion':
      return hasConclusion(template)
        ? Result.succeed({ ...flow, state: 'concluding' })
        : fail(
            'conclusion_not_in_template',
            flow,
            event,
            'The template has no conclusion.',
          )
    case 'archive': {
      const round = latestRound(flow)
      return round?.decidedBy === 'rule_met' && !hasConclusion(template)
        ? Result.succeed({ ...flow, state: 'archived' })
        : fail(
            'cannot_archive',
            flow,
            event,
            'Only a round that met its rule, in a template without a conclusion, archives directly.',
          )
    }
    case 'submit_review': {
      const round = openRound(flow)
      if (round === undefined) {
        return fail('round_not_open', flow, event, 'The round is not open.')
      }
      const participant = round.participants.find(
        p => p.accountId === event.reviewerId,
      )
      if (participant === undefined) {
        return fail(
          'not_a_participant',
          flow,
          event,
          'The reviewer is not part of this round.',
        )
      }
      const role = template.roles.find(r => r.id === participant.roleId)
      const needed = event.decision === 'comment' ? 'comment' : 'vote'
      if (role === undefined || !role.permissions.includes(needed)) {
        return fail(
          'not_permitted_decision',
          flow,
          event,
          `The role may not send a ${event.decision} review.`,
        )
      }
      return Result.succeed(
        replaceLatest(flow, {
          ...round,
          reviews: [
            ...round.reviews,
            {
              reviewerId: event.reviewerId,
              revision: round.revision,
              decision: event.decision,
            },
          ],
        }),
      )
    }
    case 'extend_deadline': {
      const round = openRound(flow)
      if (round === undefined) {
        return fail('round_not_open', flow, event, 'The round is not open.')
      }
      return event.deadline > round.deadline && event.deadline > context.now
        ? Result.succeed(
            replaceLatest(flow, { ...round, deadline: event.deadline }),
          )
        : fail(
            'deadline_not_extended',
            flow,
            event,
            'The new deadline must be later than the current one.',
          )
    }
    case 'remove_reviewer': {
      const round = openRound(flow)
      if (round === undefined) {
        return fail('round_not_open', flow, event, 'The round is not open.')
      }
      const removed = round.participants.filter(
        p => p.accountId === event.accountId,
      )
      if (removed.length === 0) {
        return fail(
          'not_a_participant',
          flow,
          event,
          'That person is not part of this round.',
        )
      }
      const remaining = round.participants.filter(
        p => p.accountId !== event.accountId,
      )
      const problems = voterProblems(template, remaining)
      if (problems.length > 0) {
        return fail(
          'removal_makes_rule_unmeetable',
          flow,
          event,
          'Without that person the approval rule could not be met.',
          problems,
        )
      }
      return Result.succeed(
        replaceLatest(flow, {
          ...round,
          participants: remaining,
          removed: [...round.removed, ...removed],
        }),
      )
    }
  }
}

// NOTE: Settles first (deadlines are checked on every write), refuses events
// the state does not accept, applies the event, then settles again, so the
// approval that completes the rule decides the round in the same step.
export const applyEvent = (
  context: FlowContext,
  flow: ReportFlow,
  event: FlowEvent,
): Result.Result<ReportFlow, FlowError> => {
  const settled = settle(context, flow)
  if (!ALLOWED_EVENTS[settled.state].includes(event.type)) {
    return fail(
      'not_allowed_in_state',
      settled,
      event,
      `${event.type} is not allowed while the report is ${settled.state}.`,
    )
  }
  const result = handle(context, settled, event)
  return Result.isFailure(result)
    ? result
    : Result.succeed(settle(context, result.success))
}

// ---- Saving content ---------------------------------------------------------

export type SaveTarget =
  | Readonly<{ kind: 'section'; sectionId: string }>
  | Readonly<{ kind: 'people' }>

export type SaveErrorCode =
  | 'report_archived'
  | 'unknown_section'
  | 'only_conclusion_while_concluding'
  | 'conclusion_only_while_concluding'

export type SaveError = Readonly<{
  code: SaveErrorCode
  state: ReportState
  message: string
}>

// NOTE: A section is part of the conclusion if it is the conclusion section
// or lies inside it.
export const isConclusionSection = (
  template: Template,
  sectionId: string,
): boolean => {
  const { conclusion } = template
  if (conclusion === undefined) return false
  return templateNodes(template).some(
    entry =>
      entry.kind === 'section' &&
      entry.node.id === sectionId &&
      entry.path[0] === 'conclusion',
  )
}

const sectionExists = (template: Template, sectionId: string): boolean =>
  templateNodes(template).some(
    entry => entry.kind === 'section' && entry.node.id === sectionId,
  )

// NOTE: The server rule on saving a working copy. Drafting continues in every
// state but archived. While `concluding` only the conclusion section can be
// saved (not the people list, not any other section), and the conclusion
// section can be saved in no other state.
export const checkSave = (
  template: Template,
  state: ReportState,
  target: SaveTarget,
): Result.Result<true, SaveError> => {
  const refuse = (code: SaveErrorCode, message: string) =>
    Result.fail({ code, state, message })
  if (state === 'archived') {
    return refuse('report_archived', 'An archived report is read-only.')
  }
  if (target.kind === 'people') {
    return state === 'concluding'
      ? refuse(
          'only_conclusion_while_concluding',
          'Only the conclusion can be saved while concluding.',
        )
      : Result.succeed(true)
  }
  if (!sectionExists(template, target.sectionId)) {
    return refuse('unknown_section', 'The template has no such section.')
  }
  const inConclusion = isConclusionSection(template, target.sectionId)
  if (state === 'concluding' && !inConclusion) {
    return refuse(
      'only_conclusion_while_concluding',
      'Only the conclusion can be saved while concluding.',
    )
  }
  if (state !== 'concluding' && inConclusion) {
    return refuse(
      'conclusion_only_while_concluding',
      'The conclusion can be saved only while concluding.',
    )
  }
  return Result.succeed(true)
}
