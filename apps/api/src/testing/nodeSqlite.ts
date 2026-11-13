import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  type SqlRow,
  type SqlStatement,
  type SqlStore,
  type SqlValue,
} from '../sql'

export const MIGRATIONS_DIR = join(import.meta.dirname, '../../migrations')

export const migrationFiles = (dir = MIGRATIONS_DIR): ReadonlyArray<string> =>
  readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => readFileSync(join(dir, file), 'utf8'))

const statement = (
  db: DatabaseSync,
  query: string,
  values: ReadonlyArray<SqlValue>,
): SqlStatement => ({
  bind: (...next) => statement(db, query, next),
  all: <T>() =>
    Promise.resolve({
      results: db.prepare(query).all(...values) as Array<T>,
    }),
  first: <T>() =>
    Promise.resolve((db.prepare(query).get(...values) ?? null) as T | null),
  run: () => Promise.resolve(db.prepare(query).run(...values)),
})

// NOTE: a test double for D1 on Node's built-in SQLite, with every migration
// applied in order, as Alchemy applies them to D1.
export const makeNodeSqlite = (
  migrations: ReadonlyArray<string> = migrationFiles(),
): SqlStore & { readonly raw: DatabaseSync } => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrations.forEach(migration => db.exec(migration))
  const total = (): number =>
    (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  return {
    raw: db,
    prepare: query => statement(db, query, []),
    // NOTE: a transaction, as D1's batch is one. The work is synchronous, so
    // nothing else runs on the connection between BEGIN and COMMIT.
    batch: steps => {
      db.exec('BEGIN')
      try {
        const results = steps.map(step => {
          const before = total()
          const rows = db.prepare(step.sql).all(...step.values) as Array<SqlRow>
          return { changes: total() - before, rows }
        })
        db.exec('COMMIT')
        return Promise.resolve(results)
      } catch (error) {
        db.exec('ROLLBACK')
        return Promise.reject(error)
      }
    },
  }
}
