import { Result } from 'effect'

import {
  type ApprovalRule,
  type Role,
  type Template,
  votingRolesOf,
} from './template'

// NOTE: Approval rules across roles (D6) and the choice of people for the
// reviewing roles of a round (D23). Pure: everything arrives as arguments.
//
// - Each voting role has its own rule: all voters, at least N, or a majority.
// - A round meets its rule only when every voting role meets its own.
// - Only the votes of the round's own revision count. A review records the
//   revision it was written on, and the tally ignores every other one, so an
//   approval of Revision 1 can never count for Revision 2.
// - A reviewer's standing vote is their latest approve or request-changes
//   review. A comment-only review is not a decision and changes nothing.
// - A rule that cannot be met with the chosen people (no voters in a voting
//   role, or N above the number of voters) refuses the publication.

export type Participant = Readonly<{ accountId: string; roleId: string }>

export const REVIEW_DECISIONS = [
  'approve',
  'request_changes',
  'comment',
] as const
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number]

export type ReviewRecord = Readonly<{
  reviewerId: string
  revision: number
  decision: ReviewDecision
}>

export const DEFAULT_RULE: ApprovalRule = { kind: 'all' }

export const ruleMet = (
  rule: ApprovalRule,
  voters: number,
  approvals: number,
): boolean => {
  if (voters < 1) return false
  if (rule.kind === 'all') return approvals >= voters
  if (rule.kind === 'majority') return approvals * 2 > voters
  return rule.count >= 1 && approvals >= rule.count
}

export const ruleCanBeMet = (rule: ApprovalRule, voters: number): boolean =>
  voters >= 1 &&
  (rule.kind !== 'at_least' || (rule.count >= 1 && rule.count <= voters))

export const standingDecisions = (
  reviews: ReadonlyArray<ReviewRecord>,
  revision: number,
): ReadonlyMap<string, 'approve' | 'request_changes'> => {
  const standing = new Map<string, 'approve' | 'request_changes'>()
  for (const review of reviews) {
    if (review.revision === revision && review.decision !== 'comment') {
      standing.set(review.reviewerId, review.decision)
    }
  }
  return standing
}

export type RoleTally = Readonly<{
  roleId: string
  rule: ApprovalRule
  voters: number
  approvals: number
  changesRequested: number
  met: boolean
}>

export type RoundTally = Readonly<{
  met: boolean
  roles: ReadonlyArray<RoleTally>
}>

export type TallyInput = Readonly<{
  revision: number
  participants: ReadonlyArray<Participant>
  reviews: ReadonlyArray<ReviewRecord>
}>

const votersOf = (
  participants: ReadonlyArray<Participant>,
  roleId: string,
): ReadonlyArray<string> => [
  ...new Set(
    participants.filter(p => p.roleId === roleId).map(p => p.accountId),
  ),
]

const votingReviewingRoles = (template: Template): ReadonlyArray<Role> =>
  votingRolesOf(template).filter(role => role.kind === 'reviewing')

export const tallyRound = (
  template: Template,
  round: TallyInput,
): RoundTally => {
  const standing = standingDecisions(round.reviews, round.revision)
  const roles = votingReviewingRoles(template).map((role): RoleTally => {
    const rule = role.approval ?? DEFAULT_RULE
    const voters = votersOf(round.participants, role.id)
    const approvals = voters.filter(id => standing.get(id) === 'approve').length
    const changesRequested = voters.filter(
      id => standing.get(id) === 'request_changes',
    ).length
    return {
      roleId: role.id,
      rule,
      voters: voters.length,
      approvals,
      changesRequested,
      met: ruleMet(rule, voters.length, approvals),
    }
  })
  return { met: roles.length > 0 && roles.every(r => r.met), roles }
}

// ---- Publishing -------------------------------------------------------------

export type PublishProblemCode =
  | 'unknown_role'
  | 'not_a_reviewing_role'
  | 'duplicate_in_role'
  | 'person_in_two_roles'
  | 'person_is_author'
  | 'no_voting_role'
  | 'no_voters'
  | 'rule_unmeetable'
  | 'unknown_committee'
  | 'unknown_person'

export type PublishProblem = Readonly<{
  code: PublishProblemCode
  roleId?: string
  accountId?: string
  message: string
}>

// NOTE: Only the rule part: every voting role needs voters and a rule that
// can be met with them. Also used when a reviewer is removed from a round.
export const voterProblems = (
  template: Template,
  participants: ReadonlyArray<Participant>,
): ReadonlyArray<PublishProblem> => {
  const voting = votingReviewingRoles(template)
  if (voting.length === 0) {
    return [
      {
        code: 'no_voting_role',
        message: 'The template has no reviewing role that votes.',
      },
    ]
  }
  return voting.flatMap((role): ReadonlyArray<PublishProblem> => {
    const voters = votersOf(participants, role.id).length
    if (voters === 0) {
      return [
        {
          code: 'no_voters',
          roleId: role.id,
          message: `${role.name} votes but has no one chosen.`,
        },
      ]
    }
    return ruleCanBeMet(role.approval ?? DEFAULT_RULE, voters)
      ? []
      : [
          {
            code: 'rule_unmeetable',
            roleId: role.id,
            message: `The approval rule of ${role.name} cannot be met with ${voters} voter(s).`,
          },
        ]
  })
}

export const publishProblems = (
  template: Template,
  participants: ReadonlyArray<Participant>,
  authors: ReadonlyArray<string>,
): ReadonlyArray<PublishProblem> => {
  const problems: Array<PublishProblem> = []
  const seen = new Map<string, string>()
  const pairs = new Set<string>()
  for (const { accountId, roleId } of participants) {
    const role = template.roles.find(r => r.id === roleId)
    if (role === undefined) {
      problems.push({
        code: 'unknown_role',
        roleId,
        accountId,
        message: `The template has no role ${roleId}.`,
      })
      continue
    }
    if (role.kind !== 'reviewing') {
      problems.push({
        code: 'not_a_reviewing_role',
        roleId,
        accountId,
        message: `${role.name} is not a reviewing role.`,
      })
      continue
    }
    if (authors.includes(accountId)) {
      problems.push({
        code: 'person_is_author',
        roleId,
        accountId,
        message: 'An author of the report cannot review it.',
      })
    }
    const key = `${roleId}\u0000${accountId}`
    if (pairs.has(key)) {
      problems.push({
        code: 'duplicate_in_role',
        roleId,
        accountId,
        message: 'The same person is listed twice in a role.',
      })
    }
    pairs.add(key)
    const other = seen.get(accountId)
    if (other !== undefined && other !== roleId) {
      problems.push({
        code: 'person_in_two_roles',
        roleId,
        accountId,
        message: 'A person holds at most one reviewing role in a round.',
      })
    }
    seen.set(accountId, roleId)
  }
  return [...problems, ...voterProblems(template, participants)]
}

export const checkPublishable = (
  template: Template,
  participants: ReadonlyArray<Participant>,
  authors: ReadonlyArray<string>,
): Result.Result<ReadonlyArray<Participant>, ReadonlyArray<PublishProblem>> => {
  const problems = publishProblems(template, participants, authors)
  return problems.length === 0
    ? Result.succeed(participants)
    : Result.fail(problems)
}

// ---- Choosing people (D23) --------------------------------------------------

export type PersonSource =
  | Readonly<{ kind: 'committee'; committeeId: string }>
  | Readonly<{ kind: 'account'; accountId: string }>

export type Selection = Readonly<{
  roleId: string
  sources: ReadonlyArray<PersonSource>
}>

export type Committee = Readonly<{
  id: string
  unit: string
  members: ReadonlyArray<string>
}>

export type ChooseContext = Readonly<{
  template: Template
  unit: string
  authors: ReadonlyArray<string>
  committees: ReadonlyArray<Committee>
  // NOTE: the accounts in the reviewer registry of the report's unit. An
  // individual account must be one of them (committee members are, by how a
  // committee is made).
  registry: ReadonlyArray<string>
}>

// NOTE: Fills each reviewing role from committees of the report's unit and
// individual accounts. A committee of another unit and an unknown committee
// are refused with the same code, and so is an individual who is not in the
// unit's reviewer registry (`unknown_person`). The result is the frozen participant list of
// the round, in the template's role order. Selections for the same role are
// merged and a person who comes twice into one role counts once.
export const chooseParticipants = (
  context: ChooseContext,
  selections: ReadonlyArray<Selection>,
): Result.Result<ReadonlyArray<Participant>, ReadonlyArray<PublishProblem>> => {
  const problems: Array<PublishProblem> = []
  const byRole = new Map<string, Array<string>>()
  for (const selection of selections) {
    const people = byRole.get(selection.roleId) ?? []
    for (const source of selection.sources) {
      if (source.kind === 'account') {
        if (!context.registry.includes(source.accountId)) {
          problems.push({
            code: 'unknown_person',
            roleId: selection.roleId,
            message: 'That person is not in the unit\'s reviewer registry.',
          })
        } else {
          people.push(source.accountId)
        }
        continue
      }
      const committee = context.committees.find(
        c => c.id === source.committeeId && c.unit === context.unit,
      )
      if (committee === undefined) {
        problems.push({
          code: 'unknown_committee',
          roleId: selection.roleId,
          message: 'That committee does not exist.',
        })
      } else {
        people.push(...committee.members)
      }
    }
    byRole.set(selection.roleId, people)
  }
  const knownIds = new Set(context.template.roles.map(r => r.id))
  const participants: Array<Participant> = []
  for (const role of context.template.roles) {
    for (const accountId of new Set(byRole.get(role.id) ?? [])) {
      participants.push({ accountId, roleId: role.id })
    }
  }
  for (const roleId of byRole.keys()) {
    if (!knownIds.has(roleId)) {
      problems.push({
        code: 'unknown_role',
        roleId,
        message: `The template has no role ${roleId}.`,
      })
    }
  }
  const rest = publishProblems(context.template, participants, context.authors)
  const all = [...problems, ...rest]
  return all.length === 0 ? Result.succeed(participants) : Result.fail(all)
}
