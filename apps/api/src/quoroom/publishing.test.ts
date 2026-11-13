import { Effect } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'

import { SCENARIOS, type World, makeWorld, PEOPLE } from './testkit'

// NOTE: Publishing (stage 6a) through the real RPC stack: a revision replaces
// the open round and its reviewers are told, a choice that cannot meet the
// approval rule is refused, a redacted role is refused without the confirmed
// preview (on both publish paths), and the deadline keeps its time zone. All
// people and data are invented.

const worlds: Array<World> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A>)

describe.each(SCENARIOS)('$name', scenario => {
  const world = async () => {
    const made = await makeWorld(scenario)
    worlds.push(made)
    return made
  }

  test('publishing Revision 2 supersedes the open round and its reviewers are told', async () => {
    const w = await world()
    const { reportId } = await w.published()
    const second = await w.share('alice', reportId, {
      shareId: 'share-2',
      people: PEOPLE,
      confirm: true,
    })
    if (second.outcome.kind !== 'shared') throw new Error('not shared')
    const result = await w.publish('alice', reportId, second.outcome.draft.number)
    expect(result.revision).toMatchObject({ number: 2, status: 'open' })

    const history = await w.call('alice', c => c.GetHistory({ reportId }))
    expect(history.revisions.find(entry => entry.number === 1)).toMatchObject({
      status: 'superseded',
      replacedBy: 2,
    })
    expect(history.revisions.find(entry => entry.number === 2)?.status).toBe('open')
    expect(
      (await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))).status,
    ).toBe('superseded')
    const detail = await w.call('alice', c => c.GetReport({ reportId }))
    expect(detail.summary).toMatchObject({ latestRevision: 2, state: 'in_review' })

    const keys = await run(w.repository.listJobKeys(reportId))
    const replaced = keys.filter(key => key.includes('revision_replaced'))
    expect(replaced.some(key => key.includes('carol'))).toBe(true)
    expect(replaced.some(key => key.includes('dan'))).toBe(true)
  })

  test('a choice that cannot meet the approval rule is refused before anything is written', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const shared = await w.share('alice', reportId, {
      shareId: 'share-r',
      people: PEOPLE,
      confirm: true,
    })
    if (shared.outcome.kind !== 'shared') throw new Error('not shared')
    const draft = shared.outcome.draft.number
    const publishWith = (selections: ReturnType<typeof w.selections>) =>
      w.refused('alice', c =>
        c.PublishRevision({
          reportId,
          draft,
          terms: { deadline: w.deadline(), selections, closing: false },
        }),
      )
    const nobody = await publishWith(
      w.selections().filter(entry => entry.roleId !== scenario.redactedRole),
    )
    expect(nobody).toMatchObject({ _tag: 'Validation' })
    expect(JSON.stringify(nobody)).toContain('no_voters')
    if (scenario.fullRole !== undefined) {
      const tooFew = await publishWith(
        w.selections().map(entry =>
          entry.roleId === scenario.redactedRole
            ? { ...entry, sources: entry.sources.slice(0, 1) }
            : entry,
        ),
      )
      expect(JSON.stringify(tooFew)).toContain('rule_unmeetable')
    }
    const after = await w.call('alice', c => c.GetReport({ reportId }))
    expect(after.summary.state).toBe('drafting')
    expect(after.summary.latestRevision).toBeUndefined()
  })

  test('a redacted role is refused without the confirmed preview, on both publish paths', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const { outcome } = await w.share('alice', reportId, {
      shareId: 'share-n',
      people: PEOPLE,
    })
    if (outcome.kind !== 'shared') throw new Error('not shared')
    const choices = await w.call('alice', c => c.GetPublishChoices({ reportId }))
    expect(choices.redactionConfirmed).toBe(false)
    const terms = { deadline: w.deadline(), selections: w.selections(), closing: false }
    const direct = await w.refused('alice', c =>
      c.PublishRevision({ reportId, draft: outcome.draft.number, terms }),
    )
    expect(JSON.stringify(direct)).toContain('redaction_not_confirmed')

    const copy = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
    const saved = await w.call('alice', c =>
      c.SaveSection({
        reportId,
        sectionId: scenario.sectionId,
        saveCounter: copy.saveCounter,
        content: {
          values: {
            [scenario.itemId]: {
              type: 'rich_text',
              doc: {
                type: 'doc',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: 'A changed text.' }] },
                ],
              },
            },
          },
          sections: {},
        },
      }),
    )
    const staged = await w.call('alice', c =>
      c.ShareSection({
        reportId,
        shareId: 'share-p',
        sectionId: scenario.sectionId,
        saveCounter: saved.saveCounter,
      }),
    )
    expect(staged.redactedHash.length).toBeGreaterThan(0)
    const outline = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
    const others = outline.sections.filter(section => section.sectionId !== scenario.sectionId)
    for (const section of others) {
      await w.call('alice', c =>
        c.ShareSection({
          reportId,
          shareId: 'share-p',
          sectionId: section.sectionId,
          saveCounter: saved.saveCounter,
        }),
      )
    }
    const combined = await w.refused('alice', c =>
      c.FinishShare({
        reportId,
        shareId: 'share-p',
        saveCounter: saved.saveCounter,
        publish: terms,
      }),
    )
    expect(JSON.stringify(combined)).toContain('redaction_not_confirmed')
    const latest = await w.call('alice', c => c.GetReport({ reportId }))
    expect(latest.summary.latestRevision).toBeUndefined()
  })

  test('the deadline keeps the time zone the author chose', async () => {
    const w = await world()
    const reportId = await w.createReport()
    const shared = await w.share('alice', reportId, {
      shareId: 'share-z',
      people: PEOPLE,
      confirm: true,
    })
    if (shared.outcome.kind !== 'shared') throw new Error('not shared')
    const draft = shared.outcome.draft.number
    const at = w.clock.now() + 5 * 24 * 3_600_000
    const unknown = await w.refused('alice', c =>
      c.PublishRevision({
        reportId,
        draft,
        terms: { deadline: { at, timeZone: 'Not/AZone' }, selections: w.selections(), closing: false },
      }),
    )
    expect(JSON.stringify(unknown)).toContain('unknown_time_zone')
    const past = await w.refused('alice', c =>
      c.PublishRevision({
        reportId,
        draft,
        terms: {
          deadline: { at: w.clock.now() - 1, timeZone: 'Europe/Madrid' },
          selections: w.selections(),
          closing: false,
        },
      }),
    )
    expect(past).toMatchObject({ _tag: 'DeadlinePassed' })
    // NOTE: a preview of the confirmation is only needed once.
    const published = await w.call('alice', c =>
      c.PublishRevision({
        reportId,
        draft,
        terms: {
          deadline: { at, timeZone: 'Asia/Tokyo' },
          selections: w.selections(),
          closing: false,
        },
      }),
    )
    expect(published.revision.deadline).toEqual({ at, timeZone: 'Asia/Tokyo' })
    const stored = await run(w.repository.getRound(reportId, 1))
    expect(stored?.round).toMatchObject({ deadlineAt: at, deadlineZone: 'Asia/Tokyo' })
    const round = await w.call('alice', c => c.GetRound({ reportId, revision: 1 }))
    expect(round.deadline).toEqual({ at, timeZone: 'Asia/Tokyo' })
  })
})
