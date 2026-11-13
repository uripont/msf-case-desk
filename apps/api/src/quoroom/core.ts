import { Context, Effect, Layer, Schema } from 'effect'

import {
  type Action,
  type Allowed,
  type DecidedBy,
  type FlowError,
  type MemberRecord,
  type NotificationConfig,
  type NotificationJob,
  NotFound,
  NotPermitted,
  Conflict,
  CurrentUser,
  DEFAULT_NOTIFICATION_CONFIG,
  DeadlinePassed,
  NotAllowedInState,
  type Problem,
  type PublishProblem,
  ReportRepository,
  type ReportRepositoryApi,
  type ReportAccess,
  type ReportEvent,
  type ReportFlow,
  type ReportRecord,
  type RevisionRecord,
  type Round,
  type RoundWithParticipants,
  StorageUnavailable,
  type StoreReviewRecord,
  Template,
  Validation,
  authorize,
  decidedAtOf,
  draftingRoleOf,
  notificationJobs,
  refusalToError,
  settle,
} from '@case-desk/domain'

// NOTE: The pieces every Quoroom handler shares (stage 2c): the injected
// clock and ID services, the repository with its errors mapped to the typed
// `StorageUnavailable`, loading a report with its flow (settling the round
// lazily), authorization through `authorize`, and the mapping from domain
// failures to the contract's errors.

// ---- Injected services ---------------------------------------------------------------------

export class QuoroomClock extends Context.Service<
  QuoroomClock,
  { readonly now: Effect.Effect<number> }
>()('QuoroomClock') {}

export class QuoroomIds extends Context.Service<
  QuoroomIds,
  { readonly next: (prefix: string) => Effect.Effect<string> }
>()('QuoroomIds') {}

export class QuoroomConfig extends Context.Service<
  QuoroomConfig,
  NotificationConfig
>()('QuoroomConfig') {}

export const QuoroomClockLive = Layer.succeed(QuoroomClock, {
  now: Effect.sync(() => Date.now()),
})

export const QuoroomIdsLive = Layer.succeed(QuoroomIds, {
  next: prefix =>
    Effect.sync(() => `${prefix}-${crypto.randomUUID().replaceAll('-', '')}`),
})

export const QuoroomConfigLive = Layer.succeed(
  QuoroomConfig,
  DEFAULT_NOTIFICATION_CONFIG,
)

export const QuoroomServicesLive = Layer.mergeAll(
  QuoroomClockLive,
  QuoroomIdsLive,
  QuoroomConfigLive,
)

// NOTE: a clock the tests move by hand.
export const makeTestClock = (start: number) => {
  let current = start
  return {
    layer: Layer.succeed(QuoroomClock, { now: Effect.sync(() => current) }),
    set: (at: number) => {
      current = at
    },
    advance: (by: number) => {
      current += by
    },
    now: () => current,
  }
}

// NOTE: IDs `prefix-1`, `prefix-2`, ... so tests can name what they made.
export const makeTestIds = () => {
  let counter = 0
  return Layer.succeed(QuoroomIds, {
    next: prefix =>
      Effect.sync(() => {
        counter += 1
        return `${prefix}-${counter}`
      }),
  })
}

// ---- The repository, with typed errors -------------------------------------------------------

type Wrapped<Api> = {
  readonly [K in keyof Api]: Api[K] extends (
    ...args: infer A
  ) => Effect.Effect<infer R, unknown>
    ? (...args: A) => Effect.Effect<R, StorageUnavailable>
    : never
}
export type Store = Wrapped<ReportRepositoryApi>

export const wrapRepository = (api: ReportRepositoryApi): Store =>
  Object.fromEntries(
    Object.entries(api).map(([name, operation]) => [
      name,
      (...args: Array<unknown>) =>
        (operation as (...a: Array<unknown>) => Effect.Effect<unknown, Error>)(
          ...args,
        ).pipe(
          Effect.mapError(error => new StorageUnavailable({ message: error.message })),
        ),
    ]),
  ) as unknown as Store

export const store: Effect.Effect<Store, never, ReportRepository> =
  Effect.gen(function* () {
    return wrapRepository(yield* ReportRepository)
  })

export type Deps = ReportRepository | QuoroomClock | QuoroomIds | QuoroomConfig

// ---- Templates (immutable once published, so cached per isolate) ---------------------------------

const templateCache = new Map<string, Template>()
const decodeTemplate = Schema.decodeUnknownSync(Template)

export const loadTemplate = (
  db: Store,
  templateId: string,
  version: number,
): Effect.Effect<Template, StorageUnavailable> => {
  const key = `${templateId}@${version}`
  const cached = templateCache.get(key)
  if (cached !== undefined) return Effect.succeed(cached)
  return db.getTemplateVersion(templateId, version).pipe(
    Effect.flatMap(record =>
      record === null
        ? Effect.fail(new StorageUnavailable({ message: 'template missing' }))
        : Effect.try({
            try: () => {
              const template = decodeTemplate(JSON.parse(record.definition))
              if (record.state !== 'draft') templateCache.set(key, template)
              return template
            },
            catch: () => new StorageUnavailable({ message: 'template invalid' }),
          }),
    ),
  )
}

// ---- Loading a report ------------------------------------------------------------------------

export type Loaded = Readonly<{
  record: ReportRecord
  template: Template
  access: ReportAccess
  flow: ReportFlow
  members: ReadonlyArray<MemberRecord>
  authors: ReadonlyArray<string>
  rounds: ReadonlyArray<RoundWithParticipants>
  reviews: ReadonlyArray<StoreReviewRecord>
  revisions: ReadonlyArray<RevisionRecord>
  now: number
}>

export const flowOf = (
  record: ReportRecord,
  rounds: ReadonlyArray<RoundWithParticipants>,
  reviews: ReadonlyArray<StoreReviewRecord>,
  revisions: ReadonlyArray<RevisionRecord>,
): ReportFlow => ({
  state: record.state,
  draftCount: record.latestDraft,
  rounds: [...rounds]
    .sort((a, b) => a.round.revision - b.round.revision)
    .map(({ round, participants }): Round => ({
      revision: round.revision,
      draft:
        revisions.find(revision => revision.number === round.revision)
          ?.draftNumber ?? 0,
      closing: round.closing,
      deadline: round.deadlineAt,
      participants: participants
        .filter(p => p.removedAt === null)
        .map(p => ({ accountId: p.userId, roleId: p.roleId })),
      removed: participants
        .filter(p => p.removedAt !== null)
        .map(p => ({ accountId: p.userId, roleId: p.roleId })),
      reviews: reviews
        .filter(review => review.roundId === round.id)
        .map(review => ({
          reviewerId: review.reviewerId,
          revision: review.revision,
          decision: review.decision,
        })),
      status: round.state,
      ...(round.decidedBy === null ? {} : { decidedBy: round.decidedBy }),
    })),
})

// NOTE: the events with times that the notification rules read, rebuilt from
// what is stored (revisions, reviews and decided rounds).
export const eventsOf = (
  revisions: ReadonlyArray<{ number: number; publishedAt: number }>,
  rounds: ReadonlyArray<RoundWithParticipants>,
  reviews: ReadonlyArray<StoreReviewRecord>,
  extra: ReadonlyArray<ReportEvent> = [],
): ReadonlyArray<ReportEvent> => [
  ...revisions.map(
    (revision): ReportEvent => ({
      type: 'revision_published',
      revision: revision.number,
      at: revision.publishedAt,
    }),
  ),
  ...reviews.map(
    (review): ReportEvent => ({
      type: 'review',
      id: review.id,
      reviewerId: review.reviewerId,
      revision: review.revision,
      decision: review.decision,
      hasComments: review.hasComments,
      at: review.sentAt,
    }),
  ),
  ...rounds.flatMap(({ round }): ReadonlyArray<ReportEvent> =>
    round.state === 'decided' &&
    round.decidedBy !== null &&
    round.decidedAt !== null
      ? [
          {
            type: 'round_decided',
            revision: round.revision,
            decidedBy: round.decidedBy,
            at: round.decidedAt,
          },
        ]
      : [],
  ),
  ...extra,
]

// NOTE: the jobs to write for `flow` at `now`: those the rules want that do
// not exist yet. One read (existing keys).
export const jobsFor = (
  db: Store,
  config: NotificationConfig,
  input: Readonly<{
    template: Template
    flow: ReportFlow
    authors: ReadonlyArray<string>
    approvalWatchers: ReadonlySet<string>
    revisions: ReadonlyArray<{ number: number; publishedAt: number }>
    rounds: ReadonlyArray<RoundWithParticipants>
    reviews: ReadonlyArray<StoreReviewRecord>
    extraEvents: ReadonlyArray<ReportEvent>
    reportId: string
    now: number
  }>,
): Effect.Effect<ReadonlyArray<NotificationJob>, StorageUnavailable> =>
  Effect.gen(function* () {
    const existing = yield* db.listJobKeys(input.reportId)
    const events = eventsOf(
      input.revisions,
      input.rounds,
      input.reviews,
      input.extraEvents,
    )
    return notificationJobs(
      {
        template: input.template,
        flow: input.flow,
        authors: input.authors.map(accountId => ({
          accountId,
          notifyOnApproval: input.approvalWatchers.has(accountId),
        })),
        events,
        existing,
      },
      input.now,
      config,
    )
  })

const loadRaw = (
  reportId: string,
): Effect.Effect<Loaded | undefined, StorageUnavailable, Deps> =>
  Effect.gen(function* () {
    const db = yield* store
    const clock = yield* QuoroomClock
    const config = yield* QuoroomConfig
    const now = yield* clock.now
    const record = yield* db.getReport(reportId)
    if (record === null) return undefined
    const template = yield* loadTemplate(
      db,
      record.templateId,
      record.templateVersion,
    )
    const members = yield* db.listMembers(reportId)
    const rounds = yield* db.listRounds(reportId)
    const reviews = rounds.length === 0 ? [] : yield* db.listReviews(reportId)
    const revisions =
      rounds.length === 0 ? [] : yield* db.listRevisions(reportId)
    const flow = flowOf(record, rounds, reviews, revisions)
    const draftingRole = draftingRoleOf(template)
    const authors = members
      .filter(member => member.roleId === draftingRole?.id)
      .map(member => member.userId)
    // NOTE: deadlines are checked on every read and write, so the round is
    // settled here, with `now`, and the decision is stored.
    const settled = settle({ template, authors, now }, flow)
    if (settled === flow) {
      return {
        record,
        template,
        flow,
        members,
        authors,
        rounds,
        reviews,
        revisions,
        now,
        access: {
          id: reportId,
          unit: record.caseFile.unitId,
          template,
          authors,
          flow,
        },
      }
    }
    const last = rounds[rounds.length - 1]
    const settledLast = settled.rounds[settled.rounds.length - 1]
    let storedRounds = rounds
    if (
      last !== undefined &&
      settledLast !== undefined &&
      settledLast.decidedBy !== undefined
    ) {
      const decidedBy: DecidedBy = settledLast.decidedBy
      const decidedRounds = rounds.map(entry =>
        entry === last
          ? {
              ...entry,
              round: {
                ...entry.round,
                state: 'decided' as const,
                decidedBy,
                decidedAt: now,
              },
            }
          : entry,
      )
      const jobs = yield* jobsFor(db, config, {
        template,
        flow: settled,
        authors,
        approvalWatchers: new Set(),
        revisions,
        rounds: decidedRounds,
        reviews,
        extraEvents: [],
        reportId,
        now,
      })
      yield* db.decideRound({
        roundId: last.round.id,
        reportId,
        decidedBy,
        toState: settled.state,
        jobs,
        now,
        audit: {
          at: now,
          actorId: null,
          action: 'round.decided',
          reportId,
          revisionNumber: last.round.revision,
          meta: JSON.stringify({ decidedBy }),
        },
      })
      storedRounds = decidedRounds
    }
    return {
      record: { ...record, state: settled.state },
      template,
      flow: settled,
      members,
      authors,
      rounds: storedRounds,
      reviews,
      revisions,
      now,
      access: {
        id: reportId,
        unit: record.caseFile.unitId,
        template,
        authors,
        flow: settled,
      },
    }
  })

export const loadReport = loadRaw

// ---- Authorization ----------------------------------------------------------------------------

export type Actor = Readonly<{ id: string }>

// NOTE: every procedure runs this before it looks at anything else. A report
// that does not exist, one the caller is not a member of and one that the
// action does not apply to all give `NotFound`; a member without the
// permission gets `NotPermitted`. The caller's grants matter only for the
// capabilities of the deployment, so they are not read for a report.
export const allow = (
  loaded: Loaded | undefined,
  actor: Actor,
  action: Action,
): Effect.Effect<Allowed, NotFound | NotPermitted> => {
  const result = authorize({ id: actor.id, grants: [] }, loaded?.access, action)
  return result.allowed
    ? Effect.succeed(result)
    : Effect.fail(refusalToError(result))
}

// NOTE: the deployment capability of an author in a unit (`create_report`).
// Grants are read here, for this one action only; a unit the caller is no
// author in answers `NotPermitted` whether or not it exists.
export const allowUnit = (
  db: Store,
  unit: string,
): Effect.Effect<
  Readonly<{ id: string }>,
  NotPermitted | StorageUnavailable,
  CurrentUser
> =>
  Effect.gen(function* () {
    const user = yield* CurrentUser
    const grants = yield* db.listGrants(user.id)
    const result = authorize(
      {
        id: user.id,
        grants: grants.map(grant => ({
          capability: grant.capability,
          ...(grant.unitId === null ? {} : { unit: grant.unitId }),
        })),
      },
      undefined,
      { type: 'create_report', unit },
    )
    if (result.allowed) return user
    return yield* Effect.fail(
      new NotPermitted({
        reason: result.reason === 'read_only' ? 'read_only' : 'not_permitted',
      }),
    )
  })

export const isAuthorOf = (loaded: Loaded, actor: Actor): boolean =>
  loaded.authors.includes(actor.id)

// NOTE: reviewer procedures are for participants; an author of the report is
// refused as if the report were not there for them.
export const requireReviewer = (
  loaded: Loaded,
  actor: Actor,
): Effect.Effect<void, NotFound> =>
  isAuthorOf(loaded, actor) ? Effect.fail(new NotFound()) : Effect.void

export const requireAuthor = (
  loaded: Loaded,
  actor: Actor,
): Effect.Effect<void, NotFound> =>
  isAuthorOf(loaded, actor) ? Effect.void : Effect.fail(new NotFound())

// ---- Errors -------------------------------------------------------------------------------------

export const problem = (
  source: Problem['source'],
  code: string,
  path: Problem['path'] = [],
  message = code.replaceAll('_', ' '),
): Problem => ({ source, code, path, message })

export const validation = (
  source: Problem['source'],
  code: string,
  path: Problem['path'] = [],
): Validation => new Validation({ problems: [problem(source, code, path)] })

export const publishProblems = (
  problems: ReadonlyArray<PublishProblem>,
): ReadonlyArray<Problem> =>
  problems.map(entry =>
    problem(
      'publish',
      entry.code,
      entry.roleId === undefined ? [] : [entry.roleId],
      entry.message,
    ),
  )

// NOTE: the one mapping from a failed flow event to the contract's errors.
export const flowFailure = (
  failure: FlowError,
  deadline: number | undefined,
): NotAllowedInState | Conflict | Validation | DeadlinePassed => {
  switch (failure.code) {
    case 'not_latest':
      return new Conflict({ reason: 'not_latest' })
    case 'deadline_not_in_future':
      return new DeadlinePassed({ deadline: deadline ?? 0 })
    case 'unpublishable':
      return new Validation({
        problems: publishProblems(failure.problems ?? []),
      })
    case 'removal_makes_rule_unmeetable':
      return new Validation({
        problems: publishProblems(failure.problems ?? []),
      })
    default:
      return new NotAllowedInState({
        state: failure.state,
        code: failure.code,
      })
  }
}

export const timeZoneOk = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export const idOf = (prefix: string): Effect.Effect<string, never, QuoroomIds> =>
  Effect.gen(function* () {
    const ids = yield* QuoroomIds
    return yield* ids.next(prefix)
  })

export const roundOf = (
  loaded: Loaded,
  revision: number,
): RoundWithParticipants | undefined =>
  loaded.rounds.find(entry => entry.round.revision === revision)

export { decidedAtOf }
