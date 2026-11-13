import { Schema } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'

import { SectionContent } from '../content'
import { PeopleList } from '../people'
import { Template, TemplateId } from '../template'
import { Theme } from '../theme'
import { Authentication } from '../rpc'
import { Email } from '../user'
import {
  AccountRow,
  ActivationLink,
  CapabilityName,
  CommitteeRecord,
  ConsumeLinkRequest,
  GrantResult,
  InviteResult,
  LinkInfo,
  MeView,
  ProfileView,
  Reviewer,
  ReviewerAdded,
  CoAuthorAdded,
  SignInRequest,
  Unit,
  UnitCode,
  UnitMember,
} from './accounts'
import {
  AuditPage,
  AuditSubject,
  ApprovalRecordData,
  DownloadSet,
  NotificationPage,
  AuditKind,
  WhatsAppLink,
  WhatsAppReadiness,
} from './activity'
import {
  ApiId,
  ContentViewSchema,
  Count,
  Deadline,
  DisplayName,
  Phone,
  PublicError,
  ReadError,
  ReportStateSchema,
  ReviewDecisionSchema,
  StateError,
  StorageError,
  TimedError,
  WriteError,
} from './common'
import { GridView, RoundView } from './flow'
import {
  CaseFileChoice,
  CaseFileRecord,
  Comparison,
  ConflictChoiceSchema,
  DraftComparison,
  DraftHeader,
  DraftOutline,
  DraftingInfo,
  History,
  ImageList,
  MarkedImage,
  PeopleView,
  PublishChoices,
  PublishResult,
  PublishTerms,
  ReportDetail,
  ReportList,
  ReportSummary,
  SaveResult,
  ShareOutcome,
  ShareSectionResult,
  VersionSection,
  WorkingCopyOutline,
  WorkingCopySection,
} from './reports'
import {
  AuthorCommentView,
  AnchoredCommentView,
  CommentAnchor,
  CommentBody,
  CommentVisibilityName,
  InboxPage,
  PendingReview,
  PendingReviewItem,
  ReviewResult,
  ReviewerCommentView,
  RevisionOutline,
  RevisionSection,
} from './reviewer'
import {
  PublishedTemplate,
  PublishedTemplateVersion,
  SavedTemplateDraft,
  TemplateRef,
  TemplateSummary,
  TemplateVersionRecord,
  ThemeRecord,
} from './templates'

// NOTE: The iteration 3 contract: two groups, each served at `/api/rpc` once
// stage 3 switches the apps over. `CaseDeskRpcs` of iteration 2 stays as it
// is until then. Procedures are named for what they do; who may call each is
// in `procedures.ts` and `docs/rpc.md`, and the server decides with
// `authorize` on every request. A report that a caller may not see answers
// `NotFound`, exactly like one that does not exist.

const ReportId = { reportId: ApiId }
const DraftNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const SaveCounter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))

// ---- Public (no session) ------------------------------------------------------------------------
//
// The Worker sets the session cookie after `SignIn` and `ConsumeLink`; the
// response carries the account, never the token. The link token is only ever
// in a POST body (D13).

export class QuoroomPublicRpcs extends RpcGroup.make(
  Rpc.make('SignIn', {
    payload: SignInRequest,
    success: MeView,
    error: PublicError,
  }),
  Rpc.make('InspectLink', {
    payload: { token: ConsumeLinkRequest.fields.token },
    success: LinkInfo,
    error: PublicError,
  }),
  Rpc.make('ConsumeLink', {
    payload: ConsumeLinkRequest,
    success: MeView,
    error: PublicError,
  }),
) {}

// ---- Signed in -----------------------------------------------------------------------------------

export class QuoroomRpcs extends RpcGroup.make(
  // -- Session and accounts (stage 3a)
  Rpc.make('GetMe', { success: MeView, error: StorageError }),
  Rpc.make('SignOut', { error: StorageError }),
  Rpc.make('SetNotificationPreferences', {
    payload: {
      notifyOnApproval: Schema.Boolean,
      // NOTE: the person's own number (`null` clears it, and with it the
      // consent) and their own WhatsApp consent. Nobody else can set either.
      phone: Schema.optionalKey(Schema.NullOr(Phone)),
      whatsappConsent: Schema.optionalKey(Schema.Boolean),
    },
    success: ProfileView,
    error: StorageError,
  }),
  Rpc.make('ListAccounts', {
    success: Schema.Array(AccountRow),
    error: ReadError,
  }),
  Rpc.make('IssueReset', {
    payload: { accountId: ApiId },
    success: ActivationLink,
    error: ReadError,
  }),
  Rpc.make('GrantCapability', {
    payload: {
      email: Email,
      name: Schema.optionalKey(DisplayName),
      capability: CapabilityName,
      unit: Schema.optionalKey(ApiId),
    },
    success: GrantResult,
    error: WriteError,
  }),
  Rpc.make('RevokeCapability', {
    payload: {
      accountId: ApiId,
      capability: CapabilityName,
      unit: Schema.optionalKey(ApiId),
    },
    success: AccountRow,
    error: WriteError,
  }),

  // -- Units and membership (stage 3a)
  Rpc.make('ListUnits', { success: Schema.Array(Unit), error: StorageError }),
  Rpc.make('CreateUnit', {
    payload: { name: DisplayName, code: UnitCode },
    success: Unit,
    error: WriteError,
  }),
  Rpc.make('UpdateUnit', {
    payload: { unit: ApiId, name: DisplayName },
    success: Unit,
    error: WriteError,
  }),
  Rpc.make('ListUnitMembers', {
    payload: { unit: ApiId },
    success: Schema.Array(UnitMember),
    error: ReadError,
  }),
  Rpc.make('InviteToUnit', {
    payload: { unit: ApiId, email: Email, name: DisplayName },
    success: InviteResult,
    error: WriteError,
  }),

  // -- Reviewer registry and committees (stage 3b)
  Rpc.make('ListReviewers', {
    payload: { unit: ApiId },
    success: Schema.Array(Reviewer),
    error: ReadError,
  }),
  Rpc.make('AddReviewer', {
    payload: {
      unit: ApiId,
      name: DisplayName,
      email: Email,
      phone: Schema.optionalKey(Phone),
      // NOTE: asks the person for consent; it does not give it.
      whatsappConsent: Schema.Boolean,
    },
    success: ReviewerAdded,
    error: WriteError,
  }),
  Rpc.make('UpdateReviewer', {
    payload: {
      unit: ApiId,
      accountId: ApiId,
      name: Schema.optionalKey(DisplayName),
      // NOTE: the unit's own entry only. `null` clears the number (and with it
      // the request for consent).
      phone: Schema.optionalKey(Schema.NullOr(Phone)),
      // NOTE: asks the person for consent; it does not give it.
      whatsappConsent: Schema.optionalKey(Schema.Boolean),
    },
    success: Reviewer,
    error: WriteError,
  }),
  Rpc.make('ListCommittees', {
    payload: { unit: ApiId },
    success: Schema.Array(CommitteeRecord),
    error: ReadError,
  }),
  Rpc.make('CreateCommittee', {
    payload: {
      unit: ApiId,
      name: DisplayName,
      memberIds: Schema.Array(ApiId).check(Schema.isMaxLength(200)),
    },
    success: CommitteeRecord,
    error: WriteError,
  }),
  Rpc.make('UpdateCommittee', {
    payload: {
      committeeId: ApiId,
      name: Schema.optionalKey(DisplayName),
      memberIds: Schema.optionalKey(
        Schema.Array(ApiId).check(Schema.isMaxLength(200)),
      ),
      // NOTE: Member changes as operations on the stored list, so two quick
      // changes never overwrite each other. A member in both lists is added.
      addMemberIds: Schema.optionalKey(
        Schema.Array(ApiId).check(Schema.isMaxLength(200)),
      ),
      removeMemberIds: Schema.optionalKey(
        Schema.Array(ApiId).check(Schema.isMaxLength(200)),
      ),
      retired: Schema.optionalKey(Schema.Boolean),
    },
    success: CommitteeRecord,
    error: WriteError,
  }),

  // -- Templates (stage 9)
  Rpc.make('ListTemplates', {
    success: Schema.Array(TemplateSummary),
    error: ReadError,
  }),
  Rpc.make('ListPublishedTemplates', {
    success: Schema.Array(PublishedTemplate),
    error: ReadError,
  }),
  Rpc.make('GetTemplateVersion', {
    // NOTE: A member of a report names it (`reportId`, and for a reviewer the
    // `revision` sent to them); the handler checks `read_template_version` on
    // that report and that the report uses this version. Template editors
    // leave both out.
    payload: {
      ...TemplateRef.fields,
      reportId: Schema.optionalKey(ApiId),
      revision: Schema.optionalKey(Revision),
    },
    success: TemplateVersionRecord,
    error: ReadError,
  }),
  Rpc.make('CreateTemplateDraft', {
    payload: {
      copyOf: Schema.optionalKey(TemplateRef),
      name: Schema.optionalKey(DisplayName),
    },
    success: TemplateVersionRecord,
    error: WriteError,
  }),
  Rpc.make('SaveTemplateDraft', {
    payload: { templateId: TemplateId, version: Revision, template: Template },
    success: SavedTemplateDraft,
    error: WriteError,
  }),
  Rpc.make('PublishTemplateVersion', {
    payload: TemplateRef,
    success: PublishedTemplateVersion,
    error: WriteError,
  }),
  Rpc.make('RetireTemplate', {
    payload: { templateId: TemplateId },
    success: TemplateSummary,
    error: WriteError,
  }),

  // -- Theme (stage 9d)
  Rpc.make('GetTheme', { success: ThemeRecord, error: StorageError }),
  Rpc.make('UpdateTheme', {
    payload: { theme: Theme },
    success: ThemeRecord,
    error: WriteError,
  }),

  // -- Case files and reports (stage 4a)
  Rpc.make('ListCaseFiles', {
    payload: { unit: ApiId },
    success: Schema.Array(CaseFileRecord),
    error: ReadError,
  }),
  Rpc.make('UpdateCaseFile', {
    payload: { caseFileId: ApiId, title: CaseFileRecord.fields.title },
    success: CaseFileRecord,
    error: WriteError,
  }),
  Rpc.make('CreateReport', {
    payload: {
      unit: ApiId,
      caseFile: CaseFileChoice,
      templateId: TemplateId,
      // NOTE: The published version at the time of the request, so a template
      // published meanwhile never surprises the author.
      templateVersion: Revision,
    },
    success: ReportSummary,
    error: WriteError,
  }),
  Rpc.make('ListReports', {
    payload: {
      state: Schema.optionalKey(ReportStateSchema),
      unit: Schema.optionalKey(ApiId),
    },
    success: ReportList,
    error: StorageError,
  }),
  Rpc.make('GetReport', {
    payload: ReportId,
    success: ReportDetail,
    error: ReadError,
  }),
  // NOTE: by account ID, from the authors of the report's unit
  // (`ListUnitMembers`). It never creates an account or grants anything.
  Rpc.make('AddCoAuthor', {
    payload: { ...ReportId, accountId: ApiId },
    success: CoAuthorAdded,
    error: WriteError,
  }),
  Rpc.make('ListDrafting', {
    payload: ReportId,
    success: Schema.Array(DraftingInfo),
    error: ReadError,
  }),

  // -- Working copies (stage 4f)
  Rpc.make('StartWorkingCopy', {
    payload: {
      ...ReportId,
      baseDraft: Schema.optionalKey(DraftNumber),
      // NOTE: Discard an existing working copy and start again.
      replace: Schema.optionalKey(Schema.Boolean),
    },
    success: WorkingCopyOutline,
    error: StateError,
  }),
  Rpc.make('GetWorkingCopy', {
    payload: ReportId,
    success: WorkingCopyOutline,
    error: ReadError,
  }),
  Rpc.make('GetWorkingCopySection', {
    payload: { ...ReportId, sectionId: ApiId },
    success: WorkingCopySection,
    error: ReadError,
  }),
  Rpc.make('SaveSection', {
    payload: {
      ...ReportId,
      sectionId: ApiId,
      // NOTE: The counter the browser last saw. A stale one is refused with
      // `Conflict` (`stale_save`), so two tabs cannot overwrite each other.
      saveCounter: SaveCounter,
      content: SectionContent,
    },
    success: SaveResult,
    error: StateError,
  }),
  Rpc.make('SavePeople', {
    payload: { ...ReportId, saveCounter: SaveCounter, people: PeopleList },
    success: SaveResult,
    error: StateError,
  }),
  Rpc.make('GetPeople', {
    payload: { ...ReportId, draft: Schema.optionalKey(DraftNumber) },
    success: PeopleView,
    error: ReadError,
  }),

  // -- Sharing (stage 4g, spike 3)
  Rpc.make('ShareSection', {
    payload: {
      ...ReportId,
      // NOTE: Chosen by the browser, the same for every request of one share.
      shareId: ApiId,
      sectionId: ApiId,
      saveCounter: SaveCounter,
    },
    success: ShareSectionResult,
    error: StateError,
  }),
  Rpc.make('FinishShare', {
    payload: {
      ...ReportId,
      shareId: ApiId,
      saveCounter: SaveCounter,
      // NOTE: SHA-256 (hex) of `<redacted hashes>|<people hash>`: the staged
      // sections' redacted hashes joined by commas in section order, a bar and
      // the `peopleHash` of the share. It is the content and the people list
      // the author saw in the redaction preview (D14): a people list changed
      // since refuses the share. The server records the confirmation in the
      // same batch as the draft and, if asked, the publish; it is required to
      // publish to a `redacted` role, and refused when the staged content is
      // not the content that was seen.
      redactionHash: Schema.optionalKey(Schema.String),
      // NOTE: "Share and publish": one batch for both.
      publish: Schema.optionalKey(PublishTerms),
    },
    success: ShareOutcome,
    error: TimedError,
  }),
  Rpc.make('PreviewMerge', {
    payload: ReportId,
    success: Comparison,
    error: ReadError,
  }),
  Rpc.make('ResolveMerge', {
    payload: {
      ...ReportId,
      saveCounter: SaveCounter,
      // NOTE: By conflict key. Only what the author chose; the server
      // recomputes the comparison and refuses unresolved conflicts.
      choices: Schema.Record(Schema.String, ConflictChoiceSchema),
    },
    success: WorkingCopyOutline,
    error: StateError,
  }),

  // -- Draft history and comparison (stage 4g)
  Rpc.make('GetHistory', {
    payload: ReportId,
    success: History,
    error: ReadError,
  }),
  Rpc.make('GetDraftOutline', {
    payload: { ...ReportId, draft: DraftNumber },
    success: DraftOutline,
    error: ReadError,
  }),
  Rpc.make('GetDraftSection', {
    payload: {
      ...ReportId,
      draft: DraftNumber,
      sectionId: ApiId,
      view: ContentViewSchema,
    },
    success: VersionSection,
    error: ReadError,
  }),
  Rpc.make('CompareDrafts', {
    payload: { ...ReportId, from: DraftNumber, to: DraftNumber },
    success: DraftComparison,
    error: ReadError,
  }),

  // -- Redaction and images (stage 5)
  Rpc.make('ConfirmRedaction', {
    payload: { ...ReportId, draft: DraftNumber, redactedHash: Schema.String },
    success: DraftHeader,
    error: StateError,
  }),
  Rpc.make('ListImages', {
    payload: ReportId,
    success: ImageList,
    error: ReadError,
  }),
  Rpc.make('MarkImageSafe', {
    payload: {
      ...ReportId,
      imageId: ApiId,
      safe: Schema.Boolean,
      saveCounter: SaveCounter,
    },
    success: MarkedImage,
    error: StateError,
  }),

  // -- Publishing and closing (stage 6a, 6e)
  Rpc.make('GetPublishChoices', {
    payload: ReportId,
    success: PublishChoices,
    error: ReadError,
  }),
  Rpc.make('PublishRevision', {
    payload: { ...ReportId, draft: DraftNumber, terms: PublishTerms },
    success: PublishResult,
    error: TimedError,
  }),
  Rpc.make('GetRound', {
    payload: { ...ReportId, revision: Revision },
    success: RoundView,
    error: ReadError,
  }),
  Rpc.make('ExtendDeadline', {
    payload: { ...ReportId, revision: Revision, deadline: Deadline },
    success: RoundView,
    error: TimedError,
  }),
  Rpc.make('RemoveReviewer', {
    payload: { ...ReportId, revision: Revision, accountId: ApiId },
    success: RoundView,
    error: TimedError,
  }),
  Rpc.make('StartConclusion', {
    payload: ReportId,
    success: ReportSummary,
    error: StateError,
  }),
  Rpc.make('ArchiveReport', {
    payload: ReportId,
    success: ReportSummary,
    error: StateError,
  }),

  // -- Reviewer: inbox, reading, comments, review (stage 6b, 6c)
  Rpc.make('ListInbox', {
    payload: {
      // NOTE: Position in the list (newest deadline first); pass the page's
      // `next` for the following one.
      offset: Schema.optionalKey(Count),
      limit: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })),
      ),
    },
    success: InboxPage,
    error: StorageError,
  }),
  Rpc.make('ListPendingReviews', {
    success: Schema.Array(PendingReviewItem),
    error: StorageError,
  }),
  // NOTE: Records that the reviewer opened the revision (the grid's "opened").
  Rpc.make('GetRevisionOutline', {
    payload: { ...ReportId, revision: Revision },
    success: RevisionOutline,
    error: ReadError,
  }),
  Rpc.make('GetRevisionSection', {
    payload: { ...ReportId, revision: Revision, sectionId: ApiId },
    success: RevisionSection,
    error: ReadError,
  }),
  Rpc.make('ListReviewerComments', {
    payload: { ...ReportId, revision: Revision },
    success: Schema.Array(ReviewerCommentView),
    error: ReadError,
  }),
  Rpc.make('AddComment', {
    payload: {
      ...ReportId,
      revision: Revision,
      anchor: CommentAnchor,
      body: CommentBody,
      // NOTE: Chosen now, fixed once the review is sent.
      visibility: CommentVisibilityName,
    },
    success: AnchoredCommentView,
    error: TimedError,
  }),
  Rpc.make('UpdatePendingComment', {
    payload: {
      ...ReportId,
      commentId: ApiId,
      body: Schema.optionalKey(CommentBody),
      visibility: Schema.optionalKey(CommentVisibilityName),
    },
    success: AnchoredCommentView,
    error: TimedError,
  }),
  Rpc.make('DeletePendingComment', {
    payload: { ...ReportId, commentId: ApiId },
    error: TimedError,
  }),
  Rpc.make('GetPendingReview', {
    payload: { ...ReportId, revision: Revision },
    success: PendingReview,
    error: ReadError,
  }),
  Rpc.make('SavePendingReview', {
    payload: {
      ...ReportId,
      revision: Revision,
      decision: Schema.optionalKey(ReviewDecisionSchema),
    },
    success: PendingReview,
    error: TimedError,
  }),
  Rpc.make('SendReview', {
    payload: {
      ...ReportId,
      revision: Revision,
      decision: ReviewDecisionSchema,
      // NOTE: The pending comments the reviewer saw in the send dialog. The
      // review is refused (Conflict `pending_changed`) when the server's set
      // is not exactly this one, so nothing is sent that was not shown.
      commentIds: Schema.Array(ApiId),
    },
    success: ReviewResult,
    error: TimedError,
  }),

  // -- Authors: comments and replies (stage 4g, 6c)
  Rpc.make('ListDraftComments', {
    payload: { ...ReportId, draft: DraftNumber },
    success: Schema.Array(AuthorCommentView),
    error: ReadError,
  }),
  Rpc.make('AddDraftComment', {
    payload: {
      ...ReportId,
      draft: DraftNumber,
      anchor: CommentAnchor,
      body: CommentBody,
    },
    success: AuthorCommentView,
    error: StateError,
  }),
  Rpc.make('ListRevisionComments', {
    payload: { ...ReportId, revision: Revision },
    success: Schema.Array(AuthorCommentView),
    error: ReadError,
  }),
  Rpc.make('ReplyToComment', {
    payload: { ...ReportId, commentId: ApiId, body: CommentBody },
    success: AuthorCommentView,
    error: StateError,
  }),
  Rpc.make('ResolveComment', {
    payload: { ...ReportId, commentId: ApiId, resolved: Schema.Boolean },
    success: AuthorCommentView,
    error: StateError,
  }),

  // -- Grid and audit (stage 6d)
  Rpc.make('GetGrid', { payload: ReportId, success: GridView, error: ReadError }),
  Rpc.make('ListAuditEvents', {
    payload: {
      subject: AuditSubject,
      before: Schema.optionalKey(ApiId),
      // NOTE: Only the events of this kind (the part of the action before the
      // dot), applied before the page is cut.
      kind: Schema.optionalKey(AuditKind),
      limit: Limit,
    },
    success: AuditPage,
    error: ReadError,
  }),

  // -- Notifications and WhatsApp (stage 7)
  Rpc.make('ListNotifications', {
    payload: { before: Schema.optionalKey(Count), limit: Limit },
    success: NotificationPage,
    error: StorageError,
  }),
  // NOTE: The cheap poll every 30 seconds.
  Rpc.make('GetUnreadCount', {
    success: Schema.Struct({ unread: Count }),
    error: StorageError,
  }),
  Rpc.make('MarkNotificationsRead', {
    payload: {
      ids: Schema.Array(ApiId).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    },
    success: Schema.Struct({ unread: Count }),
    error: StorageError,
  }),
  Rpc.make('GetWhatsAppLink', {
    payload: { ...ReportId, revision: Revision, accountId: ApiId },
    success: WhatsAppLink,
    error: WriteError,
  }),
  Rpc.make('ListWhatsAppLinks', {
    payload: { ...ReportId, revision: Revision },
    success: Schema.Array(WhatsAppReadiness),
    error: WriteError,
  }),
  Rpc.make('RecordWhatsAppOpened', {
    payload: { ...ReportId, revision: Revision, accountId: ApiId },
    error: TimedError,
  }),

  // -- Downloads metadata (stage 8)
  Rpc.make('GetDownloads', {
    payload: ReportId,
    success: DownloadSet,
    error: ReadError,
  }),
  Rpc.make('GetApprovalRecordData', {
    payload: ReportId,
    success: ApprovalRecordData,
    error: ReadError,
  }),
).middleware(Authentication) {}

