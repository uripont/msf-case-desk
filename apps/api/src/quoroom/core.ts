import { Context, Effect, Layer, Schema } from 'effect'

import {
  type Action,
  type Allowed,
  type DecidedBy,
  type FlowError,
  type GrantRecord,
  type MemberRecord,
  type NotificationConfig,
  type NotificationJob,
  NotFound,
  NotPermitted,
  Conflict,
  CurrentUser,
  DEFAULT_NOTIFICATION_CONFIG,
  DeadlinePassed,
  MAX_TEMPLATES_PER_LOOKUP,
  NotAllowedInState,
  type Problem,
  type PublishProblem,
  ReportRepository,
  type ReportRepositoryApi,
  type ReportAccess,
  type ReportBundle,
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
  draftingRoleOf,
  notificationJobs,
  refusalToError,
  settle,
} from '@quoroom/domain'

// NOTE: The pieces every Quoroom handler shares: the injected
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

// NOTE: where the address of a caller can be trusted from (D13, D20). On
// Cloudflare the platform sets `cf-connecting-ip`. Anywhere else that header is
// whatever the caller sent, so it is never read: a deployment behind a proxy it
// controls names that proxy's header (`header`), and one with nothing to trust
// (plain workerd) has a single shared bucket (`self_hosted`).
export type NetworkPolicy =
  | Readonly<{ kind: 'cloudflare' }>
  | Readonly<{ kind: 'header'; name: string }>
  | Readonly<{ kind: 'self_hosted' }>

export class QuoroomNetwork extends Context.Service<
  QuoroomNetwork,
  NetworkPolicy
>()('QuoroomNetwork') {}

export const SELF_HOSTED_BUCKET = 'self-hosted'
const MAX_ADDRESS_LENGTH = 64

// NOTE: the key of the per-address sign-in limit. With `self_hosted` every
// caller shares one bucket, so that limit only holds up together with the
// per-email one (both are always applied, and the longer wait wins).
export const clientAddress = (
  policy: NetworkPolicy,
  headers: Readonly<Record<string, string | undefined>>,
): string => {
  const raw =
    policy.kind === 'cloudflare'
      ? headers['cf-connecting-ip']
      : policy.kind === 'header'
        ? headers[policy.name.toLowerCase()]?.split(',')[0]
        : undefined
  const address = raw?.trim().slice(0, MAX_ADDRESS_LENGTH) ?? ''
  if (address !== '') return address
  return policy.kind === 'cloudflare' ? 'unknown' : SELF_HOSTED_BUCKET
}

export const QuoroomClockLive = Layer.succeed(QuoroomClock, {
  now: Effect.sync(() => Date.now()),
})

export const QuoroomIdsLive = Layer.succeed(QuoroomIds, {
  next: prefix =>
    Effect.sync(() => `${prefix}-${crypto.randomUUID().replaceAll('-', '')}`),
})

// NOTE: the services for Cloudflare. Anywhere else, `QuoroomServicesFor`
// names where addresses can be trusted from.
export const QuoroomServicesFor = (
  network: NetworkPolicy,
  config: NotificationConfig = DEFAULT_NOTIFICATION_CONFIG,
) =>
  Layer.mergeAll(
    QuoroomClockLive,
    QuoroomIdsLive,
    Layer.succeed(QuoroomConfig, config),
    Layer.succeed(QuoroomNetwork, network),
  )

export const QuoroomServicesLive = (config?: NotificationConfig) =>
  QuoroomServicesFor({ kind: 'cloudflare' }, config)

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

// NOTE: a storage error of either repository, as the API reports it.
export const fromRepository = <A>(
  effect: Effect.Effect<A, { readonly message: string }>,
): Effect.Effect<A, StorageUnavailable> =>
  effect.pipe(
    Effect.mapError(error => new StorageUnavailable({ message: error.message })),
  )

export const wrapRepository = (api: ReportRepositoryApi): Store =>
  Object.fromEntries(
    Object.entries(api).map(([name, operation]) => [
      name,
      (...args: Array<unknown>) =>
        fromRepository(
          (operation as (...a: Array<unknown>) => Effect.Effect<unknown, Error>)(
            ...args,
          ),
        ),
    ]),
  ) as unknown as Store

// NOTE: the wrapped store is a plain object of functions over the repository,
// so it is made once per repository (per isolate on the Worker), not on every
// `yield* store`.
const wrapped = new WeakMap<ReportRepositoryApi, Store>()

export const store: Effect.Effect<Store, never, ReportRepository> =
  Effect.gen(function* () {
    const api = yield* ReportRepository
    const known = wrapped.get(api)
    if (known !== undefined) return known
    const made = wrapRepository(api)
    wrapped.set(api, made)
    return made
  })

// NOTE: what the notification pass calls once per run: unreferenced
// images and abandoned staged shares older than a day, at most
// `CLEANUP_LIMIT` of each, so one run is bounded.
export const STALE_AFTER_MS = 24 * 3_600_000
export const CLEANUP_LIMIT = 50

export const cleanupStale = (): Effect.Effect<
  Readonly<{ images: number; staged: number }>,
  StorageUnavailable,
  ReportRepository | QuoroomClock
> =>
  Effect.gen(function* () {
    const db = yield* store
    const clock = yield* QuoroomClock
    const now = yield* clock.now
    return yield* db.cleanup({ olderThan: now - STALE_AFTER_MS, limit: CLEANUP_LIMIT })
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

// NOTE: the templates of several reports in at most one query (the ones not in
// the cache yet, up to the store's limit per lookup); the rest are read one at
// a time, which the callers' own bounds keep small.
export const loadTemplates = (
  db: Store,
  keys: ReadonlyArray<Readonly<{ templateId: string; version: number }>>,
): Effect.Effect<ReadonlyMap<string, Template>, StorageUnavailable> =>
  Effect.gen(function* () {
    const wanted = new Map<string, { templateId: string; version: number }>()
    for (const key of keys) wanted.set(`${key.templateId}@${key.version}`, key)
    const missing = [...wanted].filter(([key]) => !templateCache.has(key))
    if (missing.length > 0) {
      const records = yield* db.getTemplateVersions(
        missing.slice(0, MAX_TEMPLATES_PER_LOOKUP).map(([, key]) => key),
      )
      for (const record of records) {
        const key = `${record.templateId}@${record.version}`
        if (record.state === 'draft') continue
        try {
          templateCache.set(key, decodeTemplate(JSON.parse(record.definition)))
        } catch {
          return yield* Effect.fail(
            new StorageUnavailable({ message: 'template invalid' }),
          )
        }
      }
    }
    const out = new Map<string, Template>()
    for (const [key, { templateId, version }] of wanted) {
      out.set(key, yield* loadTemplate(db, templateId, version))
    }
    return out
  })

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
  // NOTE: false when the round was settled in this view (its deadline has
  // passed or its rule is met) but the store refused to record the decision
  // every time it was tried. Handlers still act on the settled view; the
  // notification pass leaves the job pending.
  decisionStored: boolean
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
  ...rounds.flatMap(({ round, participants }): ReadonlyArray<ReportEvent> =>
    participants.flatMap((participant): ReadonlyArray<ReportEvent> =>
      participant.removedAt === null
        ? []
        : [
            {
              type: 'reviewer_removed',
              revision: round.revision,
              accountId: participant.userId,
              at: participant.removedAt,
            },
          ],
    ),
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

// NOTE: a decision that the store refuses (a deadline extended or a person
// removed in between) is made again from a fresh read; after this many tries
// the settled view is returned without being stored (`decisionStored` is then
// false). The notification pass makes one try: it has a budget of queries, and
// leaves the job pending for the next run instead.
const MAX_SETTLE_ATTEMPTS = 3

export type LoadOptions = Readonly<{
  // NOTE: the notification pass: one round trip for the whole read, a cut-down
  // template (roles and whether there is a conclusion), one settle try.
  pass?: boolean
}>

// NOTE: the template of the pass: only what the rules of a round read (the
// roles, and whether the template has a conclusion). The sections are never
// read by the pass, so they are not decoded. Immutable once published, so
// cached per isolate like the full template.
const slimCache = new Map<string, Template>()

const slimTemplate = (
  key: string,
  templateId: string,
  version: number,
  bundle: NonNullable<ReportBundle['template']>,
): Effect.Effect<Template, StorageUnavailable> =>
  Effect.try({
    try: () => {
      // NOTE: not decoded with the Schema: the roles were validated when the
      // version was published, versions never change, and building the decoder
      // costs milliseconds on a cold isolate.
      const roles: unknown = JSON.parse(bundle.roles)
      if (!Array.isArray(roles)) throw new Error('roles')
      const template = {
        id: templateId,
        version,
        roles,
        sections: [],
        ...(bundle.hasConclusion ? { conclusion: { id: 'conclusion' } } : {}),
      } as unknown as Template
      if (bundle.state !== 'draft') slimCache.set(key, template)
      return template
    },
    catch: () => new StorageUnavailable({ message: 'template invalid' }),
  })

type Parts = Readonly<{
  record: ReportRecord
  template: Template
  members: ReadonlyArray<MemberRecord>
  rounds: ReadonlyArray<RoundWithParticipants>
  reviews: ReadonlyArray<StoreReviewRecord>
  revisions: ReadonlyArray<RevisionRecord>
}>

const readParts = (
  db: Store,
  reportId: string,
  pass: boolean,
): Effect.Effect<Parts | undefined, StorageUnavailable> =>
  Effect.gen(function* () {
    if (pass) {
      const bundle = yield* db.readReport(reportId, { template: true })
      if (bundle === null) return undefined
      const { record } = bundle
      const key = `${record.templateId}@${record.templateVersion}`
      const cached = templateCache.get(key) ?? slimCache.get(key)
      const template =
        cached ??
        (bundle.template === null
          ? yield* Effect.fail(new StorageUnavailable({ message: 'template missing' }))
          : yield* slimTemplate(key, record.templateId, record.templateVersion, bundle.template))
      return { ...bundle, template }
    }
    // NOTE: one round trip for the report, its members, rounds, reviews and
    // revisions; the template is cached per isolate once published.
    const parts = yield* db.readReportParts(reportId)
    if (parts === null) return undefined
    const template = yield* loadTemplate(
      db,
      parts.record.templateId,
      parts.record.templateVersion,
    )
    return { ...parts, template }
  })

const loadRaw = (
  reportId: string,
  options: LoadOptions = {},
  attempt = 1,
): Effect.Effect<Loaded | undefined, StorageUnavailable, Deps> =>
  Effect.gen(function* () {
    const db = yield* store
    const clock = yield* QuoroomClock
    const config = yield* QuoroomConfig
    const now = yield* clock.now
    const parts = yield* readParts(db, reportId, options.pass === true)
    if (parts === undefined) return undefined
    const { record, template, members, rounds, reviews, revisions } = parts
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
        decisionStored: true,
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
    let decisionStored = true
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
      const decided = yield* db.decideRound({
        roundId: last.round.id,
        reportId,
        decidedBy,
        toState: settled.state,
        jobs,
        // NOTE: what the decision was made from; the store refuses it when
        // any of these changed in between.
        expectedDeadlineAt: last.round.deadlineAt,
        expectedReviews: reviews.filter(r => r.roundId === last.round.id).length,
        expectedParticipants: last.participants.filter(p => p.removedAt === null)
          .length,
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
      if (decided._tag === 'Refused') {
        const tries = options.pass === true ? 1 : MAX_SETTLE_ATTEMPTS
        if (attempt < tries) return yield* loadRaw(reportId, options, attempt + 1)
        // NOTE: refused every time: the view is settled, but nothing was stored.
        decisionStored = false
      }
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
      decisionStored,
      access: {
        id: reportId,
        unit: record.caseFile.unitId,
        template,
        authors,
        flow: settled,
      },
    }
  })

export const loadReport = (reportId: string, options: LoadOptions = {}) =>
  loadRaw(reportId, options)


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

// NOTE: the capabilities of the deployment (People, Theme, Templates,
// author in a unit), for any action `authorize` decides from grants alone. The
// grants are read here and nowhere else; the answer is `NotPermitted` whether
// or not the thing the caller names exists.
export const allowCapability = (
  db: Store,
  action: Action,
): Effect.Effect<
  Readonly<{ user: Readonly<{ id: string }>; grants: ReadonlyArray<GrantRecord> }>,
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
      action,
    )
    if (result.allowed) return { user, grants }
    return yield* Effect.fail(
      new NotPermitted({
        reason: result.reason === 'read_only' ? 'read_only' : 'not_permitted',
      }),
    )
  })

// NOTE: 32 random bytes as hex: the token of a link (D13). Only its SHA-256
// is stored.
export const randomToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

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
