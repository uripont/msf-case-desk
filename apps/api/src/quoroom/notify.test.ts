import { Effect, Layer } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  type OutgoingMessage,
  INTAKE_TEMPLATE,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_DEFERRALS,
  MINUTE,
  ReportRepository,
  RepositoryError,
} from '@case-desk/domain'

import {
  type PassResult,
  type SendResult,
  MAX_QUERIES,
  MAX_REPORTS_PER_RUN,
  PASS_LIMIT,
  RESERVE_FINISH,
  RESERVE_REPORT,
  makeRecordingChannel,
  runPass,
} from './notify'
import {
  type PersonName,
  type Scenario,
  type World,
  makeWorld,
  richContent,
} from './testkit'

// NOTE: Stage 7: the notification pass, with an injected clock and the real RPC
// stack (invented people only). What it must produce for a scripted scenario
// (D12, D19), that nothing is sent twice (two passes at once, a pass that stops
// halfway), nothing after a round is decided or a newer revision exists, retries
// with back-off, and that a pass stays inside the 50 queries of Workers Free.

const worlds: Array<World> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

const HOUR = 3_600_000
const DAY = 24 * HOUR

const intake: Scenario = {
  name: 'intake',
  template: INTAKE_TEMPLATE,
  backend: 'memory',
  authorsRole: 'authors',
  redactedRole: 'committee',
  sectionId: 'summary',
  itemId: 'summary-text',
  conclusion: { sectionId: 'committee-conclusion', itemId: 'conclusion-decision' },
}
const intakeOnSqlite: Scenario = { ...intake, name: 'intake on SQLite', backend: 'sqlite' }

const make = async (scenario: Scenario = intake) => {
  const world = await makeWorld(scenario)
  worlds.push(world)
  return world
}

type Recording = ReturnType<typeof makeRecordingChannel>

const pass = (
  w: World,
  channel: Recording,
  options: { limit?: number; useQueries?: boolean } = {},
): Promise<PassResult> => {
  const base = w.queries()
  return Effect.runPromise(
    runPass({
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.useQueries === true ? { queries: () => w.queries() - base } : {}),
    }).pipe(Effect.provide(Layer.mergeAll(w.deps, channel.layer))) as Effect.Effect<PassResult>,
  )
}

// NOTE: the same, with some operations of the repository replaced (a storage
// that fails, a decision the store always refuses).
const passPatched = (
  w: World,
  channel: Recording,
  patch: Record<string, unknown>,
  options: { limit?: number; useQueries?: boolean } = {},
): Promise<PassResult> => {
  const base = w.queries()
  return Effect.runPromise(
    runPass({
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.useQueries === true ? { queries: () => w.queries() - base } : {}),
    }).pipe(
      Effect.provide(Layer.succeed(ReportRepository, { ...w.repository, ...patch } as typeof w.repository)),
      Effect.provide(Layer.mergeAll(w.deps, channel.layer)),
    ) as Effect.Effect<PassResult>,
  )
}

const storageDown = () =>
  Effect.fail(new RepositoryError({ message: 'storage down' }))

// NOTE: who was sent what, as `kind:person`, in the order of sending.
const summary = (messages: ReadonlyArray<OutgoingMessage>) =>
  messages.map(message => `${message.kind}:${message.recipientId}`).sort()

const inboxKinds = async (w: World, who: PersonName) =>
  (await w.call(who, c => c.ListNotifications({ limit: 50 }))).items
    .map(item => item.kind)
    .sort()

describe.each([intake, intakeOnSqlite])('the scripted scenario of D12 and D19, $name', scenario => {
  test('the request at publication, the two reminders for those who have not decided, the outcome at the deadline', async () => {
    const w = await make(scenario)
    const channel = makeRecordingChannel()
    const { reportId } = await w.published()
    const published = w.clock.now()
    const deadline = published + 7 * DAY

    // Publication: the request to both reviewers, and nothing else is due.
    await pass(w, channel)
    expect(summary(channel.sent)).toEqual(['review_request:carol', 'review_request:dan'])
    const request = channel.sent[0] as OutgoingMessage
    expect(request.template.name).toBe('quoroom_review_request')
    expect(request.link).toBe(`/r/${reportId}/rev/1`)
    // The deadline in its own time zone, and no case or report words.
    expect(request.parameters).toEqual(['19 Nov, 10:00 Madrid time'])
    expect(JSON.stringify(request)).not.toMatch(/Ana|Garcia|REF-/)
    // Running it again at once sends nothing more.
    await pass(w, channel)
    expect(channel.sent).toHaveLength(2)

    // Still before the first reminder: nothing is due.
    w.clock.set(deadline - 48 * HOUR - 1)
    await pass(w, channel)
    expect(channel.sent).toHaveLength(2)

    // 48 hours before the deadline: the first reminder, to both.
    w.clock.set(deadline - 48 * HOUR)
    await pass(w, channel)
    expect(summary(channel.sent.slice(2))).toEqual([
      'reminder_first:carol',
      'reminder_first:dan',
    ])
    expect((channel.sent[2] as OutgoingMessage).template.name).toBe('quoroom_reminder')

    // Carol approves; the author is not told (D19: off by default).
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))

    // 4 hours before: the final reminder, to Dan only.
    w.clock.set(deadline - 4 * HOUR)
    await pass(w, channel)
    expect(summary(channel.sent.slice(4))).toEqual(['reminder_final:dan'])

    // The deadline passes with Dan silent: the round is decided and the author
    // is told in the same pass; nobody is reminded after it.
    w.clock.set(deadline + 1000)
    const result = await pass(w, channel)
    expect(result.decided).toBe(1)
    expect(summary(channel.sent.slice(5))).toEqual(['round_decided:alice'])
    expect((await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))).status).toBe('decided')
    w.clock.set(deadline + 10 * DAY)
    await pass(w, channel)
    expect(channel.sent).toHaveLength(6)

    // What each person finds in the inbox.
    expect(await inboxKinds(w, 'carol')).toEqual(['review_request', 'reminder_first'].sort())
    expect(await inboxKinds(w, 'dan')).toEqual(
      ['review_request', 'reminder_first', 'reminder_final'].sort(),
    )
    expect(await inboxKinds(w, 'alice')).toEqual(['round_decided'])
    expect((await w.call('alice', c => c.GetUnreadCount())).unread).toBe(1)

    // The grid shows when they were told and reminded.
    const grid = (await w.call('alice', c => c.GetGrid({ reportId }))).grid
    const row = grid.revisions[0]
    expect(row?.cells.every(cell => cell.sent !== undefined)).toBe(true)
    expect(row?.cells.find(cell => cell.accountId === 'dan')?.reminders).toHaveLength(2)
    expect(row?.cells.find(cell => cell.accountId === 'carol')?.reminders).toHaveLength(1)
  })

  test('a plain approval reaches an author only when they asked for it; a change request always does', async () => {
    const w = await make(scenario)
    const channel = makeRecordingChannel()
    const { reportId } = await w.published()
    await w.call('alice', c => c.SetNotificationPreferences({ notifyOnApproval: true, whatsappConsent: false }))
    await pass(w, channel)
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    w.clock.advance(MINUTE)
    await pass(w, channel)
    expect(summary(channel.sent.slice(2))).toEqual(['approval_received:alice'])
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'request_changes' }))
    w.clock.advance(MINUTE)
    await pass(w, channel)
    expect(summary(channel.sent.slice(3))).toEqual(['review_received:alice'])
    expect((channel.sent[3] as OutgoingMessage).link).toBe(`/r/${reportId}/comments`)

    // The same without the preference: no approval notice.
    const other = await make(scenario)
    const second = makeRecordingChannel()
    const again = await other.published()
    await pass(other, second)
    await other.call('carol', c => c.SendReview({ commentIds: [], reportId: again.reportId, revision: 1, decision: 'approve' }))
    other.clock.advance(MINUTE)
    await pass(other, second)
    expect(summary(second.sent)).toEqual(['review_request:carol', 'review_request:dan'])
  })
})

describe('no duplicates', () => {
  test('two passes at once send each message once', async () => {
    const w = await make()
    const channel = makeRecordingChannel()
    await w.published()
    const results = await Promise.all([pass(w, channel), pass(w, channel), pass(w, channel)])
    expect(summary(channel.sent)).toEqual(['review_request:carol', 'review_request:dan'])
    expect(results.reduce((total, result) => total + result.sent, 0)).toBe(2)
    expect(new Set(channel.sent.map(message => message.idempotencyKey)).size).toBe(2)
  })

  test('a pass that stops halfway leaves its jobs to a later pass, once the lease has run out, and cannot overwrite it', async () => {
    const w = await make()
    const channel = makeRecordingChannel()
    await w.published()
    // NOTE: a pass that claimed the two requests and then stopped (the Worker
    // was cut off): it never delivered or finished them.
    const lost = await Effect.runPromise(
      w.repository.claimDueJobs({
        now: w.clock.now(),
        limit: 10,
        leaseMs: LEASE_MS,
        claimedBy: 'lost-pass',
      }) as unknown as Effect.Effect<ReadonlyArray<{ id: number; key: string }>>,
    )
    expect(lost).toHaveLength(2) // the two requests; the deadline job is not due yet
    // While the lease holds, a later pass finds nothing to do.
    w.clock.advance(MINUTE)
    expect((await pass(w, channel)).claimed).toBe(0)
    expect(channel.sent).toHaveLength(0)
    // After the lease: the jobs are taken over and sent once.
    w.clock.advance(2 * MINUTE)
    await pass(w, channel)
    expect(summary(channel.sent)).toEqual(['review_request:carol', 'review_request:dan'])
    // The stopped pass wakes up late and finishes: it changes nothing.
    await Effect.runPromise(
      w.repository.finishJobs({
        claimedBy: 'lost-pass',
        done: lost.map(job => job.id),
        skipped: [],
        now: w.clock.now(),
      }) as unknown as Effect.Effect<void>,
    )
    await pass(w, channel)
    expect(channel.sent).toHaveLength(2)
    expect(await inboxKinds(w, 'carol')).toEqual(['review_request'])
  })

  test('nothing is sent for a round that was replaced by a newer revision, and the reviewers are told of the replacement once', async () => {
    const w = await make()
    const channel = makeRecordingChannel()
    const { reportId } = await w.published()
    await pass(w, channel)
    expect(channel.sent).toHaveLength(2)
    // Revision 2 is published before any reminder is due.
    const { outcome } = await w.share('alice', reportId, {
      shareId: 'share-2',
      content: richContent('summary-text', 'A second version.'),
    })
    if (outcome.kind !== 'shared') throw new Error('not shared')
    w.clock.advance(HOUR)
    const deadline2 = w.clock.now() + 3 * DAY
    await w.publish('alice', reportId, outcome.draft.number, false, deadline2)
    await pass(w, channel)
    expect(summary(channel.sent.slice(2))).toEqual([
      'review_request:carol',
      'review_request:dan',
      'revision_replaced:carol',
      'revision_replaced:dan',
    ])
    expect(channel.sent.slice(2).every(message => message.link === `/r/${reportId}/rev/2`)).toBe(true)
    // The reminders of Revision 1 (due long before its deadline) never go out;
    // only those of Revision 2 do.
    w.clock.set(deadline2 - 48 * HOUR)
    await pass(w, channel)
    w.clock.set(deadline2 - 4 * HOUR)
    await pass(w, channel)
    const reminders = channel.sent.slice(6)
    expect(summary(reminders)).toEqual([
      'reminder_final:carol',
      'reminder_final:dan',
      'reminder_first:carol',
      'reminder_first:dan',
    ])
    expect(reminders.every(message => message.link === `/r/${reportId}/rev/2`)).toBe(true)
  })

  test('nothing is sent after the round was decided by its rule, or to a reviewer who has decided', async () => {
    const w = await make()
    const channel = makeRecordingChannel()
    const { reportId } = await w.published()
    await pass(w, channel)
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    // Decided by the rule: the reminders and the deadline job fail the recheck.
    w.clock.advance(10 * DAY)
    await pass(w, channel)
    expect(summary(channel.sent.slice(2))).toEqual(['round_decided:alice'])
    await pass(w, channel)
    expect(channel.sent).toHaveLength(3)
  })

  test('a deadline that was extended: the old reminders are not sent, the new ones are', async () => {
    const w = await make()
    const channel = makeRecordingChannel()
    const { reportId } = await w.published()
    await pass(w, channel)
    const old = w.clock.now() + 7 * DAY
    await w.call('alice', c =>
      c.ExtendDeadline({ reportId, revision: 1, deadline: { at: old + 5 * DAY, timeZone: 'Europe/Madrid' } }),
    )
    // The old first reminder time passes: it is not sent (it fails the recheck,
    // and the new one is later).
    w.clock.set(old - 48 * HOUR)
    await pass(w, channel)
    expect(channel.sent).toHaveLength(2)
    // The old deadline passes: the round is still open.
    w.clock.set(old + MINUTE)
    await pass(w, channel)
    expect(channel.sent).toHaveLength(2)
    expect((await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))).status).toBe('open')
    // The new first reminder.
    w.clock.set(old + 5 * DAY - 48 * HOUR)
    await pass(w, channel)
    expect(summary(channel.sent.slice(2))).toEqual(['reminder_first:carol', 'reminder_first:dan'])
  })
})

describe('retries', () => {
  test('a failed send is tried again after a back-off, then marked final after the last attempt', async () => {
    const w = await make()
    let failing = true
    const channel = makeRecordingChannel({
      fail: message =>
        failing && message.recipientId === 'carol'
          ? ({ _tag: 'Failed', retryable: true, reason: 'provider unavailable' } satisfies SendResult)
          : undefined,
    })
    await w.published()
    await pass(w, channel)
    expect(summary(channel.sent)).toEqual(['review_request:dan'])
    // Before the back-off (one minute) nothing is tried.
    w.clock.advance(30_000)
    await pass(w, channel)
    expect(channel.attempts.filter(message => message.recipientId === 'carol')).toHaveLength(1)
    // After it, and the channel works again: sent, as the second attempt.
    failing = false
    w.clock.advance(MINUTE)
    await pass(w, channel)
    const carol = channel.sent.find(message => message.recipientId === 'carol') as OutgoingMessage
    expect(carol.attempt).toBe(2)
    expect(await inboxKinds(w, 'carol')).toEqual(['review_request'])
  })

  test('after the last attempt the job is a final failure and is never claimed again', async () => {
    const w = await make()
    const channel = makeRecordingChannel({
      fail: message =>
        message.recipientId === 'carol'
          ? { _tag: 'Failed', retryable: true, reason: 'down' }
          : undefined,
    })
    await w.published()
    for (let attempt = 1; attempt <= MAX_ATTEMPTS + 2; attempt += 1) {
      await pass(w, channel)
      w.clock.advance(16 * MINUTE)
    }
    expect(channel.attempts.filter(message => message.recipientId === 'carol')).toHaveLength(MAX_ATTEMPTS)
    expect(await inboxKinds(w, 'carol')).toEqual([])
    expect(await inboxKinds(w, 'dan')).toEqual(['review_request'])
  })

  test('a channel that throws counts as a failure; one that says "not retryable" is final at once', async () => {
    const w = await make()
    const channel = makeRecordingChannel({
      fail: message => {
        if (message.recipientId === 'dan') {
          return { _tag: 'Failed', retryable: false, reason: 'number not allowed' }
        }
        throw new Error('boom')
      },
    })
    await w.published()
    await pass(w, channel)
    w.clock.advance(20 * MINUTE)
    await pass(w, channel)
    expect(channel.attempts.filter(message => message.recipientId === 'dan')).toHaveLength(1)
  })
})

describe('a pass that was killed is not a failed attempt', () => {
  const lose = async (w: World, times: number): Promise<void> => {
    for (let index = 0; index < times; index += 1) {
      await Effect.runPromise(
        w.repository.claimDueJobs({
          now: w.clock.now(),
          limit: 10,
          leaseMs: LEASE_MS,
          claimedBy: `lost-${index}`,
        }) as unknown as Effect.Effect<unknown>,
      )
      w.clock.advance(LEASE_MS + 1)
    }
  }

  test('takeovers of an expired lease do not use attempts: the job is still sent, as attempt 1, after more takeovers than MAX_ATTEMPTS', async () => {
    const w = await make(intakeOnSqlite)
    const channel = makeRecordingChannel()
    await w.published()
    await lose(w, MAX_ATTEMPTS + 3)
    await pass(w, channel)
    expect(summary(channel.sent)).toEqual(['review_request:carol', 'review_request:dan'])
    expect(channel.sent.every(message => message.attempt === 1)).toBe(true)
    expect(await inboxKinds(w, 'carol')).toEqual(['review_request'])
  })

  test('a real failure after takeovers still counts from one', async () => {
    const w = await make(intakeOnSqlite)
    const channel = makeRecordingChannel({
      fail: message =>
        message.recipientId === 'carol' ? { _tag: 'Failed', retryable: true, reason: 'down' } : undefined,
    })
    await w.published()
    await lose(w, 4)
    for (let index = 0; index < MAX_ATTEMPTS + 2; index += 1) {
      await pass(w, channel)
      w.clock.advance(16 * MINUTE)
    }
    expect(channel.attempts.filter(message => message.recipientId === 'carol').map(message => message.attempt)).toEqual(
      [1, 2, 3, 4, 5],
    )
  })

  test('a job taken over more than MAX_DEFERRALS times is failed with an error logged, not silently', async () => {
    const w = await make(intakeOnSqlite)
    const channel = makeRecordingChannel()
    await w.published()
    await lose(w, MAX_DEFERRALS + 2)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await pass(w, channel)
      expect(result.failed).toBe(2)
      expect(channel.sent).toHaveLength(0)
      expect(error).toHaveBeenCalled()
      expect(String(error.mock.calls[0]?.[0])).toMatch(/deferred \d+ times/)
      expect(String(error.mock.calls[0]?.[0])).not.toMatch(/REF-|Case about/)
    } finally {
      error.mockRestore()
    }
  })
})

describe('storage that fails is not the job\'s fault', () => {
  test('a failed read of the profiles leaves the approval notices pending; they are sent once it works, never skipped', async () => {
    const w = await make(intakeOnSqlite)
    const channel = makeRecordingChannel()
    const { reportId } = await w.published()
    await w.call('alice', c => c.SetNotificationPreferences({ notifyOnApproval: true, whatsappConsent: false }))
    await pass(w, channel)
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    w.clock.advance(MINUTE)
    const down = await passPatched(w, channel, { listProfiles: storageDown })
    expect(down.skipped).toBe(0)
    expect(down.deferred).toBe(1)
    expect(summary(channel.sent)).toEqual(['review_request:carol', 'review_request:dan'])
    w.clock.advance(2 * MINUTE)
    await pass(w, channel)
    expect(summary(channel.sent.slice(2))).toEqual(['approval_received:alice'])
    expect(await inboxKinds(w, 'alice')).toEqual(['approval_received'])
  })

  test('a report that cannot be read backs off without using attempts, however many times, then is sent as attempt 1', async () => {
    const w = await make(intakeOnSqlite)
    const channel = makeRecordingChannel()
    await w.published()
    for (let index = 0; index < MAX_ATTEMPTS + 3; index += 1) {
      const result = await passPatched(w, channel, { readReport: storageDown })
      expect(result.failed).toBe(0)
      w.clock.advance(16 * MINUTE)
    }
    expect(channel.sent).toHaveLength(0)
    await pass(w, channel)
    expect(summary(channel.sent)).toEqual(['review_request:carol', 'review_request:dan'])
    expect(channel.sent.every(message => message.attempt === 1)).toBe(true)
  })
})

describe('a decision the store keeps refusing', () => {
  // NOTE: the store's own guard refuses it for real (the batch runs and fails):
  // the number of reviews it expects is one too many.
  const refuse = (w: World) => ({
    decideRound: (input: { expectedReviews: number }) =>
      (w.repository.decideRound as (input: unknown) => Effect.Effect<unknown>)({
        ...input,
        expectedReviews: input.expectedReviews + 1,
      }),
  })

  test('the round is not reported as decided, the deadline job stays pending, and the next pass decides it', async () => {
    const w = await make(intakeOnSqlite)
    const channel = makeRecordingChannel()
    const { reportId } = await w.published()
    await pass(w, channel)
    w.clock.advance(10 * DAY)
    const refused = await passPatched(w, channel, refuse(w))
    expect(refused.decided).toBe(0)
    expect(refused.sent).toBe(0)
    expect(refused.released).toBeGreaterThan(0)
    expect(channel.sent.filter(message => message.kind === 'round_decided')).toHaveLength(0)
    const stored = await Effect.runPromise(w.repository.getRound(reportId, 1) as unknown as Effect.Effect<{ round: { state: string } }>)
    expect(stored.round.state).toBe('open')
    const later = await pass(w, channel)
    expect(later.decided).toBe(1)
    expect(summary(channel.sent.filter(message => message.kind === 'round_decided'))).toEqual(['round_decided:alice'])
  })

  test('the worst case of one report stays inside its reserve, and a pass over many such reports inside 50 queries', async () => {
    const w = await make(intakeOnSqlite)
    const channel = makeRecordingChannel()
    await w.call('alice', c => c.SetNotificationPreferences({ notifyOnApproval: true, whatsappConsent: false }))
    const reports: Array<string> = []
    for (let index = 0; index < 6; index += 1) reports.push((await w.published()).reportId)
    for (const reportId of reports) {
      await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    }
    w.clock.advance(10 * DAY)
    // One report, its decision always refused: claim + load + decide + profiles + finish.
    const one = w.queries()
    const first = await passPatched(w, channel, { ...refuse(w) }, { limit: 1, useQueries: true })
    expect(first.claimed).toBe(1)
    expect(w.queries() - one).toBeLessThanOrEqual(1 + RESERVE_REPORT + RESERVE_FINISH)
    const worstReport = w.queries() - one - 1 - RESERVE_FINISH
    expect(worstReport).toBeLessThanOrEqual(RESERVE_REPORT)
    // Many reports, all refused or all decided: never more than 50, never more than the reports per run.
    for (const patch of [refuse(w), {}]) {
      for (let round = 0; round < 8; round += 1) {
        const before = w.queries()
        const result = await passPatched(w, channel, patch, { useQueries: true })
        expect(w.queries() - before).toBeLessThanOrEqual(MAX_QUERIES)
        expect(result.claimed).toBeLessThanOrEqual(2 * PASS_LIMIT)
        if (result.claimed === 0) break
      }
    }
    expect(MAX_REPORTS_PER_RUN).toBe(1)
  })
})

describe('the pass inside the limits of Workers Free', () => {
  test('with many jobs due across many reports, no pass makes more than 50 queries and everything is sent in the end', async () => {
    const w = await make(intakeOnSqlite)
    const channel = makeRecordingChannel()
    const reports: Array<string> = []
    for (let index = 0; index < 8; index += 1) {
      reports.push((await w.published()).reportId)
    }
    // Everything is due: requests, both reminders (the deadline is at 7 days)
    // and the deadline jobs of all eight reports, three days past it.
    w.clock.advance(10 * DAY)
    const queriesPerPass: Array<number> = []
    let claimedTotal = 0
    for (let round = 0; round < 30; round += 1) {
      const before = w.queries()
      const result = await pass(w, channel, { useQueries: true })
      queriesPerPass.push(w.queries() - before)
      claimedTotal += result.claimed
      if (result.claimed === 0) break
    }
    expect(Math.max(...queriesPerPass)).toBeLessThanOrEqual(MAX_QUERIES)
    expect(claimedTotal).toBeGreaterThan(PASS_LIMIT)
    // Every report is decided by its deadline and its author is told once.
    for (const reportId of reports) {
      expect((await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))).status).toBe('decided')
    }
    expect(channel.sent.filter(message => message.kind === 'round_decided')).toHaveLength(8)
    // Reminders and requests of a round that was already past its deadline are not sent.
    expect(channel.sent.filter(message => message.kind !== 'round_decided')).toHaveLength(0)
  })

  test('a pass with the limit claims no more than the limit, and a report it has no room for waits for the next pass', async () => {
    const w = await make(intakeOnSqlite)
    const channel = makeRecordingChannel()
    for (let index = 0; index < 3; index += 1) await w.published()
    const first = await pass(w, channel, { limit: 4, useQueries: true })
    expect(first.claimed).toBeLessThanOrEqual(8)
    let guard = 0
    while (channel.sent.length < 6 && guard < 10) {
      await pass(w, channel, { limit: 4, useQueries: true })
      guard += 1
    }
    expect(channel.sent).toHaveLength(6)
    expect(new Set(channel.sent.map(message => message.idempotencyKey)).size).toBe(6)
  })
})

describe('the inbox never carries the case (D14, D17)', () => {
  test('no row or response has a case reference or title for any role, with a removed redacted reviewer and more than 100 rounds', async () => {
    const w = await make(intakeOnSqlite)
    const channel = makeRecordingChannel()
    const first = await w.published()
    // NOTE: dan is a redacted reviewer who is taken out of the first round.
    await w.call('alice', c => c.RemoveReviewer({ reportId: first.reportId, revision: 1, accountId: 'dan' }))
    for (let index = 0; index < 101; index += 1) await w.published()
    for (let guard = 0; guard < 250; guard += 1) {
      if ((await pass(w, channel)).claimed === 0) break
    }
    for (const who of ['alice', 'carol', 'dan'] as const) {
      let before: number | undefined
      let total = 0
      for (let page = 0; page < 40; page += 1) {
        const result = await w.call(who, c =>
          c.ListNotifications({ limit: 50, ...(before === undefined ? {} : { before }) }),
        )
        total += result.items.length
        const text = JSON.stringify(result)
        expect(text).not.toMatch(/REF-|Case about|caseReference|caseTitle/)
        if (result.next === undefined) break
        before = result.next
      }
      if (who !== 'alice') expect(total).toBeGreaterThan(100)
    }
  }, 120_000)
})

describe('the "Send on WhatsApp" link (D17)', () => {
  test('the number as digits only and exactly the generic text with the deadline in its own zone and the link', async () => {
    const w = await make()
    const { reportId } = await w.published()
    await Effect.runPromise(
      w.repository.putProfile(
        'carol',
        { phone: '+34600000001', whatsappConsent: true, whatsappConsentAt: 1, notifyOnApproval: false, active: true },
        1,
      ) as unknown as Effect.Effect<void>,
    )
    const link = await w.call('alice', c => c.GetWhatsAppLink({ reportId, revision: 1, accountId: 'carol' }))
    const text =
      'A report is waiting for your review in Quoroom, due 19 Nov, 10:00 Madrid time. http://localhost/'
    expect(link.number).toBe('34600000001')
    expect(link.text).toBe(text)
    expect(link.url).toBe(`https://wa.me/34600000001?text=${encodeURIComponent(text)}`)
    // The list that opens the buttons carries no number.
    const list = await w.call('alice', c => c.ListWhatsAppLinks({ reportId, revision: 1 }))
    expect(JSON.stringify(list)).not.toContain('34600000001')
    expect(list.find(entry => entry.accountId === 'carol')?.ready).toBe(true)
    expect(list.find(entry => entry.accountId === 'dan')?.ready).toBe(false)
  })
})
