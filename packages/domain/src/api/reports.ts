import { Schema } from 'effect'

import { ItemEntry, ItemValue, SectionContent, SectionEntry } from '../content'
import { PeopleList, Person } from '../people'
import { RichTextDoc } from '../richtext'
import { ApprovalRule, Permission, TemplateId } from '../template'
import {
  AccountRef,
  ApiId,
  ContentViewSchema,
  Count,
  Deadline,
  DecidedBySchema,
  DisplayName,
  EpochMs,
  Problem,
  ReportStateSchema,
  RoleView,
  RoundStatusSchema,
} from './common'

// NOTE: Case files, reports, working copies, sharing, history, redaction
// confirmation, images and publishing (stages 4 to 6, author side). Everything
// here is for members of the drafting role. Payloads stay within the spike 3
// limits: a section per request, never a whole document.

const DraftNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const SaveCounter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Reference = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(120),
)
const CaseTitle = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(300),
)

// ---- Case files and reports -----------------------------------------------------------

export const CaseFileRecord = Schema.Struct({
  id: ApiId,
  unit: ApiId,
  reference: Reference,
  title: CaseTitle,
})
export type CaseFileRecord = typeof CaseFileRecord.Type

export const ReportSummary = Schema.Struct({
  id: ApiId,
  caseFile: CaseFileRecord,
  templateId: TemplateId,
  templateVersion: Revision,
  templateName: DisplayName,
  state: ReportStateSchema,
  latestDraft: DraftNumber,
  latestRevision: Schema.optionalKey(Revision),
  // NOTE: The deadline of the open round, if there is one.
  deadline: Schema.optionalKey(Deadline),
  createdAt: EpochMs,
})
export type ReportSummary = typeof ReportSummary.Type

// NOTE: The author's view of one report. Reviewers never get this: they read
// a revision (`RevisionOutline` in reviewer.ts).
export const ReportDetail = Schema.Struct({
  summary: ReportSummary,
  myRoleId: ApiId,
  // NOTE: The permissions of the caller's role, so the screen can hide what
  // would be refused. The server checks again on every request.
  permissions: Schema.Array(Permission),
  authors: Schema.Array(AccountRef),
})

export const ReportList = Schema.Array(ReportSummary)

// NOTE: Either an existing case file of the unit or a new one.
export const CaseFileChoice = Schema.Union([
  Schema.Struct({ existing: ApiId }),
  Schema.Struct({ reference: Reference, title: CaseTitle }),
])

// ---- Sections --------------------------------------------------------------------------

export const SectionRef = Schema.Struct({
  sectionId: ApiId,
  // NOTE: Stored size in bytes, so the browser can plan its requests.
  size: Count,
  notApplicable: Schema.Boolean,
})

export const SaveResult = Schema.Struct({
  saveCounter: SaveCounter,
  savedAt: EpochMs,
})

// ---- Working copies ----------------------------------------------------------------------

export const WorkingCopyOutline = Schema.Struct({
  reportId: ApiId,
  ownerId: ApiId,
  baseDraft: DraftNumber,
  saveCounter: SaveCounter,
  savedAt: EpochMs,
  latestDraft: DraftNumber,
  // NOTE: True if a draft was shared after this working copy's base.
  behind: Schema.Boolean,
  hasUnsharedChanges: Schema.Boolean,
  sections: Schema.Array(SectionRef),
  peopleCount: Count,
})
export type WorkingCopyOutline = typeof WorkingCopyOutline.Type

export const WorkingCopySection = Schema.Struct({
  sectionId: ApiId,
  saveCounter: SaveCounter,
  content: SectionContent,
})

export const PeopleView = Schema.Struct({
  // NOTE: Absent for the working copy's own list.
  draft: Schema.optionalKey(DraftNumber),
  saveCounter: Schema.optionalKey(SaveCounter),
  people: PeopleList,
})

export const DraftingInfo = Schema.Struct({
  accountId: ApiId,
  name: DisplayName,
  baseDraft: DraftNumber,
  lastSavedAt: EpochMs,
  hasUnsharedChanges: Schema.Boolean,
})

// ---- Sharing (spike 3) -------------------------------------------------------------------

// NOTE: Mirrors `DraftConflict` of compare.ts. The sides hold only the
// conflicting item, never the document.
const sides = <S extends Schema.Top>(schema: S) => ({
  base: Schema.optional(schema),
  ours: Schema.optional(schema),
  theirs: Schema.optional(schema),
})

export const DraftConflictSchema = Schema.Union([
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal('value'),
    richText: Schema.Boolean,
    ...sides(ItemValue),
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal('entry'),
    ...sides(Schema.Union([SectionEntry, ItemEntry])),
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal('entry_title'),
    ...sides(Schema.String),
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal('entry_order'),
    ...sides(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal('section_status'),
    ...sides(Schema.Struct({ reason: Schema.String })),
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal('image_flag'),
    ...sides(Schema.Boolean),
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal('person'),
    ...sides(Person),
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal('person_name'),
    ...sides(Schema.String),
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal('person_label'),
    clash: Schema.Boolean,
    ...sides(Schema.String),
  }),
  Schema.Struct({
    key: Schema.String,
    kind: Schema.Literal('entries_limit'),
    max: Count,
    merged: Schema.Array(Schema.String),
    ...sides(Schema.Array(Schema.String)),
  }),
])

export const ConflictChoiceSchema = Schema.Union([
  Schema.Literals(['ours', 'theirs']),
  Schema.Struct({ edited: RichTextDoc }),
  Schema.Struct({ label: Schema.String.check(Schema.isMaxLength(200)) }),
  Schema.Struct({
    keep: Schema.Array(Schema.String).check(Schema.isMaxLength(500)),
  }),
])

// NOTE: The three-way comparison of the author's working copy against the
// latest shared draft, from their common base. `problems` are `merge`
// problems of the domain (`resolveMerge` refuses while any remain).
export const Comparison = Schema.Struct({
  baseDraft: DraftNumber,
  theirsDraft: DraftNumber,
  conflicts: Schema.Array(DraftConflictSchema).check(Schema.isMaxLength(500)),
  problems: Schema.Array(Problem).check(Schema.isMaxLength(200)),
})
export type Comparison = typeof Comparison.Type

export const ShareSectionResult = Schema.Struct({
  shareId: ApiId,
  sectionId: ApiId,
  staged: Count,
  // NOTE: Hash of the redacted content just staged. The author's redaction
  // preview of the whole share is confirmed with the hash of these, joined
  // in section order, and of the people list (see `FinishShare.redactionHash`).
  redactedHash: Schema.String,
  // NOTE: SHA-256 (hex) of the people list the section was redacted with. One
  // list covers the whole share: every section of it carries the same value.
  peopleHash: Schema.String,
})

export const DraftHeader = Schema.Struct({
  number: DraftNumber,
  label: Schema.String,
  baseDraft: Schema.optionalKey(DraftNumber),
  // NOTE: Draft 0 has no author.
  sharedBy: Schema.optionalKey(AccountRef),
  sharedAt: EpochMs,
  // NOTE: Hash of the stored redacted content and of the draft's people list.
  // The author confirms it (D14).
  redactedHash: Schema.String,
  redactionConfirmed: Schema.Boolean,
})
export type DraftHeader = typeof DraftHeader.Type

export const RevisionHeader = Schema.Struct({
  number: Revision,
  label: Schema.String,
  draft: DraftNumber,
  closing: Schema.Boolean,
  publishedAt: EpochMs,
  deadline: Deadline,
  status: RoundStatusSchema,
  decidedBy: Schema.optionalKey(DecidedBySchema),
  replacedBy: Schema.optionalKey(Revision),
})
export type RevisionHeader = typeof RevisionHeader.Type

// NOTE: Sharing on a stale base does not fail: it answers with the
// comparison (stage 2c). The two shares of a race give one Draft N and one
// comparison.
export const ShareOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('shared'),
    draft: DraftHeader,
    // NOTE: Present when the request asked to publish ("share and publish").
    revision: Schema.optionalKey(RevisionHeader),
  }),
  Schema.Struct({
    kind: Schema.Literal('stale_base'),
    latestDraft: DraftNumber,
    comparison: Comparison,
  }),
])
export type ShareOutcome = typeof ShareOutcome.Type

// ---- History -----------------------------------------------------------------------------

export const History = Schema.Struct({
  drafts: Schema.Array(DraftHeader),
  revisions: Schema.Array(RevisionHeader),
})

export const DraftOutline = Schema.Struct({
  header: DraftHeader,
  sections: Schema.Array(SectionRef),
  peopleCount: Count,
})

// NOTE: An author may read a shared draft as written or as stored for
// redacted roles.
export const VersionSection = Schema.Struct({
  sectionId: ApiId,
  view: ContentViewSchema,
  content: SectionContent,
})

export const DraftChange = Schema.Struct({
  key: Schema.String,
  change: Schema.Literals(['added', 'removed', 'changed']),
  sectionId: ApiId,
  itemId: Schema.optionalKey(Schema.String),
})

export const DraftComparison = Schema.Struct({
  from: DraftNumber,
  to: DraftNumber,
  changes: Schema.Array(DraftChange).check(Schema.isMaxLength(2000)),
  peopleChanged: Schema.Boolean,
})

// ---- Images --------------------------------------------------------------------------------

export const ImageMime = Schema.Literals(['image/jpeg', 'image/png'])

export const ImageOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('report'), reportId: ApiId }),
  Schema.Struct({ kind: Schema.Literal('theme') }),
])

export const ImageMeta = Schema.Struct({
  id: ApiId,
  owner: ImageOwner,
  mime: ImageMime,
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1600 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1600 })),
  size: Count,
  hash: Schema.String,
  uploadedBy: ApiId,
  uploadedAt: EpochMs,
  // NOTE: True once any shared draft has referenced it (D5): it can then
  // never be deleted.
  referenced: Schema.Boolean,
  // NOTE: Whether the figures of the author's working copy are marked safe.
  safeToShare: Schema.Boolean,
})
export type ImageMeta = typeof ImageMeta.Type

export const ImageList = Schema.Struct({
  images: Schema.Array(ImageMeta),
  referencedBytes: Count,
  limitBytes: Count,
})

// NOTE: Rewrites the `safeToShare` flag of every figure of the image in the
// working copy; only the sections that hold one are written.
export const MarkedImage = Schema.Struct({
  saveCounter: SaveCounter,
  savedAt: EpochMs,
  sections: Schema.Array(ApiId),
})

// ---- Publishing ----------------------------------------------------------------------------

export const PersonSourceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('committee'),
    committeeId: ApiId,
  }),
  Schema.Struct({ kind: Schema.Literal('account'), accountId: ApiId }),
])

export const SelectionSchema = Schema.Struct({
  roleId: ApiId,
  sources: Schema.Array(PersonSourceSchema).check(Schema.isMaxLength(200)),
})

// NOTE: What publishing needs (D6, D12, D23). `closing` is required while the
// report is `concluding` and refused otherwise.
export const PublishTerms = Schema.Struct({
  deadline: Deadline,
  selections: Schema.Array(SelectionSchema).check(Schema.isMaxLength(20)),
  closing: Schema.Boolean,
})
export type PublishTerms = typeof PublishTerms.Type

export const RoleChoiceView = Schema.Struct({
  roleId: ApiId,
  name: DisplayName,
  view: RoleView,
  votes: Schema.Boolean,
  comments: Schema.Boolean,
  rule: Schema.optional(ApprovalRule),
})

export const CommitteeChoice = Schema.Struct({
  id: ApiId,
  name: DisplayName,
  members: Schema.Array(AccountRef),
})

export const PublishChoices = Schema.Struct({
  latestDraft: DraftNumber,
  hasUnsharedChanges: Schema.Boolean,
  // NOTE: Whether an author confirmed the redaction preview of the latest
  // draft (needed for a `redacted` role).
  redactionConfirmed: Schema.Boolean,
  closingRequired: Schema.Boolean,
  roles: Schema.Array(RoleChoiceView),
  committees: Schema.Array(CommitteeChoice),
  reviewers: Schema.Array(AccountRef),
})

export const PublishResult = Schema.Struct({
  revision: RevisionHeader,
  // NOTE: Reviewers who got an inbox notification in the same batch.
  notified: Count,
})
