import { Match, Schema } from 'effect'

export const Priority = Schema.Literals(['P1', 'P2', 'P3'])
export type Priority = typeof Priority.Type

export const PRIORITIES: ReadonlyArray<Priority> = Priority.literals

export const TriageRules = Schema.Struct({
  version: Schema.NonEmptyString,
  p1MinScore: Schema.Int,
  p2MinScore: Schema.Int,
  fastTrackHours: Schema.Int,
  targetHours: Schema.Struct({
    P1: Schema.Int,
    P2: Schema.Int,
    P3: Schema.Int,
  }),
})
export type TriageRules = typeof TriageRules.Type

export const DEFAULT_RULES: TriageRules = {
  version: 'draft-0.1',
  p1MinScore: 7,
  p2MinScore: 4,
  fastTrackHours: 24,
  targetHours: { P1: 48, P2: 72, P3: 96 },
}

export const priorityLabel = (priority: Priority): string =>
  Match.value(priority).pipe(
    Match.when('P1', () => 'urgent'),
    Match.when('P2', () => 'medium'),
    Match.when('P3', () => 'standard'),
    Match.exhaustive,
  )
