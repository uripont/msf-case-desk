import { Effect, Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { CaseId, Repository } from '@case-desk/domain'
import {
  SYNTHETIC_ENTRY,
  SYNTHETIC_USER,
  repositoryContract,
} from '@case-desk/domain/testing'

import { layerSql, makeSqlRepository } from './d1Repository'
import { makeNodeSqlite } from './testing/nodeSqlite'

repositoryContract('SQL', () => layerSql(makeNodeSqlite()))

describe('SQL repository and newer versions', () => {
  const setup = () => {
    const db = makeNodeSqlite()
    const repository = makeSqlRepository(db)
    return { db, repository }
  }

  test('rows written by a newer version are still read', async () => {
    const { db, repository } = setup()
    db.raw.exec(`ALTER TABLE cases ADD COLUMN programme TEXT`)
    db.raw
      .prepare(
        `INSERT INTO cases (id, centre, received_at, summary, scope, risk,
          urgency, fast_track_signals, channel, programme)
        VALUES ('CD-N', 'OCZ', 5, 'Synthetic.', 'Team', 'Critical',
          'Routine', '["Retaliation","NewSignal"]', NULL, 'Added later')`,
      )
      .run()
    const cases = await Effect.runPromise(repository.listCases())
    expect(cases).toEqual([
      expect.objectContaining({
        id: 'CD-N',
        centre: 'Unknown',
        risk: 'Unknown',
        channel: 'Unknown',
        fastTrackSignals: ['Retaliation', 'Unknown'],
        details: '',
        schemaVersion: 1,
      }),
    ])
  })

  test('editing signals keeps the ones a newer version added', async () => {
    const { db, repository } = setup()
    const id = CaseId.make('CD-S')
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repository.createUser(SYNTHETIC_USER)
        yield* repository.createCase({
          id,
          entry: SYNTHETIC_ENTRY,
          enteredAt: 0,
          enteredBy: SYNTHETIC_USER.id,
        })
      }),
    )
    db.raw
      .prepare(`UPDATE cases SET fast_track_signals = ? WHERE id = ?`)
      .run('["Retaliation","NewSignal"]', id)
    await Effect.runPromise(
      repository.updateCase(id, { fastTrackSignals: ['Exploitation'] }),
    )
    const stored = db.raw
      .prepare('SELECT fast_track_signals FROM cases WHERE id = ?')
      .get(id)
    expect(stored).toEqual({
      fast_track_signals: '["Exploitation","NewSignal"]',
    })
  })

  test('an update writes only the columns it names', async () => {
    const { db, repository } = setup()
    const id = CaseId.make('CD-C')
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repository.createUser(SYNTHETIC_USER)
        yield* repository.createCase({
          id,
          entry: SYNTHETIC_ENTRY,
          enteredAt: 0,
          enteredBy: SYNTHETIC_USER.id,
        })
      }),
    )
    db.raw.exec(`ALTER TABLE cases ADD COLUMN programme TEXT`)
    db.raw.prepare(`UPDATE cases SET programme = 'Kept' WHERE id = ?`).run(id)
    const updated = await Effect.runPromise(
      repository.updateCase(id, { risk: 'High' }),
    )
    expect(Option.map(updated, found => found.risk)).toEqual(
      Option.some('High'),
    )
    expect(
      db.raw.prepare('SELECT programme FROM cases WHERE id = ?').get(id),
    ).toEqual({ programme: 'Kept' })
  })

  test('the service resolves through its Layer', async () => {
    const cases = await Effect.runPromise(
      Effect.flatMap(Repository, repository => repository.listCases()).pipe(
        Effect.provide(layerSql(makeNodeSqlite())),
      ),
    )
    expect(cases).toEqual([])
  })
})
