import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'

import { Repository } from '@quoroom/domain'
import { repositoryContract } from '@quoroom/domain/testing'

import { layerSql } from './d1Repository'
import { makeNodeSqlite } from './testing/nodeSqlite'

repositoryContract('SQL', () => layerSql(makeNodeSqlite()))

describe('SQL repository', () => {
  test('the service resolves through its Layer', async () => {
    const found = await Effect.runPromise(
      Effect.flatMap(Repository, repository =>
        repository.findUserByEmail('nobody@case-desk.test'),
      ).pipe(Effect.provide(layerSql(makeNodeSqlite()))),
    )
    expect(found._tag).toBe('None')
  })
})
