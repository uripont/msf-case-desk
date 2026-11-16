import { Effect, Layer } from 'effect'

import {
  type AccountProfile,
  type AccountRecord,
  type AssignmentRecord,
  type AuditInput,
  type AuditRecord,
  type StoreCaseFileRecord,
  type StoreCommentRecord,
  type DraftRecord,
  type EventRecord,
  type FinishShareOutcome,
  type GrantRecord,
  STORE_CAPABILITY_NAMES,
  type ImageRecord,
  type InvitationRecord,
  type JobRecord,
  type MemberRecord,
  type ParticipantRecord,
  type PublishInput,
  type PublishOutcome,
  type PutChunkOutcome,
  type ReplyRecord,
  type ReportRecord,
  type ReviewerRoundRecord,
  ReportRepository,
  type ReportRepositoryApi,
  type StoreReviewRecord,
  type RevisionRecord,
  type RoundRecord,
  type RoundWithParticipants,
  type StoreTemplateSummary,
  type StoreTemplateVersionRecord,
  type StoreThemeRecord,
  type UnitRecord,
  type UnitReviewerRecord,
  type DecideRoundInput,
  IMAGE_LIMITS,
  MAX_SECTIONS_PER_SAVE,
  MAX_TEMPLATES_PER_IMPORT,
  MAX_TEMPLATES_PER_LOOKUP,
  QUERY_BUDGET,
  RepositoryError,
  dedupeKey,
  imageChunkProblem,
  normaliseEmail,
} from '@case-desk/domain'

import {
  type GuardedStep,
  type SqlBatcher,
  type SqlStore,
  type SqlValue,
  claim,
  runBatch,
} from './sql'

// NOTE: the D1 implementation of `ReportRepository`, on the SQL
// seam. Every write that must be atomic is one `runBatch` with guards; a
// refused guard rolls the whole batch back and the operation answers a
// `Refused` value after at most one diagnosing read. `QUERY_BUDGET` (domain)
// holds the most queries each operation may make; `onQueries` reports the real
// count so the contract suite can check it.

type Row = Record<string, unknown>
type Expr = { readonly sql: string; readonly values: ReadonlyArray<SqlValue> }

type Unwrap<F> = F extends (
  ...args: infer A
) => Effect.Effect<infer R, infer _E>
  ? (db: SqlStore, ...args: A) => Promise<R>
  : never
type Impl = { [K in keyof ReportRepositoryApi]: Unwrap<ReportRepositoryApi[K]> }

// ---- Small helpers -----------------------------------------------------------------------------

const rows = async (
  db: SqlStore,
  sql: string,
  ...values: Array<SqlValue>
): Promise<Array<Row>> =>
  (
    await db
      .prepare(sql)
      .bind(...values)
      .all<Row>()
  ).results

const row = async (
  db: SqlStore,
  sql: string,
  ...values: Array<SqlValue>
): Promise<Row | null> =>
  db
    .prepare(sql)
    .bind(...values)
    .first<Row>()

const exec = async (
  db: SqlStore,
  sql: string,
  ...values: Array<SqlValue>
): Promise<void> => {
  await db
    .prepare(sql)
    .bind(...values)
    .run()
}

// NOTE: independent reads in one batch: one round trip instead of one each.
const readBatch = async (
  db: SqlStore,
  steps: ReadonlyArray<Expr>,
): Promise<ReadonlyArray<Array<Row>>> => {
  const outcome = await runBatch(db, steps)
  if (outcome._tag !== 'Committed') throw new Error('read batch not committed')
  return outcome.results.map(result => result.rows as Array<Row>)
}

const s = (value: unknown): string => value as string
const n = (value: unknown): number => value as number
const sn = (value: unknown): string | null => (value ?? null) as string | null
const nn = (value: unknown): number | null => (value ?? null) as number | null
const b = (value: unknown): boolean => value === 1 || value === true
const flag = (value: boolean): number => (value ? 1 : 0)

const IN = (count: number): string => new Array(count).fill('?').join(', ')

// NOTE: kinds of notification a superseded, decided or abandoned round must
// no longer send (revision_replaced and the outcomes are sent regardless).
const SKIPPABLE_KINDS = [
  'review_request',
  'reminder_first',
  'reminder_final',
  'deadline',
]
const SKIPPABLE_SQL = SKIPPABLE_KINDS.map(kind => `'${kind}'`).join(', ')

const jobsJson = (
  reportId: string,
  jobs: ReadonlyArray<{
    key: string
    recipient: string | null
    kind: string
    revision: number
    dueAt: number
    deadline: number | null
    subject: string | null
    channel: string
  }>,
): string =>
  JSON.stringify(
    jobs.map(job => ({ ...job, key: dedupeKey(reportId, job.key) })),
  )

const insertJobsStep = (
  reportId: string,
  roundId: string | null,
  jobs: Parameters<typeof jobsJson>[1],
  now: number,
): GuardedStep | null =>
  jobs.length === 0
    ? null
    : {
        sql: `INSERT OR IGNORE INTO notification_jobs (dedupe_key, report_id, round_id,
          recipient_id, kind, revision_number, due_at, deadline, subject, channel,
          state, attempts, created_at)
          SELECT json_extract(j.value, '$.key'), ?, ?, json_extract(j.value, '$.recipient'),
            json_extract(j.value, '$.kind'), json_extract(j.value, '$.revision'),
            json_extract(j.value, '$.dueAt'), json_extract(j.value, '$.deadline'),
            json_extract(j.value, '$.subject'), json_extract(j.value, '$.channel'),
            'pending', 0, ?
          FROM json_each(?) j`,
        values: [reportId, roundId, now, jobsJson(reportId, jobs)],
      }

const auditStep = (
  audit: AuditInput,
  options: {
    readonly draft?: Expr
    readonly where?: Expr
  } = {},
): GuardedStep => {
  const columns: ReadonlyArray<Expr> = [
    { sql: '?', values: [audit.at] },
    { sql: '?', values: [audit.actorId] },
    { sql: '?', values: [audit.reportId ?? null] },
    { sql: '?', values: [audit.templateId ?? null] },
    options.draft ?? { sql: '?', values: [audit.draftNumber ?? null] },
    { sql: '?', values: [audit.revisionNumber ?? null] },
    { sql: '?', values: [audit.action] },
    { sql: '?', values: [audit.meta ?? '{}'] },
  ]
  const where = options.where
  return {
    sql: `INSERT INTO audit_events (at, actor_id, report_id, template_id,
      draft_number, revision_number, action, meta)
      SELECT ${columns.map(c => c.sql).join(', ')}${where === undefined ? '' : ` WHERE ${where.sql}`}`,
    values: [
      ...columns.flatMap(c => c.values),
      ...(where === undefined ? [] : where.values),
    ],
  }
}

const compact = <T>(list: ReadonlyArray<T | null>): Array<T> =>
  list.filter((item): item is T => item !== null)

// ---- Row mappers ---------------------------------------------------------------------------------

const unitOf = (r: Row): UnitRecord => ({
  id: s(r['id']),
  name: s(r['name']),
  code: s(r['code']),
  createdAt: n(r['created_at']),
})

// NOTE: a capability this version does not know is ignored, not refused.
const grantsOf = (found: ReadonlyArray<Row>): ReadonlyArray<GrantRecord> =>
  found.flatMap(r => {
    const capability = STORE_CAPABILITY_NAMES.find(
      name => name === s(r['capability']),
    )
    return capability === undefined
      ? []
      : [
          {
            userId: s(r['user_id']),
            capability,
            unitId: s(r['unit_id']) === '' ? null : s(r['unit_id']),
            grantedBy: sn(r['granted_by']),
            grantedAt: n(r['granted_at']),
          },
        ]
  })

const PROFILE_COLUMNS = `p.user_id AS p_user_id,
  p.notify_on_approval AS p_notify, p.active AS p_active,
  p.password_set_at AS p_password_set_at`

const profileOf = (r: Row): AccountProfile | null =>
  r['p_user_id'] === null || r['p_user_id'] === undefined
    ? null
    : {
        userId: s(r['p_user_id']),
        notifyOnApproval: b(r['p_notify']),
        active: b(r['p_active']),
        passwordSetAt: nn(r['p_password_set_at']),
      }

const accountOf = (r: Row): AccountRecord => ({
  id: s(r['id']),
  email: s(r['email']),
  name: s(r['name']),
  profile: profileOf(r),
})

const invitationOf = (r: Row): InvitationRecord => ({
  id: s(r['id']),
  tokenHash: s(r['token_hash']),
  userId: s(r['user_id']),
  purpose: s(r['purpose']) as InvitationRecord['purpose'],
  expiresAt: n(r['expires_at']),
  usedAt: nn(r['used_at']),
  issuedBy: sn(r['issued_by']),
  createdAt: n(r['created_at']),
})

const versionOf = (r: Row): StoreTemplateVersionRecord => ({
  templateId: s(r['template_id']),
  version: n(r['version']),
  name: s(r['name']),
  shortName: s(r['short_name']),
  state: s(r['state']) as StoreTemplateVersionRecord['state'],
  definition: s(r['definition']),
  builtin: b(r['builtin']),
  createdBy: sn(r['created_by']),
  createdAt: n(r['created_at']),
  publishedAt: nn(r['published_at']),
  publishedBy: sn(r['published_by']),
  changes: sn(r['changes']),
  retiredAt: nn(r['retired_at']),
  draftRevision: n(r['draft_revision']),
})

const summaryOf = (r: Row): StoreTemplateSummary => {
  const { definition: _definition, ...rest } = versionOf({
    ...r,
    definition: '',
  })
  return rest
}

const caseFileOf = (r: Row, prefix = ''): StoreCaseFileRecord => ({
  id: s(r[`${prefix}id`]),
  unitId: s(r[`${prefix}unit_id`]),
  reference: s(r[`${prefix}reference`]),
  title: s(r[`${prefix}title`]),
  createdAt: n(r[`${prefix}created_at`]),
  updatedAt: n(r[`${prefix}updated_at`]),
})

const REPORT_SELECT = `SELECT r.id, r.case_file_id, r.template_id, r.template_version,
  r.state, r.deadline_at, r.deadline_zone, r.created_by, r.created_at, r.updated_at,
  f.unit_id AS f_unit_id, f.reference AS f_reference, f.title AS f_title,
  f.created_at AS f_created_at, f.updated_at AS f_updated_at,
  (SELECT MAX(number) FROM drafts WHERE report_id = r.id) AS latest_draft,
  (SELECT MAX(number) FROM revisions WHERE report_id = r.id) AS latest_revision
  FROM reports r JOIN case_files f ON f.id = r.case_file_id`

const DRAFT_SECTIONS = `SELECT section_id, ordinal, length(CAST(content AS BLOB)) AS bytes, redacted_hash
  FROM draft_sections WHERE report_id = ? AND draft_number = ?
  ORDER BY ordinal, section_id`

const draftSectionOf = (r: Row) => ({
  sectionId: s(r['section_id']),
  ordinal: n(r['ordinal']),
  bytes: n(r['bytes']),
  version: s(r['redacted_hash']),
})

const WORKING_COPY_ONE = 'SELECT * FROM working_copies WHERE report_id = ? AND user_id = ?'

const WORKING_COPY_SECTION = `SELECT content, save_counter FROM working_copy_sections
  WHERE report_id = ? AND user_id = ? AND section_id = ?`

const wcSectionOf = (r: Row) => ({
  content: s(r['content']),
  version: n(r['save_counter']),
})

const inboxRead = (userId: string, limit: number, before?: number): Expr => ({
  sql: `SELECT j.*, r.deadline_zone FROM notification_jobs j
    LEFT JOIN review_rounds r ON r.id = j.round_id
    WHERE j.recipient_id = ? AND j.channel = 'inbox'
    AND j.state = 'done'${before === undefined ? '' : ' AND j.id < ?'}
    ORDER BY j.id DESC LIMIT ?`,
  values: [userId, ...(before === undefined ? [] : [before]), limit],
})

const UNREAD_COUNT = `SELECT COUNT(*) AS c FROM notification_jobs WHERE recipient_id = ?
  AND channel = 'inbox' AND state = 'done' AND read_at IS NULL`

const MEMBERS_SELECT = `SELECT m.user_id, u.name, m.role_id, m.added_at FROM report_members m
  JOIN users u ON u.id = m.user_id WHERE m.report_id = ?
  ORDER BY m.added_at, m.user_id`

const memberOf = (r: Row): MemberRecord => ({
  userId: s(r['user_id']),
  name: s(r['name']),
  roleId: s(r['role_id']),
  addedAt: n(r['added_at']),
})

const REVIEWS_SELECT = `SELECT v.*, r.revision_number FROM reviews v JOIN review_rounds r ON r.id = v.round_id
  WHERE r.report_id = ? ORDER BY v.sent_at, v.id`

const participantsSelect = (where: 'p.round_id = ?' | 'r.report_id = ?'): string =>
  `SELECT p.round_id, p.user_id, u.name, p.role_id, p.added_at, p.removed_at, p.removed_by
  FROM round_participants p JOIN users u ON u.id = p.user_id
  JOIN review_rounds r ON r.id = p.round_id
  WHERE ${where}
  ORDER BY p.added_at, p.user_id`

const reportOf = (r: Row): ReportRecord => ({
  id: s(r['id']),
  caseFile: {
    id: s(r['case_file_id']),
    unitId: s(r['f_unit_id']),
    reference: s(r['f_reference']),
    title: s(r['f_title']),
    createdAt: n(r['f_created_at']),
    updatedAt: n(r['f_updated_at']),
  },
  templateId: s(r['template_id']),
  templateVersion: n(r['template_version']),
  state: s(r['state']) as ReportRecord['state'],
  deadlineAt: nn(r['deadline_at']),
  deadlineZone: sn(r['deadline_zone']),
  createdBy: s(r['created_by']),
  createdAt: n(r['created_at']),
  updatedAt: n(r['updated_at']),
  latestDraft: n(r['latest_draft']),
  latestRevision: nn(r['latest_revision']),
})

const wcOf = (r: Row) => ({
  reportId: s(r['report_id']),
  userId: s(r['user_id']),
  baseDraft: n(r['base_draft']),
  saveCounter: n(r['save_counter']),
  sharedCounter: n(r['shared_counter']),
  people: s(r['people']),
  startedAt: n(r['started_at']),
  lastSavedAt: n(r['last_saved_at']),
})

const DRAFT_SELECT = `SELECT d.report_id, d.number, d.base_number, d.author_id,
  u.name AS author_name, d.shared_at, d.share_id, d.people, d.case_title_redacted,
  d.case_reference_redacted,
  c.confirmed_at,
  (SELECT group_concat(number) FROM revisions
    WHERE report_id = d.report_id AND draft_number = d.number) AS revision_numbers
  FROM drafts d LEFT JOIN users u ON u.id = d.author_id
  LEFT JOIN redaction_confirmations c
    ON c.report_id = d.report_id AND c.draft_number = d.number`

const DRAFT_ONE = `${DRAFT_SELECT} WHERE d.report_id = ? AND d.number = ?`

const draftOf = (r: Row): DraftRecord => ({
  reportId: s(r['report_id']),
  number: n(r['number']),
  baseNumber: nn(r['base_number']),
  authorId: sn(r['author_id']),
  authorName: sn(r['author_name']),
  sharedAt: n(r['shared_at']),
  shareId: s(r['share_id']),
  people: s(r['people']),
  caseTitleRedacted: s(r['case_title_redacted']),
  caseReferenceRedacted: s(r['case_reference_redacted']),
  redactionConfirmedAt: nn(r['confirmed_at']),
  revisions:
    r['revision_numbers'] === null || r['revision_numbers'] === undefined
      ? []
      : s(r['revision_numbers'])
          .split(',')
          .map(Number)
          .sort((a, c) => a - c),
})

const revisionOf = (r: Row): RevisionRecord => ({
  reportId: s(r['report_id']),
  number: n(r['number']),
  draftNumber: n(r['draft_number']),
  closing: b(r['closing']),
  publishedBy: s(r['published_by']),
  publishedAt: n(r['published_at']),
})

const reviewRecordOf = (r: Row): StoreReviewRecord => ({
  id: s(r['id']),
  roundId: s(r['round_id']),
  revision: n(r['revision_number']),
  reviewerId: s(r['reviewer_id']),
  decision: s(r['decision']) as StoreReviewRecord['decision'],
  hasComments: b(r['has_comments']),
  sentAt: n(r['sent_at']),
})

const roundOf = (r: Row): RoundRecord => ({
  id: s(r['id']),
  reportId: s(r['report_id']),
  revision: n(r['revision_number']),
  closing: b(r['closing']),
  deadlineAt: n(r['deadline_at']),
  deadlineZone: s(r['deadline_zone']),
  state: s(r['state']) as RoundRecord['state'],
  decidedBy: sn(r['decided_by']) as RoundRecord['decidedBy'],
  decidedAt: nn(r['decided_at']),
  createdAt: n(r['created_at']),
})

const participantOf = (r: Row): ParticipantRecord => ({
  roundId: s(r['round_id']),
  userId: s(r['user_id']),
  name: s(r['name']),
  roleId: s(r['role_id']),
  addedAt: n(r['added_at']),
  removedAt: nn(r['removed_at']),
  removedBy: sn(r['removed_by']),
})

const COMMENT_SELECT = `SELECT c.id, c.report_id, c.target_kind, c.target_number,
  c.round_id, c.section_id, c.item_id, c.range_from, c.range_to, c.quoted, c.body,
  c.redacted_body, c.author_id, u.name AS author_name, c.visibility, c.resolved,
  c.review_id, c.created_at
  FROM comments c JOIN users u ON u.id = c.author_id`

const commentOf = (r: Row): StoreCommentRecord => ({
  id: s(r['id']),
  reportId: s(r['report_id']),
  targetKind: s(r['target_kind']) as StoreCommentRecord['targetKind'],
  targetNumber: n(r['target_number']),
  roundId: sn(r['round_id']),
  sectionId: s(r['section_id']),
  itemId: sn(r['item_id']),
  rangeFrom: nn(r['range_from']),
  rangeTo: nn(r['range_to']),
  quoted: sn(r['quoted']),
  body: s(r['body']),
  redactedBody: sn(r['redacted_body']),
  authorId: s(r['author_id']),
  authorName: s(r['author_name']),
  visibility: s(r['visibility']) as StoreCommentRecord['visibility'],
  resolved: b(r['resolved']),
  reviewId: sn(r['review_id']),
  createdAt: n(r['created_at']),
})

const jobOf = (r: Row): JobRecord => ({
  id: n(r['id']),
  key: s(r['dedupe_key']).slice(s(r['report_id']).length + 1),
  reportId: s(r['report_id']),
  roundId: sn(r['round_id']),
  recipientId: sn(r['recipient_id']),
  kind: s(r['kind']) as JobRecord['kind'],
  revision: n(r['revision_number']),
  dueAt: n(r['due_at']),
  deadline: nn(r['deadline']),
  subject: sn(r['subject']),
  channel: s(r['channel']) as JobRecord['channel'],
  state: s(r['state']) as JobRecord['state'],
  claimedBy: sn(r['claimed_by']),
  leaseUntil: nn(r['lease_until']),
  attempts: n(r['attempts']),
  deferrals: n(r['deferrals']),
  deadlineZone: sn(r['deadline_zone']),
  retryAt: nn(r['retry_at']),
  lastError: sn(r['last_error']),
  createdAt: n(r['created_at']),
  doneAt: nn(r['done_at']),
  readAt: nn(r['read_at']),
})

const imageOf = (r: Row, referenced: boolean): ImageRecord => ({
  id: s(r['id']),
  owner:
    s(r['owner_kind']) === 'theme'
      ? { kind: 'theme' }
      : { kind: 'report', reportId: s(r['owner_id']) },
  uploadedBy: s(r['uploaded_by']),
  mime: s(r['mime']) as ImageRecord['mime'],
  width: n(r['width']),
  height: n(r['height']),
  size: n(r['size_bytes']),
  hash: s(r['sha256']),
  chunkCount: n(r['chunk_count']),
  chunksReceived: n(r['chunks_received']),
  complete: b(r['complete']),
  createdAt: n(r['created_at']),
  referenced,
})

const byDue = (a: JobRecord, c: JobRecord): number =>
  a.dueAt - c.dueAt || a.id - c.id

// ---- Publishing steps, shared by publishRevision and finishShare ------------------------------

// NOTE: the statements of "publish": the revision (guarded on the report's
// state, on the draft being the latest, on the revision number being the
// next one and on no participant being an author), the old round superseded
// with its reminders skipped, the new round and its participants, the report's
// state and deadline, the jobs and the audit event. 9 queries.
// NOTE: the steps that decide a round (see `decideRound`).
const decideSteps = (input: DecideRoundInput): ReadonlyArray<GuardedStep> =>
  compact<GuardedStep>([
    {
      sql: `UPDATE review_rounds SET state = 'decided', decided_by = ?, decided_at = ?
        WHERE id = ? AND state = 'open' AND deadline_at = ?
        AND (? <> 'deadline' OR deadline_at <= ?)
        AND (SELECT COUNT(*) FROM reviews WHERE round_id = ?) = ?
        AND (SELECT COUNT(*) FROM round_participants
          WHERE round_id = ? AND removed_at IS NULL) = ?`,
      values: [
        input.decidedBy,
        input.now,
        input.roundId,
        input.expectedDeadlineAt,
        input.decidedBy,
        input.now,
        input.roundId,
        input.expectedReviews,
        input.roundId,
        input.expectedParticipants,
      ],
      expectChanges: 1,
    },
    {
      sql: 'UPDATE reports SET state = ?, updated_at = ? WHERE id = ?',
      values: [input.toState, input.now, input.reportId],
    },
    {
      sql: `UPDATE notification_jobs SET state = 'skipped'
        WHERE round_id = ? AND state = 'pending' AND kind IN (${SKIPPABLE_SQL})`,
      values: [input.roundId],
    },
    insertJobsStep(input.reportId, input.roundId, input.jobs, input.now),
    auditStep(input.audit),
  ])

const publishSteps = (
  reportId: string,
  draft: Expr,
  checkLatest: boolean,
  input: PublishInput,
): ReadonlyArray<GuardedStep> => {
  const participantsJson = JSON.stringify(input.participants)
  const latestCheck: Expr = checkLatest
    ? {
        sql:
          ' AND (SELECT MAX(number) FROM drafts WHERE report_id = ?) = ' +
          draft.sql,
        values: [reportId, ...draft.values],
      }
    : { sql: '', values: [] }
  // NOTE: a participant with a `redacted` view needs the redaction of exactly
  // this draft confirmed; the check is part of the publish statement.
  const confirmCheck: Expr =
    input.requiresConfirmation === true
      ? {
          sql:
            ' AND EXISTS (SELECT 1 FROM redaction_confirmations WHERE report_id = ? AND draft_number = ' +
            draft.sql +
            ')',
          values: [reportId, ...draft.values],
        }
      : { sql: '', values: [] }
  const jobs = insertJobsStep(reportId, input.roundId, input.jobs, input.now)
  return compact<GuardedStep>([
    {
      sql: `INSERT INTO revisions (report_id, number, draft_number, closing, published_by, published_at)
        SELECT ?, ?, ${draft.sql}, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM reports WHERE id = ? AND state IN (${IN(input.fromStates.length)}))${latestCheck.sql}
        AND (SELECT COALESCE(MAX(number), 0) FROM revisions WHERE report_id = ?) = ?
        AND NOT EXISTS (SELECT 1 FROM report_members m, json_each(?) j
          WHERE m.report_id = ? AND m.user_id = json_extract(j.value, '$.userId'))${confirmCheck.sql}`,
      values: [
        reportId,
        input.revision,
        ...draft.values,
        flag(input.closing),
        input.publishedBy,
        input.now,
        reportId,
        ...input.fromStates,
        ...latestCheck.values,
        reportId,
        input.revision - 1,
        participantsJson,
        reportId,
        ...confirmCheck.values,
      ],
      expectChanges: 1,
    },
    {
      sql: `UPDATE notification_jobs SET state = 'skipped'
        WHERE state = 'pending' AND kind IN (${SKIPPABLE_SQL})
        AND round_id IN (SELECT id FROM review_rounds WHERE report_id = ? AND state = 'open')`,
      values: [reportId],
    },
    {
      sql: `UPDATE review_rounds SET state = 'superseded' WHERE report_id = ? AND state = 'open'`,
      values: [reportId],
    },
    {
      sql: `INSERT INTO review_rounds (id, report_id, revision_number, closing,
        deadline_at, deadline_zone, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      values: [
        input.roundId,
        reportId,
        input.revision,
        flag(input.closing),
        input.deadlineAt,
        input.deadlineZone,
        input.now,
      ],
    },
    {
      sql: `INSERT INTO round_participants (round_id, user_id, role_id, added_at)
        SELECT ?, json_extract(j.value, '$.userId'), json_extract(j.value, '$.roleId'), ?
        FROM json_each(?) j`,
      values: [input.roundId, input.now, participantsJson],
    },
    {
      sql: `UPDATE reports SET state = ?, deadline_at = ?, deadline_zone = ?, updated_at = ? WHERE id = ?`,
      values: [
        input.toState,
        input.deadlineAt,
        input.deadlineZone,
        input.now,
        reportId,
      ],
    },
    jobs,
    auditStep(
      { ...input.audit, reportId, revisionNumber: input.revision },
      { draft },
    ),
  ])
}

const PUBLISH_DIAGNOSIS = `SELECT
  (SELECT state FROM reports WHERE id = ?) AS state,
  (SELECT MAX(number) FROM drafts WHERE report_id = ?) AS latest,
  (SELECT COALESCE(MAX(number), 0) FROM revisions WHERE report_id = ?) AS last_revision,
  (SELECT COUNT(*) FROM report_members m, json_each(?) j
    WHERE m.report_id = ? AND m.user_id = json_extract(j.value, '$.userId')) AS overlap`

// ---- The operations ---------------------------------------------------------------------------------

const ops: Impl = {
  // -- units, accounts, grants, links
  createUnit: async (db, unit) => {
    const inserted = await rows(
      db,
      `INSERT INTO units (id, name, code, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING RETURNING id`,
      unit.id,
      unit.name,
      unit.code,
      unit.createdAt,
      unit.createdAt,
    )
    return inserted.length === 1
      ? { _tag: 'Created' }
      : { _tag: 'Refused', reason: 'duplicate' }
  },
  listUnits: async db =>
    (await rows(db, 'SELECT * FROM units ORDER BY name, id')).map(unitOf),
  updateUnit: async (db, id, name, now) => {
    const updated = await rows(
      db,
      'UPDATE units SET name = ?, updated_at = ? WHERE id = ? RETURNING *',
      name,
      now,
      id,
    )
    return updated[0] === undefined ? null : unitOf(updated[0])
  },
  grantCapability: async (db, grant) => {
    const unitId = grant.unitId ?? ''
    const inserted = await rows(
      db,
      `INSERT INTO permission_grants (user_id, capability, unit_id, granted_by, granted_at)
        SELECT ?, ?, ?, ?, ? WHERE ? <> 'author' OR EXISTS (SELECT 1 FROM units WHERE id = ?)
        ON CONFLICT DO NOTHING RETURNING user_id`,
      grant.userId,
      grant.capability,
      unitId,
      grant.grantedBy,
      grant.grantedAt,
      grant.capability,
      unitId,
    )
    if (inserted.length === 1) return 'granted'
    const existing = await row(
      db,
      `SELECT EXISTS (SELECT 1 FROM permission_grants
        WHERE user_id = ? AND capability = ? AND unit_id = ?) AS e`,
      grant.userId,
      grant.capability,
      unitId,
    )
    return b(existing?.['e']) ? 'exists' : 'no_unit'
  },
  revokeCapability: async (db, userId, capability, unitId) =>
    (
      await rows(
        db,
        `DELETE FROM permission_grants WHERE user_id = ? AND capability = ? AND unit_id = ?
          RETURNING user_id`,
        userId,
        capability,
        unitId ?? '',
      )
    ).length === 1,
  listGrants: async (db, userId) =>
    grantsOf(
      userId === undefined
      ? await rows(
          db,
          'SELECT * FROM permission_grants ORDER BY user_id, capability, unit_id',
        )
      : await rows(
          db,
          `SELECT * FROM permission_grants WHERE user_id = ?
              ORDER BY user_id, capability, unit_id`,
          userId,
        ),
    ),
  listAccounts: async db =>
    (
      await rows(
        db,
        `SELECT u.id, u.email, u.name, ${PROFILE_COLUMNS} FROM users u
          LEFT JOIN account_profiles p ON p.user_id = u.id ORDER BY u.email`,
      )
    ).map(accountOf),
  listAccountsByIds: async (db, userIds) =>
    userIds.length === 0
      ? []
      : (
          await rows(
            db,
            `SELECT u.id, u.email, u.name, ${PROFILE_COLUMNS} FROM users u
              LEFT JOIN account_profiles p ON p.user_id = u.id
              WHERE u.id IN (SELECT value FROM json_each(?)) ORDER BY u.email`,
            JSON.stringify(userIds),
          )
        ).map(accountOf),
  getAccount: async (db, userId) => {
    const found = await row(
      db,
      `SELECT u.id, u.email, u.name, ${PROFILE_COLUMNS} FROM users u
        LEFT JOIN account_profiles p ON p.user_id = u.id WHERE u.id = ?`,
      userId,
    )
    return found === null ? null : accountOf(found)
  },
  findAccountByEmail: async (db, email) => {
    const found = await row(
      db,
      `SELECT u.id, u.email, u.name, ${PROFILE_COLUMNS} FROM users u
        LEFT JOIN account_profiles p ON p.user_id = u.id WHERE u.email = ?`,
      email,
    )
    return found === null ? null : accountOf(found)
  },
  updateAccountName: async (db, userId, name) => {
    const outcome = await runBatch(db, [
      {
        sql: 'UPDATE users SET name = ? WHERE id = ?',
        values: [name, userId],
        expectChanges: 1,
      },
    ])
    return outcome._tag === 'Committed'
  },
  createAccount: async (db, input) => {
    const email = normaliseEmail(input.email)
    const profile = input.profile
    const unitGuard = (unitId: string): string =>
      `EXISTS (SELECT 1 FROM units WHERE id = '${unitId.replace(/'/g, "''")}')`
    void unitGuard
    const steps = compact<GuardedStep>([
      {
        sql: `INSERT INTO users (id, email, name, password_hash)
          SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ?)`,
        values: [input.id, email, input.name, input.passwordHash, email],
        expectChanges: 1,
      },
      {
        sql: `INSERT INTO account_profiles (user_id, notify_on_approval, active,
          password_set_at, created_at)
          VALUES (?, ?, ?, NULL, ?)`,
        values: [
          input.id,
          flag(profile.notifyOnApproval),
          flag(profile.active),
          input.now,
        ],
      },
      input.reviewerOfUnit === undefined
        ? null
        : {
            sql: `INSERT INTO unit_reviewers (unit_id, user_id, added_by, added_at, display_name)
              SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM units WHERE id = ?)`,
            values: [
              input.reviewerOfUnit,
              input.id,
              input.createdBy,
              input.now,
              input.reviewerEntry?.displayName ?? input.name,
              input.reviewerOfUnit,
            ],
            expectChanges: 1,
          },
      input.grant === undefined
        ? null
        : {
            sql: `INSERT INTO permission_grants (user_id, capability, unit_id, granted_by, granted_at)
              SELECT ?, ?, ?, ?, ? WHERE ? <> 'author' OR EXISTS (SELECT 1 FROM units WHERE id = ?)`,
            values: [
              input.id,
              input.grant.capability,
              input.grant.unitId ?? '',
              input.createdBy,
              input.now,
              input.grant.capability,
              input.grant.unitId ?? '',
            ],
            expectChanges: 1,
          },
      input.invitation === undefined
        ? null
        : {
            sql: `INSERT INTO invitations (id, token_hash, user_id, purpose, expires_at,
              used_at, issued_by, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
            values: [
              input.invitation.id,
              input.invitation.tokenHash,
              input.invitation.userId,
              input.invitation.purpose,
              input.invitation.expiresAt,
              input.invitation.issuedBy,
              input.invitation.createdAt,
            ],
          },
      input.audit === undefined ? null : auditStep(input.audit),
    ])
    const outcome = await runBatch(db, steps)
    if (outcome._tag === 'Committed') return { _tag: 'Created' }
    const taken = await row(
      db,
      'SELECT EXISTS (SELECT 1 FROM users WHERE email = ?) AS t',
      email,
    )
    return {
      _tag: 'Refused',
      reason: b(taken?.['t']) ? 'email_taken' : 'no_unit',
    }
  },
  getProfile: async (db, userId) => {
    const found = await row(
      db,
      `SELECT ${PROFILE_COLUMNS} FROM account_profiles p WHERE p.user_id = ?`,
      userId,
    )
    return found === null ? null : profileOf(found)
  },
  putProfile: async (db, userId, profile, now) => {
    await exec(
      db,
      `INSERT INTO account_profiles (user_id, notify_on_approval, active, password_set_at,
        created_at)
        VALUES (?, ?, ?, NULL, ?)
        ON CONFLICT (user_id) DO UPDATE SET
          notify_on_approval = excluded.notify_on_approval, active = excluded.active`,
      userId,
      flag(profile.notifyOnApproval),
      flag(profile.active),
      now,
    )
  },
  linkReviewer: async (db, unitId, userId, addedBy, now, audit, entry) => {
    const outcome = await runBatch(db, [
      {
        sql: `INSERT INTO unit_reviewers (unit_id, user_id, added_by, added_at, display_name)
          SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM units WHERE id = ?)
          AND NOT EXISTS (SELECT 1 FROM unit_reviewers WHERE unit_id = ? AND user_id = ?)`,
        values: [
          unitId,
          userId,
          addedBy,
          now,
          entry.displayName,
          unitId,
          unitId,
          userId,
        ],
        expectChanges: 1,
      },
      auditStep(audit),
    ])
    if (outcome._tag === 'Committed') return 'linked'
    const existing = await row(
      db,
      `SELECT EXISTS (SELECT 1 FROM unit_reviewers WHERE unit_id = ? AND user_id = ?) AS e`,
      unitId,
      userId,
    )
    return b(existing?.['e']) ? 'exists' : 'no_unit'
  },
  listReviewerUnits: async (db, userId) =>
    (userId === undefined
      ? await rows(db, 'SELECT unit_id, user_id FROM unit_reviewers ORDER BY unit_id, user_id')
      : await rows(
          db,
          'SELECT unit_id, user_id FROM unit_reviewers WHERE user_id = ? ORDER BY unit_id',
          userId,
        )
    ).map(r => ({ unitId: s(r['unit_id']), userId: s(r['user_id']) })),
  listUnitReviewers: async (db, unitId) =>
    (
      await rows(
        db,
        `SELECT r.unit_id, r.user_id, u.email, COALESCE(NULLIF(r.display_name, ''), u.name) AS name,
          COALESCE(p.active, 1) AS active, r.added_at
          FROM unit_reviewers r JOIN users u ON u.id = r.user_id
          LEFT JOIN account_profiles p ON p.user_id = u.id
          WHERE r.unit_id = ? ORDER BY name, r.user_id`,
        unitId,
      )
    ).map(
      (r): UnitReviewerRecord => ({
        unitId: s(r['unit_id']),
        userId: s(r['user_id']),
        email: s(r['email']),
        name: s(r['name']),
        active: b(r['active']),
        addedAt: n(r['added_at']),
      }),
    ),
  // NOTE: only the unit's own entry is written, never the account.
  updateUnitReviewer: async (db, input) => {
    const outcome = await runBatch(db, [
      {
        sql: `UPDATE unit_reviewers SET display_name = COALESCE(?, display_name)
          WHERE unit_id = ? AND user_id = ?`,
        values: [
          input.displayName ?? null,
          input.unitId,
          input.userId,
        ],
        expectChanges: 1,
      },
      auditStep(input.audit),
    ])
    return outcome._tag === 'Committed' ? 'updated' : 'not_found'
  },
  listUnitAuthors: async (db, unitId) =>
    (
      await rows(
        db,
        `SELECT u.id, u.email, u.name, ${PROFILE_COLUMNS} FROM permission_grants g
          JOIN users u ON u.id = g.user_id LEFT JOIN account_profiles p ON p.user_id = u.id
          WHERE g.capability = 'author' AND g.unit_id = ? ORDER BY u.name, u.id`,
        unitId,
      )
    ).map(accountOf),
  listProfiles: async (db, userIds) => {
    if (userIds.length === 0) return []
    return (
      await rows(
        db,
        `SELECT ${PROFILE_COLUMNS} FROM account_profiles p
          WHERE p.user_id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(userIds),
      )
    ).flatMap(r => {
      const profile = profileOf(r)
      return profile === null ? [] : [profile]
    })
  },
  createInvitation: async (db, invitation, audit) => {
    await runBatch(db, [
      {
        sql: `INSERT INTO invitations (id, token_hash, user_id, purpose, expires_at,
          used_at, issued_by, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        values: [
          invitation.id,
          invitation.tokenHash,
          invitation.userId,
          invitation.purpose,
          invitation.expiresAt,
          invitation.issuedBy,
          invitation.createdAt,
        ],
      },
      auditStep(audit),
    ])
  },
  findInvitation: async (db, tokenHash) => {
    const found = await row(
      db,
      'SELECT * FROM invitations WHERE token_hash = ?',
      tokenHash,
    )
    return found === null ? null : invitationOf(found)
  },
  // NOTE: the plan's order: set the password where an unused, unexpired
  // invitation exists, write the profile, end the sessions, write the audit
  // row, and mark the invitation used last. 7 queries.
  consumeInvitation: async (db, tokenHash, passwordHash, now, audit) => {
    const outcome = await runBatch(db, [
      {
        sql: `UPDATE users SET password_hash = ? WHERE id = (SELECT user_id FROM invitations
          WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?)`,
        values: [passwordHash, tokenHash, now],
        expectChanges: 1,
      },
      {
        sql: `INSERT INTO account_profiles (user_id, notify_on_approval, active,
          password_set_at, created_at)
          SELECT user_id, 0, 1, ?, ? FROM invitations WHERE token_hash = ?
          ON CONFLICT (user_id) DO UPDATE SET password_set_at = excluded.password_set_at`,
        values: [now, now, tokenHash],
      },
      {
        sql: `DELETE FROM sessions WHERE user_id = (SELECT user_id FROM invitations WHERE token_hash = ?)`,
        values: [tokenHash],
      },
      {
        sql: `INSERT INTO audit_events (at, actor_id, report_id, template_id, draft_number,
          revision_number, action, meta)
          SELECT ?, user_id, ?, ?, ?, ?, ?, ? FROM invitations WHERE token_hash = ?`,
        values: [
          audit.at,
          audit.reportId ?? null,
          audit.templateId ?? null,
          audit.draftNumber ?? null,
          audit.revisionNumber ?? null,
          audit.action,
          audit.meta ?? '{}',
          tokenHash,
        ],
      },
      {
        // NOTE: using one link ends every other unused link of the account.
        sql: `UPDATE invitations SET used_at = ? WHERE used_at IS NULL AND token_hash <> ?
          AND user_id = (SELECT user_id FROM invitations WHERE token_hash = ?)`,
        values: [now, tokenHash, tokenHash],
      },
      {
        sql: `UPDATE invitations SET used_at = ? WHERE token_hash = ? AND used_at IS NULL
          AND expires_at > ? RETURNING user_id, purpose`,
        values: [now, tokenHash, now],
        expectChanges: 1,
      },
    ])
    if (outcome._tag === 'Conflict')
      return { _tag: 'Refused', reason: 'invalid' }
    const last = outcome.results[outcome.results.length - 1]?.rows[0]
    return {
      _tag: 'Consumed',
      userId: s(last?.['user_id']),
      purpose: s(last?.['purpose']) as InvitationRecord['purpose'],
    }
  },
  recordSignInAttempt: async (db, email, ip, at, succeeded) => {
    await exec(
      db,
      'INSERT INTO sign_in_attempts (email, ip, at, succeeded) VALUES (?, ?, ?, ?)',
      email,
      ip,
      at,
      flag(succeeded),
    )
  },
  // NOTE: D13: a successful sign-in clears the per-email failures, so only the
  // failures after the last success of that email count.
  signInSummary: async (db, email, ip, since) => {
    const found = await row(
      db,
      `WITH c AS (SELECT COALESCE(MAX(at), -1) AS ok FROM sign_in_attempts
          WHERE email = ? AND succeeded = 1)
        SELECT
        (SELECT COUNT(*) FROM sign_in_attempts, c WHERE email = ? AND succeeded = 0 AND at >= ? AND at > c.ok) AS fe,
        (SELECT MAX(at) FROM sign_in_attempts, c WHERE email = ? AND succeeded = 0 AND at >= ? AND at > c.ok) AS le,
        (SELECT COUNT(*) FROM sign_in_attempts WHERE ip = ? AND succeeded = 0 AND at >= ?) AS fi,
        (SELECT MAX(at) FROM sign_in_attempts WHERE ip = ? AND succeeded = 0 AND at >= ?) AS li`,
      email,
      email,
      since,
      email,
      since,
      ip,
      since,
      ip,
      since,
    )
    return {
      failuresByEmail: n(found?.['fe']),
      lastFailureByEmail: nn(found?.['le']),
      failuresByIp: n(found?.['fi']),
      lastFailureByIp: nn(found?.['li']),
    }
  },
  pruneSignInAttempts: async (db, before, limit) =>
    (
      await rows(
        db,
        `DELETE FROM sign_in_attempts WHERE id IN
          (SELECT id FROM sign_in_attempts WHERE at < ? ORDER BY at LIMIT ?) RETURNING id`,
        before,
        limit,
      )
    ).length,
  deleteSessionsOfUser: async (db, userId) => {
    await exec(db, 'DELETE FROM sessions WHERE user_id = ?', userId)
  },
  getTheme: async db => {
    const found = await row(db, 'SELECT * FROM theme WHERE id = 1')
    return found === null
      ? null
      : {
          settings: s(found['settings']),
          logoImageId: sn(found['logo_image_id']),
          updatedAt: n(found['updated_at']),
          updatedBy: sn(found['updated_by']),
        }
  },
  putTheme: async (db, theme: StoreThemeRecord, audit) => {
    await runBatch(db, [
      {
        sql: `INSERT INTO theme (id, settings, logo_image_id, updated_at, updated_by)
          VALUES (1, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET settings = excluded.settings,
            logo_image_id = excluded.logo_image_id, updated_at = excluded.updated_at,
            updated_by = excluded.updated_by`,
        values: [
          theme.settings,
          theme.logoImageId,
          theme.updatedAt,
          theme.updatedBy,
        ],
      },
      auditStep(audit),
    ])
  },

  // -- templates
  // NOTE: insert-if-absent by (template ID, version): `ON CONFLICT DO NOTHING`
  // never rewrites an existing version, so a redeploy changes nothing and a
  // retired built-in version stays retired. 2 queries per template.
  importBuiltInTemplates: async (db, templates, now) => {
    if (templates.length === 0) return 0
    if (templates.length > MAX_TEMPLATES_PER_IMPORT) {
      throw new Error(
        `At most ${MAX_TEMPLATES_PER_IMPORT} templates can be imported in one call.`,
      )
    }
    const outcome = await runBatch(
      db,
      templates.flatMap<GuardedStep>(t => [
        {
          sql: `INSERT INTO templates (id, builtin, created_by, created_at)
            VALUES (?, 1, NULL, ?) ON CONFLICT DO NOTHING`,
          values: [t.templateId, now],
        },
        {
          sql: `INSERT INTO template_versions (template_id, version, name, short_name, state,
            definition, created_by, created_at, published_at, published_by, changes, retired_at)
            VALUES (?, ?, ?, ?, 'published', ?, NULL, ?, ?, NULL, NULL, NULL)
            ON CONFLICT DO NOTHING`,
          values: [
            t.templateId,
            t.version,
            t.name,
            t.shortName,
            t.definition,
            now,
            now,
          ],
        },
      ]),
    )
    return outcome._tag === 'Committed'
      ? outcome.results.reduce(
          (sum, result, index) =>
            index % 2 === 1 ? sum + result.changes : sum,
          0,
        )
      : 0
  },
  getTemplateVersion: async (db, templateId, version) => {
    const found = await row(
      db,
      `SELECT v.*, t.builtin FROM template_versions v JOIN templates t ON t.id = v.template_id
        WHERE v.template_id = ? AND v.version = ?`,
      templateId,
      version,
    )
    return found === null ? null : versionOf(found)
  },
  getTemplateVersions: async (db, keys) => {
    if (keys.length === 0) return []
    return (
      await rows(
        db,
        `SELECT v.*, t.builtin FROM template_versions v JOIN templates t ON t.id = v.template_id
          WHERE EXISTS (SELECT 1 FROM json_each(?) j
            WHERE json_extract(j.value, '$.templateId') = v.template_id
            AND json_extract(j.value, '$.version') = v.version)`,
        JSON.stringify(keys.slice(0, MAX_TEMPLATES_PER_LOOKUP)),
      )
    ).map(versionOf)
  },
  listTemplates: async db =>
    (
      await rows(
        db,
        `SELECT v.template_id, v.version, v.name, v.short_name, v.state, t.builtin,
          v.created_by, v.created_at, v.published_at, v.published_by, v.changes, v.retired_at,
          v.draft_revision
          FROM template_versions v JOIN templates t ON t.id = v.template_id
          ORDER BY v.template_id, v.version`,
      )
    ).map(summaryOf),
  createTemplateDraft: async (db, input) => {
    const outcome = await runBatch(db, [
      {
        sql: `INSERT INTO templates (id, builtin, created_by, created_at)
          VALUES (?, 0, ?, ?) ON CONFLICT DO NOTHING`,
        values: [input.templateId, input.createdBy, input.now],
      },
      {
        sql: `INSERT INTO template_versions (template_id, version, name, short_name, state,
          definition, created_by, created_at)
          SELECT ?, ?, ?, ?, 'draft', ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM template_versions WHERE template_id = ? AND state = 'draft')
          AND (SELECT COALESCE(MAX(version), 0) + 1 FROM template_versions WHERE template_id = ?) = ?`,
        values: [
          input.templateId,
          input.version,
          input.name,
          input.shortName,
          input.definition,
          input.createdBy,
          input.now,
          input.templateId,
          input.templateId,
          input.version,
        ],
        expectChanges: 1,
      },
      auditStep(input.audit),
    ])
    if (outcome._tag === 'Committed') return { _tag: 'Created' }
    const draft = await row(
      db,
      `SELECT EXISTS (SELECT 1 FROM template_versions WHERE template_id = ? AND state = 'draft') AS d`,
      input.templateId,
    )
    return {
      _tag: 'Refused',
      reason: b(draft?.['d']) ? 'draft_exists' : 'wrong_version',
    }
  },
  saveTemplateDraft: async (db, input) => {
    const outcome = await runBatch(db, [
      {
        sql: `UPDATE template_versions SET name = ?, short_name = ?, definition = ?,
          draft_revision = draft_revision + 1
          WHERE template_id = ? AND version = ? AND state = 'draft' AND draft_revision = ?`,
        values: [
          input.name,
          input.shortName,
          input.definition,
          input.templateId,
          input.version,
          input.expectedRevision,
        ],
        expectChanges: 1,
      },
    ])
    if (outcome._tag === 'Committed') return { _tag: 'Saved' }
    const draft = await row(
      db,
      `SELECT 1 AS d FROM template_versions WHERE template_id = ? AND version = ? AND state = 'draft'`,
      input.templateId,
      input.version,
    )
    return { _tag: 'Refused', reason: draft === null ? 'not_a_draft' : 'stale' }
  },
  publishTemplateVersion: async (db, input) => {
    const outcome = await runBatch(db, [
      {
        sql: `UPDATE template_versions SET state = 'published', published_at = ?,
          published_by = ?, changes = ?
          WHERE template_id = ? AND version = ? AND state = 'draft' AND draft_revision = ?
          AND (EXISTS (SELECT 1 FROM template_versions WHERE template_id = ? AND state = 'published')
            OR NOT EXISTS (SELECT 1 FROM template_versions WHERE template_id = ? AND state = 'retired'))`,
        values: [
          input.now,
          input.publishedBy,
          input.changes,
          input.templateId,
          input.version,
          input.expectedRevision,
          input.templateId,
          input.templateId,
        ],
        expectChanges: 1,
      },
      auditStep(input.audit),
    ])
    if (outcome._tag === 'Committed') return { _tag: 'Published' }
    const draft = await row(
      db,
      `SELECT draft_revision,
        (NOT EXISTS (SELECT 1 FROM template_versions WHERE template_id = ? AND state = 'published')
          AND EXISTS (SELECT 1 FROM template_versions WHERE template_id = ? AND state = 'retired')) AS retired
        FROM template_versions WHERE template_id = ? AND version = ? AND state = 'draft'`,
      input.templateId,
      input.templateId,
      input.templateId,
      input.version,
    )
    if (draft === null) return { _tag: 'Refused', reason: 'not_a_draft' }
    if (b(draft['retired'])) return { _tag: 'Refused', reason: 'retired' }
    return { _tag: 'Refused', reason: 'stale' }
  },
  retireTemplate: async (db, templateId, now, audit) => {
    const outcome = await runBatch(db, [
      {
        ...auditStep(audit, {
          where: {
            sql: `EXISTS (SELECT 1 FROM template_versions WHERE template_id = ? AND state = 'published')`,
            values: [templateId],
          },
        }),
        expectChanges: 1,
      },
      {
        sql: `UPDATE template_versions SET state = 'retired', retired_at = ?
          WHERE template_id = ? AND state = 'published'`,
        values: [now, templateId],
      },
    ])
    return outcome._tag === 'Committed'
      ? { _tag: 'Retired' }
      : { _tag: 'Refused', reason: 'not_published' }
  },

  restoreTemplate: async (db, templateId, audit) => {
    const outcome = await runBatch(db, [
      {
        ...auditStep(audit, {
          where: {
            sql: `NOT EXISTS (SELECT 1 FROM template_versions WHERE template_id = ? AND state = 'published')
              AND EXISTS (SELECT 1 FROM template_versions WHERE template_id = ? AND state = 'retired')`,
            values: [templateId, templateId],
          },
        }),
        expectChanges: 1,
      },
      {
        sql: `UPDATE template_versions SET state = 'published', retired_at = NULL
          WHERE template_id = ? AND state = 'retired'
          AND version = (SELECT MAX(version) FROM template_versions WHERE template_id = ? AND state = 'retired')`,
        values: [templateId, templateId],
      },
    ])
    return outcome._tag === 'Committed'
      ? { _tag: 'Restored' }
      : { _tag: 'Refused', reason: 'not_retired' }
  },
  discardTemplateDraft: async (db, templateId, version, audit) => {
    const outcome = await runBatch(db, [
      {
        ...auditStep(audit, {
          where: {
            sql: `EXISTS (SELECT 1 FROM template_versions WHERE template_id = ? AND version = ? AND state = 'draft')`,
            values: [templateId, version],
          },
        }),
        expectChanges: 1,
      },
      {
        sql: `DELETE FROM template_versions WHERE template_id = ? AND version = ? AND state = 'draft'`,
        values: [templateId, version],
      },
      {
        sql: `DELETE FROM templates WHERE id = ? AND builtin = 0
          AND NOT EXISTS (SELECT 1 FROM template_versions WHERE template_id = ?)`,
        values: [templateId, templateId],
      },
    ])
    return outcome._tag === 'Committed'
      ? { _tag: 'Discarded' }
      : { _tag: 'Refused', reason: 'not_a_draft' }
  },

  // -- committees and case files
  createCommittee: async (db, input) => {
    const outcome = await runBatch(db, [
      {
        sql: `INSERT INTO committees (id, unit_id, name, created_by, created_at)
          SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM units WHERE id = ?)
          AND NOT EXISTS (SELECT 1 FROM committees WHERE id = ? OR (unit_id = ? AND name = ?))`,
        values: [
          input.id,
          input.unitId,
          input.name,
          input.createdBy,
          input.now,
          input.unitId,
          input.id,
          input.unitId,
          input.name,
        ],
        expectChanges: 1,
      },
      {
        sql: `INSERT INTO committee_members (committee_id, user_id, added_at)
          SELECT DISTINCT ?, j.value, ? FROM json_each(?) j`,
        values: [input.id, input.now, JSON.stringify(input.memberIds)],
      },
      auditStep(input.audit),
    ])
    if (outcome._tag === 'Committed') return { _tag: 'Created' }
    const unit = await row(
      db,
      'SELECT EXISTS (SELECT 1 FROM units WHERE id = ?) AS u',
      input.unitId,
    )
    return {
      _tag: 'Refused',
      reason: b(unit?.['u']) ? 'duplicate' : 'no_unit',
    }
  },
  updateCommittee: async (db, input) => {
    const archived =
      input.archived === undefined ? null : input.archived ? 1 : 0
    const outcome = await runBatch(
      db,
      compact<GuardedStep>([
        {
          sql: `UPDATE committees SET name = COALESCE(?, name),
            archived_at = CASE WHEN ? IS NULL THEN archived_at WHEN ? = 1 THEN ? ELSE NULL END
            WHERE id = ?`,
          values: [input.name ?? null, archived, archived, input.now, input.id],
          expectChanges: 1,
        },
        input.memberIds === undefined
          ? null
          : {
              sql: 'DELETE FROM committee_members WHERE committee_id = ?',
              values: [input.id],
            },
        input.memberIds === undefined
          ? null
          : {
              sql: `INSERT INTO committee_members (committee_id, user_id, added_at)
                SELECT DISTINCT ?, j.value, ? FROM json_each(?) j`,
              values: [input.id, input.now, JSON.stringify(input.memberIds)],
            },
        input.removeMemberIds === undefined || input.removeMemberIds.length === 0
          ? null
          : {
              sql: `DELETE FROM committee_members WHERE committee_id = ?
                AND user_id IN (SELECT j.value FROM json_each(?) j)`,
              values: [input.id, JSON.stringify(input.removeMemberIds)],
            },
        input.addMemberIds === undefined || input.addMemberIds.length === 0
          ? null
          : {
              sql: `INSERT OR IGNORE INTO committee_members (committee_id, user_id, added_at)
                SELECT DISTINCT ?, j.value, ? FROM json_each(?) j`,
              values: [input.id, input.now, JSON.stringify(input.addMemberIds)],
            },
        auditStep(input.audit),
      ]),
    )
    return outcome._tag === 'Committed'
  },
  listCommittees: async (db, unitId) => {
    const list = await rows(
      db,
      'SELECT * FROM committees WHERE unit_id = ? ORDER BY name, id',
      unitId,
    )
    const members = await rows(
      db,
      `SELECT m.committee_id, m.user_id FROM committee_members m
        JOIN committees c ON c.id = m.committee_id WHERE c.unit_id = ?
        ORDER BY m.user_id`,
      unitId,
    )
    return list.map(c => ({
      id: s(c['id']),
      unitId: s(c['unit_id']),
      name: s(c['name']),
      createdAt: n(c['created_at']),
      archivedAt: nn(c['archived_at']),
      memberIds: members
        .filter(m => m['committee_id'] === c['id'])
        .map(m => s(m['user_id'])),
    }))
  },
  getCommittee: async (db, id) => {
    const found = await row(db, 'SELECT * FROM committees WHERE id = ?', id)
    if (found === null) return null
    const members = await rows(
      db,
      'SELECT user_id FROM committee_members WHERE committee_id = ? ORDER BY user_id',
      id,
    )
    return {
      id: s(found['id']),
      unitId: s(found['unit_id']),
      name: s(found['name']),
      createdAt: n(found['created_at']),
      archivedAt: nn(found['archived_at']),
      memberIds: members.map(m => s(m['user_id'])),
    }
  },
  listCaseFiles: async (db, unitId) =>
    (
      await rows(
        db,
        'SELECT * FROM case_files WHERE unit_id = ? ORDER BY reference',
        unitId,
      )
    ).map(r => caseFileOf(r)),
  updateCaseFile: async (db, id, patch, now) => {
    const updated = await rows(
      db,
      `UPDATE OR IGNORE case_files SET reference = COALESCE(?, reference),
        title = COALESCE(?, title), updated_at = ? WHERE id = ? RETURNING *`,
      patch.reference ?? null,
      patch.title ?? null,
      now,
      id,
    )
    if (updated[0] !== undefined) return caseFileOf(updated[0])
    const exists = await row(
      db,
      'SELECT EXISTS (SELECT 1 FROM case_files WHERE id = ?) AS e',
      id,
    )
    return b(exists?.['e']) ? { _tag: 'Refused', reason: 'duplicate' } : null
  },
  // NOTE: the guard is the caller's membership of a report on the case file.
  // One audit row per report on the case file, in the same batch.
  retitleCaseFile: async (db, input) => {
    const outcome = await runBatch(db, [
      {
        sql: `UPDATE case_files SET title = ?, updated_at = ? WHERE id = ?
          AND EXISTS (SELECT 1 FROM reports r JOIN report_members m ON m.report_id = r.id
            WHERE r.case_file_id = case_files.id AND m.user_id = ?)`,
        values: [input.title, input.now, input.caseFileId, input.userId],
        expectChanges: 1,
      },
      {
        sql: `INSERT INTO audit_events (at, actor_id, report_id, template_id, draft_number,
          revision_number, action, meta)
          SELECT ?, ?, r.id, NULL, NULL, NULL, ?, ? FROM reports r WHERE r.case_file_id = ?`,
        values: [
          input.audit.at,
          input.audit.actorId,
          input.audit.action,
          input.audit.meta ?? '{}',
          input.caseFileId,
        ],
      },
    ])
    if (outcome._tag === 'Conflict') return { _tag: 'Refused', reason: 'not_found' }
    const found = await row(db, 'SELECT * FROM case_files WHERE id = ?', input.caseFileId)
    const ids = await rows(
      db,
      'SELECT id FROM reports WHERE case_file_id = ? ORDER BY id',
      input.caseFileId,
    )
    if (found === null) return { _tag: 'Refused', reason: 'not_found' }
    return {
      _tag: 'Updated',
      caseFile: caseFileOf(found),
      reportIds: ids.map(r => s(r['id'])),
    }
  },

  // -- reports and members
  createReport: async (db, input) => {
    const caseFile = input.caseFile
    const outcome = await runBatch(db, [
      caseFile.kind === 'new'
        ? {
            sql: `INSERT INTO case_files (id, unit_id, reference, title, created_by, created_at, updated_at)
              SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM units WHERE id = ?)
              AND NOT EXISTS (SELECT 1 FROM case_files WHERE unit_id = ? AND reference = ?)`,
            values: [
              caseFile.id,
              input.unitId,
              caseFile.reference,
              caseFile.title,
              input.createdBy,
              input.now,
              input.now,
              input.unitId,
              input.unitId,
              caseFile.reference,
            ],
            expectChanges: 1,
          }
        : {
            sql: 'UPDATE case_files SET updated_at = updated_at WHERE id = ? AND unit_id = ?',
            values: [caseFile.id, input.unitId],
            expectChanges: 1,
          },
      {
        sql: `INSERT INTO reports (id, case_file_id, template_id, template_version, state,
          deadline_at, deadline_zone, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'drafting', NULL, NULL, ?, ?, ?)`,
        values: [
          input.reportId,
          caseFile.id,
          input.templateId,
          input.templateVersion,
          input.createdBy,
          input.now,
          input.now,
        ],
      },
      {
        sql: `INSERT INTO report_members (report_id, user_id, role_id, added_by, added_at)
          VALUES (?, ?, ?, ?, ?)`,
        values: [
          input.reportId,
          input.createdBy,
          input.draftingRoleId,
          input.createdBy,
          input.now,
        ],
      },
      {
        sql: `INSERT INTO drafts (report_id, number, base_number, author_id, shared_at,
          share_id, people, case_title_redacted, case_reference_redacted)
          VALUES (?, 0, NULL, ?, ?, ?, '[]', '', '')`,
        values: [
          input.reportId,
          input.createdBy,
          input.now,
          `draft-0:${input.reportId}`,
        ],
      },
      auditStep(
        { ...input.audit, reportId: input.reportId },
        { draft: { sql: '0', values: [] } },
      ),
    ])
    if (outcome._tag === 'Committed') return { _tag: 'Created' }
    return {
      _tag: 'Refused',
      reason: caseFile.kind === 'new' ? 'duplicate_reference' : 'no_case_file',
    }
  },
  getReport: async (db, reportId) => {
    const found = await row(db, `${REPORT_SELECT} WHERE r.id = ?`, reportId)
    return found === null ? null : reportOf(found)
  },
  // NOTE: the whole read of a report for the notification pass in one batch
  // (one round trip). No users join, no correlated subqueries: the latest
  // draft and revision are taken from the revisions read in the same batch.
  readReport: async (db, reportId, options) => {
    const outcome = await runBatch(db, [
      {
        sql: `SELECT r.id, r.case_file_id, r.template_id, r.template_version,
          r.state, r.deadline_at, r.deadline_zone, r.created_by, r.created_at, r.updated_at,
          f.unit_id AS f_unit_id, f.reference AS f_reference, f.title AS f_title,
          f.created_at AS f_created_at, f.updated_at AS f_updated_at
          FROM reports r JOIN case_files f ON f.id = r.case_file_id WHERE r.id = ?`,
        values: [reportId],
      },
      options.template
        ? {
            sql: `SELECT v.state, json_extract(v.definition, '$.roles') AS roles,
              json_type(v.definition, '$.conclusion') AS conclusion
              FROM template_versions v WHERE v.template_id = (SELECT template_id FROM reports WHERE id = ?)
              AND v.version = (SELECT template_version FROM reports WHERE id = ?)`,
            values: [reportId, reportId],
          }
        : { sql: 'SELECT 1 WHERE 0', values: [] },
      {
        sql: `SELECT user_id, role_id, added_at FROM report_members WHERE report_id = ?
          ORDER BY added_at, user_id`,
        values: [reportId],
      },
      {
        sql: 'SELECT * FROM review_rounds WHERE report_id = ? ORDER BY revision_number',
        values: [reportId],
      },
      {
        sql: `SELECT p.round_id, p.user_id, p.role_id, p.added_at, p.removed_at, p.removed_by
          FROM round_participants p JOIN review_rounds r ON r.id = p.round_id
          WHERE r.report_id = ? ORDER BY p.added_at, p.user_id`,
        values: [reportId],
      },
      {
        sql: `SELECT v.*, r.revision_number FROM reviews v JOIN review_rounds r ON r.id = v.round_id
          WHERE r.report_id = ? ORDER BY v.sent_at, v.id`,
        values: [reportId],
      },
      {
        sql: 'SELECT * FROM revisions WHERE report_id = ? ORDER BY number',
        values: [reportId],
      },
    ])
    if (outcome._tag !== 'Committed') throw new Error('readReport: batch not committed')
    const [report, template, members, roundRows, participantRows, reviewRows, revisionRows] =
      outcome.results.map(result => result.rows)
    const found = report?.[0]
    if (found === undefined) return null
    const revisions = (revisionRows ?? []).map(revisionOf)
    const participants = (participantRows ?? []).map(r =>
      participantOf({ ...r, name: '' }),
    )
    const first = template?.[0]
    return {
      record: {
        ...reportOf({ ...found, latest_draft: null, latest_revision: null }),
        latestDraft: revisions.reduce((m, r) => Math.max(m, r.draftNumber), 0),
        latestRevision: revisions.reduce<number | null>(
          (m, r) => (m === null ? r.number : Math.max(m, r.number)),
          null,
        ),
      },
      template:
        first === undefined
          ? null
          : {
              state: s(first['state']) as 'draft' | 'published' | 'retired',
              roles: s(first['roles']),
              hasConclusion: first['conclusion'] !== null,
            },
      members: (members ?? []).map(r => ({
        userId: s(r['user_id']),
        name: '',
        roleId: s(r['role_id']),
        addedAt: n(r['added_at']),
      })),
      rounds: (roundRows ?? []).map(roundOf).map(round => ({
        round,
        participants: participants.filter(p => p.roundId === round.id),
      })),
      reviews: (reviewRows ?? []).map(reviewRecordOf),
      revisions,
    }
  },
  // NOTE: the same five reads as `getReport`, `listMembers`, `listRounds`,
  // `listReviews` and `listRevisions`, with the same statements, in one batch.
  readReportParts: async (db, reportId) => {
    const outcome = await runBatch(db, [
      { sql: `${REPORT_SELECT} WHERE r.id = ?`, values: [reportId] },
      { sql: MEMBERS_SELECT, values: [reportId] },
      {
        sql: 'SELECT * FROM review_rounds WHERE report_id = ? ORDER BY revision_number',
        values: [reportId],
      },
      { sql: participantsSelect('r.report_id = ?'), values: [reportId] },
      { sql: REVIEWS_SELECT, values: [reportId] },
      {
        sql: 'SELECT * FROM revisions WHERE report_id = ? ORDER BY number',
        values: [reportId],
      },
    ])
    if (outcome._tag !== 'Committed') throw new Error('readReportParts: batch not committed')
    const [report, members, roundRows, participantRows, reviewRows, revisionRows] =
      outcome.results.map(result => result.rows)
    const found = report?.[0]
    if (found === undefined) return null
    const participants = (participantRows ?? []).map(participantOf)
    return {
      record: reportOf(found),
      members: (members ?? []).map(memberOf),
      rounds: (roundRows ?? []).map(roundOf).map(round => ({
        round,
        participants: participants.filter(p => p.roundId === round.id),
      })),
      reviews: (reviewRows ?? []).map(reviewRecordOf),
      revisions: (revisionRows ?? []).map(revisionOf),
    }
  },
  listReportsForMember: async (db, userId) =>
    (
      await rows(
        db,
        `${REPORT_SELECT} WHERE r.id IN (SELECT report_id FROM report_members WHERE user_id = ?)
          ORDER BY r.created_at, r.id`,
        userId,
      )
    ).map(reportOf),
  listMembers: async (db, reportId) =>
    (await rows(db, MEMBERS_SELECT, reportId)).map(memberOf),
  getMembership: async (db, reportId, userId) => {
    const found = await row(
      db,
      'SELECT role_id FROM report_members WHERE report_id = ? AND user_id = ?',
      reportId,
      userId,
    )
    return found === null ? null : { roleId: s(found['role_id']) }
  },
  addMember: async (db, input) => {
    const outcome = await runBatch(db, [
      {
        sql: `INSERT INTO report_members (report_id, user_id, role_id, added_by, added_at)
          SELECT ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM reports WHERE id = ? AND state <> 'archived')
          AND NOT EXISTS (SELECT 1 FROM report_members WHERE report_id = ? AND user_id = ?)
          AND NOT EXISTS (SELECT 1 FROM round_participants p JOIN review_rounds r ON r.id = p.round_id
            WHERE r.report_id = ? AND r.state = 'open' AND p.user_id = ? AND p.removed_at IS NULL)`,
        values: [
          input.reportId,
          input.userId,
          input.roleId,
          input.addedBy,
          input.now,
          input.reportId,
          input.reportId,
          input.userId,
          input.reportId,
          input.userId,
        ],
        expectChanges: 1,
      },
      auditStep(input.audit),
    ])
    if (outcome._tag === 'Committed') return { _tag: 'Added' }
    const why = await row(
      db,
      `SELECT (SELECT state FROM reports WHERE id = ?) AS state,
        EXISTS (SELECT 1 FROM report_members WHERE report_id = ? AND user_id = ?) AS member`,
      input.reportId,
      input.reportId,
      input.userId,
    )
    const state = sn(why?.['state'])
    return {
      _tag: 'Refused',
      reason:
        state === null || state === 'archived'
          ? 'archived'
          : b(why?.['member'])
            ? 'already_member'
            : 'reviewer_in_open_round',
    }
  },
  moveReport: async (db, input) => {
    const outcome = await runBatch(db, [
      {
        sql: 'UPDATE reports SET state = ?, updated_at = ? WHERE id = ? AND state = ?',
        values: [input.to, input.now, input.reportId, input.from],
        expectChanges: 1,
      },
      auditStep(input.audit),
    ])
    return outcome._tag === 'Committed'
      ? { _tag: 'Moved' }
      : { _tag: 'Refused', reason: 'wrong_state' }
  },

  // -- working copies
  startWorkingCopy: async (db, input) => {
    const existing = await row(
      db,
      'SELECT * FROM working_copies WHERE report_id = ? AND user_id = ?',
      input.reportId,
      input.userId,
    )
    if (existing !== null) return wcOf(existing)
    const outcome = await runBatch(db, [
      {
        sql: `INSERT INTO working_copies (report_id, user_id, base_draft, save_counter, people,
          started_at, last_saved_at)
          SELECT ?, ?, d.number, 0, d.people, ?, ? FROM drafts d
          WHERE d.report_id = ? AND d.number = ?
          AND EXISTS (SELECT 1 FROM report_members WHERE report_id = ? AND user_id = ?)
          RETURNING *`,
        values: [
          input.reportId,
          input.userId,
          input.now,
          input.now,
          input.reportId,
          input.fromDraft,
          input.reportId,
          input.userId,
        ],
        expectChanges: 1,
      },
      {
        sql: `INSERT INTO working_copy_sections (report_id, user_id, section_id, ordinal,
          content, save_counter, saved_at)
          SELECT ?, ?, section_id, ordinal, content, 0, ? FROM draft_sections
          WHERE report_id = ? AND draft_number = ?`,
        values: [
          input.reportId,
          input.userId,
          input.now,
          input.reportId,
          input.fromDraft,
        ],
      },
    ])
    if (outcome._tag === 'Committed') {
      const created = outcome.results[0]?.rows[0]
      return created === undefined ? null : wcOf(created)
    }
    // NOTE: lost a race with another start (same author, other tab), or the
    // draft or the membership is not there.
    const raced = await row(
      db,
      'SELECT * FROM working_copies WHERE report_id = ? AND user_id = ?',
      input.reportId,
      input.userId,
    )
    return raced === null ? null : wcOf(raced)
  },
  getWorkingCopy: async (db, reportId, userId) => {
    const found = await row(db, WORKING_COPY_ONE, reportId, userId)
    return found === null ? null : wcOf(found)
  },
  getWorkingCopyWithSection: async (db, reportId, userId, sectionId) => {
    const [copy, section] = await readBatch(db, [
      { sql: WORKING_COPY_ONE, values: [reportId, userId] },
      { sql: WORKING_COPY_SECTION, values: [reportId, userId, sectionId] },
    ])
    const foundCopy = copy?.[0]
    const foundSection = section?.[0]
    return {
      copy: foundCopy === undefined ? null : wcOf(foundCopy),
      section: foundSection === undefined ? null : wcSectionOf(foundSection),
    }
  },
  listWorkingCopySections: async (db, reportId, userId) =>
    (
      await rows(
        db,
        `SELECT section_id, ordinal, length(CAST(content AS BLOB)) AS bytes, save_counter
          FROM working_copy_sections WHERE report_id = ? AND user_id = ?
          ORDER BY ordinal, section_id`,
        reportId,
        userId,
      )
    ).map(r => ({
      sectionId: s(r['section_id']),
      ordinal: n(r['ordinal']),
      bytes: n(r['bytes']),
      version: n(r['save_counter']),
    })),
  getWorkingCopySection: async (db, reportId, userId, sectionId) => {
    const found = await row(db, WORKING_COPY_SECTION, reportId, userId, sectionId)
    return found === null ? null : wcSectionOf(found)
  },
  // NOTE: one guard on the working copy's save counter, then one upsert per
  // section: 2 + sections queries (one section per save in practice, at most
  // MAX_SECTIONS_PER_SAVE).
  saveWorkingCopy: async (db, input) => {
    if (input.sections.length > MAX_SECTIONS_PER_SAVE) {
      throw new Error(
        `At most ${MAX_SECTIONS_PER_SAVE} sections can be saved in one call.`,
      )
    }
    const outcome = await runBatch(db, [
      {
        sql: `UPDATE working_copies SET save_counter = save_counter + 1, last_saved_at = ?,
          people = COALESCE(?, people)
          WHERE report_id = ? AND user_id = ? AND save_counter = ? RETURNING save_counter`,
        values: [
          input.now,
          input.people ?? null,
          input.reportId,
          input.userId,
          input.expectedCounter,
        ],
        expectChanges: 1,
      },
      ...input.sections.map<GuardedStep>(section => ({
        sql: `INSERT INTO working_copy_sections (report_id, user_id, section_id, ordinal,
          content, save_counter, saved_at)
          SELECT report_id, user_id, ?, ?, ?, save_counter, ? FROM working_copies
          WHERE report_id = ? AND user_id = ?
          ON CONFLICT (report_id, user_id, section_id) DO UPDATE SET
            ordinal = excluded.ordinal, content = excluded.content,
            save_counter = excluded.save_counter, saved_at = excluded.saved_at`,
        values: [
          section.sectionId,
          section.ordinal,
          section.content,
          input.now,
          input.reportId,
          input.userId,
        ],
      })),
    ])
    if (outcome._tag === 'Conflict') {
      return { _tag: 'Refused', reason: 'stale_save' }
    }
    return {
      _tag: 'Saved',
      saveCounter: n(outcome.results[0]?.rows[0]?.['save_counter']),
    }
  },
  getWorkingCopyContents: async (db, reportId, userId) =>
    (
      await rows(
        db,
        `SELECT section_id, ordinal, content, save_counter FROM working_copy_sections
          WHERE report_id = ? AND user_id = ? ORDER BY ordinal, section_id`,
        reportId,
        userId,
      )
    ).map(r => ({
      sectionId: s(r['section_id']),
      ordinal: n(r['ordinal']),
      content: s(r['content']),
      version: n(r['save_counter']),
    })),
  // NOTE: 5 queries with the diagnosis: the guarded counter bump, the removal of sections that
  // are no longer there and one upsert of every section from a JSON list.
  rebaseWorkingCopy: async (db, input) => {
    const list = JSON.stringify(input.sections)
    const outcome = await runBatch(db, [
      {
        sql: `UPDATE working_copies SET base_draft = ?, people = ?,
          save_counter = save_counter + 1, last_saved_at = ?,
          shared_counter = CASE WHEN ? = 1 THEN save_counter + 1 ELSE shared_counter END
          WHERE report_id = ? AND user_id = ? AND save_counter = ?
          AND EXISTS (SELECT 1 FROM drafts WHERE report_id = ? AND number = ?)
          RETURNING save_counter`,
        values: [
          input.baseDraft,
          input.people,
          input.now,
          flag(input.markShared === true),
          input.reportId,
          input.userId,
          input.expectedCounter,
          input.reportId,
          input.baseDraft,
        ],
        expectChanges: 1,
      },
      {
        sql: `DELETE FROM working_copy_sections WHERE report_id = ? AND user_id = ?
          AND section_id NOT IN (SELECT json_extract(j.value, '$.sectionId') FROM json_each(?) j)`,
        values: [input.reportId, input.userId, list],
      },
      {
        sql: `INSERT INTO working_copy_sections (report_id, user_id, section_id, ordinal,
          content, save_counter, saved_at)
          SELECT w.report_id, w.user_id, json_extract(j.value, '$.sectionId'),
            json_extract(j.value, '$.ordinal'), json_extract(j.value, '$.content'),
            w.save_counter, ?
          FROM working_copies w, json_each(?) j
          WHERE w.report_id = ? AND w.user_id = ?
          ON CONFLICT (report_id, user_id, section_id) DO UPDATE SET
            ordinal = excluded.ordinal, content = excluded.content,
            save_counter = excluded.save_counter, saved_at = excluded.saved_at`,
        values: [input.now, list, input.reportId, input.userId],
      },
    ])
    if (outcome._tag === 'Committed') {
      return {
        _tag: 'Saved',
        saveCounter: n(outcome.results[0]?.rows[0]?.['save_counter']),
      }
    }
    const draft = await row(
      db,
      'SELECT 1 AS ok FROM drafts WHERE report_id = ? AND number = ?',
      input.reportId,
      input.baseDraft,
    )
    return draft === null
      ? { _tag: 'Refused', reason: 'no_draft' }
      : { _tag: 'Refused', reason: 'stale_save' }
  },
  listDrafting: async (db, reportId) =>
    (
      await rows(
        db,
        `SELECT w.user_id, u.name, w.base_draft, w.last_saved_at,
          w.save_counter > w.shared_counter AS unshared FROM working_copies w
          JOIN users u ON u.id = w.user_id WHERE w.report_id = ?
          ORDER BY w.last_saved_at DESC, w.user_id`,
        reportId,
      )
    ).map(r => ({
      userId: s(r['user_id']),
      name: s(r['name']),
      baseDraft: n(r['base_draft']),
      lastSavedAt: n(r['last_saved_at']),
      unshared: b(r['unshared']),
    })),

  // -- sharing
  // NOTE: the original text never crosses the Worker: it is copied from the
  // working copy inside SQL, guarded on the section's version, so the staged
  // original and the redacted text the handler made from it always match.
  // 2 queries.
  stageShareSection: async (db, input) => {
    const outcome = await runBatch(db, [
      {
        sql: `INSERT INTO share_staging (share_id, report_id, user_id, section_id, ordinal,
          content, redacted_content, redacted_hash, image_refs, staged_at, people_hash)
          SELECT ?, w.report_id, w.user_id, w.section_id, w.ordinal, w.content, ?, ?, ?, ?, ?
          FROM working_copy_sections w
          WHERE w.report_id = ? AND w.user_id = ? AND w.section_id = ? AND w.save_counter = ?
          AND (SELECT people FROM working_copies
            WHERE report_id = w.report_id AND user_id = w.user_id) = ?
          AND NOT EXISTS (SELECT 1 FROM share_staging x WHERE x.share_id = ?
            AND x.section_id <> w.section_id AND x.people_hash <> ?)
          ON CONFLICT (share_id, section_id) DO UPDATE SET ordinal = excluded.ordinal,
            content = excluded.content, redacted_content = excluded.redacted_content,
            redacted_hash = excluded.redacted_hash, image_refs = excluded.image_refs,
            staged_at = excluded.staged_at, people_hash = excluded.people_hash
            WHERE share_staging.report_id = excluded.report_id
            AND share_staging.user_id = excluded.user_id`,
        values: [
          input.shareId,
          input.redactedContent,
          input.redactedHash,
          input.imageRefs,
          input.now,
          input.peopleHash,
          input.reportId,
          input.userId,
          input.sectionId,
          input.sectionVersion,
          input.people,
          input.shareId,
          input.peopleHash,
        ],
        expectChanges: 1,
      },
    ])
    return outcome._tag === 'Committed'
      ? { _tag: 'Staged' }
      : { _tag: 'Refused', reason: 'changed' }
  },
  // NOTE: the draft is built in SQL from the staged sections. The guard
  // inserts the draft only if the working copy is based on the latest draft,
  // the staged count is the expected one and the share ID is new; the number
  // is allocated inside the insert. A second guard checks the sections
  // copied. "Share and publish" adds `publishSteps` to the same batch.
  // 8 queries, 17 with publishing, plus one diagnosing read on a refusal.
  finishShare: async (db, input): Promise<FinishShareOutcome> => {
    const newDraft: Expr = {
      sql: '(SELECT number FROM drafts WHERE report_id = ? AND share_id = ?)',
      values: [input.reportId, input.shareId],
    }
    const steps = compact<GuardedStep>([
      {
        sql: `INSERT INTO drafts (report_id, number, base_number, author_id, shared_at,
          share_id, people, case_title_redacted, case_reference_redacted)
          SELECT w.report_id, (SELECT MAX(number) + 1 FROM drafts WHERE report_id = w.report_id),
            ?, w.user_id, ?, ?, w.people, ?, ?
          FROM working_copies w JOIN reports r ON r.id = w.report_id
          WHERE w.report_id = ? AND w.user_id = ? AND w.base_draft = ? AND r.state <> 'archived'
          AND w.people = ?
          AND EXISTS (SELECT 1 FROM case_files cf WHERE cf.id = r.case_file_id
            AND cf.title = ? AND cf.reference = ?)
          AND NOT EXISTS (SELECT 1 FROM share_staging WHERE share_id = ? AND people_hash <> ?)
          AND (SELECT MAX(number) FROM drafts WHERE report_id = w.report_id) = ?
          AND (SELECT COUNT(*) FROM share_staging
            WHERE share_id = ? AND report_id = w.report_id AND user_id = w.user_id) = ?
          AND NOT EXISTS (SELECT 1 FROM drafts WHERE report_id = w.report_id AND share_id = ?)
          RETURNING number`,
        values: [
          input.baseDraft,
          input.now,
          input.shareId,
          input.redactedCaseTitle,
          input.redactedCaseReference,
          input.reportId,
          input.userId,
          input.baseDraft,
          input.people,
          input.caseGuard.title,
          input.caseGuard.reference,
          input.shareId,
          input.peopleHash,
          input.baseDraft,
          input.shareId,
          input.expectedSections,
          input.shareId,
        ],
        expectChanges: 1,
      },
      {
        sql: `INSERT INTO draft_sections (report_id, draft_number, section_id, ordinal, content,
          redacted_content, redacted_hash)
          SELECT s.report_id, d.number, s.section_id, s.ordinal, s.content, s.redacted_content,
            s.redacted_hash
          FROM share_staging s JOIN drafts d ON d.report_id = s.report_id AND d.share_id = s.share_id
          WHERE s.share_id = ? AND s.report_id = ?`,
        values: [input.shareId, input.reportId],
        expectChanges: input.expectedSections,
      },
      {
        sql: `INSERT INTO draft_images (report_id, draft_number, image_id, safe)
          SELECT s.report_id, d.number, json_extract(j.value, '$.id'),
            MIN(json_extract(j.value, '$.safe'))
          FROM share_staging s JOIN drafts d ON d.report_id = s.report_id AND d.share_id = s.share_id,
            json_each(s.image_refs) j
          WHERE s.share_id = ? AND s.report_id = ?
          GROUP BY json_extract(j.value, '$.id')`,
        values: [input.shareId, input.reportId],
      },
      {
        sql: `UPDATE working_copies SET base_draft = ${newDraft.sql}
          WHERE report_id = ? AND user_id = ?`,
        values: [...newDraft.values, input.reportId, input.userId],
      },
      input.confirmation === undefined
        ? null
        : {
            // NOTE: the confirmation is recorded for the new draft only while
            // the staged redacted content is the content the author saw.
            sql: `INSERT INTO redaction_confirmations (report_id, draft_number, confirmed_by, confirmed_at)
              SELECT ?, ${newDraft.sql}, ?, ?
              WHERE (SELECT group_concat(redacted_hash, ',') FROM
                (SELECT redacted_hash FROM share_staging WHERE share_id = ? AND report_id = ?
                  ORDER BY ordinal, section_id)) = ?`,
            values: [
              input.reportId,
              ...newDraft.values,
              input.confirmation.confirmedBy,
              input.now,
              input.shareId,
              input.reportId,
              input.confirmation.joinedHashes,
            ],
            expectChanges: 1,
          },
      input.confirmation === undefined
        ? null
        : auditStep(
            { ...input.confirmation.audit, reportId: input.reportId },
            { draft: newDraft },
          ),
      {
        // NOTE: shared up to the newest section that still has the staged
        // content; a section saved after staging keeps the copy "unshared".
        sql: `UPDATE working_copies SET shared_counter = COALESCE(
            (SELECT MAX(w.save_counter) FROM working_copy_sections w
              JOIN share_staging s ON s.report_id = w.report_id AND s.user_id = w.user_id
                AND s.section_id = w.section_id AND s.content = w.content
              WHERE s.share_id = ?), 0)
          WHERE report_id = ? AND user_id = ?`,
        values: [input.shareId, input.reportId, input.userId],
      },
      {
        sql: 'DELETE FROM share_staging WHERE share_id = ? AND report_id = ?',
        values: [input.shareId, input.reportId],
      },
      auditStep(
        { ...input.audit, reportId: input.reportId },
        { draft: newDraft },
      ),
      ...(input.publish === undefined
        ? []
        : publishSteps(input.reportId, newDraft, false, input.publish)),
    ])
    const outcome = await runBatch(db, steps)
    if (outcome._tag === 'Committed') {
      return {
        _tag: 'Shared',
        number: n(outcome.results[0]?.rows[0]?.['number']),
        revision: input.publish?.revision ?? null,
      }
    }
    const why = await row(
      db,
      `SELECT
        (SELECT number FROM drafts WHERE report_id = ? AND share_id = ?) AS existing,
        (SELECT base_draft FROM working_copies WHERE report_id = ? AND user_id = ?) AS wc_base,
        (SELECT state FROM reports WHERE id = ?) AS state,
        (SELECT MAX(number) FROM drafts WHERE report_id = ?) AS latest,
        (SELECT COUNT(*) FROM share_staging WHERE share_id = ? AND report_id = ? AND user_id = ?) AS staged,
        (SELECT COUNT(*) FROM share_staging WHERE share_id = ? AND report_id = ? AND user_id = ?
          AND ? = (SELECT group_concat(redacted_hash, ',') FROM
            (SELECT redacted_hash FROM share_staging WHERE share_id = ? AND report_id = ? ORDER BY ordinal, section_id))) AS confirmed,
        (SELECT COUNT(*) FROM working_copies WHERE report_id = ? AND user_id = ? AND people = ?) AS people_same,
        (SELECT COUNT(*) FROM share_staging WHERE share_id = ? AND people_hash <> ?) AS people_mixed,
        (SELECT COUNT(*) FROM case_files cf JOIN reports rp ON rp.case_file_id = cf.id
          WHERE rp.id = ? AND cf.title = ? AND cf.reference = ?) AS case_same,
        (SELECT COALESCE(MAX(number), 0) FROM revisions WHERE report_id = ?) AS last_revision,
        (SELECT COUNT(*) FROM report_members m, json_each(?) j
          WHERE m.report_id = ? AND m.user_id = json_extract(j.value, '$.userId')) AS overlap`,
      input.reportId,
      input.shareId,
      input.reportId,
      input.userId,
      input.reportId,
      input.reportId,
      input.shareId,
      input.reportId,
      input.userId,
      input.shareId,
      input.reportId,
      input.userId,
      input.confirmation?.joinedHashes ?? '',
      input.shareId,
      input.reportId,
      input.reportId,
      input.userId,
      input.people,
      input.shareId,
      input.peopleHash,
      input.reportId,
      input.caseGuard.title,
      input.caseGuard.reference,
      input.reportId,
      JSON.stringify(input.publish?.participants ?? []),
      input.reportId,
    )
    if (why?.['existing'] !== null && why?.['existing'] !== undefined) {
      return { _tag: 'AlreadyShared', number: n(why['existing']) }
    }
    const state = sn(why?.['state'])
    if (
      why?.['wc_base'] === null ||
      why?.['wc_base'] === undefined ||
      state === null
    ) {
      return { _tag: 'Refused', reason: 'no_working_copy' }
    }
    if (state === 'archived') return { _tag: 'Refused', reason: 'wrong_state' }
    const latest = n(why['latest'])
    if (n(why['wc_base']) !== input.baseDraft || latest !== input.baseDraft) {
      return { _tag: 'Refused', reason: 'stale_base', latest }
    }
    if (n(why['people_same']) === 0 || n(why['people_mixed']) > 0) {
      return { _tag: 'Refused', reason: 'people_changed' }
    }
    if (n(why['case_same']) === 0) {
      return { _tag: 'Refused', reason: 'case_changed' }
    }
    if (n(why['staged']) !== input.expectedSections) {
      return { _tag: 'Refused', reason: 'share_incomplete' }
    }
    if (input.confirmation !== undefined && n(why['confirmed']) === 0) {
      return { _tag: 'Refused', reason: 'not_confirmed' }
    }
    if (
      input.publish?.requiresConfirmation === true &&
      input.confirmation === undefined
    ) {
      return { _tag: 'Refused', reason: 'not_confirmed' }
    }
    if (input.publish !== undefined) {
      if (!input.publish.fromStates.includes(state as never)) {
        return { _tag: 'Refused', reason: 'wrong_state' }
      }
      if (n(why['last_revision']) !== input.publish.revision - 1) {
        return { _tag: 'Refused', reason: 'revision_number' }
      }
      if (n(why['overlap']) > 0) {
        return { _tag: 'Refused', reason: 'participant_is_author' }
      }
    }
    return { _tag: 'Refused', reason: 'share_incomplete' }
  },

  // -- drafts and revisions
  getDraft: async (db, reportId, number) => {
    const found = await row(db, DRAFT_ONE, reportId, number)
    return found === null ? null : draftOf(found)
  },
  getDraftWithSections: async (db, reportId, number) => {
    const [draft, sections] = await readBatch(db, [
      { sql: DRAFT_ONE, values: [reportId, number] },
      { sql: DRAFT_SECTIONS, values: [reportId, number] },
    ])
    const found = draft?.[0]
    return found === undefined
      ? null
      : { draft: draftOf(found), sections: (sections ?? []).map(draftSectionOf) }
  },
  getDraftOutline: async (db, reportId, number, view) => {
    const column = view === 'original' ? 'content' : 'redacted_content'
    const [draft, sections] = await readBatch(db, [
      { sql: DRAFT_ONE, values: [reportId, number] },
      {
        sql: `SELECT section_id, ordinal, length(CAST(${column} AS BLOB)) AS bytes,
          json_type(${column}, '$.notApplicable') IS NOT NULL AS not_applicable
          FROM draft_sections WHERE report_id = ? AND draft_number = ?
          ORDER BY ordinal, section_id`,
        values: [reportId, number],
      },
    ])
    const found = draft?.[0]
    return {
      draft: found === undefined ? null : draftOf(found),
      sections: (sections ?? []).map(r => ({
        sectionId: s(r['section_id']),
        ordinal: n(r['ordinal']),
        bytes: n(r['bytes']),
        notApplicable: n(r['not_applicable']) === 1,
      })),
    }
  },
  listDrafts: async (db, reportId) =>
    (
      await rows(
        db,
        `${DRAFT_SELECT} WHERE d.report_id = ? ORDER BY d.number`,
        reportId,
      )
    ).map(draftOf),
  listDraftSections: async (db, reportId, number) =>
    (await rows(db, DRAFT_SECTIONS, reportId, number)).map(draftSectionOf),
  getDraftSection: async (db, reportId, number, sectionId, view) => {
    const found = await row(
      db,
      `SELECT ${view === 'original' ? 'content' : 'redacted_content'} AS text FROM draft_sections
        WHERE report_id = ? AND draft_number = ? AND section_id = ?`,
      reportId,
      number,
      sectionId,
    )
    return found === null ? null : s(found['text'])
  },
  getDraftContents: async (db, reportId, number, view) =>
    (
      await rows(
        db,
        `SELECT section_id, ordinal, ${view === 'original' ? 'content' : 'redacted_content'} AS text,
          redacted_hash FROM draft_sections WHERE report_id = ? AND draft_number = ?
          ORDER BY ordinal, section_id`,
        reportId,
        number,
      )
    ).map(r => ({
      sectionId: s(r['section_id']),
      ordinal: n(r['ordinal']),
      content: s(r['text']),
      version: s(r['redacted_hash']),
    })),
  listRedactedHashes: async (db, reportId) =>
    (
      await rows(
        db,
        `SELECT draft_number, group_concat(redacted_hash, ',') AS hash FROM
          (SELECT draft_number, redacted_hash FROM draft_sections WHERE report_id = ?
            ORDER BY draft_number, ordinal, section_id)
          GROUP BY draft_number ORDER BY draft_number`,
        reportId,
      )
    ).map(r => ({ draftNumber: n(r['draft_number']), hash: s(r['hash']) })),
  confirmRedaction: async (db, input) => {
    const outcome = await runBatch(db, [
      {
        sql: `INSERT INTO redaction_confirmations (report_id, draft_number, confirmed_by, confirmed_at)
          SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM drafts WHERE report_id = ? AND number = ?)
          AND NOT EXISTS (SELECT 1 FROM redaction_confirmations WHERE report_id = ? AND draft_number = ?)`,
        values: [
          input.reportId,
          input.draftNumber,
          input.confirmedBy,
          input.now,
          input.reportId,
          input.draftNumber,
          input.reportId,
          input.draftNumber,
        ],
      },
      auditStep(input.audit, {
        where: { sql: '(SELECT changes()) = 1', values: [] },
      }),
    ])
    if (outcome._tag === 'Committed' && outcome.results[0]?.changes === 1) {
      return true
    }
    const exists = await row(
      db,
      'SELECT EXISTS (SELECT 1 FROM drafts WHERE report_id = ? AND number = ?) AS e',
      input.reportId,
      input.draftNumber,
    )
    return b(exists?.['e'])
  },
  getRevision: async (db, reportId, number) => {
    const found = await row(
      db,
      'SELECT * FROM revisions WHERE report_id = ? AND number = ?',
      reportId,
      number,
    )
    return found === null ? null : revisionOf(found)
  },
  listRevisions: async (db, reportId) =>
    (
      await rows(
        db,
        'SELECT * FROM revisions WHERE report_id = ? ORDER BY number',
        reportId,
      )
    ).map(revisionOf),
  getRevisionSection: async (db, reportId, revision, sectionId, view) => {
    const found = await row(
      db,
      `SELECT ${view === 'original' ? 's.content' : 's.redacted_content'} AS text
        FROM revisions v JOIN draft_sections s
          ON s.report_id = v.report_id AND s.draft_number = v.draft_number
        WHERE v.report_id = ? AND v.number = ? AND s.section_id = ?`,
      reportId,
      revision,
      sectionId,
    )
    return found === null ? null : s(found['text'])
  },
  listRevisionSections: async (db, reportId, revision) =>
    (
      await rows(
        db,
        `SELECT s.section_id, s.ordinal, length(CAST(s.content AS BLOB)) AS bytes, s.redacted_hash
          FROM revisions v JOIN draft_sections s
            ON s.report_id = v.report_id AND s.draft_number = v.draft_number
          WHERE v.report_id = ? AND v.number = ? ORDER BY s.ordinal, s.section_id`,
        reportId,
        revision,
      )
    ).map(r => ({
      sectionId: s(r['section_id']),
      ordinal: n(r['ordinal']),
      bytes: n(r['bytes']),
      version: s(r['redacted_hash']),
    })),

  // -- publishing and rounds
  publishRevision: async (db, input): Promise<PublishOutcome> => {
    if (input.draft === undefined) {
      throw new Error('publishRevision needs the draft to publish.')
    }
    const draft: Expr = { sql: '?', values: [input.draft] }
    const outcome = await runBatch(
      db,
      publishSteps(input.reportId, draft, true, input),
    )
    if (outcome._tag === 'Committed') {
      return {
        _tag: 'Published',
        revision: input.revision,
        roundId: input.roundId,
      }
    }
    const why = await row(
      db,
      PUBLISH_DIAGNOSIS,
      input.reportId,
      input.reportId,
      input.reportId,
      JSON.stringify(input.participants),
      input.reportId,
    )
    const state = sn(why?.['state'])
    if (state === null || !input.fromStates.includes(state as never)) {
      return { _tag: 'Refused', reason: 'wrong_state' }
    }
    if (nn(why?.['latest']) !== input.draft) {
      return { _tag: 'Refused', reason: 'not_latest' }
    }
    if (n(why?.['last_revision']) !== input.revision - 1) {
      return { _tag: 'Refused', reason: 'revision_number' }
    }
    if (input.requiresConfirmation === true) {
      const confirmed = await row(
        db,
        'SELECT 1 AS ok FROM redaction_confirmations WHERE report_id = ? AND draft_number = ?',
        input.reportId,
        input.draft,
      )
      if (confirmed === null) return { _tag: 'Refused', reason: 'not_confirmed' }
    }
    return { _tag: 'Refused', reason: 'participant_is_author' }
  },
  getRound: async (db, reportId, revision) => {
    const found = await row(
      db,
      'SELECT * FROM review_rounds WHERE report_id = ? AND revision_number = ?',
      reportId,
      revision,
    )
    return found === null
      ? null
      : withParticipants(db, [roundOf(found)]).then(l => l[0] ?? null)
  },
  getOpenRound: async (db, reportId) => {
    const found = await row(
      db,
      `SELECT * FROM review_rounds WHERE report_id = ? AND state = 'open'`,
      reportId,
    )
    return found === null
      ? null
      : withParticipants(db, [roundOf(found)]).then(l => l[0] ?? null)
  },
  listRounds: async (db, reportId) =>
    withParticipants(
      db,
      (
        await rows(
          db,
          'SELECT * FROM review_rounds WHERE report_id = ? ORDER BY revision_number',
          reportId,
        )
      ).map(roundOf),
      reportId,
    ),
  getParticipation: async (db, reportId, revision, userId) => {
    const found = await row(
      db,
      `SELECT r.*, p.role_id, p.removed_at, v.draft_number
        FROM review_rounds r JOIN round_participants p ON p.round_id = r.id
        JOIN revisions v ON v.report_id = r.report_id AND v.number = r.revision_number
        WHERE r.report_id = ? AND r.revision_number = ? AND p.user_id = ?`,
      reportId,
      revision,
      userId,
    )
    return found === null
      ? null
      : {
          round: roundOf(found),
          roleId: s(found['role_id']),
          removedAt: nn(found['removed_at']),
          draftNumber: n(found['draft_number']),
        }
  },
  listAssignments: async (db, userId) =>
    (
      await rows(
        db,
        `SELECT r.id, r.report_id, r.revision_number, r.state, r.deadline_at, r.closing,
          p.role_id, p.removed_at
          FROM round_participants p JOIN review_rounds r ON r.id = p.round_id
          WHERE p.user_id = ? ORDER BY r.report_id, r.revision_number`,
        userId,
      )
    ).map((r): AssignmentRecord => ({
      reportId: s(r['report_id']),
      revision: n(r['revision_number']),
      roundId: s(r['id']),
      roleId: s(r['role_id']),
      removedAt: nn(r['removed_at']),
      roundState: s(r['state']) as AssignmentRecord['roundState'],
      deadlineAt: n(r['deadline_at']),
      closing: b(r['closing']),
    })),
  listReviewerRounds: async (db, userId, options) =>
    (
      await rows(
        db,
        `SELECT r.report_id, r.revision_number, r.id AS round_id, r.closing, r.state,
          r.deadline_at, r.deadline_zone, cf.reference,
          (SELECT d.case_reference_redacted FROM drafts d
            WHERE d.report_id = r.report_id AND d.number = v.draft_number) AS reference_redacted,
          rep.template_id, rep.template_version,
          v.published_at, p.role_id,
          (SELECT decision FROM reviews WHERE round_id = r.id AND reviewer_id = p.user_id
            AND decision <> 'comment' ORDER BY sent_at DESC, id DESC LIMIT 1) AS decision,
          (SELECT decision FROM pending_reviews WHERE round_id = r.id AND reviewer_id = p.user_id
            AND r.state = 'open') AS pending_decision,
          (SELECT COUNT(*) FROM comments WHERE round_id = r.id AND author_id = p.user_id
            AND review_id IS NULL AND r.state = 'open') AS pending_comments
          FROM round_participants p
          JOIN review_rounds r ON r.id = p.round_id
          JOIN reports rep ON rep.id = r.report_id
          JOIN case_files cf ON cf.id = rep.case_file_id
          JOIN revisions v ON v.report_id = r.report_id AND v.number = r.revision_number
          WHERE p.user_id = ? AND p.removed_at IS NULL${options.openOnly ? " AND r.state = 'open'" : ''}${
            options.pendingOnly
              ? ` AND r.state = 'open' AND (EXISTS (SELECT 1 FROM pending_reviews q WHERE q.round_id = r.id
                  AND q.reviewer_id = p.user_id AND q.decision IS NOT NULL)
                OR EXISTS (SELECT 1 FROM comments c WHERE c.round_id = r.id
                  AND c.author_id = p.user_id AND c.review_id IS NULL))`
              : ''
          }
          ORDER BY r.deadline_at DESC, r.id LIMIT ? OFFSET ?`,
        userId,
        options.limit,
        options.offset,
      )
    ).map((r): ReviewerRoundRecord => ({
      reportId: s(r['report_id']),
      revision: n(r['revision_number']),
      roundId: s(r['round_id']),
      closing: b(r['closing']),
      roundState: s(r['state']) as ReviewerRoundRecord['roundState'],
      deadlineAt: n(r['deadline_at']),
      deadlineZone: s(r['deadline_zone']),
      caseReference: s(r['reference']),
      caseReferenceRedacted: s(r['reference_redacted']),
      templateId: s(r['template_id']),
      templateVersion: n(r['template_version']),
      publishedAt: n(r['published_at']),
      roleId: s(r['role_id']),
      decision: sn(r['decision']) as ReviewerRoundRecord['decision'],
      pendingDecision: sn(
        r['pending_decision'],
      ) as ReviewerRoundRecord['pendingDecision'],
      pendingComments: n(r['pending_comments']),
    })),
  listStagedSections: async (db, shareId, reportId, userId) =>
    (
      await rows(
        db,
        `SELECT section_id, ordinal, redacted_hash, people_hash FROM share_staging
          WHERE share_id = ? AND report_id = ? AND user_id = ? ORDER BY ordinal, section_id`,
        shareId,
        reportId,
        userId,
      )
    ).map(r => ({
      sectionId: s(r['section_id']),
      ordinal: n(r['ordinal']),
      redactedHash: s(r['redacted_hash']),
      peopleHash: s(r['people_hash']),
    })),
  // NOTE: the decision is guarded on what it was made from: the round is open
  // with the deadline the handler read (a concurrent extension makes it
  // `changed`, and the handler reads again), the deadline has passed for a
  // decision by the deadline, and the reviews and the people are the ones the
  // rule was evaluated with.
  decideRound: async (db, input) => {
    const outcome = await runBatch(db, decideSteps(input))
    if (outcome._tag === 'Committed') return { _tag: 'Decided' }
    const open = await row(
      db,
      `SELECT EXISTS (SELECT 1 FROM review_rounds WHERE id = ? AND state = 'open') AS o`,
      input.roundId,
    )
    return { _tag: 'Refused', reason: b(open?.['o']) ? 'changed' : 'not_open' }
  },
  extendDeadline: async (db, input) => {
    const outcome = await runBatch(
      db,
      compact<GuardedStep>([
        {
          sql: `UPDATE review_rounds SET deadline_at = ?, deadline_zone = ?
            WHERE id = ? AND state = 'open' AND deadline_at < ?`,
          values: [
            input.deadlineAt,
            input.deadlineZone,
            input.roundId,
            input.deadlineAt,
          ],
          expectChanges: 1,
        },
        {
          sql: `UPDATE reports SET deadline_at = ?, deadline_zone = ?, updated_at = ? WHERE id = ?`,
          values: [
            input.deadlineAt,
            input.deadlineZone,
            input.now,
            input.reportId,
          ],
        },
        insertJobsStep(input.reportId, input.roundId, input.jobs, input.now),
        auditStep(input.audit),
      ]),
    )
    if (outcome._tag === 'Committed') return { _tag: 'Extended' }
    const open = await row(
      db,
      `SELECT EXISTS (SELECT 1 FROM review_rounds WHERE id = ? AND state = 'open') AS o`,
      input.roundId,
    )
    return {
      _tag: 'Refused',
      reason: b(open?.['o']) ? 'not_later' : 'not_open',
    }
  },
  removeParticipant: async (db, input) => {
    const outcome = await runBatch(db, compact<GuardedStep>([
      {
        sql: `UPDATE round_participants SET removed_at = ?, removed_by = ?
          WHERE round_id = ? AND user_id = ? AND removed_at IS NULL
          AND EXISTS (SELECT 1 FROM review_rounds WHERE id = ? AND state = 'open')`,
        values: [
          input.now,
          input.removedBy,
          input.roundId,
          input.userId,
          input.roundId,
        ],
        expectChanges: 1,
      },
      {
        sql: `UPDATE notification_jobs SET state = 'skipped'
          WHERE round_id = ? AND recipient_id = ? AND state = 'pending'
          AND kind IN (${SKIPPABLE_SQL})`,
        values: [input.roundId, input.userId],
      },
      insertJobsStep(input.reportId, input.roundId, input.jobs ?? [], input.now),
      auditStep(input.audit),
      ...(input.decide === undefined
        ? []
        : decideSteps({
            ...input.decide,
            roundId: input.roundId,
            reportId: input.reportId,
            now: input.now,
          })),
    ]))
    if (outcome._tag === 'Committed') return { _tag: 'Removed' }
    const open = await row(
      db,
      `SELECT EXISTS (SELECT 1 FROM review_rounds WHERE id = ? AND state = 'open') AS o,
        EXISTS (SELECT 1 FROM round_participants WHERE round_id = ? AND user_id = ?
          AND removed_at IS NULL) AS p`,
      input.roundId,
      input.roundId,
      input.userId,
    )
    if (!b(open?.['o'])) return { _tag: 'Refused', reason: 'not_open' }
    return {
      _tag: 'Refused',
      reason: b(open?.['p']) ? 'changed' : 'not_a_participant',
    }
  },

  // -- reviews and comments
  savePendingReview: async (db, input) => {
    const outcome = await runBatch(db, [
      {
        sql: `INSERT INTO pending_reviews (round_id, reviewer_id, decision, updated_at)
          SELECT p.round_id, p.user_id, ?, ? FROM round_participants p
          JOIN review_rounds r ON r.id = p.round_id
          WHERE p.round_id = ? AND p.user_id = ? AND p.removed_at IS NULL AND r.state = 'open'
          ON CONFLICT (round_id, reviewer_id) DO UPDATE SET decision = excluded.decision,
            updated_at = excluded.updated_at`,
        values: [input.decision, input.now, input.roundId, input.reviewerId],
        expectChanges: 1,
      },
    ])
    return outcome._tag === 'Committed'
      ? { _tag: 'Saved' }
      : { _tag: 'Refused', reason: 'not_open' }
  },
  getPendingReview: async (db, roundId, reviewerId) => {
    // NOTE: both reads in one round trip.
    const [decisionRows, list = []] = await readBatch(db, [
      {
        sql: 'SELECT decision FROM pending_reviews WHERE round_id = ? AND reviewer_id = ?',
        values: [roundId, reviewerId],
      },
      {
        sql: `${COMMENT_SELECT} WHERE c.round_id = ? AND c.author_id = ? AND c.review_id IS NULL
          ORDER BY c.created_at, c.id`,
        values: [roundId, reviewerId],
      },
    ])
    const pending = decisionRows?.[0]
    return {
      decision: sn(pending?.['decision']) as StoreCommentRecord extends never
        ? never
        : StoreReviewRecord['decision'] | null,
      comments: list.map(commentOf),
    }
  },
  addPendingComment: async (db, input) => {
    const outcome = await runBatch(db, [
      {
        sql: `INSERT INTO comments (id, report_id, target_kind, target_number, round_id,
          section_id, item_id, range_from, range_to, quoted, body, redacted_body, author_id,
          visibility, resolved, review_id, created_at)
          SELECT ?, r.report_id, 'revision', ?, r.id, ?, ?, ?, ?, ?, ?, ?, p.user_id, ?, 0, NULL, ?
          FROM round_participants p JOIN review_rounds r ON r.id = p.round_id
          WHERE p.round_id = ? AND p.user_id = ? AND p.removed_at IS NULL AND r.state = 'open'`,
        values: [
          input.id,
          input.revision,
          input.sectionId,
          input.itemId,
          input.rangeFrom,
          input.rangeTo,
          input.quoted,
          input.body,
          input.redactedBody,
          input.visibility,
          input.now,
          input.roundId,
          input.reviewerId,
        ],
        expectChanges: 1,
      },
      {
        sql: `INSERT INTO pending_reviews (round_id, reviewer_id, decision, updated_at)
          VALUES (?, ?, NULL, ?) ON CONFLICT DO NOTHING`,
        values: [input.roundId, input.reviewerId, input.now],
      },
    ])
    return outcome._tag === 'Committed'
      ? { _tag: 'Added' }
      : { _tag: 'Refused', reason: 'not_open' }
  },
  updatePendingComment: async (db, input) =>
    (
      await runBatch(db, [
        {
          sql: `UPDATE comments SET body = ?, redacted_body = ?, visibility = ?
            WHERE id = ? AND author_id = ? AND review_id IS NULL
            AND round_id IN (SELECT id FROM review_rounds WHERE state = 'open')`,
          values: [
            input.body,
            input.redactedBody ?? null,
            input.visibility,
            input.id,
            input.reviewerId,
          ],
          expectChanges: 1,
        },
      ])
    )._tag === 'Committed',
  getComment: async (db, reportId, commentId) => {
    const found = await row(
      db,
      `${COMMENT_SELECT} WHERE c.id = ? AND c.report_id = ?`,
      commentId,
      reportId,
    )
    return found === null ? null : commentOf(found)
  },
  deletePendingComment: async (db, id, reviewerId) =>
    (
      await rows(
        db,
        `DELETE FROM comments WHERE id = ? AND author_id = ? AND review_id IS NULL
          AND round_id IN (SELECT id FROM review_rounds WHERE state = 'open') RETURNING id`,
        id,
        reviewerId,
      )
    ).length === 1,
  // NOTE: the review is inserted only for an active participant of an open
  // round whose deadline is after `now` (a late cron never lets a review in,
  // constraint 8). The pending comments are attached in the same batch.
  sendReview: async (db, input) => {
    const outcome = await runBatch(
      db,
      compact<GuardedStep>([
        {
          sql: `INSERT INTO reviews (id, round_id, reviewer_id, decision, has_comments, sent_at)
            SELECT ?, p.round_id, p.user_id, ?,
              EXISTS (SELECT 1 FROM comments WHERE round_id = p.round_id
                AND author_id = p.user_id AND review_id IS NULL), ?
            FROM round_participants p JOIN review_rounds r ON r.id = p.round_id
            WHERE p.round_id = ? AND p.user_id = ? AND p.removed_at IS NULL
            AND r.state = 'open' AND r.deadline_at > ?
            RETURNING has_comments`,
          values: [
            input.reviewId,
            input.decision,
            input.now,
            input.roundId,
            input.reviewerId,
            input.now,
          ],
          expectChanges: 1,
        },
        {
          sql: `UPDATE comments SET review_id = ?
            WHERE round_id = ? AND author_id = ? AND review_id IS NULL`,
          values: [input.reviewId, input.roundId, input.reviewerId],
        },
        {
          sql: 'DELETE FROM pending_reviews WHERE round_id = ? AND reviewer_id = ?',
          values: [input.roundId, input.reviewerId],
        },
        insertJobsStep(input.reportId, input.roundId, input.jobs, input.now),
        auditStep(input.audit),
      ]),
    )
    if (outcome._tag === 'Conflict') {
      return { _tag: 'Refused', reason: 'not_open' }
    }
    return {
      _tag: 'Sent',
      hasComments: b(outcome.results[0]?.rows[0]?.['has_comments']),
    }
  },
  listReviews: async (db, reportId) =>
    (await rows(db, REVIEWS_SELECT, reportId)).map(reviewRecordOf),
  addDraftComment: async (db, input) => {
    const inserted = await rows(
      db,
      `INSERT INTO comments (id, report_id, target_kind, target_number, round_id, section_id,
        item_id, range_from, range_to, quoted, body, redacted_body, author_id, visibility,
        resolved, review_id, created_at)
        SELECT ?, d.report_id, 'draft', d.number, NULL, ?, ?, ?, ?, ?, ?, ?, m.user_id,
          'authors', 0, NULL, ?
        FROM drafts d JOIN report_members m ON m.report_id = d.report_id
        WHERE d.report_id = ? AND d.number = ? AND m.user_id = ? RETURNING id`,
      input.id,
      input.sectionId,
      input.itemId,
      input.rangeFrom,
      input.rangeTo,
      input.quoted,
      input.body,
      input.redactedBody,
      input.now,
      input.reportId,
      input.draftNumber,
      input.authorId,
    )
    return inserted.length === 1
      ? { _tag: 'Added' }
      : { _tag: 'Refused', reason: 'not_found' }
  },
  addReply: async (db, input) =>
    (
      await rows(
        db,
        `INSERT INTO comment_replies (id, comment_id, author_id, body, redacted_body, created_at)
          SELECT ?, id, ?, ?, ?, ? FROM comments WHERE id = ? RETURNING id`,
        input.id,
        input.authorId,
        input.body,
        input.redactedBody,
        input.now,
        input.commentId,
      )
    ).length === 1,
  setCommentResolved: async (db, commentId, resolved) =>
    (
      await rows(
        db,
        'UPDATE comments SET resolved = ? WHERE id = ? RETURNING id',
        flag(resolved),
        commentId,
      )
    ).length === 1,
  listComments: async (db, input) => {
    const audience =
      input.audience.kind === 'authors'
        ? {
            sql: `(c.target_kind = 'draft' OR c.review_id IS NOT NULL)`,
            values: [],
          }
        : {
            sql: `(c.author_id = ? OR (c.review_id IS NOT NULL AND c.visibility = 'committee'))`,
            values: [input.audience.userId],
          }
    const list = (
      await rows(
        db,
        `${COMMENT_SELECT} WHERE c.report_id = ? AND c.target_kind = ? AND c.target_number = ?
          AND ${audience.sql} ORDER BY c.created_at, c.id`,
        input.reportId,
        input.kind,
        input.number,
        ...audience.values,
      )
    ).map(commentOf)
    const ids = new Set(list.map(c => c.id))
    const replies = (
      await rows(
        db,
        `SELECT p.id, p.comment_id, p.author_id, u.name AS author_name, p.body,
          p.redacted_body, p.created_at
          FROM comment_replies p JOIN comments c ON c.id = p.comment_id
          JOIN users u ON u.id = p.author_id
          WHERE c.report_id = ? AND c.target_kind = ? AND c.target_number = ?
          ORDER BY p.created_at, p.id`,
        input.reportId,
        input.kind,
        input.number,
      )
    )
      .filter(r => ids.has(s(r['comment_id'])))
      .map((r): ReplyRecord => ({
        id: s(r['id']),
        commentId: s(r['comment_id']),
        authorId: s(r['author_id']),
        authorName: s(r['author_name']),
        body: s(r['body']),
        redactedBody: sn(r['redacted_body']),
        createdAt: n(r['created_at']),
      }))
    return { comments: list, replies }
  },

  // -- jobs, inbox, events, audit
  claimDueJobs: (db, input) => claimJobs(db, input),
  // NOTE: every statement changes only jobs still claimed by this pass. The
  // events come first, from the rows as they are before they become `done`.
  finishJobs: async (db, input) => {
    const mine = `state = 'claimed' AND claimed_by = ?`
    const steps = compact<GuardedStep>([
      input.done.length === 0
        ? null
        : {
            sql: `INSERT INTO report_events (report_id, kind, account_id, draft_number,
              revision_number, at, detail)
              SELECT report_id,
                CASE kind WHEN 'review_request' THEN 'notified' ELSE 'reminded' END,
                recipient_id, NULL, revision_number, ?,
                CASE kind WHEN 'review_request' THEN NULL ELSE kind END
              FROM notification_jobs
              WHERE ${mine} AND recipient_id IS NOT NULL
                AND kind IN ('review_request', 'reminder_first', 'reminder_final')
                AND id IN (SELECT value FROM json_each(?))`,
            values: [input.now, input.claimedBy, JSON.stringify(input.done)],
          },
      input.done.length === 0
        ? null
        : {
            sql: `UPDATE notification_jobs SET state = 'done', done_at = ?, lease_until = NULL
              WHERE ${mine} AND id IN (SELECT value FROM json_each(?))`,
            values: [input.now, input.claimedBy, JSON.stringify(input.done)],
          },
      input.skipped.length === 0
        ? null
        : {
            sql: `UPDATE notification_jobs SET state = 'skipped', done_at = ?, lease_until = NULL
              WHERE ${mine} AND id IN (SELECT value FROM json_each(?))`,
            values: [input.now, input.claimedBy, JSON.stringify(input.skipped)],
          },
      input.failed === undefined || input.failed.length === 0
        ? null
        : {
            sql: `UPDATE notification_jobs SET state = 'failed', lease_until = NULL,
                attempts = attempts + 1,
                retry_at = (SELECT json_extract(f.value, '$.retryAt') FROM json_each(?) f
                  WHERE json_extract(f.value, '$.id') = notification_jobs.id),
                last_error = (SELECT json_extract(f.value, '$.error') FROM json_each(?) f
                  WHERE json_extract(f.value, '$.id') = notification_jobs.id)
              WHERE ${mine} AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
            values: [
              JSON.stringify(input.failed),
              JSON.stringify(input.failed),
              input.claimedBy,
              JSON.stringify(input.failed),
            ],
          },
      input.deferred === undefined || input.deferred.length === 0
        ? null
        : {
            sql: `UPDATE notification_jobs SET state = 'failed', lease_until = NULL,
                deferrals = deferrals + 1,
                retry_at = (SELECT json_extract(f.value, '$.retryAt') FROM json_each(?) f
                  WHERE json_extract(f.value, '$.id') = notification_jobs.id),
                last_error = (SELECT json_extract(f.value, '$.error') FROM json_each(?) f
                  WHERE json_extract(f.value, '$.id') = notification_jobs.id)
              WHERE ${mine} AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
            values: [
              JSON.stringify(input.deferred),
              JSON.stringify(input.deferred),
              input.claimedBy,
              JSON.stringify(input.deferred),
            ],
          },
      input.released === undefined || input.released.length === 0
        ? null
        : {
            sql: `UPDATE notification_jobs SET state = 'pending', claimed_by = NULL,
                lease_until = NULL
              WHERE ${mine} AND id IN (SELECT value FROM json_each(?))`,
            values: [input.claimedBy, JSON.stringify(input.released)],
          },
    ])
    if (steps.length > 0) await runBatch(db, steps)
  },
  listJobKeys: async (db, reportId) =>
    (
      await rows(
        db,
        'SELECT dedupe_key FROM notification_jobs WHERE report_id = ? ORDER BY dedupe_key',
        reportId,
      )
    ).map(r => s(r['dedupe_key']).slice(reportId.length + 1)),
  listInbox: async (db, userId, limit, before) => {
    const read = inboxRead(userId, limit, before)
    return (await rows(db, read.sql, ...read.values)).map(jobOf)
  },
  countUnread: async (db, userId) =>
    n((await row(db, UNREAD_COUNT, userId))?.['c']),
  inboxPage: async (db, userId, limit, before) => {
    const [jobs, unread] = await readBatch(db, [
      inboxRead(userId, limit, before),
      { sql: UNREAD_COUNT, values: [userId] },
    ])
    return { jobs: (jobs ?? []).map(jobOf), unread: n(unread?.[0]?.['c']) }
  },
  markInboxRead: async (db, userId, ids, now) =>
    ids.length === 0
      ? 0
      : (
          await rows(
            db,
            `UPDATE notification_jobs SET read_at = ?
              WHERE recipient_id = ? AND channel = 'inbox' AND state = 'done' AND read_at IS NULL
              AND id IN (SELECT value FROM json_each(?)) RETURNING id`,
            now,
            userId,
            JSON.stringify(ids),
          )
        ).length,
  recordEvent: async (db, event) => {
    const once = event.kind === 'draft_read' || event.kind === 'read'
    await exec(
      db,
      `INSERT INTO report_events (report_id, kind, account_id, draft_number, revision_number, at, detail)
        SELECT ?, ?, ?, ?, ?, ?, ?${
          once
            ? ` WHERE NOT EXISTS (SELECT 1 FROM report_events WHERE report_id = ? AND kind = ?
                AND account_id = ? AND draft_number IS ? AND revision_number IS ?)`
            : ''
        }`,
      event.reportId,
      event.kind,
      event.accountId,
      event.draftNumber ?? null,
      event.revisionNumber ?? null,
      event.at,
      event.detail ?? null,
      ...(once
        ? [
            event.reportId,
            event.kind,
            event.accountId,
            event.draftNumber ?? null,
            event.revisionNumber ?? null,
          ]
        : []),
    )
  },
  listEvents: async (db, reportId, limit) =>
    (
      await rows(
        db,
        `SELECT * FROM (SELECT * FROM report_events WHERE report_id = ?
          ORDER BY id DESC LIMIT ?) ORDER BY id`,
        reportId,
        limit,
      )
    ).map((r): EventRecord => ({
      id: n(r['id']),
      reportId: s(r['report_id']),
      kind: s(r['kind']) as EventRecord['kind'],
      accountId: s(r['account_id']),
      draftNumber: nn(r['draft_number']),
      revisionNumber: nn(r['revision_number']),
      detail: sn(r['detail']),
      at: n(r['at']),
    })),
  appendAudit: async (db, audit) => {
    await runBatch(db, [auditStep(audit)])
  },
  listAudit: async (db, filter) => {
    const conditions: Array<string> = []
    const values: Array<SqlValue> = []
    if (filter.reportId !== undefined) {
      conditions.push('report_id = ?')
      values.push(filter.reportId)
    }
    if (filter.templateId !== undefined) {
      conditions.push('template_id = ?')
      values.push(filter.templateId)
    }
    if (filter.actionPrefix !== undefined) {
      conditions.push('substr(action, 1, ?) = ?')
      values.push(filter.actionPrefix.length, filter.actionPrefix)
    }
    if (filter.before !== undefined) {
      conditions.push('id < ?')
      values.push(filter.before)
    }
    return (
      await rows(
        db,
        `SELECT * FROM audit_events${conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`}
          ORDER BY id DESC LIMIT ?`,
        ...values,
        filter.limit,
      )
    ).map((r): AuditRecord => ({
      id: n(r['id']),
      at: n(r['at']),
      actorId: sn(r['actor_id']),
      reportId: sn(r['report_id']),
      templateId: sn(r['template_id']),
      draftNumber: nn(r['draft_number']),
      revisionNumber: nn(r['revision_number']),
      action: s(r['action']),
      meta: s(r['meta']),
    }))
  },

  // -- images
  // NOTE: one chunk. The checks that need no query (position, length, base64)
  // come first. The guard then checks the image row (same owner, size and
  // count, not complete), the 400 MB total (a running counter, not a scan)
  // and the 20 MB of the report in the same statement that stores the chunk,
  // so two uploads cannot both slip under a limit. 5 queries, 6 on a refusal.
  putImageChunk: async (db, input): Promise<PutChunkOutcome> => {
    if (imageChunkProblem(input) !== null) {
      return { _tag: 'Refused', reason: 'bad_chunk' }
    }
    const ownerKind = input.owner.kind
    const ownerId = input.owner.kind === 'report' ? input.owner.reportId : ''
    const length = input.data.length
    const outcome = await runBatch(db, [
      {
        sql: `INSERT INTO images (id, owner_kind, owner_id, uploaded_by, mime, width, height,
          size_bytes, sha256, chunk_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        values: [
          input.imageId,
          ownerKind,
          ownerId,
          input.uploadedBy,
          input.mime,
          input.width,
          input.height,
          input.size,
          input.hash,
          input.chunkCount,
          input.now,
        ],
      },
      {
        sql: `INSERT OR IGNORE INTO image_chunks (image_id, idx, data)
          SELECT ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM images WHERE id = ? AND owner_kind = ? AND owner_id = ?
            AND size_bytes = ? AND chunk_count = ? AND uploaded_by = ? AND complete = 0)
          AND (SELECT value FROM storage_stats WHERE key = 'image_bytes') + ? <= ?
          AND (? = 'theme' OR (SELECT COALESCE(SUM(size_bytes), 0) FROM images
            WHERE owner_kind = 'report' AND owner_id = ? AND id <> ?) + ? <= ?)`,
        values: [
          input.imageId,
          input.index,
          input.data,
          input.imageId,
          ownerKind,
          ownerId,
          input.size,
          input.chunkCount,
          input.uploadedBy,
          length,
          IMAGE_LIMITS.databaseBytes,
          ownerKind,
          ownerId,
          input.imageId,
          input.size,
          IMAGE_LIMITS.reportBytes,
        ],
        expectChanges: 1,
      },
      {
        sql: `UPDATE images SET chunks_received = chunks_received + 1,
          stored_bytes = stored_bytes + ?,
          complete = CASE WHEN chunks_received + 1 = chunk_count THEN 1 ELSE 0 END
          WHERE id = ? RETURNING *`,
        values: [length, input.imageId],
      },
      {
        sql: `UPDATE storage_stats SET value = value + ? WHERE key = 'image_bytes'`,
        values: [length],
      },
    ])
    if (outcome._tag === 'Committed') {
      const updated = outcome.results[2]?.rows[0] as Row
      const complete = b(updated['complete'])
      return {
        _tag: 'Stored',
        received: n(updated['chunks_received']),
        complete,
        image: complete ? imageOf(updated, false) : null,
      }
    }
    const why = await row(
      db,
      `SELECT i.*,
        EXISTS (SELECT 1 FROM image_chunks WHERE image_id = ? AND idx = ?) AS has_chunk,
        COALESCE((SELECT data = ? FROM image_chunks WHERE image_id = ? AND idx = ?), 0) AS same_chunk,
        (SELECT value FROM storage_stats WHERE key = 'image_bytes') AS bytes,
        (SELECT COALESCE(SUM(size_bytes), 0) FROM images
          WHERE owner_kind = 'report' AND owner_id = ? AND id <> ?) AS used
        FROM (SELECT 1) LEFT JOIN images i ON i.id = ?`,
      input.imageId,
      input.index,
      input.data,
      input.imageId,
      input.index,
      ownerId,
      input.imageId,
      input.imageId,
    )
    if (why?.['owner_kind'] !== null && why?.['owner_kind'] !== undefined) {
      const sameImage =
        why['owner_kind'] === ownerKind &&
        why['owner_id'] === ownerId &&
        why['size_bytes'] === input.size &&
        why['chunk_count'] === input.chunkCount &&
        why['uploaded_by'] === input.uploadedBy
      if (!sameImage) return { _tag: 'Refused', reason: 'mismatch' }
      if (b(why['has_chunk'])) {
        // NOTE: a retried upload of a chunk that is stored with identical
        // content gets the same answer again.
        if (!b(why['same_chunk'])) return { _tag: 'Refused', reason: 'duplicate' }
        const complete = b(why['complete'])
        return {
          _tag: 'Stored',
          received: n(why['chunks_received']),
          complete,
          image: complete ? imageOf(why, false) : null,
        }
      }
      if (b(why['complete'])) return { _tag: 'Refused', reason: 'mismatch' }
    }
    if (n(why?.['bytes']) + length > IMAGE_LIMITS.databaseBytes) {
      return { _tag: 'Refused', reason: 'database_full' }
    }
    return { _tag: 'Refused', reason: 'report_limit' }
  },
  getImage: async (db, imageId) => {
    const found = await row(
      db,
      `SELECT i.*, EXISTS (SELECT 1 FROM draft_images d WHERE d.image_id = i.id) AS referenced
        FROM images i WHERE i.id = ?`,
      imageId,
    )
    return found === null ? null : imageOf(found, b(found['referenced']))
  },
  readImageChunk: async (db, imageId, index) => {
    const found = await row(
      db,
      `SELECT c.data FROM image_chunks c JOIN images i ON i.id = c.image_id
        WHERE c.image_id = ? AND c.idx = ? AND i.complete = 1`,
      imageId,
      index,
    )
    return found === null ? null : s(found['data'])
  },
  readDraftImageChunk: async (db, input) => {
    const found = await row(
      db,
      `SELECT c.data FROM draft_images d JOIN image_chunks c ON c.image_id = d.image_id
        JOIN images i ON i.id = d.image_id
        WHERE d.report_id = ? AND d.draft_number = ? AND d.image_id = ? AND c.idx = ?
        AND (? = 0 OR d.safe = 1) AND i.complete = 1`,
      input.reportId,
      input.draftNumber,
      input.imageId,
      input.index,
      flag(input.safeOnly),
    )
    return found === null ? null : s(found['data'])
  },
  readRevisionImageChunk: async (db, input) => {
    const found = await row(
      db,
      `SELECT c.data FROM revisions v
        JOIN draft_images d ON d.report_id = v.report_id AND d.draft_number = v.draft_number
        JOIN image_chunks c ON c.image_id = d.image_id
        JOIN images i ON i.id = d.image_id
        WHERE v.report_id = ? AND v.number = ? AND d.image_id = ? AND c.idx = ?
        AND (? = 0 OR (d.safe = 1 AND EXISTS (
          SELECT 1 FROM draft_images l
          WHERE l.report_id = v.report_id AND l.image_id = d.image_id AND l.safe = 1
            AND l.draft_number = (SELECT MAX(number) FROM drafts WHERE report_id = v.report_id))))
        AND i.complete = 1`,
      input.reportId,
      input.revision,
      input.imageId,
      input.index,
      flag(input.safeOnly),
    )
    return found === null ? null : s(found['data'])
  },
  withdrawImage: async (db, reportId, imageId) => {
    await exec(
      db,
      `UPDATE draft_images SET safe = 0
        WHERE report_id = ? AND image_id = ?
        AND draft_number = (SELECT MAX(number) FROM drafts WHERE report_id = ?)`,
      reportId,
      imageId,
      reportId,
    )
  },
  listReportImages: async (db, reportId) =>
    (
      await rows(
        db,
        `SELECT i.*, EXISTS (SELECT 1 FROM draft_images d WHERE d.image_id = i.id) AS referenced
          FROM images i WHERE i.owner_kind = 'report' AND i.owner_id = ?
          ORDER BY i.created_at, i.id`,
        reportId,
      )
    ).map(r => imageOf(r, b(r['referenced']))),
  imageStats: async (db, reportId) => {
    const found = await row(
      db,
      `SELECT (SELECT value FROM storage_stats WHERE key = 'image_bytes') AS db,
        (SELECT COALESCE(SUM(size_bytes), 0) FROM images
          WHERE owner_kind = 'report' AND owner_id = ?) AS rep`,
      reportId ?? '',
    )
    return {
      databaseBytes: n(found?.['db']),
      databaseLimitBytes: IMAGE_LIMITS.databaseBytes,
      reportBytes: reportId === null ? 0 : n(found?.['rep']),
      reportLimitBytes: IMAGE_LIMITS.reportBytes,
    }
  },
  deleteUnreferencedImage: async (db, imageId) => {
    const outcome = await runBatch(db, [
      {
        sql: `UPDATE images SET chunks_received = chunks_received WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM draft_images WHERE image_id = ?)
          AND NOT EXISTS (SELECT 1 FROM theme WHERE logo_image_id = ?)`,
        values: [imageId, imageId, imageId],
        expectChanges: 1,
      },
      {
        sql: `UPDATE storage_stats SET value = value - (SELECT stored_bytes FROM images WHERE id = ?)
          WHERE key = 'image_bytes'`,
        values: [imageId],
      },
      { sql: 'DELETE FROM image_chunks WHERE image_id = ?', values: [imageId] },
      { sql: 'DELETE FROM images WHERE id = ?', values: [imageId] },
    ])
    if (outcome._tag === 'Committed') return { _tag: 'Deleted' }
    const exists = await row(
      db,
      'SELECT EXISTS (SELECT 1 FROM images WHERE id = ?) AS e',
      imageId,
    )
    return {
      _tag: 'Refused',
      reason: b(exists?.['e']) ? 'referenced' : 'not_found',
    }
  },
  // NOTE: bounded cleanup for the notification pass. An image no draft, the
  // theme, a working copy or a staged section refers to, older than the limit,
  // and abandoned staged shares. All steps use the same candidate list, taken
  // before the first delete.
  cleanup: async (db, input) => {
    const candidates = `SELECT i.id FROM images i WHERE i.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM draft_images d WHERE d.image_id = i.id)
      AND NOT EXISTS (SELECT 1 FROM theme t WHERE t.logo_image_id = i.id)
      AND NOT EXISTS (SELECT 1 FROM working_copy_sections w WHERE instr(w.content, i.id) > 0)
      AND NOT EXISTS (SELECT 1 FROM share_staging s WHERE s.staged_at >= ?
        AND instr(s.image_refs, i.id) > 0)
      ORDER BY i.created_at, i.id LIMIT ?`
    const values = [input.olderThan, input.olderThan, input.limit]
    const outcome = await runBatch(db, [
      {
        sql: `UPDATE storage_stats SET value = value - COALESCE((SELECT SUM(stored_bytes)
          FROM images WHERE id IN (${candidates})), 0) WHERE key = 'image_bytes'`,
        values,
      },
      {
        sql: `DELETE FROM image_chunks WHERE image_id IN (${candidates})`,
        values,
      },
      {
        sql: `DELETE FROM images WHERE id IN (${candidates}) RETURNING id`,
        values,
      },
      {
        sql: `DELETE FROM share_staging WHERE rowid IN (SELECT rowid FROM share_staging
          WHERE staged_at < ? ORDER BY staged_at LIMIT ?) RETURNING share_id`,
        values: [input.olderThan, input.limit],
      },
    ])
    if (outcome._tag !== 'Committed') return { images: 0, staged: 0 }
    return {
      images: outcome.results[2]?.rows.length ?? 0,
      staged: outcome.results[3]?.rows.length ?? 0,
    }
  },
}

async function withParticipants(
  db: SqlStore,
  list: ReadonlyArray<RoundRecord>,
  reportId?: string,
): Promise<Array<RoundWithParticipants>> {
  if (list.length === 0) return []
  const participants = (
    await rows(
      db,
      participantsSelect(reportId === undefined ? 'p.round_id = ?' : 'r.report_id = ?'),
      reportId ?? (list[0] as RoundRecord).id,
    )
  ).map(participantOf)
  return list.map(round => ({
    round,
    participants: participants.filter(p => p.roundId === round.id),
  }))
}

// ---- Wiring: Effect, error mapping and the query count ------------------------------------------

export interface QueryCountOptions {
  // NOTE: called after every operation with the number of D1 queries it made.
  readonly onQueries?: (operation: string, queries: number) => void
}

// NOTE: the claim of the notification pass as plain SQL, one statement, with no
// Effect around it: the cron handler runs it first and returns at once when
// nothing is due (an idle run is one query). Taking over a claim whose lease
// has run out counts a deferral, not an attempt.
export const claimJobs = async (
  db: SqlBatcher,
  input: Readonly<{
    now: number
    limit: number
    leaseMs: number
    claimedBy: string
    reportIds?: ReadonlyArray<string>
  }>,
): Promise<ReadonlyArray<JobRecord>> =>
  (
    await claim(db, {
      table: 'notification_jobs',
      set: `state = 'claimed', claimed_by = ?, lease_until = ?, deferrals = deferrals + (state = 'claimed'), retry_at = NULL`,
      setValues: [input.claimedBy, input.now + input.leaseMs],
      where: `((state = 'pending' AND due_at <= ?)
        OR (state = 'claimed' AND lease_until < ?)
        OR (state = 'failed' AND retry_at IS NOT NULL AND retry_at <= ?))${
          input.reportIds === undefined
            ? ''
            : ' AND report_id IN (SELECT value FROM json_each(?))'
        }`,
      whereValues: [
        input.now,
        input.now,
        input.now,
        ...(input.reportIds === undefined
          ? []
          : [JSON.stringify(input.reportIds)]),
      ],
      orderBy: 'due_at, id',
      limit: input.limit,
    })
  )
    .map(jobOf)
    .sort(byDue)

const counting = (
  store: SqlStore,
): { readonly store: SqlStore; readonly count: () => number } => {
  let queries = 0
  const statement = (sql: string, values: ReadonlyArray<SqlValue>) => ({
    bind: (...next: ReadonlyArray<SqlValue>) => statement(sql, next),
    all: <T>() => {
      queries += 1
      return store
        .prepare(sql)
        .bind(...values)
        .all<T>()
    },
    first: <T>() => {
      queries += 1
      return store
        .prepare(sql)
        .bind(...values)
        .first<T>()
    },
    run: () => {
      queries += 1
      return store
        .prepare(sql)
        .bind(...values)
        .run()
    },
  })
  return {
    store: {
      prepare: sql => statement(sql, []),
      batch: steps => {
        queries += steps.length
        return store.batch(steps)
      },
    },
    count: () => queries,
  }
}

export const makeSqlReportRepository = (
  store: SqlStore,
  options: QueryCountOptions = {},
): ReportRepositoryApi => {
  const wrap = (name: string, run: (db: SqlStore) => Promise<unknown>) =>
    Effect.tryPromise({
      try: async () => {
        const measured = counting(store)
        const result = await run(measured.store)
        const used = measured.count()
        options.onQueries?.(name, used)
        return result
      },
      catch: error =>
        new RepositoryError({
          message: `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    })
  const entries = (Object.keys(ops) as Array<keyof ReportRepositoryApi>).map(
    key => {
      const impl = ops[key] as (
        db: SqlStore,
        ...args: Array<unknown>
      ) => Promise<unknown>
      return [
        key,
        (...args: Array<unknown>) => wrap(key, db => impl(db, ...args)),
      ] as const
    },
  )
  return Object.fromEntries(entries) as unknown as ReportRepositoryApi
}

export const layerSqlReport = (
  store: SqlStore,
  options: QueryCountOptions = {},
): Layer.Layer<ReportRepository> =>
  Layer.succeed(ReportRepository, makeSqlReportRepository(store, options))

export { QUERY_BUDGET }
