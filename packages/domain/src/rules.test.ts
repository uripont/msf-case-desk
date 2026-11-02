import { Result } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  type Case,
  DEFAULT_RULES,
  type RuleSet,
  SEED_CASES,
  type TriageRules,
  decodeCaseEntry,
  decodeTriageRules,
  prioritiseByCentre,
  rulesFor,
  triage,
} from './index'

const ruleSet = (scope: RuleSet['scope'], rules: TriageRules): RuleSet => ({
  scope,
  rules,
  updatedAt: 0,
  updatedByName: 'Synthetic tester',
})

const validEntry = {
  centre: 'OCG',
  receivedAt: 0,
  summary: 'Synthetic report about a team.',
  scope: 'Team',
  risk: 'Medium',
  urgency: 'Elevated',
  fastTrackSignals: [],
}

describe('case entry', () => {
  test('a minimal entry is valid', () => {
    expect(Result.isSuccess(decodeCaseEntry(validEntry))).toBe(true)
  })

  test('optional fields are accepted', () => {
    const entry = decodeCaseEntry({
      ...validEntry,
      channel: 'Email',
      details: 'More synthetic detail.',
      location: 'Synthetic project',
      reference: 'IL-0001',
    })
    expect(Result.isSuccess(entry)).toBe(true)
  })

  test('entries are strict about the values they accept', () => {
    const invalid = [
      { ...validEntry, summary: '' },
      { ...validEntry, summary: '  padded  ' },
      { ...validEntry, centre: 'OCZ' },
      { ...validEntry, risk: 'Critical' },
      { ...validEntry, receivedAt: -1 },
      { ...validEntry, fastTrackSignals: ['Retaliation', 'Retaliation'] },
      { ...validEntry, summary: 'x'.repeat(501) },
    ]
    invalid.forEach(entry => {
      expect(Result.isFailure(decodeCaseEntry(entry))).toBe(true)
    })
  })
})

describe('triage rules', () => {
  test('the default rules are valid', () => {
    expect(Result.isSuccess(decodeTriageRules(DEFAULT_RULES))).toBe(true)
  })

  test('inconsistent rules are rejected', () => {
    const invalid: ReadonlyArray<TriageRules> = [
      { ...DEFAULT_RULES, p2MinScore: 7, p1MinScore: 7 },
      { ...DEFAULT_RULES, p1MinScore: 11 },
      { ...DEFAULT_RULES, p2MinScore: 0 },
      { ...DEFAULT_RULES, fastTrackHours: 60 },
      { ...DEFAULT_RULES, targetHours: { P1: 48, P2: 24, P3: 96 } },
      { ...DEFAULT_RULES, targetHours: { P1: 48, P2: 72, P3: 0 } },
      { ...DEFAULT_RULES, version: '' },
    ]
    invalid.forEach(rules => {
      expect(Result.isFailure(decodeTriageRules(rules))).toBe(true)
    })
  })

  test('lowering the urgent threshold raises a case predictably', () => {
    const mediumCase: Case = {
      ...SEED_CASES[0]!,
      scope: 'Team',
      risk: 'High',
      urgency: 'Routine',
      fastTrackSignals: [],
    }
    const before = triage(DEFAULT_RULES, mediumCase)
    const after = triage({ ...DEFAULT_RULES, p1MinScore: 5 }, mediumCase)
    expect(before.priority).toBe('P2')
    expect(after.priority).toBe('P1')
    expect(after.score).toBe(before.score)
  })

  test('a longer target moves the due time by the same amount', () => {
    const triageCase: Case = { ...SEED_CASES[0]!, fastTrackSignals: [] }
    const before = triage(DEFAULT_RULES, triageCase)
    const longer = {
      ...DEFAULT_RULES,
      targetHours: {
        P1: DEFAULT_RULES.targetHours.P1 + 12,
        P2: DEFAULT_RULES.targetHours.P2 + 12,
        P3: DEFAULT_RULES.targetHours.P3 + 12,
      },
    }
    const after = triage(longer, triageCase)
    expect(after.dueAt - before.dueAt).toBe(12 * 3_600_000)
  })
})

describe('rule sets per centre', () => {
  const strict = { ...DEFAULT_RULES, version: 'ocg-1', p1MinScore: 5 }
  const lenient = { ...DEFAULT_RULES, version: 'default-2', p1MinScore: 9 }

  test('a centre uses its own rule set, then the default one', () => {
    const sets = [ruleSet('OCG', strict), ruleSet('Default', lenient)]
    expect(rulesFor(sets, 'OCG')).toBe(strict)
    expect(rulesFor(sets, 'OCA')).toBe(lenient)
    expect(rulesFor([], 'OCA')).toBe(DEFAULT_RULES)
    expect(rulesFor(sets, 'Unknown')).toBe(lenient)
  })

  test('the queue scores each case with the rules of its centre', () => {
    const sets = [ruleSet('OCG', strict)]
    const queue = prioritiseByCentre(sets, SEED_CASES, 0)
    queue.forEach(({ triageCase, result }) => {
      const rules = triageCase.centre === 'OCG' ? strict : DEFAULT_RULES
      expect(result).toEqual(triage(rules, triageCase))
    })
  })
})
