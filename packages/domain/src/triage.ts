import { Array, Match, Result, Schema, pipe } from 'effect'

import {
  type Case,
  type FastTrackSignal,
  type Risk,
  type Scope,
  type Urgency,
} from './case'
import { UNKNOWN, type Unknown } from './compat'
import { type Priority, type TriageRules, priorityLabel } from './rules'

const HOUR_MS = 3_600_000

export const Factor = Schema.Literals(['Scope', 'Risk', 'Urgency'])
export type Factor = typeof Factor.Type

export const CaseField = Schema.Literals([
  'Centre',
  'Channel',
  'Scope',
  'Risk',
  'Urgency',
  'FastTrackSignal',
])
export type CaseField = typeof CaseField.Type

export const Reason = Schema.Union([
  Schema.TaggedStruct('FastTrackSignal', {
    signal: Schema.Literals([
      'ImmediatePhysicalSafety',
      'Exploitation',
      'Retaliation',
    ]),
  }),
  Schema.TaggedStruct('Scored', {
    factor: Factor,
    level: Schema.String,
    points: Schema.Int,
  }),
  Schema.TaggedStruct('ReachedThreshold', {
    priority: Schema.Literals(['P1', 'P2']),
    minScore: Schema.Int,
    score: Schema.Int,
  }),
  Schema.TaggedStruct('BelowThresholds', { score: Schema.Int }),
  Schema.TaggedStruct('Unrecognised', {
    field: CaseField,
    points: Schema.Int,
  }),
])
export type Reason = typeof Reason.Type

export type TriageResult = {
  readonly priority: Priority
  readonly score: number
  readonly isFastTrack: boolean
  readonly targetHours: number
  readonly dueAt: number
  readonly reasons: ReadonlyArray<Reason>
}

export const scopePoints = (scope: Scope | Unknown): number =>
  Match.value(scope).pipe(
    Match.when('Individual', () => 0),
    Match.when('Team', () => 1),
    Match.when('Systemic', () => 2),
    Match.when(UNKNOWN, () => 0),
    Match.exhaustive,
  )

export const riskPoints = (risk: Risk | Unknown): number =>
  Match.value(risk).pipe(
    Match.when('Low', () => 0),
    Match.when('Medium', () => 2),
    Match.when('High', () => 4),
    Match.when(UNKNOWN, () => riskPoints('Medium')),
    Match.exhaustive,
  )

export const urgencyPoints = (urgency: Urgency | Unknown): number =>
  Match.value(urgency).pipe(
    Match.when('Routine', () => 0),
    Match.when('Elevated', () => 2),
    Match.when('Immediate', () => 4),
    Match.when(UNKNOWN, () => urgencyPoints('Elevated')),
    Match.exhaustive,
  )

export const MAX_SCORE = 2 + 4 + 4

const scoredReasons = (triageCase: Case): ReadonlyArray<Reason> => [
  {
    _tag: 'Scored',
    factor: 'Scope',
    level: triageCase.scope,
    points: scopePoints(triageCase.scope),
  },
  {
    _tag: 'Scored',
    factor: 'Risk',
    level: triageCase.risk,
    points: riskPoints(triageCase.risk),
  },
  {
    _tag: 'Scored',
    factor: 'Urgency',
    level: triageCase.urgency,
    points: urgencyPoints(triageCase.urgency),
  },
]

const isKnownSignal = (
  signal: FastTrackSignal | Unknown,
): signal is FastTrackSignal => signal !== UNKNOWN

const fastTrackReasons = (
  signals: ReadonlyArray<FastTrackSignal | Unknown>,
): ReadonlyArray<Reason> =>
  Array.map(
    Array.dedupe(Array.filter(signals, isKnownSignal)),
    (signal): Reason => ({ _tag: 'FastTrackSignal', signal }),
  )

const unrecognisedReasons = (triageCase: Case): ReadonlyArray<Reason> =>
  Array.filterMap(
    [
      { field: 'Centre', isUnknown: triageCase.centre === UNKNOWN, points: 0 },
      {
        field: 'Channel',
        isUnknown: triageCase.channel === UNKNOWN,
        points: 0,
      },
      {
        field: 'Scope',
        isUnknown: triageCase.scope === UNKNOWN,
        points: scopePoints(UNKNOWN),
      },
      {
        field: 'Risk',
        isUnknown: triageCase.risk === UNKNOWN,
        points: riskPoints(UNKNOWN),
      },
      {
        field: 'Urgency',
        isUnknown: triageCase.urgency === UNKNOWN,
        points: urgencyPoints(UNKNOWN),
      },
      {
        field: 'FastTrackSignal',
        isUnknown: triageCase.fastTrackSignals.includes(UNKNOWN),
        points: 0,
      },
    ] satisfies ReadonlyArray<{
      field: CaseField
      isUnknown: boolean
      points: number
    }>,
    ({ field, isUnknown, points }): Result.Result<Reason, void> =>
      isUnknown
        ? Result.succeed({ _tag: 'Unrecognised', field, points })
        : Result.failVoid,
  )

const priorityForScore = (
  rules: TriageRules,
  score: number,
): { readonly priority: Priority; readonly reason: Reason } => {
  if (score >= rules.p1MinScore) {
    return {
      priority: 'P1',
      reason: {
        _tag: 'ReachedThreshold',
        priority: 'P1',
        minScore: rules.p1MinScore,
        score,
      },
    }
  }
  if (score >= rules.p2MinScore) {
    return {
      priority: 'P2',
      reason: {
        _tag: 'ReachedThreshold',
        priority: 'P2',
        minScore: rules.p2MinScore,
        score,
      },
    }
  }
  return { priority: 'P3', reason: { _tag: 'BelowThresholds', score } }
}

export const triage = (rules: TriageRules, triageCase: Case): TriageResult => {
  const scored = scoredReasons(triageCase)
  const score = pipe(
    scored,
    Array.reduce(0, (total, reason) =>
      reason._tag === 'Scored' ? total + reason.points : total,
    ),
  )
  const fastTrack = fastTrackReasons(triageCase.fastTrackSignals)
  const isFastTrack = Array.isReadonlyArrayNonEmpty(fastTrack)
  const byScore = priorityForScore(rules, score)
  const priority: Priority = isFastTrack ? 'P1' : byScore.priority
  const targetHours = isFastTrack
    ? rules.fastTrackHours
    : rules.targetHours[priority]

  return {
    priority,
    score,
    isFastTrack,
    targetHours,
    dueAt: triageCase.receivedAt + targetHours * HOUR_MS,
    reasons: [
      ...fastTrack,
      ...scored,
      byScore.reason,
      ...unrecognisedReasons(triageCase),
    ],
  }
}

const signalLabel = (signal: FastTrackSignal): string =>
  Match.value(signal).pipe(
    Match.when('ImmediatePhysicalSafety', () => 'immediate physical safety'),
    Match.when('Exploitation', () => 'exploitation'),
    Match.when('Retaliation', () => 'retaliation'),
    Match.exhaustive,
  )

const fieldLabel = (field: CaseField): string =>
  Match.value(field).pipe(
    Match.when('Centre', () => 'Operational centre'),
    Match.when('Channel', () => 'Channel'),
    Match.when('Scope', () => 'Scope'),
    Match.when('Risk', () => 'Risk'),
    Match.when('Urgency', () => 'Urgency'),
    Match.when('FastTrackSignal', () => 'Fast-track signal'),
    Match.exhaustive,
  )

export const describeReason = (reason: Reason): string =>
  Match.value(reason).pipe(
    Match.tagsExhaustive({
      FastTrackSignal: ({ signal }) =>
        `Fast-track signal: ${signalLabel(signal)}. These cases are always urgent and get the 24 hour clock.`,
      Scored: ({ factor, level, points }) =>
        `${factor}: ${level.toLowerCase()}, ${points} ${points === 1 ? 'point' : 'points'}`,
      ReachedThreshold: ({ priority, minScore, score }) =>
        `${score} out of ${MAX_SCORE} points reaches the ${priorityLabel(priority)} level, which starts at ${minScore}`,
      BelowThresholds: ({ score }) =>
        `${score} out of ${MAX_SCORE} points is below the medium level, so this is standard`,
      Unrecognised: ({ field, points }) =>
        `${fieldLabel(field)}: unrecognised value, ${points === 0 ? 'no points' : `counted as medium, ${points} points`}. A newer version of Case Desk may have added it.`,
    }),
  )
