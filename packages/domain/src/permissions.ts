import { Result } from 'effect'

import type { ReviewDecision } from './approval'
import { type ReportFlow, openRound, isConclusionSection } from './report-flow'
import {
  type Permission,
  type Role,
  type Template,
  draftingRoleOf,
} from './template'

// NOTE: One authorization function, `authorize(account, report, action)`,
// for the capabilities of the deployment and the roles of a template.
//
// Capabilities, one per top tab of the app: `people` (accounts, units,
// capabilities and links), `theme`, `template_editor` and `author` in a unit.
// None of them gives access to a report. Access to a report comes only from
// being one of its members: an author of the drafting role, or a participant
// of a round in a reviewing role.
//
// Refusals. `not_found` is what a caller gets for anything it may not know
// exists: another unit's report, a report with no role for it, a draft for a
// reviewer. It is one constant, identical for "forbidden" and "does not
// exist". `not_permitted` is for a member who sees the thing but lacks the
// permission (or the capability). `read_only` is an archived report.

export type Capability = 'people' | 'theme' | 'template_editor' | 'author'

export type Grant = Readonly<{ capability: Capability; unit?: string }>

export type Account = Readonly<{
  id: string
  grants: ReadonlyArray<Grant>
}>

export type ReportAccess = Readonly<{
  id: string
  unit: string
  template: Template
  // NOTE: members of the drafting role.
  authors: ReadonlyArray<string>
  flow: ReportFlow
}>

export type ContentView = 'original' | 'redacted'

export type Refusal = Readonly<{
  allowed: false
  reason: 'not_found' | 'not_permitted' | 'read_only'
}>

export type Allowed = Readonly<{ allowed: true; view?: ContentView }>

export type Authorization = Allowed | Refusal

export const NOT_FOUND: Refusal = { allowed: false, reason: 'not_found' }
const NOT_PERMITTED: Refusal = { allowed: false, reason: 'not_permitted' }
const READ_ONLY: Refusal = { allowed: false, reason: 'read_only' }
const ALLOWED: Allowed = { allowed: true }

export type Action =
  // NOTE: deployment
  | Readonly<{ type: 'set_theme' }>
  | Readonly<{ type: 'manage_units' }>
  | Readonly<{ type: 'manage_grants' }>
  | Readonly<{ type: 'issue_reset' }>
  | Readonly<{
      type:
        | 'create_template'
        | 'edit_template'
        | 'copy_template'
        | 'publish_template'
        | 'retire_template'
        | 'preview_template'
    }>
  | Readonly<{
      type: 'create_report' | 'manage_committees' | 'invite_to_unit'
      unit: string
    }>
  // NOTE: the report, for its authors
  | Readonly<{ type: 'read_working_copy'; ownerId: string }>
  | Readonly<{ type: 'start_working_copy' }>
  | Readonly<{ type: 'save_section'; sectionId: string }>
  | Readonly<{ type: 'save_people' }>
  | Readonly<{ type: 'read_draft'; number: number }>
  | Readonly<{ type: 'read_people' }>
  | Readonly<{ type: 'share_draft' }>
  | Readonly<{ type: 'comment_on_draft' }>
  | Readonly<{ type: 'read_draft_comments' }>
  | Readonly<{ type: 'publish_revision' }>
  | Readonly<{ type: 'add_co_author' }>
  | Readonly<{ type: 'reply'; revision: number }>
  | Readonly<{ type: 'read_grid' }>
  | Readonly<{ type: 'read_audit' }>
  | Readonly<{ type: 'extend_deadline' }>
  | Readonly<{ type: 'remove_reviewer' }>
  | Readonly<{ type: 'start_conclusion' }>
  // NOTE: the report, for authors and reviewers
  | Readonly<{ type: 'view_report' }>
  // NOTE: The template version the report uses. An author reads it; a
  // reviewer reads it for a revision that was sent to them.
  | Readonly<{ type: 'read_template_version'; revision?: number }>
  | Readonly<{ type: 'read_revision'; revision: number }>
  | Readonly<{ type: 'read_comments'; revision: number }>
  | Readonly<{ type: 'write_comment'; revision: number }>
  | Readonly<{
      type: 'submit_review'
      revision: number
      decision: ReviewDecision
    }>

export type ActionType = Action['type']

// NOTE: The permission of the drafting role (or `null` for membership alone)
// that each author action needs. `save_section` is decided by the section.
type AuthorRule = Permission | null | 'by_section'

const AUTHOR_RULES: Readonly<Partial<Record<ActionType, AuthorRule>>> = {
  read_working_copy: null,
  start_working_copy: 'edit',
  save_section: 'by_section',
  save_people: 'manage_people',
  read_draft: null,
  read_people: null,
  share_draft: 'share',
  comment_on_draft: 'comment_drafts',
  read_draft_comments: null,
  publish_revision: 'publish',
  add_co_author: 'manage_people',
  reply: 'reply',
  read_grid: null,
  read_audit: null,
  extend_deadline: 'publish',
  remove_reviewer: 'publish',
  start_conclusion: 'write_conclusion',
}

// NOTE: The actions that change something. An archived report refuses them.
const WRITES: ReadonlySet<ActionType> = new Set<ActionType>([
  'start_working_copy',
  'save_section',
  'save_people',
  'share_draft',
  'comment_on_draft',
  'publish_revision',
  'add_co_author',
  'reply',
  'extend_deadline',
  'remove_reviewer',
  'start_conclusion',
  'write_comment',
  'submit_review',
])

export const hasCapability = (
  account: Account,
  capability: Capability,
  unit?: string,
): boolean =>
  account.grants.some(
    grant =>
      grant.capability === capability &&
      (unit === undefined || grant.unit === unit),
  )

const need = (ok: boolean): Authorization => (ok ? ALLOWED : NOT_PERMITTED)

const authorizeDeployment = (
  account: Account,
  action: Action,
): Authorization | undefined => {
  switch (action.type) {
    case 'set_theme':
      return need(hasCapability(account, 'theme'))
    case 'manage_units':
    case 'manage_grants':
    case 'issue_reset':
      return need(hasCapability(account, 'people'))
    case 'create_template':
    case 'edit_template':
    case 'copy_template':
    case 'publish_template':
    case 'retire_template':
    case 'preview_template':
      return need(hasCapability(account, 'template_editor'))
    case 'create_report':
    case 'manage_committees':
    case 'invite_to_unit':
      return need(hasCapability(account, 'author', action.unit))
    default:
      return undefined
  }
}

// NOTE: Somebody must always be able to manage people: a change that would
// leave no active account holding `people` is refused. `accounts` is every
// account of the deployment with its grants as they are now.
export type PeopleHolderCandidate = Readonly<{
  id: string
  active: boolean
  grants: ReadonlyArray<Grant>
}>

export const leavesNobodyForPeople = (
  accounts: ReadonlyArray<PeopleHolderCandidate>,
  revoked: Readonly<{ accountId: string; capability: Capability }>,
): boolean =>
  !accounts.some(
    candidate =>
      candidate.active &&
      hasCapability(candidate, 'people') &&
      !(candidate.id === revoked.accountId && revoked.capability === 'people'),
  )

const hasPermission = (role: Role, permission: Permission): boolean =>
  role.permissions.includes(permission)

export const isAuthor = (account: Account, report: ReportAccess): boolean =>
  report.authors.includes(account.id)

// NOTE: The role this account holds for a revision, if it was sent to them
// and they were not removed from its round.
export const reviewerRoleFor = (
  account: Account,
  report: ReportAccess,
  revision: number,
): Role | undefined => {
  if (isAuthor(account, report)) return undefined
  const round = report.flow.rounds.find(r => r.revision === revision)
  const participant = round?.participants.find(p => p.accountId === account.id)
  return participant === undefined
    ? undefined
    : report.template.roles.find(
        role => role.id === participant.roleId && role.kind === 'reviewing',
      )
}

const isReviewer = (account: Account, report: ReportAccess): boolean =>
  !isAuthor(account, report) &&
  report.flow.rounds.some(r =>
    r.participants.some(p => p.accountId === account.id),
  )

const viewOf = (role: Role): ContentView =>
  role.view === 'full' ? 'original' : 'redacted'

const authorizeAuthor = (
  account: Account,
  report: ReportAccess,
  action: Action,
): Authorization => {
  const role = draftingRoleOf(report.template)
  if (role === undefined) return NOT_FOUND
  const rule = AUTHOR_RULES[action.type]
  if (rule === undefined) return NOT_FOUND
  if (action.type === 'read_working_copy' && action.ownerId !== account.id) {
    return NOT_FOUND
  }
  if (
    action.type === 'read_draft' &&
    !(
      Number.isInteger(action.number) &&
      action.number >= 0 &&
      action.number <= report.flow.draftCount
    )
  ) {
    return NOT_FOUND
  }
  const permission: Permission | null =
    rule === 'by_section'
      ? action.type === 'save_section' &&
        isConclusionSection(report.template, action.sectionId)
        ? 'write_conclusion'
        : 'edit'
      : rule
  if (permission !== null && !hasPermission(role, permission)) {
    return NOT_PERMITTED
  }
  if (action.type === 'read_working_copy' || action.type === 'read_draft') {
    return { allowed: true, view: 'original' }
  }
  return ALLOWED
}

const authorizeReviewerAction = (
  account: Account,
  report: ReportAccess,
  action: Action,
): Authorization => {
  if (
    action.type !== 'read_revision' &&
    action.type !== 'read_comments' &&
    action.type !== 'write_comment' &&
    action.type !== 'submit_review'
  ) {
    return NOT_FOUND
  }
  const role = reviewerRoleFor(account, report, action.revision)
  if (role === undefined) return NOT_FOUND
  switch (action.type) {
    case 'read_revision':
      return { allowed: true, view: viewOf(role) }
    case 'read_comments':
      return { allowed: true, view: viewOf(role) }
    case 'write_comment':
      return need(hasPermission(role, 'comment'))
    case 'submit_review':
      return need(
        hasPermission(role, action.decision === 'comment' ? 'comment' : 'vote'),
      )
  }
}

// NOTE: `report` is `undefined` when it does not exist, which answers exactly
// like a report the account may not see.
export const authorize = (
  account: Account,
  report: ReportAccess | undefined,
  action: Action,
): Authorization => {
  const deployment = authorizeDeployment(account, action)
  if (deployment !== undefined) return deployment
  if (report === undefined) return NOT_FOUND

  const author = isAuthor(account, report)
  let result: Authorization
  if (action.type === 'read_template_version') {
    result = author
      ? ALLOWED
      : action.revision !== undefined &&
          reviewerRoleFor(account, report, action.revision) !== undefined
        ? ALLOWED
        : NOT_FOUND
  } else if (action.type === 'view_report') {
    result = author || isReviewer(account, report) ? ALLOWED : NOT_FOUND
  } else if (
    action.type === 'read_revision' ||
    action.type === 'read_comments'
  ) {
    result = author
      ? action.revision >= 1 &&
        report.flow.rounds.some(r => r.revision === action.revision)
        ? { allowed: true, view: 'original' }
        : NOT_FOUND
      : authorizeReviewerAction(account, report, action)
  } else if (
    action.type === 'write_comment' ||
    action.type === 'submit_review'
  ) {
    result = author
      ? NOT_PERMITTED
      : authorizeReviewerAction(account, report, action)
  } else {
    result = author ? authorizeAuthor(account, report, action) : NOT_FOUND
  }
  return result.allowed &&
    WRITES.has(action.type) &&
    report.flow.state === 'archived'
    ? READ_ONLY
    : result
}

// ---- Comments ---------------------------------------------------------------

export type CommentScope =
  | Readonly<{ kind: 'draft'; draft: number }>
  | Readonly<{ kind: 'revision'; revision: number }>

export type CommentVisibility = 'authors' | 'committee'

// NOTE: `sent` is false while the comment is in a reviewer's pending review.
// Comments on drafts have no review and are always `sent`.
export type CommentRecord = Readonly<{
  authorId: string
  scope: CommentScope
  visibility: CommentVisibility
  sent: boolean
}>

// NOTE: Authors see every comment that was sent, in the view it was written
// in; comments on drafts only they see. A reviewer sees their own comments
// (sent or pending) and the comments other reviewers of the same revision
// sent with committee visibility. A reply is visible exactly when its
// comment is. A reviewer removed from a round no longer sees its comments.
export const canSeeComment = (
  account: Account,
  report: ReportAccess,
  comment: CommentRecord,
): boolean => {
  if (isAuthor(account, report)) {
    return comment.scope.kind === 'draft' || comment.sent
  }
  if (comment.scope.kind === 'draft') return false
  if (reviewerRoleFor(account, report, comment.scope.revision) === undefined) {
    return false
  }
  if (comment.authorId === account.id) return true
  return comment.sent && comment.visibility === 'committee'
}

// NOTE: Only an existing author may add a co-author (checked by `authorize`
// with `add_co_author`); the person added must not be a reviewer in an open
// round, who first has to be removed from it.
export const checkNewAuthor = (
  report: ReportAccess,
  candidateId: string,
): Result.Result<true, 'reviewer_in_open_round'> => {
  const round = openRound(report.flow)
  return round?.participants.some(p => p.accountId === candidateId)
    ? Result.fail('reviewer_in_open_round')
    : Result.succeed(true)
}
