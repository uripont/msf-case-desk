import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  HOUR,
  INTAKE_TEMPLATE,
  type FlowEvent,
  type Participant,
  type ReportEvent,
  type ReportFlow,
  type Template,
  applyEvent,
  buildGrid,
  initialFlow,
  settle,
  standingDecisions,
  tallyRound,
} from './index'
import { eventsFromRun } from './testing/events'
import {
  AUTHOR_IDS,
  contextFor,
  flowTemplateArbitrary,
  runScript,
  scriptArbitrary,
} from './testing/reports'

const T0 = 1_000_000_000_000
const COMMITTEE: ReadonlyArray<Participant> = [
  { accountId: 'r1', roleId: 'committee' },
  { accountId: 'r2', roleId: 'committee' },
  { accountId: 'r3', roleId: 'committee' },
]

const must = (
  flow: ReportFlow,
  now: number,
  event: FlowEvent,
  template: Template = INTAKE_TEMPLATE,
): ReportFlow => {
  const result = applyEvent(
    { template, authors: ['a1', 'a2'], now },
    flow,
    event,
  )
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return result.success
}

describe('draft rows', () => {
  test('one row per draft with the author who shared it and who read it', () => {
    let flow = initialFlow
    flow = must(flow, T0, { type: 'share_draft' })
    flow = must(flow, T0, { type: 'share_draft' })
    const events: ReadonlyArray<ReportEvent> = [
      { type: 'draft_shared', draft: 1, accountId: 'a1', at: T0 },
      { type: 'draft_shared', draft: 2, accountId: 'a2', at: T0 + 5 },
      { type: 'draft_read', draft: 1, accountId: 'a2', at: T0 + 9 },
      { type: 'draft_read', draft: 1, accountId: 'a2', at: T0 + 7 },
    ]
    const grid = buildGrid({
      template: INTAKE_TEMPLATE,
      flow,
      authors: ['a1', 'a2'],
      events,
    })
    expect(grid.drafts.map(d => d.label)).toEqual([
      'Draft 0',
      'Draft 1',
      'Draft 2',
    ])
    expect(grid.drafts[0]?.sharedBy).toBeUndefined()
    expect(grid.drafts[1]?.cells).toEqual([
      { accountId: 'a1', shared: { at: T0 }, read: undefined },
      { accountId: 'a2', shared: undefined, read: { at: T0 + 7 } },
    ])
    expect(grid.drafts[2]?.sharedAt).toBe(T0 + 5)
    expect(grid.drafts[2]?.cells[1]?.shared).toEqual({ at: T0 + 5 })
  })
})

describe('revision rows', () => {
  // Revision 1 to r1, r2, r3; r1 asks for changes, then Revision 2 replaces it.
  const scenario = () => {
    let flow = must(initialFlow, T0, { type: 'share_draft' })
    flow = must(flow, T0, {
      type: 'publish_revision',
      draft: 1,
      deadline: T0 + 72 * HOUR,
      participants: COMMITTEE,
    })
    flow = must(flow, T0 + HOUR, {
      type: 'submit_review',
      reviewerId: 'r1',
      decision: 'request_changes',
    })
    flow = must(flow, T0 + 2 * HOUR, {
      type: 'submit_review',
      reviewerId: 'r2',
      decision: 'approve',
    })
    flow = must(flow, T0 + 3 * HOUR, {
      type: 'remove_reviewer',
      accountId: 'r3',
    })
    flow = must(flow, T0 + 4 * HOUR, { type: 'share_draft' })
    flow = must(flow, T0 + 4 * HOUR, {
      type: 'publish_revision',
      draft: 2,
      deadline: T0 + 80 * HOUR,
      participants: COMMITTEE.slice(0, 2),
    })
    const events: ReadonlyArray<ReportEvent> = [
      { type: 'revision_published', revision: 1, at: T0 },
      { type: 'notified', revision: 1, accountId: 'r1', at: T0 },
      { type: 'notified', revision: 1, accountId: 'r2', at: T0 },
      { type: 'read', revision: 1, accountId: 'r1', at: T0 + 30 * 60_000 },
      {
        type: 'whatsapp_opened',
        revision: 1,
        accountId: 'r1',
        at: T0 + 60_000,
      },
      {
        type: 'reminded',
        revision: 1,
        accountId: 'r2',
        kind: 'reminder_final',
        at: T0 + 60 * HOUR,
      },
      {
        type: 'reminded',
        revision: 1,
        accountId: 'r2',
        kind: 'reminder_first',
        at: T0 + 24 * HOUR,
      },
      {
        type: 'review',
        id: 'x1',
        reviewerId: 'r1',
        revision: 1,
        decision: 'comment',
        hasComments: true,
        at: T0 + HOUR / 2,
      },
      {
        type: 'review',
        id: 'x2',
        reviewerId: 'r1',
        revision: 1,
        decision: 'request_changes',
        hasComments: true,
        at: T0 + HOUR,
      },
      {
        type: 'review',
        id: 'x3',
        reviewerId: 'r2',
        revision: 1,
        decision: 'approve',
        hasComments: false,
        at: T0 + 2 * HOUR,
      },
      { type: 'revision_published', revision: 2, at: T0 + 4 * HOUR },
    ]
    return buildGrid({
      template: INTAKE_TEMPLATE,
      flow,
      authors: ['a1', 'a2'],
      events,
    })
  }

  test('every fact has its time, and unknown facts are absent', () => {
    const [one] = scenario().revisions
    if (one === undefined) throw new Error('no row')
    const r1 = one.cells.find(c => c.accountId === 'r1')
    const r2 = one.cells.find(c => c.accountId === 'r2')
    expect(r1?.sent).toEqual({ at: T0 })
    expect(r1?.read).toEqual({ at: T0 + 30 * 60_000 })
    expect(r1?.whatsappOpened).toEqual({ at: T0 + 60_000 })
    expect(r2?.read).toBeUndefined()
    expect(r2?.whatsappOpened).toBeUndefined()
    expect(r1?.decision).toEqual({ decision: 'request_changes', at: T0 + HOUR })
    expect(r2?.decision).toEqual({ decision: 'approve', at: T0 + 2 * HOUR })
    expect(r1?.reviews.map(r => [r.id, r.standing])).toEqual([
      ['x1', false],
      ['x2', true],
    ])
    expect(r2?.reminders).toEqual([
      { kind: 'reminder_first', at: T0 + 24 * HOUR },
      { kind: 'reminder_final', at: T0 + 60 * HOUR },
    ])
  })

  test('a removed reviewer keeps a cell, marked removed', () => {
    const [one] = scenario().revisions
    const r3 = one?.cells.find(c => c.accountId === 'r3')
    expect(r3?.removed).toBe(true)
    expect(one?.cells.map(c => c.accountId)).toEqual(['r1', 'r2', 'r3'])
    expect(r3?.decision).toBeUndefined()
  })

  test('the round: deadline, status, replaced by, rule status per role', () => {
    const grid = scenario()
    const [one, two] = grid.revisions
    expect(one).toMatchObject({
      label: 'Revision 1',
      draft: 1,
      publishedAt: T0,
      deadline: T0 + 72 * HOUR,
      status: 'superseded',
      replacedBy: 2,
      decidedBy: undefined,
      decidedAt: undefined,
    })
    expect(one?.rule.met).toBe(false)
    expect(two).toMatchObject({
      status: 'open',
      replacedBy: undefined,
      publishedAt: T0 + 4 * HOUR,
    })
    expect(two?.cells.every(c => c.decision === undefined)).toBe(true)
  })

  test('decided by rule: the time of the last approval; by deadline: the deadline', () => {
    let flow = must(initialFlow, T0, { type: 'share_draft' })
    flow = must(flow, T0, {
      type: 'publish_revision',
      draft: 1,
      deadline: T0 + 72 * HOUR,
      participants: COMMITTEE,
    })
    const approvals: Array<ReportEvent> = []
    for (const [index, id] of ['r1', 'r2', 'r3'].entries()) {
      flow = must(flow, T0 + (index + 1) * HOUR, {
        type: 'submit_review',
        reviewerId: id,
        decision: 'approve',
      })
      approvals.push({
        type: 'review',
        id: `a-${id}`,
        reviewerId: id,
        revision: 1,
        decision: 'approve',
        hasComments: false,
        at: T0 + (index + 1) * HOUR,
      })
    }
    const byRule = buildGrid({
      template: INTAKE_TEMPLATE,
      flow,
      authors: ['a1'],
      events: approvals,
    }).revisions[0]
    expect(byRule).toMatchObject({
      status: 'decided',
      decidedBy: 'rule_met',
      decidedAt: T0 + 3 * HOUR,
    })
    expect(byRule?.rule.met).toBe(true)

    let late = must(initialFlow, T0, { type: 'share_draft' })
    late = must(late, T0, {
      type: 'publish_revision',
      draft: 1,
      deadline: T0 + 72 * HOUR,
      participants: COMMITTEE,
    })
    late = settle(contextFor(INTAKE_TEMPLATE, T0 + 100 * HOUR, ['a1']), late)
    const byDeadline = buildGrid({
      template: INTAKE_TEMPLATE,
      flow: late,
      authors: ['a1'],
      events: [],
    }).revisions[0]
    expect(byDeadline).toMatchObject({
      decidedBy: 'deadline',
      decidedAt: T0 + 72 * HOUR,
    })
    const logged = buildGrid({
      template: INTAKE_TEMPLATE,
      flow: late,
      authors: ['a1'],
      events: [
        {
          type: 'round_decided',
          revision: 1,
          decidedBy: 'deadline',
          at: T0 + 73 * HOUR,
        },
      ],
    }).revisions[0]
    expect(logged?.decidedAt).toBe(T0 + 73 * HOUR)
  })
})

describe('generated runs', () => {
  test('the grid agrees with the flow: cells, standing decisions, rule status', () => {
    fc.assert(
      fc.property(
        flowTemplateArbitrary.chain(template =>
          scriptArbitrary(template).map(script => ({ template, script })),
        ),
        ({ template, script }) => {
          const run = runScript(template, script)
          const grid = buildGrid({
            template,
            flow: run.final,
            authors: AUTHOR_IDS,
            events: eventsFromRun(run),
          })
          expect(grid.drafts).toHaveLength(run.final.draftCount + 1)
          expect(grid.revisions).toHaveLength(run.final.rounds.length)
          grid.revisions.forEach((row, index) => {
            const round = run.final.rounds[index]
            if (round === undefined) throw new Error('missing round')
            expect(row.cells.map(c => c.accountId)).toEqual([
              ...round.participants.map(p => p.accountId),
              ...round.removed.map(p => p.accountId),
            ])
            const standing = standingDecisions(round.reviews, round.revision)
            for (const cell of row.cells) {
              expect(cell.decision?.decision).toBe(standing.get(cell.accountId))
              for (const review of cell.reviews) {
                expect(Number.isFinite(review.at)).toBe(true)
              }
            }
            expect(row.rule).toEqual(tallyRound(template, round))
            expect(row.status).toBe(round.status)
            expect(row.decidedAt === undefined).toBe(round.status !== 'decided')
          })
        },
      ),
      { numRuns: 200 },
    )
  })
})
