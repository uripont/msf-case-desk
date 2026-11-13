import { Effect, Result } from 'effect'
import type { RpcGroup } from 'effect/rpc'

import {
  type Person,
  type QuoroomRpcs,
  type SectionContent,
  Conflict,
  CurrentUser,
  NotAllowedInState,
  NotFound,
  Validation,
  applyEvent,
  canonicalJson,
  checkClosingDraft,
  checkSave,
  compareDrafts,
  contentProblems,
  draftLabel,
  draftingRoleOf,
  peopleListProblems,
  redactedSectionOf,
  redactorFor,
  resolveMerge,
} from '@case-desk/domain'

import {
  EMPTY_SECTION,
  imageRefsJson,
  ordinalOf,
  parseSection,
  reportShell,
  sha256Hex,
  topLevelIds,
} from './content'
import {
  QuoroomClock,
  allow,
  allowUnit,
  loadTemplate,
  flowFailure,
  idOf,
  jobsFor,
  loadReport,
  loadTemplates,
  problem,
  store,
  validation,
} from './core'
import {
  auditOf,
  comparisonOf,
  dataOf,
  draftHeader,
  hashOfJoined,
  peopleHashOf,
  member,
  peopleOf,
  planPublish,
  revisionHeaderFor,
} from './support'
import {
  hashOfSections,
  revisionHeaderOf,
  sectionRefsOf,
  summaryOf,
  summaryOfRecord,
} from './views'

// NOTE: The author side of the report: reading, working copies, sharing,
// history. Every handler calls `member` first (loading the report, settling
// the round and asking `authorize`), so a caller with no role in the report
// gets the same `NotFound` as for a report that does not exist, before
// anything else is looked at. Authors read their own content as written;
// reviewers never come through here.

type AllHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof QuoroomRpcs>>

const missingCopy = () => validation('input', 'no_working_copy')

// NOTE: the working copy of the caller. A read of one that does not exist is
// `NotFound`; a write to it is `Validation`: the author has to start one.
const ownCopy = (
  db: import('./core').Store,
  reportId: string,
  userId: string,
) =>
  Effect.gen(function* () {
    const copy = yield* db.getWorkingCopy(reportId, userId)
    if (copy === null) return yield* Effect.fail(new NotFound())
    return copy
  })

const writableCopy = (
  db: import('./core').Store,
  reportId: string,
  userId: string,
) =>
  Effect.gen(function* () {
    const copy = yield* db.getWorkingCopy(reportId, userId)
    if (copy === null) return yield* Effect.fail(missingCopy())
    return copy
  })

const outlineOf = (
  db: import('./core').Store,
  loaded: import('./core').Loaded,
  userId: string,
) =>
  Effect.gen(function* () {
    const copy = yield* ownCopy(db, loaded.record.id, userId)
    const rows = yield* db.getWorkingCopyContents(loaded.record.id, userId)
    return {
      reportId: loaded.record.id,
      ownerId: userId,
      baseDraft: copy.baseDraft,
      saveCounter: copy.saveCounter,
      savedAt: copy.lastSavedAt,
      latestDraft: loaded.record.latestDraft,
      behind: loaded.record.latestDraft > copy.baseDraft,
      // NOTE: saved since it was started and since its base was shared.
      hasUnsharedChanges: copy.saveCounter > copy.sharedCounter,
      sections: sectionRefsOf(rows),
      peopleCount: peopleOf(copy.people).length,
    }
  })

// NOTE: base, ours and theirs of the working copy against the latest draft.
const loadMerge = (
  db: import('./core').Store,
  loaded: import('./core').Loaded,
  userId: string,
  baseDraft: number,
  people: ReadonlyArray<Person>,
  // NOTE: the newest draft as the store has it now, when the caller found out
  // that `loaded` is behind (a share that lost a race).
  newest?: number,
) =>
  Effect.gen(function* () {
    const reportId = loaded.record.id
    const latest = newest ?? loaded.record.latestDraft
    const base = yield* db.getDraft(reportId, baseDraft)
    const theirs = yield* db.getDraft(reportId, latest)
    if (base === null || theirs === null) return yield* Effect.fail(new NotFound())
    const baseRows = yield* db.getDraftContents(reportId, baseDraft, 'original')
    const theirRows = yield* db.getDraftContents(reportId, latest, 'original')
    const ourRows = yield* db.getWorkingCopyContents(reportId, userId)
    return compareDrafts(loaded.template, {
      base: dataOf(loaded.template, baseRows, peopleOf(base.people)),
      ours: dataOf(loaded.template, ourRows, people),
      theirs: dataOf(loaded.template, theirRows, peopleOf(theirs.people)),
    })
  })

const sectionOrFail = (
  template: import('@case-desk/domain').Template,
  sectionId: string,
) =>
  topLevelIds(template).includes(sectionId)
    ? Effect.void
    : Effect.fail(new NotFound())

const MAX_REPORTS_IN_LIST = 40
const MAX_SETTLED_IN_LIST = 2

export const authorHandlers: Pick<
  AllHandlers,
  | 'ListCaseFiles'
  | 'CreateReport'
  | 'ListReports'
  | 'GetReport'
  | 'ListDrafting'
  | 'StartWorkingCopy'
  | 'GetWorkingCopy'
  | 'GetWorkingCopySection'
  | 'SaveSection'
  | 'SavePeople'
  | 'GetPeople'
  | 'ShareSection'
  | 'FinishShare'
  | 'PreviewMerge'
  | 'ResolveMerge'
  | 'GetHistory'
  | 'GetDraftOutline'
  | 'GetDraftSection'
  | 'CompareDrafts'
  | 'ConfirmRedaction'
  | 'GetPublishChoices'
  | 'PublishRevision'
> = {
  ListCaseFiles: ({ unit }) =>
    Effect.gen(function* () {
      const db = yield* store
      yield* allowUnit(db, unit)
      const files = yield* db.listCaseFiles(unit)
      return files.map(file => ({
        id: file.id,
        unit: file.unitId,
        reference: file.reference,
        title: file.title,
      }))
    }),

  CreateReport: ({ unit, caseFile, templateId, templateVersion }) =>
    Effect.gen(function* () {
      const db = yield* store
      const user = yield* allowUnit(db, unit)
      const record = yield* db.getTemplateVersion(templateId, templateVersion)
      if (record === null || record.state !== 'published') {
        return yield* Effect.fail(validation('input', 'unknown_template'))
      }
      const template = yield* loadTemplate(db, templateId, templateVersion)
      const role = draftingRoleOf(template)
      if (role === undefined) {
        return yield* Effect.fail(validation('template', 'no_drafting_role'))
      }
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const reportId = yield* idOf('report')
      const outcome = yield* db.createReport({
        caseFile:
          'existing' in caseFile
            ? { kind: 'existing', id: caseFile.existing }
            : {
                kind: 'new',
                id: yield* idOf('casefile'),
                reference: caseFile.reference,
                title: caseFile.title,
              },
        unitId: unit,
        reportId,
        templateId,
        templateVersion,
        createdBy: user.id,
        draftingRoleId: role.id,
        now,
        audit: auditOf(now, user.id, 'report.created', reportId),
      })
      if (outcome._tag === 'Refused') {
        return yield* Effect.fail(
          outcome.reason === 'no_case_file'
            ? new NotFound()
            : new Conflict({ reason: 'duplicate' }),
        )
      }
      const loaded = yield* loadReport(reportId)
      if (loaded === undefined) return yield* Effect.fail(new NotFound())
      return summaryOf(loaded)
    }),

  // NOTE: a constant number of queries however many reports the caller has:
  // the list (one), the templates of the page (one) and at most
  // `MAX_SETTLED_IN_LIST` overdue rounds settled through `loadReport`. Overdue
  // ones beyond that show their stored state until opened (or settled by the
  // scheduled pass), so a list is never the reason for a request to run out of
  // queries.
  ListReports: ({ state, unit }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const db = yield* store
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const reports = (yield* db.listReportsForMember(user.id))
        .filter(
          record =>
            (state === undefined || record.state === state) &&
            (unit === undefined || record.caseFile.unitId === unit),
        )
        .slice(0, MAX_REPORTS_IN_LIST)
      const templates = yield* loadTemplates(
        db,
        reports.map(record => ({
          templateId: record.templateId,
          version: record.templateVersion,
        })),
      )
      const out = []
      let settledInList = 0
      for (const record of reports) {
        const overdue =
          (record.state === 'in_review' || record.state === 'concluding') &&
          record.deadlineAt !== null &&
          record.deadlineAt <= now
        if (overdue && settledInList < MAX_SETTLED_IN_LIST) {
          settledInList += 1
          const loaded = yield* loadReport(record.id)
          if (loaded === undefined) continue
          if (state !== undefined && loaded.record.state !== state) continue
          out.push(summaryOf(loaded))
          continue
        }
        const template = templates.get(
          `${record.templateId}@${record.templateVersion}`,
        )
        if (template === undefined) continue
        out.push(summaryOfRecord(record, template))
      }
      return out
    }),

  GetReport: ({ reportId }) =>
    Effect.gen(function* () {
      const { user, loaded } = yield* member(reportId, { type: 'view_report' })
      const role = loaded.members.find(m => m.userId === user.id)
      const roleId = role?.roleId ?? ''
      const authorRole = draftingRoleOf(loaded.template)
      if (authorRole === undefined || roleId !== authorRole.id) {
        // NOTE: reviewers read revisions, never the report as a whole.
        return yield* Effect.fail(new NotFound())
      }
      return {
        summary: summaryOf(loaded),
        myRoleId: roleId,
        permissions: authorRole.permissions,
        authors: loaded.members
          .filter(m => m.roleId === authorRole.id)
          .map(m => ({ id: m.userId, name: m.name })),
      }
    }),

  ListDrafting: ({ reportId }) =>
    Effect.gen(function* () {
      const { loaded, db } = yield* member(reportId, { type: 'read_people' })
      const drafting = yield* db.listDrafting(reportId)
      return drafting.map(entry => ({
        accountId: entry.userId,
        name: entry.name,
        baseDraft: entry.baseDraft,
        lastSavedAt: entry.lastSavedAt,
        hasUnsharedChanges: entry.unshared,
      }))
    }),

  StartWorkingCopy: ({ reportId, baseDraft, replace }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'start_working_copy',
      })
      // NOTE: `replace` throws the working copy away and starts again from
      // the latest shared draft, with no merge; it never starts from an
      // older one.
      if (
        replace === true &&
        baseDraft !== undefined &&
        baseDraft !== loaded.record.latestDraft
      ) {
        return yield* Effect.fail(new Conflict({ reason: 'not_latest' }))
      }
      const from =
        replace === true
          ? loaded.record.latestDraft
          : (baseDraft ?? loaded.record.latestDraft)
      if (from > loaded.record.latestDraft) {
        return yield* Effect.fail(validation('input', 'unknown_draft'))
      }
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const existing = yield* db.getWorkingCopy(reportId, user.id)
      if (existing === null) {
        const started = yield* db.startWorkingCopy({
          reportId,
          userId: user.id,
          fromDraft: from,
          now,
        })
        if (started === null) return yield* Effect.fail(new NotFound())
      } else if (replace === true) {
        const draft = yield* db.getDraft(reportId, from)
        if (draft === null) return yield* Effect.fail(new NotFound())
        const rows = yield* db.getDraftContents(reportId, from, 'original')
        const outcome = yield* db.rebaseWorkingCopy({
          reportId,
          userId: user.id,
          expectedCounter: existing.saveCounter,
          baseDraft: from,
          sections: rows.map(row => ({
            sectionId: row.sectionId,
            ordinal: row.ordinal,
            content: row.content,
          })),
          people: draft.people,
          markShared: true,
          now,
        })
        if (outcome._tag !== 'Saved') {
          return yield* Effect.fail(new Conflict({ reason: 'stale_save' }))
        }
      }
      return yield* outlineOf(db, loaded, user.id)
    }),

  GetWorkingCopy: ({ reportId }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const { loaded, db } = yield* member(reportId, {
        type: 'read_working_copy',
        ownerId: user.id,
      })
      return yield* outlineOf(db, loaded, user.id)
    }),

  GetWorkingCopySection: ({ reportId, sectionId }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const { loaded, db } = yield* member(reportId, {
        type: 'read_working_copy',
        ownerId: user.id,
      })
      yield* sectionOrFail(loaded.template, sectionId)
      const copy = yield* ownCopy(db, reportId, user.id)
      const row = yield* db.getWorkingCopySection(reportId, user.id, sectionId)
      return {
        sectionId,
        saveCounter: copy.saveCounter,
        content: row === null ? EMPTY_SECTION : parseSection(row.content),
      }
    }),

  SaveSection: ({ reportId, sectionId, saveCounter, content }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'save_section',
        sectionId,
      })
      const checked = checkSave(loaded.template, loaded.record.state, {
        kind: 'section',
        sectionId,
      })
      if (Result.isFailure(checked)) {
        return yield* Effect.fail(
          new NotAllowedInState({
            state: loaded.record.state,
            code: checked.failure.code,
          }),
        )
      }
      // NOTE: sections are stored by top-level section: a nested one is
      // saved inside its parent.
      yield* sectionOrFail(loaded.template, sectionId)
      const problems = contentProblems(
        loaded.template,
        reportShell(loaded.template, { [sectionId]: content }),
      )
      if (problems.length > 0) {
        return yield* Effect.fail(
          new Validation({
            problems: problems.map(entry =>
              problem('content', entry.code, entry.path, entry.message),
            ),
          }),
        )
      }
      yield* writableCopy(db, reportId, user.id)
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const outcome = yield* db.saveWorkingCopy({
        reportId,
        userId: user.id,
        expectedCounter: saveCounter,
        sections: [
          {
            sectionId,
            ordinal: ordinalOf(loaded.template, sectionId),
            content: JSON.stringify(content),
          },
        ],
        now,
      })
      if (outcome._tag !== 'Saved') {
        return yield* Effect.fail(new Conflict({ reason: 'stale_save' }))
      }
      return { saveCounter: outcome.saveCounter, savedAt: now }
    }),

  SavePeople: ({ reportId, saveCounter, people }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'save_people',
      })
      const checked = checkSave(loaded.template, loaded.record.state, {
        kind: 'people',
      })
      if (Result.isFailure(checked)) {
        return yield* Effect.fail(
          new NotAllowedInState({
            state: loaded.record.state,
            code: checked.failure.code,
          }),
        )
      }
      const problems = peopleListProblems(people)
      if (problems.length > 0) {
        return yield* Effect.fail(
          new Validation({
            problems: problems.map(entry =>
              problem('people', entry.code, entry.path, entry.message),
            ),
          }),
        )
      }
      yield* writableCopy(db, reportId, user.id)
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const outcome = yield* db.saveWorkingCopy({
        reportId,
        userId: user.id,
        expectedCounter: saveCounter,
        sections: [],
        people: JSON.stringify(people),
        now,
      })
      if (outcome._tag !== 'Saved') {
        return yield* Effect.fail(new Conflict({ reason: 'stale_save' }))
      }
      return { saveCounter: outcome.saveCounter, savedAt: now }
    }),

  GetPeople: ({ reportId, draft }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      if (draft === undefined) {
        const { db } = yield* member(reportId, {
          type: 'read_working_copy',
          ownerId: user.id,
        })
        const copy = yield* ownCopy(db, reportId, user.id)
        return {
          saveCounter: copy.saveCounter,
          people: peopleOf(copy.people),
        }
      }
      const { db } = yield* member(reportId, {
        type: 'read_draft',
        number: draft,
      })
      const found = yield* db.getDraft(reportId, draft)
      if (found === null) return yield* Effect.fail(new NotFound())
      return { draft, people: peopleOf(found.people) }
    }),

  ShareSection: ({ reportId, shareId, sectionId, saveCounter }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'share_draft',
      })
      yield* sectionOrFail(loaded.template, sectionId)
      const copy = yield* writableCopy(db, reportId, user.id)
      if (copy.saveCounter !== saveCounter) {
        return yield* Effect.fail(new Conflict({ reason: 'stale_save' }))
      }
      const row = yield* db.getWorkingCopySection(reportId, user.id, sectionId)
      const original: SectionContent =
        row === null ? EMPTY_SECTION : parseSection(row.content)
      // NOTE: the redaction of a section, made here, on the server, every
      // time a section is shared; what reviewers of a redacted role read is
      // this stored text and nothing computed later (D14).
      const redacted = redactedSectionOf(
        loaded.template,
        peopleOf(copy.people),
        sectionId,
        original,
      )
      const redactedContent = JSON.stringify(redacted)
      // NOTE: the hash is of the canonical text, so the browser, which builds
      // the same section with the same function, gets the same hash.
      const redactedHash = yield* Effect.promise(() =>
        sha256Hex(canonicalJson(redacted)),
      )
      const peopleHash = yield* Effect.promise(() => peopleHashOf(copy.people))
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const outcome = yield* db.stageShareSection({
        shareId,
        reportId,
        userId: user.id,
        sectionId,
        sectionVersion: row?.version ?? 0,
        redactedContent,
        redactedHash,
        // NOTE: one people list for the whole share: the text this section
        // was redacted with, which the store checks against the working copy
        // and against the other sections of the share.
        people: copy.people,
        peopleHash,
        imageRefs: imageRefsJson(original),
        now,
      })
      if (outcome._tag !== 'Staged') {
        return yield* Effect.fail(new Conflict({ reason: 'stale_save' }))
      }
      return { shareId, sectionId, staged: 1, redactedHash, peopleHash }
    }),

  FinishShare: ({
    reportId,
    shareId,
    saveCounter,
    redactionHash,
    publish,
  }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: publish === undefined ? 'share_draft' : 'publish_revision',
      })
      if (publish !== undefined) {
        yield* allow(loaded, user, { type: 'share_draft' })
      }
      const copy = yield* writableCopy(db, reportId, user.id)
      if (copy.saveCounter !== saveCounter) {
        return yield* Effect.fail(new Conflict({ reason: 'stale_save' }))
      }
      const reportKey = loaded.record.id
      const stale = () =>
        Effect.gen(function* () {
          const latest = (yield* db.getReport(reportKey))?.latestDraft
          const merge = yield* loadMerge(
            db,
            loaded,
            user.id,
            copy.baseDraft,
            peopleOf(copy.people),
            latest ?? loaded.record.latestDraft,
          )
          return {
            kind: 'stale_base' as const,
            latestDraft: latest ?? loaded.record.latestDraft,
            comparison: comparisonOf(
              merge,
              copy.baseDraft,
              latest ?? loaded.record.latestDraft,
            ),
          }
        })
      if (copy.baseDraft < loaded.record.latestDraft) return yield* stale()

      const expected = (yield* db.listWorkingCopySections(reportKey, user.id))
        .length
      if (loaded.record.state === 'concluding') {
        const revision = loaded.revisions[loaded.revisions.length - 1]
        if (revision !== undefined) {
          const baseRows = yield* db.getDraftContents(
            reportKey,
            revision.draftNumber,
            'original',
          )
          const ourRows = yield* db.getWorkingCopyContents(reportKey, user.id)
          const closing = checkClosingDraft(
            loaded.template,
            loaded.record.state,
            dataOf(loaded.template, baseRows, []).content,
            dataOf(loaded.template, ourRows, []).content,
          )
          if (Result.isFailure(closing)) {
            return yield* Effect.fail(
              new Validation({
                problems: closing.failure.sectionIds.map(id =>
                  problem('flow', closing.failure.code, [id]),
                ),
              }),
            )
          }
        }
      }
      const shared = applyEvent(
        { template: loaded.template, authors: loaded.authors, now: loaded.now },
        loaded.flow,
        { type: 'share_draft' },
      )
      if (Result.isFailure(shared)) {
        return yield* Effect.fail(flowFailure(shared.failure, undefined))
      }
      const newNumber = loaded.record.latestDraft + 1
      // NOTE: the confirmation is the hash of the redacted content the author
      // saw, checked against what is staged now; the batch re-checks it and
      // writes it together with the draft and the publish (D14).
      const staged = yield* db.listStagedSections(shareId, reportKey, user.id)
      const joined = staged.map(section => section.redactedHash).join(',')
      const peopleHash = yield* Effect.promise(() => peopleHashOf(copy.people))
      let confirmed = false
      if (redactionHash !== undefined) {
        if (staged.length !== expected) {
          return yield* Effect.fail(new Conflict({ reason: 'share_incomplete' }))
        }
        // NOTE: the confirmed hash covers the people list the preview was made
        // with: a list changed since (or sections staged under another one)
        // is not the share the author saw.
        if (
          staged.some(section => section.peopleHash !== peopleHash) ||
          redactionHash !==
            (yield* Effect.promise(() => hashOfJoined(joined, copy.people)))
        ) {
          return yield* Effect.fail(
            validation('publish', 'redaction_not_confirmed'),
          )
        }
        confirmed = true
      }
      const plan =
        publish === undefined
          ? undefined
          : yield* planPublish(
              db,
              loaded,
              user.id,
              publish,
              shared.success,
              newNumber,
              true,
              confirmed,
            )
      const redactor = redactorFor(peopleOf(copy.people))
      const outcome = yield* db.finishShare({
        shareId,
        reportId: reportKey,
        userId: user.id,
        baseDraft: copy.baseDraft,
        expectedSections: expected,
        redactedCaseTitle: redactor.text(loaded.record.caseFile.title),
        people: copy.people,
        peopleHash,
        now: loaded.now,
        audit: auditOf(loaded.now, user.id, 'draft.shared', reportKey),
        ...(confirmed
          ? {
              confirmation: {
                joinedHashes: joined,
                confirmedBy: user.id,
                audit: auditOf(
                  loaded.now,
                  user.id,
                  'redaction.confirmed',
                  reportKey,
                ),
              },
            }
          : {}),
        ...(plan === undefined
          ? {}
          : {
              publish: {
                ...plan.input,
                audit: auditOf(
                  loaded.now,
                  user.id,
                  'revision.published',
                  reportKey,
                  { revisionNumber: plan.revision },
                ),
              },
            }),
      })
      if (outcome._tag === 'Refused') {
        switch (outcome.reason) {
          case 'stale_base':
            return yield* stale()
          case 'share_incomplete':
            return yield* Effect.fail(new Conflict({ reason: 'share_incomplete' }))
          case 'no_working_copy':
            return yield* Effect.fail(missingCopy())
          case 'not_latest':
            return yield* stale()
          case 'wrong_state':
            return yield* Effect.fail(
              new NotAllowedInState({
                state: loaded.record.state,
                code: 'wrong_state',
              }),
            )
          case 'not_confirmed':
          case 'people_changed':
            return yield* Effect.fail(
              confirmed || outcome.reason === 'not_confirmed'
                ? validation('publish', 'redaction_not_confirmed')
                : new Conflict({ reason: 'changed_meanwhile' }),
            )
          default:
            return yield* Effect.fail(
              new Conflict({ reason: 'changed_meanwhile' }),
            )
        }
      }
      const number = outcome.number
      const header = yield* draftHeader(db, reportKey, number)
      if (header === undefined) return yield* Effect.fail(new NotFound())
      if (
        plan !== undefined &&
        publish !== undefined &&
        outcome._tag === 'Shared' &&
        outcome.revision !== null
      ) {
        return {
          kind: 'shared' as const,
          draft: header,
          revision: revisionHeaderFor(plan, number, publish, loaded.now),
        }
      }
      return { kind: 'shared' as const, draft: header }
    }),

  PreviewMerge: ({ reportId }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'share_draft',
      })
      const copy = yield* ownCopy(db, reportId, user.id)
      const merge = yield* loadMerge(
        db,
        loaded,
        user.id,
        copy.baseDraft,
        peopleOf(copy.people),
      )
      return comparisonOf(merge, copy.baseDraft, loaded.record.latestDraft)
    }),

  ResolveMerge: ({ reportId, saveCounter, choices }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'save_section',
        sectionId: '',
      })
      const copy = yield* writableCopy(db, reportId, user.id)
      if (copy.saveCounter !== saveCounter) {
        return yield* Effect.fail(new Conflict({ reason: 'stale_save' }))
      }
      if (copy.baseDraft >= loaded.record.latestDraft) {
        return yield* outlineOf(db, loaded, user.id)
      }
      const merge = yield* loadMerge(
        db,
        loaded,
        user.id,
        copy.baseDraft,
        peopleOf(copy.people),
      )
      const resolved = resolveMerge(
        merge,
        choices as Parameters<typeof resolveMerge>[1],
      )
      if (Result.isFailure(resolved)) {
        return yield* Effect.fail(
          new Validation({
            problems: resolved.failure.map(entry =>
              problem('merge', entry.code, entry.path, entry.message),
            ),
          }),
        )
      }
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const outcome = yield* db.rebaseWorkingCopy({
        reportId,
        userId: user.id,
        expectedCounter: saveCounter,
        baseDraft: loaded.record.latestDraft,
        sections: Object.entries(resolved.success.content.sections).map(
          ([sectionId, section]) => ({
            sectionId,
            ordinal: ordinalOf(loaded.template, sectionId),
            content: JSON.stringify(section),
          }),
        ),
        people: JSON.stringify(resolved.success.people),
        now,
      })
      if (outcome._tag === 'Refused') {
        return yield* Effect.fail(
          outcome.reason === 'no_draft'
            ? new NotFound()
            : new Conflict({ reason: 'stale_save' }),
        )
      }
      return yield* outlineOf(db, loaded, user.id)
    }),

  GetHistory: ({ reportId }) =>
    Effect.gen(function* () {
      const { loaded, db } = yield* member(reportId, {
        type: 'read_draft',
        number: 0,
      })
      const drafts = yield* db.listDrafts(reportId)
      const hashes = yield* db.listRedactedHashes(reportId)
      const out = []
      for (const draft of drafts) {
        const joined =
          hashes.find(entry => entry.draftNumber === draft.number)?.hash ?? ''
        out.push({
          number: draft.number,
          label: draftLabel(draft.number),
          ...(draft.baseNumber === null ? {} : { baseDraft: draft.baseNumber }),
          ...(draft.authorId === null || draft.authorName === null
            ? {}
            : { sharedBy: { id: draft.authorId, name: draft.authorName } }),
          sharedAt: draft.sharedAt,
          redactedHash: yield* Effect.promise(() => hashOfJoined(joined, draft.people)),
          redactionConfirmed: draft.redactionConfirmedAt !== null,
        })
      }
      const revisions = loaded.revisions.flatMap(revision => {
        const header = revisionHeaderOf(loaded, revision.number)
        return header === undefined ? [] : [header]
      })
      return { drafts: out, revisions }
    }),

  GetDraftOutline: ({ reportId, draft }) =>
    Effect.gen(function* () {
      const { loaded, db } = yield* member(reportId, {
        type: 'read_draft',
        number: draft,
      })
      const header = yield* draftHeader(db, reportId, draft)
      const found = yield* db.getDraft(reportId, draft)
      if (header === undefined || found === null) {
        return yield* Effect.fail(new NotFound())
      }
      const rows = yield* db.getDraftContents(reportId, draft, 'original')
      void loaded
      return {
        header,
        sections: sectionRefsOf(rows),
        peopleCount: peopleOf(found.people).length,
      }
    }),

  GetDraftSection: ({ reportId, draft, sectionId, view }) =>
    Effect.gen(function* () {
      const { loaded, db } = yield* member(reportId, {
        type: 'read_draft',
        number: draft,
      })
      yield* sectionOrFail(loaded.template, sectionId)
      const text = yield* db.getDraftSection(reportId, draft, sectionId, view)
      return {
        sectionId,
        view,
        content: text === null ? EMPTY_SECTION : parseSection(text),
      }
    }),

  CompareDrafts: ({ reportId, from, to }) =>
    Effect.gen(function* () {
      const { db } = yield* member(reportId, { type: 'read_draft', number: from })
      yield* allow(
        (yield* loadReport(reportId)),
        yield* CurrentUser,
        { type: 'read_draft', number: to },
      )
      const a = yield* db.getDraft(reportId, from)
      const b = yield* db.getDraft(reportId, to)
      if (a === null || b === null) return yield* Effect.fail(new NotFound())
      const left = yield* db.getDraftContents(reportId, from, 'original')
      const right = yield* db.getDraftContents(reportId, to, 'original')
      return {
        from,
        to,
        changes: diffSections(left, right),
        peopleChanged: a.people !== b.people,
      }
    }),

  ConfirmRedaction: ({ reportId, draft, redactedHash }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'publish_revision',
      })
      const header = yield* draftHeader(db, reportId, draft)
      if (header === undefined) return yield* Effect.fail(new NotFound())
      // NOTE: the author confirms what they saw (D14): if the stored text
      // is not the one the hash names, nothing is confirmed.
      if (header.redactedHash !== redactedHash) {
        return yield* Effect.fail(new Conflict({ reason: 'changed_meanwhile' }))
      }
      yield* db.confirmRedaction({
        reportId,
        draftNumber: draft,
        confirmedBy: user.id,
        now: loaded.now,
        audit: auditOf(loaded.now, user.id, 'redaction.confirmed', reportId, {
          draftNumber: draft,
        }),
      })
      const after = yield* draftHeader(db, reportId, draft)
      if (after === undefined) return yield* Effect.fail(new NotFound())
      return after
    }),

  GetPublishChoices: ({ reportId }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'publish_revision',
      })
      const latest = loaded.record.latestDraft
      const header = yield* draftHeader(db, reportId, latest)
      const copy = yield* db.getWorkingCopy(reportId, user.id)
      const committees = yield* db.listCommittees(loaded.record.caseFile.unitId)
      const accounts = yield* db.listUnitReviewers(loaded.record.caseFile.unitId)
      const roles = loaded.template.roles
        .filter(role => role.kind === 'reviewing')
        .map(role => ({
          roleId: role.id,
          name: role.name,
          view: role.view,
          votes: role.permissions.includes('vote'),
          comments: role.permissions.includes('comment'),
          ...(role.permissions.includes('vote') && role.approval !== undefined
            ? { rule: role.approval }
            : {}),
        }))
      const people = new Map<string, string>()
      for (const entry of accounts) people.set(entry.userId, entry.name)
      return {
        latestDraft: latest,
        hasUnsharedChanges:
          copy !== null && copy.saveCounter > copy.sharedCounter,
        redactionConfirmed: header?.redactionConfirmed ?? false,
        closingRequired: loaded.record.state === 'concluding',
        roles,
        committees: committees
          .filter(committee => committee.archivedAt === null)
          .map(committee => ({
            id: committee.id,
            name: committee.name,
            members: committee.memberIds.map(id => ({
              id,
              name: people.get(id) ?? id,
            })),
          })),
        reviewers: [...people].map(([id, name]) => ({ id, name })),
      }
    }),

  PublishRevision: ({ reportId, draft, terms }) =>
    Effect.gen(function* () {
      const { user, loaded, db } = yield* member(reportId, {
        type: 'publish_revision',
      })
      const header = yield* draftHeader(db, reportId, draft)
      if (header === undefined) return yield* Effect.fail(new NotFound())
      const plan = yield* planPublish(
        db,
        loaded,
        user.id,
        terms,
        loaded.flow,
        draft,
        false,
        header.redactionConfirmed,
      )
      const outcome = yield* db.publishRevision({
        ...plan.input,
        draft,
        reportId,
        audit: auditOf(loaded.now, user.id, 'revision.published', reportId, {
          draftNumber: draft,
          revisionNumber: plan.revision,
        }),
      })
      if (outcome._tag === 'Refused') {
        switch (outcome.reason) {
          case 'not_latest':
            return yield* Effect.fail(new Conflict({ reason: 'not_latest' }))
          case 'wrong_state':
            return yield* Effect.fail(
              new NotAllowedInState({
                state: loaded.record.state,
                code: 'wrong_state',
              }),
            )
          case 'participant_is_author':
            return yield* Effect.fail(
              validation('publish', 'participant_is_author'),
            )
          case 'not_confirmed':
            return yield* Effect.fail(
              validation('publish', 'redaction_not_confirmed'),
            )
          default:
            return yield* Effect.fail(
              new Conflict({ reason: 'changed_meanwhile' }),
            )
        }
      }
      return {
        revision: revisionHeaderFor(plan, draft, terms, loaded.now),
        notified: plan.notified,
      }
    }),
}

// NOTE: the changes between two drafts: whole sections added or removed, the
// items whose value changed, and a change of the rest of a section (entries,
// subsections, status) as a change of the section.
const diffSections = (
  left: ReadonlyArray<import('@case-desk/domain').SectionContentRow>,
  right: ReadonlyArray<import('@case-desk/domain').SectionContentRow>,
) => {
  const a = new Map(left.map(row => [row.sectionId, parseSection(row.content)]))
  const b = new Map(
    right.map(row => [row.sectionId, parseSection(row.content)]),
  )
  const ids = [...new Set([...a.keys(), ...b.keys()])]
  const changes: Array<{
    key: string
    change: 'added' | 'removed' | 'changed'
    sectionId: string
    itemId?: string
  }> = []
  for (const sectionId of ids) {
    const before = a.get(sectionId)
    const after = b.get(sectionId)
    if (before === undefined && after !== undefined) {
      changes.push({ key: sectionId, change: 'added', sectionId })
      continue
    }
    if (after === undefined && before !== undefined) {
      changes.push({ key: sectionId, change: 'removed', sectionId })
      continue
    }
    if (before === undefined || after === undefined) continue
    if (JSON.stringify(before) === JSON.stringify(after)) continue
    const items = new Set([
      ...Object.keys(before.values),
      ...Object.keys(after.values),
    ])
    for (const itemId of items) {
      const x = before.values[itemId]
      const y = after.values[itemId]
      if (JSON.stringify(x) === JSON.stringify(y)) continue
      changes.push({
        key: `${sectionId}/${itemId}`,
        change: x === undefined ? 'added' : y === undefined ? 'removed' : 'changed',
        sectionId,
        itemId,
      })
    }
    if (
      JSON.stringify({ ...before, values: {} }) !==
      JSON.stringify({ ...after, values: {} })
    ) {
      changes.push({ key: sectionId, change: 'changed', sectionId })
    }
  }
  return changes
}

export { hashOfSections, idOf, jobsFor }
