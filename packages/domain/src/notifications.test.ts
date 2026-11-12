import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_NOTIFICATION_CONFIG,
  HOUR,
  INTAKE_TEMPLATE,
  MINUTE,
  SCHEDULED_KINDS,
  type FlowEvent,
  type NotificationConfig,
  type NotificationState,
  type Participant,
  type ReportEvent,
  type ReportFlow,
  type Template,
  applyEvent,
  desiredJobs,
  initialFlow,
  isJobNeeded,
  jobKey,
  notificationConfigInMinutes,
  notificationJobs,
  openRound,
  settle,
  standingDecisions,
} from './index'
import { eventsFromRun } from './testing/events'
import {
  AUTHOR_IDS,
  contextFor,
  flowTemplateArbitrary,
  runScript,
  scriptArbitrary,
} from './testing/reports'
import { PANEL_TEMPLATE } from './testing/templates'

const T0 = 1_000_000_000_000
const AUTHORS = [
  { accountId: 'a1', notifyOnApproval: false },
  { accountId: 'a2', notifyOnApproval: true },
]
const COMMITTEE: ReadonlyArray<Participant> = [
  { accountId: 'r1', roleId: 'committee' },
  { accountId: 'r2', roleId: 'committee' },
]

const must = (
  template: Template,
  flow: ReportFlow,
  now: number,
  event: FlowEvent,
): ReportFlow => {
  const result = applyEvent(
    { template, authors: ['a1', 'a2'], now },
    flow,
    event,
  )
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

// A report with Draft 1 and Revision 1 published at T0, due 72 hours later.
const published = (
  template: Template = INTAKE_TEMPLATE,
  people: ReadonlyArray<Participant> = COMMITTEE,
  span = 72 * HOUR,
) => {
  let flow = must(template, initialFlow, T0, { type: 'share_draft' })
  flow = must(template, flow, T0, {
    type: 'publish_revision',
    draft: 1,
    deadline: T0 + span,
    participants: people,
  })
  const events: ReadonlyArray<ReportEvent> = [
    { type: 'revision_published', revision: 1, at: T0 },
  ]
  return { template, flow, events }
}

const state = (
  parts: {
    template: Template
    flow: ReportFlow
    events: ReadonlyArray<ReportEvent>
  },
  existing: ReadonlyArray<string> = [],
): NotificationState => ({
  ...parts,
  authors: AUTHORS,
  existing,
})

const config = DEFAULT_NOTIFICATION_CONFIG
const kinds = (jobs: ReadonlyArray<{ kind: string }>): ReadonlyArray<string> =>
  jobs.map(j => j.kind)

describe('what is scheduled on publication (D12)', () => {
  test('a request for each reviewer, the two reminders, and the deadline job', () => {
    const jobs = notificationJobs(state(published()), T0, config)
    const scheduled = jobs.filter(j => SCHEDULED_KINDS.includes(j.kind))
    expect(scheduled.map(j => [j.kind, j.recipient, j.dueAt])).toEqual([
      ['review_request', 'r1', T0],
      ['review_request', 'r2', T0],
      ['reminder_first', 'r1', T0 + 24 * HOUR],
      ['reminder_first', 'r2', T0 + 24 * HOUR],
      ['reminder_final', 'r1', T0 + 68 * HOUR],
      ['reminder_final', 'r2', T0 + 68 * HOUR],
      ['deadline', null, T0 + 72 * HOUR],
    ])
    expect(jobs).toHaveLength(scheduled.length)
  })

  test('the first reminder is skipped when the deadline is closer than 48 hours', () => {
    const jobs = notificationJobs(
      state(published(INTAKE_TEMPLATE, COMMITTEE, 30 * HOUR)),
      T0,
      config,
    )
    expect(kinds(jobs.filter(j => j.recipient === 'r1'))).toEqual([
      'review_request',
      'reminder_final',
    ])
  })

  test('no reminder when the deadline is closer than the final offset', () => {
    const jobs = notificationJobs(
      state(published(INTAKE_TEMPLATE, COMMITTEE, 3 * HOUR)),
      T0,
      config,
    )
    expect(kinds(jobs.filter(j => j.recipient === 'r1'))).toEqual([
      'review_request',
    ])
  })

  test('the timings are configuration: minutes for a test environment', () => {
    const fast = notificationConfigInMinutes(2, 1)
    const jobs = notificationJobs(
      state(published(INTAKE_TEMPLATE, COMMITTEE, 5 * MINUTE)),
      T0,
      fast,
    )
    expect(
      jobs.filter(j => j.recipient === 'r1').map(j => [j.kind, j.dueAt - T0]),
    ).toEqual([
      ['review_request', 0],
      ['reminder_first', 3 * MINUTE],
      ['reminder_final', 4 * MINUTE],
    ])
  })

  test('a request delay moves the request, not the reminders', () => {
    const jobs = notificationJobs(state(published()), T0, {
      ...config,
      requestDelay: 5 * MINUTE,
    })
    expect(jobs.find(j => j.kind === 'review_request')?.dueAt).toBe(
      T0 + 5 * MINUTE,
    )
  })

  test('the deadline job has no recipient and keys include the deadline', () => {
    const jobs = notificationJobs(state(published()), T0, config)
    const deadline = jobs.find(j => j.kind === 'deadline')
    expect(deadline?.recipient).toBeNull()
    expect(deadline?.key).toBe(
      jobKey({
        revision: 1,
        recipient: null,
        kind: 'deadline',
        deadline: T0 + 72 * HOUR,
      }),
    )
  })

  test('a reviewer who cannot vote is asked but never reminded', () => {
    const panel: ReadonlyArray<Participant> = [
      { accountId: 'chair', roleId: 'chair' },
      { accountId: 'm1', roleId: 'members' },
      { accountId: 'm2', roleId: 'members' },
      { accountId: 'obs', roleId: 'observer' },
    ]
    const jobs = notificationJobs(
      state(published(PANEL_TEMPLATE, panel)),
      T0,
      config,
    )
    expect(kinds(jobs.filter(j => j.recipient === 'obs'))).toEqual([
      'review_request',
    ])
    expect(kinds(jobs.filter(j => j.recipient === 'chair'))).toEqual([
      'review_request',
      'reminder_first',
      'reminder_final',
    ])
  })
})

describe('who has decided is left alone', () => {
  const afterReview = (decision: 'approve' | 'request_changes' | 'comment') => {
    const base = published()
    const flow = must(base.template, base.flow, T0 + HOUR, {
      type: 'submit_review',
      reviewerId: 'r1',
      decision,
    })
    return {
      ...base,
      flow,
      events: [
        ...base.events,
        {
          type: 'review' as const,
          id: 'rv1',
          reviewerId: 'r1',
          revision: 1,
          decision,
          hasComments: false,
          at: T0 + HOUR,
        },
      ],
    }
  }

  test.each(['approve', 'request_changes'] as const)(
    'after %s the reviewer gets no request or reminder',
    decision => {
      const jobs = desiredJobs(
        state(afterReview(decision)),
        T0 + 2 * HOUR,
        config,
      )
      expect(
        jobs.filter(
          j => j.recipient === 'r1' && SCHEDULED_KINDS.includes(j.kind),
        ),
      ).toEqual([])
      expect(
        jobs.filter(j => j.recipient === 'r2' && j.kind === 'reminder_final'),
      ).toHaveLength(1)
    },
  )

  test('a comment-only review is not a decision: the reminders stay', () => {
    const jobs = desiredJobs(
      state(afterReview('comment')),
      T0 + 2 * HOUR,
      config,
    )
    expect(kinds(jobs.filter(j => j.recipient === 'r1'))).toContain(
      'reminder_final',
    )
  })

  test('a job written earlier fails the recheck once its reviewer decided', () => {
    const before = published()
    const written = notificationJobs(state(before), T0, config)
    const reminder = written.find(
      j => j.kind === 'reminder_first' && j.recipient === 'r1',
    )
    if (reminder === undefined) throw new Error('missing reminder')
    expect(isJobNeeded(reminder, state(before), T0 + HOUR, config)).toBe(true)
    expect(
      isJobNeeded(
        reminder,
        state(afterReview('approve')),
        T0 + 2 * HOUR,
        config,
      ),
    ).toBe(false)
  })
})

describe('no reminder at or after the deadline', () => {
  test('nothing but the deadline job once now has reached the deadline', () => {
    const parts = published()
    const deadline = T0 + 72 * HOUR
    for (const now of [deadline, deadline + 1, deadline + HOUR]) {
      const jobs = desiredJobs(state(parts), now, config)
      expect(kinds(jobs)).toEqual(['deadline'])
    }
  })

  test('a reminder is never due at or after the deadline, whatever the config', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -5, max: 100 }),
        fc.integer({ min: -5, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (first, final, span) => {
          const cfg: NotificationConfig = {
            requestDelay: 0,
            firstReminderBefore: first,
            finalReminderBefore: final,
          }
          const parts = published(INTAKE_TEMPLATE, COMMITTEE, span)
          const jobs = desiredJobs(state(parts), T0, cfg)
          for (const j of jobs) {
            if (j.kind === 'reminder_first' || j.kind === 'reminder_final') {
              expect(j.dueAt).toBeLessThan(T0 + span)
              expect(j.dueAt).toBeGreaterThan(T0)
            }
          }
        },
      ),
    )
  })
})

describe('a decided or superseded round schedules nothing', () => {
  test('a round decided by its rule', () => {
    const base = published()
    let flow = base.flow
    const events = [...base.events]
    for (const id of ['r1', 'r2']) {
      flow = must(base.template, flow, T0 + HOUR, {
        type: 'submit_review',
        reviewerId: id,
        decision: 'approve',
      })
      events.push({
        type: 'review',
        id: `rv-${id}`,
        reviewerId: id,
        revision: 1,
        decision: 'approve',
        hasComments: false,
        at: T0 + HOUR,
      })
    }
    expect(flow.rounds[0]?.status).toBe('decided')
    const jobs = desiredJobs(
      state({ template: base.template, flow, events }),
      T0 + 2 * HOUR,
      config,
    )
    expect(jobs.filter(j => SCHEDULED_KINDS.includes(j.kind))).toEqual([])
    expect(
      jobs.filter(j => j.kind === 'round_decided').map(j => j.recipient),
    ).toEqual(['a1', 'a2'])
  })

  test('a round decided by its deadline, told at the deadline', () => {
    const base = published()
    const now = T0 + 73 * HOUR
    const flow = settle(contextFor(base.template, now, ['a1', 'a2']), base.flow)
    expect(flow.rounds[0]?.decidedBy).toBe('deadline')
    const jobs = desiredJobs(state({ ...base, flow }), now, config)
    expect(jobs.map(j => [j.kind, j.recipient, j.dueAt])).toEqual([
      ['round_decided', 'a1', T0 + 72 * HOUR],
      ['round_decided', 'a2', T0 + 72 * HOUR],
    ])
  })

  test('a superseded round: its jobs fail the recheck, the new one is scheduled', () => {
    const base = published()
    const written = notificationJobs(state(base), T0, config)
    let flow = must(base.template, base.flow, T0 + HOUR, {
      type: 'share_draft',
    })
    flow = must(base.template, flow, T0 + HOUR, {
      type: 'publish_revision',
      draft: 2,
      deadline: T0 + 60 * HOUR,
      participants: COMMITTEE,
    })
    const events: ReadonlyArray<ReportEvent> = [
      ...base.events,
      { type: 'revision_published', revision: 2, at: T0 + HOUR },
    ]
    const next = state(
      { template: base.template, flow, events },
      written.map(j => j.key),
    )
    for (const old of written) {
      expect(isJobNeeded(old, next, T0 + 2 * HOUR, config)).toBe(false)
    }
    const jobs = notificationJobs(next, T0 + 2 * HOUR, config)
    expect(jobs.every(j => j.revision === 2)).toBe(true)
    expect(
      jobs.filter(j => j.kind === 'revision_replaced').map(j => j.recipient),
    ).toEqual(['r1', 'r2'])
  })

  test('a new revision tells only those of the old round who are in the new one', () => {
    const base = published()
    let flow = must(base.template, base.flow, T0 + HOUR, {
      type: 'share_draft',
    })
    flow = must(base.template, flow, T0 + HOUR, {
      type: 'publish_revision',
      draft: 2,
      deadline: T0 + 60 * HOUR,
      participants: [
        { accountId: 'r2', roleId: 'committee' },
        { accountId: 'r3', roleId: 'committee' },
      ],
    })
    const events: ReadonlyArray<ReportEvent> = [
      ...base.events,
      { type: 'revision_published', revision: 2, at: T0 + HOUR },
    ]
    const jobs = desiredJobs(
      state({ template: base.template, flow, events }),
      T0 + HOUR,
      config,
    )
    expect(
      jobs.filter(j => j.kind === 'revision_replaced').map(j => j.recipient),
    ).toEqual(['r2'])
    expect(
      jobs.filter(j => j.kind === 'review_request').map(j => j.recipient),
    ).toEqual(['r2', 'r3'])
  })
})

describe('extending a deadline', () => {
  test('writes new reminder and deadline jobs and the old ones fail the recheck', () => {
    const base = published()
    const written = notificationJobs(state(base), T0, config)
    const flow = must(base.template, base.flow, T0 + HOUR, {
      type: 'extend_deadline',
      deadline: T0 + 100 * HOUR,
    })
    const next = state(
      { ...base, flow },
      written.map(j => j.key),
    )
    const fresh = notificationJobs(next, T0 + HOUR, config)
    expect([...kinds(fresh)].sort()).toEqual([
      'deadline',
      'reminder_final',
      'reminder_final',
      'reminder_first',
      'reminder_first',
    ])
    const old = written.filter(
      j => j.kind === 'deadline' || j.kind.startsWith('reminder'),
    )
    for (const j of old) {
      expect(isJobNeeded(j, next, T0 + HOUR, config)).toBe(false)
    }
    // The request does not depend on the deadline and stays.
    const request = written.find(j => j.kind === 'review_request')
    expect(request && isJobNeeded(request, next, T0 + HOUR, config)).toBe(true)
  })
})

describe('what the authors are told (D19)', () => {
  const withReview = (
    decision: 'approve' | 'request_changes' | 'comment',
    hasComments: boolean,
  ) => {
    const base = published()
    return state({
      ...base,
      events: [
        ...base.events,
        {
          type: 'review',
          id: 'rv1',
          reviewerId: 'r1',
          revision: 1,
          decision,
          hasComments,
          at: T0 + HOUR,
        },
      ],
    })
  }
  const authorJobs = (s: NotificationState) =>
    desiredJobs(s, T0 + 2 * HOUR, config).filter(
      j => j.kind === 'review_received' || j.kind === 'approval_received',
    )

  test('a change request is always reported to every author', () => {
    expect(
      authorJobs(withReview('request_changes', false)).map(j => [
        j.kind,
        j.recipient,
        j.dueAt,
      ]),
    ).toEqual([
      ['review_received', 'a1', T0 + HOUR],
      ['review_received', 'a2', T0 + HOUR],
    ])
  })

  test('so is a review with comments, an approval with comments included', () => {
    expect(authorJobs(withReview('comment', true))).toHaveLength(2)
    expect(kinds(authorJobs(withReview('approve', true)))).toEqual([
      'review_received',
      'review_received',
    ])
  })

  test('a plain approval only reaches the author who asked for it', () => {
    expect(
      authorJobs(withReview('approve', false)).map(j => [j.kind, j.recipient]),
    ).toEqual([['approval_received', 'a2']])
  })

  test('a comment-only review without comments tells nobody', () => {
    expect(authorJobs(withReview('comment', false))).toEqual([])
  })

  test('two reviews by the same reviewer in a round are two notifications', () => {
    const base = published()
    const make = (id: string, at: number): ReportEvent => ({
      type: 'review',
      id,
      reviewerId: 'r1',
      revision: 1,
      decision: 'request_changes',
      hasComments: true,
      at,
    })
    const jobs = desiredJobs(
      state({
        ...base,
        events: [...base.events, make('x', T0 + 1), make('y', T0 + 2)],
      }),
      T0 + 3,
      config,
    ).filter(j => j.kind === 'review_received' && j.recipient === 'a1')
    expect(jobs).toHaveLength(2)
  })

  test('the outcome of a decided round is reported once to each author', () => {
    const base = published()
    const flow = settle(
      contextFor(base.template, T0 + 80 * HOUR, ['a1', 'a2']),
      base.flow,
    )
    const decided = state({ ...base, flow })
    const first = notificationJobs(decided, T0 + 80 * HOUR, config)
    const again = notificationJobs(
      { ...decided, existing: first.map(j => j.key) },
      T0 + 81 * HOUR,
      config,
    )
    expect(first).toHaveLength(2)
    expect(again).toEqual([])
  })
})

describe('deduplication (D12)', () => {
  test('running the rules twice yields no new jobs', () => {
    const parts = published()
    const first = notificationJobs(state(parts), T0, config)
    expect(first.length).toBeGreaterThan(0)
    const second = notificationJobs(
      state(
        parts,
        first.map(j => j.key),
      ),
      T0,
      config,
    )
    expect(second).toEqual([])
  })

  test('keys are unique and follow (round, recipient, kind, deadline)', () => {
    const jobs = desiredJobs(state(published()), T0, config)
    expect(new Set(jobs.map(j => j.key)).size).toBe(jobs.length)
    for (const j of jobs) {
      expect(JSON.parse(j.key).slice(0, 4)).toEqual([
        j.revision,
        j.recipient,
        j.kind,
        j.deadline,
      ])
    }
  })
})

// ---- Properties over generated templates and runs ------------------------------------

const runArbitrary = flowTemplateArbitrary.chain(template =>
  scriptArbitrary(template).map(script => ({ template, script })),
)

const authorsFor = AUTHOR_IDS.map((accountId, index) => ({
  accountId,
  notifyOnApproval: index === 0,
}))

const abstractConfig: NotificationConfig = {
  requestDelay: 0,
  firstReminderBefore: 4,
  finalReminderBefore: 1,
}

describe('generated runs', () => {
  const property = (
    check: (s: NotificationState, now: number, template: Template) => void,
  ) =>
    fc.assert(
      fc.property(
        runArbitrary,
        fc.integer({ min: 0, max: 8 }),
        fc.boolean(),
        ({ template, script }, extra, settled) => {
          const run = runScript(template, script)
          const last = run.steps[run.steps.length - 1]?.now ?? 1000
          const now = last + extra
          const flow = settled
            ? settle(contextFor(template, now), run.final)
            : run.final
          check(
            {
              template,
              flow,
              authors: authorsFor,
              events: eventsFromRun(run),
              existing: [],
            },
            now,
            template,
          )
        },
      ),
      { numRuns: 300 },
    )

  test('nobody who has decided is reminded, and nothing is scheduled for a superseded or decided round', () => {
    property((s, now) => {
      const open = openRound(s.flow)
      const jobs = desiredJobs(s, now, abstractConfig)
      for (const j of jobs.filter(job => SCHEDULED_KINDS.includes(job.kind))) {
        expect(open).toBeDefined()
        expect(j.revision).toBe(open?.revision)
        expect(open?.status).toBe('open')
        if (j.recipient !== null && open !== undefined) {
          const decided = standingDecisions(open.reviews, open.revision)
          expect(decided.has(j.recipient)).toBe(false)
          expect(open.participants.map(p => p.accountId)).toContain(j.recipient)
        }
      }
      for (const j of jobs) {
        if (j.kind.startsWith('reminder')) {
          const round = s.flow.rounds.find(r => r.revision === j.revision)
          expect(round?.status).toBe('open')
          expect(now).toBeLessThan(round?.deadline ?? 0)
          expect(j.dueAt).toBeLessThan(round?.deadline ?? 0)
        }
      }
    })
  })

  test('reminders go only to voting roles', () => {
    property((s, now, template) => {
      for (const j of desiredJobs(s, now, abstractConfig)) {
        if (!j.kind.startsWith('reminder')) continue
        const round = s.flow.rounds.find(r => r.revision === j.revision)
        const role = round?.participants.find(p => p.accountId === j.recipient)
        const permissions =
          template.roles.find(r => r.id === role?.roleId)?.permissions ?? []
        expect(permissions).toContain('vote')
      }
    })
  })

  test('running the rules twice gives no new jobs', () => {
    property((s, now) => {
      const first = notificationJobs(s, now, abstractConfig)
      const second = notificationJobs(
        { ...s, existing: first.map(j => j.key) },
        now,
        abstractConfig,
      )
      expect(second).toEqual([])
      const keys = desiredJobs(s, now, abstractConfig).map(j => j.key)
      expect(new Set(keys).size).toBe(keys.length)
    })
  })

  test('a job is needed exactly when the rules still produce it', () => {
    property((s, now) => {
      for (const j of desiredJobs(s, now, abstractConfig)) {
        expect(isJobNeeded(j, s, now, abstractConfig)).toBe(true)
      }
    })
  })
})
