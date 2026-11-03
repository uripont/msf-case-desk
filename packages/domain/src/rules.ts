import { Array, Match, Option, Result, Schema, pipe } from 'effect'

import { OperationalCentre } from './case'
import { Tolerant } from './compat'

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

export const MAX_TARGET_HOURS = 24 * 30

// NOTE: the maximum score is fixed by the points table in triage.ts.
export const RULES_MAX_SCORE = 10

const Hours = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_TARGET_HOURS }),
)

export type RulesProblem = Readonly<{
  path: ReadonlyArray<string>
  issue: string
}>

// NOTE: the consistency checks between fields, shared by the schema below
// and the rules editor, so both explain a problem in the same words.
export const rulesProblemsOf = (
  rules: TriageRules,
): ReadonlyArray<RulesProblem> =>
  Array.filterMap(
    [
      {
        isBroken: rules.p2MinScore >= rules.p1MinScore,
        path: ['p2MinScore'],
        issue: 'The medium level must start below the urgent level',
      },
      {
        isBroken: rules.fastTrackHours > rules.targetHours.P1,
        path: ['fastTrackHours'],
        issue: 'The fast-track target cannot be longer than the urgent target',
      },
      {
        isBroken: rules.targetHours.P1 > rules.targetHours.P2,
        path: ['targetHours', 'P2'],
        issue: 'The medium target cannot be shorter than the urgent target',
      },
      {
        isBroken: rules.targetHours.P2 > rules.targetHours.P3,
        path: ['targetHours', 'P3'],
        issue: 'The standard target cannot be shorter than the medium target',
      },
    ],
    ({ isBroken, path, issue }): Result.Result<RulesProblem, void> =>
      isBroken ? Result.succeed({ path, issue }) : Result.failVoid,
  )

export const ValidTriageRules = Schema.Struct({
  version: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(40)),
  p1MinScore: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: RULES_MAX_SCORE }),
  ),
  p2MinScore: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: RULES_MAX_SCORE }),
  ),
  fastTrackHours: Hours,
  targetHours: Schema.Struct({ P1: Hours, P2: Hours, P3: Hours }),
}).check(
  Schema.makeFilter(rules =>
    rulesProblemsOf(rules).map(({ path, issue }) => ({
      path: [...path],
      issue,
    })),
  ),
)

export const decodeTriageRules = Schema.decodeUnknownResult(ValidTriageRules)

export const RuleSetScope = Schema.Literals([
  'Default',
  ...OperationalCentre.literals,
])
export type RuleSetScope = typeof RuleSetScope.Type

export const RULE_SET_SCOPES: ReadonlyArray<RuleSetScope> =
  RuleSetScope.literals

export const RULES_SCHEMA_VERSION = 1

// NOTE: RuleSet is the reader for stored rule sets, so its scope is tolerant.
export const RuleSet = Schema.Struct({
  scope: Tolerant(RuleSetScope),
  rules: TriageRules,
  updatedAt: Schema.Int,
  updatedByName: Schema.String,
})
export type RuleSet = typeof RuleSet.Type

export const rulesFor = (
  ruleSets: ReadonlyArray<RuleSet>,
  centre: string,
): TriageRules => {
  const findScope = (scope: string) =>
    Array.findFirst(ruleSets, ruleSet => ruleSet.scope === scope)
  return pipe(
    findScope(centre),
    Option.orElse(() => findScope('Default')),
    Option.match({
      onNone: () => DEFAULT_RULES,
      onSome: ruleSet => ruleSet.rules,
    }),
  )
}
