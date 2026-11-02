import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { type SqlDatabase, type SqlStatement, type SqlValue } from '../sql'

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
): SqlDatabase & { readonly raw: DatabaseSync } => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrations.forEach(migration => db.exec(migration))
  return { raw: db, prepare: query => statement(db, query, []) }
}
