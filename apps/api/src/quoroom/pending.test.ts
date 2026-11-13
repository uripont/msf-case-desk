import { afterEach, describe, expect, test } from 'vitest'

import { PEOPLE, SCENARIOS, type World, makeWorld } from './testkit'

// NOTE: A reviewer's unsent comments belong to an open round only. Once the
// round is superseded they are not pending any more: the inbox does not show
// them as pending, the pending list leaves them out, and they can no longer be
// edited or deleted. All people and data are invented.

const worlds: Array<World> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

const tagOf = (error: unknown): string =>
  (error as { _tag?: string })._tag ?? 'unknown'

describe.each(SCENARIOS)('$name', scenario => {
  test('pending counts and edits stop when the round is not open', async () => {
    const w = await makeWorld(scenario)
    worlds.push(w)
    const { reportId } = await w.published()
    const anchor = { kind: 'section' as const, sectionId: scenario.sectionId }
    const first = await w.call('carol', c =>
      c.AddComment({ reportId, revision: 1, anchor, body: 'Unsent one.', visibility: 'authors' }),
    )
    const second = await w.call('carol', c =>
      c.AddComment({ reportId, revision: 1, anchor, body: 'Unsent two.', visibility: 'authors' }),
    )
    const before = await w.call('carol', c => c.ListInbox({}))
    expect(before.items.find(item => item.revision === 1)?.hasPending).toBe(true)

    const next = await w.share('alice', reportId, {
      shareId: 'share-2',
      people: PEOPLE,
      confirm: true,
    })
    if (next.outcome.kind !== 'shared') throw new Error('not shared')
    await w.publish('alice', reportId, next.outcome.draft.number)

    const inbox = await w.call('carol', c => c.ListInbox({}))
    expect(inbox.items.find(item => item.revision === 1)?.hasPending).toBe(false)
    const pending = await w.call('carol', c => c.ListPendingReviews())
    expect(pending.find(item => item.revision === 1)).toBeUndefined()

    expect(
      tagOf(
        await w.refused('carol', c =>
          c.UpdatePendingComment({ reportId, commentId: first.id, body: 'Edited late.' }),
        ),
      ),
    ).not.toBe('unknown')
    expect(
      tagOf(
        await w.refused('carol', c => c.DeletePendingComment({ reportId, commentId: second.id })),
      ),
    ).not.toBe('unknown')
    // NOTE: the store itself refuses too, whatever the handler checks.
    const stored = await w.call('carol', c => c.ListReviewerComments({ reportId, revision: 1 }))
    expect(stored.map(entry => entry.body).sort()).toEqual(['Unsent one.', 'Unsent two.'])
  })
})

describe.each(SCENARIOS)('$name', scenario => {
  test('a review is sent only with the pending comments the reviewer saw', async () => {
    const w = await makeWorld(scenario)
    worlds.push(w)
    const { reportId } = await w.published()
    const anchor = { kind: 'section' as const, sectionId: scenario.sectionId }
    const one = await w.call('carol', c =>
      c.AddComment({ reportId, revision: 1, anchor, body: 'Seen.', visibility: 'authors' }),
    )
    // NOTE: a comment added after the dialog read the list (another tab).
    const late = await w.call('carol', c =>
      c.AddComment({ reportId, revision: 1, anchor, body: 'Unseen.', visibility: 'committee' }),
    )
    const refusal = async (commentIds: Array<string>) =>
      tagOf(
        await w.refused('carol', c =>
          c.SendReview({ reportId, revision: 1, decision: 'comment', commentIds }),
        ),
      )
    expect(await refusal([one.id])).toBe('Conflict')
    expect(await refusal([])).toBe('Conflict')
    expect(await refusal([one.id, one.id])).toBe('Conflict')
    expect(await refusal([one.id, late.id, 'invented'])).toBe('Conflict')
    // NOTE: nothing was sent by the refusals.
    const still = await w.call('carol', c => c.ListReviewerComments({ reportId, revision: 1 }))
    expect(still.every(comment => comment.sent === false)).toBe(true)
    const sent = await w.call('carol', c =>
      c.SendReview({
        reportId,
        revision: 1,
        decision: 'comment',
        commentIds: [late.id, one.id],
      }),
    )
    expect(sent.commentsSent).toBe(2)
  })
})
