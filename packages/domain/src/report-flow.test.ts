import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  ALLOWED_EVENTS,
  EVENT_KINDS,
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
  REPORT_STATES,
  TRANSITIONS,
  type EventKind,
  type FlowEvent,
  type Participant,
  type ReportContent,
  type ReportFlow,
  type ReportState,
  type Template,
  applyEvent,
  checkClosingConclusion,
  checkClosingDraft,
  checkSave,
  emptyContent,
  initialFlow,
  latestRound,
  nextDraftNumber,
  nextRevisionNumber,
  openRound,
  revisionLabel,
  revisionTitle,
  draftLabel,
  versionSlug,
  settle,
  tallyRound,
  templateNodes,
} from './index'
import {
  AUTHOR_IDS,
  flowTemplateArbitrary,
  runScript,
  satisfiableParticipants,
  scriptArbitrary,
} from './testing/reports'
import { PANEL_TEMPLATE } from './testing/templates'

// ---- An independent copy of D18 ---------------------------------------------

const D18_ALLOWED: Readonly<Record<ReportState, ReadonlyArray<EventKind>>> = {
  drafting: ['share_draft', 'publish_revision'],
  in_review: [
    'share_draft',
    'publish_revision',
    'submit_review',
    'extend_deadline',
    'remove_reviewer',
  ],
  decided: ['share_draft', 'publish_revision', 'start_conclusion', 'archive'],
  concluding: [
    'share_draft',
    'publish_closing_revision',
    'submit_review',
    'extend_deadline',
    'remove_reviewer',
  ],
  archived: [],
}

// Every change of state a report may go through, including the two-step
// "rule met, then archived" of a template without a conclusion.
const D18_PAIRS: ReadonlyArray<readonly [ReportState, ReportState]> = [
  ['drafting', 'in_review'],
  ['in_review', 'in_review'],
  ['in_review', 'decided'],
  ['in_review', 'archived'],
  ['decided', 'in_review'],
  ['decided', 'archived'],
  ['decided', 'concluding'],
  ['concluding', 'concluding'],
  ['concluding', 'archived'],
]
const pairAllowed = (from: ReportState, to: ReportState): boolean =>
  from === to || D18_PAIRS.some(([a, b]) => a === from && b === to)

// ---- Helpers ----------------------------------------------------------------

const people = (...ids: ReadonlyArray<string>): ReadonlyArray<Participant> =>
  ids.map(id => ({ accountId: id, roleId: 'committee' }))

const ctx = (template: Template, now: number) => ({
  template,
  authors: AUTHOR_IDS,
  now,
})

const code = (result: Result.Result<ReportFlow, { code: string }>) =>
  Result.isFailure(result) ? result.failure.code : 'ok'

const run = (
  template: Template,
  start: ReportFlow,
  now: number,
  event: FlowEvent,
): ReportFlow => {
  const result = applyEvent(ctx(template, now), start, event)
  if (Result.isFailure(result)) {
    throw new Error(`${event.type} refused: ${JSON.stringify(result.failure)}`)
  }
  return result.success
}

const approve = (reviewerId: string, revision = 1): FlowEvent => ({
  type: 'submit_review',
  revision,
  reviewerId,
  decision: 'approve',
})

const publish = (deadline: number, who = people('r1', 'r2')): FlowEvent => ({
  type: 'publish_revision',
  draft: 1,
  deadline,
  participants: who,
})

const closing = (deadline: number, who = people('r1', 'r2')): FlowEvent => ({
  type: 'publish_closing_revision',
  draft: 1,
  deadline,
  participants: who,
})

const share: FlowEvent = { type: 'share_draft' }

// A report of the given template in each of the five states, by the book.
const inState = (
  template: Template,
  state: ReportState,
): ReportFlow | undefined => {
  const withConclusion = template.conclusion !== undefined
  const shared = run(template, initialFlow, 1, share)
  if (state === 'drafting') return initialFlow
  const reviewing = run(template, shared, 2, publish(100))
  if (state === 'in_review') return reviewing
  const approved = run(
    template,
    run(template, reviewing, 3, approve('r1')),
    4,
    approve('r2'),
  )
  if (state === 'archived') return withConclusion ? undefined : approved
  if (state === 'decided') return withConclusion ? approved : undefined
  if (!withConclusion) return undefined
  return run(template, approved, 5, { type: 'start_conclusion' })
}

const eventsOfEveryKind = (_flow: ReportFlow): ReadonlyArray<FlowEvent> => [
  share,
  publish(500),
  closing(500),
  approve('r1'),
  { type: 'extend_deadline', deadline: 900 },
  { type: 'remove_reviewer', accountId: 'r1' },
  { type: 'start_conclusion' },
  { type: 'archive' },
]

// ---- The table --------------------------------------------------------------

describe('D18 table', () => {
  test('the code lists exactly the events D18 allows in each state', () => {
    for (const state of REPORT_STATES) {
      expect([...ALLOWED_EVENTS[state]].sort()).toEqual(
        [...D18_ALLOWED[state]].sort(),
      )
    }
  })

  test('the transition rows are exactly the D18 changes of state', () => {
    const rows = TRANSITIONS.map(t => `${t.from}>${t.to}`)
    for (const row of rows) {
      const [from, to] = row.split('>') as [ReportState, ReportState]
      expect(pairAllowed(from, to)).toBe(true)
    }
    // Each D18 change except the composed one has a row.
    for (const [from, to] of D18_PAIRS.filter(
      ([a, b]) => !(a === 'in_review' && b === 'archived'),
    )) {
      expect(rows).toContain(`${from}>${to}`)
    }
  })

  test('every event outside the table fails, in every state, and changes nothing', () => {
    for (const template of [INTAKE_TEMPLATE, INVESTIGATION_TEMPLATE]) {
      for (const state of REPORT_STATES) {
        const flow = inState(template, state)
        if (flow === undefined) continue
        expect(flow.state).toBe(state)
        for (const event of eventsOfEveryKind(flow)) {
          const result = applyEvent(ctx(template, 10), flow, event)
          if (D18_ALLOWED[state].includes(event.type)) {
            expect(code(result)).not.toBe('not_allowed_in_state')
          } else {
            expect(code(result)).toBe('not_allowed_in_state')
          }
        }
      }
    }
  })

  test('all five states are reached by the by-the-book paths', () => {
    expect(inState(INTAKE_TEMPLATE, 'drafting')?.state).toBe('drafting')
    expect(inState(INTAKE_TEMPLATE, 'in_review')?.state).toBe('in_review')
    expect(inState(INTAKE_TEMPLATE, 'decided')?.state).toBe('decided')
    expect(inState(INTAKE_TEMPLATE, 'concluding')?.state).toBe('concluding')
    expect(inState(INVESTIGATION_TEMPLATE, 'archived')?.state).toBe('archived')
  })

  test('a review on a decided round fails', () => {
    const decided = inState(INTAKE_TEMPLATE, 'decided')!
    expect(decided.rounds[0]?.status).toBe('decided')
    expect(
      code(applyEvent(ctx(INTAKE_TEMPLATE, 10), decided, approve('r1'))),
    ).toBe('not_allowed_in_state')
  })

  test('a normal revision while concluding fails, a closing one is fine', () => {
    const concluding = inState(INTAKE_TEMPLATE, 'concluding')!
    expect(
      code(applyEvent(ctx(INTAKE_TEMPLATE, 10), concluding, publish(500))),
    ).toBe('not_allowed_in_state')
    expect(
      code(applyEvent(ctx(INTAKE_TEMPLATE, 10), concluding, closing(500))),
    ).toBe('ok')
  })

  test('a closing revision outside concluding fails', () => {
    for (const state of ['drafting', 'in_review', 'decided'] as const) {
      const flow = inState(INTAKE_TEMPLATE, state)!
      expect(
        code(applyEvent(ctx(INTAKE_TEMPLATE, 10), flow, closing(500))),
      ).toBe('not_allowed_in_state')
    }
  })
})

// ---- Scenarios --------------------------------------------------------------

describe('the pipeline of a template with a conclusion', () => {
  test('rounds, supersede, decide, conclude, close, archive', () => {
    const t = INTAKE_TEMPLATE
    let flow = run(t, initialFlow, 1, share)
    expect(flow.draftCount).toBe(1)
    flow = run(t, flow, 2, publish(100))
    expect(flow.state).toBe('in_review')
    expect(flow.rounds[0]).toMatchObject({
      revision: 1,
      draft: 1,
      closing: false,
    })
    flow = run(t, flow, 3, approve('r1'))
    flow = run(t, flow, 4, {
      type: 'submit_review',
      revision: 1,
      reviewerId: 'r2',
      decision: 'request_changes',
    })
    expect(flow.state).toBe('in_review')

    // Revision 2 replaces Revision 1; its approval no longer counts.
    flow = run(t, flow, 5, share)
    flow = run(t, flow, 6, { ...(publish(200) as any), draft: 2 })
    expect(flow.rounds.map(r => r.status)).toEqual(['superseded', 'open'])
    expect(flow.rounds[1]?.revision).toBe(2)
    flow = run(t, flow, 7, approve('r1', 2))
    expect(flow.state).toBe('in_review')
    flow = run(t, flow, 8, approve('r2', 2))
    expect(flow.state).toBe('decided')
    expect(latestRound(flow)).toMatchObject({
      status: 'decided',
      decidedBy: 'rule_met',
    })

    flow = run(t, flow, 9, { type: 'start_conclusion' })
    expect(flow.state).toBe('concluding')
    flow = run(t, flow, 10, share)
    flow = run(t, flow, 11, { ...(closing(300) as any), draft: 3 })
    expect(flow.state).toBe('concluding')
    expect(latestRound(flow)).toMatchObject({ revision: 3, closing: true })
    flow = run(t, flow, 12, approve('r1', 3))
    expect(flow.state).toBe('concluding')
    flow = run(t, flow, 13, approve('r2', 3))
    expect(flow.state).toBe('archived')
    for (const event of eventsOfEveryKind(flow)) {
      expect(code(applyEvent(ctx(t, 14), flow, event))).toBe(
        'not_allowed_in_state',
      )
    }
  })

  test('an approval of Revision 1 does not count for Revision 2', () => {
    const t = INTAKE_TEMPLATE
    let flow = run(t, run(t, initialFlow, 1, share), 2, publish(100))
    flow = run(t, flow, 3, approve('r1'))
    flow = run(t, flow, 4, publish(200))
    flow = run(t, flow, 5, approve('r2', 2))
    expect(flow.state).toBe('in_review')
    expect(tallyRound(t, flow.rounds[1]!).met).toBe(false)
    expect(tallyRound(t, flow.rounds[1]!).roles[0]?.approvals).toBe(1)
  })

  test('regression: a review written on Revision 1 is refused once Revision 2 is open', () => {
    const t = INTAKE_TEMPLATE
    let flow = run(t, run(t, initialFlow, 1, share), 2, publish(100))
    flow = run(t, flow, 3, publish(200))
    const stale = applyEvent(ctx(t, 4), flow, approve('r1', 1))
    expect(code(stale)).toBe('round_not_open')
    // Nothing landed on the new round, and a review of the open one works.
    expect(flow.rounds[1]?.reviews).toEqual([])
    expect(code(applyEvent(ctx(t, 4), flow, approve('r1', 2)))).toBe('ok')
    // A revision that does not exist yet is refused too.
    expect(code(applyEvent(ctx(t, 4), flow, approve('r1', 3)))).toBe(
      'round_not_open',
    )
  })

  test('start_conclusion fails in a template without one', () => {
    const t = INVESTIGATION_TEMPLATE
    let flow = run(t, run(t, initialFlow, 1, share), 2, publish(100))
    flow = run(t, flow, 100, share) // settles the round by its deadline
    expect(flow.state).toBe('decided')
    expect(
      code(applyEvent(ctx(t, 101), flow, { type: 'start_conclusion' })),
    ).toBe('conclusion_not_in_template')
    expect(code(applyEvent(ctx(t, 101), flow, { type: 'archive' }))).toBe(
      'cannot_archive',
    )
  })

  test('a template without a conclusion is archived when the rule is met', () => {
    const t = INVESTIGATION_TEMPLATE
    let flow = run(t, run(t, initialFlow, 1, share), 2, publish(100))
    flow = run(t, flow, 3, approve('r1'))
    expect(flow.state).toBe('in_review')
    flow = run(t, flow, 4, approve('r2'))
    expect(flow.state).toBe('archived')
    expect(latestRound(flow)?.decidedBy).toBe('rule_met')
  })
})

describe('deadlines', () => {
  const t = INTAKE_TEMPLATE
  const reviewing = run(t, run(t, initialFlow, 1, share), 2, publish(100))

  test('a round is decided by its deadline when the rule is not met', () => {
    const half = run(t, reviewing, 3, approve('r1'))
    const settled = settle(ctx(t, 100), half)
    expect(settled.state).toBe('decided')
    expect(latestRound(settled)).toMatchObject({
      status: 'decided',
      decidedBy: 'deadline',
    })
    expect(settle(ctx(t, 99), half)).toBe(half)
  })

  test('a review at or after the deadline is refused even if nobody settled yet', () => {
    expect(code(applyEvent(ctx(t, 100), reviewing, approve('r1')))).toBe(
      'not_allowed_in_state',
    )
    expect(code(applyEvent(ctx(t, 99), reviewing, approve('r1')))).toBe('ok')
  })

  test('after a deadline decision a new revision is accepted', () => {
    const decided = settle(ctx(t, 150), reviewing)
    const next = run(t, decided, 150, publish(300))
    expect(next.state).toBe('in_review')
    expect(next.rounds.map(r => r.status)).toEqual(['decided', 'open'])
  })

  test('the deadline can be extended only while open, and only later', () => {
    const extended = run(t, reviewing, 50, {
      type: 'extend_deadline',
      deadline: 160,
    })
    expect(latestRound(extended)?.deadline).toBe(160)
    expect(settle(ctx(t, 120), extended).state).toBe('in_review')
    expect(
      code(
        applyEvent(ctx(t, 50), reviewing, {
          type: 'extend_deadline',
          deadline: 100,
        }),
      ),
    ).toBe('deadline_not_extended')
    expect(
      code(
        applyEvent(ctx(t, 50), reviewing, {
          type: 'extend_deadline',
          deadline: 60,
        }),
      ),
    ).toBe('deadline_not_extended')
    // Too late: the round was decided by its deadline first.
    expect(
      code(
        applyEvent(ctx(t, 100), reviewing, {
          type: 'extend_deadline',
          deadline: 500,
        }),
      ),
    ).toBe('not_allowed_in_state')
  })

  test('a closing round decided by its deadline leaves the report concluding', () => {
    const concluding = inState(t, 'concluding')!
    let flow = run(t, concluding, 6, closing(50))
    flow = run(t, flow, 7, approve('r1', 2))
    const settled = settle(ctx(t, 50), flow)
    expect(settled.state).toBe('concluding')
    expect(latestRound(settled)).toMatchObject({
      status: 'decided',
      decidedBy: 'deadline',
      closing: true,
    })
    expect(openRound(settled)).toBeUndefined()
    // Nothing more to review, extend or remove in that round.
    for (const event of [
      approve('r2'),
      { type: 'extend_deadline', deadline: 999 } as const,
      { type: 'remove_reviewer', accountId: 'r2' } as const,
    ]) {
      expect(code(applyEvent(ctx(t, 51), settled, event))).toBe(
        'round_not_open',
      )
    }
    // Another closing revision, then the rule is met: archived.
    let again = run(t, settled, 60, closing(200))
    expect(again.rounds.map(r => r.status)).toEqual([
      'decided',
      'decided',
      'open',
    ])
    again = run(
      t,
      run(t, again, 61, approve('r1', 3)),
      62,
      approve('r2', 3),
    )
    expect(again.state).toBe('archived')
  })
})

describe('publishing', () => {
  const t = INTAKE_TEMPLATE
  const shared = run(t, initialFlow, 1, share)

  test('only a shared draft can be published; Draft 0 cannot', () => {
    for (const draft of [0, 2, -1, 1.5]) {
      expect(
        code(
          applyEvent(ctx(t, 2), shared, { ...(publish(100) as any), draft }),
        ),
      ).toBe('draft_not_shared')
    }
  })

  test('regression: only the latest shared draft can be published', () => {
    const two = run(t, shared, 2, share)
    expect(
      code(applyEvent(ctx(t, 3), two, { ...(publish(100) as any), draft: 1 })),
    ).toBe('not_latest')
    expect(
      code(applyEvent(ctx(t, 3), two, { ...(publish(100) as any), draft: 2 })),
    ).toBe('ok')
    // And for a closing revision.
    const concluding = inState(t, 'concluding')!
    const more = run(t, concluding, 40, share)
    const latest = more.draftCount
    expect(
      code(
        applyEvent(ctx(t, 41), more, {
          ...(closing(500) as any),
          draft: latest - 1,
        }),
      ),
    ).toBe('not_latest')
    expect(
      code(
        applyEvent(ctx(t, 41), more, {
          ...(closing(500) as any),
          draft: latest,
        }),
      ),
    ).toBe('ok')
  })

  test('the deadline must be in the future', () => {
    expect(code(applyEvent(ctx(t, 100), shared, publish(100)))).toBe(
      'deadline_not_in_future',
    )
    expect(code(applyEvent(ctx(t, 100), shared, publish(Number.NaN)))).toBe(
      'deadline_not_in_future',
    )
  })

  test('a rule that cannot be met, or an author as reviewer, refuses', () => {
    const none = applyEvent(ctx(t, 2), shared, publish(100, []))
    expect(code(none)).toBe('unpublishable')
    expect(
      Result.isFailure(none) && none.failure.problems?.map(p => p.code),
    ).toEqual(['no_voters'])
    expect(
      code(
        applyEvent(ctx(t, 2), shared, publish(100, people('r1', 'author-1'))),
      ),
    ).toBe('unpublishable')
    expect(
      code(
        applyEvent(
          ctx(PANEL_TEMPLATE, 2),
          run(PANEL_TEMPLATE, initialFlow, 1, share),
          publish(100, [
            { accountId: 'c', roleId: 'chair' },
            { accountId: 'm', roleId: 'members' },
          ]),
        ),
      ),
    ).toBe('unpublishable')
  })

  test('a refused event changes nothing', () => {
    const before = shared
    applyEvent(ctx(t, 2), before, publish(100, []))
    expect(before).toEqual(run(t, initialFlow, 1, share))
  })
})

describe('reviews and reviewers', () => {
  const t = INTAKE_TEMPLATE
  const reviewing = run(
    t,
    run(t, initialFlow, 1, share),
    2,
    publish(100, people('r1', 'r2', 'r3')),
  )

  test('only a participant may review, and a new review replaces the old one', () => {
    expect(code(applyEvent(ctx(t, 3), reviewing, approve('stranger')))).toBe(
      'not_a_participant',
    )
    let flow = run(t, reviewing, 3, approve('r1'))
    flow = run(t, flow, 4, {
      type: 'submit_review',
      revision: 1,
      reviewerId: 'r1',
      decision: 'request_changes',
    })
    expect(tallyRound(t, flow.rounds[0]!).roles[0]).toMatchObject({
      approvals: 0,
      changesRequested: 1,
    })
    flow = run(t, flow, 5, {
      type: 'submit_review',
      revision: 1,
      reviewerId: 'r1',
      decision: 'comment',
    })
    expect(tallyRound(t, flow.rounds[0]!).roles[0]?.changesRequested).toBe(1)
  })

  test('removing a reviewer recomputes the rule, and can decide the round', () => {
    let flow = run(t, reviewing, 3, approve('r1'))
    flow = run(t, flow, 4, approve('r2'))
    expect(flow.state).toBe('in_review')
    flow = run(t, flow, 5, { type: 'remove_reviewer', accountId: 'r3' })
    expect(flow.state).toBe('decided')
    expect(flow.rounds[0]?.removed).toEqual([
      { accountId: 'r3', roleId: 'committee' },
    ])
    expect(flow.rounds[0]?.participants).toEqual(people('r1', 'r2'))
  })

  test('a reviewer with a standing decision cannot be removed; a silent one or one who only commented can', () => {
    const removal = { type: 'remove_reviewer', accountId: 'r1' } as const
    for (const decision of ['approve', 'request_changes'] as const) {
      const decided = run(t, reviewing, 3, {
        type: 'submit_review',
        revision: 1,
        reviewerId: 'r1',
        decision,
      })
      expect(code(applyEvent(ctx(t, 4), decided, removal))).toBe(
        'reviewer_has_decision',
      )
    }
    const commented = run(t, reviewing, 3, {
      type: 'submit_review',
      revision: 1,
      reviewerId: 'r1',
      decision: 'comment',
    })
    expect(code(applyEvent(ctx(t, 4), commented, removal))).toBe('ok')
    expect(code(applyEvent(ctx(t, 4), reviewing, removal))).toBe('ok')
  })

  test('a removed reviewer can no longer review', () => {
    const flow = run(t, reviewing, 3, {
      type: 'remove_reviewer',
      accountId: 'r3',
    })
    expect(code(applyEvent(ctx(t, 4), flow, approve('r3')))).toBe(
      'not_a_participant',
    )
    expect(
      code(
        applyEvent(ctx(t, 4), flow, {
          type: 'remove_reviewer',
          accountId: 'r3',
        }),
      ),
    ).toBe('not_a_participant')
  })

  test('removing the last voter, or one a rule needs, is refused', () => {
    const one = run(
      t,
      run(t, initialFlow, 1, share),
      2,
      publish(100, people('r1')),
    )
    expect(
      code(
        applyEvent(ctx(t, 3), one, {
          type: 'remove_reviewer',
          accountId: 'r1',
        }),
      ),
    ).toBe('removal_makes_rule_unmeetable')
    const p = PANEL_TEMPLATE
    const panel = run(
      p,
      run(p, initialFlow, 1, share),
      2,
      publish(100, [
        { accountId: 'c', roleId: 'chair' },
        { accountId: 'm1', roleId: 'members' },
        { accountId: 'm2', roleId: 'members' },
        { accountId: 'o', roleId: 'observer' },
      ]),
    )
    expect(
      code(
        applyEvent(ctx(p, 3), panel, {
          type: 'remove_reviewer',
          accountId: 'm1',
        }),
      ),
    ).toBe('removal_makes_rule_unmeetable')
    // The observer does not vote and may go.
    expect(
      code(
        applyEvent(ctx(p, 3), panel, {
          type: 'remove_reviewer',
          accountId: 'o',
        }),
      ),
    ).toBe('ok')
  })

  test('a role may send only the reviews its permissions allow', () => {
    const p = PANEL_TEMPLATE
    const panel = run(
      p,
      run(p, initialFlow, 1, share),
      2,
      publish(100, [
        { accountId: 'c', roleId: 'chair' },
        { accountId: 'm1', roleId: 'members' },
        { accountId: 'm2', roleId: 'members' },
        { accountId: 'o', roleId: 'observer' },
      ]),
    )
    expect(code(applyEvent(ctx(p, 3), panel, approve('o')))).toBe(
      'not_permitted_decision',
    )
    expect(
      code(
        applyEvent(ctx(p, 3), panel, {
          type: 'submit_review',
          revision: 1,
          reviewerId: 'o',
          decision: 'comment',
        }),
      ),
    ).toBe('ok')
    // The panel decides by majority and at least two, observer or not.
    let flow = run(p, panel, 4, approve('c'))
    flow = run(p, flow, 5, approve('m1'))
    expect(flow.state).toBe('in_review')
    flow = run(p, flow, 6, approve('m2'))
    expect(flow.state).toBe('archived') // the panel template has no conclusion
  })
})

describe('numbering of drafts and revisions', () => {
  test('Draft 0 exists, shares make Draft 1, 2, ...; publications are Revision 1, 2, ...', () => {
    const t = INTAKE_TEMPLATE
    let flow = initialFlow
    for (let i = 1; i <= 3; i++) {
      flow = run(t, flow, i, share)
      expect(flow.draftCount).toBe(i)
    }
    flow = run(t, flow, 10, { ...(publish(100) as any), draft: 3 })
    flow = run(t, flow, 11, { ...(publish(200) as any), draft: 3 })
    expect(flow.rounds.map(r => [r.revision, r.draft])).toEqual([
      [1, 3],
      [2, 3],
    ])
  })

  test('labels and the next number', () => {
    expect(draftLabel(0)).toBe('Draft 0')
    expect(revisionLabel(2)).toBe('Revision 2')
    expect(revisionTitle(4, true)).toBe('Revision 4 (closing)')
    expect(versionSlug({ kind: 'revision', number: 2 })).toBe('Revision-2')
    expect(versionSlug({ kind: 'draft', number: 5 })).toBe('Draft-5')
    expect(nextDraftNumber([])).toBe(1)
    expect(nextRevisionNumber([])).toBe(1)
    fc.assert(
      fc.property(fc.array(fc.nat(50), { maxLength: 20 }), existing => {
        const next = nextDraftNumber(existing)
        expect(existing).not.toContain(next)
        expect(existing.every(n => n < next)).toBe(true)
      }),
    )
  })
})

// ---- Saving content ---------------------------------------------------------

const conclusionIds = (template: Template): ReadonlySet<string> => {
  const ids = new Set<string>()
  const visit = (section: NonNullable<Template['conclusion']>): void => {
    ids.add(section.id)
    section.sections.forEach(visit)
  }
  if (template.conclusion !== undefined) visit(template.conclusion)
  return ids
}

describe('saving content', () => {
  test('property: the conclusion is savable only while concluding, and nothing else then', () => {
    fc.assert(
      fc.property(flowTemplateArbitrary, template => {
        const inConclusion = conclusionIds(template)
        const sections = templateNodes(template).filter(
          n => n.kind === 'section',
        )
        for (const state of REPORT_STATES) {
          for (const node of sections) {
            const result = checkSave(template, state, {
              kind: 'section',
              sectionId: node.node.id,
            })
            const isConclusion = inConclusion.has(node.node.id)
            const expected =
              state === 'archived'
                ? false
                : state === 'concluding'
                  ? isConclusion
                  : !isConclusion
            expect(Result.isSuccess(result)).toBe(expected)
          }
          const people = checkSave(template, state, { kind: 'people' })
          expect(Result.isSuccess(people)).toBe(
            state !== 'archived' && state !== 'concluding',
          )
        }
      }),
      { numRuns: 200 },
    )
  })

  test('typed errors', () => {
    const t = INTAKE_TEMPLATE
    const first = t.sections[0]!.id
    const conclusion = t.conclusion!.id
    const codeOf = (state: ReportState, sectionId: string) => {
      const result = checkSave(t, state, { kind: 'section', sectionId })
      return Result.isFailure(result) ? result.failure.code : 'ok'
    }
    expect(codeOf('drafting', conclusion)).toBe(
      'conclusion_only_while_concluding',
    )
    expect(codeOf('decided', conclusion)).toBe(
      'conclusion_only_while_concluding',
    )
    expect(codeOf('concluding', first)).toBe('only_conclusion_while_concluding')
    expect(codeOf('concluding', conclusion)).toBe('ok')
    expect(codeOf('archived', conclusion)).toBe('report_archived')
    expect(codeOf('in_review', first)).toBe('ok')
    expect(codeOf('drafting', 'no-such-section')).toBe('unknown_section')
  })
})

describe('regression: sharing while concluding', () => {
  const t = INTAKE_TEMPLATE
  const first = t.sections[0]!.id
  const second = t.sections[1]!.id
  const conclusionId = t.conclusion!.id
  const content = (sections: ReportContent['sections']): ReportContent => ({
    ...emptyContent(t),
    sections,
  })
  const text = (value: string) => ({
    values: { x: { type: 'text' as const, text: value } },
    sections: {},
  })
  const rich = (...nodes: ReadonlyArray<string>) => ({
    values: {
      r: {
        type: 'rich_text' as const,
        doc: {
          type: 'doc' as const,
          content: [
            {
              type: 'paragraph' as const,
              content: nodes.map(value => ({ type: 'text' as const, text: value })),
            },
          ],
        },
      },
    },
    sections: {},
  })
  const base = content({ [first]: text('a'), [second]: rich('he', 'llo') })
  const check = (draft: ReportContent, state: ReportState = 'concluding') => {
    const result = checkClosingDraft(t, state, base, draft)
    return Result.isFailure(result) ? result.failure.sectionIds : 'ok'
  }

  test('only the conclusion may differ from the revision being closed', () => {
    expect(
      check(content({ ...base.sections, [conclusionId]: text('closing words') })),
    ).toBe('ok')
    expect(check(content({ ...base.sections, [first]: text('b') }))).toEqual([first])
    expect(
      check(
        content({
          [first]: text('b'),
          [second]: rich('hello'),
          [conclusionId]: text('c'),
          extra: text('new'),
        }),
      ),
    ).toEqual([first, 'extra'])
    // A section removed counts as a change too.
    expect(check(content({ [first]: text('a') }))).toEqual([second])
  })

  test('editor normalisation is not a change', () => {
    // The same rich text in other nodes, an empty section against an absent one.
    expect(
      check(
        content({
          [first]: text('a'),
          [second]: rich('hello'),
          extra: { values: {}, sections: {} },
        }),
      ),
    ).toBe('ok')
  })

  test('in every other state the check accepts: drafting continues', () => {
    for (const state of ['drafting', 'in_review', 'decided'] as const) {
      expect(check(content({ [first]: text('changed') }), state)).toBe('ok')
    }
  })

  test('property: any change outside the conclusion is found, any change inside it is not', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(first, second, conclusionId),
        fc.string({ minLength: 1, maxLength: 12 }),
        (id, value) => {
          const draft = content({ ...base.sections, [id]: text(`#${value}`) })
          expect(check(draft)).toEqual(id === conclusionId ? 'ok' : [id])
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('regression: publishing a closing revision needs a written conclusion', () => {
  const t = INTAKE_TEMPLATE
  const conclusionId = t.conclusion!.id
  const draft = (sections: ReportContent['sections']): ReportContent => ({
    ...emptyContent(t),
    sections,
  })
  const richText = (...texts: ReadonlyArray<string>) => ({
    values: {
      x: {
        type: 'rich_text' as const,
        doc: {
          type: 'doc' as const,
          content: texts.map(text => ({
            type: 'paragraph' as const,
            content: text === '' ? [] : [{ type: 'text' as const, text }],
          })),
        },
      },
    },
    sections: {},
  })
  const code = (content: ReportContent, state: ReportState = 'concluding') => {
    const result = checkClosingConclusion(t, state, content)
    return Result.isFailure(result) ? result.failure.code : 'ok'
  }

  test('an absent, empty or blank conclusion is refused while concluding', () => {
    expect(code(draft({}))).toBe('conclusion_empty')
    expect(code(draft({ [conclusionId]: { values: {}, sections: {} } }))).toBe(
      'conclusion_empty',
    )
    expect(code(draft({ [conclusionId]: richText('', '  ') }))).toBe(
      'conclusion_empty',
    )
    expect(
      code(
        draft({
          [conclusionId]: {
            values: {},
            sections: {},
            notApplicable: { reason: 'none' },
          },
        }),
      ),
    ).toBe('conclusion_empty')
  })

  test('a written conclusion passes, and other states accept anything', () => {
    expect(code(draft({ [conclusionId]: richText('Closed.') }))).toBe('ok')
    expect(code(draft({}), 'in_review')).toBe('ok')
    expect(code(draft({}), 'decided')).toBe('ok')
  })
})

// ---- Generated event sequences ----------------------------------------------

const scripts = flowTemplateArbitrary.chain(template =>
  fc.tuple(fc.constant(template), scriptArbitrary(template)),
)

describe('generated event sequences', () => {
  test('property: every event outside the D18 table fails, every other fails for its own reason', () => {
    fc.assert(
      fc.property(scripts, ([template, script]) => {
        const { steps } = runScript(template, script)
        for (const step of steps) {
          const state = step.settledBefore.state
          const allowed = D18_ALLOWED[state].includes(step.event.type)
          if (!allowed) {
            expect(code(step.result)).toBe('not_allowed_in_state')
            // Nothing is applied: the same settled report.
          } else {
            expect(code(step.result)).not.toBe('not_allowed_in_state')
          }
        }
      }),
      { numRuns: 400 },
    )
  })

  test('property: every change of state is one D18 allows', () => {
    fc.assert(
      fc.property(scripts, ([template, script]) => {
        for (const step of runScript(template, script).steps) {
          const settled = step.settledBefore.state
          expect(pairAllowed(step.before.state, settled)).toBe(true)
          if (Result.isSuccess(step.result)) {
            expect(pairAllowed(settled, step.result.success.state)).toBe(true)
          }
        }
      }),
      { numRuns: 400 },
    )
  })

  test('property: invariants of the report hold after every step', () => {
    fc.assert(
      fc.property(scripts, ([template, script]) => {
        const { steps, final } = runScript(template, script)
        const flows = [...steps.map(s => s.settledBefore), final]
        for (const flow of flows) {
          const open = flow.rounds.filter(r => r.status === 'open')
          const last = flow.rounds[flow.rounds.length - 1]
          expect(open.length).toBeLessThanOrEqual(1)
          if (open.length === 1) expect(open[0]).toBe(last)
          expect(flow.rounds.map(r => r.revision)).toEqual(
            flow.rounds.map((_, index) => index + 1),
          )
          if (flow.state === 'drafting') expect(flow.rounds).toEqual([])
          if (flow.state === 'in_review') {
            expect(last?.status).toBe('open')
            expect(last?.closing).toBe(false)
          }
          if (flow.state === 'decided') expect(last?.status).toBe('decided')
          if (flow.state === 'concluding') {
            expect(template.conclusion).toBeDefined()
          }
          if (flow.state === 'archived') {
            expect(last?.decidedBy).toBe('rule_met')
            expect(
              template.conclusion === undefined || last?.closing === true,
            ).toBe(true)
          }
          // Once a round is a closing one, every later one is.
          const firstClosing = flow.rounds.findIndex(r => r.closing)
          if (firstClosing >= 0) {
            expect(flow.rounds.slice(firstClosing).every(r => r.closing)).toBe(
              true,
            )
            expect(
              flow.state === 'concluding' || flow.state === 'archived',
            ).toBe(true)
          }
          for (const round of flow.rounds) {
            if (round.status === 'decided') {
              expect(round.decidedBy).toBeDefined()
              if (round.decidedBy === 'rule_met') {
                expect(tallyRound(template, round).met).toBe(true)
              }
            } else {
              expect(round.decidedBy).toBeUndefined()
            }
            // The participants of a round are frozen but for removals.
            expect(
              round.reviews.every(r => r.revision === round.revision),
            ).toBe(true)
            expect(
              round.reviews.every(r =>
                [...round.participants, ...round.removed].some(
                  p => p.accountId === r.reviewerId,
                ),
              ),
            ).toBe(true)
          }
        }
      }),
      { numRuns: 400 },
    )
  })

  test('property: only the open round ever changes, and a late review never gets in', () => {
    fc.assert(
      fc.property(scripts, ([template, script]) => {
        for (const step of runScript(template, script).steps) {
          if (Result.isFailure(step.result)) continue
          const before = step.settledBefore.rounds
          const after = step.result.success.rounds
          before.forEach((round, index) => {
            if (round.status !== 'open') {
              // Closed rounds keep their reviews, people and deadline.
              expect(after[index]).toEqual(round)
            }
          })
          if (step.event.type === 'submit_review') {
            const round = openRound(step.settledBefore)
            expect(round).toBeDefined()
            expect(round!.deadline).toBeGreaterThan(step.now)
            // A review of any other revision never gets in.
            expect(step.event.revision).toBe(round!.revision)
          }
        }
      }),
      { numRuns: 400 },
    )
  })

  test('property: a stale review is refused, and an older approval never counts for the latest revision', () => {
    let stale = 0
    fc.assert(
      fc.property(
        flowTemplateArbitrary.chain(template =>
          fc.tuple(fc.constant(template), scriptArbitrary(template, 60)),
        ), ([template, script]) => {
        for (const step of runScript(template, script).steps) {
          if (step.event.type !== 'submit_review') continue
          const latest = latestRound(step.settledBefore)
          if (latest !== undefined && step.event.revision !== latest.revision) {
            stale += 1
            expect(Result.isFailure(step.result)).toBe(true)
            if (ALLOWED_EVENTS[step.settledBefore.state].includes('submit_review')) {
              expect(code(step.result)).toBe('round_not_open')
            }
          }
        }
        // Every review in every round was written on that round's revision,
        // so tallying the latest round only ever counts its own approvals.
        const { final } = runScript(template, script)
        for (const round of final.rounds) {
          expect(round.reviews.every(r => r.revision === round.revision)).toBe(
            true,
          )
        }
      }),
      { numRuns: 1500, seed: 20261112 },
    )
    expect(stale).toBeGreaterThan(0)
  })

  test('property: approvals written on older revisions never count for the latest, through applyEvent', () => {
    fc.assert(
      fc.property(
        flowTemplateArbitrary.chain(template =>
          fc.tuple(
            fc.constant(template),
            satisfiableParticipants(template),
            fc.integer({ min: 2, max: 4 }),
            fc.array(fc.nat(100), { minLength: 1, maxLength: 12 }),
          ),
        ),
        ([template, who, revisions, picks]) => {
          const authors = AUTHOR_IDS
          const voters = who.filter(person =>
            template.roles
              .find(role => role.id === person.roleId)
              ?.permissions.includes('vote'),
          )
          fc.pre(voters.length > 0)
          const step = (flow: ReportFlow, now: number, event: FlowEvent) => {
            const result = applyEvent({ template, authors, now }, flow, event)
            if (Result.isFailure(result)) {
              throw new Error(JSON.stringify(result.failure))
            }
            return result.success
          }
          let flow = step(initialFlow, 1, { type: 'share_draft' })
          for (let revision = 1; revision <= revisions; revision++) {
            flow = step(flow, 1 + revision, {
              type: 'publish_revision',
              draft: 1,
              deadline: 1_000_000,
              participants: who,
            })
          }
          // Everyone approves, on an older revision: every one is refused,
          // nothing lands on the latest round.
          for (const pick of picks) {
            const voter = voters[pick % voters.length] as Participant
            const result = applyEvent(
              { template, authors, now: 100 },
              flow,
              {
                type: 'submit_review',
                revision: 1 + (pick % (revisions - 1)),
                reviewerId: voter.accountId,
                decision: 'approve',
              },
            )
            expect(code(result)).toBe('round_not_open')
          }
          const latest = latestRound(flow)!
          expect(latest.reviews).toEqual([])
          expect(tallyRound(template, latest).met).toBe(false)
          expect(flow.state).toBe('in_review')
          // The same people approving on the latest revision decide it.
          for (const voter of voters) {
            if (openRound(flow) === undefined) break
            flow = step(flow, 200, {
              type: 'submit_review',
              revision: revisions,
              reviewerId: voter.accountId,
              decision: 'approve',
            })
          }
          expect(latestRound(flow)).toMatchObject({
            status: 'decided',
            decidedBy: 'rule_met',
          })
        },
      ),
      { numRuns: 200 },
    )
  })

  test('property: only the latest shared draft is ever published', () => {
    fc.assert(
      fc.property(scripts, ([template, script]) => {
        for (const step of runScript(template, script).steps) {
          const { event } = step
          if (
            event.type !== 'publish_revision' &&
            event.type !== 'publish_closing_revision'
          ) {
            continue
          }
          if (Result.isSuccess(step.result)) {
            expect(event.draft).toBe(step.settledBefore.draftCount)
            expect(latestRound(step.result.success)?.draft).toBe(event.draft)
          } else if (
            event.draft >= 1 &&
            event.draft < step.settledBefore.draftCount &&
            ALLOWED_EVENTS[step.settledBefore.state].includes(event.type)
          ) {
            expect(code(step.result)).toBe('not_latest')
          }
        }
      }),
      { numRuns: 400 },
    )
  })

  test('property: a report that is archived stays archived and refuses everything', () => {
    fc.assert(
      fc.property(scripts, ([template, script]) => {
        let archived = false
        for (const step of runScript(template, script).steps) {
          if (archived) {
            expect(Result.isFailure(step.result)).toBe(true)
            expect(step.settledBefore.state).toBe('archived')
          }
          if (step.settledBefore.state === 'archived') archived = true
        }
      }),
      { numRuns: 400 },
    )
  })

  test('the generators reach every state, with a fixed seed', () => {
    const reached = new Set<string>()
    const outcomes = new Set<string>()
    fc.assert(
      fc.property(
        fc
          .constantFrom(INTAKE_TEMPLATE, INVESTIGATION_TEMPLATE, PANEL_TEMPLATE)
          .chain(template =>
            fc.tuple(fc.constant(template), scriptArbitrary(template, 60)),
          ),
        ([template, script]) => {
          for (const step of runScript(template, script).steps) {
            reached.add(step.settledBefore.state)
            const round = latestRound(step.settledBefore)
            if (round?.decidedBy !== undefined) {
              outcomes.add(
                `${round.decidedBy}${round.closing ? '-closing' : ''}`,
              )
            }
          }
        },
      ),
      { numRuns: 1500, seed: 20261112 },
    )
    expect([...reached].sort()).toEqual([...REPORT_STATES].sort())
    expect(outcomes.has('rule_met')).toBe(true)
    expect(outcomes.has('deadline')).toBe(true)
    expect(outcomes.has('rule_met-closing')).toBe(true)
  })

  test('every event kind is generated', () => {
    expect(EVENT_KINDS.length).toBe(8)
  })
})
