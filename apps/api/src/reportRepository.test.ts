import { Effect } from 'effect'
import { afterAll, describe, expect, test } from 'vitest'

import { QUERY_BUDGET, type ReportRepositoryApi } from '@case-desk/domain'
import {
  type HarnessFactory,
  reportRepositoryContract,
} from '@case-desk/domain/testing/report-repository'

import { makeSqlReportRepository } from './reportRepository'
import { type SqlStore, fromD1 } from './sql'
import { makeFakeD1 } from './testing/fakeD1'
import { makeNodeSqlite, migrationFiles } from './testing/nodeSqlite'
import { startWorkerd } from './testing/workerdSqlite'

// NOTE: the most queries each operation made in any contract run, per adapter.
const seen = new Map<string, Map<string, number>>()

const sqlHarness =
  (adapter: string, open: () => SqlStore): HarnessFactory =>
  async options => {
    const store = open()
    const counts = seen.get(adapter) ?? new Map<string, number>()
    seen.set(adapter, counts)
    const repository: ReportRepositoryApi = makeSqlReportRepository(store, {
      onQueries: (operation, queries) =>
        counts.set(operation, Math.max(counts.get(operation) ?? 0, queries)),
    })
    if (options?.initialImageBytes !== undefined) {
      await store
        .prepare("UPDATE storage_stats SET value = ? WHERE key = 'image_bytes'")
        .bind(options.initialImageBytes)
        .run()
    }
    return {
      repository,
      seedSession: async (tokenHash, userId) => {
        await store
          .prepare(
            'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, 0, 9999999999)',
          )
          .bind(tokenHash, userId)
          .run()
      },
      countSessions: async userId =>
        Number(
          (
            await store
              .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
              .bind(userId)
              .first<{ n: number }>()
          )?.n,
        ),
    }
  }

reportRepositoryContract(
  'SQL on Node SQLite',
  sqlHarness('node', () => makeNodeSqlite()),
)

reportRepositoryContract(
  'SQL on the D1 batch model',
  sqlHarness('d1', () => fromD1(makeFakeD1(migrationFiles()))),
)

const workerd = await startWorkerd(migrationFiles())
afterAll(() => workerd.stop())
let databases = 0
reportRepositoryContract(
  'SQL on workerd Durable Object SQLite',
  sqlHarness('workerd', () => workerd.open(`report-${(databases += 1)}`)),
)

// NOTE: runs after the contract suites above (tests run in file order).
describe('query budget', () => {
  test.each(['node', 'd1', 'workerd'])(
    'every operation stays within its budget on %s',
    adapter => {
      const counts = seen.get(adapter) ?? new Map<string, number>()
      const over = [...counts].filter(
        ([operation, queries]) =>
          queries > (QUERY_BUDGET as Record<string, number>)[operation]!,
      )
      expect(over).toEqual([])
      for (const [operation, budget] of Object.entries(QUERY_BUDGET)) {
        expect(budget, operation).toBeLessThanOrEqual(50)
      }
    },
  )

  test('every operation is exercised by the contract', () => {
    const counts = seen.get('node') ?? new Map<string, number>()
    const missing = Object.keys(QUERY_BUDGET).filter(
      operation => !counts.has(operation),
    )
    expect(missing).toEqual([])
  })
})

void Effect
