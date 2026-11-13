import { DatabaseSync } from 'node:sqlite'

import { type SqlRow, type SqlValue } from '../sql'

// NOTE: a local model of D1's documented behaviour, on Node's SQLite: `batch`
// runs its statements in one transaction in order, stops at the first error
// and rolls everything back; each result has `results` and `meta.changes`.
// No Miniflare or wrangler is installed in this repository (and plain
// workerd has no D1), so this is the closest faithful local option. The
// guard check in `runBatch` was confirmed on a real throwaway D1 database on
// 12 Nov 2026: D1 keeps
// `changes()` across the batch's statements, rolls the batch back on the
// overflow error, and reports it as
// `D1_ERROR: integer overflow: SQLITE_ERROR` with the SQLite message as
// `cause`. Errors here carry the same shape.
export const makeFakeD1 = (
  migrations: ReadonlyArray<string> = [],
): D1Database => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrations.forEach(migration => db.exec(migration))
  const execute = (query: string, values: ReadonlyArray<SqlValue>) => {
    const before = (
      db.prepare('SELECT total_changes() AS n').get() as { n: number }
    ).n
    let results: Array<SqlRow>
    try {
      results = db.prepare(query).all(...values) as Array<SqlRow>
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error))
      throw new Error(`D1_ERROR: ${cause.message}: SQLITE_ERROR`, { cause })
    }
    const after = (
      db.prepare('SELECT total_changes() AS n').get() as { n: number }
    ).n
    return { success: true, results, meta: { changes: after - before } }
  }
  const prepared = (query: string, values: ReadonlyArray<SqlValue>) => ({
    query,
    values,
    bind: (...next: Array<SqlValue>) => prepared(query, next),
    all: () => Promise.resolve(execute(query, values)),
    first: () => Promise.resolve(execute(query, values).results[0] ?? null),
    run: () => Promise.resolve(execute(query, values)),
  })
  const fake = {
    prepare: (query: string) => prepared(query, []),
    batch: (statements: Array<ReturnType<typeof prepared>>) => {
      db.exec('BEGIN')
      try {
        const results = statements.map(s => execute(s.query, s.values))
        db.exec('COMMIT')
        return Promise.resolve(results)
      } catch (error) {
        db.exec('ROLLBACK')
        return Promise.reject(error)
      }
    },
  }
  return fake as unknown as D1Database
}
