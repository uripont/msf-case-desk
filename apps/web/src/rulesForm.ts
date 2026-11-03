import { Array, Option, Result, Schema, pipe } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import {
  type Case,
  MAX_TARGET_HOURS,
  PRIORITIES,
  type Priority,
  RULES_MAX_SCORE,
  type RuleSet,
  RuleSetScope,
  type TriageRules,
  decodeTriageRules,
  rulesFor,
  rulesProblemsOf,
  triage,
} from '@case-desk/domain'

import { ApiFailure } from './api'

// MODEL

export const RulesSubmission = defineTaggedUnion({
  Editing: {},
  Saving: {},
  Saved: {},
  Failed: { failure: ApiFailure },
})
export type RulesSubmission = typeof RulesSubmission.Type

export const RulesField = Schema.Literals([
  'version',
  'p1MinScore',
  'p2MinScore',
  'fastTrackHours',
  'targetP1',
  'targetP2',
  'targetP3',
])
export type RulesField = typeof RulesField.Type

export const RulesForm = Schema.Struct({
  scope: RuleSetScope,
  version: Schema.String,
  p1MinScore: Schema.String,
  p2MinScore: Schema.String,
  fastTrackHours: Schema.String,
  targetP1: Schema.String,
  targetP2: Schema.String,
  targetP3: Schema.String,
  isShowingErrors: Schema.Boolean,
  submission: RulesSubmission,
})
export type RulesForm = typeof RulesForm.Type

export const rulesFormFor = (
  ruleSets: ReadonlyArray<RuleSet>,
  scope: RuleSetScope,
): RulesForm => {
  const rules = rulesFor(ruleSets, scope)
  return RulesForm.make({
    scope,
    version: rules.version,
    p1MinScore: String(rules.p1MinScore),
    p2MinScore: String(rules.p2MinScore),
    fastTrackHours: String(rules.fastTrackHours),
    targetP1: String(rules.targetHours.P1),
    targetP2: String(rules.targetHours.P2),
    targetP3: String(rules.targetHours.P3),
    isShowingErrors: false,
    submission: RulesSubmission.Editing(),
  })
}

export const ownRuleSetOf = (
  ruleSets: ReadonlyArray<RuleSet>,
  scope: RuleSetScope,
): Option.Option<RuleSet> =>
  Array.findFirst(ruleSets, ruleSet => ruleSet.scope === scope)

// VALIDATION

export type RulesErrors = Partial<Record<RulesField, string>>

const parseWhole = (text: string): Option.Option<number> =>
  pipe(
    Option.liftPredicate(text.trim(), value => /^\d{1,4}$/.test(value)),
    Option.map(Number),
  )

const rangeError = (
  field: RulesField,
  text: string,
  maximum: number,
  unit: string,
): RulesErrors =>
  Option.match(parseWhole(text), {
    onNone: () => ({ [field]: `Enter a whole number of ${unit}.` }),
    onSome: value =>
      value < 1 || value > maximum
        ? { [field]: `Use between 1 and ${maximum} ${unit}.` }
        : {},
  })

const PROBLEM_FIELDS: Record<string, RulesField> = {
  p2MinScore: 'p2MinScore',
  fastTrackHours: 'fastTrackHours',
  'targetHours.P2': 'targetP2',
  'targetHours.P3': 'targetP3',
}

const draftOf = (form: RulesForm): Option.Option<TriageRules> =>
  Option.all({
    p1MinScore: parseWhole(form.p1MinScore),
    p2MinScore: parseWhole(form.p2MinScore),
    fastTrackHours: parseWhole(form.fastTrackHours),
    P1: parseWhole(form.targetP1),
    P2: parseWhole(form.targetP2),
    P3: parseWhole(form.targetP3),
  }).pipe(
    Option.map(({ p1MinScore, p2MinScore, fastTrackHours, P1, P2, P3 }) => ({
      version: form.version.trim(),
      p1MinScore,
      p2MinScore,
      fastTrackHours,
      targetHours: { P1, P2, P3 },
    })),
  )

export const rulesErrorsOf = (form: RulesForm): RulesErrors => {
  const fieldErrors: RulesErrors = {
    ...(form.version.trim() === ''
      ? { version: 'Give this version of the rules a name.' }
      : {}),
    ...(form.version.trim().length > 40
      ? { version: 'Keep the name under 40 characters.' }
      : {}),
    ...rangeError('p1MinScore', form.p1MinScore, RULES_MAX_SCORE, 'points'),
    ...rangeError('p2MinScore', form.p2MinScore, RULES_MAX_SCORE, 'points'),
    ...rangeError(
      'fastTrackHours',
      form.fastTrackHours,
      MAX_TARGET_HOURS,
      'hours',
    ),
    ...rangeError('targetP1', form.targetP1, MAX_TARGET_HOURS, 'hours'),
    ...rangeError('targetP2', form.targetP2, MAX_TARGET_HOURS, 'hours'),
    ...rangeError('targetP3', form.targetP3, MAX_TARGET_HOURS, 'hours'),
  }
  if (Object.keys(fieldErrors).length > 0) {
    return fieldErrors
  }
  return Option.match(draftOf(form), {
    onNone: () => fieldErrors,
    onSome: draft =>
      Object.fromEntries(
        Array.filterMap(
          rulesProblemsOf(draft),
          ({ path, issue }): Result.Result<[RulesField, string], void> =>
            Option.match(Option.fromNullishOr(PROBLEM_FIELDS[path.join('.')]), {
              onNone: () => Result.failVoid,
              onSome: field => Result.succeed([field, `${issue}.`]),
            }),
        ),
      ),
  })
}

export const rulesOfForm = (
  form: RulesForm,
): Result.Result<TriageRules, RulesErrors> => {
  const errors = rulesErrorsOf(form)
  if (Object.keys(errors).length > 0) {
    return Result.fail(errors)
  }
  return Option.match(draftOf(form), {
    onNone: () => Result.fail<RulesErrors>({ version: 'Check every field.' }),
    onSome: draft =>
      Result.mapError(decodeTriageRules(draft), (): RulesErrors => ({
        version: 'Check every field.',
      })),
  })
}

// PREVIEW

export type GroupCount = Readonly<{
  priority: Priority
  before: number
  after: number
}>

export type RulesPreview = Readonly<{
  affectedCases: number
  groups: ReadonlyArray<GroupCount>
  moved: ReadonlyArray<
    Readonly<{ triageCase: Case; before: Priority; after: Priority }>
  >
}>

// NOTE: which cases a rule set decides. The default set decides every centre
// that has no rule set of its own.
const isDecidedBy = (
  ruleSets: ReadonlyArray<RuleSet>,
  scope: RuleSetScope,
  triageCase: Case,
): boolean =>
  scope === 'Default'
    ? Option.isNone(
        Array.findFirst(
          ruleSets,
          ruleSet => ruleSet.scope === triageCase.centre,
        ),
      )
    : triageCase.centre === scope

export const previewOfRules = (
  form: RulesForm,
  ruleSets: ReadonlyArray<RuleSet>,
  cases: ReadonlyArray<Case>,
): Option.Option<RulesPreview> =>
  Option.map(Result.getSuccess(rulesOfForm(form)), draft => {
    const current = rulesFor(ruleSets, form.scope)
    const decided = Array.filter(cases, triageCase =>
      isDecidedBy(ruleSets, form.scope, triageCase),
    )
    const compared = Array.map(decided, triageCase => ({
      triageCase,
      before: triage(current, triageCase).priority,
      after: triage(draft, triageCase).priority,
    }))
    return {
      affectedCases: decided.length,
      groups: Array.map(PRIORITIES, priority => ({
        priority,
        before: Array.filter(compared, row => row.before === priority).length,
        after: Array.filter(compared, row => row.after === priority).length,
      })),
      moved: Array.filter(compared, row => row.before !== row.after),
    }
  })
