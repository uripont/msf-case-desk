import { type ReviewDecision, standingDecisions } from './approval'
import type { DecidedBy, Round } from './report-flow'

// NOTE: The facts of a report that carry a time (D12, step 10 of the
// pipeline). The report flow (report-flow.ts) holds the state and no clock, so
// the times live in an event log that stage 2 stores: when a draft was shared,
// when a revision was published, when someone was told, opened, reminded,
// reviewed, and when a round was decided. The grid and the notification rules
// both read this one log. Times are milliseconds since the epoch.
//
// A review is one event with an `id` (the notification rules key on it) and
// `hasComments` (whether it came with comments, D19).

export type ReminderKind = 'reminder_first' | 'reminder_final'

export type ReviewFact = Readonly<{
  id: string
  reviewerId: string
  revision: number
  decision: ReviewDecision
  hasComments: boolean
  at: number
}>

export type ReportEvent =
  | Readonly<{
      type: 'draft_shared'
      draft: number
      accountId: string
      at: number
    }>
  | Readonly<{
      type: 'draft_read'
      draft: number
      accountId: string
      at: number
    }>
  | Readonly<{ type: 'revision_published'; revision: number; at: number }>
  | Readonly<{
      type: 'notified'
      revision: number
      accountId: string
      at: number
    }>
  | Readonly<{
      type: 'read'
      revision: number
      accountId: string
      at: number
    }>
  | Readonly<{
      type: 'reminded'
      revision: number
      accountId: string
      kind: ReminderKind
      at: number
    }>
  | Readonly<{
      type: 'whatsapp_opened'
      revision: number
      accountId: string
      at: number
    }>
  | (Readonly<{ type: 'review' }> & ReviewFact)
  | Readonly<{
      type: 'round_decided'
      revision: number
      decidedBy: DecidedBy
      at: number
    }>

type OfType<T extends ReportEvent['type']> = Extract<ReportEvent, { type: T }>

export const eventsOfType = <T extends ReportEvent['type']>(
  events: ReadonlyArray<ReportEvent>,
  type: T,
): ReadonlyArray<OfType<T>> =>
  events.filter((event): event is OfType<T> => event.type === type)

export const publishedAtOf = (
  events: ReadonlyArray<ReportEvent>,
  revision: number,
): number | undefined =>
  eventsOfType(events, 'revision_published').find(
    event => event.revision === revision,
  )?.at

// NOTE: The reviews of one revision, oldest first (stable for equal times).
export const reviewFactsOf = (
  events: ReadonlyArray<ReportEvent>,
  revision: number,
): ReadonlyArray<ReviewFact> =>
  eventsOfType(events, 'review')
    .filter(event => event.revision === revision)
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.at - b.event.at || a.index - b.index)
    .map(({ event }) => event)

// NOTE: When a round was decided. The event says so if it was logged. Without
// it, a round decided by its deadline was decided at the deadline, and a round
// decided by its rule at the time of its last decision. `undefined` while the
// round is not decided.
export const decidedAtOf = (
  events: ReadonlyArray<ReportEvent>,
  round: Round,
): number | undefined => {
  if (round.status !== 'decided') return undefined
  const logged = eventsOfType(events, 'round_decided').find(
    event => event.revision === round.revision,
  )
  if (logged !== undefined) return logged.at
  if (round.decidedBy === 'deadline') return round.deadline
  const decisions = reviewFactsOf(events, round.revision).filter(
    review => review.decision !== 'comment',
  )
  const last = decisions[decisions.length - 1]
  return last?.at ?? publishedAtOf(events, round.revision)
}

// NOTE: The standing decision of each reviewer, from the log.
export const standingFacts = (
  events: ReadonlyArray<ReportEvent>,
  revision: number,
): ReadonlyMap<string, ReviewFact> => {
  const standing = new Map<string, ReviewFact>()
  for (const review of reviewFactsOf(events, revision)) {
    if (review.decision !== 'comment') standing.set(review.reviewerId, review)
  }
  return standing
}

// NOTE: Who has decided in the round according to the flow itself.
export const decidedReviewers = (round: Round): ReadonlySet<string> =>
  new Set(standingDecisions(round.reviews, round.revision).keys())
