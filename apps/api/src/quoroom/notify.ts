import { Context, Effect, Layer, Result } from 'effect'

import {
  type JobRecord,
  type MessageKind,
  type NotificationConfig,
  type OutgoingMessage,
  type StorageUnavailable,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_DEFERRALS,
  MINUTE,
  THROTTLE_WINDOW_MS,
  dedupeKey,
  deferredAt,
  desiredJobs,
  isMessageKind,
  notificationLink,
  retryAt,
} from '@quoroom/domain'

import {
  type Loaded,
  type Deps,
  type Store,
  QuoroomClock,
  QuoroomConfig,
  QuoroomIds,
  cleanupStale,
  eventsOf,
  loadReport,
  store,
} from './core'

// NOTE: The notification pass (D12, D17, D19).
//
// Rules decide what should be sent (`packages/domain`, pure); this module
// decides when it was sent and records it, in bounded steps that fit one
// Workers Free invocation: at most 50 D1 queries and about 10 ms of CPU.
//
// The state machine of a job, in the table `notification_jobs`:
//
//   pending ----claim----> claimed(lease_until) --delivered--> done
//      ^                        |  |  \--- rules no longer want it --> skipped
//      |                        |  \------ failed, attempts left ---> failed(retry_at)
//      \---- released ----------/  \------ no attempts left --------> failed(final)
//   claimed whose lease has run out  --> claimed again (another pass took it over)
//   failed(retry_at <= now)          --> claimed again
//
// - A claim is one `UPDATE ... RETURNING`: two passes at once never get the
//   same job. The lease lets a pass that stopped halfway lose its jobs to a
//   later pass. Finishing a job only changes it while it is still claimed by
//   the finishing pass, so the pass that lost its lease cannot overwrite the
//   new owner.
// - A job is tried at most `MAX_ATTEMPTS` times, and only a failure of the
//   channel is an attempt. A takeover of an expired lease, and a storage error
//   while the job was handled, are deferrals (a separate, larger cap,
//   `MAX_DEFERRALS`, at which the job fails and an error is logged): a pass
//   that was killed never makes a job fail for good by itself.
// - The in-app inbox needs no delivery step: the inbox is the list of the
//   recipient's `done` jobs, so finishing the job is writing the inbox item,
//   and a job cannot be delivered twice. A channel outside the app would be
//   at-least-once: a pass that stops after sending and before finishing sends
//   again once the lease has run out. It receives the job's idempotency key
//   and the attempt number so it can guard against that.
// - Every claimed job is rechecked against fresh state before it is sent.

// ---- The channel ---------------------------------------------------------------------------

export type SendResult =
  | Readonly<{ _tag: 'Sent' }>
  | Readonly<{ _tag: 'Failed'; retryable: boolean; reason: string }>

// NOTE: `send` never fails as an Effect: a problem is a `Failed` result, so
// the pass always records it.
export interface NotificationChannel {
  readonly send: (message: OutgoingMessage) => Effect.Effect<SendResult>
}

export class NotificationChannels extends Context.Service<
  NotificationChannels,
  Readonly<{ inbox: NotificationChannel }>
>()('NotificationChannels') {}

// NOTE: The inbox "sends" nothing: see the state machine above.
export const inboxChannel: NotificationChannel = {
  send: () => Effect.succeed({ _tag: 'Sent' }),
}

export const NotificationChannelsInbox = Layer.succeed(NotificationChannels, {
  inbox: inboxChannel,
})

// NOTE: For tests: records what it was asked to send, and fails when told to.
export const makeRecordingChannel = (
  options: {
    readonly fail?: (message: OutgoingMessage) => SendResult | undefined
  } = {},
) => {
  const sent: Array<OutgoingMessage> = []
  const attempts: Array<OutgoingMessage> = []
  const channel: NotificationChannel = {
    send: message =>
      Effect.sync(() => {
        attempts.push(message)
        const failure = options.fail?.(message)
        if (failure !== undefined) return failure
        sent.push(message)
        return { _tag: 'Sent' } satisfies SendResult
      }),
  }
  return {
    sent,
    attempts,
    layer: Layer.succeed(NotificationChannels, { inbox: channel }),
  }
}

// ---- The pass ------------------------------------------------------------------------------

// NOTE: Sizing for the 10 ms of CPU and 50 queries of Workers Free. A run claims
// at most `PASS_LIMIT` jobs and loads at most `MAX_REPORTS_PER_RUN` reports
// (the rest go back to `pending`, still due, with no attempt used). A report is
// loaded only if `RESERVE_REPORT` queries and `RESERVE_FINISH` more for
// finishing still fit under `MAX_QUERIES`, counting what the run has really
// used. `RESERVE_REPORT` is the worst case of one report, measured by the test
// that always refuses the decision (20 queries: the load of 7 statements, the
// job keys, the deciding batch whose guard fails, and the check after it; one
// more is the margin). A report that is decided reads the profiles but not the
// check, and is cheaper. The pass makes one try to decide
// a round (the handlers make three); a refused decision leaves its jobs pending
// for the next run. `notify.test.ts` drives that worst case.
export const PASS_LIMIT = 5
export const MAX_REPORTS_PER_RUN = 1
export const MAX_QUERIES = 50
export const RESERVE_REPORT = 21
export const RESERVE_FINISH = 7
const RESERVE_CLEANUP = 8
const MAX_ERROR_LENGTH = 120

// NOTE: housekeeping (stale images, staged shares, old sign-in attempts) is not
// needed every minute: it runs in the first minute of each hour.
export const housekeepingDue = (now: number): boolean =>
  Math.floor(now / MINUTE) % 60 === 0

export type PassOptions = Readonly<{
  limit?: number
  leaseMs?: number
  // NOTE: how many queries the pass has made so far. Without it (the in-memory
  // repository) the pass is not limited by queries.
  queries?: () => number
  // NOTE: jobs the caller already claimed (with `claimedBy`) so that an idle
  // run costs one query and no Effect layers; the pass then does not claim.
  claimed?: ReadonlyArray<JobRecord>
  claimedBy?: string
  // NOTE: default true.
  housekeeping?: boolean
}>

export type PassResult = Readonly<{
  claimed: number
  sent: number
  skipped: number
  failed: number
  deferred: number
  released: number
  decided: number
  cleaned: Readonly<{ images: number; staged: number }>
  pruned: number
}>

type Outcome = {
  done: Array<number>
  skipped: Array<number>
  failed: Array<{ id: number; retryAt: number | null; error: string }>
  deferred: Array<{ id: number; retryAt: number; error: string }>
  released: Array<number>
}

const emptyOutcome = (): Outcome => ({
  done: [],
  skipped: [],
  failed: [],
  deferred: [],
  released: [],
})

// NOTE: a failure of the channel: counts an attempt (this one is the
// `attempts + 1`-th).
const failure = (job: JobRecord, now: number, error: string) => ({
  id: job.id,
  retryAt: retryAt(now, job.attempts + 1),
  error: error.slice(0, MAX_ERROR_LENGTH),
})

// NOTE: not the job's fault: tried again later, counted apart from attempts. At
// the cap of deferrals the job fails for good and the pass logs an error.
const defer = (outcome: Outcome, job: JobRecord, now: number, error: string) => {
  if (job.deferrals + 1 > MAX_DEFERRALS) {
    // NOTE: ids and counts only, no report text.
    console.error(
      `notification job ${job.id} was deferred ${job.deferrals + 1} times (${error}); it is failed for good`,
    )
    outcome.failed.push({ id: job.id, retryAt: null, error: 'too many deferrals' })
    return
  }
  outcome.deferred.push({
    id: job.id,
    retryAt: deferredAt(now, job.deferrals + 1),
    error: error.slice(0, MAX_ERROR_LENGTH),
  })
}

const messageFor = (job: JobRecord): OutgoingMessage | undefined => {
  if (!isMessageKind(job.kind) || job.recipientId === null) return undefined
  const kind: MessageKind = job.kind
  return {
    idempotencyKey: dedupeKey(job.reportId, job.key),
    jobId: job.id,
    kind,
    recipientId: job.recipientId,
    link: notificationLink(kind, job.reportId, job.revision),
    attempt: job.attempts + 1,
  }
}

// NOTE: One report's claimed jobs: the report is loaded (which decides its round
// if the deadline has passed, with the jobs that tells the authors), each job
// is rechecked against what is stored now, and what is still wanted is sent.
const processReport = (
  db: Store,
  loaded: Loaded,
  jobs: ReadonlyArray<JobRecord>,
  now: number,
  outcome: Outcome,
): Effect.Effect<number, never, QuoroomConfig | NotificationChannels> =>
  Effect.gen(function* () {
    const config: NotificationConfig = yield* QuoroomConfig
    const channels = yield* NotificationChannels
    if (!loaded.decisionStored) {
      // NOTE: the round is past its deadline (or its rule is met) but the
      // decision could not be recorded: nothing is reported as decided and the
      // jobs stay pending for the next run.
      outcome.released.push(...jobs.map(job => job.id))
      return 0
    }
    const watchers = new Set<string>()
    let profilesFailed = false
    if (jobs.some(job => job.kind === 'approval_received')) {
      const profiles = yield* db.listProfiles(loaded.authors).pipe(
        Effect.map(list => list),
        Effect.orElseSucceed(() => undefined),
      )
      if (profiles === undefined) profilesFailed = true
      else {
        for (const profile of profiles) {
          if (profile.notifyOnApproval) watchers.add(profile.userId)
        }
      }
    }
    const state = {
      template: loaded.template,
      flow: loaded.flow,
      authors: loaded.authors.map(accountId => ({
        accountId,
        notifyOnApproval: watchers.has(accountId),
      })),
      events: eventsOf(loaded.revisions, loaded.rounds, loaded.reviews),
      existing: [],
    }
    // NOTE: what the rules want, worked out once for the report (the recheck
    // of `isJobNeeded` is membership in exactly this list).
    let wanted: Set<string> | undefined
    const needed = (key: string): boolean => {
      wanted ??= new Set(desiredJobs(state, now, config).map(entry => entry.key))
      return wanted.has(key)
    }
    let decided = 0
    for (const job of jobs) {
      if (job.kind === 'deadline') {
        // NOTE: the work of this job was done by loading the report: the round
        // is decided when its deadline has passed. A job for a deadline that
        // was extended, or a round that ended another way, is not needed.
        const round = loaded.rounds.find(
          entry => entry.round.revision === job.revision,
        )
        if (
          round?.round.state === 'decided' &&
          round.round.decidedBy === 'deadline' &&
          round.round.deadlineAt === job.deadline
        ) {
          outcome.done.push(job.id)
          decided += 1
        } else {
          outcome.skipped.push(job.id)
        }
        continue
      }
      if (job.kind === 'approval_received' && profilesFailed) {
        // NOTE: whether the author wants it is not known: not skipped, tried
        // again later.
        defer(outcome, job, now, 'storage unavailable')
        continue
      }
      if (!needed(job.key)) {
        outcome.skipped.push(job.id)
        continue
      }
      const message = messageFor(job)
      if (message === undefined) {
        outcome.failed.push({ id: job.id, retryAt: null, error: 'no recipient' })
        continue
      }
      const result = yield* channels.inbox.send(message).pipe(
        Effect.catchCause(() =>
          Effect.succeed<SendResult>({
            _tag: 'Failed',
            retryable: true,
            reason: 'the channel failed',
          }),
        ),
      )
      if (result._tag === 'Sent') {
        outcome.done.push(job.id)
      } else {
        outcome.failed.push(
          result.retryable
            ? failure(job, now, result.reason)
            : { id: job.id, retryAt: null, error: result.reason.slice(0, MAX_ERROR_LENGTH) },
        )
      }
    }
    return decided
  })

type Totals = {
  claimed: number
  sent: number
  skipped: number
  failed: number
  deferred: number
  released: number
  decided: number
}

export const runPass = (
  options: PassOptions = {},
): Effect.Effect<
  PassResult,
  StorageUnavailable,
  Deps | NotificationChannels
> =>
  Effect.gen(function* () {
    const db = yield* store
    const clock = yield* QuoroomClock
    const ids = yield* QuoroomIds
    const now = yield* clock.now
    const limit = options.limit ?? PASS_LIMIT
    const leaseMs = options.leaseMs ?? LEASE_MS
    const claimedBy = options.claimedBy ?? (yield* ids.next('pass'))
    const used = options.queries ?? (() => 0)
    const loadedReports = new Map<string, Loaded | null>()
    const totals: Totals = {
      claimed: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      deferred: 0,
      released: 0,
      decided: 0,
    }

    // NOTE: one phase: group the claimed jobs by report, load each report while
    // the query budget lasts, and record the result in one batch. Jobs of a
    // report there was no budget for go back to `pending`, still due.
    const phase = (claimed: ReadonlyArray<JobRecord>) =>
      Effect.gen(function* () {
        const outcome = emptyOutcome()
        totals.claimed += claimed.length
        const tried: Array<JobRecord> = []
        for (const job of claimed) {
          if (job.deferrals > MAX_DEFERRALS) {
            defer(outcome, job, now, 'taken over too often')
          } else if (job.attempts >= MAX_ATTEMPTS) {
            outcome.failed.push({ id: job.id, retryAt: null, error: 'too many attempts' })
          } else {
            tried.push(job)
          }
        }
        const byReport = new Map<string, Array<JobRecord>>()
        for (const job of tried) {
          byReport.set(job.reportId, [...(byReport.get(job.reportId) ?? []), job])
        }
        for (const [reportId, jobs] of byReport) {
          const cached = loadedReports.get(reportId)
          // NOTE: a report loaded earlier still costs a query (the profiles).
          const affordable =
            cached !== undefined
              ? used() + 1 + RESERVE_FINISH <= MAX_QUERIES
              : loadedReports.size < MAX_REPORTS_PER_RUN &&
                used() + RESERVE_REPORT + RESERVE_FINISH <= MAX_QUERIES
          if (!affordable) {
            outcome.released.push(...jobs.map(job => job.id))
            continue
          }
          const loaded =
            cached !== undefined
              ? cached
              : yield* loadReport(reportId, { pass: true }).pipe(
                  Effect.map(report => report ?? null),
                  Effect.result,
                  Effect.map(result => (Result.isSuccess(result) ? result.success : undefined)),
                )
          if (loaded === undefined) {
            // NOTE: storage was unavailable: try these again later, without
            // using up their attempts.
            for (const job of jobs) defer(outcome, job, now, 'storage unavailable')
            continue
          }
          loadedReports.set(reportId, loaded)
          if (loaded === null) {
            outcome.skipped.push(...jobs.map(job => job.id))
            continue
          }
          totals.decided += yield* processReport(db, loaded, jobs, now, outcome)
        }
        yield* db.finishJobs({
          claimedBy,
          done: outcome.done,
          skipped: outcome.skipped,
          failed: outcome.failed,
          deferred: outcome.deferred,
          released: outcome.released,
          now,
        })
        totals.sent += outcome.done.length
        totals.skipped += outcome.skipped.length
        totals.failed += outcome.failed.length
        totals.deferred += outcome.deferred.length
        totals.released += outcome.released.length
      })

    const first =
      options.claimed ?? (yield* db.claimDueJobs({ now, limit, leaseMs, claimedBy }))
    if (first.length > 0) yield* phase(first)
    // NOTE: the outcomes of rounds this pass decided are due now: tell the
    // authors in the same pass, for the reports already loaded, if the queries
    // are there (the claim, the profiles of each, the finish).
    const loadedIds = [...loadedReports]
      .filter(([, loaded]) => loaded !== null)
      .map(([id]) => id)
    if (
      totals.decided > 0 &&
      used() + 1 + loadedIds.length + RESERVE_FINISH <= MAX_QUERIES
    ) {
      const second = yield* db.claimDueJobs({
        now,
        limit,
        leaseMs,
        claimedBy,
        reportIds: loadedIds,
      })
      if (second.length > 0) yield* phase(second)
    }
    // NOTE: housekeeping only when it is due and with budget to spare. Each is
    // bounded, and a failure in one never fails the pass.
    let cleaned = { images: 0, staged: 0 }
    let pruned = 0
    if (options.housekeeping !== false && used() + RESERVE_CLEANUP <= MAX_QUERIES) {
      cleaned = yield* cleanupStale().pipe(
        Effect.orElseSucceed(() => ({ images: 0, staged: 0 })),
      )
      if (used() + 1 <= MAX_QUERIES) {
        pruned = yield* db
          .pruneSignInAttempts(now - THROTTLE_WINDOW_MS, 50)
          .pipe(Effect.orElseSucceed(() => 0))
      }
    }
    return { ...totals, cleaned, pruned }
  })
