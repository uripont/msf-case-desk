import { Array, Match, Order, pipe } from 'effect'

import { type Case } from './case'
import { type Priority, type TriageRules } from './rules'
import { type TriageResult, triage } from './triage'

const HOUR_MS = 3_600_000
export const DUE_SOON_HOURS = 6

export type SlaStatus =
  | { readonly _tag: 'OnTrack'; readonly remainingMs: number }
  | { readonly _tag: 'DueSoon'; readonly remainingMs: number }
  | { readonly _tag: 'Overdue'; readonly overdueMs: number }

export type TriagedCase = {
  readonly triageCase: Case
  readonly result: TriageResult
  readonly sla: SlaStatus
}

export const slaStatus = (dueAt: number, now: number): SlaStatus => {
  const remainingMs = dueAt - now
  if (remainingMs < 0) {
    return { _tag: 'Overdue', overdueMs: -remainingMs }
  }
  if (remainingMs <= DUE_SOON_HOURS * HOUR_MS) {
    return { _tag: 'DueSoon', remainingMs }
  }
  return { _tag: 'OnTrack', remainingMs }
}

const priorityRank = (priority: Priority): number =>
  Match.value(priority).pipe(
    Match.when('P1', () => 0),
    Match.when('P2', () => 1),
    Match.when('P3', () => 2),
    Match.exhaustive,
  )

const byPriority = Order.mapInput(Order.Number, (triaged: TriagedCase) =>
  priorityRank(triaged.result.priority),
)

const byDueAt = Order.mapInput(
  Order.Number,
  (triaged: TriagedCase) => triaged.result.dueAt,
)

const byCaseId = Order.mapInput(
  Order.String,
  (triaged: TriagedCase) => triaged.triageCase.id,
)

export const prioritise = (
  rules: TriageRules,
  cases: ReadonlyArray<Case>,
  now: number,
): ReadonlyArray<TriagedCase> =>
  pipe(
    cases,
    Array.map((triageCase): TriagedCase => {
      const result = triage(rules, triageCase)
      return { triageCase, result, sla: slaStatus(result.dueAt, now) }
    }),
    Array.sort(Order.combineAll([byPriority, byDueAt, byCaseId])),
  )

export const countByPriority = (
  queue: ReadonlyArray<TriagedCase>,
  priority: Priority,
): number =>
  Array.filter(queue, triaged => triaged.result.priority === priority).length
