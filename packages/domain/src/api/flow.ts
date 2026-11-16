import { Schema } from 'effect'

import { ApprovalRule } from '../template'
import {
  ApiId,
  Count,
  DecidedBySchema,
  EpochMs,
  ReportStateSchema,
  ReviewDecisionSchema,
  RoundStatusSchema,
  Deadline,
  DisplayName,
  AccountRef,
} from './common'

// NOTE: Schemas for the domain's round, flow, event log and grid types
// (report-flow.ts, round-events.ts, grid.ts, approval.ts). They are for
// authors only: reviewers get `RoundSummary` (reviewer.ts) instead. Fields the
// domain types as `T | undefined` are `Schema.optional`, so the domain values
// are assignable to the Schema types as they are.

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const DraftNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const ParticipantSchema = Schema.Struct({
  accountId: ApiId,
  roleId: ApiId,
})

export const ReviewRecordSchema = Schema.Struct({
  reviewerId: ApiId,
  revision: Revision,
  decision: ReviewDecisionSchema,
})

export const RoundSchema = Schema.Struct({
  revision: Revision,
  draft: DraftNumber,
  closing: Schema.Boolean,
  deadline: EpochMs,
  participants: Schema.Array(ParticipantSchema),
  removed: Schema.Array(ParticipantSchema),
  reviews: Schema.Array(ReviewRecordSchema),
  status: RoundStatusSchema,
  decidedBy: Schema.optionalKey(DecidedBySchema),
})

export const ReportFlowSchema = Schema.Struct({
  state: ReportStateSchema,
  draftCount: DraftNumber,
  rounds: Schema.Array(RoundSchema),
})

const ReminderKindSchema = Schema.Literals(['reminder_first', 'reminder_final'])

export const ReportEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('draft_shared'),
    draft: DraftNumber,
    accountId: ApiId,
    at: EpochMs,
  }),
  Schema.Struct({
    type: Schema.Literal('draft_read'),
    draft: DraftNumber,
    accountId: ApiId,
    at: EpochMs,
  }),
  Schema.Struct({
    type: Schema.Literal('revision_published'),
    revision: Revision,
    at: EpochMs,
  }),
  Schema.Struct({
    type: Schema.Literal('notified'),
    revision: Revision,
    accountId: ApiId,
    at: EpochMs,
  }),
  Schema.Struct({
    type: Schema.Literal('read'),
    revision: Revision,
    accountId: ApiId,
    at: EpochMs,
  }),
  Schema.Struct({
    type: Schema.Literal('reminded'),
    revision: Revision,
    accountId: ApiId,
    kind: ReminderKindSchema,
    at: EpochMs,
  }),
  Schema.Struct({
    type: Schema.Literal('review'),
    id: ApiId,
    reviewerId: ApiId,
    revision: Revision,
    decision: ReviewDecisionSchema,
    hasComments: Schema.Boolean,
    at: EpochMs,
  }),
  Schema.Struct({
    type: Schema.Literal('round_decided'),
    revision: Revision,
    decidedBy: DecidedBySchema,
    at: EpochMs,
  }),
])

// ---- Tally -----------------------------------------------------------------------

export const RoleTallySchema = Schema.Struct({
  roleId: ApiId,
  rule: ApprovalRule,
  voters: Count,
  approvals: Count,
  changesRequested: Count,
  met: Schema.Boolean,
})

export const RoundTallySchema = Schema.Struct({
  met: Schema.Boolean,
  roles: Schema.Array(RoleTallySchema),
})

// ---- Grid ------------------------------------------------------------------------

const Fact = Schema.Struct({ at: EpochMs })

export const GridReviewCell = Schema.Struct({
  id: ApiId,
  decision: ReviewDecisionSchema,
  hasComments: Schema.Boolean,
  at: EpochMs,
  standing: Schema.Boolean,
})

export const GridRevisionCell = Schema.Struct({
  accountId: ApiId,
  roleId: ApiId,
  roleName: DisplayName,
  removed: Schema.Boolean,
  sent: Schema.optional(Fact),
  read: Schema.optional(Fact),
  reviews: Schema.Array(GridReviewCell),
  decision: Schema.optional(
    Schema.Struct({ decision: ReviewDecisionSchema, at: EpochMs }),
  ),
  reminders: Schema.Array(
    Schema.Struct({ kind: ReminderKindSchema, at: EpochMs }),
  ),
})

export const GridRevisionRow = Schema.Struct({
  kind: Schema.Literal('revision'),
  revision: Revision,
  label: Schema.String,
  draft: DraftNumber,
  closing: Schema.Boolean,
  publishedAt: Schema.optional(EpochMs),
  deadline: EpochMs,
  status: RoundStatusSchema,
  decidedBy: Schema.optional(DecidedBySchema),
  decidedAt: Schema.optional(EpochMs),
  replacedBy: Schema.optional(Revision),
  rule: RoundTallySchema,
  cells: Schema.Array(GridRevisionCell),
})

export const GridDraftRow = Schema.Struct({
  kind: Schema.Literal('draft'),
  draft: DraftNumber,
  label: Schema.String,
  sharedBy: Schema.optional(ApiId),
  sharedAt: Schema.optional(EpochMs),
  cells: Schema.Array(
    Schema.Struct({
      accountId: ApiId,
      shared: Schema.optional(Fact),
      read: Schema.optional(Fact),
    }),
  ),
})

export const GridSchema = Schema.Struct({
  authors: Schema.Array(ApiId),
  drafts: Schema.Array(GridDraftRow),
  revisions: Schema.Array(GridRevisionRow),
})

// NOTE: The grid refers to people by account ID; `names` resolves them.
export const GridView = Schema.Struct({
  grid: GridSchema,
  names: Schema.Array(AccountRef),
})

// ---- Round for authors -------------------------------------------------------------

export const RoundParticipantView = Schema.Struct({
  accountId: ApiId,
  name: DisplayName,
  roleId: ApiId,
  roleName: DisplayName,
  removed: Schema.Boolean,
  decision: Schema.optionalKey(ReviewDecisionSchema),
})

export const RoundView = Schema.Struct({
  revision: Revision,
  draft: DraftNumber,
  closing: Schema.Boolean,
  status: RoundStatusSchema,
  decidedBy: Schema.optionalKey(DecidedBySchema),
  decidedAt: Schema.optionalKey(EpochMs),
  deadline: Deadline,
  participants: Schema.Array(RoundParticipantView),
  tally: RoundTallySchema,
})
export type RoundView = typeof RoundView.Type
