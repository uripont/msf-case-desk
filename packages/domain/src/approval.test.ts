import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  type ApprovalRule,
  type Participant,
  type ReviewDecision,
  type ReviewRecord,
  type Template,
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
  checkPublishable,
  chooseParticipants,
  publishProblems,
  roleChoices,
  ruleCanBeMet,
  ruleMet,
  standingDecisions,
  tallyRound,
  votingRolesOf,
} from './index'
import {
  AUTHOR_IDS,
  flowTemplateArbitrary,
  satisfiableParticipants,
  unsatisfiableParticipants,
} from './testing/reports'
import { PANEL_TEMPLATE } from './testing/templates'

// An oracle written another way from the code: how many approvals a rule
// needs among `voters`.
const threshold = (rule: ApprovalRule, voters: number): number =>
  rule.kind === 'all'
    ? voters
    : rule.kind === 'at_least'
      ? rule.count
      : Math.floor(voters / 2) + 1

const votersByRole = (template: Template, people: ReadonlyArray<Participant>) =>
  votingRolesOf(template)
    .filter(role => role.kind === 'reviewing')
    .map(role => ({
      role,
      voters: people.filter(p => p.roleId === role.id),
    }))

const approvals = (
  who: ReadonlyArray<Participant>,
  revision: number,
): ReadonlyArray<ReviewRecord> =>
  who.map(p => ({
    reviewerId: p.accountId,
    revision,
    decision: 'approve' as const,
  }))

describe('ruleMet', () => {
  test('decides exactly at the threshold, for every voter count', () => {
    const rules: ReadonlyArray<ApprovalRule> = [
      { kind: 'all' },
      { kind: 'majority' },
      { kind: 'at_least', count: 1 },
      { kind: 'at_least', count: 3 },
    ]
    for (const rule of rules) {
      for (let voters = 0; voters <= 9; voters++) {
        for (let count = 0; count <= voters; count++) {
          const expected = voters >= 1 && count >= threshold(rule, voters)
          expect(ruleMet(rule, voters, count)).toBe(expected)
        }
      }
    }
  })

  test('a majority is more than half, so a tie is not a majority', () => {
    expect(ruleMet({ kind: 'majority' }, 4, 2)).toBe(false)
    expect(ruleMet({ kind: 'majority' }, 4, 3)).toBe(true)
    expect(ruleMet({ kind: 'majority' }, 1, 1)).toBe(true)
    expect(ruleMet({ kind: 'majority' }, 3, 2)).toBe(true)
  })

  test('nothing is met with no voters', () => {
    expect(ruleMet({ kind: 'all' }, 0, 0)).toBe(false)
    expect(ruleMet({ kind: 'majority' }, 0, 0)).toBe(false)
  })

  test('ruleCanBeMet', () => {
    expect(ruleCanBeMet({ kind: 'all' }, 0)).toBe(false)
    expect(ruleCanBeMet({ kind: 'all' }, 1)).toBe(true)
    expect(ruleCanBeMet({ kind: 'at_least', count: 3 }, 2)).toBe(false)
    expect(ruleCanBeMet({ kind: 'at_least', count: 3 }, 3)).toBe(true)
    expect(ruleCanBeMet({ kind: 'at_least', count: 0 }, 3)).toBe(false)
  })
})

describe('standing decisions', () => {
  const r = (
    reviewerId: string,
    decision: ReviewDecision,
    revision = 1,
  ): ReviewRecord => ({ reviewerId, revision, decision })

  test('the latest approve or request-changes counts', () => {
    const standing = standingDecisions(
      [r('a', 'approve'), r('a', 'request_changes'), r('b', 'request_changes')],
      1,
    )
    expect(standing.get('a')).toBe('request_changes')
    expect(standing.get('b')).toBe('request_changes')
    expect(
      standingDecisions([r('a', 'request_changes'), r('a', 'approve')], 1).get(
        'a',
      ),
    ).toBe('approve')
  })

  test('a comment-only review is not a decision and changes nothing', () => {
    const standing = standingDecisions(
      [r('a', 'approve'), r('a', 'comment'), r('b', 'comment')],
      1,
    )
    expect(standing.get('a')).toBe('approve')
    expect(standing.has('b')).toBe(false)
  })

  test('another revision is ignored', () => {
    expect(standingDecisions([r('a', 'approve', 1)], 2).size).toBe(0)
  })
})

describe('a round meets its rule only when every voting role meets its own', () => {
  test('the panel: chair by majority of one, members at least two, observer silent', () => {
    const people: ReadonlyArray<Participant> = [
      { accountId: 'c', roleId: 'chair' },
      { accountId: 'm1', roleId: 'members' },
      { accountId: 'm2', roleId: 'members' },
      { accountId: 'm3', roleId: 'members' },
      { accountId: 'o', roleId: 'observer' },
    ]
    const round = (ids: ReadonlyArray<string>) =>
      tallyRound(PANEL_TEMPLATE, {
        revision: 1,
        participants: people,
        reviews: ids.map(id => ({
          reviewerId: id,
          revision: 1,
          decision: 'approve' as const,
        })),
      })
    expect(round(['c', 'm1']).met).toBe(false)
    expect(round(['m1', 'm2', 'm3']).met).toBe(false)
    expect(round(['c', 'm1', 'm2']).met).toBe(true)
    // The observer neither votes nor is needed.
    expect(round(['c', 'm1', 'm2', 'o']).met).toBe(true)
    expect(round(['o']).met).toBe(false)
  })

  test('the built-in templates need every committee member', () => {
    const people: ReadonlyArray<Participant> = ['a', 'b', 'c'].map(id => ({
      accountId: id,
      roleId: 'committee',
    }))
    for (const template of [INTAKE_TEMPLATE, INVESTIGATION_TEMPLATE]) {
      const tally = (who: ReadonlyArray<Participant>) =>
        tallyRound(template, {
          revision: 1,
          participants: people,
          reviews: approvals(who, 1),
        }).met
      expect(tally(people.slice(0, 2))).toBe(false)
      expect(tally(people)).toBe(true)
    }
  })

  test('a request for changes blocks the all rule', () => {
    const people: ReadonlyArray<Participant> = ['a', 'b'].map(id => ({
      accountId: id,
      roleId: 'committee',
    }))
    const tally = tallyRound(INTAKE_TEMPLATE, {
      revision: 1,
      participants: people,
      reviews: [
        ...approvals(people, 1),
        { reviewerId: 'b', revision: 1, decision: 'request_changes' },
      ],
    })
    expect(tally.met).toBe(false)
    expect(tally.roles[0]?.changesRequested).toBe(1)
  })

  test('property: all roles at threshold meet, one role one approval short does not', () => {
    fc.assert(
      fc.property(
        flowTemplateArbitrary.chain(template =>
          fc.tuple(
            fc.constant(template),
            satisfiableParticipants(template),
            fc.nat(100),
          ),
        ),
        ([template, people, lowerPick]) => {
          const groups = votersByRole(template, people)
          const atThreshold = groups.flatMap(({ role, voters }) =>
            voters.slice(
              0,
              threshold(role.approval ?? { kind: 'all' }, voters.length),
            ),
          )
          const tally = (who: ReadonlyArray<Participant>) =>
            tallyRound(template, {
              revision: 3,
              participants: people,
              reviews: approvals(who, 3),
            })
          expect(tally(atThreshold).met).toBe(true)
          const target = groups[lowerPick % groups.length]
          if (target === undefined) return
          const short = atThreshold.filter(
            (p, index) =>
              !(
                p.roleId === target.role.id &&
                index === atThreshold.findIndex(q => q.roleId === p.roleId)
              ),
          )
          expect(tally(short).met).toBe(false)
        },
      ),
      { numRuns: 300 },
    )
  })

  test('property: the tally equals an oracle for any mix of reviews', () => {
    fc.assert(
      fc.property(
        flowTemplateArbitrary.chain(template =>
          fc.tuple(
            fc.constant(template),
            satisfiableParticipants(template),
            fc.array(
              fc.record({
                who: fc.nat(100),
                decision: fc.constantFrom<ReviewDecision>(
                  'approve',
                  'approve',
                  'request_changes',
                  'comment',
                ),
              }),
              { maxLength: 30 },
            ),
          ),
        ),
        ([template, people, picks]) => {
          const reviews: ReadonlyArray<ReviewRecord> = picks.map(
            ({ who, decision }) => ({
              reviewerId: people[who % people.length]?.accountId ?? 'x',
              revision: 1,
              decision,
            }),
          )
          const last = new Map<string, ReviewDecision>()
          for (const review of reviews) {
            if (review.decision !== 'comment') {
              last.set(review.reviewerId, review.decision)
            }
          }
          const expected = votersByRole(template, people).every(
            ({ role, voters }) =>
              voters.length > 0 &&
              voters.filter(p => last.get(p.accountId) === 'approve').length >=
                threshold(role.approval ?? { kind: 'all' }, voters.length),
          )
          expect(
            tallyRound(template, { revision: 1, participants: people, reviews })
              .met,
          ).toBe(expected)
        },
      ),
      { numRuns: 300 },
    )
  })

  test('property: an older approval never counts for the latest revision', () => {
    fc.assert(
      fc.property(
        flowTemplateArbitrary.chain(template =>
          fc.tuple(fc.constant(template), satisfiableParticipants(template)),
        ),
        ([template, people]) => {
          // Everyone approved Revision 1; Revision 2 has no review of its own.
          const old = approvals(people, 1)
          const latest = tallyRound(template, {
            revision: 2,
            participants: people,
            reviews: old,
          })
          expect(latest.met).toBe(false)
          expect(latest.roles.every(role => role.approvals === 0)).toBe(true)
          // And it still decides Revision 1, where they were written.
          expect(
            tallyRound(template, {
              revision: 1,
              participants: people,
              reviews: old,
            }).met,
          ).toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })

  test('property: only the reviews of the round count, whatever else is there', () => {
    fc.assert(
      fc.property(
        flowTemplateArbitrary.chain(template =>
          fc.tuple(
            fc.constant(template),
            satisfiableParticipants(template),
            fc.array(
              fc.record({
                who: fc.nat(100),
                revision: fc.integer({ min: 1, max: 3 }),
                decision: fc.constantFrom<ReviewDecision>(
                  'approve',
                  'request_changes',
                  'comment',
                ),
              }),
              { maxLength: 30 },
            ),
          ),
        ),
        ([template, people, picks]) => {
          const reviews = picks.map(({ who, revision, decision }) => ({
            reviewerId: people[who % people.length]?.accountId ?? 'x',
            revision,
            decision,
          }))
          const input = { revision: 2, participants: people }
          expect(tallyRound(template, { ...input, reviews })).toEqual(
            tallyRound(template, {
              ...input,
              reviews: reviews.filter(r => r.revision === 2),
            }),
          )
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('publishing refuses a rule that cannot be met', () => {
  test('property: people that satisfy every rule are accepted', () => {
    fc.assert(
      fc.property(
        flowTemplateArbitrary.chain(template =>
          fc.tuple(fc.constant(template), satisfiableParticipants(template)),
        ),
        ([template, people]) => {
          expect(publishProblems(template, people, AUTHOR_IDS)).toEqual([])
          expect(
            Result.isSuccess(checkPublishable(template, people, AUTHOR_IDS)),
          ).toBe(true)
        },
      ),
      { numRuns: 300 },
    )
  })

  test('property: people that break one voting role are always refused', () => {
    fc.assert(
      fc.property(
        flowTemplateArbitrary.chain(template =>
          fc.tuple(fc.constant(template), unsatisfiableParticipants(template)),
        ),
        ([template, people]) => {
          const result = checkPublishable(template, people, AUTHOR_IDS)
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(
              result.failure.some(
                p => p.code === 'no_voters' || p.code === 'rule_unmeetable',
              ),
            ).toBe(true)
          }
        },
      ),
      { numRuns: 300 },
    )
  })

  test('at least N above the number of voters, and a voting role with no voters', () => {
    const one: ReadonlyArray<Participant> = [
      { accountId: 'c', roleId: 'chair' },
      { accountId: 'm1', roleId: 'members' },
    ]
    const problems = publishProblems(PANEL_TEMPLATE, one, AUTHOR_IDS)
    expect(problems.map(p => p.code)).toEqual(['rule_unmeetable'])
    expect(problems[0]?.roleId).toBe('members')
    const none = publishProblems(PANEL_TEMPLATE, [], AUTHOR_IDS)
    expect(none.map(p => p.code)).toEqual(['no_voters', 'no_voters'])
  })

  test('an author, a person in two roles, a duplicate and a bad role are refused', () => {
    const base: ReadonlyArray<Participant> = [
      { accountId: 'c', roleId: 'chair' },
      { accountId: 'm1', roleId: 'members' },
      { accountId: 'm2', roleId: 'members' },
    ]
    const codes = (extra: ReadonlyArray<Participant>) =>
      publishProblems(PANEL_TEMPLATE, [...base, ...extra], ['author-1']).map(
        p => p.code,
      )
    expect(codes([])).toEqual([])
    expect(codes([{ accountId: 'author-1', roleId: 'observer' }])).toEqual([
      'person_is_author',
    ])
    expect(codes([{ accountId: 'c', roleId: 'observer' }])).toEqual([
      'person_in_two_roles',
    ])
    expect(codes([{ accountId: 'm1', roleId: 'members' }])).toEqual([
      'duplicate_in_role',
    ])
    expect(codes([{ accountId: 'z', roleId: 'nope' }])).toEqual([
      'unknown_role',
    ])
    expect(codes([{ accountId: 'z', roleId: 'drafters' }])).toEqual([
      'not_a_reviewing_role',
    ])
  })
})

describe('choosing people', () => {
  const committees = [
    { id: 'cm-1', unit: 'unit-a', members: ['a', 'b', 'c'] },
    { id: 'cm-2', unit: 'unit-a', members: ['c', 'd'] },
    { id: 'cm-3', unit: 'unit-b', members: ['x', 'y'] },
  ]
  const context = {
    template: PANEL_TEMPLATE,
    unit: 'unit-a',
    authors: ['author-1'],
    committees,
  }

  test('fills each role from committees and individual accounts, in role order', () => {
    const result = chooseParticipants(context, [
      {
        roleId: 'members',
        sources: [
          { kind: 'committee', committeeId: 'cm-1' },
          { kind: 'committee', committeeId: 'cm-2' },
        ],
      },
      { roleId: 'chair', sources: [{ kind: 'account', accountId: 'z' }] },
      { roleId: 'observer', sources: [{ kind: 'account', accountId: 'o' }] },
    ])
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success).toEqual([
        { accountId: 'z', roleId: 'chair' },
        { accountId: 'a', roleId: 'members' },
        { accountId: 'b', roleId: 'members' },
        { accountId: 'c', roleId: 'members' },
        { accountId: 'd', roleId: 'members' },
        { accountId: 'o', roleId: 'observer' },
      ])
    }
  })

  test('a person in two committees of one role counts once', () => {
    const result = chooseParticipants(
      { ...context, template: PANEL_TEMPLATE },
      [
        {
          roleId: 'members',
          sources: [
            { kind: 'committee', committeeId: 'cm-1' },
            { kind: 'committee', committeeId: 'cm-2' },
            { kind: 'account', accountId: 'a' },
          ],
        },
        { roleId: 'chair', sources: [{ kind: 'account', accountId: 'z' }] },
      ],
    )
    expect(Result.isSuccess(result) && result.success.length).toBe(5)
  })

  test('a committee of another unit looks exactly like one that does not exist', () => {
    const codes = (committeeId: string) => {
      const result = chooseParticipants(context, [
        {
          roleId: 'members',
          sources: [
            { kind: 'committee', committeeId },
            { kind: 'account', accountId: 'a' },
            { kind: 'account', accountId: 'b' },
          ],
        },
        { roleId: 'chair', sources: [{ kind: 'account', accountId: 'z' }] },
      ])
      return Result.isFailure(result) ? result.failure : []
    }
    expect(codes('cm-3')).toEqual([
      expect.objectContaining({ code: 'unknown_committee' }),
    ])
    expect(codes('cm-3')).toEqual(codes('cm-404'))
  })

  test('refuses an author, a person in two roles, and an unknown role', () => {
    const result = chooseParticipants(context, [
      {
        roleId: 'members',
        sources: [
          { kind: 'account', accountId: 'author-1' },
          { kind: 'account', accountId: 'a' },
        ],
      },
      { roleId: 'chair', sources: [{ kind: 'account', accountId: 'a' }] },
      { roleId: 'nope', sources: [] },
    ])
    expect(Result.isFailure(result)).toBe(true)
    const codes = Result.isFailure(result)
      ? result.failure.map(p => p.code)
      : []
    expect(codes).toContain('unknown_role')
    expect(codes).toContain('person_is_author')
    expect(codes).toContain('person_in_two_roles')
  })

  test('the dialog shows the view and the rule of every reviewing role', () => {
    expect(roleChoices(PANEL_TEMPLATE)).toEqual([
      {
        roleId: 'chair',
        name: 'Chair',
        view: 'full',
        votes: true,
        comments: true,
        rule: { kind: 'majority' },
      },
      {
        roleId: 'members',
        name: 'Panel members',
        view: 'redacted',
        votes: true,
        comments: true,
        rule: { kind: 'at_least', count: 2 },
      },
      {
        roleId: 'observer',
        name: 'Observer',
        view: 'redacted',
        votes: false,
        comments: true,
        rule: undefined,
      },
    ])
  })
})
