import { Effect } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import { INTAKE_TEMPLATE, INVESTIGATION_TEMPLATE } from '@quoroom/domain'
import { PANEL_TEMPLATE } from '@quoroom/domain/testing/templates'

import {
  PEOPLE,
  type Scenario,
  type World,
  makeWorld,
  richContent,
} from './testkit'

// NOTE: Closing rounds through the real RPC stack, with three accounts that
// are invented: an author (alice) and two reviewers (carol, dan), plus a chair
// (erin) and an observer (ivy) in the panel template. Covers the closing path,
// a round decided by its deadline, the template without a conclusion archived
// at once, the panel's rules with an observer who cannot vote, the grid with
// every fact and its time, and the audit log.

const worlds: Array<World> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

const tagOf = (error: unknown): string =>
  (error as { _tag?: string })._tag ?? 'unknown'

const DAY = 24 * 3_600_000

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

const investigation: Scenario = {
  name: 'investigation',
  template: INVESTIGATION_TEMPLATE,
  backend: 'memory',
  authorsRole: 'authors',
  redactedRole: 'committee',
  sectionId: 'overall-findings',
  itemId: 'overall-findings-text',
}

const panel: Scenario = {
  name: 'panel',
  template: PANEL_TEMPLATE,
  backend: 'memory',
  authorsRole: 'drafters',
  redactedRole: 'members',
  fullRole: 'chair',
  observerRole: 'observer',
  sectionId: 'overview',
  itemId: 'overview-text',
}

const make = async (scenario: Scenario) => {
  const world = await makeWorld(scenario)
  worlds.push(world)
  return world
}

// NOTE: Shares the author's working copy with one changed section as the next
// draft and returns its number.
const nextDraft = async (
  w: World,
  reportId: string,
  shareId: string,
  text: string,
  scenario: Scenario,
): Promise<number> => {
  const { outcome } = await w.share('alice', reportId, {
    shareId,
    sectionId: scenario.sectionId,
    itemId: scenario.itemId,
    content: richContent(scenario.itemId, text),
  })
  if (outcome.kind !== 'shared') throw new Error('not shared')
  return outcome.draft.number
}

describe.each([intake, intakeOnSqlite])('the closing path, $name', scenario => {
  test('Revision 1 with a change request and two comments, Revision 2, approvals on Revision 2 only, the round decided, the conclusion written, the closing revision approved, the report archived', async () => {
    const w = await make(scenario)
    const { reportId } = await w.published()
    const { sectionId, itemId } = scenario
    const conclusion = scenario.conclusion
    if (conclusion === undefined) throw new Error('no conclusion')

    // Revision 1: one comment on a selected phrase (to the authors), one on the
    // section shared with the whole committee, then a request for changes.
    const text = 'Ana Garcia reported the matter on Monday.'
    const phrase = 'reported the matter'
    const from = text.indexOf(phrase)
    await w.call('carol', c =>
      c.AddComment({
        reportId,
        revision: 1,
        anchor: {
          kind: 'text',
          sectionId,
          itemId,
          entryPath: [],
          from,
          to: from + phrase.length,
          quoted: phrase,
        },
        body: 'Which Monday?',
        visibility: 'authors',
      }),
    )
    await w.call('carol', c =>
      c.AddComment({
        reportId,
        revision: 1,
        anchor: { kind: 'section', sectionId },
        body: 'Everyone should read this.',
        visibility: 'committee',
      }),
    )
    await w.sendReview('carol', reportId, 1, 'request_changes')
    expect(await w.call('dan', c => c.ListReviewerComments({ reportId, revision: 1 }))).toHaveLength(1)
    expect((await w.call('alice', c => c.ListRevisionComments({ reportId, revision: 1 }))).length).toBe(2)

    // Revision 2 replaces the open round.
    const draft2 = await nextDraft(w, reportId, 'share-2', 'The matter was reported on Monday 3 March.', scenario)
    w.clock.advance(60_000)
    await w.publish('alice', reportId, draft2)
    expect((await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))).status).toBe('superseded')
    expect((await w.call('alice', c => c.GetRound({ reportId, revision: 2 }))).status).toBe('open')

    // A review of Revision 1 is refused now; reviews of Revision 2 count.
    expect(
      await w.refused('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' })),
    ).toMatchObject({ _tag: 'NotAllowedInState', code: 'round_not_open' })
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 2, decision: 'approve' }))
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('in_review')
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 2, decision: 'approve' }))

    // The round is decided by its rule; the intake template has a conclusion,
    // so it waits for the authors, who cannot archive it directly.
    const round = await w.call('alice', c => c.GetRound({ reportId, revision: 2 }))
    expect(round).toMatchObject({ status: 'decided', decidedBy: 'rule_met' })
    expect(round.tally.met).toBe(true)
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('decided')
    expect(tagOf(await w.refused('alice', c => c.ArchiveReport({ reportId })))).toBe('NotAllowedInState')
    expect(
      await w.refused('carol', c => c.SendReview({ commentIds: [], reportId, revision: 2, decision: 'request_changes' })),
    ).toMatchObject({ _tag: 'NotAllowedInState' })

    // The conclusion: every other section refuses saves, the conclusion does not.
    expect(tagOf(await w.refused('bob', c => c.StartConclusion({ reportId })))).toBe('NotFound')
    expect(tagOf(await w.refused('carol', c => c.StartConclusion({ reportId })))).toBe('NotFound')
    expect((await w.call('alice', c => c.StartConclusion({ reportId }))).state).toBe('concluding')
    const copy = await w.call('alice', c => c.StartWorkingCopy({ reportId }))
    expect(
      await w.refused('alice', c =>
        c.SaveSection({ reportId, sectionId, saveCounter: copy.saveCounter, content: richContent(itemId, 'No.') }),
      ),
    ).toMatchObject({ _tag: 'NotAllowedInState' })
    const written = await w.call('alice', c =>
      c.SaveSection({
        reportId,
        sectionId: conclusion.sectionId,
        saveCounter: copy.saveCounter,
        content: richContent(conclusion.itemId, 'The committee decided to close the case.'),
      }),
    )
    const outline = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
    expect(outline.saveCounter).toBe(written.saveCounter)
    const closingDraft = (
      await w.stageAndFinish('alice', reportId, 'share-3', written.saveCounter)
    ).outcome
    if (closingDraft.kind !== 'shared') throw new Error('not shared')
    w.clock.advance(60_000)
    const closing = await w.publish('alice', reportId, closingDraft.draft.number, true)
    expect(closing.revision).toMatchObject({ number: 3, closing: true, status: 'open' })
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('concluding')

    // The closing revision is reviewed and approved: the report is archived.
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 3, decision: 'approve' }))
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 3, decision: 'approve' }))
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('archived')
    expect(await w.call('alice', c => c.GetRound({ reportId, revision: 3 }))).toMatchObject({
      status: 'decided',
      decidedBy: 'rule_met',
      closing: true,
    })

    // Archived reports are read-only for everyone, and still readable.
    expect(
      await w.refused('alice', c =>
        c.SaveSection({
          reportId,
          sectionId: conclusion.sectionId,
          saveCounter: written.saveCounter + 1,
          content: richContent(conclusion.itemId, 'Too late.'),
        }),
      ),
    ).toMatchObject({ _tag: 'NotPermitted', reason: 'read_only' })
    expect(
      await w.refused('alice', c => c.ExtendDeadline({ reportId, revision: 3, deadline: { at: w.clock.now() + DAY, timeZone: 'UTC' } })),
    ).toMatchObject({ _tag: 'NotPermitted', reason: 'read_only' })
    expect(tagOf(await w.refused('alice', c => c.StartConclusion({ reportId })))).toBe('NotPermitted')
    // NOTE: a review on the archived report is refused with a typed error, and
    // nothing of it is stored.
    expect(
      await w.refused('carol', c =>
        c.SendReview({ commentIds: [], reportId, revision: 3, decision: 'comment' }),
      ),
    ).toMatchObject({ _tag: 'NotPermitted', reason: 'read_only' })
    const readable = await w.call('carol', c =>
      c.GetRevisionSection({ reportId, revision: 3, sectionId: conclusion.sectionId }),
    )
    expect(JSON.stringify(readable.content)).toContain('The committee decided to close the case.')
    expect(await w.call('alice', c => c.GetHistory({ reportId }))).toMatchObject({
      revisions: [{ number: 1 }, { number: 2 }, { number: 3 }],
    })

    // The audit log tells the whole story, newest first.
    const log = await w.call('alice', c =>
      c.ListAuditEvents({ subject: { kind: 'report', reportId }, limit: 100 }),
    )
    const actions = log.events.map(event => event.action)
    expect(actions).toEqual(
      expect.arrayContaining([
        'report.created',
        'draft.shared',
        'redaction.confirmed',
        'revision.published',
        'review.sent',
        'round.decided',
        'report.conclusion_started',
      ]),
    )
    expect(actions.filter(action => action === 'revision.published')).toHaveLength(3)
    expect(log.events.map(event => event.at)).toEqual([...log.events.map(event => event.at)].sort((a, b) => b - a))

    // The grid has each fact with its time.
    const view = await w.call('alice', c => c.GetGrid({ reportId }))
    expect(view.grid.revisions.map(row => [row.revision, row.status])).toEqual([
      [1, 'superseded'],
      [2, 'decided'],
      [3, 'decided'],
    ])
    const third = view.grid.revisions[2]
    expect(third?.closing).toBe(true)
    const carolCell = third?.cells.find(cell => cell.accountId === 'carol')
    expect(third?.publishedAt).toBeGreaterThan(0)
    expect(carolCell?.decision).toMatchObject({ decision: 'approve' })
    expect(carolCell?.decision?.at).toBeGreaterThanOrEqual(third?.publishedAt ?? Number.MAX_SAFE_INTEGER)
    expect(view.grid.revisions[0]?.cells.find(cell => cell.accountId === 'carol')?.decision?.decision).toBe('request_changes')
    expect(view.grid.revisions[1]?.decidedAt).toBeDefined()
  })

  test('a deadline extended by the authors reaches the reviewers and the new time counts', async () => {
    const w = await make(scenario)
    const { reportId } = await w.published()
    const later = { at: w.clock.now() + 14 * DAY, timeZone: 'Africa/Nairobi' }
    const round = await w.call('alice', c => c.ExtendDeadline({ reportId, revision: 1, deadline: later }))
    expect(round.deadline).toEqual(later)
    w.clock.advance(10 * DAY)
    // Past the old deadline, inside the new one: reviews are still accepted.
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    expect((await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))).status).toBe('open')
    const grid = await w.call('alice', c => c.GetGrid({ reportId }))
    expect(grid.grid.revisions[0]?.deadline).toBe(later.at)
  })
})

describe('a round decided by its deadline, intake', () => {
  test('a silent reviewer, a late review refused, and a new revision accepted', async () => {
    const w = await make(intake)
    const { reportId } = await w.published()
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    w.clock.advance(8 * DAY)

    const decided = await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))
    expect(decided).toMatchObject({ status: 'decided', decidedBy: 'deadline' })
    expect(decided.tally.met).toBe(false)
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('decided')

    // Dan was silent. A review now is refused.
    expect(
      await w.refused('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' })),
    ).toMatchObject({ _tag: 'NotAllowedInState', state: 'decided' })

    // The grid shows who decided and who did not, and how the round ended.
    const grid = await w.call('alice', c => c.GetGrid({ reportId }))
    const row = grid.grid.revisions[0]
    expect(row).toMatchObject({ status: 'decided', decidedBy: 'deadline' })
    expect(row?.decidedAt).toBeGreaterThanOrEqual(row?.deadline ?? Number.MAX_SAFE_INTEGER)
    expect(row?.cells.find(cell => cell.accountId === 'carol')?.decision?.decision).toBe('approve')
    expect(row?.cells.find(cell => cell.accountId === 'dan')?.decision).toBeUndefined()
    expect(row?.rule.roles[0]).toMatchObject({ voters: 2, approvals: 1, met: false })

    // The authors publish another revision: accepted, a new round opens.
    const draft = await nextDraft(w, reportId, 'share-2', 'Changed after the deadline.', intake)
    await w.publish('alice', reportId, draft)
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('in_review')
    expect(await w.call('alice', c => c.GetRound({ reportId, revision: 2 }))).toMatchObject({ status: 'open' })
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 2, decision: 'approve' }))
  })

  test('a deadline that passes in the closing round leaves the report concluding for another closing revision', async () => {
    const w = await make(intake)
    const { reportId } = await w.published()
    const conclusion = intake.conclusion
    if (conclusion === undefined) throw new Error('no conclusion')
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    await w.call('alice', c => c.StartConclusion({ reportId }))
    const copy = await w.call('alice', c => c.StartWorkingCopy({ reportId }))
    const saved = await w.call('alice', c =>
      c.SaveSection({
        reportId,
        sectionId: conclusion.sectionId,
        saveCounter: copy.saveCounter,
        content: richContent(conclusion.itemId, 'First closing text.'),
      }),
    )
    const shared = (await w.stageAndFinish('alice', reportId, 'share-2', saved.saveCounter)).outcome
    if (shared.kind !== 'shared') throw new Error('not shared')
    await w.publish('alice', reportId, shared.draft.number, true)
    w.clock.advance(8 * DAY)
    expect(await w.call('alice', c => c.GetRound({ reportId, revision: 2 }))).toMatchObject({
      status: 'decided',
      decidedBy: 'deadline',
    })
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('concluding')
    // Another closing revision is accepted from the same state.
    const again = await w.call('alice', c => c.StartWorkingCopy({ reportId }))
    const resaved = await w.call('alice', c =>
      c.SaveSection({
        reportId,
        sectionId: conclusion.sectionId,
        saveCounter: again.saveCounter,
        content: richContent(conclusion.itemId, 'Second closing text.'),
      }),
    )
    const second = (await w.stageAndFinish('alice', reportId, 'share-3', resaved.saveCounter)).outcome
    if (second.kind !== 'shared') throw new Error('not shared')
    const published = await w.publish('alice', reportId, second.draft.number, true)
    expect(published.revision).toMatchObject({ number: 3, closing: true })
  })
})

describe('a template without a conclusion', () => {
  test('the investigation template is archived directly when the round meets its rule', async () => {
    const w = await make(investigation)
    const { reportId } = await w.published()
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('in_review')
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('archived')
    expect(await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))).toMatchObject({
      status: 'decided',
      decidedBy: 'rule_met',
    })
    expect(tagOf(await w.refused('alice', c => c.StartConclusion({ reportId })))).toBe('NotPermitted')
    const copy = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
    expect(
      await w.refused('alice', c =>
        c.SaveSection({
          reportId,
          sectionId: investigation.sectionId,
          saveCounter: copy.saveCounter,
          content: richContent(investigation.itemId, 'Archived.'),
        }),
      ),
    ).toMatchObject({ _tag: 'NotPermitted', reason: 'read_only' })
    const log = await w.call('alice', c => c.ListAuditEvents({ subject: { kind: 'report', reportId }, limit: 50 }))
    expect(log.events.map(event => event.action)).toContain('round.decided')
  })

  test('a deadline without the rule met leaves it decided and it cannot be archived or concluded', async () => {
    const w = await make(investigation)
    const { reportId } = await w.published()
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    w.clock.advance(8 * DAY)
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('decided')
    expect(tagOf(await w.refused('alice', c => c.ArchiveReport({ reportId })))).toBe('NotAllowedInState')
    expect(await w.refused('alice', c => c.StartConclusion({ reportId }))).toMatchObject({
      _tag: 'NotAllowedInState',
      code: 'conclusion_not_in_template',
    })
  })
})

describe('the panel template: rules per role and an observer who cannot vote', () => {
  test('decided only when the chair approves and two panel members approve; the observer is refused as a voter', async () => {
    const w = await make(panel)
    const { reportId } = await w.published()
    const round = await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))
    expect(round.tally.roles.map(role => [role.roleId, role.rule.kind, role.voters])).toEqual([
      ['chair', 'majority', 1],
      ['members', 'at_least', 2],
    ])
    expect(round.participants.find(p => p.accountId === 'ivy')?.roleId).toBe('observer')

    // The observer may comment but a decision is refused and counts for nothing.
    expect(
      await w.refused('ivy', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' })),
    ).toMatchObject({ _tag: 'NotPermitted' })
    await w.call('ivy', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'comment' }))

    // The members' rule is "at least 2": one approval is not enough.
    await w.call('erin', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    const middle = await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))
    expect(middle.status).toBe('open')
    expect(middle.tally.roles.map(role => [role.roleId, role.met])).toEqual([
      ['chair', true],
      ['members', false],
    ])
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    expect(await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))).toMatchObject({
      status: 'decided',
      decidedBy: 'rule_met',
    })
    // No conclusion in the template: archived at once.
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('archived')

    // The grid keeps the observer's comment-only review, with no decision.
    const grid = await w.call('alice', c => c.GetGrid({ reportId }))
    const ivy = grid.grid.revisions[0]?.cells.find(cell => cell.accountId === 'ivy')
    expect(ivy?.decision).toBeUndefined()
    expect(ivy?.reviews[0]).toMatchObject({ decision: 'comment' })
    expect(ivy?.roleName).toBeDefined()
  })

  test('removing a reviewer is refused when it makes a rule unmeetable, and can complete the rule when it does not', async () => {
    const w = await make(panel)
    const { reportId } = await w.published()
    // Removing the only chair leaves a voting role with no voter.
    expect(tagOf(await w.refused('alice', c => c.RemoveReviewer({ reportId, revision: 1, accountId: 'erin' })))).toBe('Validation')
    // Removing one of two members leaves one voter for "at least 2".
    expect(tagOf(await w.refused('alice', c => c.RemoveReviewer({ reportId, revision: 1, accountId: 'dan' })))).toBe('Validation')
    // The observer does not vote, so removing them changes no rule.
    const round = await w.call('alice', c => c.RemoveReviewer({ reportId, revision: 1, accountId: 'ivy' }))
    expect(round.participants.find(p => p.accountId === 'ivy')?.removed).toBe(true)
    const grid = await w.call('alice', c => c.GetGrid({ reportId }))
    expect(grid.grid.revisions[0]?.cells.find(cell => cell.accountId === 'ivy')?.removed).toBe(true)
    // A removed observer no longer sees the round.
    expect(tagOf(await w.refused('ivy', c => c.GetRevisionOutline({ reportId, revision: 1 })))).toBe('NotFound')
  })
})

describe('the grid shows each fact with its time', () => {
  test('told, read, reminded, reviewed, removed, and who shared and read each draft', async () => {
    const w = await make(intake)
    const { reportId } = await w.published()
    const start = w.clock.now()
    // NOTE: the notification pass writes "told" and "reminded"; here
    // it is stood in for with the facts it would record.
    const record = (kind: 'notified' | 'reminded', accountId: string, at: number, detail?: string) =>
      Effect.runPromise(
        w.repository.recordEvent({
          reportId,
          kind,
          accountId,
          revisionNumber: 1,
          at,
          ...(detail === undefined ? {} : { detail }),
        }) as Effect.Effect<void>,
      )
    await record('notified', 'carol', start + 1_000)
    await record('notified', 'dan', start + 2_000)
    await record('reminded', 'dan', start + 3_600_000, 'reminder_first')

    w.clock.advance(5 * 60_000)
    await w.call('carol', c => c.GetRevisionOutline({ reportId, revision: 1 }))
    const readAt = w.clock.now()
    w.clock.advance(10 * 60_000)
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    const reviewedAt = w.clock.now()
    w.clock.advance(5 * 60_000)
    await w.call('alice', c => c.AddCoAuthor({ reportId, accountId: 'bob' }))
    await w.call('bob', c => c.GetDraftOutline({ reportId, draft: 1 }))
    const draftReadAt = w.clock.now()

    const view = await w.call('alice', c => c.GetGrid({ reportId }))
    const row = view.grid.revisions[0]
    const carol = row?.cells.find(cell => cell.accountId === 'carol')
    const dan = row?.cells.find(cell => cell.accountId === 'dan')
    // Each fact has a time; what did not happen has none.
    expect(carol?.read?.at).toBe(readAt)
    expect(carol?.decision?.at).toBe(reviewedAt)
    expect(carol?.reviews).toHaveLength(1)
    expect(carol?.reviews[0]).toMatchObject({ decision: 'approve', at: reviewedAt, standing: true })
    expect(dan?.read).toBeUndefined()
    expect(dan?.decision).toBeUndefined()
    expect(carol?.sent?.at).toBe(start + 1_000)
    expect(dan?.sent?.at).toBe(start + 2_000)
    expect(dan?.reminders).toEqual([{ kind: 'reminder_first', at: start + 3_600_000 }])
    expect(carol?.reminders).toEqual([])
    expect(row?.publishedAt).toBeLessThanOrEqual(start)
    expect(row?.deadline).toBeGreaterThan(start)

    const draft = view.grid.drafts.find(d => d.draft === 1)
    expect(draft?.sharedBy).toBe('alice')
    expect(draft?.sharedAt).toBeLessThanOrEqual(start)
    expect(draft?.cells.find(cell => cell.accountId === 'bob')?.read?.at).toBe(draftReadAt)
    expect(draft?.cells.find(cell => cell.accountId === 'alice')?.shared?.at).toBe(draft?.sharedAt)

    // A reviewer who is not an author cannot see the grid.
    expect(tagOf(await w.refused('dan', c => c.GetGrid({ reportId })))).toBe('NotFound')
    expect(tagOf(await w.refused('frank', c => c.GetGrid({ reportId })))).toBe('NotFound')
  })
})

// NOTE: regression: a closing revision was published with
// no check: a draft shared while the first round was open (an unreviewed change
// to the summary) could become the closing revision, and a closing revision
// could have no conclusion.
describe('regression: the closing revision is checked when it is published', () => {
  const conclusion = intake.conclusion!

  const concluding = async () => {
    const w = await make(intake)
    const { reportId } = await w.published()
    // Draft 2: shared while Revision 1 is open, with a summary nobody reviewed.
    const { outcome } = await w.share('alice', reportId, {
      shareId: 's2',
      content: richContent(intake.itemId, 'UNREVIEWED CHANGE.'),
    })
    if (outcome.kind !== 'shared') throw new Error('not shared')
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    await w.call('alice', c => c.StartConclusion({ reportId }))
    return { w, reportId, draft2: outcome.draft.number }
  }

  test('a draft that changed another section cannot be published as the closing revision', async () => {
    const { w, reportId, draft2 } = await concluding()
    // The helper confirms the redaction first, as the browser does.
    const error = await w.publish('alice', reportId, draft2, true).then(
      () => 'published',
      (failure: Error) => failure.message,
    )
    expect(error).not.toBe('published')
    expect(error).toContain('other_sections_changed')
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('concluding')
  })

  test('a closing revision with no conclusion is refused, on its own and as share and publish', async () => {
    const w = await make(intake)
    const { reportId } = await w.published()
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    await w.call('alice', c => c.StartConclusion({ reportId }))
    const copy = await w.call('alice', c => c.StartWorkingCopy({ reportId }))
    // Shared with the conclusion still empty: allowed, it is only a draft.
    const { outcome } = await w.stageAndFinish('alice', reportId, 's2', copy.saveCounter)
    if (outcome.kind !== 'shared') throw new Error('not shared')
    const alone = await w.publish('alice', reportId, outcome.draft.number, true).then(
      () => 'published',
      (failure: Error) => failure.message,
    )
    expect(alone).toContain('conclusion_empty')

    // Share and publish in one step is refused the same way, and nothing is written.
    const copy2 = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
    const together = await w
      .stageAndFinish('alice', reportId, 's3', copy2.saveCounter, true, true)
      .then(
        () => 'published',
        (failure: Error) => failure.message,
      )
    expect(together).toContain('conclusion_empty')
    expect((await w.call('alice', c => c.GetHistory({ reportId }))).revisions).toHaveLength(1)

    // With the conclusion written it goes through.
    const written = await w.call('alice', c =>
      c.SaveSection({
        reportId,
        sectionId: conclusion.sectionId,
        saveCounter: copy2.saveCounter,
        content: richContent(conclusion.itemId, 'Closed.'),
      }),
    )
    const done = await w.stageAndFinish('alice', reportId, 's4', written.saveCounter, true, true)
    expect(done.outcome).toMatchObject({ kind: 'shared', revision: { closing: true } })
  })
})

describe('removing a reviewer (D6)', () => {
  test('a reviewer with a standing decision cannot be removed; one who only commented can', async () => {
    const w = await make(intake)
    const { reportId } = await w.published()
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    expect(
      await w.refused('alice', c => c.RemoveReviewer({ reportId, revision: 1, accountId: 'carol' })),
    ).toMatchObject({ _tag: 'NotAllowedInState', code: 'reviewer_has_decision' })
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'request_changes' }))
    expect(
      await w.refused('alice', c => c.RemoveReviewer({ reportId, revision: 1, accountId: 'dan' })),
    ).toMatchObject({ _tag: 'NotAllowedInState', code: 'reviewer_has_decision' })
    // Nothing changed: both are still in the round.
    const round = await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))
    expect(round.participants.filter(p => p.removed !== true).map(p => p.accountId).sort()).toEqual(['carol', 'dan'])
  })

  test('removing a silent reviewer can complete the rule: the round is decided and the removed reviewer is told', async () => {
    const w = await make(intake)
    const { reportId } = await w.published()
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('in_review')
    const round = await w.call('alice', c => c.RemoveReviewer({ reportId, revision: 1, accountId: 'dan' }))
    expect(round).toMatchObject({ status: 'decided', decidedBy: 'rule_met' })
    expect((await w.call('alice', c => c.GetReport({ reportId }))).summary.state).toBe('decided')
    // NOTE: the pass that delivers jobs is stood in for here.
    const keys = await Effect.runPromise(w.repository.listJobKeys(reportId) as unknown as Effect.Effect<ReadonlyArray<string>>)
    expect(keys.filter(key => key.includes('removed_from_round'))).toHaveLength(1)
    const claimed = await Effect.runPromise(
      w.repository.claimDueJobs({ now: w.clock.now() + 1, limit: 100, leaseMs: 60_000, claimedBy: 'test' }) as unknown as Effect.Effect<ReadonlyArray<{ id: number }>>,
    )
    await Effect.runPromise(
      w.repository.finishJobs({ claimedBy: 'test', done: claimed.map(job => job.id), skipped: [], now: w.clock.now() + 2 }) as unknown as Effect.Effect<void>,
    )
    const told = await w.call('dan', c => c.ListNotifications({ limit: 20 }))
    expect(told.items.map(item => item.kind)).toContain('removed_from_round')
    // The other reviewer is not told of it.
    const other = await w.call('carol', c => c.ListNotifications({ limit: 20 }))
    expect(other.items.map(item => item.kind)).not.toContain('removed_from_round')
    const log = await w.call('alice', c => c.ListAuditEvents({ subject: { kind: 'report', reportId }, limit: 50 }))
    expect(log.events.map(event => event.action)).toEqual(
      expect.arrayContaining(['round.reviewer_removed', 'round.decided']),
    )
  })
})

describe('deadlines are bounded', () => {
  const YEAR = 366 * DAY

  test('publishing and extending refuse a deadline more than a year ahead, and accept one just inside', async () => {
    const w = await make(intake)
    const reportId = await w.createReport()
    const { outcome } = await w.share('alice', reportId, { shareId: 's1', people: PEOPLE })
    if (outcome.kind !== 'shared') throw new Error('not shared')
    const draft = outcome.draft.number
    // The browser confirms the redaction first; the helper publishes with its own terms.
    const tooFar = await w.publish('alice', reportId, draft, false, w.clock.now() + 2 * YEAR).then(
      () => 'published',
      (failure: Error) => failure.message,
    )
    expect(tooFar).toContain('deadline_too_far')
    const ok = await w.publish('alice', reportId, draft, false, w.clock.now() + YEAR - 1)
    expect(ok.revision.number).toBe(1)

    const refused = await w.refused('alice', c =>
      c.ExtendDeadline({ reportId, revision: 1, deadline: { at: 8.7e15, timeZone: 'UTC' } }),
    )
    expect(refused).toMatchObject({ _tag: 'Validation' })
    expect(JSON.stringify(refused)).toContain('deadline_too_far')
    const kept = await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))
    expect(kept.deadline.at).toBeLessThanOrEqual(w.clock.now() + YEAR)
    const extended = await w.call('alice', c =>
      c.ExtendDeadline({ reportId, revision: 1, deadline: { at: w.clock.now() + YEAR, timeZone: 'UTC' } }),
    )
    expect(extended.deadline.at).toBe(w.clock.now() + YEAR)
  })
})
