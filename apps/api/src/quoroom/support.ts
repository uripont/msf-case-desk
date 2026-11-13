import { Effect, Result } from 'effect'

import {
  type Action,
  type AuditInput,
  type Comparison,
  type DraftData,
  type DraftHeader,
  type Merge,
  type Person,
  type PublishInput,
  type PublishTerms,
  type ReportEvent,
  type ReportFlow,
  type ReportState,
  type SectionContentRow,
  type Template,
  ALLOWED_EVENTS,
  CurrentUser,
  DeadlinePassed,
  NotFound,
  REPORT_STATES,
  Validation,
  applyEvent,
  chooseParticipants,
  draftLabel,
  revisionTitle,
} from '@case-desk/domain'

import { parseSection, reportShell, sha256Hex } from './content'
import {
  type Loaded,
  QuoroomConfig,
  type Store,
  allow,
  flowFailure,
  idOf,
  jobsFor,
  loadReport,
  problem,
  publishProblems,
  store,
  timeZoneOk,
  validation,
} from './core'

// NOTE: Pieces the author-side and reviewer-side handlers share.

// NOTE: The one entry of every report procedure: the caller, the report
// loaded with its round settled, and the answer of `authorize`. A report that
// does not exist, or that the caller has no role in, is `NotFound` here and
// nowhere else.
export const member = (reportId: string, action: Action) =>
  Effect.gen(function* () {
    const user = yield* CurrentUser
    const loaded = yield* loadReport(reportId)
    const allowed = yield* allow(loaded, user, action)
    if (loaded === undefined) return yield* Effect.fail(new NotFound())
    const db = yield* store
    return { user, loaded, allowed, db }
  })

export const peopleOf = (text: string): ReadonlyArray<Person> =>
  JSON.parse(text) as ReadonlyArray<Person>

export const dataOf = (
  template: Template,
  rows: ReadonlyArray<SectionContentRow>,
  people: ReadonlyArray<Person>,
): DraftData => ({
  content: reportShell(
    template,
    Object.fromEntries(
      rows.map(row => [row.sectionId, parseSection(row.content)]),
    ),
  ),
  people,
})

// NOTE: the hash an author confirms (D14): the hash of the stored redacted
// hashes of the sections of a draft, joined in order.
// NOTE: the people list is part of what is confirmed: the redacted text
// depends on it, so a change to the list after the preview is a different
// share. The hash of the list text is `peopleHashOf`.
export const peopleHashOf = (people: string): Promise<string> =>
  sha256Hex(people)

export const hashOfJoined = async (
  joined: string,
  people: string,
): Promise<string> => sha256Hex(`${joined}|${await peopleHashOf(people)}`)

export const draftHeader = (
  db: Store,
  reportId: string,
  number: number,
): Effect.Effect<DraftHeader | undefined, import('@case-desk/domain').StorageUnavailable> =>
  Effect.gen(function* () {
    const draft = yield* db.getDraft(reportId, number)
    if (draft === null) return undefined
    const sections = yield* db.listDraftSections(reportId, number)
    const hash = yield* Effect.promise(() =>
      hashOfJoined(
        sections.map(section => section.version).join(','),
        draft.people,
      ),
    )
    return {
      number: draft.number,
      label: draftLabel(draft.number),
      ...(draft.baseNumber === null ? {} : { baseDraft: draft.baseNumber }),
      ...(draft.authorId === null || draft.authorName === null
        ? {}
        : { sharedBy: { id: draft.authorId, name: draft.authorName } }),
      sharedAt: draft.sharedAt,
      redactedHash: hash,
      redactionConfirmed: draft.redactionConfirmedAt !== null,
    }
  })

export const comparisonOf = (
  merge: Merge,
  baseDraft: number,
  theirsDraft: number,
): Comparison => ({
  baseDraft,
  theirsDraft,
  conflicts: merge.conflicts as unknown as Comparison['conflicts'],
  problems: merge.problems.map(entry =>
    problem('merge', entry.code, entry.path, entry.message),
  ),
})

export const auditOf = (
  at: number,
  actorId: string,
  action: string,
  reportId: string,
  extra: Partial<AuditInput> = {},
): AuditInput => ({ at, actorId, action, reportId, ...extra })

const statesAllowing = (types: ReadonlyArray<string>): ReadonlyArray<ReportState> =>
  REPORT_STATES.filter(state =>
    types.every(type =>
      (ALLOWED_EVENTS[state] as ReadonlyArray<string>).includes(type),
    ),
  )

export type PublishPlan = Readonly<{
  input: Omit<PublishInput, 'draft' | 'audit'>
  flow: ReportFlow
  revision: number
  notified: number
  roleViews: ReadonlyArray<'full' | 'redacted'>
}>

// NOTE: Everything publishing needs, in one place so that "share and publish"
// and "publish" do the same checks: the closing flag matches the state, the
// deadline is in the future and a known zone, the participants (D23), the
// redaction confirmation for a `redacted` role (D14), the flow event, the
// notification jobs. Nothing is written here.
export const planPublish = (
  db: Store,
  loaded: Loaded,
  publisherId: string,
  terms: PublishTerms,
  flow: ReportFlow,
  draftNumber: number,
  alsoShares: boolean,
  redactionConfirmed: boolean,
) =>
  Effect.gen(function* () {
    const config = yield* QuoroomConfig
    const { template, now } = loaded
    const concluding = loaded.record.state === 'concluding'
    if (terms.closing !== concluding) {
      return yield* Effect.fail(
        validation(
          'input',
          concluding ? 'closing_required' : 'closing_not_allowed',
        ),
      )
    }
    if (!timeZoneOk(terms.deadline.timeZone)) {
      return yield* Effect.fail(validation('input', 'unknown_time_zone'))
    }
    if (terms.deadline.at <= now) {
      return yield* Effect.fail(
        new DeadlinePassed({ deadline: terms.deadline.at }),
      )
    }
    const committees = yield* db.listCommittees(loaded.record.caseFile.unitId)
    // NOTE: an account chosen by ID must be in this unit's registry (or in one
    // of its committees); anything else is a validation problem, not a fault.
    const registry = (yield* db.listUnitReviewers(loaded.record.caseFile.unitId)).map(
      entry => entry.userId,
    )
    const chosen = chooseParticipants(
      {
        template,
        unit: loaded.record.caseFile.unitId,
        authors: loaded.authors,
        registry,
        committees: committees
          .filter(committee => committee.archivedAt === null)
          .map(committee => ({
            id: committee.id,
            unit: committee.unitId,
            members: committee.memberIds,
          })),
      },
      terms.selections,
    )
    if (Result.isFailure(chosen)) {
      return yield* Effect.fail(
        new Validation({ problems: publishProblems(chosen.failure) }),
      )
    }
    const roleViews = chosen.success.map(
      participant =>
        template.roles.find(role => role.id === participant.roleId)?.view ??
        'redacted',
    )
    if (roleViews.includes('redacted') && !redactionConfirmed) {
      return yield* Effect.fail(validation('publish', 'redaction_not_confirmed'))
    }
    const eventType = concluding
      ? ('publish_closing_revision' as const)
      : ('publish_revision' as const)
    const applied = applyEvent(
      { template, authors: loaded.authors, now },
      flow,
      {
        type: eventType,
        draft: draftNumber,
        deadline: terms.deadline.at,
        participants: chosen.success,
      },
    )
    if (Result.isFailure(applied)) {
      return yield* Effect.fail(flowFailure(applied.failure, terms.deadline.at))
    }
    const newFlow = applied.success
    const round = newFlow.rounds[newFlow.rounds.length - 1]
    if (round === undefined) return yield* Effect.fail(new NotFound())
    const revision = round.revision
    // NOTE: one read for all the authors, whatever their number.
    const watchers = new Set<string>(
      (yield* db.listProfiles(loaded.authors))
        .filter(profile => profile.notifyOnApproval)
        .map(profile => profile.userId),
    )
    const extra: ReadonlyArray<ReportEvent> = [
      { type: 'revision_published', revision, at: now },
    ]
    const jobs = yield* jobsFor(db, config, {
      template,
      flow: newFlow,
      authors: loaded.authors,
      approvalWatchers: watchers,
      revisions: loaded.revisions,
      rounds: loaded.rounds,
      reviews: loaded.reviews,
      extraEvents: extra,
      reportId: loaded.record.id,
      now,
    })
    const roundId = yield* idOf('round')
    const plan: PublishPlan = {
      input: {
        closing: concluding,
        revision,
        roundId,
        deadlineAt: terms.deadline.at,
        deadlineZone: terms.deadline.timeZone,
        participants: chosen.success.map(participant => ({
          userId: participant.accountId,
          roleId: participant.roleId,
        })),
        fromStates: statesAllowing(
          alsoShares ? ['share_draft', eventType] : [eventType],
        ),
        toState: newFlow.state,
        jobs,
        publishedBy: publisherId,
        // NOTE: the batch itself refuses to publish to a `redacted` role
        // unless the redaction of this exact draft is confirmed (D14).
        ...(roleViews.includes('redacted')
          ? { requiresConfirmation: true }
          : {}),
        now,
      },
      flow: newFlow,
      revision,
      notified: new Set(
        jobs
          .filter(job => job.kind === 'review_request')
          .map(job => job.recipient),
      ).size,
      roleViews,
    }
    return plan
  })

export const revisionHeaderFor = (
  plan: PublishPlan,
  draft: number,
  terms: PublishTerms,
  now: number,
) => ({
  number: plan.revision,
  label: revisionTitle(plan.revision, plan.input.closing),
  draft,
  closing: plan.input.closing,
  publishedAt: now,
  deadline: terms.deadline,
  status: 'open' as const,
})
