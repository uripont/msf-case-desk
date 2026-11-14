import { Context, type Effect } from 'effect'

import {
  DATABASE_LIMIT_BYTES,
  IMAGE_CHUNK_BYTES,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SIDE,
  IMAGE_REPORT_LIMIT_BYTES,
} from './api/images-route'
import type { ReviewDecision } from './approval'
import type { NotificationJob } from './notifications'
import type { ReportState } from './report-flow'
import type { RepositoryError } from './repository'

// NOTE: The storage contract of iteration 3 (stage 2b). One Effect service,
// two implementations (SQL in apps/api, in memory in `testing/report-repository-memory.ts`)
// and one contract suite (`testing/reportRepositoryContract.ts`) that both
// pass. It is storage only: no authorization and no rules. Handlers read, ask
// the pure domain, and write through the operations below.
//
// Conventions.
// - JSON (content, people, template definitions, theme) is text the handler
//   parses only where it must look inside (spike 3). The repository never
//   interprets it, except `image_refs` and the job and participant lists,
//   which SQLite expands with `json_each`.
// - Time and IDs come in as arguments; the domain has no clock.
// - A refusal is a value (`_tag: 'Refused'` with a reason), never an error.
//   `RepositoryError` means storage failed.
// - Every write that must be atomic is one guarded batch (apps/api/src/sql.ts):
//   a guard step must change exactly one row or the whole batch has no effect.
// - Each operation states its D1 query count in `QUERY_BUDGET` (a guard counts
//   as 2, as `runBatch` does). Workers Free allows 50 queries per request.
// - Nothing is deleted, except staging rows and images no draft references.

type Eff<A> = Effect.Effect<A, RepositoryError>

export type Refused<R extends string> = Readonly<{
  _tag: 'Refused'
  reason: R
}>

// ---- Records ---------------------------------------------------------------------------------

export type UnitRecord = Readonly<{
  id: string
  name: string
  code: string
  createdAt: number
}>

export type StoreCapabilityName = 'admin' | 'template_editor' | 'author'

export type GrantRecord = Readonly<{
  userId: string
  capability: StoreCapabilityName
  // NOTE: `null` for the deployment-wide capabilities.
  unitId: string | null
  grantedBy: string | null
  grantedAt: number
}>

export type AccountRecord = Readonly<{
  id: string
  email: string
  name: string
  profile: AccountProfile | null
}>

export type AccountProfile = Readonly<{
  userId: string
  phone: string | null
  whatsappConsent: boolean
  whatsappConsentAt: number | null
  notifyOnApproval: boolean
  active: boolean
  passwordSetAt: number | null
}>

export type ProfileInput = Readonly<{
  phone: string | null
  whatsappConsent: boolean
  whatsappConsentAt: number | null
  notifyOnApproval: boolean
  active: boolean
}>

export type InvitationPurpose = 'activate' | 'reset'

export type InvitationRecord = Readonly<{
  id: string
  tokenHash: string
  userId: string
  purpose: InvitationPurpose
  expiresAt: number
  usedAt: number | null
  issuedBy: string | null
  createdAt: number
}>

export type InvitationInput = Readonly<{
  id: string
  tokenHash: string
  userId: string
  purpose: InvitationPurpose
  expiresAt: number
  issuedBy: string | null
  createdAt: number
}>

export type AuditInput = Readonly<{
  at: number
  actorId: string | null
  action: string
  reportId?: string
  templateId?: string
  draftNumber?: number
  revisionNumber?: number
  // NOTE: small JSON, never report text.
  meta?: string
}>

export type AuditRecord = Readonly<{
  id: number
  at: number
  actorId: string | null
  reportId: string | null
  templateId: string | null
  draftNumber: number | null
  revisionNumber: number | null
  action: string
  meta: string
}>

export type StoreThemeRecord = Readonly<{
  settings: string
  logoImageId: string | null
  updatedAt: number
  updatedBy: string | null
}>

export type TemplateState = 'draft' | 'published' | 'retired'

export type StoreTemplateVersionRecord = Readonly<{
  templateId: string
  version: number
  name: string
  shortName: string
  state: TemplateState
  definition: string
  builtin: boolean
  createdBy: string | null
  createdAt: number
  publishedAt: number | null
  publishedBy: string | null
  changes: string | null
  retiredAt: number | null
  draftRevision: number
}>

export type StoreTemplateSummary = Omit<
  StoreTemplateVersionRecord,
  'definition'
>

export type BuiltInTemplateInput = Readonly<{
  templateId: string
  version: number
  name: string
  shortName: string
  definition: string
}>

export type StoreCommitteeRecord = Readonly<{
  id: string
  unitId: string
  name: string
  createdAt: number
  archivedAt: number | null
  memberIds: ReadonlyArray<string>
}>

// NOTE: an entry of a unit's reviewer registry. The name and the number are the
// unit's own (what its authors typed), never the account's: the account's name
// and number are the person's, and an author of a unit neither reads nor
// changes them (D13).
export type UnitReviewerRecord = Readonly<{
  unitId: string
  userId: string
  email: string
  name: string
  phone: string | null
  // NOTE: the unit asked for WhatsApp consent. Only the person can give it,
  // on their own account.
  consentRequested: boolean
  active: boolean
  addedAt: number
}>

export type ReviewerEntryInput = Readonly<{
  displayName: string
  phone: string | null
  consentRequested: boolean
}>

export type StoreCaseFileRecord = Readonly<{
  id: string
  unitId: string
  reference: string
  title: string
  createdAt: number
  updatedAt: number
}>

export type ReportRecord = Readonly<{
  id: string
  caseFile: StoreCaseFileRecord
  templateId: string
  templateVersion: number
  state: ReportState
  deadlineAt: number | null
  deadlineZone: string | null
  createdBy: string
  createdAt: number
  updatedAt: number
  latestDraft: number
  latestRevision: number | null
}>

// NOTE: what the notification pass reads of a report (stage 7), in one round
// trip. It is the same data as `getReport`, `listMembers`, `listRounds`,
// `listReviews` and `listRevisions`, trimmed: no person's name is read (`name`
// is empty in the members and participants), and `latestDraft` and
// `latestRevision` come from the published revisions (the drafts are not
// read), which is all the rules of a round look at. `template` is the report's
// template version cut down to its roles and whether it has a conclusion.
export type ReportBundle = Readonly<{
  record: ReportRecord
  template: Readonly<{
    state: 'draft' | 'published' | 'retired'
    // NOTE: the `roles` array of the definition, as JSON.
    roles: string
    hasConclusion: boolean
  }> | null
  members: ReadonlyArray<MemberRecord>
  rounds: ReadonlyArray<RoundWithParticipants>
  reviews: ReadonlyArray<StoreReviewRecord>
  revisions: ReadonlyArray<RevisionRecord>
}>

export type MemberRecord = Readonly<{
  userId: string
  name: string
  roleId: string
  addedAt: number
}>

export type WorkingCopyRecord = Readonly<{
  reportId: string
  userId: string
  baseDraft: number
  saveCounter: number
  // NOTE: the save counter at the last share (or replace) of this working
  // copy, so "unshared changes" is exactly `saveCounter > sharedCounter`.
  sharedCounter: number
  people: string
  startedAt: number
  lastSavedAt: number
}>

export type SectionOutline = Readonly<{
  sectionId: string
  ordinal: number
  bytes: number
  // NOTE: working copies: the counter at which the section was written.
  // Drafts: the hash of the redacted text.
  version: number | string
}>

export type DraftingRecord = Readonly<{
  userId: string
  name: string
  baseDraft: number
  lastSavedAt: number
  // NOTE: the working copy has saves that were never shared.
  unshared: boolean
}>

export type DraftRecord = Readonly<{
  reportId: string
  number: number
  baseNumber: number | null
  authorId: string | null
  authorName: string | null
  sharedAt: number
  shareId: string
  people: string
  caseTitleRedacted: string
  // NOTE: the case reference as a redacted reader sees it (empty for a draft
  // made before the twin was stored).
  caseReferenceRedacted: string
  redactionConfirmedAt: number | null
  revisions: ReadonlyArray<number>
}>

export type DraftView = 'original' | 'redacted'

export type RevisionRecord = Readonly<{
  reportId: string
  number: number
  draftNumber: number
  closing: boolean
  publishedBy: string
  publishedAt: number
}>

export type RoundState = 'open' | 'superseded' | 'decided'

export type RoundRecord = Readonly<{
  id: string
  reportId: string
  revision: number
  closing: boolean
  deadlineAt: number
  deadlineZone: string
  state: RoundState
  decidedBy: 'rule_met' | 'deadline' | null
  decidedAt: number | null
  createdAt: number
}>

export type ParticipantRecord = Readonly<{
  roundId: string
  userId: string
  name: string
  roleId: string
  addedAt: number
  removedAt: number | null
  removedBy: string | null
}>

export type RoundWithParticipants = Readonly<{
  round: RoundRecord
  participants: ReadonlyArray<ParticipantRecord>
}>

export type ParticipationRecord = Readonly<{
  round: RoundRecord
  roleId: string
  removedAt: number | null
  draftNumber: number
}>

export type AssignmentRecord = Readonly<{
  reportId: string
  revision: number
  roundId: string
  roleId: string
  removedAt: number | null
  roundState: RoundState
  deadlineAt: number
  closing: boolean
}>

export type StoreReviewRecord = Readonly<{
  id: string
  roundId: string
  revision: number
  reviewerId: string
  decision: ReviewDecision
  hasComments: boolean
  sentAt: number
}>

export type StoreCommentVisibility = 'authors' | 'committee'

export type StoreCommentRecord = Readonly<{
  id: string
  reportId: string
  targetKind: 'draft' | 'revision'
  targetNumber: number
  roundId: string | null
  sectionId: string
  itemId: string | null
  rangeFrom: number | null
  rangeTo: number | null
  quoted: string | null
  body: string
  redactedBody: string | null
  authorId: string
  authorName: string
  visibility: StoreCommentVisibility
  resolved: boolean
  // NOTE: `null` while the reviewer's review is pending.
  reviewId: string | null
  createdAt: number
}>

export type ReplyRecord = Readonly<{
  id: string
  commentId: string
  authorId: string
  authorName: string
  body: string
  redactedBody: string | null
  createdAt: number
}>

export type CommentInput = Readonly<{
  id: string
  sectionId: string
  itemId: string | null
  rangeFrom: number | null
  rangeTo: number | null
  quoted: string | null
  body: string
  redactedBody: string | null
  visibility: StoreCommentVisibility
  now: number
}>

export type CommentAudience =
  | Readonly<{ kind: 'authors' }>
  | Readonly<{ kind: 'reviewer'; userId: string }>

export type JobState = 'pending' | 'claimed' | 'done' | 'skipped' | 'failed'

export type JobRecord = Readonly<{
  id: number
  key: string
  reportId: string
  roundId: string | null
  recipientId: string | null
  kind: NotificationJob['kind']
  revision: number
  dueAt: number
  deadline: number | null
  subject: string | null
  channel: 'inbox' | 'whatsapp'
  state: JobState
  claimedBy: string | null
  leaseUntil: number | null
  // NOTE: real failures of the channel only. A pass that stopped halfway, or a
  // storage error, is counted in `deferrals`, never here.
  attempts: number
  deferrals: number
  // NOTE: the time zone of the round's deadline, read with the inbox only.
  deadlineZone: string | null
  providerMessageId: string | null
  deliveryStatus: string | null
  // NOTE: set on a failed job that may be tried again: it is claimable from
  // this time. A failed job with no retry time is final.
  retryAt: number | null
  lastError: string | null
  createdAt: number
  doneAt: number | null
  readAt: number | null
}>

export type AuditFilter = Readonly<{
  reportId?: string
  templateId?: string
  // NOTE: `theme.` for the theme's log.
  actionPrefix?: string
  // NOTE: only events older than this ID (paging, newest first).
  before?: number
  limit: number
}>

export type ReviewerRoundRecord = Readonly<{
  reportId: string
  revision: number
  roundId: string
  closing: boolean
  roundState: RoundState
  deadlineAt: number
  deadlineZone: string
  caseReference: string
  // NOTE: the reference as the draft of the revision stored it for redacted
  // readers; a role with the `full` view reads `caseReference`.
  caseReferenceRedacted: string
  templateId: string
  templateVersion: number
  publishedAt: number
  roleId: string
  // NOTE: the standing decision (latest approve or request changes sent).
  decision: ReviewDecision | null
  pendingDecision: ReviewDecision | null
  pendingComments: number
}>

export type StoreEventKind =
  | 'draft_read'
  | 'read'
  | 'whatsapp_opened'
  | 'notified'
  | 'reminded'

export type EventInput = Readonly<{
  reportId: string
  kind: StoreEventKind
  accountId: string
  draftNumber?: number
  revisionNumber?: number
  detail?: string
  at: number
}>

export type EventRecord = Readonly<{
  id: number
  reportId: string
  kind: StoreEventKind
  accountId: string
  draftNumber: number | null
  revisionNumber: number | null
  detail: string | null
  at: number
}>

export type ImageOwnerRef =
  | Readonly<{ kind: 'report'; reportId: string }>
  | Readonly<{ kind: 'theme' }>

export type ImageRecord = Readonly<{
  id: string
  owner: ImageOwnerRef
  uploadedBy: string
  mime: 'image/jpeg' | 'image/png'
  width: number
  height: number
  size: number
  hash: string
  chunkCount: number
  chunksReceived: number
  complete: boolean
  createdAt: number
  // NOTE: true once any shared draft references it (D5).
  referenced: boolean
}>

export type ImageChunkInput = Readonly<{
  imageId: string
  owner: ImageOwnerRef
  uploadedBy: string
  mime: 'image/jpeg' | 'image/png'
  width: number
  height: number
  // NOTE: the whole image, in bytes, over all chunks.
  size: number
  hash: string
  chunkCount: number
  index: number
  // NOTE: the base64 text of the chunk, made with the native `toBase64`.
  data: string
  now: number
}>

// ---- Operation inputs and outcomes -----------------------------------------------------------

export type StagedSectionInput = Readonly<{
  shareId: string
  reportId: string
  userId: string
  sectionId: string
  // NOTE: the section's `save_counter` the handler read before redacting it;
  // staging is refused if the section changed since.
  sectionVersion: number
  redactedContent: string
  redactedHash: string
  // NOTE: the people list the section was redacted with (the working copy's
  // `people` text) and its hash. The whole share uses one: staging is refused
  // when the working copy's people changed since, or when another section of
  // this share was staged with a different one.
  people: string
  peopleHash: string
  // NOTE: JSON `[{ "id": "...", "safe": true }]` of the section's images.
  imageRefs: string
  now: number
}>

export type JobInput = Readonly<{
  roundId: string | null
  job: NotificationJob
  now: number
}>

export type ParticipantInput = Readonly<{ userId: string; roleId: string }>

export type PublishInput = Readonly<{
  // NOTE: for `finishShare` the draft is the one being shared and `draft` is
  // ignored.
  draft?: number
  closing: boolean
  revision: number
  roundId: string
  deadlineAt: number
  deadlineZone: string
  participants: ReadonlyArray<ParticipantInput>
  // NOTE: states the report may be in (from the D18 table, by the handler).
  fromStates: ReadonlyArray<ReportState>
  toState: ReportState
  jobs: ReadonlyArray<NotificationJob>
  publishedBy: string
  // NOTE: set when a participant has a `redacted` view (D14). The batch then
  // refuses to publish unless a redaction confirmation exists for the draft
  // being published, so the check and the publish are one atomic step.
  requiresConfirmation?: boolean
  now: number
  audit: AuditInput
}>

export type PublishRefusal =
  | 'not_latest'
  | 'wrong_state'
  | 'revision_number'
  | 'participant_is_author'
  | 'not_confirmed'

export type PublishOutcome =
  | Readonly<{ _tag: 'Published'; revision: number; roundId: string }>
  | Refused<PublishRefusal>

export type FinishShareInput = Readonly<{
  shareId: string
  reportId: string
  userId: string
  // NOTE: the number the new draft is based on; it must still be the latest.
  baseDraft: number
  expectedSections: number
  redactedCaseTitle: string
  redactedCaseReference: string
  // NOTE: the case file as the share was read and confirmed: the batch is
  // refused (`case_changed`) unless the case file still has this title and
  // reference, so the redacted twins stored are those of the preview.
  caseGuard: Readonly<{ title: string; reference: string }>
  // NOTE: the working copy's `people` text the staged sections were redacted
  // with and its hash: refused unless the working copy still has exactly that
  // text and every staged section of this share was redacted with it.
  people: string
  peopleHash: string
  now: number
  audit: AuditInput
  // NOTE: the author confirmed the redaction preview of this content (D14).
  // `joinedHashes` is the redacted hashes of the staged sections in order,
  // joined with commas, exactly as the handler read them; the batch records
  // the confirmation for the new draft only while the staged content still
  // gives that string, and refuses everything otherwise.
  confirmation?: Readonly<{
    joinedHashes: string
    confirmedBy: string
    audit: AuditInput
  }>
  // NOTE: "share and publish": the same batch also publishes the new draft.
  publish?: PublishInput
}>

export type FinishShareOutcome =
  | Readonly<{
      _tag: 'Shared'
      number: number
      revision: number | null
    }>
  | Readonly<{ _tag: 'AlreadyShared'; number: number }>
  | Readonly<{ _tag: 'Refused'; reason: 'stale_base'; latest: number }>
  | Refused<
      'share_incomplete' | 'no_working_copy' | 'people_changed' | 'case_changed' | PublishRefusal
    >

export type StagedSectionRecord = Readonly<{
  sectionId: string
  ordinal: number
  redactedHash: string
  peopleHash: string
}>

export type SaveWorkingCopyInput = Readonly<{
  reportId: string
  userId: string
  // NOTE: the counter the client last saw; a stale save is refused.
  expectedCounter: number
  sections: ReadonlyArray<
    Readonly<{ sectionId: string; ordinal: number; content: string }>
  >
  people?: string
  now: number
}>

export type SaveOutcome =
  | Readonly<{ _tag: 'Saved'; saveCounter: number }>
  | Refused<'stale_save'>

// NOTE: a section with its stored text, for the reads that need a whole
// document in one query (merging, closing checks). `version` is the save
// counter for working copies and the redacted hash for drafts.
export type SectionContentRow = Readonly<{
  sectionId: string
  ordinal: number
  content: string
  version: number | string
}>

// NOTE: moves a working copy to a new base draft with merged content (the
// resolution of a stale share). Guarded on the save counter. Sections not in
// the list are removed from the copy: it is the author's own private copy.
export type RebaseWorkingCopyInput = Readonly<{
  reportId: string
  userId: string
  expectedCounter: number
  baseDraft: number
  sections: ReadonlyArray<
    Readonly<{ sectionId: string; ordinal: number; content: string }>
  >
  people: string
  // NOTE: the rebased copy has no unshared changes (the content is the shared
  // draft's, as when a working copy is replaced): `sharedCounter` follows the
  // new save counter.
  markShared?: boolean
  now: number
}>

export type CreateReportInput = Readonly<{
  caseFile:
    | Readonly<{ kind: 'new'; id: string; reference: string; title: string }>
    | Readonly<{ kind: 'existing'; id: string }>
  unitId: string
  reportId: string
  templateId: string
  templateVersion: number
  createdBy: string
  draftingRoleId: string
  now: number
  audit: AuditInput
}>

export type CreateAccountInput = Readonly<{
  id: string
  email: string
  name: string
  passwordHash: string
  profile: ProfileInput
  grant?: Readonly<{ capability: StoreCapabilityName; unitId?: string }>
  reviewerOfUnit?: string
  // NOTE: the registry entry for `reviewerOfUnit` (the name and number typed by
  // the unit); by default the account's name, no number, no consent request.
  reviewerEntry?: ReviewerEntryInput
  invitation?: InvitationInput
  createdBy: string | null
  now: number
  audit?: AuditInput
}>

export type ConsumeOutcome =
  | Readonly<{
      _tag: 'Consumed'
      userId: string
      purpose: InvitationPurpose
    }>
  | Refused<'invalid'>

export type SignInSummary = Readonly<{
  failuresByEmail: number
  lastFailureByEmail: number | null
  failuresByIp: number
  lastFailureByIp: number | null
}>

export type PutChunkRefusal =
  | 'bad_chunk'
  | 'mismatch'
  | 'duplicate'
  | 'database_full'
  | 'report_limit'

export type PutChunkOutcome =
  | Readonly<{
      _tag: 'Stored'
      received: number
      complete: boolean
      image: ImageRecord | null
    }>
  | Refused<PutChunkRefusal>

export type ImageStats = Readonly<{
  databaseBytes: number
  databaseLimitBytes: number
  reportBytes: number
  reportLimitBytes: number
}>

// NOTE: deciding a round is guarded on what the decision was made from: the
// round is open with the deadline the handler read (an extension in between
// makes it a refusal, and the handler reads again), and for `deadline` the
// deadline has passed; for `rule_met` the people and the reviews are still the
// ones the rule was met with.
export type DecideRoundInput = Readonly<{
  roundId: string
  reportId: string
  decidedBy: 'rule_met' | 'deadline'
  toState: ReportState
  jobs: ReadonlyArray<NotificationJob>
  expectedDeadlineAt: number
  expectedReviews: number
  expectedParticipants: number
  now: number
  audit: AuditInput
}>

export type DecideOutcome =
  | Readonly<{ _tag: 'Decided' }>
  | Refused<'not_open' | 'changed'>

// ---- The service --------------------------------------------------------------------------------

export interface ReportRepositoryApi {
  // -- units, accounts, grants, links (stage 3 builds screens on these)
  readonly createUnit: (
    unit: UnitRecord,
  ) => Eff<Readonly<{ _tag: 'Created' }> | Refused<'duplicate'>>
  readonly listUnits: () => Eff<ReadonlyArray<UnitRecord>>
  readonly updateUnit: (
    id: string,
    name: string,
    now: number,
  ) => Eff<UnitRecord | null>
  readonly grantCapability: (
    grant: GrantRecord,
  ) => Eff<'granted' | 'exists' | 'no_unit'>
  readonly revokeCapability: (
    userId: string,
    capability: StoreCapabilityName,
    unitId: string | null,
  ) => Eff<boolean>
  readonly listGrants: (userId?: string) => Eff<ReadonlyArray<GrantRecord>>
  readonly listAccounts: () => Eff<ReadonlyArray<AccountRecord>>
  readonly getAccount: (userId: string) => Eff<AccountRecord | null>
  // NOTE: only the accounts asked for, one query.
  readonly listAccountsByIds: (
    userIds: ReadonlyArray<string>,
  ) => Eff<ReadonlyArray<AccountRecord>>
  readonly findAccountByEmail: (email: string) => Eff<AccountRecord | null>
  readonly updateAccountName: (userId: string, name: string) => Eff<boolean>
  readonly createAccount: (
    input: CreateAccountInput,
  ) => Eff<Readonly<{ _tag: 'Created' }> | Refused<'email_taken' | 'no_unit'>>
  readonly getProfile: (userId: string) => Eff<AccountProfile | null>
  readonly putProfile: (
    userId: string,
    profile: ProfileInput,
    now: number,
  ) => Eff<void>
  // NOTE: links an account into a unit's registry with the unit's own name and
  // number for it. An entry that exists is left as it is (`exists`); the
  // account is never read or changed.
  readonly linkReviewer: (
    unitId: string,
    userId: string,
    addedBy: string | null,
    now: number,
    audit: AuditInput,
    entry: ReviewerEntryInput,
  ) => Eff<'linked' | 'exists' | 'no_unit'>
  readonly listUnitReviewers: (
    unitId: string,
  ) => Eff<ReadonlyArray<UnitReviewerRecord>>
  readonly updateUnitReviewer: (
    input: Readonly<{
      unitId: string
      userId: string
      displayName?: string
      phone?: string | null
      consentRequested?: boolean
      audit: AuditInput
    }>,
  ) => Eff<'updated' | 'not_found'>
  // NOTE: the accounts holding the author capability in a unit, in one query.
  readonly listUnitAuthors: (
    unitId: string,
  ) => Eff<ReadonlyArray<AccountRecord>>
  // NOTE: the profiles of the given accounts, in one query.
  readonly listProfiles: (
    userIds: ReadonlyArray<string>,
  ) => Eff<ReadonlyArray<AccountProfile>>
  readonly createInvitation: (
    invitation: InvitationInput,
    audit: AuditInput,
  ) => Eff<void>
  readonly findInvitation: (tokenHash: string) => Eff<InvitationRecord | null>
  readonly consumeInvitation: (
    tokenHash: string,
    passwordHash: string,
    now: number,
    audit: AuditInput,
  ) => Eff<ConsumeOutcome>
  readonly recordSignInAttempt: (
    email: string,
    ip: string,
    at: number,
    succeeded: boolean,
  ) => Eff<void>
  readonly signInSummary: (
    email: string,
    ip: string,
    since: number,
  ) => Eff<SignInSummary>
  readonly deleteSessionsOfUser: (userId: string) => Eff<void>
  // NOTE: removes sign-in attempts older than `before`, at most `limit` rows.
  readonly pruneSignInAttempts: (
    before: number,
    limit: number,
  ) => Eff<number>
  readonly getTheme: () => Eff<StoreThemeRecord | null>
  readonly putTheme: (theme: StoreThemeRecord, audit: AuditInput) => Eff<void>

  // -- templates: versions are immutable once published
  readonly importBuiltInTemplates: (
    templates: ReadonlyArray<BuiltInTemplateInput>,
    now: number,
  ) => Eff<number>
  readonly getTemplateVersion: (
    templateId: string,
    version: number,
  ) => Eff<StoreTemplateVersionRecord | null>
  // NOTE: several versions in one query (at most `MAX_TEMPLATES_PER_LOOKUP`).
  readonly getTemplateVersions: (
    keys: ReadonlyArray<Readonly<{ templateId: string; version: number }>>,
  ) => Eff<ReadonlyArray<StoreTemplateVersionRecord>>
  readonly listTemplates: () => Eff<ReadonlyArray<StoreTemplateSummary>>
  readonly createTemplateDraft: (
    input: Readonly<{
      templateId: string
      version: number
      name: string
      shortName: string
      definition: string
      createdBy: string
      now: number
      audit: AuditInput
    }>,
  ) => Eff<
    Readonly<{ _tag: 'Created' }> | Refused<'draft_exists' | 'wrong_version'>
  >
  readonly saveTemplateDraft: (
    input: Readonly<{
      templateId: string
      version: number
      name: string
      shortName: string
      definition: string
      expectedRevision: number
    }>,
  ) => Eff<Readonly<{ _tag: 'Saved' }> | Refused<'not_a_draft' | 'stale'>>
  readonly publishTemplateVersion: (
    input: Readonly<{
      templateId: string
      version: number
      changes: string
      publishedBy: string
      now: number
      expectedRevision: number
      audit: AuditInput
    }>,
  ) => Eff<
    Readonly<{ _tag: 'Published' }> | Refused<'not_a_draft' | 'stale' | 'retired'>
  >
  readonly retireTemplate: (
    templateId: string,
    now: number,
    audit: AuditInput,
  ) => Eff<Readonly<{ _tag: 'Retired' }> | Refused<'not_published'>>
  // NOTE: the newest retired version becomes published again; only while the
  // template has no published version.
  readonly restoreTemplate: (
    templateId: string,
    audit: AuditInput,
  ) => Eff<Readonly<{ _tag: 'Restored' }> | Refused<'not_retired'>>
  // NOTE: deletes a draft (never a published or retired version).
  readonly discardTemplateDraft: (
    templateId: string,
    version: number,
    audit: AuditInput,
  ) => Eff<Readonly<{ _tag: 'Discarded' }> | Refused<'not_a_draft'>>

  // -- committees and case files
  readonly createCommittee: (
    input: Readonly<{
      id: string
      unitId: string
      name: string
      memberIds: ReadonlyArray<string>
      createdBy: string
      now: number
      audit: AuditInput
    }>,
  ) => Eff<Readonly<{ _tag: 'Created' }> | Refused<'duplicate' | 'no_unit'>>
  readonly updateCommittee: (
    input: Readonly<{
      id: string
      name?: string
      archived?: boolean
      memberIds?: ReadonlyArray<string>
      // NOTE: applied on the stored list, in one batch, removals first.
      addMemberIds?: ReadonlyArray<string>
      removeMemberIds?: ReadonlyArray<string>
      now: number
      audit: AuditInput
    }>,
  ) => Eff<boolean>
  readonly listCommittees: (
    unitId: string,
  ) => Eff<ReadonlyArray<StoreCommitteeRecord>>
  readonly getCommittee: (id: string) => Eff<StoreCommitteeRecord | null>
  readonly listCaseFiles: (
    unitId: string,
  ) => Eff<ReadonlyArray<StoreCaseFileRecord>>
  readonly updateCaseFile: (
    id: string,
    patch: Readonly<{ reference?: string; title?: string }>,
    now: number,
  ) => Eff<StoreCaseFileRecord | null | Refused<'duplicate'>>
  // NOTE: changes the title of a case file, but only if `userId` is a member
  // of at least one report on it (guarded in the batch). Every report of the
  // case file gets the audit event, so each log shows the change.
  readonly retitleCaseFile: (
    input: Readonly<{
      caseFileId: string
      title: string
      userId: string
      now: number
      audit: Omit<AuditInput, 'reportId'>
    }>,
  ) => Eff<
    | Readonly<{
        _tag: 'Updated'
        caseFile: StoreCaseFileRecord
        reportIds: ReadonlyArray<string>
      }>
    | Refused<'not_found'>
  >

  // -- reports and members
  readonly createReport: (
    input: CreateReportInput,
  ) => Eff<
    | Readonly<{ _tag: 'Created' }>
    | Refused<'duplicate_reference' | 'no_case_file'>
  >
  readonly getReport: (reportId: string) => Eff<ReportRecord | null>
  // NOTE: one batch of seven statements, for the
  // notification pass. See `ReportBundle`.
  readonly readReport: (
    reportId: string,
    options: Readonly<{ template: boolean }>,
  ) => Eff<ReportBundle | null>
  readonly listReportsForMember: (
    userId: string,
  ) => Eff<ReadonlyArray<ReportRecord>>
  readonly listMembers: (reportId: string) => Eff<ReadonlyArray<MemberRecord>>
  readonly getMembership: (
    reportId: string,
    userId: string,
  ) => Eff<Readonly<{ roleId: string }> | null>
  readonly addMember: (
    input: Readonly<{
      reportId: string
      userId: string
      roleId: string
      addedBy: string
      now: number
      audit: AuditInput
    }>,
  ) => Eff<
    | Readonly<{ _tag: 'Added' }>
    | Refused<'already_member' | 'reviewer_in_open_round' | 'archived'>
  >
  readonly moveReport: (
    input: Readonly<{
      reportId: string
      from: ReportState
      to: ReportState
      now: number
      audit: AuditInput
    }>,
  ) => Eff<Readonly<{ _tag: 'Moved' }> | Refused<'wrong_state'>>

  // -- private working copies
  readonly startWorkingCopy: (
    input: Readonly<{
      reportId: string
      userId: string
      fromDraft: number
      now: number
    }>,
  ) => Eff<WorkingCopyRecord | null>
  readonly getWorkingCopy: (
    reportId: string,
    userId: string,
  ) => Eff<WorkingCopyRecord | null>
  readonly listWorkingCopySections: (
    reportId: string,
    userId: string,
  ) => Eff<ReadonlyArray<SectionOutline>>
  readonly getWorkingCopySection: (
    reportId: string,
    userId: string,
    sectionId: string,
  ) => Eff<Readonly<{ content: string; version: number }> | null>
  readonly saveWorkingCopy: (input: SaveWorkingCopyInput) => Eff<SaveOutcome>
  readonly getWorkingCopyContents: (
    reportId: string,
    userId: string,
  ) => Eff<ReadonlyArray<SectionContentRow>>
  readonly rebaseWorkingCopy: (
    input: RebaseWorkingCopyInput,
  ) => Eff<SaveOutcome | Refused<'no_draft'>>
  readonly listDrafting: (
    reportId: string,
  ) => Eff<ReadonlyArray<DraftingRecord>>

  // -- sharing: ShareSection per section, then FinishShare
  readonly stageShareSection: (
    input: StagedSectionInput,
  ) => Eff<Readonly<{ _tag: 'Staged' }> | Refused<'changed'>>
  readonly finishShare: (input: FinishShareInput) => Eff<FinishShareOutcome>
  readonly listStagedSections: (
    shareId: string,
    reportId: string,
    userId: string,
  ) => Eff<ReadonlyArray<StagedSectionRecord>>

  // -- drafts and revisions (immutable)
  readonly getDraft: (
    reportId: string,
    number: number,
  ) => Eff<DraftRecord | null>
  readonly listDrafts: (reportId: string) => Eff<ReadonlyArray<DraftRecord>>
  readonly listDraftSections: (
    reportId: string,
    number: number,
  ) => Eff<ReadonlyArray<SectionOutline>>
  readonly getDraftSection: (
    reportId: string,
    number: number,
    sectionId: string,
    view: DraftView,
  ) => Eff<string | null>
  readonly getDraftContents: (
    reportId: string,
    number: number,
    view: DraftView,
  ) => Eff<ReadonlyArray<SectionContentRow>>
  // NOTE: per draft, the redacted hashes of its sections joined in order, so
  // the history can show a hash per draft in one query.
  readonly listRedactedHashes: (
    reportId: string,
  ) => Eff<ReadonlyArray<Readonly<{ draftNumber: number; hash: string }>>>
  readonly confirmRedaction: (
    input: Readonly<{
      reportId: string
      draftNumber: number
      confirmedBy: string
      now: number
      audit: AuditInput
    }>,
  ) => Eff<boolean>
  readonly getRevision: (
    reportId: string,
    number: number,
  ) => Eff<RevisionRecord | null>
  readonly listRevisions: (
    reportId: string,
  ) => Eff<ReadonlyArray<RevisionRecord>>
  readonly getRevisionSection: (
    reportId: string,
    revision: number,
    sectionId: string,
    view: DraftView,
  ) => Eff<string | null>
  readonly listRevisionSections: (
    reportId: string,
    revision: number,
  ) => Eff<ReadonlyArray<SectionOutline>>

  // -- publishing and rounds
  readonly publishRevision: (
    input: PublishInput & Readonly<{ reportId: string }>,
  ) => Eff<PublishOutcome>
  readonly getRound: (
    reportId: string,
    revision: number,
  ) => Eff<RoundWithParticipants | null>
  readonly getOpenRound: (reportId: string) => Eff<RoundWithParticipants | null>
  readonly listRounds: (
    reportId: string,
  ) => Eff<ReadonlyArray<RoundWithParticipants>>
  readonly getParticipation: (
    reportId: string,
    revision: number,
    userId: string,
  ) => Eff<ParticipationRecord | null>
  readonly listAssignments: (
    userId: string,
  ) => Eff<ReadonlyArray<AssignmentRecord>>
  // NOTE: one line per round the user takes part in (not removed), newest
  // deadline first, with what the inbox shows, in one query.
  readonly listReviewerRounds: (
    userId: string,
    options: Readonly<{
      offset: number
      limit: number
      openOnly: boolean
      pendingOnly: boolean
    }>,
  ) => Eff<ReadonlyArray<ReviewerRoundRecord>>
  readonly decideRound: (input: DecideRoundInput) => Eff<DecideOutcome>
  readonly extendDeadline: (
    input: Readonly<{
      roundId: string
      reportId: string
      deadlineAt: number
      deadlineZone: string
      jobs: ReadonlyArray<NotificationJob>
      now: number
      audit: AuditInput
    }>,
  ) => Eff<Readonly<{ _tag: 'Extended' }> | Refused<'not_open' | 'not_later'>>
  readonly removeParticipant: (
    input: Readonly<{
      roundId: string
      reportId: string
      userId: string
      removedBy: string
      // NOTE: the notification jobs the removal brings (the removed reviewer
      // is told), written in the same batch; existing keys are ignored.
      jobs?: ReadonlyArray<NotificationJob>
      now: number
      audit: AuditInput
      // NOTE: when the removal makes the rule met, the same batch decides the
      // round (`DecideRoundInput` without the round, the report and the time).
      decide?: Omit<DecideRoundInput, 'roundId' | 'reportId' | 'now'>
    }>,
  ) => Eff<
    | Readonly<{ _tag: 'Removed' }>
    | Refused<'not_open' | 'not_a_participant' | 'changed'>
  >

  // -- reviews and comments
  readonly savePendingReview: (
    input: Readonly<{
      roundId: string
      reviewerId: string
      decision: ReviewDecision | null
      now: number
    }>,
  ) => Eff<Readonly<{ _tag: 'Saved' }> | Refused<'not_open'>>
  readonly getPendingReview: (
    roundId: string,
    reviewerId: string,
  ) => Eff<
    Readonly<{
      decision: ReviewDecision | null
      comments: ReadonlyArray<StoreCommentRecord>
    }>
  >
  readonly addPendingComment: (
    input: CommentInput &
      Readonly<{ roundId: string; reviewerId: string; revision: number }>,
  ) => Eff<Readonly<{ _tag: 'Added' }> | Refused<'not_open'>>
  readonly updatePendingComment: (
    input: Readonly<{
      id: string
      reviewerId: string
      body: string
      // NOTE: the redacted twin of the new body (a `full` reviewer's comment),
      // kept in step with it.
      redactedBody?: string | null
      visibility: StoreCommentVisibility
    }>,
  ) => Eff<boolean>
  readonly getComment: (
    reportId: string,
    commentId: string,
  ) => Eff<StoreCommentRecord | null>
  readonly deletePendingComment: (
    id: string,
    reviewerId: string,
  ) => Eff<boolean>
  readonly sendReview: (
    input: Readonly<{
      reviewId: string
      roundId: string
      reportId: string
      reviewerId: string
      decision: ReviewDecision
      jobs: ReadonlyArray<NotificationJob>
      now: number
      audit: AuditInput
    }>,
  ) => Eff<
    Readonly<{ _tag: 'Sent'; hasComments: boolean }> | Refused<'not_open'>
  >
  readonly listReviews: (
    reportId: string,
  ) => Eff<ReadonlyArray<StoreReviewRecord>>
  readonly addDraftComment: (
    input: CommentInput &
      Readonly<{ reportId: string; draftNumber: number; authorId: string }>,
  ) => Eff<Readonly<{ _tag: 'Added' }> | Refused<'not_found'>>
  readonly addReply: (
    input: Readonly<{
      id: string
      commentId: string
      authorId: string
      body: string
      redactedBody: string | null
      now: number
    }>,
  ) => Eff<boolean>
  readonly setCommentResolved: (
    commentId: string,
    resolved: boolean,
  ) => Eff<boolean>
  readonly listComments: (
    input: Readonly<{
      reportId: string
      kind: 'draft' | 'revision'
      number: number
      audience: CommentAudience
    }>,
  ) => Eff<
    Readonly<{
      comments: ReadonlyArray<StoreCommentRecord>
      replies: ReadonlyArray<ReplyRecord>
    }>
  >

  // -- notification jobs, inbox, events, audit
  // NOTE: the state machine of a job (stage 7):
  //   pending -> claimed (lease) -> done | skipped | failed
  //   claimed -> claimed        when the lease has run out (a pass stopped halfway;
  //                             counts a deferral, not an attempt)
  //   failed (retry time) -> claimed when the retry time has come
  //   claimed -> pending        released unprocessed (`released`)
  // A claim is one `UPDATE ... RETURNING`, so two passes never get the same
  // job. `reportIds` limits the claim to those reports.
  readonly claimDueJobs: (
    input: Readonly<{
      now: number
      limit: number
      leaseMs: number
      claimedBy: string
      reportIds?: ReadonlyArray<string>
    }>,
  ) => Eff<ReadonlyArray<JobRecord>>
  // NOTE: one atomic batch. Only jobs still claimed by `claimedBy` change, so a
  // pass whose lease ran out and was taken over cannot overwrite the new owner.
  // A job that becomes `done` records who was told (`notified` for a review
  // request, `reminded` for a reminder) for the grid, in the same batch.
  readonly finishJobs: (
    input: Readonly<{
      claimedBy: string
      done: ReadonlyArray<number>
      skipped: ReadonlyArray<number>
      // NOTE: the provider's message ID and delivery status, for jobs sent
      // through a channel outside the app.
      delivered?: ReadonlyArray<
        Readonly<{
          id: number
          providerMessageId: string | null
          deliveryStatus: string | null
        }>
      >
      // NOTE: a failure of the channel: counts an attempt. `retryAt: null` is
      // a final failure.
      failed?: ReadonlyArray<
        Readonly<{ id: number; retryAt: number | null; error: string }>
      >
      // NOTE: not the job's fault (storage was unavailable): tried again at
      // `retryAt`, counted in `deferrals` and not in `attempts`.
      deferred?: ReadonlyArray<
        Readonly<{ id: number; retryAt: number; error: string }>
      >
      released?: ReadonlyArray<number>
      now: number
    }>,
  ) => Eff<void>
  readonly listJobKeys: (reportId: string) => Eff<ReadonlyArray<string>>
  readonly listInbox: (
    userId: string,
    limit: number,
    // NOTE: only notifications due before this time (paging).
    before?: number,
  ) => Eff<ReadonlyArray<JobRecord>>
  readonly countUnread: (userId: string) => Eff<number>
  readonly markInboxRead: (
    userId: string,
    ids: ReadonlyArray<number>,
    now: number,
  ) => Eff<number>
  readonly recordEvent: (event: EventInput) => Eff<void>
  // NOTE: bounded: the newest `limit` events, oldest first.
  readonly listEvents: (
    reportId: string,
    limit: number,
  ) => Eff<ReadonlyArray<EventRecord>>
  readonly appendAudit: (audit: AuditInput) => Eff<void>
  readonly listAudit: (filter: AuditFilter) => Eff<ReadonlyArray<AuditRecord>>

  // -- images (ImageStore, D5): chunks of base64 text
  // NOTE: a chunk that is already stored with identical content is accepted
  // again with the same result (a retried upload); different content for the
  // same chunk is still `duplicate`.
  readonly putImageChunk: (input: ImageChunkInput) => Eff<PutChunkOutcome>
  readonly getImage: (imageId: string) => Eff<ImageRecord | null>
  readonly readImageChunk: (
    imageId: string,
    index: number,
  ) => Eff<string | null>
  readonly readDraftImageChunk: (
    input: Readonly<{
      reportId: string
      draftNumber: number
      imageId: string
      index: number
      safeOnly: boolean
    }>,
  ) => Eff<string | null>
  readonly readRevisionImageChunk: (
    input: Readonly<{
      reportId: string
      revision: number
      imageId: string
      index: number
      safeOnly: boolean
    }>,
  ) => Eff<string | null>
  // NOTE: withdrawing an image takes effect at once: the image stops being
  // safe in the latest draft, which is the flag redacted readers of every
  // revision are checked against. A later share decides again.
  readonly withdrawImage: (
    reportId: string,
    imageId: string,
  ) => Eff<void>
  readonly listReportImages: (
    reportId: string,
  ) => Eff<ReadonlyArray<ImageRecord>>
  readonly imageStats: (reportId: string | null) => Eff<ImageStats>
  readonly deleteUnreferencedImage: (
    imageId: string,
  ) => Eff<Readonly<{ _tag: 'Deleted' }> | Refused<'referenced' | 'not_found'>>
  // NOTE: the bounded cleanup the notification pass calls: deletes images that
  // no draft references and that were created before `olderThan`, and staged
  // shares abandoned before `olderThan`, at most `limit` of each.
  readonly cleanup: (
    input: Readonly<{ olderThan: number; limit: number }>,
  ) => Eff<Readonly<{ images: number; staged: number }>>
}

export class ReportRepository extends Context.Service<
  ReportRepository,
  ReportRepositoryApi
>()('ReportRepository') {}

// ---- Query budget ------------------------------------------------------------------------------------

// NOTE: the most D1 queries one call of each operation may make, counting a
// guard as 2 and a refusal's diagnosis as 1. The SQL implementation checks
// the real count against this table in the contract suite; a test checks no
// entry is over `MAX_QUERIES_PER_REQUEST` and that every operation has one.
// Formulas for the variable ones: `importBuiltInTemplates` is 2 per template
// (at most 24); `saveWorkingCopy` is 2 + sections + (1 if people), with at
// most `MAX_SECTIONS_PER_SAVE` sections.
export const MAX_QUERIES_PER_REQUEST = 50
export const MAX_TEMPLATES_PER_IMPORT = 24
export const MAX_SECTIONS_PER_SAVE = 40
export const MAX_TEMPLATES_PER_LOOKUP = 100

export const QUERY_BUDGET: Record<keyof ReportRepositoryApi, number> = {
  createUnit: 1,
  listUnits: 1,
  updateUnit: 1,
  grantCapability: 2,
  revokeCapability: 1,
  listGrants: 1,
  listAccounts: 1,
  getAccount: 1,
  listAccountsByIds: 1,
  findAccountByEmail: 1,
  updateAccountName: 2,
  createAccount: 10,
  getProfile: 1,
  putProfile: 1,
  linkReviewer: 4,
  listUnitReviewers: 1,
  updateUnitReviewer: 4,
  listUnitAuthors: 1,
  listProfiles: 1,
  pruneSignInAttempts: 1,
  createInvitation: 2,
  findInvitation: 1,
  consumeInvitation: 8,
  recordSignInAttempt: 1,
  signInSummary: 1,
  deleteSessionsOfUser: 1,
  getTheme: 1,
  putTheme: 2,
  importBuiltInTemplates: 2 * MAX_TEMPLATES_PER_IMPORT,
  getTemplateVersion: 1,
  getTemplateVersions: 1,
  listTemplates: 1,
  createTemplateDraft: 5,
  saveTemplateDraft: 3,
  publishTemplateVersion: 5,
  retireTemplate: 3,
  restoreTemplate: 4,
  discardTemplateDraft: 5,
  createCommittee: 5,
  updateCommittee: 5,
  listCommittees: 2,
  getCommittee: 2,
  listCaseFiles: 1,
  updateCaseFile: 2,
  retitleCaseFile: 5,
  createReport: 9,
  getReport: 1,
  readReport: 7,
  listReportsForMember: 1,
  listMembers: 1,
  getMembership: 1,
  addMember: 4,
  moveReport: 3,
  startWorkingCopy: 5,
  getWorkingCopy: 1,
  listWorkingCopySections: 1,
  getWorkingCopySection: 1,
  saveWorkingCopy: 2 + MAX_SECTIONS_PER_SAVE + 1,
  getWorkingCopyContents: 1,
  rebaseWorkingCopy: 5,
  getDraftContents: 1,
  listRedactedHashes: 1,
  listDrafting: 1,
  stageShareSection: 2,
  finishShare: 22,
  listStagedSections: 1,
  getDraft: 1,
  listDrafts: 1,
  listDraftSections: 1,
  getDraftSection: 1,
  confirmRedaction: 3,
  getRevision: 1,
  listRevisions: 1,
  getRevisionSection: 1,
  listRevisionSections: 1,
  publishRevision: 12,
  getRound: 2,
  getOpenRound: 2,
  listRounds: 2,
  getParticipation: 1,
  listAssignments: 1,
  listReviewerRounds: 1,
  decideRound: 9,
  extendDeadline: 6,
  removeParticipant: 14,
  savePendingReview: 2,
  getPendingReview: 2,
  addPendingComment: 3,
  updatePendingComment: 2,
  getComment: 1,
  deletePendingComment: 1,
  sendReview: 7,
  listReviews: 1,
  addDraftComment: 2,
  addReply: 2,
  setCommentResolved: 1,
  listComments: 2,
  claimDueJobs: 1,
  finishJobs: 7,
  listJobKeys: 1,
  listInbox: 1,
  countUnread: 1,
  markInboxRead: 1,
  recordEvent: 1,
  listEvents: 1,
  appendAudit: 1,
  listAudit: 1,
  putImageChunk: 6,
  getImage: 1,
  readImageChunk: 1,
  readDraftImageChunk: 1,
  readRevisionImageChunk: 1,
  withdrawImage: 1,
  listReportImages: 1,
  imageStats: 2,
  deleteUnreferencedImage: 6,
  cleanup: 6,
}

// ---- Shared pure checks (both implementations call these) ---------------------------------------------

// NOTE: the decoded length of a base64 text, from its length and padding.
export const base64DecodedLength = (data: string): number => {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor((data.length * 3) / 4) - padding
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

// NOTE: a chunk is refused before any query when it cannot belong to its
// image: wrong index, wrong length for its position (every chunk but the last
// is exactly `IMAGE_CHUNK_BYTES`), or text that is not base64 (D3, D5).
export const imageChunkProblem = (input: ImageChunkInput): string | null => {
  const expectedChunks = Math.ceil(input.size / IMAGE_CHUNK_BYTES)
  if (
    !Number.isInteger(input.size) ||
    input.size < 1 ||
    input.size > IMAGE_MAX_BYTES
  ) {
    return 'size'
  }
  if (input.chunkCount !== expectedChunks) {
    return 'chunk count'
  }
  if (
    !Number.isInteger(input.index) ||
    input.index < 0 ||
    input.index >= input.chunkCount
  ) {
    return 'index'
  }
  if (
    input.width < 1 ||
    input.height < 1 ||
    input.width > IMAGE_MAX_SIDE ||
    input.height > IMAGE_MAX_SIDE
  ) {
    return 'dimensions'
  }
  if (input.data.length % 4 !== 0 || !BASE64.test(input.data)) {
    return 'encoding'
  }
  const expectedBytes =
    input.index < input.chunkCount - 1
      ? IMAGE_CHUNK_BYTES
      : input.size - IMAGE_CHUNK_BYTES * (input.chunkCount - 1)
  return base64DecodedLength(input.data) === expectedBytes ? null : 'length'
}

export const IMAGE_LIMITS = {
  databaseBytes: DATABASE_LIMIT_BYTES,
  reportBytes: IMAGE_REPORT_LIMIT_BYTES,
} as const

// NOTE: the key of a job in the unique index: the domain key is per report.
export const dedupeKey = (reportId: string, key: string): string =>
  `${reportId}:${key}`
