import { Schema } from 'effect'

import { SectionContent } from '../content'
import { TemplateId } from '../template'
import {
  ApiId,
  Count,
  Deadline,
  DecidedBySchema,
  DisplayName,
  EpochMs,
  ReviewDecisionSchema,
  RoleView,
  RoundStatusSchema,
} from './common'
import { SectionRef } from './reports'

// NOTE: The reviewer-facing procedures and the comments both sides
// use. The rules the shapes enforce, checked structurally by tests:
//
// - The server, not the caller, chooses between redacted and original
//   content: no reviewer request carries a `view`, and a reviewer response has
//   one `content` or `body` that is already the right version.
// - A reviewer response never carries a working copy, a draft, the people
//   list, an alias, a save counter or the redacted twin of a body.
// - Comments of authors name the view they were written in; reviewers see one
//   body only.
// - A comment of a `full` reviewer shared with the committee reaches a
//   `redacted` reader as a `SectionNoteCommentView`: its section and the
//   quoted text redacted, never positions in a text the reader does not have
//   (D14). Every other comment a reviewer reads is anchored in their own view.
// - Comment authors are named (display name of the account) only on the
//   comments they shared with the committee, and on a reviewer's own. Reviewer
//   and author names are not case content (D14 redacts the people list), but
//   the server still runs the name through the revision's redaction for a
//   `redacted` reader, so an account that shares a name with a person of the
//   report is never shown as that person.

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Body = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(4000))

export const CommentVisibilityName = Schema.Literals(['authors', 'committee'])

// ---- Anchors -------------------------------------------------------------------------

// NOTE: A comment is on a whole section, or on a selection inside one rich
// text item: positions in the text of the view the author of the comment read
// (redacted or original) and the quoted text itself. Anchors stay on the
// revision they were made on (D14).
export const CommentAnchor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('section'), sectionId: ApiId }),
  Schema.Struct({
    kind: Schema.Literal('text'),
    sectionId: ApiId,
    itemId: ApiId,
    // NOTE: The repeated entries to pass through, outermost first.
    entryPath: Schema.optionalKey(
      Schema.Array(ApiId).check(Schema.isMaxLength(8)),
    ),
    from: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    to: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    quoted: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
  }),
])
export type CommentAnchor = typeof CommentAnchor.Type

// ---- Inbox -----------------------------------------------------------------------------

export const InboxItem = Schema.Struct({
  reportId: ApiId,
  revision: Revision,
  label: Schema.String,
  // NOTE: The reference, never the title: the title is personal data.
  caseReference: Schema.String,
  reportName: DisplayName,
  deadline: Deadline,
  status: RoundStatusSchema,
  sentAt: EpochMs,
  // NOTE: The reviewer's standing decision, if any.
  myDecision: Schema.optionalKey(ReviewDecisionSchema),
  hasPending: Schema.Boolean,
})

export const InboxPage = Schema.Struct({
  items: Schema.Array(InboxItem),
  // NOTE: Absent on the last page.
  next: Schema.optionalKey(Count),
})
export type InboxPage = typeof InboxPage.Type

export const PendingReviewItem = Schema.Struct({
  reportId: ApiId,
  revision: Revision,
  label: Schema.String,
  caseReference: Schema.String,
  deadline: Deadline,
  commentCount: Count,
  decision: Schema.optionalKey(ReviewDecisionSchema),
})

// ---- Reading ----------------------------------------------------------------------------

// NOTE: What a reviewer knows of a round: no names of other participants (the
// authors of a comment shared with the committee are named on the comment).
export const RoundSummary = Schema.Struct({
  status: RoundStatusSchema,
  decidedBy: Schema.optionalKey(DecidedBySchema),
  deadline: Deadline,
  closing: Schema.Boolean,
})

export const RevisionOutline = Schema.Struct({
  reportId: ApiId,
  revision: Revision,
  label: Schema.String,
  caseReference: Schema.String,
  // NOTE: For a `redacted` role the title as redacted when the draft was
  // shared (D14).
  caseTitle: Schema.String,
  templateId: TemplateId,
  templateVersion: Revision,
  // NOTE: What this role reads, chosen by the server from the template.
  view: RoleView,
  roleId: ApiId,
  canComment: Schema.Boolean,
  canVote: Schema.Boolean,
  round: RoundSummary,
  myDecision: Schema.optionalKey(ReviewDecisionSchema),
  closing: Schema.Boolean,
  // NOTE: When the revision was published; it is the date of the PDF.
  publishedAt: EpochMs,
  // NOTE: Only the label of each person, the text a people item prints for
  // every reader (a name never leaves the authors' side for a redacted role).
  personLabels: Schema.Array(
    Schema.Struct({ id: ApiId, label: Schema.String }),
  ),
  sections: Schema.Array(SectionRef),
})
export type RevisionOutline = typeof RevisionOutline.Type

export const RevisionSection = Schema.Struct({
  sectionId: ApiId,
  view: RoleView,
  content: SectionContent,
})

// ---- Comments for reviewers -----------------------------------------------------------------

export const ReviewerReplyView = Schema.Struct({
  id: ApiId,
  authorName: DisplayName,
  body: Schema.String,
  createdAt: EpochMs,
})

// NOTE: What every comment a reviewer reads has, whatever its anchor.
const reviewerCommentFields = {
  id: ApiId,
  revision: Revision,
  // NOTE: The display name of the commenter, for comments shared with the
  // committee and the reader's own (see the rules above).
  authorName: DisplayName,
  mine: Schema.Boolean,
  // NOTE: Already the version this reviewer may read.
  body: Schema.String,
  visibility: CommentVisibilityName,
  // NOTE: False while the comment is in the reviewer's pending review.
  sent: Schema.Boolean,
  resolved: Schema.Boolean,
  createdAt: EpochMs,
  replies: Schema.Array(ReviewerReplyView),
}

// NOTE: A comment anchored in the text the reader sees: always the reader's
// own comments, and comments of readers of the same view.
export const AnchoredCommentView = Schema.Struct({
  ...reviewerCommentFields,
  anchor: CommentAnchor,
})
export type AnchoredCommentView = typeof AnchoredCommentView.Type

// NOTE: Where a comment of a `full` reviewer, shared with the committee, sits
// for a `redacted` reader: on the section, with the quoted text redacted. No
// item, no positions and no entry path: those point into the original text.
export const SectionNoteAnchor = Schema.Struct({
  kind: Schema.Literal('section_note'),
  sectionId: ApiId,
  quoted: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
})
export type SectionNoteAnchor = typeof SectionNoteAnchor.Type

export const SectionNoteCommentView = Schema.Struct({
  ...reviewerCommentFields,
  anchor: SectionNoteAnchor,
})
export type SectionNoteCommentView = typeof SectionNoteCommentView.Type

export const ReviewerCommentView = Schema.Union([
  AnchoredCommentView,
  SectionNoteCommentView,
])
export type ReviewerCommentView = typeof ReviewerCommentView.Type

export const PendingReview = Schema.Struct({
  revision: Revision,
  // NOTE: The reader's own comments, so always anchored.
  comments: Schema.Array(AnchoredCommentView),
  decision: Schema.optionalKey(ReviewDecisionSchema),
})

export const ReviewResult = Schema.Struct({
  reviewId: ApiId,
  decision: ReviewDecisionSchema,
  sentAt: EpochMs,
  commentsSent: Count,
  round: RoundSummary,
})

export const CommentBody = Body

// ---- Comments for authors ----------------------------------------------------------------------

export const CommentScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('draft'), draft: Count }),
  Schema.Struct({ kind: Schema.Literal('revision'), revision: Revision }),
])

export const AuthorReplyView = Schema.Struct({
  id: ApiId,
  authorId: ApiId,
  authorName: DisplayName,
  body: Schema.String,
  // NOTE: The version stored for redacted readers (D14).
  redactedBody: Schema.String,
  createdAt: EpochMs,
})

export const AuthorCommentView = Schema.Struct({
  id: ApiId,
  scope: CommentScopeSchema,
  anchor: CommentAnchor,
  authorId: ApiId,
  authorName: DisplayName,
  // NOTE: Authors read a comment in the view it was written in. Only a
  // comment of a `full` reviewer shared with the committee has a twin.
  body: Schema.String,
  redactedBody: Schema.optionalKey(Schema.String),
  visibility: CommentVisibilityName,
  sent: Schema.Boolean,
  resolved: Schema.Boolean,
  createdAt: EpochMs,
  replies: Schema.Array(AuthorReplyView),
})
export type AuthorCommentView = typeof AuthorCommentView.Type
