import { afterEach, describe, expect, test } from 'vitest'

import { INTAKE_TEMPLATE } from '@case-desk/domain'

import { makePng } from './imageFixtures'
import {
  PEOPLE,
  type Scenario,
  type World,
  makeWorld,
  richContent,
  withFigure,
} from './testkit'

// NOTE: One table over every procedure that writes the content of a working
// copy, in every report state (D18): drafting continues in every state but
// `archived`; while `concluding` only the conclusion can be written; the
// conclusion can be written in no other state. The rule is `checkSave`, and
// each writer applies it to the sections it touches.

const worlds: Array<World> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

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

type State = 'drafting' | 'in_review' | 'decided' | 'concluding' | 'archived'
const STATES: ReadonlyArray<State> = [
  'drafting',
  'in_review',
  'decided',
  'concluding',
  'archived',
]

const upload = async (w: World, reportId: string, uploadId: string) => {
  const png = makePng()
  const response = await w.raw(
    'alice',
    `/api/images?uploadId=${uploadId}&owner=${reportId}&index=0&chunks=1&mime=image%2Fpng&width=1&height=1&size=${png.length}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: png,
    },
  )
  expect(response.status).toBeLessThan(300)
}

// NOTE: a report in `state`, with Draft 1 shared by alice (her working copy is
// based on it) and, unless archived, Draft 2 shared by bob with another summary,
// so alice's working copy is behind and a merge changes her summary.
const reach = async (w: World, state: State) => {
  const reportId = await w.createReport()
  await upload(w, reportId, 'img-s')
  await upload(w, reportId, 'img-c')
  const first = await w.share('alice', reportId, {
    shareId: 's1',
    people: PEOPLE,
    content: withFigure('summary-text', 'Hello', 'img-s', false) as never,
  })
  if (first.outcome.kind !== 'shared') throw new Error('not shared')
  if (state !== 'drafting') await w.publish('alice', reportId, first.outcome.draft.number)
  if (state !== 'archived') {
    await w.call('alice', c => c.AddCoAuthor({ reportId, accountId: 'bob' }))
    await w.share('bob', reportId, {
      shareId: 's2',
      content: richContent('summary-text', 'Bob changed the summary.'),
    })
  }
  if (state === 'decided' || state === 'concluding' || state === 'archived') {
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
  }
  if (state === 'concluding' || state === 'archived') {
    await w.call('alice', c => c.StartConclusion({ reportId }))
  }
  if (state === 'archived') {
    const copy = await w.call('alice', c => c.StartWorkingCopy({ reportId }))
    const saved = await w.call('alice', c =>
      c.SaveSection({
        reportId,
        sectionId: 'committee-conclusion',
        saveCounter: copy.saveCounter,
        content: richContent('conclusion-decision', 'Closed.'),
      }),
    )
    const { outcome } = await w.stageAndFinish('alice', reportId, 's3', saved.saveCounter)
    if (outcome.kind !== 'shared') throw new Error('not shared')
    await w.publish('alice', reportId, outcome.draft.number, true)
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 2, decision: 'approve' }))
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 2, decision: 'approve' }))
  }
  const report = await w.call('alice', c => c.GetReport({ reportId }))
  expect(report.summary.state).toBe(state)
  return reportId
}

type Row = Readonly<{
  name: string
  // NOTE: the states in which the write is accepted; the others refuse it.
  accepted: ReadonlyArray<State>
  // NOTE: states the row is not about (the content it needs cannot exist).
  only?: ReadonlyArray<State>
  write: (w: World, reportId: string, counter: number) => Promise<unknown>
}>

const ROWS: ReadonlyArray<Row> = [
  {
    name: 'MarkImageSafe on an image in another section',
    accepted: ['drafting', 'in_review', 'decided'],
    write: (w, reportId, counter) =>
      w.attempt('alice', c =>
        c.MarkImageSafe({ reportId, imageId: 'img-s', safe: true, saveCounter: counter }),
      ),
  },
  {
    name: 'SavePeople',
    accepted: ['drafting', 'in_review', 'decided'],
    write: (w, reportId, counter) =>
      w.attempt('alice', c => c.SavePeople({ reportId, saveCounter: counter, people: PEOPLE })),
  },
  {
    name: 'ResolveMerge that changes another section',
    accepted: ['drafting', 'in_review', 'decided'],
    write: (w, reportId, counter) =>
      w.attempt('alice', c => c.ResolveMerge({ reportId, saveCounter: counter, choices: {} })),
  },
  {
    name: 'SaveSection of another section',
    accepted: ['drafting', 'in_review', 'decided'],
    write: (w, reportId, counter) =>
      w.attempt('alice', c =>
        c.SaveSection({
          reportId,
          sectionId: 'summary',
          saveCounter: counter,
          content: richContent('summary-text', 'Edited.'),
        }),
      ),
  },
  {
    name: 'SaveSection of the conclusion',
    accepted: ['concluding'],
    write: (w, reportId, counter) =>
      w.attempt('alice', c =>
        c.SaveSection({
          reportId,
          sectionId: 'committee-conclusion',
          saveCounter: counter,
          content: withFigure('conclusion-decision', 'Closed.', 'img-c', false) as never,
        }),
      ),
  },
  {
    name: 'MarkImageSafe on an image in the conclusion',
    accepted: ['concluding'],
    only: ['concluding', 'archived'],
    write: (w, reportId, counter) =>
      w.attempt('alice', c =>
        c.MarkImageSafe({ reportId, imageId: 'img-c', safe: true, saveCounter: counter }),
      ),
  },
]

describe('every writer of a working copy applies the save rule of the state', () => {
  for (const state of STATES) {
    test(`state ${state}`, async () => {
      const w = await makeWorld(intake)
      worlds.push(w)
      const reportId = await reach(w, state)
      for (const row of ROWS) {
        if (row.only !== undefined && !row.only.includes(state)) continue
        const outline = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
        const result = await row.write(w, reportId, outline.saveCounter)
        const failure = (result as { _tag: string; failure?: { _tag?: string } })
        const ok = failure._tag === 'Success'
        if (row.accepted.includes(state)) {
          expect(ok, `${row.name} in ${state}: ${JSON.stringify(result)}`).toBe(true)
        } else {
          expect(ok, `${row.name} in ${state} must be refused`).toBe(false)
          expect(
            ['NotAllowedInState', 'NotPermitted'],
            `${row.name} in ${state}: ${JSON.stringify(result)}`,
          ).toContain(failure.failure?._tag)
        }
      }
    })
  }
})

describe('a merge that only brings in the conclusion is accepted while concluding', () => {
  test('another author shared the conclusion; resolving changes only that section', async () => {
    const w = await makeWorld(intake)
    worlds.push(w)
    const { reportId } = await w.published()
    await w.call('carol', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    await w.call('dan', c => c.SendReview({ commentIds: [], reportId, revision: 1, decision: 'approve' }))
    await w.call('alice', c => c.StartConclusion({ reportId }))
    await w.call('alice', c => c.AddCoAuthor({ reportId, accountId: 'bob' }))
    const mine = await w.call('alice', c => c.GetWorkingCopy({ reportId }))
    const copy = await w.call('bob', c => c.StartWorkingCopy({ reportId }))
    const saved = await w.call('bob', c =>
      c.SaveSection({
        reportId,
        sectionId: 'committee-conclusion',
        saveCounter: copy.saveCounter,
        content: richContent('conclusion-decision', 'Bob wrote the conclusion.'),
      }),
    )
    await w.stageAndFinish('bob', reportId, 's2', saved.saveCounter)
    const resolved = await w.call('alice', c =>
      c.ResolveMerge({ reportId, saveCounter: mine.saveCounter, choices: {} }),
    )
    expect(resolved.behind).toBe(false)
  })
})
