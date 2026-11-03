import { Effect } from 'effect'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { SEED_CASES } from '@case-desk/domain'

import { makeSqlRepository } from './d1Repository'
import { demoSeedSql } from './demoSeed'
import { makeNodeSqlite } from './testing/nodeSqlite'

const SEED_FILE = join(import.meta.dirname, '../seed/demo-cases.sql')

const refreshedOn = (sql: string): string =>
  /-- Refreshed: (.*)/.exec(sql)?.[1] ?? ''

// NOTE: `pnpm --filter @case-desk/api demo:seed` sets this to rewrite the
// file with a new refresh stamp, so the next deploy imports it again.
if (process.env['UPDATE_DEMO_SEED'] === '1') {
  writeFileSync(SEED_FILE, demoSeedSql(new Date().toISOString().slice(0, 16)))
}

describe('demo seed', () => {
  test('the committed seed file matches the domain seed cases', () => {
    const committed = readFileSync(SEED_FILE, 'utf8')
    expect(committed).toBe(demoSeedSql(refreshedOn(committed)))
  })

  test('importing it twice gives every seed case once', async () => {
    const db = makeNodeSqlite()
    const sql = readFileSync(SEED_FILE, 'utf8')
    db.raw.exec(sql)
    db.raw.exec(sql)
    const cases = await Effect.runPromise(makeSqlRepository(db).listCases())
    expect(cases.map(stored => stored.summary).sort()).toEqual(
      SEED_CASES.map(seed => seed.summary).sort(),
    )
  })
})
