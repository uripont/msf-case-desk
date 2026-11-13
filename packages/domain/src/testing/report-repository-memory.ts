import { Effect, Layer } from 'effect'

import type { NotificationJob } from '../notifications'
import type { ReportState } from '../report-flow'
import {
  type AccountProfile,
  type AccountRecord,
  type AssignmentRecord,
  type ReviewerRoundRecord,
  type AuditInput,
  type AuditRecord,
  type StoreCaseFileRecord,
  type StoreCommentRecord,
  type EventRecord,
  type FinishShareOutcome,
  type GrantRecord,
  type ImageChunkInput,
  type ImageOwnerRef,
  type ImageRecord,
  type InvitationRecord,
  type JobRecord,
  type ParticipantRecord,
  type PublishInput,
  type PublishOutcome,
  type PutChunkOutcome,
  type DecideRoundInput,
  type ReplyRecord,
  type ReportRecord,
  ReportRepository,
  type ReportRepositoryApi,
  type StoreReviewRecord,
  type RevisionRecord,
  type RoundRecord,
  type RoundWithParticipants,
  type StoreTemplateVersionRecord,
  type StoreThemeRecord,
  type UnitRecord,
  IMAGE_LIMITS,
  dedupeKey,
  imageChunkProblem,
} from '../report-repository'
import { normaliseEmail } from '../user'

// NOTE: the in-memory twin of the SQL repository (stage 2b). It follows the
// same rules as the guarded batches, one by one, so the contract suite gives
// the same answers on both. Everything is synchronous, so each operation is
// atomic by construction; the SQL version gets the same from `runBatch`.

type DraftRow = {
  reportId: string
  number: number
  baseNumber: number | null
  authorId: string | null
  sharedAt: number
  shareId: string
  people: string
  caseTitleRedacted: string
  caseReferenceRedacted: string
}
type DraftSectionRow = {
  reportId: string
  draftNumber: number
  sectionId: string
  ordinal: number
  content: string
  redactedContent: string
  redactedHash: string
}
type StagingRow = {
  shareId: string
  reportId: string
  userId: string
  sectionId: string
  ordinal: number
  content: string
  redactedContent: string
  redactedHash: string
  imageRefs: string
  peopleHash: string
  stagedAt: number
}
type WcSectionRow = {
  reportId: string
  userId: string
  sectionId: string
  ordinal: number
  content: string
  saveCounter: number
  savedAt: number
}
type WcRow = {
  reportId: string
  userId: string
  baseDraft: number
  saveCounter: number
  sharedCounter: number
  people: string
  startedAt: number
  lastSavedAt: number
}
type ReportRow = {
  id: string
  caseFileId: string
  templateId: string
  templateVersion: number
  state: ReportState
  deadlineAt: number | null
  deadlineZone: string | null
  createdBy: string
  createdAt: number
  updatedAt: number
}
type MemberRow = {
  reportId: string
  userId: string
  roleId: string
  addedAt: number
}
type ParticipantRow = {
  roundId: string
  userId: string
  roleId: string
  addedAt: number
  removedAt: number | null
  removedBy: string | null
}
type CommentRow = Omit<StoreCommentRecord, 'authorName'>
type ReplyRow = Omit<ReplyRecord, 'authorName'>
type ImageRow = {
  id: string
  owner: ImageOwnerRef
  uploadedBy: string
  mime: 'image/jpeg' | 'image/png'
  width: number
  height: number
  size: number
  hash: string
  chunkCount: number
  storedBytes: number
  complete: boolean
  createdAt: number
}
type UserRow = {
  id: string
  email: string
  name: string
  passwordHash: string
}
type PendingRow = {
  roundId: string
  reviewerId: string
  decision: StoreReviewRecord['decision'] | null
}
type TemplateRow = { id: string; builtin: boolean }

export type MemorySession = { tokenHash: string; userId: string }

export const makeMemoryReportRepository = (
  options: {
    readonly sessions?: Array<MemorySession>
    // NOTE: test seam for the 400 MB guard: bytes already stored.
    readonly initialImageBytes?: number
  } = {},
): Effect.Effect<ReportRepositoryApi> =>
  Effect.sync(() => {
    const sessions = options.sessions ?? []
    let users: Array<UserRow> = []
    const profiles = new Map<string, AccountProfile>()
    const units: Array<UnitRecord> = []
    let grants: Array<GrantRecord> = []
    const invitations: Array<InvitationRecord> = []
    const attempts: Array<{
      email: string
      ip: string
      at: number
      succeeded: boolean
    }> = []
    let theme: StoreThemeRecord | null = null
    const templates = new Map<string, TemplateRow>()
    const versions: Array<StoreTemplateVersionRecord> = []
    const unitReviewers: Array<{
      unitId: string
      userId: string
      displayName: string
      phone: string | null
      consentRequested: boolean
      addedAt: number
    }> = []
    const committees: Array<{
      id: string
      unitId: string
      name: string
      createdAt: number
      archivedAt: number | null
    }> = []
    let committeeMembers: Array<{ committeeId: string; userId: string }> = []
    const caseFiles: Array<StoreCaseFileRecord> = []
    const reports: Array<ReportRow> = []
    const members: Array<MemberRow> = []
    const workingCopies: Array<WcRow> = []
    const wcSections: Array<WcSectionRow> = []
    const drafts: Array<DraftRow> = []
    const draftSections: Array<DraftSectionRow> = []
    const draftImages: Array<{
      reportId: string
      draftNumber: number
      imageId: string
      safe: boolean
    }> = []
    const confirmations: Array<{
      reportId: string
      draftNumber: number
      at: number
    }> = []
    let staging: Array<StagingRow> = []
    const revisions: Array<RevisionRecord> = []
    const rounds: Array<RoundRecord> = []
    const participants: Array<ParticipantRow> = []
    const reviews: Array<StoreReviewRecord> = []
    const pending: Array<PendingRow> = []
    const comments: Array<CommentRow> = []
    const replies: Array<ReplyRow> = []
    const jobs: Array<JobRecord> = []
    const events: Array<EventRecord> = []
    const audit: Array<AuditRecord> = []
    const images: Array<ImageRow> = []
    const chunks = new Map<string, string>()
    let storedImageBytes = options.initialImageBytes ?? 0
    let jobSeq = 0
    let eventSeq = 0
    let auditSeq = 0

    const utf8 = (text: string): number => new TextEncoder().encode(text).length
    const nameOf = (id: string | null): string =>
      users.find(user => user.id === id)?.name ?? ''
    const byKey =
      <T>(...keys: Array<(item: T) => string | number>) =>
      (a: T, b: T): number => {
        for (const key of keys) {
          const x = key(a)
          const y = key(b)
          if (x < y) return -1
          if (x > y) return 1
        }
        return 0
      }

    const addAudit = (
      input: AuditInput,
      override: Partial<AuditRecord> = {},
    ): void => {
      auditSeq += 1
      audit.push({
        id: auditSeq,
        at: input.at,
        actorId: input.actorId,
        reportId: input.reportId ?? null,
        templateId: input.templateId ?? null,
        draftNumber: input.draftNumber ?? null,
        revisionNumber: input.revisionNumber ?? null,
        action: input.action,
        meta: input.meta ?? '{}',
        ...override,
      })
    }

    const addJobs = (
      reportId: string,
      roundId: string | null,
      list: ReadonlyArray<NotificationJob>,
      now: number,
    ): void => {
      list.forEach(job => {
        const key = job.key
        if (
          jobs.some(
            existing =>
              dedupeKey(existing.reportId, existing.key) ===
              dedupeKey(reportId, key),
          )
        ) {
          return
        }
        jobSeq += 1
        jobs.push({
          id: jobSeq,
          key,
          reportId,
          roundId,
          recipientId: job.recipient,
          kind: job.kind,
          revision: job.revision,
          dueAt: job.dueAt,
          deadline: job.deadline,
          subject: job.subject,
          channel: job.channel,
          state: 'pending',
          claimedBy: null,
          leaseUntil: null,
          attempts: 0,
          providerMessageId: null,
          deliveryStatus: null,
          createdAt: now,
          doneAt: null,
          readAt: null,
        })
      })
    }

    const SKIPPABLE = new Set([
      'review_request',
      'reminder_first',
      'reminder_final',
      'deadline',
    ])
    const skipJobsOf = (roundId: string, recipient?: string): void => {
      jobs.forEach((job, index) => {
        if (
          job.roundId === roundId &&
          job.state === 'pending' &&
          SKIPPABLE.has(job.kind) &&
          (recipient === undefined || job.recipientId === recipient)
        ) {
          jobs[index] = { ...job, state: 'skipped' }
        }
      })
    }

    const imageRecord = (row: ImageRow): ImageRecord => ({
      id: row.id,
      owner: row.owner,
      uploadedBy: row.uploadedBy,
      mime: row.mime,
      width: row.width,
      height: row.height,
      size: row.size,
      hash: row.hash,
      chunkCount: row.chunkCount,
      chunksReceived: [...chunks.keys()].filter(key =>
        key.startsWith(`${row.id}#`),
      ).length,
      complete: row.complete,
      createdAt: row.createdAt,
      referenced: draftImages.some(ref => ref.imageId === row.id),
    })

    const reportRecord = (row: ReportRow): ReportRecord => {
      const caseFile = caseFiles.find(file => file.id === row.caseFileId)
      const mine = revisions.filter(r => r.reportId === row.id)
      return {
        id: row.id,
        caseFile: caseFile as StoreCaseFileRecord,
        templateId: row.templateId,
        templateVersion: row.templateVersion,
        state: row.state,
        deadlineAt: row.deadlineAt,
        deadlineZone: row.deadlineZone,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        latestDraft: Math.max(
          ...drafts.filter(d => d.reportId === row.id).map(d => d.number),
        ),
        latestRevision:
          mine.length === 0 ? null : Math.max(...mine.map(r => r.number)),
      }
    }

    const draftRecord = (row: DraftRow) => ({
      reportId: row.reportId,
      number: row.number,
      baseNumber: row.baseNumber,
      authorId: row.authorId,
      authorName: row.authorId === null ? null : nameOf(row.authorId),
      sharedAt: row.sharedAt,
      shareId: row.shareId,
      people: row.people,
      caseTitleRedacted: row.caseTitleRedacted,
      caseReferenceRedacted: row.caseReferenceRedacted,
      redactionConfirmedAt:
        confirmations.find(
          c => c.reportId === row.reportId && c.draftNumber === row.number,
        )?.at ?? null,
      revisions: revisions
        .filter(
          r => r.reportId === row.reportId && r.draftNumber === row.number,
        )
        .map(r => r.number)
        .sort((a, b) => a - b),
    })

    const withParticipants = (round: RoundRecord): RoundWithParticipants => ({
      round,
      participants: participants
        .filter(p => p.roundId === round.id)
        .sort(
          byKey(
            p => p.addedAt,
            p => p.userId,
          ),
        )
        .map((p): ParticipantRecord => ({
          ...p,
          name: nameOf(p.userId),
        })),
    })

    const commentRecord = (row: CommentRow): StoreCommentRecord => ({
      ...row,
      authorName: nameOf(row.authorId),
    })

    const accountRecord = (user: UserRow): AccountRecord => ({
      id: user.id,
      email: user.email,
      name: user.name,
      profile: profiles.get(user.id) ?? null,
    })

    // ---- deciding a round, shared by decideRound and removeParticipant ------------------
    const activeParticipants = (roundId: string): number =>
      participants.filter(p => p.roundId === roundId && p.removedAt === null)
        .length
    // NOTE: the same guards as the SQL batch: the round is open with the
    // deadline the decision was made from, the deadline has passed for a
    // decision by the deadline, and the reviews and the people are the same.
    const decisionStillHolds = (
      input: DecideRoundInput,
      activeCount: number,
    ): boolean => {
      const round = rounds.find(r => r.id === input.roundId)
      return (
        round !== undefined &&
        round.state === 'open' &&
        round.deadlineAt === input.expectedDeadlineAt &&
        (input.decidedBy !== 'deadline' || round.deadlineAt <= input.now) &&
        reviews.filter(v => v.roundId === input.roundId).length ===
          input.expectedReviews &&
        activeCount === input.expectedParticipants
      )
    }
    const applyDecision = (input: DecideRoundInput): void => {
      const index = rounds.findIndex(r => r.id === input.roundId)
      rounds[index] = {
        ...(rounds[index] as RoundRecord),
        state: 'decided',
        decidedBy: input.decidedBy,
        decidedAt: input.now,
      }
      const at = reports.findIndex(r => r.id === input.reportId)
      reports[at] = {
        ...(reports[at] as ReportRow),
        state: input.toState,
        updatedAt: input.now,
      }
      skipJobsOf(input.roundId)
      addJobs(input.reportId, input.roundId, input.jobs, input.now)
      addAudit(input.audit)
    }

    // ---- publishing, shared by publishRevision and finishShare --------------------------

    const publishRefusal = (
      reportId: string,
      draft: number | 'new',
      input: PublishInput,
    ): PublishOutcome | null => {
      const report = reports.find(r => r.id === reportId)
      if (report === undefined || !input.fromStates.includes(report.state)) {
        return { _tag: 'Refused', reason: 'wrong_state' }
      }
      if (
        draft !== 'new' &&
        Math.max(
          ...drafts.filter(d => d.reportId === reportId).map(d => d.number),
        ) !== draft
      ) {
        return { _tag: 'Refused', reason: 'not_latest' }
      }
      const lastRevision = Math.max(
        0,
        ...revisions.filter(r => r.reportId === reportId).map(r => r.number),
      )
      if (lastRevision !== input.revision - 1) {
        return { _tag: 'Refused', reason: 'revision_number' }
      }
      if (
        input.requiresConfirmation === true &&
        draft !== 'new' &&
        !confirmations.some(
          c => c.reportId === reportId && c.draftNumber === draft,
        )
      ) {
        return { _tag: 'Refused', reason: 'not_confirmed' }
      }
      if (
        input.participants.some(p =>
          members.some(m => m.reportId === reportId && m.userId === p.userId),
        )
      ) {
        return { _tag: 'Refused', reason: 'participant_is_author' }
      }
      return null
    }

    const applyPublish = (
      reportId: string,
      draftNumber: number,
      input: PublishInput,
    ): void => {
      revisions.push({
        reportId,
        number: input.revision,
        draftNumber,
        closing: input.closing,
        publishedBy: input.publishedBy,
        publishedAt: input.now,
      })
      rounds.forEach((round, index) => {
        if (round.reportId === reportId && round.state === 'open') {
          skipJobsOf(round.id)
          rounds[index] = { ...round, state: 'superseded' }
        }
      })
      rounds.push({
        id: input.roundId,
        reportId,
        revision: input.revision,
        closing: input.closing,
        deadlineAt: input.deadlineAt,
        deadlineZone: input.deadlineZone,
        state: 'open',
        decidedBy: null,
        decidedAt: null,
        createdAt: input.now,
      })
      input.participants.forEach(p =>
        participants.push({
          roundId: input.roundId,
          userId: p.userId,
          roleId: p.roleId,
          addedAt: input.now,
          removedAt: null,
          removedBy: null,
        }),
      )
      const index = reports.findIndex(r => r.id === reportId)
      const report = reports[index] as ReportRow
      reports[index] = {
        ...report,
        state: input.toState,
        deadlineAt: input.deadlineAt,
        deadlineZone: input.deadlineZone,
        updatedAt: input.now,
      }
      addJobs(reportId, input.roundId, input.jobs, input.now)
      addAudit(input.audit, {
        reportId,
        draftNumber,
        revisionNumber: input.revision,
      })
    }

    const latestDraftOf = (reportId: string): number =>
      Math.max(
        -1,
        ...drafts.filter(d => d.reportId === reportId).map(d => d.number),
      )

    // ---- the API -----------------------------------------------------------------------------------

    const api: ReportRepositoryApi = {
      createUnit: unit =>
        Effect.sync(() => {
          if (
            units.some(
              u =>
                u.id === unit.id ||
                u.name === unit.name ||
                u.code === unit.code,
            )
          ) {
            return { _tag: 'Refused', reason: 'duplicate' } as const
          }
          units.push(unit)
          return { _tag: 'Created' } as const
        }),
      listUnits: () =>
        Effect.sync(() =>
          [...units].sort(
            byKey(
              u => u.name,
              u => u.id,
            ),
          ),
        ),
      updateUnit: (id, name) =>
        Effect.sync(() => {
          const index = units.findIndex(u => u.id === id)
          if (index < 0) return null
          const updated = { ...(units[index] as UnitRecord), name }
          units[index] = updated
          return updated
        }),
      grantCapability: grant =>
        Effect.sync(() => {
          const unitId = grant.unitId ?? ''
          if (
            grant.capability === 'author' &&
            !units.some(u => u.id === unitId)
          ) {
            return 'no_unit' as const
          }
          if (
            grants.some(
              g =>
                g.userId === grant.userId &&
                g.capability === grant.capability &&
                (g.unitId ?? '') === unitId,
            )
          ) {
            return 'exists' as const
          }
          grants.push(grant)
          return 'granted' as const
        }),
      revokeCapability: (userId, capability, unitId) =>
        Effect.sync(() => {
          const before = grants.length
          grants = grants.filter(
            g =>
              !(
                g.userId === userId &&
                g.capability === capability &&
                (g.unitId ?? '') === (unitId ?? '')
              ),
          )
          return grants.length < before
        }),
      listGrants: userId =>
        Effect.sync(() =>
          grants
            .filter(g => userId === undefined || g.userId === userId)
            .sort(
              byKey(
                g => g.userId,
                g => g.capability,
                g => g.unitId ?? '',
              ),
            ),
        ),
      getAccount: userId =>
        Effect.sync(() => {
          const user = users.find(u => u.id === userId)
          return user === undefined ? null : accountRecord(user)
        }),
      findAccountByEmail: email =>
        Effect.sync(() => {
          const user = users.find(u => u.email === normaliseEmail(email))
          return user === undefined ? null : accountRecord(user)
        }),
      updateAccountName: (userId, name) =>
        Effect.sync(() => {
          if (!users.some(u => u.id === userId)) return false
          users = users.map(u => (u.id === userId ? { ...u, name } : u))
          return true
        }),
      listStagedSections: (shareId, reportId, userId) =>
        Effect.sync(() =>
          staging
            .filter(
              s =>
                s.shareId === shareId &&
                s.reportId === reportId &&
                s.userId === userId,
            )
            .sort(
              byKey(
                s => s.ordinal,
                s => s.sectionId,
              ),
            )
            .map(s => ({
              sectionId: s.sectionId,
              ordinal: s.ordinal,
              redactedHash: s.redactedHash,
              peopleHash: s.peopleHash,
            })),
        ),
      listReviewerRounds: (userId, options) =>
        Effect.sync(() =>
          participants
            .filter(p => p.userId === userId && p.removedAt === null)
            .flatMap((p): Array<ReviewerRoundRecord> => {
              const round = rounds.find(r => r.id === p.roundId)
              const report = reports.find(r => r.id === round?.reportId)
              const revision = revisions.find(
                v =>
                  v.reportId === round?.reportId &&
                  v.number === round?.revision,
              )
              if (
                round === undefined ||
                report === undefined ||
                revision === undefined
              ) {
                return []
              }
              if (options.openOnly && round.state !== 'open') return []
              const standing = reviews
                .filter(
                  r =>
                    r.roundId === round.id &&
                    r.reviewerId === userId &&
                    r.decision !== 'comment',
                )
                .sort(byKey(r => r.sentAt))
                .pop()
              const isOpen = round.state === 'open'
              const mine = isOpen
                ? pending.find(
                    q => q.roundId === round.id && q.reviewerId === userId,
                  )
                : undefined
              const pendingComments = comments.filter(
                c =>
                  isOpen &&
                  c.roundId === round.id &&
                  c.authorId === userId &&
                  c.reviewId === null,
              ).length
              if (
                options.pendingOnly &&
                (mine?.decision ?? null) === null &&
                pendingComments === 0
              ) {
                return []
              }
              return [
                {
                  reportId: round.reportId,
                  revision: round.revision,
                  roundId: round.id,
                  closing: round.closing,
                  roundState: round.state,
                  deadlineAt: round.deadlineAt,
                  deadlineZone: round.deadlineZone,
                  caseReference: (
                    caseFiles.find(
                      f => f.id === report.caseFileId,
                    ) as StoreCaseFileRecord
                  ).reference,
                  caseReferenceRedacted:
                    drafts.find(
                      d =>
                        d.reportId === round.reportId &&
                        d.number === revision.draftNumber,
                    )?.caseReferenceRedacted ?? '',
                  templateId: report.templateId,
                  templateVersion: report.templateVersion,
                  publishedAt: revision.publishedAt,
                  roleId: p.roleId,
                  decision: standing?.decision ?? null,
                  pendingDecision: mine?.decision ?? null,
                  pendingComments,
                },
              ]
            })
            .sort(
              byKey(
                r => -r.deadlineAt,
                r => r.roundId,
              ),
            )
            .slice(options.offset, options.offset + options.limit),
        ),
      listAccountsByIds: userIds =>
        Effect.sync(() =>
          users
            .filter(u => userIds.includes(u.id))
            .sort(byKey(u => u.email))
            .map(accountRecord),
        ),
      listAccounts: () =>
        Effect.sync(() =>
          [...users].sort(byKey(u => u.email)).map(accountRecord),
        ),
      createAccount: input =>
        Effect.sync(() => {
          const email = normaliseEmail(input.email)
          if (users.some(u => u.email === email)) {
            return { _tag: 'Refused', reason: 'email_taken' } as const
          }
          const unitMissing = (id: string | undefined): boolean =>
            id !== undefined && !units.some(u => u.id === id)
          if (
            unitMissing(input.reviewerOfUnit) ||
            (input.grant?.capability === 'author' &&
              unitMissing(input.grant.unitId))
          ) {
            return { _tag: 'Refused', reason: 'no_unit' } as const
          }
          users.push({
            id: input.id,
            email,
            name: input.name,
            passwordHash: input.passwordHash,
          })
          profiles.set(input.id, {
            userId: input.id,
            ...input.profile,
            passwordSetAt: null,
          })
          if (input.reviewerOfUnit !== undefined) {
            unitReviewers.push({
              unitId: input.reviewerOfUnit,
              userId: input.id,
              displayName: input.reviewerEntry?.displayName ?? input.name,
              phone: input.reviewerEntry?.phone ?? null,
              consentRequested: input.reviewerEntry?.consentRequested ?? false,
              addedAt: input.now,
            })
          }
          if (input.grant !== undefined) {
            grants.push({
              userId: input.id,
              capability: input.grant.capability,
              unitId: input.grant.unitId ?? null,
              grantedBy: input.createdBy,
              grantedAt: input.now,
            })
          }
          if (input.invitation !== undefined) {
            invitations.push({ ...input.invitation, usedAt: null })
          }
          if (input.audit !== undefined) addAudit(input.audit)
          return { _tag: 'Created' } as const
        }),
      getProfile: userId => Effect.sync(() => profiles.get(userId) ?? null),
      putProfile: (userId, profile, now) =>
        Effect.sync(() => {
          const existing = profiles.get(userId)
          profiles.set(userId, {
            userId,
            ...profile,
            passwordSetAt: existing?.passwordSetAt ?? null,
          })
          void now
        }),
      linkReviewer: (unitId, userId, _addedBy, now, auditInput, entry) =>
        Effect.sync(() => {
          if (!units.some(u => u.id === unitId)) return 'no_unit' as const
          if (
            unitReviewers.some(r => r.unitId === unitId && r.userId === userId)
          ) {
            return 'exists' as const
          }
          unitReviewers.push({
            unitId,
            userId,
            displayName: entry.displayName,
            phone: entry.phone,
            consentRequested: entry.consentRequested,
            addedAt: now,
          })
          addAudit(auditInput)
          return 'linked' as const
        }),
      listUnitReviewers: unitId =>
        Effect.sync(() =>
          unitReviewers
            .filter(r => r.unitId === unitId)
            .flatMap(r => {
              const user = users.find(u => u.id === r.userId)
              return user === undefined
                ? []
                : [
                    {
                      unitId: r.unitId,
                      userId: r.userId,
                      email: user.email,
                      name: r.displayName === '' ? user.name : r.displayName,
                      phone: r.phone,
                      consentRequested: r.consentRequested,
                      active: profiles.get(user.id)?.active ?? true,
                      addedAt: r.addedAt,
                    },
                  ]
            })
            .sort(
              byKey(
                u => u.name,
                u => u.userId,
              ),
            ),
        ),
      updateUnitReviewer: input =>
        Effect.sync(() => {
          const index = unitReviewers.findIndex(
            r => r.unitId === input.unitId && r.userId === input.userId,
          )
          if (index < 0) return 'not_found' as const
          const current = unitReviewers[index] as (typeof unitReviewers)[number]
          unitReviewers[index] = {
            ...current,
            displayName: input.displayName ?? current.displayName,
            phone: input.phone === undefined ? current.phone : input.phone,
            consentRequested:
              input.consentRequested ?? current.consentRequested,
          }
          addAudit(input.audit)
          return 'updated' as const
        }),
      listUnitAuthors: unitId =>
        Effect.sync(() =>
          grants
            .filter(g => g.capability === 'author' && g.unitId === unitId)
            .flatMap(g => users.filter(u => u.id === g.userId))
            .sort(
              byKey(
                u => u.name,
                u => u.id,
              ),
            )
            .map(accountRecord),
        ),
      listProfiles: userIds =>
        Effect.sync(() =>
          userIds.flatMap(id => {
            const profile = profiles.get(id)
            return profile === undefined ? [] : [profile]
          }),
        ),
      createInvitation: (invitation, auditInput) =>
        Effect.sync(() => {
          invitations.push({ ...invitation, usedAt: null })
          addAudit(auditInput)
        }),
      findInvitation: tokenHash =>
        Effect.sync(
          () => invitations.find(i => i.tokenHash === tokenHash) ?? null,
        ),
      consumeInvitation: (tokenHash, passwordHash, now, auditInput) =>
        Effect.sync(() => {
          const index = invitations.findIndex(
            i =>
              i.tokenHash === tokenHash &&
              i.usedAt === null &&
              i.expiresAt > now,
          )
          if (index < 0) return { _tag: 'Refused', reason: 'invalid' } as const
          const invitation = invitations[index] as InvitationRecord
          invitations.forEach((other, at) => {
            if (
              at !== index &&
              other.userId === invitation.userId &&
              other.usedAt === null
            ) {
              invitations[at] = { ...other, usedAt: now }
            }
          })
          users = users.map(u =>
            u.id === invitation.userId ? { ...u, passwordHash } : u,
          )
          const profile = profiles.get(invitation.userId)
          profiles.set(invitation.userId, {
            userId: invitation.userId,
            phone: profile?.phone ?? null,
            whatsappConsent: profile?.whatsappConsent ?? false,
            whatsappConsentAt: profile?.whatsappConsentAt ?? null,
            notifyOnApproval: profile?.notifyOnApproval ?? false,
            active: profile?.active ?? true,
            passwordSetAt: now,
          })
          for (let i = sessions.length - 1; i >= 0; i -= 1) {
            if (sessions[i]?.userId === invitation.userId) sessions.splice(i, 1)
          }
          addAudit(auditInput, { actorId: invitation.userId })
          invitations[index] = { ...invitation, usedAt: now }
          return {
            _tag: 'Consumed',
            userId: invitation.userId,
            purpose: invitation.purpose,
          } as const
        }),
      recordSignInAttempt: (email, ip, at, succeeded) =>
        Effect.sync(() => {
          attempts.push({ email, ip, at, succeeded })
        }),
      signInSummary: (email, ip, since) =>
        Effect.sync(() => {
          const failed = attempts.filter(a => !a.succeeded && a.at >= since)
          const lastOk = Math.max(
            -1,
            ...attempts
              .filter(a => a.succeeded && a.email === email)
              .map(a => a.at),
          )
          const mail = failed.filter(a => a.email === email && a.at > lastOk)
          const net = failed.filter(a => a.ip === ip)
          const last = (list: typeof failed): number | null =>
            list.length === 0 ? null : Math.max(...list.map(a => a.at))
          return {
            failuresByEmail: mail.length,
            lastFailureByEmail: last(mail),
            failuresByIp: net.length,
            lastFailureByIp: last(net),
          }
        }),
      pruneSignInAttempts: (before, limit) =>
        Effect.sync(() => {
          const doomed = attempts
            .map((a, index) => ({ a, index }))
            .filter(({ a }) => a.at < before)
            .sort((x, y) => x.a.at - y.a.at || x.index - y.index)
            .slice(0, limit)
            .map(({ index }) => index)
          const gone = new Set(doomed)
          const kept = attempts.filter((_, index) => !gone.has(index))
          attempts.length = 0
          attempts.push(...kept)
          return doomed.length
        }),
      deleteSessionsOfUser: userId =>
        Effect.sync(() => {
          for (let i = sessions.length - 1; i >= 0; i -= 1) {
            if (sessions[i]?.userId === userId) sessions.splice(i, 1)
          }
        }),
      getTheme: () => Effect.sync(() => theme),
      putTheme: (next, auditInput) =>
        Effect.sync(() => {
          theme = next
          addAudit(auditInput)
        }),

      importBuiltInTemplates: (list, now) =>
        Effect.sync(() => {
          let inserted = 0
          list.forEach(t => {
            if (!templates.has(t.templateId)) {
              templates.set(t.templateId, { id: t.templateId, builtin: true })
            }
            if (
              !versions.some(
                v => v.templateId === t.templateId && v.version === t.version,
              )
            ) {
              versions.push({
                templateId: t.templateId,
                version: t.version,
                name: t.name,
                shortName: t.shortName,
                state: 'published',
                definition: t.definition,
                builtin: true,
                createdBy: null,
                createdAt: now,
                publishedAt: now,
                publishedBy: null,
                changes: null,
                retiredAt: null,
              })
              inserted += 1
            }
          })
          return inserted
        }),
      getTemplateVersion: (templateId, version) =>
        Effect.sync(
          () =>
            versions.find(
              v => v.templateId === templateId && v.version === version,
            ) ?? null,
        ),
      getTemplateVersions: keys =>
        Effect.sync(() =>
          versions.filter(v =>
            keys.some(k => k.templateId === v.templateId && k.version === v.version),
          ),
        ),
      listTemplates: () =>
        Effect.sync(() =>
          [...versions]
            .sort(
              byKey(
                v => v.templateId,
                v => v.version,
              ),
            )
            .map(({ definition: _definition, ...rest }) => rest),
        ),
      createTemplateDraft: input =>
        Effect.sync(() => {
          const mine = versions.filter(v => v.templateId === input.templateId)
          if (mine.some(v => v.state === 'draft')) {
            return { _tag: 'Refused', reason: 'draft_exists' } as const
          }
          if (Math.max(0, ...mine.map(v => v.version)) + 1 !== input.version) {
            return { _tag: 'Refused', reason: 'wrong_version' } as const
          }
          if (!templates.has(input.templateId)) {
            templates.set(input.templateId, {
              id: input.templateId,
              builtin: false,
            })
          }
          versions.push({
            templateId: input.templateId,
            version: input.version,
            name: input.name,
            shortName: input.shortName,
            state: 'draft',
            definition: input.definition,
            builtin: false,
            createdBy: input.createdBy,
            createdAt: input.now,
            publishedAt: null,
            publishedBy: null,
            changes: null,
            retiredAt: null,
          })
          addAudit(input.audit)
          return { _tag: 'Created' } as const
        }),
      saveTemplateDraft: input =>
        Effect.sync(() => {
          const index = versions.findIndex(
            v =>
              v.templateId === input.templateId &&
              v.version === input.version &&
              v.state === 'draft',
          )
          if (index < 0)
            return { _tag: 'Refused', reason: 'not_a_draft' } as const
          versions[index] = {
            ...(versions[index] as StoreTemplateVersionRecord),
            name: input.name,
            shortName: input.shortName,
            definition: input.definition,
          }
          return { _tag: 'Saved' } as const
        }),
      publishTemplateVersion: input =>
        Effect.sync(() => {
          const index = versions.findIndex(
            v =>
              v.templateId === input.templateId &&
              v.version === input.version &&
              v.state === 'draft',
          )
          if (index < 0)
            return { _tag: 'Refused', reason: 'not_a_draft' } as const
          versions[index] = {
            ...(versions[index] as StoreTemplateVersionRecord),
            state: 'published',
            publishedAt: input.now,
            publishedBy: input.publishedBy,
            changes: input.changes,
          }
          addAudit(input.audit)
          return { _tag: 'Published' } as const
        }),
      retireTemplate: (templateId, now, auditInput) =>
        Effect.sync(() => {
          if (
            !versions.some(
              v => v.templateId === templateId && v.state === 'published',
            )
          ) {
            return { _tag: 'Refused', reason: 'not_published' } as const
          }
          addAudit(auditInput)
          versions.forEach((v, index) => {
            if (v.templateId === templateId && v.state === 'published') {
              versions[index] = { ...v, state: 'retired', retiredAt: now }
            }
          })
          return { _tag: 'Retired' } as const
        }),

      createCommittee: input =>
        Effect.sync(() => {
          if (!units.some(u => u.id === input.unitId)) {
            return { _tag: 'Refused', reason: 'no_unit' } as const
          }
          if (
            committees.some(
              c =>
                c.id === input.id ||
                (c.unitId === input.unitId && c.name === input.name),
            )
          ) {
            return { _tag: 'Refused', reason: 'duplicate' } as const
          }
          committees.push({
            id: input.id,
            unitId: input.unitId,
            name: input.name,
            createdAt: input.now,
            archivedAt: null,
          })
          new Set(input.memberIds).forEach(userId =>
            committeeMembers.push({ committeeId: input.id, userId }),
          )
          addAudit(input.audit)
          return { _tag: 'Created' } as const
        }),
      updateCommittee: input =>
        Effect.sync(() => {
          const index = committees.findIndex(c => c.id === input.id)
          if (index < 0) return false
          const current = committees[index] as (typeof committees)[number]
          committees[index] = {
            ...current,
            name: input.name ?? current.name,
            archivedAt:
              input.archived === undefined
                ? current.archivedAt
                : input.archived
                  ? input.now
                  : null,
          }
          if (input.memberIds !== undefined) {
            committeeMembers = committeeMembers.filter(
              m => m.committeeId !== input.id,
            )
            new Set(input.memberIds).forEach(userId =>
              committeeMembers.push({ committeeId: input.id, userId }),
            )
          }
          const removing = new Set(input.removeMemberIds ?? [])
          if (removing.size > 0) {
            committeeMembers = committeeMembers.filter(
              m => m.committeeId !== input.id || !removing.has(m.userId),
            )
          }
          new Set(input.addMemberIds ?? []).forEach(userId => {
            if (
              !committeeMembers.some(
                m => m.committeeId === input.id && m.userId === userId,
              )
            ) {
              committeeMembers.push({ committeeId: input.id, userId })
            }
          })
          addAudit(input.audit)
          return true
        }),
      listCommittees: unitId =>
        Effect.sync(() =>
          committees
            .filter(c => c.unitId === unitId)
            .sort(
              byKey(
                c => c.name,
                c => c.id,
              ),
            )
            .map(c => ({
              ...c,
              memberIds: committeeMembers
                .filter(m => m.committeeId === c.id)
                .map(m => m.userId)
                .sort(),
            })),
        ),
      getCommittee: id =>
        Effect.sync(() => {
          const c = committees.find(x => x.id === id)
          return c === undefined
            ? null
            : {
                ...c,
                memberIds: committeeMembers
                  .filter(m => m.committeeId === c.id)
                  .map(m => m.userId)
                  .sort(),
              }
        }),
      listCaseFiles: unitId =>
        Effect.sync(() =>
          caseFiles
            .filter(f => f.unitId === unitId)
            .sort(byKey(f => f.reference)),
        ),
      retitleCaseFile: input =>
        Effect.sync(() => {
          const index = caseFiles.findIndex(f => f.id === input.caseFileId)
          const onFile = reports.filter(r => r.caseFileId === input.caseFileId)
          const isMember = onFile.some(r =>
            members.some(m => m.reportId === r.id && m.userId === input.userId),
          )
          if (index < 0 || !isMember) {
            return { _tag: 'Refused', reason: 'not_found' } as const
          }
          const updated = {
            ...(caseFiles[index] as StoreCaseFileRecord),
            title: input.title,
            updatedAt: input.now,
          }
          caseFiles[index] = updated
          const reportIds = onFile.map(r => r.id).sort()
          reportIds.forEach(reportId => addAudit({ ...input.audit, reportId }))
          return { _tag: 'Updated', caseFile: updated, reportIds } as const
        }),
      updateCaseFile: (id, patch, now) =>
        Effect.sync(() => {
          const index = caseFiles.findIndex(f => f.id === id)
          if (index < 0) return null
          const current = caseFiles[index] as StoreCaseFileRecord
          const reference = patch.reference ?? current.reference
          if (
            caseFiles.some(
              f =>
                f.id !== id &&
                f.unitId === current.unitId &&
                f.reference === reference,
            )
          ) {
            return { _tag: 'Refused', reason: 'duplicate' } as const
          }
          const updated = {
            ...current,
            reference,
            title: patch.title ?? current.title,
            updatedAt: now,
          }
          caseFiles[index] = updated
          return updated
        }),

      createReport: input =>
        Effect.sync(() => {
          let caseFile: StoreCaseFileRecord | undefined
          if (input.caseFile.kind === 'new') {
            const { id, reference, title } = input.caseFile
            if (
              caseFiles.some(
                f => f.unitId === input.unitId && f.reference === reference,
              ) ||
              !units.some(u => u.id === input.unitId)
            ) {
              return { _tag: 'Refused', reason: 'duplicate_reference' } as const
            }
            caseFile = {
              id,
              unitId: input.unitId,
              reference,
              title,
              createdAt: input.now,
              updatedAt: input.now,
            }
          } else {
            const existingId = input.caseFile.id
            caseFile = caseFiles.find(
              f => f.id === existingId && f.unitId === input.unitId,
            )
            if (caseFile === undefined) {
              return { _tag: 'Refused', reason: 'no_case_file' } as const
            }
          }
          if (input.caseFile.kind === 'new') caseFiles.push(caseFile)
          reports.push({
            id: input.reportId,
            caseFileId: caseFile.id,
            templateId: input.templateId,
            templateVersion: input.templateVersion,
            state: 'drafting',
            deadlineAt: null,
            deadlineZone: null,
            createdBy: input.createdBy,
            createdAt: input.now,
            updatedAt: input.now,
          })
          members.push({
            reportId: input.reportId,
            userId: input.createdBy,
            roleId: input.draftingRoleId,
            addedAt: input.now,
          })
          drafts.push({
            reportId: input.reportId,
            number: 0,
            baseNumber: null,
            authorId: input.createdBy,
            sharedAt: input.now,
            shareId: `draft-0:${input.reportId}`,
            people: '[]',
            caseTitleRedacted: '',
            caseReferenceRedacted: '',
          })
          addAudit(input.audit, { reportId: input.reportId, draftNumber: 0 })
          return { _tag: 'Created' } as const
        }),
      getReport: reportId =>
        Effect.sync(() => {
          const row = reports.find(r => r.id === reportId)
          return row === undefined ? null : reportRecord(row)
        }),
      listReportsForMember: userId =>
        Effect.sync(() =>
          reports
            .filter(r =>
              members.some(m => m.reportId === r.id && m.userId === userId),
            )
            .sort(
              byKey(
                r => r.createdAt,
                r => r.id,
              ),
            )
            .map(reportRecord),
        ),
      listMembers: reportId =>
        Effect.sync(() =>
          members
            .filter(m => m.reportId === reportId)
            .sort(
              byKey(
                m => m.addedAt,
                m => m.userId,
              ),
            )
            .map(m => ({
              userId: m.userId,
              name: nameOf(m.userId),
              roleId: m.roleId,
              addedAt: m.addedAt,
            })),
        ),
      getMembership: (reportId, userId) =>
        Effect.sync(() => {
          const row = members.find(
            m => m.reportId === reportId && m.userId === userId,
          )
          return row === undefined ? null : { roleId: row.roleId }
        }),
      addMember: input =>
        Effect.sync(() => {
          const report = reports.find(r => r.id === input.reportId)
          if (report === undefined || report.state === 'archived') {
            return { _tag: 'Refused', reason: 'archived' } as const
          }
          if (
            members.some(
              m => m.reportId === input.reportId && m.userId === input.userId,
            )
          ) {
            return { _tag: 'Refused', reason: 'already_member' } as const
          }
          const reviewing = participants.some(
            p =>
              p.userId === input.userId &&
              p.removedAt === null &&
              rounds.some(
                r =>
                  r.id === p.roundId &&
                  r.reportId === input.reportId &&
                  r.state === 'open',
              ),
          )
          if (reviewing) {
            return {
              _tag: 'Refused',
              reason: 'reviewer_in_open_round',
            } as const
          }
          members.push({
            reportId: input.reportId,
            userId: input.userId,
            roleId: input.roleId,
            addedAt: input.now,
          })
          addAudit(input.audit)
          return { _tag: 'Added' } as const
        }),
      moveReport: input =>
        Effect.sync(() => {
          const index = reports.findIndex(
            r => r.id === input.reportId && r.state === input.from,
          )
          if (index < 0)
            return { _tag: 'Refused', reason: 'wrong_state' } as const
          reports[index] = {
            ...(reports[index] as ReportRow),
            state: input.to,
            updatedAt: input.now,
          }
          addAudit(input.audit)
          return { _tag: 'Moved' } as const
        }),

      startWorkingCopy: input =>
        Effect.sync(() => {
          const existing = workingCopies.find(
            w => w.reportId === input.reportId && w.userId === input.userId,
          )
          if (existing !== undefined) return existing
          const draft = drafts.find(
            d => d.reportId === input.reportId && d.number === input.fromDraft,
          )
          if (
            draft === undefined ||
            !members.some(
              m => m.reportId === input.reportId && m.userId === input.userId,
            )
          ) {
            return null
          }
          const created: WcRow = {
            reportId: input.reportId,
            userId: input.userId,
            baseDraft: input.fromDraft,
            saveCounter: 0,
            sharedCounter: 0,
            people: draft.people,
            startedAt: input.now,
            lastSavedAt: input.now,
          }
          workingCopies.push(created)
          draftSections
            .filter(
              s =>
                s.reportId === input.reportId &&
                s.draftNumber === input.fromDraft,
            )
            .forEach(s =>
              wcSections.push({
                reportId: input.reportId,
                userId: input.userId,
                sectionId: s.sectionId,
                ordinal: s.ordinal,
                content: s.content,
                saveCounter: 0,
                savedAt: input.now,
              }),
            )
          return created
        }),
      getWorkingCopy: (reportId, userId) =>
        Effect.sync(
          () =>
            workingCopies.find(
              w => w.reportId === reportId && w.userId === userId,
            ) ?? null,
        ),
      listWorkingCopySections: (reportId, userId) =>
        Effect.sync(() =>
          wcSections
            .filter(s => s.reportId === reportId && s.userId === userId)
            .sort(
              byKey(
                s => s.ordinal,
                s => s.sectionId,
              ),
            )
            .map(s => ({
              sectionId: s.sectionId,
              ordinal: s.ordinal,
              bytes: utf8(s.content),
              version: s.saveCounter,
            })),
        ),
      getWorkingCopySection: (reportId, userId, sectionId) =>
        Effect.sync(() => {
          const row = wcSections.find(
            s =>
              s.reportId === reportId &&
              s.userId === userId &&
              s.sectionId === sectionId,
          )
          return row === undefined
            ? null
            : { content: row.content, version: row.saveCounter }
        }),
      saveWorkingCopy: input =>
        Effect.sync(() => {
          const index = workingCopies.findIndex(
            w =>
              w.reportId === input.reportId &&
              w.userId === input.userId &&
              w.saveCounter === input.expectedCounter,
          )
          if (index < 0)
            return { _tag: 'Refused', reason: 'stale_save' } as const
          const current = workingCopies[index] as WcRow
          const next = current.saveCounter + 1
          workingCopies[index] = {
            ...current,
            saveCounter: next,
            lastSavedAt: input.now,
            people: input.people ?? current.people,
          }
          input.sections.forEach(section => {
            const at = wcSections.findIndex(
              s =>
                s.reportId === input.reportId &&
                s.userId === input.userId &&
                s.sectionId === section.sectionId,
            )
            const row: WcSectionRow = {
              reportId: input.reportId,
              userId: input.userId,
              sectionId: section.sectionId,
              ordinal: section.ordinal,
              content: section.content,
              saveCounter: next,
              savedAt: input.now,
            }
            if (at < 0) wcSections.push(row)
            else wcSections[at] = row
          })
          return { _tag: 'Saved', saveCounter: next } as const
        }),
      getWorkingCopyContents: (reportId, userId) =>
        Effect.sync(() =>
          wcSections
            .filter(s => s.reportId === reportId && s.userId === userId)
            .sort(
              byKey(
                s => s.ordinal,
                s => s.sectionId,
              ),
            )
            .map(s => ({
              sectionId: s.sectionId,
              ordinal: s.ordinal,
              content: s.content,
              version: s.saveCounter,
            })),
        ),
      rebaseWorkingCopy: input =>
        Effect.sync(() => {
          const index = workingCopies.findIndex(
            w =>
              w.reportId === input.reportId &&
              w.userId === input.userId &&
              w.saveCounter === input.expectedCounter,
          )
          const draftExists = drafts.some(
            d => d.reportId === input.reportId && d.number === input.baseDraft,
          )
          if (index < 0 || !draftExists) {
            return {
              _tag: 'Refused',
              reason: draftExists ? 'stale_save' : 'no_draft',
            } as const
          }
          const current = workingCopies[index] as WcRow
          const next = current.saveCounter + 1
          workingCopies[index] = {
            ...current,
            baseDraft: input.baseDraft,
            people: input.people,
            saveCounter: next,
            sharedCounter: input.markShared === true ? next : current.sharedCounter,
            lastSavedAt: input.now,
          }
          const keep = new Set(input.sections.map(s => s.sectionId))
          for (let at = wcSections.length - 1; at >= 0; at -= 1) {
            const row = wcSections[at] as WcSectionRow
            if (
              row.reportId === input.reportId &&
              row.userId === input.userId &&
              !keep.has(row.sectionId)
            ) {
              wcSections.splice(at, 1)
            }
          }
          input.sections.forEach(section => {
            const at = wcSections.findIndex(
              s =>
                s.reportId === input.reportId &&
                s.userId === input.userId &&
                s.sectionId === section.sectionId,
            )
            const row: WcSectionRow = {
              reportId: input.reportId,
              userId: input.userId,
              sectionId: section.sectionId,
              ordinal: section.ordinal,
              content: section.content,
              saveCounter: next,
              savedAt: input.now,
            }
            if (at < 0) wcSections.push(row)
            else wcSections[at] = row
          })
          return { _tag: 'Saved', saveCounter: next } as const
        }),
      listDrafting: reportId =>
        Effect.sync(() =>
          workingCopies
            .filter(w => w.reportId === reportId)
            .sort(
              byKey(
                w => -w.lastSavedAt,
                w => w.userId,
              ),
            )
            .map(w => ({
              userId: w.userId,
              name: nameOf(w.userId),
              baseDraft: w.baseDraft,
              lastSavedAt: w.lastSavedAt,
              unshared: w.saveCounter > w.sharedCounter,
            })),
        ),

      stageShareSection: input =>
        Effect.sync(() => {
          const source = wcSections.find(
            s =>
              s.reportId === input.reportId &&
              s.userId === input.userId &&
              s.sectionId === input.sectionId &&
              s.saveCounter === input.sectionVersion,
          )
          if (source === undefined) {
            return { _tag: 'Refused', reason: 'changed' } as const
          }
          const wcNow = workingCopies.find(
            w => w.reportId === input.reportId && w.userId === input.userId,
          )
          if (wcNow?.people !== input.people) {
            return { _tag: 'Refused', reason: 'changed' } as const
          }
          if (
            staging.some(
              s =>
                s.shareId === input.shareId &&
                s.sectionId !== input.sectionId &&
                s.peopleHash !== input.peopleHash,
            )
          ) {
            return { _tag: 'Refused', reason: 'changed' } as const
          }
          const taken = staging.find(
            s =>
              s.shareId === input.shareId &&
              s.sectionId === input.sectionId &&
              (s.reportId !== input.reportId || s.userId !== input.userId),
          )
          if (taken !== undefined) {
            return { _tag: 'Refused', reason: 'changed' } as const
          }
          staging = staging.filter(
            s =>
              !(s.shareId === input.shareId && s.sectionId === input.sectionId),
          )
          staging.push({
            shareId: input.shareId,
            reportId: input.reportId,
            userId: input.userId,
            sectionId: input.sectionId,
            ordinal: source.ordinal,
            content: source.content,
            redactedContent: input.redactedContent,
            redactedHash: input.redactedHash,
            imageRefs: input.imageRefs,
            peopleHash: input.peopleHash,
            stagedAt: input.now,
          })
          return { _tag: 'Staged' } as const
        }),
      finishShare: input =>
        Effect.sync((): FinishShareOutcome => {
          const existing = drafts.find(
            d => d.reportId === input.reportId && d.shareId === input.shareId,
          )
          if (existing !== undefined) {
            return { _tag: 'AlreadyShared', number: existing.number }
          }
          const wc = workingCopies.find(
            w => w.reportId === input.reportId && w.userId === input.userId,
          )
          const report = reports.find(r => r.id === input.reportId)
          if (wc === undefined || report === undefined) {
            return { _tag: 'Refused', reason: 'no_working_copy' }
          }
          if (report.state === 'archived') {
            return { _tag: 'Refused', reason: 'wrong_state' }
          }
          const latest = latestDraftOf(input.reportId)
          if (wc.baseDraft !== input.baseDraft || latest !== input.baseDraft) {
            return { _tag: 'Refused', reason: 'stale_base', latest }
          }
          const mine = staging.filter(
            s =>
              s.shareId === input.shareId &&
              s.reportId === input.reportId &&
              s.userId === input.userId,
          )
          if (
            wc.people !== input.people ||
            staging.some(
              s => s.shareId === input.shareId && s.peopleHash !== input.peopleHash,
            )
          ) {
            return { _tag: 'Refused', reason: 'people_changed' }
          }
          const caseFile = caseFiles.find(f => f.id === report.caseFileId)
          if (
            caseFile === undefined ||
            caseFile.title !== input.caseGuard.title ||
            caseFile.reference !== input.caseGuard.reference
          ) {
            return { _tag: 'Refused', reason: 'case_changed' }
          }
          if (mine.length !== input.expectedSections) {
            return { _tag: 'Refused', reason: 'share_incomplete' }
          }
          const joined = [...mine]
            .sort(
              byKey(
                s => s.ordinal,
                s => s.sectionId,
              ),
            )
            .map(s => s.redactedHash)
            .join(',')
          if (
            input.confirmation !== undefined &&
            input.confirmation.joinedHashes !== joined
          ) {
            return { _tag: 'Refused', reason: 'not_confirmed' }
          }
          if (input.publish !== undefined) {
            if (
              input.publish.requiresConfirmation === true &&
              input.confirmation === undefined
            ) {
              return { _tag: 'Refused', reason: 'not_confirmed' }
            }
            const refusal = publishRefusal(input.reportId, 'new', input.publish)
            if (refusal !== null && refusal._tag === 'Refused') {
              return refusal
            }
          }
          const number = latest + 1
          drafts.push({
            reportId: input.reportId,
            number,
            baseNumber: input.baseDraft,
            authorId: input.userId,
            sharedAt: input.now,
            shareId: input.shareId,
            people: wc.people,
            caseTitleRedacted: input.redactedCaseTitle,
            caseReferenceRedacted: input.redactedCaseReference,
          })
          mine.forEach(s =>
            draftSections.push({
              reportId: input.reportId,
              draftNumber: number,
              sectionId: s.sectionId,
              ordinal: s.ordinal,
              content: s.content,
              redactedContent: s.redactedContent,
              redactedHash: s.redactedHash,
            }),
          )
          const flags = new Map<string, boolean>()
          mine.forEach(s => {
            const refs = JSON.parse(s.imageRefs) as Array<{
              id: string
              safe: boolean
            }>
            refs.forEach(ref =>
              flags.set(ref.id, (flags.get(ref.id) ?? true) && ref.safe),
            )
          })
          flags.forEach((safe, imageId) =>
            draftImages.push({
              reportId: input.reportId,
              draftNumber: number,
              imageId,
              safe,
            }),
          )
          const at = workingCopies.indexOf(wc)
          // NOTE: shared up to the newest section that still has the staged
          // content (a section saved after staging stays "unshared").
          const sharedCounter = Math.max(
            0,
            ...wcSections
              .filter(
                w =>
                  w.reportId === input.reportId &&
                  w.userId === input.userId &&
                  mine.some(
                    s => s.sectionId === w.sectionId && s.content === w.content,
                  ),
              )
              .map(w => w.saveCounter),
          )
          workingCopies[at] = { ...wc, baseDraft: number, sharedCounter }
          if (input.confirmation !== undefined) {
            confirmations.push({
              reportId: input.reportId,
              draftNumber: number,
              at: input.now,
            })
            addAudit(input.confirmation.audit, {
              reportId: input.reportId,
              draftNumber: number,
            })
          }
          staging = staging.filter(
            s =>
              !(s.shareId === input.shareId && s.reportId === input.reportId),
          )
          addAudit(input.audit, {
            reportId: input.reportId,
            draftNumber: number,
          })
          if (input.publish !== undefined) {
            applyPublish(input.reportId, number, input.publish)
          }
          return {
            _tag: 'Shared',
            number,
            revision: input.publish?.revision ?? null,
          }
        }),

      getDraft: (reportId, number) =>
        Effect.sync(() => {
          const row = drafts.find(
            d => d.reportId === reportId && d.number === number,
          )
          return row === undefined ? null : draftRecord(row)
        }),
      listDrafts: reportId =>
        Effect.sync(() =>
          drafts
            .filter(d => d.reportId === reportId)
            .sort(byKey(d => d.number))
            .map(draftRecord),
        ),
      listDraftSections: (reportId, number) =>
        Effect.sync(() =>
          draftSections
            .filter(s => s.reportId === reportId && s.draftNumber === number)
            .sort(
              byKey(
                s => s.ordinal,
                s => s.sectionId,
              ),
            )
            .map(s => ({
              sectionId: s.sectionId,
              ordinal: s.ordinal,
              bytes: utf8(s.content),
              version: s.redactedHash,
            })),
        ),
      getDraftSection: (reportId, number, sectionId, view) =>
        Effect.sync(() => {
          const row = draftSections.find(
            s =>
              s.reportId === reportId &&
              s.draftNumber === number &&
              s.sectionId === sectionId,
          )
          if (row === undefined) return null
          return view === 'original' ? row.content : row.redactedContent
        }),
      getDraftContents: (reportId, number, view) =>
        Effect.sync(() =>
          draftSections
            .filter(s => s.reportId === reportId && s.draftNumber === number)
            .sort(
              byKey(
                s => s.ordinal,
                s => s.sectionId,
              ),
            )
            .map(s => ({
              sectionId: s.sectionId,
              ordinal: s.ordinal,
              content: view === 'original' ? s.content : s.redactedContent,
              version: s.redactedHash,
            })),
        ),
      listRedactedHashes: reportId =>
        Effect.sync(() => {
          const numbers = [
            ...new Set(
              draftSections
                .filter(s => s.reportId === reportId)
                .map(s => s.draftNumber),
            ),
          ].sort((a, b) => a - b)
          return numbers.map(draftNumber => ({
            draftNumber,
            hash: draftSections
              .filter(
                s => s.reportId === reportId && s.draftNumber === draftNumber,
              )
              .sort(
                byKey(
                  s => s.ordinal,
                  s => s.sectionId,
                ),
              )
              .map(s => s.redactedHash)
              .join(','),
          }))
        }),
      confirmRedaction: input =>
        Effect.sync(() => {
          if (
            !drafts.some(
              d =>
                d.reportId === input.reportId && d.number === input.draftNumber,
            )
          ) {
            return false
          }
          if (
            !confirmations.some(
              c =>
                c.reportId === input.reportId &&
                c.draftNumber === input.draftNumber,
            )
          ) {
            confirmations.push({
              reportId: input.reportId,
              draftNumber: input.draftNumber,
              at: input.now,
            })
            addAudit(input.audit)
          }
          return true
        }),
      getRevision: (reportId, number) =>
        Effect.sync(
          () =>
            revisions.find(
              r => r.reportId === reportId && r.number === number,
            ) ?? null,
        ),
      listRevisions: reportId =>
        Effect.sync(() =>
          revisions
            .filter(r => r.reportId === reportId)
            .sort(byKey(r => r.number)),
        ),
      getRevisionSection: (reportId, revision, sectionId, view) =>
        Effect.sync(() => {
          const rev = revisions.find(
            r => r.reportId === reportId && r.number === revision,
          )
          if (rev === undefined) return null
          const row = draftSections.find(
            s =>
              s.reportId === reportId &&
              s.draftNumber === rev.draftNumber &&
              s.sectionId === sectionId,
          )
          if (row === undefined) return null
          return view === 'original' ? row.content : row.redactedContent
        }),
      listRevisionSections: (reportId, revision) =>
        Effect.sync(() => {
          const rev = revisions.find(
            r => r.reportId === reportId && r.number === revision,
          )
          if (rev === undefined) return []
          return draftSections
            .filter(
              s => s.reportId === reportId && s.draftNumber === rev.draftNumber,
            )
            .sort(
              byKey(
                s => s.ordinal,
                s => s.sectionId,
              ),
            )
            .map(s => ({
              sectionId: s.sectionId,
              ordinal: s.ordinal,
              bytes: utf8(s.content),
              version: s.redactedHash,
            }))
        }),

      publishRevision: input =>
        Effect.sync((): PublishOutcome => {
          const draft = input.draft ?? -1
          if (
            !drafts.some(
              d => d.reportId === input.reportId && d.number === draft,
            )
          ) {
            const report = reports.find(r => r.id === input.reportId)
            if (
              report === undefined ||
              !input.fromStates.includes(report.state)
            ) {
              return { _tag: 'Refused', reason: 'wrong_state' }
            }
            return { _tag: 'Refused', reason: 'not_latest' }
          }
          const refusal = publishRefusal(input.reportId, draft, input)
          if (refusal !== null) return refusal
          applyPublish(input.reportId, draft, input)
          return {
            _tag: 'Published',
            revision: input.revision,
            roundId: input.roundId,
          }
        }),
      getRound: (reportId, revision) =>
        Effect.sync(() => {
          const row = rounds.find(
            r => r.reportId === reportId && r.revision === revision,
          )
          return row === undefined ? null : withParticipants(row)
        }),
      getOpenRound: reportId =>
        Effect.sync(() => {
          const row = rounds.find(
            r => r.reportId === reportId && r.state === 'open',
          )
          return row === undefined ? null : withParticipants(row)
        }),
      listRounds: reportId =>
        Effect.sync(() =>
          rounds
            .filter(r => r.reportId === reportId)
            .sort(byKey(r => r.revision))
            .map(withParticipants),
        ),
      getParticipation: (reportId, revision, userId) =>
        Effect.sync(() => {
          const round = rounds.find(
            r => r.reportId === reportId && r.revision === revision,
          )
          const part = participants.find(
            p => p.roundId === round?.id && p.userId === userId,
          )
          const rev = revisions.find(
            r => r.reportId === reportId && r.number === revision,
          )
          if (round === undefined || part === undefined || rev === undefined) {
            return null
          }
          return {
            round,
            roleId: part.roleId,
            removedAt: part.removedAt,
            draftNumber: rev.draftNumber,
          }
        }),
      listAssignments: userId =>
        Effect.sync(() =>
          participants
            .filter(p => p.userId === userId)
            .flatMap((p): Array<AssignmentRecord> => {
              const round = rounds.find(r => r.id === p.roundId)
              return round === undefined
                ? []
                : [
                    {
                      reportId: round.reportId,
                      revision: round.revision,
                      roundId: round.id,
                      roleId: p.roleId,
                      removedAt: p.removedAt,
                      roundState: round.state,
                      deadlineAt: round.deadlineAt,
                      closing: round.closing,
                    },
                  ]
            })
            .sort(
              byKey(
                a => a.reportId,
                a => a.revision,
              ),
            ),
        ),
      decideRound: input =>
        Effect.sync(() => {
          const index = rounds.findIndex(
            r => r.id === input.roundId && r.state === 'open',
          )
          if (index < 0) return { _tag: 'Refused', reason: 'not_open' } as const
          if (!decisionStillHolds(input, activeParticipants(input.roundId))) {
            return { _tag: 'Refused', reason: 'changed' } as const
          }
          applyDecision(input)
          return { _tag: 'Decided' } as const
        }),
      extendDeadline: input =>
        Effect.sync(() => {
          const index = rounds.findIndex(
            r => r.id === input.roundId && r.state === 'open',
          )
          if (index < 0) return { _tag: 'Refused', reason: 'not_open' } as const
          const round = rounds[index] as RoundRecord
          if (input.deadlineAt <= round.deadlineAt) {
            return { _tag: 'Refused', reason: 'not_later' } as const
          }
          rounds[index] = {
            ...round,
            deadlineAt: input.deadlineAt,
            deadlineZone: input.deadlineZone,
          }
          const at = reports.findIndex(r => r.id === input.reportId)
          reports[at] = {
            ...(reports[at] as ReportRow),
            deadlineAt: input.deadlineAt,
            deadlineZone: input.deadlineZone,
            updatedAt: input.now,
          }
          addJobs(input.reportId, input.roundId, input.jobs, input.now)
          addAudit(input.audit)
          return { _tag: 'Extended' } as const
        }),
      removeParticipant: input =>
        Effect.sync(() => {
          const round = rounds.find(r => r.id === input.roundId)
          if (round === undefined || round.state !== 'open') {
            return { _tag: 'Refused', reason: 'not_open' } as const
          }
          const index = participants.findIndex(
            p =>
              p.roundId === input.roundId &&
              p.userId === input.userId &&
              p.removedAt === null,
          )
          if (index < 0) {
            return { _tag: 'Refused', reason: 'not_a_participant' } as const
          }
          const decision =
            input.decide === undefined
              ? undefined
              : {
                  ...input.decide,
                  roundId: input.roundId,
                  reportId: input.reportId,
                  now: input.now,
                }
          if (
            decision !== undefined &&
            !decisionStillHolds(decision, activeParticipants(input.roundId) - 1)
          ) {
            return { _tag: 'Refused', reason: 'changed' } as const
          }
          participants[index] = {
            ...(participants[index] as ParticipantRow),
            removedAt: input.now,
            removedBy: input.removedBy,
          }
          skipJobsOf(input.roundId, input.userId)
          addJobs(input.reportId, input.roundId, input.jobs ?? [], input.now)
          addAudit(input.audit)
          if (decision !== undefined) applyDecision(decision)
          return { _tag: 'Removed' } as const
        }),

      savePendingReview: input =>
        Effect.sync(() => {
          if (!isActiveReviewer(input.roundId, input.reviewerId, undefined)) {
            return { _tag: 'Refused', reason: 'not_open' } as const
          }
          const index = pending.findIndex(
            p =>
              p.roundId === input.roundId && p.reviewerId === input.reviewerId,
          )
          const row: PendingRow = {
            roundId: input.roundId,
            reviewerId: input.reviewerId,
            decision: input.decision,
          }
          if (index < 0) pending.push(row)
          else pending[index] = row
          return { _tag: 'Saved' } as const
        }),
      getPendingReview: (roundId, reviewerId) =>
        Effect.sync(() => ({
          decision:
            pending.find(
              p => p.roundId === roundId && p.reviewerId === reviewerId,
            )?.decision ?? null,
          comments: comments
            .filter(
              c =>
                c.roundId === roundId &&
                c.authorId === reviewerId &&
                c.reviewId === null,
            )
            .sort(
              byKey(
                c => c.createdAt,
                c => c.id,
              ),
            )
            .map(commentRecord),
        })),
      addPendingComment: input =>
        Effect.sync(() => {
          if (!isActiveReviewer(input.roundId, input.reviewerId, undefined)) {
            return { _tag: 'Refused', reason: 'not_open' } as const
          }
          const round = rounds.find(r => r.id === input.roundId) as RoundRecord
          comments.push({
            id: input.id,
            reportId: round.reportId,
            targetKind: 'revision',
            targetNumber: input.revision,
            roundId: input.roundId,
            sectionId: input.sectionId,
            itemId: input.itemId,
            rangeFrom: input.rangeFrom,
            rangeTo: input.rangeTo,
            quoted: input.quoted,
            body: input.body,
            redactedBody: input.redactedBody,
            authorId: input.reviewerId,
            visibility: input.visibility,
            resolved: false,
            reviewId: null,
            createdAt: input.now,
          })
          if (
            !pending.some(
              p =>
                p.roundId === input.roundId &&
                p.reviewerId === input.reviewerId,
            )
          ) {
            pending.push({
              roundId: input.roundId,
              reviewerId: input.reviewerId,
              decision: null,
            })
          }
          return { _tag: 'Added' } as const
        }),
      updatePendingComment: input =>
        Effect.sync(() => {
          const index = comments.findIndex(
            c =>
              c.id === input.id &&
              c.authorId === input.reviewerId &&
              c.reviewId === null &&
              rounds.find(r => r.id === c.roundId)?.state === 'open',
          )
          if (index < 0) return false
          comments[index] = {
            ...(comments[index] as CommentRow),
            body: input.body,
            redactedBody: input.redactedBody ?? null,
            visibility: input.visibility,
          }
          return true
        }),
      getComment: (reportId, commentId) =>
        Effect.sync(() => {
          const found = comments.find(
            c => c.id === commentId && c.reportId === reportId,
          )
          return found === undefined ? null : commentRecord(found)
        }),
      deletePendingComment: (id, reviewerId) =>
        Effect.sync(() => {
          const index = comments.findIndex(
            c =>
              c.id === id &&
              c.authorId === reviewerId &&
              c.reviewId === null &&
              rounds.find(r => r.id === c.roundId)?.state === 'open',
          )
          if (index < 0) return false
          comments.splice(index, 1)
          return true
        }),
      sendReview: input =>
        Effect.sync(() => {
          const round = rounds.find(r => r.id === input.roundId)
          if (
            round === undefined ||
            !isActiveReviewer(input.roundId, input.reviewerId, input.now) ||
            round.deadlineAt <= input.now
          ) {
            return { _tag: 'Refused', reason: 'not_open' } as const
          }
          const mine = comments.filter(
            c =>
              c.roundId === input.roundId &&
              c.authorId === input.reviewerId &&
              c.reviewId === null,
          )
          reviews.push({
            id: input.reviewId,
            roundId: input.roundId,
            revision: round.revision,
            reviewerId: input.reviewerId,
            decision: input.decision,
            hasComments: mine.length > 0,
            sentAt: input.now,
          })
          comments.forEach((c, index) => {
            if (mine.includes(c))
              comments[index] = { ...c, reviewId: input.reviewId }
          })
          const at = pending.findIndex(
            p =>
              p.roundId === input.roundId && p.reviewerId === input.reviewerId,
          )
          if (at >= 0) pending.splice(at, 1)
          addJobs(input.reportId, input.roundId, input.jobs, input.now)
          addAudit(input.audit)
          return { _tag: 'Sent', hasComments: mine.length > 0 } as const
        }),
      listReviews: reportId =>
        Effect.sync(() =>
          reviews
            .filter(r =>
              rounds.some(
                round => round.id === r.roundId && round.reportId === reportId,
              ),
            )
            .sort(
              byKey(
                r => r.sentAt,
                r => r.id,
              ),
            ),
        ),
      addDraftComment: input =>
        Effect.sync(() => {
          const ok =
            drafts.some(
              d =>
                d.reportId === input.reportId && d.number === input.draftNumber,
            ) &&
            members.some(
              m => m.reportId === input.reportId && m.userId === input.authorId,
            )
          if (!ok) return { _tag: 'Refused', reason: 'not_found' } as const
          comments.push({
            id: input.id,
            reportId: input.reportId,
            targetKind: 'draft',
            targetNumber: input.draftNumber,
            roundId: null,
            sectionId: input.sectionId,
            itemId: input.itemId,
            rangeFrom: input.rangeFrom,
            rangeTo: input.rangeTo,
            quoted: input.quoted,
            body: input.body,
            redactedBody: input.redactedBody,
            authorId: input.authorId,
            visibility: 'authors',
            resolved: false,
            reviewId: null,
            createdAt: input.now,
          })
          return { _tag: 'Added' } as const
        }),
      addReply: input =>
        Effect.sync(() => {
          if (!comments.some(c => c.id === input.commentId)) return false
          replies.push({
            id: input.id,
            commentId: input.commentId,
            authorId: input.authorId,
            body: input.body,
            redactedBody: input.redactedBody,
            createdAt: input.now,
          })
          return true
        }),
      setCommentResolved: (commentId, resolved) =>
        Effect.sync(() => {
          const index = comments.findIndex(c => c.id === commentId)
          if (index < 0) return false
          comments[index] = { ...(comments[index] as CommentRow), resolved }
          return true
        }),
      listComments: input =>
        Effect.sync(() => {
          const visible = comments
            .filter(
              c =>
                c.reportId === input.reportId &&
                c.targetKind === input.kind &&
                c.targetNumber === input.number,
            )
            .filter(c => {
              if (input.audience.kind === 'authors') {
                return c.targetKind === 'draft' || c.reviewId !== null
              }
              const userId = input.audience.userId
              return (
                c.authorId === userId ||
                (c.reviewId !== null && c.visibility === 'committee')
              )
            })
            .sort(
              byKey(
                c => c.createdAt,
                c => c.id,
              ),
            )
          const ids = new Set(visible.map(c => c.id))
          return {
            comments: visible.map(commentRecord),
            replies: replies
              .filter(r => ids.has(r.commentId))
              .sort(
                byKey(
                  r => r.createdAt,
                  r => r.id,
                ),
              )
              .map(r => ({ ...r, authorName: nameOf(r.authorId) })),
          }
        }),

      claimDueJobs: input =>
        Effect.sync(() => {
          const due = jobs
            .filter(
              j =>
                (j.state === 'pending' && j.dueAt <= input.now) ||
                (j.state === 'claimed' &&
                  j.leaseUntil !== null &&
                  j.leaseUntil < input.now),
            )
            .sort(
              byKey(
                j => j.dueAt,
                j => j.id,
              ),
            )
            .slice(0, input.limit)
          return due.map(job => {
            const claimed: JobRecord = {
              ...job,
              state: 'claimed',
              claimedBy: input.claimedBy,
              leaseUntil: input.now + input.leaseMs,
              attempts: job.attempts + 1,
            }
            jobs[jobs.indexOf(job)] = claimed
            return claimed
          })
        }),
      finishJobs: input =>
        Effect.sync(() => {
          jobs.forEach((job, index) => {
            if (job.state !== 'claimed' || job.claimedBy !== input.claimedBy) {
              return
            }
            if (input.done.includes(job.id)) {
              jobs[index] = { ...job, state: 'done', doneAt: input.now }
            } else if (input.skipped.includes(job.id)) {
              jobs[index] = { ...job, state: 'skipped', doneAt: input.now }
            }
          })
        }),
      listJobKeys: reportId =>
        Effect.sync(() =>
          jobs
            .filter(j => j.reportId === reportId)
            .map(j => j.key)
            .sort(),
        ),
      listInbox: (userId, limit, before) =>
        Effect.sync(() =>
          jobs
            .filter(
              j =>
                j.recipientId === userId &&
                j.channel === 'inbox' &&
                j.state === 'done' &&
                (before === undefined || j.id < before),
            )
            .sort(byKey(j => -j.id))
            .slice(0, limit),
        ),
      countUnread: userId =>
        Effect.sync(
          () =>
            jobs.filter(
              j =>
                j.recipientId === userId &&
                j.channel === 'inbox' &&
                j.state === 'done' &&
                j.readAt === null,
            ).length,
        ),
      markInboxRead: (userId, ids, now) =>
        Effect.sync(() => {
          let changed = 0
          jobs.forEach((job, index) => {
            if (
              ids.includes(job.id) &&
              job.recipientId === userId &&
              job.channel === 'inbox' &&
              job.state === 'done' &&
              job.readAt === null
            ) {
              jobs[index] = { ...job, readAt: now }
              changed += 1
            }
          })
          return changed
        }),
      recordEvent: event =>
        Effect.sync(() => {
          const once =
            event.kind === 'draft_read' ||
            event.kind === 'read' ||
            event.kind === 'whatsapp_opened'
          if (
            once &&
            events.some(
              e =>
                e.reportId === event.reportId &&
                e.kind === event.kind &&
                e.accountId === event.accountId &&
                e.draftNumber === (event.draftNumber ?? null) &&
                e.revisionNumber === (event.revisionNumber ?? null),
            )
          ) {
            return
          }
          eventSeq += 1
          events.push({
            id: eventSeq,
            reportId: event.reportId,
            kind: event.kind,
            accountId: event.accountId,
            draftNumber: event.draftNumber ?? null,
            revisionNumber: event.revisionNumber ?? null,
            detail: event.detail ?? null,
            at: event.at,
          })
        }),
      listEvents: (reportId, limit) =>
        Effect.sync(() =>
          events.filter(e => e.reportId === reportId).slice(-limit),
        ),
      appendAudit: input => Effect.sync(() => addAudit(input)),
      listAudit: filter =>
        Effect.sync(() =>
          audit
            .filter(
              a =>
                (filter.reportId === undefined ||
                  a.reportId === filter.reportId) &&
                (filter.templateId === undefined ||
                  a.templateId === filter.templateId) &&
                (filter.actionPrefix === undefined ||
                  a.action.startsWith(filter.actionPrefix)) &&
                (filter.before === undefined || a.id < filter.before),
            )
            .sort(byKey(a => -a.id))
            .slice(0, filter.limit),
        ),

      putImageChunk: input =>
        Effect.sync((): PutChunkOutcome => {
          if (imageChunkProblem(input) !== null) {
            return { _tag: 'Refused', reason: 'bad_chunk' }
          }
          const existing = images.find(i => i.id === input.imageId)
          const sameOwner = (a: ImageOwnerRef, b: ImageOwnerRef): boolean =>
            a.kind === b.kind &&
            (a.kind === 'theme' ||
              (b.kind === 'report' && a.reportId === b.reportId))
          if (
            existing !== undefined &&
            (!sameOwner(existing.owner, input.owner) ||
              existing.size !== input.size ||
              existing.chunkCount !== input.chunkCount ||
              existing.uploadedBy !== input.uploadedBy)
          ) {
            return { _tag: 'Refused', reason: 'mismatch' }
          }
          const stored = chunks.get(`${input.imageId}#${input.index}`)
          if (stored !== undefined) {
            // NOTE: a retried upload with identical content is answered again.
            if (stored !== input.data || existing === undefined) {
              return { _tag: 'Refused', reason: 'duplicate' }
            }
            return {
              _tag: 'Stored',
              received: [...chunks.keys()].filter(key =>
                key.startsWith(`${input.imageId}#`),
              ).length,
              complete: existing.complete,
              image: existing.complete ? imageRecord(existing) : null,
            }
          }
          if (existing?.complete === true) {
            return { _tag: 'Refused', reason: 'mismatch' }
          }
          if (
            storedImageBytes + input.data.length >
            IMAGE_LIMITS.databaseBytes
          ) {
            return { _tag: 'Refused', reason: 'database_full' }
          }
          if (input.owner.kind === 'report') {
            const owner = input.owner
            const used = images
              .filter(
                i =>
                  i.id !== input.imageId &&
                  i.owner.kind === 'report' &&
                  i.owner.reportId === owner.reportId,
              )
              .reduce((sum, i) => sum + i.size, 0)
            if (used + input.size > IMAGE_LIMITS.reportBytes) {
              return { _tag: 'Refused', reason: 'report_limit' }
            }
          }
          let row = existing
          if (row === undefined) {
            row = {
              id: input.imageId,
              owner: input.owner,
              uploadedBy: input.uploadedBy,
              mime: input.mime,
              width: input.width,
              height: input.height,
              size: input.size,
              hash: input.hash,
              chunkCount: input.chunkCount,
              storedBytes: 0,
              complete: false,
              createdAt: input.now,
            }
            images.push(row)
          }
          chunks.set(`${input.imageId}#${input.index}`, input.data)
          storedImageBytes += input.data.length
          const received = [...chunks.keys()].filter(key =>
            key.startsWith(`${input.imageId}#`),
          ).length
          const complete = received === row.chunkCount
          const updated: ImageRow = {
            ...row,
            storedBytes: row.storedBytes + input.data.length,
            complete,
          }
          images[images.indexOf(row)] = updated
          return {
            _tag: 'Stored',
            received,
            complete,
            image: complete ? imageRecord(updated) : null,
          }
        }),
      getImage: imageId =>
        Effect.sync(() => {
          const row = images.find(i => i.id === imageId)
          return row === undefined ? null : imageRecord(row)
        }),
      readImageChunk: (imageId, index) =>
        Effect.sync(() => {
          const row = images.find(i => i.id === imageId)
          return row?.complete === true
            ? (chunks.get(`${imageId}#${index}`) ?? null)
            : null
        }),
      readDraftImageChunk: input =>
        Effect.sync(() => {
          const ref = draftImages.find(
            d =>
              d.reportId === input.reportId &&
              d.draftNumber === input.draftNumber &&
              d.imageId === input.imageId &&
              (!input.safeOnly || d.safe),
          )
          const row = images.find(i => i.id === input.imageId)
          return ref === undefined || row?.complete !== true
            ? null
            : (chunks.get(`${input.imageId}#${input.index}`) ?? null)
        }),
      readRevisionImageChunk: input =>
        Effect.sync(() => {
          const rev = revisions.find(
            r => r.reportId === input.reportId && r.number === input.revision,
          )
          if (rev === undefined) return null
          const ref = draftImages.find(
            d =>
              d.reportId === input.reportId &&
              d.draftNumber === rev.draftNumber &&
              d.imageId === input.imageId &&
              (!input.safeOnly || d.safe),
          )
          // NOTE: a redacted reader also needs the image marked safe in the
          // latest draft: an image withdrawn later is no longer served.
          const latest = Math.max(
            ...drafts.filter(d => d.reportId === input.reportId).map(d => d.number),
          )
          const current =
            !input.safeOnly ||
            draftImages.some(
              d =>
                d.reportId === input.reportId &&
                d.draftNumber === latest &&
                d.imageId === input.imageId &&
                d.safe,
            )
          const row = images.find(i => i.id === input.imageId)
          return ref === undefined || !current || row?.complete !== true
            ? null
            : (chunks.get(`${input.imageId}#${input.index}`) ?? null)
        }),
      withdrawImage: (reportId, imageId) =>
        Effect.sync(() => {
          const latest = Math.max(
            ...drafts.filter(d => d.reportId === reportId).map(d => d.number),
          )
          draftImages.forEach(d => {
            if (
              d.reportId === reportId &&
              d.draftNumber === latest &&
              d.imageId === imageId
            ) {
              d.safe = false
            }
          })
        }),
      listReportImages: reportId =>
        Effect.sync(() =>
          images
            .filter(
              i => i.owner.kind === 'report' && i.owner.reportId === reportId,
            )
            .sort(
              byKey(
                i => i.createdAt,
                i => i.id,
              ),
            )
            .map(imageRecord),
        ),
      imageStats: reportId =>
        Effect.sync(() => ({
          databaseBytes: storedImageBytes,
          databaseLimitBytes: IMAGE_LIMITS.databaseBytes,
          reportBytes:
            reportId === null
              ? 0
              : images
                  .filter(
                    i =>
                      i.owner.kind === 'report' &&
                      i.owner.reportId === reportId,
                  )
                  .reduce((sum, i) => sum + i.size, 0),
          reportLimitBytes: IMAGE_LIMITS.reportBytes,
        })),
      deleteUnreferencedImage: imageId =>
        Effect.sync(() => {
          const index = images.findIndex(i => i.id === imageId)
          if (index < 0)
            return { _tag: 'Refused', reason: 'not_found' } as const
          if (
            draftImages.some(d => d.imageId === imageId) ||
            theme?.logoImageId === imageId
          ) {
            return { _tag: 'Refused', reason: 'referenced' } as const
          }
          const row = images[index] as ImageRow
          storedImageBytes -= row.storedBytes
          ;[...chunks.keys()]
            .filter(key => key.startsWith(`${imageId}#`))
            .forEach(key => chunks.delete(key))
          images.splice(index, 1)
          return { _tag: 'Deleted' } as const
        }),
      cleanup: input =>
        Effect.sync(() => {
          const doomed = images
            .filter(
              i =>
                i.createdAt < input.olderThan &&
                !draftImages.some(d => d.imageId === i.id) &&
                theme?.logoImageId !== i.id &&
                !wcSections.some(w => w.content.includes(i.id)) &&
                !staging.some(
                  s => s.stagedAt >= input.olderThan && s.imageRefs.includes(i.id),
                ),
            )
            .sort(
              byKey(
                i => i.createdAt,
                i => i.id,
              ),
            )
            .slice(0, input.limit)
          doomed.forEach(row => {
            storedImageBytes -= row.storedBytes
            ;[...chunks.keys()]
              .filter(key => key.startsWith(`${row.id}#`))
              .forEach(key => chunks.delete(key))
            images.splice(images.indexOf(row), 1)
          })
          const old = staging
            .filter(s => s.stagedAt < input.olderThan)
            .sort((x, y) => x.stagedAt - y.stagedAt)
            .slice(0, input.limit)
          staging = staging.filter(s => !old.includes(s))
          return { images: doomed.length, staged: old.length }
        }),
    }

    // NOTE: an active participant of an open round (and, when `now` is given,
    // also before its deadline is checked by the caller).
    function isActiveReviewer(
      roundId: string,
      userId: string,
      _now: number | undefined,
    ): boolean {
      const round = rounds.find(r => r.id === roundId)
      return (
        round !== undefined &&
        round.state === 'open' &&
        participants.some(
          p =>
            p.roundId === roundId &&
            p.userId === userId &&
            p.removedAt === null,
        )
      )
    }

    return api
  })

export const layerMemoryReport = (
  options: {
    readonly sessions?: Array<MemorySession>
    // NOTE: test seam for the 400 MB guard: bytes already stored.
    readonly initialImageBytes?: number
  } = {},
): Layer.Layer<ReportRepository> =>
  Layer.effect(ReportRepository, makeMemoryReportRepository(options))
