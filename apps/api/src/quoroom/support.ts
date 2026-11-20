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
  automaticChanges,
  canonicalJson,
  checkClosingConclusion,
  deadlineTooFar,
  checkClosingDraft,
  chooseParticipants,
  draftLabel,
  revisionTitle,
} from '@quoroom/domain'

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

// NOTE: a stored people list that is not a list is a fault, never an empty list
// (the check of `readPeople` in reviewer.ts).
export const peopleOf = (text: string): ReadonlyArray<Person> => {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('people list is not a list')
  return parsed as ReadonlyArray<Person>
}

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

// NOTE: the case file is part of what is confirmed too: the hash of the
// canonical JSON of its redacted title and reference (`redactedCaseOf`).
export const caseHashOf = (title: string, reference: string): Promise<string> =>
  sha256Hex(canonicalJson({ title, reference }))

export const hashOfJoined = async (
  joined: string,
  people: string,
  caseHash: string,
): Promise<string> =>
  sha256Hex(`${joined}|${await peopleHashOf(people)}|${caseHash}`)

export const draftHeader = (
  db: Store,
  reportId: string,
  number: number,
): Effect.Effect<DraftHeader | undefined, import('@quoroom/domain').StorageUnavailable> =>
  Effect.gen(function* () {
    // NOTE: the draft and its sections in one round trip.
    const found = yield* db.getDraftWithSections(reportId, number)
    if (found === null) return undefined
    const { draft, sections } = found
    const hash = yield* Effect.promise(async () =>
      hashOfJoined(
        sections.map(section => section.version).join(','),
        draft.people,
        await caseHashOf(draft.caseTitleRedacted, draft.caseReferenceRedacted),
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

// NOTE: The most automatically-taken changes one comparison lists (the
// `Comparison` schema allows 2000).
export const AUTOMATIC_LIMIT = 2000

// NOTE: The list cut to `limit`, and how many were left out. The count goes in
// `Comparison.automaticOmitted` so the screen can say "and N more changes"
// instead of silently showing a part.
export const capAutomatic = <A>(
  changes: ReadonlyArray<A>,
  limit: number = AUTOMATIC_LIMIT,
): Readonly<{ automatic: ReadonlyArray<A>; omitted: number }> => ({
  automatic: changes.slice(0, limit),
  omitted: Math.max(0, changes.length - limit),
})

export const comparisonOf = (
  merge: Merge,
  baseDraft: number,
  theirsDraft: number,
): Comparison => {
  const { automatic, omitted } = capAutomatic(automaticChanges(merge))
  return {
    baseDraft,
    theirsDraft,
    conflicts: merge.conflicts as unknown as Comparison['conflicts'],
    automatic,
    ...(omitted > 0 ? { automaticOmitted: omitted } : {}),
    problems: merge.problems.map(entry =>
      problem('merge', entry.code, entry.path, entry.message),
    ),
  }
}

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

// NOTE: The rule on a draft while the report is `concluding` (D18): only the
// conclusion may differ from the revision being closed, and, when the draft is
// to be published as the closing revision, the conclusion must be written. The
// rows are those of the draft or working copy in question. It never writes.
export const closingGuard = (
  db: Store,
  loaded: Loaded,
  rows: ReadonlyArray<SectionContentRow>,
  requireConclusion: boolean,
) =>
  Effect.gen(function* () {
    if (loaded.record.state !== 'concluding') return
    const revision = loaded.revisions[loaded.revisions.length - 1]
    if (revision === undefined) {
      return yield* Effect.fail(validation('flow', 'no_revision_to_close'))
    }
    const baseRows = yield* db.getDraftContents(
      loaded.record.id,
      revision.draftNumber,
      'original',
    )
    const content = dataOf(loaded.template, rows, []).content
    const closing = checkClosingDraft(
      loaded.template,
      loaded.record.state,
      dataOf(loaded.template, baseRows, []).content,
      content,
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
    if (requireConclusion) {
      const written = checkClosingConclusion(
        loaded.template,
        loaded.record.state,
        content,
      )
      if (Result.isFailure(written)) {
        return yield* Effect.fail(
          new Validation({
            problems: [
              problem('flow', written.failure.code, [written.failure.sectionId]),
            ],
          }),
        )
      }
    }
  })

export const deadlineTooFarFailure = () =>
  new Validation({
    problems: [
      problem(
        'input',
        'deadline_too_far',
        ['deadline'],
        'The deadline can be at most one year ahead.',
      ),
    ],
  })

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
  // NOTE: the content that would be published, read only when the report is
  // `concluding`: the rows of the draft, or of the working copy being shared.
  rowsOf: Effect.Effect<
    ReadonlyArray<SectionContentRow>,
    import('@quoroom/domain').StorageUnavailable
  >,
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
    if (concluding) {
      yield* closingGuard(db, loaded, yield* rowsOf, true)
    }
    if (!timeZoneOk(terms.deadline.timeZone)) {
      return yield* Effect.fail(validation('input', 'unknown_time_zone'))
    }
    if (terms.deadline.at <= now) {
      return yield* Effect.fail(
        new DeadlinePassed({ deadline: terms.deadline.at }),
      )
    }
    if (deadlineTooFar(terms.deadline.at, now)) {
      return yield* Effect.fail(deadlineTooFarFailure())
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
