import { Array, Option } from 'effect'

import {
  type ReviewRecord,
  type RoundView,
  type Template,
  tallyRound,
  voterProblems,
} from '@case-desk/domain'

// NOTE: What removing a reviewer from an open round does to its approval rule
// (D6), worked out with the same domain functions the server uses, so the
// author reads the consequence before confirming. Pure.

export type RoleLine = Readonly<{
  roleId: string
  roleName: string
  text: string
  met: boolean
}>

export type Removal =
  | Readonly<{ kind: 'refused'; message: string }>
  | Readonly<{
      kind: 'allowed'
      // NOTE: The round would be decided by its rule the moment this person
      // is removed.
      decidesNow: boolean
      lines: ReadonlyArray<RoleLine>
    }>

const ruleWords = (
  rule: Readonly<{ kind: 'all' | 'majority' | 'at_least'; count?: number }>,
): string =>
  rule.kind === 'all'
    ? 'every voter must approve'
    : rule.kind === 'majority'
      ? 'more than half must approve'
      : `at least ${rule.count ?? 1} must approve`

export const roleLines = (
  template: Template,
  round: RoundView,
  without: Option.Option<string>,
): ReadonlyArray<RoleLine> => {
  const participants = Array.filter(
    round.participants,
    p => !p.removed && !Option.exists(without, id => id === p.accountId),
  )
  const reviews: ReadonlyArray<ReviewRecord> = Array.flatMap(
    participants,
    (p): ReadonlyArray<ReviewRecord> =>
      p.decision === undefined || p.decision === 'comment'
        ? []
        : [
            {
              reviewerId: p.accountId,
              revision: round.revision,
              decision: p.decision,
            },
          ],
  )
  const tally = tallyRound(template, {
    revision: round.revision,
    participants: Array.map(participants, p => ({
      accountId: p.accountId,
      roleId: p.roleId,
    })),
    reviews,
  })
  return Array.map(tally.roles, role => {
    const roleName =
      template.roles.find(candidate => candidate.id === role.roleId)?.name ??
      role.roleId
    return {
      roleId: role.roleId,
      roleName,
      met: role.met,
      text: `${roleName}: ${role.approvals} of ${role.voters} approved, ${ruleWords(role.rule)}. ${role.met ? 'The rule is met.' : 'The rule is not met yet.'}`,
    }
  })
}

export const removalOf = (
  template: Template,
  round: RoundView,
  accountId: string,
): Removal => {
  // NOTE: D6: a reviewer with a standing decision stays in the round.
  const decided = round.participants.find(p => p.accountId === accountId)?.decision
  if (decided === 'approve' || decided === 'request_changes') {
    return {
      kind: 'refused',
      message:
        'This person has already decided on this revision, so they stay in the round. Only reviewers who have not decided can be removed.',
    }
  }
  const remaining = Array.filter(
    round.participants,
    p => !p.removed && p.accountId !== accountId,
  )
  const problems = voterProblems(
    template,
    Array.map(remaining, p => ({ accountId: p.accountId, roleId: p.roleId })),
  )
  if (problems.length > 0) {
    return {
      kind: 'refused',
      message: `This person cannot be removed: ${problems[0]?.message ?? 'the approval rule could not be met.'}`,
    }
  }
  const lines = roleLines(template, round, Option.some(accountId))
  return {
    kind: 'allowed',
    decidesNow: lines.length > 0 && Array.every(lines, line => line.met),
    lines,
  }
}
