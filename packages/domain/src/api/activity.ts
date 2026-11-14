import { Schema } from 'effect'

import { ReportFlowSchema, ReportEventSchema } from './flow'
import {
  AccountRef,
  ApiId,
  ContentViewSchema,
  Count,
  Deadline,
  EpochMs,
} from './common'
import { TemplateId } from '../template'

// NOTE: Audit log, notification inbox, WhatsApp link data and downloads
// metadata (stages 6 to 8).

// ---- Audit ---------------------------------------------------------------------------------

// NOTE: Small metadata only, never report text (section 5).
export const AuditMeta = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String.check(Schema.isMaxLength(200)), Schema.Finite, Schema.Boolean]),
)

export const AUDIT_KINDS = [
  'report',
  'draft',
  'redaction',
  'revision',
  'review',
  'round',
] as const
export const AuditKind = Schema.Literals(AUDIT_KINDS)
export type AuditKind = typeof AuditKind.Type

export const AuditEvent = Schema.Struct({
  id: ApiId,
  at: EpochMs,
  actor: Schema.optionalKey(AccountRef),
  // NOTE: Machine name such as `draft_shared`, `template_published`.
  action: Schema.String.check(Schema.isMaxLength(64)),
  draft: Schema.optionalKey(Count),
  revision: Schema.optionalKey(Count),
  meta: AuditMeta,
})
export type AuditEvent = typeof AuditEvent.Type

// NOTE: A report's log is for its authors; a template's for template editors;
// the theme's for administrators.
export const AuditSubject = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('report'), reportId: ApiId }),
  Schema.Struct({ kind: Schema.Literal('template'), templateId: TemplateId }),
  Schema.Struct({ kind: Schema.Literal('theme') }),
])

export const AuditPage = Schema.Struct({
  events: Schema.Array(AuditEvent),
  // NOTE: Pass as `before` for the next, older page.
  next: Schema.optionalKey(ApiId),
})

// ---- Notifications ---------------------------------------------------------------------------

export const NOTIFICATION_KINDS = [
  'review_request',
  'reminder_first',
  'reminder_final',
  'deadline',
  'revision_replaced',
  'review_received',
  'approval_received',
  'round_decided',
  'removed_from_round',
] as const

export const NotificationKindSchema = Schema.Literals(NOTIFICATION_KINDS)

// NOTE: Generic by design: no case title, no report text (D17).
export const NotificationEntry = Schema.Struct({
  id: ApiId,
  kind: NotificationKindSchema,
  at: EpochMs,
  readAt: Schema.optionalKey(EpochMs),
  reportId: Schema.optionalKey(ApiId),
  revision: Schema.optionalKey(Count),
  deadline: Schema.optionalKey(Deadline),
})

export const NotificationPage = Schema.Struct({
  items: Schema.Array(NotificationEntry),
  unread: Count,
  // NOTE: pass as `before` for the next, older page.
  next: Schema.optionalKey(Count),
})

// ---- WhatsApp (D17) ------------------------------------------------------------------------------

export const WhatsAppLink = Schema.Struct({
  accountId: ApiId,
  name: Schema.String,
  // NOTE: Digits only, without `+`.
  number: Schema.String.check(Schema.isPattern(/^[1-9]\d{6,14}$/)),
  // NOTE: Never names the case or the report: only the deadline in its own
  // time zone and the link.
  text: Schema.String.check(Schema.isMaxLength(500)),
  url: Schema.String.check(Schema.isMaxLength(1500)),
})

// NOTE: One row per active participant of the round: whether a link can be
// made for them (a number and consent). No number: the number is fetched, with
// `GetWhatsAppLink`, only when the author taps for that person.
export const WhatsAppReadiness = Schema.Struct({
  accountId: ApiId,
  ready: Schema.Boolean,
})

// ---- Downloads (D4) -----------------------------------------------------------------------------

// NOTE: The versions an author may take out as PDF. The PDF is made in the
// browser from the sections the other procedures return.
export const DownloadVersion = Schema.Struct({
  kind: Schema.Literals(['draft', 'revision']),
  number: Count,
  label: Schema.String,
  view: ContentViewSchema,
  closing: Schema.Boolean,
  at: EpochMs,
})

export const DownloadSet = Schema.Struct({
  reportName: Schema.String,
  caseReference: Schema.String,
  versions: Schema.Array(DownloadVersion),
  approvalRecord: Schema.Boolean,
})

// NOTE: Input of `approvalRecordDescription` apart from the template and the
// theme, which the browser already has.
export const ApprovalRecordData = Schema.Struct({
  reportName: Schema.String,
  caseFile: Schema.Struct({
    reference: Schema.String,
    unit: Schema.String,
    title: Schema.String,
  }),
  flow: ReportFlowSchema,
  events: Schema.Array(ReportEventSchema),
  authors: Schema.Array(ApiId),
  accountNames: Schema.Record(Schema.String, Schema.String),
})
