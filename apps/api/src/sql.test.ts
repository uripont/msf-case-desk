import { afterAll } from 'vitest'

import { fromD1 } from './sql'
import { makeFakeD1 } from './testing/fakeD1'
import { makeNodeSqlite } from './testing/nodeSqlite'
import { sqlBatchContract } from './testing/sqlContract'
import { startWorkerd } from './testing/workerdSqlite'

sqlBatchContract('Node SQLite (test adapter)', () => makeNodeSqlite([]))

sqlBatchContract('D1 adapter (D1 batch semantics on local SQLite)', () =>
  fromD1(makeFakeD1()),
)

const workerd = await startWorkerd()
afterAll(() => workerd.stop())
let databases = 0
sqlBatchContract('workerd Durable Object SQLite', () =>
  workerd.open(`contract-${(databases += 1)}`),
)
