import { Schema } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  Case,
  DEFAULT_RULES,
  FAST_TRACK_SIGNALS,
  MAX_SCORE,
  RISKS,
  SCOPES,
  SEED_CASES,
  URGENCIES,
  describeReason,
  riskPoints,
  scopePoints,
  triage,
  urgencyPoints,
} from './index'

const caseArbitrary = fc.record({
  id: fc.constant('PROP-1'),
  centre: fc.constantFrom('OCA', 'OCB', 'OCBA', 'OCG', 'OCP'),
  summary: fc.constant('Synthetic case for property tests.'),
  channel: fc.constantFrom(
    'IntegrityLine',
    'Email',
    'LineManager',
    'PartnerOrganisation',
  ),
  receivedAt: fc.integer({ min: 0, max: 4_000_000_000_000 }),
  scope: fc.constantFrom(...SCOPES),
  risk: fc.constantFrom(...RISKS),
  urgency: fc.constantFrom(...URGENCIES),
  fastTrackSignals: fc.array(fc.constantFrom(...FAST_TRACK_SIGNALS), {
    maxLength: 3,
  }),
})

const decode = Schema.decodeUnknownSync(Case)

const priorityRank = { P1: 0, P2: 1, P3: 2 } as const

describe('triage', () => {
  test('every seed case is a valid case', () => {
    expect(SEED_CASES.length).toBeGreaterThan(0)
  })

  test('a fast-track signal always gives P1 with the fast-track clock', () => {
    fc.assert(
      fc.property(
        caseArbitrary,
        fc.constantFrom(...FAST_TRACK_SIGNALS),
        (generated, signal) => {
          const triageCase = decode({
            ...generated,
            fastTrackSignals: [signal],
          })
          const result = triage(DEFAULT_RULES, triageCase)
          expect(result.priority).toBe('P1')
          expect(result.isFastTrack).toBe(true)
          expect(result.targetHours).toBe(DEFAULT_RULES.fastTrackHours)
        },
      ),
    )
  })

  test('the score never leaves its range', () => {
    fc.assert(
      fc.property(caseArbitrary, generated => {
        const result = triage(DEFAULT_RULES, decode(generated))
        expect(result.score).toBeGreaterThanOrEqual(0)
        expect(result.score).toBeLessThanOrEqual(MAX_SCORE)
      }),
    )
  })

  test('raising one factor never lowers the priority', () => {
    fc.assert(
      fc.property(
        caseArbitrary,
        fc.constantFrom('scope', 'risk', 'urgency'),
        (generated, factor) => {
          const base = decode({ ...generated, fastTrackSignals: [] })
          const raised = decode({
            ...base,
            scope: factor === 'scope' ? 'Systemic' : base.scope,
            risk: factor === 'risk' ? 'High' : base.risk,
            urgency: factor === 'urgency' ? 'Immediate' : base.urgency,
          })
          const before = triage(DEFAULT_RULES, base)
          const after = triage(DEFAULT_RULES, raised)
          expect(priorityRank[after.priority]).toBeLessThanOrEqual(
            priorityRank[before.priority],
          )
          expect(after.score).toBeGreaterThanOrEqual(before.score)
        },
      ),
    )
  })

  test('the result is deterministic', () => {
    fc.assert(
      fc.property(caseArbitrary, generated => {
        const triageCase = decode(generated)
        expect(triage(DEFAULT_RULES, triageCase)).toEqual(
          triage(DEFAULT_RULES, triageCase),
        )
      }),
    )
  })

  test('the due time is the reception time plus the target', () => {
    fc.assert(
      fc.property(caseArbitrary, generated => {
        const triageCase = decode(generated)
        const result = triage(DEFAULT_RULES, triageCase)
        expect(result.dueAt).toBe(
          triageCase.receivedAt + result.targetHours * 3_600_000,
        )
      }),
    )
  })

  test('every result explains itself', () => {
    fc.assert(
      fc.property(caseArbitrary, generated => {
        const result = triage(DEFAULT_RULES, decode(generated))
        expect(result.reasons.length).toBeGreaterThanOrEqual(4)
        result.reasons.forEach(reason => {
          expect(describeReason(reason).length).toBeGreaterThan(0)
        })
      }),
    )
  })

  test('points are monotonic in each factor', () => {
    expect(SCOPES.map(scopePoints)).toEqual([0, 1, 2])
    expect(RISKS.map(riskPoints)).toEqual([0, 2, 4])
    expect(URGENCIES.map(urgencyPoints)).toEqual([0, 2, 4])
  })

  test('a high risk and immediate team case reaches P1 without a signal', () => {
    const result = triage(
      DEFAULT_RULES,
      decode({
        id: 'T-1',
        centre: 'OCG',
        summary: 'Synthetic.',
        channel: 'Email',
        receivedAt: 0,
        scope: 'Team',
        risk: 'High',
        urgency: 'Immediate',
        fastTrackSignals: [],
      }),
    )
    expect(result.priority).toBe('P1')
    expect(result.isFastTrack).toBe(false)
    expect(result.targetHours).toBe(DEFAULT_RULES.targetHours.P1)
  })

  test('a low routine individual case is P3', () => {
    const result = triage(
      DEFAULT_RULES,
      decode({
        id: 'T-2',
        centre: 'OCBA',
        summary: 'Synthetic.',
        channel: 'Email',
        receivedAt: 0,
        scope: 'Individual',
        risk: 'Low',
        urgency: 'Routine',
        fastTrackSignals: [],
      }),
    )
    expect(result.priority).toBe('P3')
    expect(result.score).toBe(0)
  })

  test('malformed cases are rejected', () => {
    expect(() => decode({ id: '' })).toThrow()
    expect(() =>
      decode({
        id: 'X',
        centre: 'OCG',
        summary: '',
        channel: 'Email',
        receivedAt: 0,
        scope: 'Team',
        risk: 'High',
        urgency: 'Immediate',
        fastTrackSignals: [],
      }),
    ).toThrow()
  })
})

const storedCaseArbitrary = fc.record({
  id: fc.constant('PROP-2'),
  summary: fc.constant('Synthetic case written by a newer version.'),
  receivedAt: fc.integer({ min: 0, max: 4_000_000_000_000 }),
  centre: fc.oneof(fc.constantFrom('OCA', 'OCG'), fc.string()),
  channel: fc.oneof(fc.constantFrom('Email', 'IntegrityLine'), fc.string()),
  scope: fc.oneof(fc.constantFrom(...SCOPES), fc.string()),
  risk: fc.oneof(fc.constantFrom(...RISKS), fc.string()),
  urgency: fc.oneof(fc.constantFrom(...URGENCIES), fc.string()),
  fastTrackSignals: fc.array(
    fc.oneof(fc.constantFrom(...FAST_TRACK_SIGNALS), fc.string()),
    { maxLength: 3 },
  ),
})

describe('triage of values from newer versions', () => {
  const unknownCase = {
    id: 'U-1',
    centre: 'OCZ',
    summary: 'Synthetic.',
    channel: 'Chatbot',
    receivedAt: 0,
    scope: 'Global',
    risk: 'Critical',
    urgency: 'Extreme',
    fastTrackSignals: ['NewSignal'],
  }

  test('unrecognised values decode as Unknown', () => {
    expect(decode(unknownCase)).toMatchObject({
      centre: 'Unknown',
      channel: 'Unknown',
      scope: 'Unknown',
      risk: 'Unknown',
      urgency: 'Unknown',
      fastTrackSignals: ['Unknown'],
    })
  })

  test('an unknown risk or urgency counts as medium and says why', () => {
    const result = triage(DEFAULT_RULES, decode(unknownCase))
    expect(result.score).toBe(riskPoints('Medium') + urgencyPoints('Elevated'))
    expect(result.isFastTrack).toBe(false)
    const unrecognised = result.reasons.filter(
      reason => reason._tag === 'Unrecognised',
    )
    expect(unrecognised.map(reason => reason.field)).toEqual([
      'Centre',
      'Channel',
      'Scope',
      'Risk',
      'Urgency',
      'FastTrackSignal',
    ])
    unrecognised.forEach(reason => {
      expect(describeReason(reason)).toContain('unrecognised value')
    })
  })

  test('any stored case is scored without failing and explains itself', () => {
    fc.assert(
      fc.property(storedCaseArbitrary, generated => {
        const result = triage(DEFAULT_RULES, decode(generated))
        expect(result.score).toBeGreaterThanOrEqual(0)
        expect(result.score).toBeLessThanOrEqual(MAX_SCORE)
        expect(result.reasons.length).toBeGreaterThanOrEqual(4)
        result.reasons.forEach(reason => {
          expect(describeReason(reason).length).toBeGreaterThan(0)
        })
      }),
    )
  })

  test('raising a factor to a known level never lowers the priority', () => {
    fc.assert(
      fc.property(
        storedCaseArbitrary,
        fc.constantFrom('scope', 'risk', 'urgency'),
        (generated, factor) => {
          const base = decode({ ...generated, fastTrackSignals: [] })
          const raised = decode({
            ...base,
            scope: factor === 'scope' ? 'Systemic' : base.scope,
            risk: factor === 'risk' ? 'High' : base.risk,
            urgency: factor === 'urgency' ? 'Immediate' : base.urgency,
          })
          const before = triage(DEFAULT_RULES, base)
          const after = triage(DEFAULT_RULES, raised)
          expect(priorityRank[after.priority]).toBeLessThanOrEqual(
            priorityRank[before.priority],
          )
        },
      ),
    )
  })
})
