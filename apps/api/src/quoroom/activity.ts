import { Effect, Result } from 'effect'
import type { RpcGroup } from 'effect/rpc'

import {
  type AuditRecord,
  type QuoroomRpcs,
  type ReportEvent,
  CurrentUser,
  Conflict,
  NotFound,
  applyEvent,
  buildGrid,
  checkNewAuthor,
  draftLabel,
  draftingRoleOf,
  revisionTitle,
} from '@case-desk/domain'

import {
  type Loaded,
  type Store,
  QuoroomClock,
  QuoroomConfig,
  allowCapability,
  eventsOf,
  flowFailure,
  jobsFor,
  loadTemplates,
  roundOf,
  store,
  timeZoneOk,
  validation,
} from './core'
import { auditOf, member } from './support'
import { roundViewOf } from './views'

// NOTE: Report extras (co-authors, case file title, deadline, removing a
// reviewer), the grid and audit log, the notification inbox, WhatsApp link
// data and downloads metadata.

type AllHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof QuoroomRpcs>>

// ---- Events ------------------------------------------------------------------------------------

// NOTE: what the grid and the approval record read: the log of the report with
// times. Drafts shared come from the drafts, the reads and sends from the event
// table, the rest from what is stored. Two reads.
const eventsFor = (db: Store, loaded: Loaded) =>
  Effect.gen(function* () {
    const drafts = yield* db.listDrafts(loaded.record.id)
    const logged = yield* db.listEvents(loaded.record.id)
    const extra: Array<ReportEvent> = []
    for (const draft of drafts) {
      if (draft.number >= 1 && draft.authorId !== null) {
        extra.push({
          type: 'draft_shared',
          draft: draft.number,
          accountId: draft.authorId,
          at: draft.sharedAt,
        })
      }
    }
    for (const event of logged) {
      if (event.kind === 'draft_read') {
        extra.push({
          type: 'draft_read',
          draft: event.draftNumber ?? 0,
          accountId: event.accountId,
          at: event.at,
        })
      } else if (event.revisionNumber !== null) {
        const revision = event.revisionNumber
        if (event.kind === 'read') {
          extra.push({ type: 'read', revision, accountId: event.accountId, at: event.at })
        } else if (event.kind === 'whatsapp_opened') {
          extra.push({
            type: 'whatsapp_opened',
            revision,
            accountId: event.accountId,
            at: event.at,
          })
        } else if (event.kind === 'notified') {
          extra.push({ type: 'notified', revision, accountId: event.accountId, at: event.at })
        } else if (event.kind === 'reminded') {
          extra.push({
            type: 'reminded',
            revision,
            accountId: event.accountId,
            kind: event.detail === 'reminder_final' ? 'reminder_final' : 'reminder_first',
            at: event.at,
          })
        }
      }
    }
    return eventsOf(loaded.revisions, loaded.rounds, loaded.reviews, extra)
  })

const namesOf = (loaded: Loaded): ReadonlyMap<string, string> => {
  const names = new Map<string, string>()
  for (const member of loaded.members) names.set(member.userId, member.name)
  for (const { participants } of loaded.rounds) {
    for (const participant of participants) names.set(participant.userId, participant.name)
  }
  return names
}

// ---- Audit -------------------------------------------------------------------------------------

const metaOf = (text: string): Record<string, string | number | boolean> => {
  try {
    const parsed: unknown = JSON.parse(text)
    const out: Record<string, string | number | boolean> = {}
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') out[key] = value.slice(0, 200)
        else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
        else if (typeof value === 'boolean') out[key] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

// ---- WhatsApp ----------------------------------------------------------------------------------

const when = (at: number, zone: string): string => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const part = (type: string) => parts.find(entry => entry.type === type)?.value ?? ''
  const city = (zone.split('/').pop() ?? zone).replaceAll('_', ' ')
  return `${part('day')} ${part('month')}, ${part('hour')}:${part('minute')} ${city} time`
}

const originOf = (headers: Readonly<Record<string, string | undefined>>): string => {
  const host = (headers['host'] ?? 'localhost').replaceAll(/[^A-Za-z0-9.:-]/g, '')
  const local = /^(localhost|127\.|\[?::1)/.test(host)
  const forwarded = headers['x-forwarded-proto']
  const proto = forwarded === 'http' || forwarded === 'https' ? forwarded : local ? 'http' : 'https'
  return `${proto}://${host}`
}

// NOTE: the participant of an open round, who has a phone number and agreed to
// WhatsApp. Anything else is `NotFound` or a refusal.
const whatsAppTarget = (loaded: Loaded, db: Store, revision: number, accountId: string) =>
  Effect.gen(function* () {
    const entry = roundOf(loaded, revision)
    const participant = entry?.participants.find(
      p => p.userId === accountId && p.removedAt === null,
    )
    if (entry === undefined || participant === undefined) {
      return yield* Effect.fail(new NotFound())
    }
    if (entry.round.state !== 'open') {
      return yield* Effect.fail(new Conflict({ reason: 'not_latest' }))
    }
    const account = yield* db.getAccount(accountId)
    const phone = account?.profile?.phone ?? null
    if (account === null || phone === null || account.profile?.whatsappConsent !== true) {
      return yield* Effect.fail(validation('input', 'no_whatsapp_consent'))
    }
    return { entry, account, number: phone.replace(/^\+/, '') }
  })

// ---- Handlers ----------------------------------------------------------------------------------

export const activityHandlers: Pick<
  AllHandlers,
  | 'UpdateCaseFile'
  | 'AddCoAuthor'
  | 'ExtendDeadline'
  | 'RemoveReviewer'
  | 'GetGrid'
  | 'ListAuditEvents'
  | 'ListNotifications'
  | 'GetUnreadCount'
  | 'MarkNotificationsRead'
  | 'GetWhatsAppLink'
  | 'RecordWhatsAppOpened'
  | 'GetDownloads'
  | 'GetApprovalRecordData'
> = {
  // NOTE: only an author of a report on the case file may retitle it (guarded
  // in one batch); anyone else gets `NotFound`, like a case file that does not
  // exist. Every report of the case file gets the audit row, so each log shows
  // who changed it.
  UpdateCaseFile: ({ caseFileId, title }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const db = yield* store
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const result = yield* db.retitleCaseFile({
        caseFileId,
        title,
        userId: user.id,
        now,
        audit: {
          at: now,
          actorId: user.id,
          action: 'case_file.updated',
          meta: JSON.stringify({ caseFileId }),
        },
      })
      if (result._tag === 'Refused') return yield* Effect.fail(new NotFound())
      const { caseFile } = result
      return {
        id: caseFile.id,
        unit: caseFile.unitId,
        reference: caseFile.reference,
        title: caseFile.title,
      }
    }),

  // NOTE: by account ID, from the authors of the report's unit. It never
  // creates an account and never grants anything: a co-author already holds
  // the author capability in the unit. An ID that is unknown, belongs to
  // someone with no author grant in this unit or to an inactive account gets
  // one refusal, so nothing says whether an account exists. A unit author who
  // is a reviewer in the open round is refused with its own code: the caller
  // sees the round's people anyway (`checkNewAuthor`).
  AddCoAuthor: ({ reportId, accountId }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, { type: 'add_co_author' })
      const unit = loaded.record.caseFile.unitId
      const role = draftingRoleOf(loaded.template)
      if (role === undefined) return yield* Effect.fail(new NotFound())
      const grants = yield* db.listGrants(accountId)
      const isUnitAuthor = grants.some(
        grant => grant.capability === 'author' && grant.unitId === unit,
      )
      const account = isUnitAuthor ? yield* db.getAccount(accountId) : null
      if (account === null || account.profile?.active === false) {
        return yield* Effect.fail(validation('input', 'not_a_unit_author'))
      }
      if (Result.isFailure(checkNewAuthor(loaded.access, accountId))) {
        return yield* Effect.fail(validation('input', 'reviewer_in_open_round'))
      }
      const added = yield* db.addMember({
        reportId,
        userId: accountId,
        roleId: role.id,
        addedBy: user.id,
        now: loaded.now,
        audit: auditOf(loaded.now, user.id, 'report.co_author_added', reportId, {
          meta: JSON.stringify({ accountId }),
        }),
      })
      if (added._tag === 'Refused') {
        return yield* Effect.fail(
          added.reason === 'already_member'
            ? new Conflict({ reason: 'already_exists' })
            : added.reason === 'reviewer_in_open_round'
              ? validation('input', 'reviewer_in_open_round')
              : new Conflict({ reason: 'changed_meanwhile' }),
        )
      }
      return { account: { id: account.id, name: account.name } }
    }),

  ExtendDeadline: ({ reportId, revision, deadline }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, { type: 'extend_deadline' })
      const entry = roundOf(loaded, revision)
      if (entry === undefined) return yield* Effect.fail(new NotFound())
      if (!timeZoneOk(deadline.timeZone)) {
        return yield* Effect.fail(validation('input', 'unknown_time_zone', ['deadline', 'timeZone']))
      }
      const applied = applyEvent(
        { template: loaded.template, authors: loaded.authors, now: loaded.now },
        loaded.flow,
        { type: 'extend_deadline', deadline: deadline.at },
      )
      if (Result.isFailure(applied)) {
        return yield* Effect.fail(flowFailure(applied.failure, deadline.at))
      }
      const open = loaded.flow.rounds.find(round => round.status === 'open')
      if (open === undefined || open.revision !== revision) {
        return yield* Effect.fail(new Conflict({ reason: 'not_latest' }))
      }
      const rounds = loaded.rounds.map(each =>
        each === entry
          ? {
              ...each,
              round: { ...each.round, deadlineAt: deadline.at, deadlineZone: deadline.timeZone },
            }
          : each,
      )
      const jobs = yield* jobsFor(db, yield* QuoroomConfig, {
        template: loaded.template,
        flow: applied.success,
        authors: loaded.authors,
        approvalWatchers: new Set(),
        revisions: loaded.revisions,
        rounds,
        reviews: loaded.reviews,
        extraEvents: [],
        reportId,
        now: loaded.now,
      })
      const extended = yield* db.extendDeadline({
        roundId: entry.round.id,
        reportId,
        deadlineAt: deadline.at,
        deadlineZone: deadline.timeZone,
        jobs,
        now: loaded.now,
        audit: auditOf(loaded.now, user.id, 'round.deadline_extended', reportId, {
          revisionNumber: revision,
          meta: JSON.stringify({ deadline: deadline.at, timeZone: deadline.timeZone }),
        }),
      })
      if (extended._tag === 'Refused') {
        return yield* Effect.fail(
          extended.reason === 'not_later'
            ? validation('input', 'deadline_not_later', ['deadline'])
            : new Conflict({ reason: 'changed_meanwhile' }),
        )
      }
      const view = roundViewOf(
        { ...loaded, rounds, flow: applied.success },
        revision,
      )
      if (view === undefined) return yield* Effect.fail(new NotFound())
      return view
    }),

  RemoveReviewer: ({ reportId, revision, accountId }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, { type: 'remove_reviewer' })
      const entry = roundOf(loaded, revision)
      if (entry === undefined) return yield* Effect.fail(new NotFound())
      if (!entry.participants.some(p => p.userId === accountId && p.removedAt === null)) {
        return yield* Effect.fail(new NotFound())
      }
      const applied = applyEvent(
        { template: loaded.template, authors: loaded.authors, now: loaded.now },
        loaded.flow,
        { type: 'remove_reviewer', accountId },
      )
      if (Result.isFailure(applied)) {
        return yield* Effect.fail(flowFailure(applied.failure, entry.round.deadlineAt))
      }
      const open = loaded.flow.rounds.find(round => round.status === 'open')
      if (open === undefined || open.revision !== revision) {
        return yield* Effect.fail(new Conflict({ reason: 'not_latest' }))
      }
      const rounds = loaded.rounds.map(each =>
        each === entry
          ? {
              ...each,
              participants: each.participants.map(p =>
                p.userId === accountId ? { ...p, removedAt: loaded.now } : p,
              ),
            }
          : each,
      )
      // NOTE: a removal can make the approval rule met. The round is then
      // decided in the same batch, by the rule, at this time, with this
      // actor's removal in the log, so nobody waits for the next read.
      const lastAfter = applied.success.rounds[applied.success.rounds.length - 1]
      const decidedNow =
        lastAfter !== undefined &&
        lastAfter.status === 'decided' &&
        lastAfter.decidedBy === 'rule_met'
      const decidedRounds = rounds.map(each =>
        decidedNow && each.round.id === entry.round.id
          ? {
              ...each,
              round: {
                ...each.round,
                state: 'decided' as const,
                decidedBy: 'rule_met' as const,
                decidedAt: loaded.now,
              },
            }
          : each,
      )
      let decide: Parameters<typeof db.removeParticipant>[0]['decide']
      if (decidedNow) {
        const jobs = yield* jobsFor(db, yield* QuoroomConfig, {
          template: loaded.template,
          flow: applied.success,
          authors: loaded.authors,
          approvalWatchers: new Set(),
          revisions: loaded.revisions,
          rounds: decidedRounds,
          reviews: loaded.reviews,
          extraEvents: [],
          reportId,
          now: loaded.now,
        })
        decide = {
          decidedBy: 'rule_met',
          toState: applied.success.state,
          jobs,
          expectedDeadlineAt: entry.round.deadlineAt,
          expectedReviews: loaded.reviews.filter(r => r.roundId === entry.round.id)
            .length,
          expectedParticipants: entry.participants.filter(
            p => p.removedAt === null && p.userId !== accountId,
          ).length,
          audit: auditOf(loaded.now, user.id, 'round.decided', reportId, {
            revisionNumber: revision,
            meta: JSON.stringify({ decidedBy: 'rule_met' }),
          }),
        }
      }
      const removed = yield* db.removeParticipant({
        roundId: entry.round.id,
        reportId,
        userId: accountId,
        removedBy: user.id,
        now: loaded.now,
        audit: auditOf(loaded.now, user.id, 'round.reviewer_removed', reportId, {
          revisionNumber: revision,
          meta: JSON.stringify({ accountId }),
        }),
        ...(decide === undefined ? {} : { decide }),
      })
      if (removed._tag === 'Refused') {
        return yield* Effect.fail(
          removed.reason === 'not_a_participant'
            ? new NotFound()
            : new Conflict({ reason: 'changed_meanwhile' }),
        )
      }
      const view = roundViewOf(
        { ...loaded, rounds: decidedRounds, flow: applied.success },
        revision,
      )
      if (view === undefined) return yield* Effect.fail(new NotFound())
      return view
    }),

  GetGrid: ({ reportId }) =>
    Effect.gen(function* () {
      const { loaded, db } = yield* member(reportId, { type: 'read_grid' })
      const events = yield* eventsFor(db, loaded)
      const grid = buildGrid({
        template: loaded.template,
        flow: loaded.flow,
        authors: loaded.authors,
        events,
      })
      const names = namesOf(loaded)
      const ids = new Set<string>(grid.authors)
      for (const row of grid.revisions) for (const cell of row.cells) ids.add(cell.accountId)
      for (const row of grid.drafts) if (row.sharedBy !== undefined) ids.add(row.sharedBy)
      return {
        grid,
        names: [...ids].map(id => ({ id, name: names.get(id) ?? id })),
      }
    }),

  // NOTE: newest first. A report's log is for its authors, a template's for
  // template editors and the theme's for administrators.
  ListAuditEvents: ({ subject, before, limit }) =>
    Effect.gen(function* () {
      const db = yield* store
      if (subject.kind === 'report') {
        yield* member(subject.reportId, { type: 'read_audit' })
      } else {
        yield* allowCapability(
          db,
          subject.kind === 'template' ? { type: 'edit_template' } : { type: 'set_theme' },
        )
      }
      const cursor = before === undefined ? undefined : Number(before)
      const rows: ReadonlyArray<AuditRecord> = yield* db.listAudit({
        ...(subject.kind === 'report' ? { reportId: subject.reportId } : {}),
        ...(subject.kind === 'template' ? { templateId: subject.templateId } : {}),
        ...(subject.kind === 'theme' ? { actionPrefix: 'theme.' } : {}),
        ...(cursor === undefined || !Number.isFinite(cursor) ? {} : { before: cursor }),
        limit: limit + 1,
      })
      const page = rows.slice(0, limit)
      const accounts = yield* db.listAccounts()
      const names = new Map(accounts.map(account => [account.id, account.name]))
      return {
        events: page.map(row => ({
          id: String(row.id),
          at: row.at,
          ...(row.actorId === null
            ? {}
            : { actor: { id: row.actorId, name: names.get(row.actorId) ?? row.actorId } }),
          action: row.action.slice(0, 64),
          ...(row.draftNumber === null ? {} : { draft: row.draftNumber }),
          ...(row.revisionNumber === null ? {} : { revision: row.revisionNumber }),
          meta: metaOf(row.meta),
        })),
        ...(rows.length > limit && page.length > 0
          ? { next: String(page[page.length - 1]?.id) }
          : {}),
      }
    }),

  // NOTE: generic by design (D17): the case reference at most, never a title.
  // The reference and time zone come from the rounds the caller takes part in
  // or the reports they are a member of (two reads).
  ListNotifications: ({ before, limit }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const db = yield* store
      const rows = yield* db.listInbox(user.id, limit + 1, before)
      const page = rows.slice(0, limit)
      const unread = yield* db.countUnread(user.id)
      const rounds = yield* db.listReviewerRounds(user.id, {
        offset: 0,
        limit: 100,
        openOnly: false,
        pendingOnly: false,
      })
      const reports = yield* db.listReportsForMember(user.id)
      const reference = new Map<string, string>()
      for (const report of reports) reference.set(report.id, report.caseFile.reference)
      // NOTE: a reviewer's reference is the one their role may read: the
      // redacted twin of the draft for a redacted role (D14).
      const templates = yield* loadTemplates(
        db,
        rounds.map(round => ({
          templateId: round.templateId,
          version: round.templateVersion,
        })),
      )
      for (const round of rounds) {
        const role = templates
          .get(`${round.templateId}@${round.templateVersion}`)
          ?.roles.find(entry => entry.id === round.roleId)
        reference.set(
          round.reportId,
          role?.view === 'full' ? round.caseReference : round.caseReferenceRedacted,
        )
      }
      const zone = new Map(
        rounds.map(round => [`${round.reportId}/${round.revision}`, round.deadlineZone]),
      )
      return {
        items: page.map(job => {
          const timeZone = zone.get(`${job.reportId}/${job.revision}`)
          return {
            id: String(job.id),
            kind: job.kind,
            at: job.doneAt ?? job.dueAt,
            ...(job.readAt === null ? {} : { readAt: job.readAt }),
            reportId: job.reportId,
            revision: job.revision,
            ...(reference.has(job.reportId)
              ? { caseReference: reference.get(job.reportId) as string }
              : {}),
            ...(job.deadline !== null && timeZone !== undefined
              ? { deadline: { at: job.deadline, timeZone } }
              : {}),
          }
        }),
        unread,
        ...(rows.length > limit && page.length > 0
          ? { next: page[page.length - 1]?.id as number }
          : {}),
      }
    }),

  GetUnreadCount: () =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const db = yield* store
      return { unread: yield* db.countUnread(user.id) }
    }),

  // NOTE: only the caller's own notifications are touched; an ID that is not
  // one of theirs is ignored.
  MarkNotificationsRead: ({ ids }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const db = yield* store
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const numbers = ids
        .map(id => Number(id))
        .filter(id => Number.isInteger(id) && id >= 0)
      yield* db.markInboxRead(user.id, numbers, now)
      return { unread: yield* db.countUnread(user.id) }
    }),

  // NOTE: never names the case or the report: the deadline in its own time zone
  // and the link only (D17). Authors only; the reviewer must be in the open
  // round and have a number and consent.
  GetWhatsAppLink: ({ reportId, revision, accountId }, { headers }) =>
    Effect.gen(function* () {
      const { loaded, db } = yield* member(reportId, { type: 'publish_revision' })
      const target = yield* whatsAppTarget(loaded, db, revision, accountId)
      const deadline = target.entry.round
      const text = `A report is waiting for your review in Quoroom, due ${when(
        deadline.deadlineAt,
        deadline.deadlineZone,
      )}. ${originOf(headers)}/`
      return {
        accountId,
        name: target.account.name,
        number: target.number,
        text,
        url: `https://wa.me/${target.number}?text=${encodeURIComponent(text)}`,
      }
    }),

  RecordWhatsAppOpened: ({ reportId, revision, accountId }) =>
    Effect.gen(function* () {
      const { loaded, db } = yield* member(reportId, { type: 'publish_revision' })
      yield* whatsAppTarget(loaded, db, revision, accountId)
      yield* db.recordEvent({
        reportId,
        kind: 'whatsapp_opened',
        accountId,
        revisionNumber: revision,
        at: loaded.now,
      })
    }),

  GetDownloads: ({ reportId }) =>
    Effect.gen(function* () {
      const { loaded, db } = yield* member(reportId, { type: 'read_grid' })
      const drafts = yield* db.listDrafts(reportId)
      return {
        reportName: loaded.template.name,
        caseReference: loaded.record.caseFile.reference,
        versions: [
          ...drafts
            .filter(draft => draft.number >= 1)
            .map(draft => ({
              kind: 'draft' as const,
              number: draft.number,
              label: draftLabel(draft.number),
              view: 'original' as const,
              closing: false,
              at: draft.sharedAt,
            })),
          ...loaded.revisions.flatMap(revision =>
            (['original', 'redacted'] as const).map(view => ({
              kind: 'revision' as const,
              number: revision.number,
              label: revisionTitle(revision.number, revision.closing),
              view,
              closing: revision.closing,
              at: revision.publishedAt,
            })),
          ),
        ],
        approvalRecord: loaded.flow.rounds.some(round => round.status === 'decided'),
      }
    }),

  GetApprovalRecordData: ({ reportId }) =>
    Effect.gen(function* () {
      const { loaded, db } = yield* member(reportId, { type: 'read_grid' })
      const events = yield* eventsFor(db, loaded)
      const units = yield* db.listUnits()
      const names = namesOf(loaded)
      return {
        reportName: loaded.template.name,
        caseFile: {
          reference: loaded.record.caseFile.reference,
          unit: units.find(u => u.id === loaded.record.caseFile.unitId)?.name ?? '',
          title: loaded.record.caseFile.title,
        },
        flow: loaded.flow,
        events,
        authors: loaded.authors,
        accountNames: Object.fromEntries(names),
      }
    }),
}
