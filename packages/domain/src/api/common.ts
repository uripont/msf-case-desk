import { Schema } from 'effect'

import { REVIEW_DECISIONS } from '../approval'
import type { Refusal } from '../permissions'
import { REPORT_STATES } from '../report-flow'
import { StorageUnavailable } from '../rpc'

// NOTE: Shared pieces of the RPC contract: primitives, the typed
// errors and the error sets the procedures declare. Nothing here carries
// report content.

// ---- Primitives -------------------------------------------------------------

// NOTE: Identifiers are opaque strings made by the server (or, for share and
// upload IDs, by the browser). Their form is not part of the contract.
export const ApiId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
)
export type ApiId = typeof ApiId.Type

// NOTE: Milliseconds since the epoch, UTC.
export const EpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export type EpochMs = typeof EpochMs.Type

export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const DisplayName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
)

// NOTE: E.164, with the plus sign. The `wa.me` link carries digits only.
export const Phone = Schema.String.check(Schema.isPattern(/^\+[1-9]\d{6,14}$/))

export const NewPassword = Schema.String.check(
  Schema.isMinLength(10),
  Schema.isMaxLength(200),
)

export const LinkToken = Schema.String.check(
  Schema.isMinLength(16),
  Schema.isMaxLength(200),
)

// NOTE: An IANA name such as `Europe/Madrid`. The handler checks that it is a
// known zone.
export const TimeZone = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
)

export const Deadline = Schema.Struct({ at: EpochMs, timeZone: TimeZone })
export type Deadline = typeof Deadline.Type

export const ReportStateSchema = Schema.Literals(REPORT_STATES)
export const ReviewDecisionSchema = Schema.Literals(REVIEW_DECISIONS)
export const RoundStatusSchema = Schema.Literals([
  'open',
  'superseded',
  'decided',
])
export const DecidedBySchema = Schema.Literals(['rule_met', 'deadline'])
// NOTE: What a role sees of a revision (D23).
export const RoleView = Schema.Literals(['full', 'redacted'])
export const ContentViewSchema = Schema.Literals(['original', 'redacted'])

export const AccountRef = Schema.Struct({ id: ApiId, name: DisplayName })
export type AccountRef = typeof AccountRef.Type

// NOTE: A coded problem. The message is fixed text written by the domain and
// never repeats report content, so it can go to any caller that gets the
// error. `source` tells which part of the domain found it.
export const PROBLEM_SOURCES = [
  'input',
  'template',
  'content',
  'people',
  'merge',
  'theme',
  'publish',
  'flow',
  'save',
] as const

export const Problem = Schema.Struct({
  source: Schema.Literals(PROBLEM_SOURCES),
  code: Schema.String.check(Schema.isMaxLength(64)),
  path: Schema.Array(Schema.Union([Schema.String, Schema.Int])).check(
    Schema.isMaxLength(32),
  ),
  message: Schema.String.check(Schema.isMaxLength(500)),
})
export type Problem = typeof Problem.Type

// ---- Errors -----------------------------------------------------------------

// NOTE: One answer for "forbidden" and "does not exist". It carries
// nothing, so it cannot tell the two apart.
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', {}) {}

// NOTE: The one mapping from `authorize` (permissions.ts) to an error:
// - `not_found` is `NotFound`, whatever the cause (does not exist, not a
//   member, a draft for a reviewer). Non-members of a report only ever get
//   this one.
// - `not_permitted` is `NotPermitted` with reason `not_permitted`: the caller
//   is a member who sees the thing but lacks the permission or capability.
//   For capabilities of the deployment (administrator, template editor,
//   author in a unit) `authorize` never looks at the target, so a caller
//   without the capability gets this answer whether the target exists or not.
// - `read_only` is `NotPermitted` with reason `read_only`: an archived report
//   refuses every write, for members only.
// A reason never carries more than that, so it cannot tell anyone anything
// they did not already see.
export const NOT_PERMITTED_REASONS = ['not_permitted', 'read_only'] as const

export class NotPermitted extends Schema.TaggedError<NotPermitted>()(
  'NotPermitted',
  { reason: Schema.Literals(NOT_PERMITTED_REASONS) },
) {}

export const refusalToError = (refusal: Refusal): NotFound | NotPermitted =>
  refusal.reason === 'not_found'
    ? new NotFound()
    : new NotPermitted({ reason: refusal.reason })

export const CONFLICT_REASONS = [
  // A save or share carried an old save counter (another tab, or a share).
  'stale_save',
  // Something else was shared first; the comparison is the answer (see
  // `ShareOutcome`), so this is only for requests that cannot carry one.
  'stale_base',
  'already_exists',
  'duplicate',
  // The draft to publish is no longer the latest one.
  'not_latest',
  // A pending comment was sent meanwhile, or a staged share is incomplete.
  'already_sent',
  'share_incomplete',
  // Another request changed the same thing first.
  'changed_meanwhile',
  // The pending comments are not the ones the reviewer saw when sending.
  'pending_changed',
] as const

export class Conflict extends Schema.TaggedError<Conflict>()('Conflict', {
  reason: Schema.Literals(CONFLICT_REASONS),
}) {}

export class Validation extends Schema.TaggedError<Validation>()(
  'Validation',
  { problems: Schema.Array(Problem).check(Schema.isMaxLength(200)) },
) {}

export class DeadlinePassed extends Schema.TaggedError<DeadlinePassed>()(
  'DeadlinePassed',
  { deadline: EpochMs },
) {}

// NOTE: `code` is a `FlowErrorCode` or `SaveErrorCode` of the domain.
export class NotAllowedInState extends Schema.TaggedError<NotAllowedInState>()(
  'NotAllowedInState',
  {
    state: ReportStateSchema,
    code: Schema.String.check(Schema.isMaxLength(64)),
  },
) {}

export class InvalidCredentials extends Schema.TaggedError<InvalidCredentials>()(
  'InvalidCredentials',
  {},
) {}

// NOTE: D13. The delay never exceeds 15 minutes.
export class Throttled extends Schema.TaggedError<Throttled>()('Throttled', {
  retryAfterSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 900 })),
}) {}

// NOTE: Unknown, used and expired links all answer the same.
export class LinkInvalid extends Schema.TaggedError<LinkInvalid>()(
  'LinkInvalid',
  {},
) {}

// ---- Error sets ---------------------------------------------------------------
//
// Every procedure declares one of these (or its own union). All include
// `StorageUnavailable`, the infrastructure error of iteration 2.

export const ReadError = Schema.Union([
  NotFound,
  NotPermitted,
  StorageUnavailable,
])
export const WriteError = Schema.Union([
  NotFound,
  NotPermitted,
  Conflict,
  Validation,
  StorageUnavailable,
])
// NOTE: Writes that depend on the state of the report.
export const StateError = Schema.Union([
  NotFound,
  NotPermitted,
  Conflict,
  Validation,
  NotAllowedInState,
  StorageUnavailable,
])
// NOTE: Writes that also depend on a deadline.
export const TimedError = Schema.Union([
  NotFound,
  NotPermitted,
  Conflict,
  Validation,
  NotAllowedInState,
  DeadlinePassed,
  StorageUnavailable,
])
export const PublicError = Schema.Union([
  LinkInvalid,
  InvalidCredentials,
  Throttled,
  Validation,
  StorageUnavailable,
])
// NOTE: For procedures that cannot fail except through storage.
export const StorageError = StorageUnavailable
