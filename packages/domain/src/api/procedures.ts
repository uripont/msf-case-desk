import type { ActionType } from '../permissions'
import { QuoroomPublicRpcs, QuoroomRpcs } from './rpcs'

// NOTE: Who may call each procedure, as data. The server's `authorize` is the
// rule; this table is documentation that tests keep honest: every procedure of
// both groups has exactly one row, and `docs/rpc.md` lists every row.

export type Area =
  | 'session'
  | 'accounts'
  | 'units'
  | 'committees'
  | 'templates'
  | 'theme'
  | 'reports'
  | 'working_copies'
  | 'sharing'
  | 'history'
  | 'redaction'
  | 'publishing'
  | 'reviewer'
  | 'comments'
  | 'grid_audit'
  | 'notifications'
  | 'downloads'

export type Audience =
  // No session.
  | 'public'
  // Any signed-in account, about itself.
  | 'signed_in'
  | 'admin'
  | 'template_editor'
  // An author capability in the unit.
  | 'unit_author'
  // A member of the report's drafting role, with the permission `authorize`
  // names for the action.
  | 'report_author'
  // A participant of the round, in a reviewing role.
  | 'reviewer'

export type Procedure = Readonly<{
  area: Area
  audience: Audience
  // NOTE: The `authorize` actions the handler checks (see permissions.ts).
  // Empty for `public` and `signed_in`.
  actions: ReadonlyArray<ActionType>
  note?: string
}>

const p = (
  area: Area,
  audience: Audience,
  actions: ReadonlyArray<ActionType> = [],
  note?: string,
): Procedure => (note === undefined ? { area, audience, actions } : { area, audience, actions, note })

export const PROCEDURES = {
  // -- public
  SignIn: p('session', 'public', [], 'Throttled before hashing (D13).'),
  InspectLink: p('session', 'public'),
  ConsumeLink: p('session', 'public'),
  // -- session and accounts
  GetMe: p('session', 'signed_in'),
  SignOut: p('session', 'signed_in'),
  SetNotificationPreferences: p('session', 'signed_in', [], 'D19. Authors only matter.'),
  ListAccounts: p('accounts', 'admin', ['manage_grants']),
  IssueReset: p('accounts', 'admin', ['issue_reset']),
  GrantCapability: p('accounts', 'admin', ['manage_grants']),
  RevokeCapability: p('accounts', 'admin', ['manage_grants']),
  // -- units
  ListUnits: p('units', 'signed_in', [], 'Administrators all units; others the units they hold a grant in.'),
  CreateUnit: p('units', 'admin', ['manage_units']),
  UpdateUnit: p('units', 'admin', ['manage_units']),
  ListUnitMembers: p('units', 'unit_author', ['invite_to_unit']),
  InviteToUnit: p('units', 'unit_author', ['invite_to_unit']),
  // -- committees
  ListReviewers: p('committees', 'unit_author', ['manage_committees']),
  AddReviewer: p('committees', 'unit_author', ['manage_committees']),
  UpdateReviewer: p('committees', 'unit_author', ['manage_committees']),
  ListCommittees: p('committees', 'unit_author', ['manage_committees']),
  CreateCommittee: p('committees', 'unit_author', ['manage_committees']),
  UpdateCommittee: p('committees', 'unit_author', ['manage_committees']),
  // -- templates
  ListTemplates: p('templates', 'template_editor', ['edit_template']),
  ListPublishedTemplates: p('templates', 'unit_author', ['create_report'], 'Any author capability.'),
  GetTemplateVersion: p(
    'templates',
    'template_editor',
    ['preview_template', 'read_template_version'],
    'Template editors read any version (`preview_template`). Authors of a report that uses the version, and reviewers for the version of a revision sent to them, read it with `read_template_version` on that report; anyone else gets NotFound.',
  ),
  CreateTemplateDraft: p('templates', 'template_editor', ['create_template', 'copy_template']),
  SaveTemplateDraft: p('templates', 'template_editor', ['edit_template']),
  PublishTemplateVersion: p('templates', 'template_editor', ['publish_template']),
  RetireTemplate: p('templates', 'template_editor', ['retire_template']),
  // -- theme
  GetTheme: p('theme', 'signed_in'),
  UpdateTheme: p('theme', 'admin', ['set_theme']),
  // -- reports
  ListCaseFiles: p('reports', 'unit_author', ['create_report']),
  UpdateCaseFile: p('reports', 'report_author', ['view_report'], 'Authors of a report of the case file.'),
  CreateReport: p('reports', 'unit_author', ['create_report']),
  ListReports: p('reports', 'report_author', ['view_report'], 'Only reports where the caller is in the drafting role.'),
  GetReport: p('reports', 'report_author', ['view_report']),
  AddCoAuthor: p('reports', 'report_author', ['add_co_author'], 'By account ID, from the unit\'s authors; checkNewAuthor: not a reviewer in an open round.'),
  ListDrafting: p('reports', 'report_author', ['read_people'], 'Author-only fact, polled every 30 seconds.'),
  // -- working copies
  StartWorkingCopy: p('working_copies', 'report_author', ['start_working_copy']),
  GetWorkingCopy: p('working_copies', 'report_author', ['read_working_copy']),
  GetWorkingCopySection: p('working_copies', 'report_author', ['read_working_copy'], 'Own working copy only.'),
  SaveSection: p('working_copies', 'report_author', ['save_section'], 'checkSave: conclusion rule.'),
  SavePeople: p('working_copies', 'report_author', ['save_people']),
  GetPeople: p('working_copies', 'report_author', ['read_people']),
  // -- sharing
  ShareSection: p('sharing', 'report_author', ['share_draft']),
  FinishShare: p('sharing', 'report_author', ['share_draft', 'publish_revision'], 'publish_revision only when `publish` is set.'),
  PreviewMerge: p('sharing', 'report_author', ['share_draft']),
  ResolveMerge: p('sharing', 'report_author', ['save_section']),
  // -- history
  GetHistory: p('history', 'report_author', ['read_draft']),
  GetDraftOutline: p('history', 'report_author', ['read_draft'], 'Records the draft as read.'),
  GetDraftSection: p('history', 'report_author', ['read_draft']),
  CompareDrafts: p('history', 'report_author', ['read_draft']),
  // -- redaction and images
  ConfirmRedaction: p('redaction', 'report_author', ['publish_revision']),
  ListImages: p('redaction', 'report_author', ['read_working_copy']),
  MarkImageSafe: p('redaction', 'report_author', ['save_section']),
  // -- publishing
  GetPublishChoices: p('publishing', 'report_author', ['publish_revision']),
  PublishRevision: p('publishing', 'report_author', ['publish_revision']),
  GetRound: p('publishing', 'report_author', ['read_grid']),
  ExtendDeadline: p('publishing', 'report_author', ['extend_deadline']),
  RemoveReviewer: p('publishing', 'report_author', ['remove_reviewer']),
  StartConclusion: p('publishing', 'report_author', ['start_conclusion']),
  ArchiveReport: p('publishing', 'report_author', ['publish_revision'], 'The `archive` event of report-flow.ts.'),
  // -- reviewer
  ListInbox: p('reviewer', 'reviewer', [], 'Rounds the caller participates in.'),
  ListPendingReviews: p('reviewer', 'reviewer', ['write_comment']),
  GetRevisionOutline: p('reviewer', 'reviewer', ['read_revision'], 'Records the revision as opened.'),
  GetRevisionSection: p('reviewer', 'reviewer', ['read_revision'], 'The server picks redacted or full.'),
  ListReviewerComments: p('reviewer', 'reviewer', ['read_comments'], 'canSeeComment.'),
  AddComment: p('reviewer', 'reviewer', ['write_comment']),
  UpdatePendingComment: p('reviewer', 'reviewer', ['write_comment']),
  DeletePendingComment: p('reviewer', 'reviewer', ['write_comment']),
  GetPendingReview: p('reviewer', 'reviewer', ['write_comment']),
  SavePendingReview: p('reviewer', 'reviewer', ['write_comment']),
  SendReview: p('reviewer', 'reviewer', ['submit_review']),
  // -- author comments
  ListDraftComments: p('comments', 'report_author', ['read_draft_comments']),
  AddDraftComment: p('comments', 'report_author', ['comment_on_draft']),
  ListRevisionComments: p('comments', 'report_author', ['read_comments'], 'Every sent comment, in the view it was written in.'),
  ReplyToComment: p('comments', 'report_author', ['reply']),
  ResolveComment: p('comments', 'report_author', ['reply']),
  // -- grid and audit
  GetGrid: p('grid_audit', 'report_author', ['read_grid']),
  ListAuditEvents: p('grid_audit', 'report_author', ['read_audit'], 'Subject `template`: template editor; `theme`: administrator.'),
  // -- notifications
  ListNotifications: p('notifications', 'signed_in'),
  GetUnreadCount: p('notifications', 'signed_in'),
  MarkNotificationsRead: p('notifications', 'signed_in'),
  GetWhatsAppLink: p('notifications', 'report_author', ['publish_revision'], 'Needs the reviewer\'s number and consent.'),
  RecordWhatsAppOpened: p('notifications', 'report_author', ['publish_revision']),
  // -- downloads
  GetDownloads: p('downloads', 'report_author', ['read_draft']),
  GetApprovalRecordData: p('downloads', 'report_author', ['read_grid']),
} as const satisfies Record<string, Procedure>

export type ProcedureName = keyof typeof PROCEDURES

export const PROCEDURE_NAMES = Object.keys(PROCEDURES) as ReadonlyArray<ProcedureName>

// NOTE: Procedures a reviewing role calls. Their response schemas are held to
// the structural rules in reviewer.ts.
export const REVIEWER_PROCEDURES: ReadonlyArray<ProcedureName> = PROCEDURE_NAMES.filter(
  name => PROCEDURES[name].audience === 'reviewer',
)

export const ALL_RPCS = [
  ...QuoroomPublicRpcs.requests.values(),
  ...QuoroomRpcs.requests.values(),
]
