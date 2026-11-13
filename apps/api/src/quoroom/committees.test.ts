import { afterEach, describe, expect, test } from 'vitest'

import { type World, SCENARIOS, makeWorld } from './testkit'

// NOTE: Two quick changes to one committee never lose one of them: the member
// changes are sent as add and remove operations, applied on the stored list,
// not as a whole list taken from a screen that may be a step behind.

const worlds: Array<World> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

describe.each(SCENARIOS)('$name', scenario => {
  test('adding and removing members applies to the stored list', async () => {
    const w = await makeWorld(scenario)
    worlds.push(w)
    const made = await w.call('alice', c =>
      c.CreateCommittee({ unit: 'unit-1', name: 'Quick Committee', memberIds: [] }),
    )
    const ids = (committee: { memberIds: ReadonlyArray<string> }) => [...committee.memberIds].sort()
    // NOTE: both requests carry no list that could overwrite the other.
    const [first, second] = await Promise.all([
      w.call('alice', c => c.UpdateCommittee({ committeeId: made.id, addMemberIds: ['carol'] })),
      w.call('alice', c => c.UpdateCommittee({ committeeId: made.id, addMemberIds: ['dan'] })),
    ])
    expect(first.memberIds.length).toBeGreaterThanOrEqual(1)
    expect(second.memberIds.length).toBeGreaterThanOrEqual(1)
    const both = await w.call('alice', c => c.ListCommittees({ unit: 'unit-1' }))
    expect(ids(both.find(c => c.id === made.id) ?? { memberIds: [] })).toEqual(['carol', 'dan'])

    const removed = await w.call('alice', c =>
      c.UpdateCommittee({ committeeId: made.id, removeMemberIds: ['carol'], addMemberIds: ['carol', 'dan'] }),
    )
    // NOTE: a removal and an addition of the same member: the addition wins.
    expect(ids(removed)).toEqual(['carol', 'dan'])
    const gone = await w.call('alice', c =>
      c.UpdateCommittee({ committeeId: made.id, removeMemberIds: ['carol'] }),
    )
    expect(ids(gone)).toEqual(['dan'])
    // NOTE: someone who is no reviewer of the unit cannot be added.
    expect(
      (
        await w.refused('alice', c =>
          c.UpdateCommittee({ committeeId: made.id, addMemberIds: ['alice'] }),
        )
      )._tag,
    ).toBe('Validation')
  })
})
