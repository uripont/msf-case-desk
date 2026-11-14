import { Effect, Layer } from 'effect'

import {
  type NotificationConfig,
  DEFAULT_NOTIFICATION_CONFIG,
  LEASE_MS,
  MINUTE,
  ReportRepository,
} from '@case-desk/domain'

import { withReferrerPolicy } from './headers'
import { QuoroomClock, QuoroomConfig, QuoroomIdsLive } from './quoroom/core'
import {
  type PassResult,
  NotificationChannelsInbox,
  PASS_LIMIT,
  housekeepingDue,
  runPass,
} from './quoroom/notify'
import { claimJobs, makeSqlReportRepository } from './reportRepository'
import type { SqlStore } from './sql'

// NOTE: Where the notification pass is started from (stage 7): the Cloudflare
// `scheduled` handler, and `POST /api/tick` for hosts that have no Cron Trigger
// (plain workerd, driven by a host `cron` with `curl`). Both run the same
// `runNotificationPass`, which is safe to run twice at once or to stop halfway
// (see the state machine in `quoroom/notify.ts`).

export type TickEnv = {
  // NOTE: Timings in minutes, set by the stack (D12). Unset or invalid means
  // the production value of `DEFAULT_NOTIFICATION_CONFIG`.
  readonly NOTIFY_REQUEST_DELAY_MINUTES?: string
  readonly NOTIFY_FIRST_REMINDER_MINUTES?: string
  readonly NOTIFY_FINAL_REMINDER_MINUTES?: string
  // NOTE: The secret `/api/tick` needs. Unset: the route does not exist.
  readonly TICK_SECRET?: string
}

// NOTE: workerd gives a binding that the host did not set (`fromEnvironment`)
// as `null`, not `undefined`, so anything that is not text is "unset".
const minutesOf = (value: unknown, fallback: number): number => {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 60 * 24 * 30) {
    // NOTE: a setting of the stack, not personal data.
    console.error('A NOTIFY_*_MINUTES variable is not a number of minutes; its default is used.')
    return fallback
  }
  return minutes * MINUTE
}

const parseConfig = (env: TickEnv): NotificationConfig => ({
  requestDelay: minutesOf(
    env.NOTIFY_REQUEST_DELAY_MINUTES,
    DEFAULT_NOTIFICATION_CONFIG.requestDelay,
  ),
  firstReminderBefore: minutesOf(
    env.NOTIFY_FIRST_REMINDER_MINUTES,
    DEFAULT_NOTIFICATION_CONFIG.firstReminderBefore,
  ),
  finalReminderBefore: minutesOf(
    env.NOTIFY_FINAL_REMINDER_MINUTES,
    DEFAULT_NOTIFICATION_CONFIG.finalReminderBefore,
  ),
})

// NOTE: the settings are the stack's and do not change while an isolate lives,
// so they are read once per isolate (keyed by the three values, so a test that
// changes them still gets the new ones).
let parsed: { key: string; config: NotificationConfig } | undefined
export const notificationConfigFrom = (env: TickEnv): NotificationConfig => {
  const key = [
    env.NOTIFY_REQUEST_DELAY_MINUTES,
    env.NOTIFY_FIRST_REMINDER_MINUTES,
    env.NOTIFY_FINAL_REMINDER_MINUTES,
  ].join('|')
  if (parsed?.key !== key) parsed = { key, config: parseConfig(env) }
  return parsed.config
}

export type PassSummary = PassResult & Readonly<{ queries: number }>

// NOTE: One pass over the database `store`, as of `now`. The claim is plain
// SQL, made before any Effect layer exists: a run with nothing due (and no
// housekeeping due, which is the first minute of each hour) costs one query and
// returns. Otherwise it builds its own small layer, not the per-request RPC
// app, and hands the claimed jobs to the pass. The summary holds counts only.
export const runNotificationPass = async (
  store: SqlStore,
  config: NotificationConfig,
  now: number = Date.now(),
): Promise<PassSummary> => {
  let queries = 0
  const claimedBy = `pass-${crypto.randomUUID().replaceAll('-', '')}`
  const claimed = await claimJobs(store, {
    now,
    limit: PASS_LIMIT,
    leaseMs: LEASE_MS,
    claimedBy,
  })
  queries += 1
  const housekeeping = housekeepingDue(now)
  if (claimed.length === 0 && !housekeeping) {
    return {
      claimed: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      deferred: 0,
      released: 0,
      decided: 0,
      cleaned: { images: 0, staged: 0 },
      pruned: 0,
      queries,
    }
  }
  const repository = makeSqlReportRepository(store, {
    onQueries: (_, count) => {
      queries += count
    },
  })
  const layer = Layer.mergeAll(
    Layer.succeed(ReportRepository, repository),
    Layer.succeed(QuoroomClock, { now: Effect.succeed(now) }),
    QuoroomIdsLive,
    Layer.succeed(QuoroomConfig, config),
    NotificationChannelsInbox,
  )
  const result = await Effect.runPromise(
    runPass({
      queries: () => queries,
      claimed,
      claimedBy,
      housekeeping,
    }).pipe(Effect.provide(layer)),
  )
  return { ...result, queries }
}

// NOTE: The pass as the Cloudflare `scheduled` handler runs it: errors are
// logged (a message, no content) and never rethrown, so one bad run does not
// stop the cron.
export const scheduledPass = async (
  store: SqlStore,
  env: TickEnv,
): Promise<void> => {
  try {
    const summary = await runNotificationPass(store, notificationConfigFrom(env))
    console.log(JSON.stringify({ event: 'notification_pass', ...summary }))
  } catch (error) {
    console.error(
      `notification pass failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`,
    )
  }
}

// ---- /api/tick ------------------------------------------------------------------------------

export const TICK_PATH = '/api/tick'

// NOTE: equal in time that does not depend on where the two differ or how long
// they are: both are hashed to the same length first.
export const constantTimeEqual = async (
  given: string,
  expected: string,
): Promise<boolean> => {
  const digest = async (value: string) =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    )
  const [a, b] = await Promise.all([digest(given), digest(expected)])
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return difference === 0
}

const plain = (status: number, body = ''): Response =>
  withReferrerPolicy(
    new Response(body, {
      status,
      headers: { 'cache-control': 'no-store' },
    }),
  )

// NOTE: 404 for every request, whatever its method, unless `TICK_SECRET` is set
// and the request is a POST that carries it: the route is never revealed to
// anyone who does not hold the secret (not by 405, not by 401, not by timing).
// Then 200 with the counts of the pass.
export const handleTick = async (
  request: Request,
  env: TickEnv,
  store: SqlStore,
  now: number = Date.now(),
): Promise<Response> => {
  const secret = env.TICK_SECRET
  if (typeof secret !== 'string' || secret === '') return plain(404)
  const header = request.headers.get('authorization') ?? ''
  const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  // NOTE: the secret is compared whatever the method, so the time taken does
  // not tell a wrong method from a wrong secret.
  const matches = await constantTimeEqual(given, secret)
  if (!matches || request.method !== 'POST') return plain(404)
  try {
    const summary = await runNotificationPass(
      store,
      notificationConfigFrom(env),
      now,
    )
    console.log(JSON.stringify({ event: 'notification_pass', ...summary }))
    return withReferrerPolicy(
      Response.json(summary, { headers: { 'cache-control': 'no-store' } }),
    )
  } catch (error) {
    console.error(
      `notification pass failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`,
    )
    return plain(500)
  }
}
