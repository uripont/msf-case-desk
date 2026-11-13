import { describe, expect, test } from 'vitest'

import {
  MAX_BATCH_QUERIES,
  SqlBatchTooLarge,
  batchQueryCount,
  claim,
  runBatch,
  type SqlStore,
} from '../sql'

let counter = 0

// NOTE: one suite, run against every adapter. `open` returns an empty
// database (or a fresh name on a shared one); the suite creates its tables.
export const sqlBatchContract = (
  name: string,
  open: () => SqlStore | Promise<SqlStore>,
): void => {
  describe(`SQL batch contract: ${name}`, () => {
    const setup = async () => {
      const store = await open()
      counter += 1
      const reports = `reports_${counter}`
      const jobs = `jobs_${counter}`
      await store
        .prepare(
          `CREATE TABLE ${reports} (id TEXT PRIMARY KEY, version INTEGER NOT NULL)`,
        )
        .run()
      await store
        .prepare(
          `CREATE TABLE ${jobs} (id INTEGER PRIMARY KEY, due INTEGER NOT NULL, claimed_by TEXT)`,
        )
        .run()
      const count = async (table: string): Promise<number> =>
        (
          (await store
            .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
            .first<{ n: number }>()) as { n: number }
        ).n
      return { store, reports, jobs, count }
    }

    test('reports changed-row counts and RETURNING rows per statement', async () => {
      const { store, reports } = await setup()
      const outcome = await runBatch(store, [
        {
          sql: `INSERT INTO ${reports} (id, version) VALUES (?, ?), (?, ?), (?, ?)`,
          values: ['a', 1, 'b', 1, 'c', 1],
        },
        {
          sql: `UPDATE ${reports} SET version = version + 1 WHERE id IN (?, ?) RETURNING id, version`,
          values: ['a', 'b'],
        },
        { sql: `SELECT id FROM ${reports} ORDER BY id`, values: [] },
        { sql: `DELETE FROM ${reports} WHERE id = ?`, values: ['zzz'] },
      ])
      expect(outcome._tag).toBe('Committed')
      if (outcome._tag !== 'Committed') return
      const [insert, update, select, none] = outcome.results
      expect(insert?.changes).toBe(3)
      expect(insert?.rows).toEqual([])
      expect(update?.changes).toBe(2)
      expect(
        [...(update?.rows ?? [])].sort((x, y) =>
          String(x['id']).localeCompare(String(y['id'])),
        ),
      ).toEqual([
        { id: 'a', version: 2 },
        { id: 'b', version: 2 },
      ])
      expect(select?.rows).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
      expect(none?.changes).toBe(0)
    })

    test('an error in any statement undoes the whole batch', async () => {
      const { store, reports, count } = await setup()
      await expect(
        runBatch(store, [
          {
            sql: `INSERT INTO ${reports} (id, version) VALUES ('a', 1)`,
            values: [],
          },
          {
            sql: `INSERT INTO ${reports} (id, version) VALUES ('b', 1)`,
            values: [],
          },
          {
            sql: `INSERT INTO ${reports} (id, version) VALUES ('a', 9)`,
            values: [],
          },
        ]),
      ).rejects.toThrow()
      expect(await count(reports)).toBe(0)
    })

    test('an ordinary SQL error is rethrown, not reported as a conflict', async () => {
      const { store } = await setup()
      await expect(
        runBatch(store, [{ sql: 'SELECT * FROM no_such_table', values: [] }]),
      ).rejects.toThrow()
    })

    test('a passing guard lets the batch commit', async () => {
      const { store, reports } = await setup()
      await store
        .prepare(`INSERT INTO ${reports} (id, version) VALUES ('r', 3)`)
        .run()
      const outcome = await runBatch(store, [
        {
          sql: `UPDATE ${reports} SET version = version + 1 WHERE id = ? AND version = ?`,
          values: ['r', 3],
          expectChanges: 1,
        },
        {
          sql: `INSERT INTO ${reports} (id, version) SELECT 'audit', version FROM ${reports} WHERE id = ?`,
          values: ['r'],
        },
      ])
      expect(outcome._tag).toBe('Committed')
      if (outcome._tag !== 'Committed') return
      expect(outcome.results).toHaveLength(2)
      expect(outcome.results.map(result => result.changes)).toEqual([1, 1])
      expect(
        (
          await store
            .prepare(`SELECT id, version FROM ${reports} ORDER BY id`)
            .all()
        ).results,
      ).toEqual([
        { id: 'audit', version: 4 },
        { id: 'r', version: 4 },
      ])
    })

    test('a failing guard leaves nothing behind, whether it changed none or too many', async () => {
      const { store, reports, count } = await setup()
      await store
        .prepare(
          `INSERT INTO ${reports} (id, version) VALUES ('r', 3), ('s', 3)`,
        )
        .run()
      const stale = await runBatch(store, [
        {
          sql: `UPDATE ${reports} SET version = version + 1 WHERE id = ? AND version = ?`,
          values: ['r', 2],
          expectChanges: 1,
        },
        {
          sql: `INSERT INTO ${reports} (id, version) VALUES ('audit', 1)`,
          values: [],
        },
      ])
      expect(stale).toEqual({ _tag: 'Conflict' })
      const tooMany = await runBatch(store, [
        {
          sql: `INSERT INTO ${reports} (id, version) VALUES ('early', 1)`,
          values: [],
        },
        {
          sql: `UPDATE ${reports} SET version = 100 WHERE version = 3`,
          values: [],
          expectChanges: 1,
        },
        {
          sql: `INSERT INTO ${reports} (id, version) VALUES ('audit', 1)`,
          values: [],
        },
      ])
      expect(tooMany).toEqual({ _tag: 'Conflict' })
      expect(await count(reports)).toBe(2)
      expect(
        (
          await store
            .prepare(`SELECT version FROM ${reports} ORDER BY id`)
            .all()
        ).results,
      ).toEqual([{ version: 3 }, { version: 3 }])
    })

    test('two concurrent writers on the same version: one commits, one conflicts', async () => {
      const { store, reports } = await setup()
      await store
        .prepare(`INSERT INTO ${reports} (id, version) VALUES ('r', 1)`)
        .run()
      const attempt = (who: string) =>
        runBatch(store, [
          {
            sql: `UPDATE ${reports} SET version = version + 1 WHERE id = 'r' AND version = 1`,
            values: [],
            expectChanges: 1,
          },
          {
            sql: `INSERT INTO ${reports} (id, version) VALUES (?, 0)`,
            values: [who],
          },
        ])
      const outcomes = await Promise.all([attempt('x'), attempt('y')])
      expect(outcomes.map(outcome => outcome._tag).sort()).toEqual([
        'Committed',
        'Conflict',
      ])
      expect(
        (
          (await store
            .prepare(`SELECT COUNT(*) AS n FROM ${reports}`)
            .first<{ n: number }>()) as { n: number }
        ).n,
      ).toBe(2)
    })

    test('refuses a batch over the cap before running anything', async () => {
      const { store, reports, count } = await setup()
      const insert = (id: string) => ({
        sql: `INSERT INTO ${reports} (id, version) VALUES (?, 1)`,
        values: [id],
      })
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`)
      await expect(
        runBatch(store, ids(MAX_BATCH_QUERIES + 1).map(insert)),
      ).rejects.toBeInstanceOf(SqlBatchTooLarge)
      expect(await count(reports)).toBe(0)
      // A guard counts as two queries.
      const guarded = ids(MAX_BATCH_QUERIES / 2 + 1).map(id => ({
        ...insert(id),
        expectChanges: 1,
      }))
      expect(batchQueryCount(guarded)).toBe(MAX_BATCH_QUERIES + 2)
      await expect(runBatch(store, guarded)).rejects.toBeInstanceOf(
        SqlBatchTooLarge,
      )
      expect(await count(reports)).toBe(0)
      const exact = await runBatch(store, ids(MAX_BATCH_QUERIES).map(insert))
      expect(exact._tag).toBe('Committed')
      expect(await count(reports)).toBe(MAX_BATCH_QUERIES)
      await expect(
        runBatch(store, ids(3).map(insert), { maxQueries: 2 }),
      ).rejects.toBeInstanceOf(SqlBatchTooLarge)
    })

    test('the claim query takes the oldest due rows and returns them', async () => {
      const { store, jobs } = await setup()
      await store
        .prepare(
          `INSERT INTO ${jobs} (id, due) VALUES (1, 50), (2, 10), (3, 30), (4, 999)`,
        )
        .run()
      const rows = await claim(store, {
        table: jobs,
        set: 'claimed_by = ?',
        setValues: ['me'],
        where: 'claimed_by IS NULL AND due <= ?',
        whereValues: [100],
        orderBy: 'due',
        limit: 2,
      })
      expect(rows.map(row => row['id']).sort()).toEqual([2, 3])
      expect(rows.every(row => row['claimed_by'] === 'me')).toBe(true)
    })

    test('two concurrent claimers claim disjoint rows', async () => {
      const { store, jobs } = await setup()
      const values = Array.from({ length: 10 }, (_, i) => `(${i + 1}, ${i})`)
      await store
        .prepare(`INSERT INTO ${jobs} (id, due) VALUES ${values.join(', ')}`)
        .run()
      const claimer = (who: string, limit: number) =>
        claim(store, {
          table: jobs,
          set: 'claimed_by = ?',
          setValues: [who],
          where: 'claimed_by IS NULL',
          whereValues: [],
          orderBy: 'due',
          limit,
        })
      const [first, second, third] = await Promise.all([
        claimer('one', 6),
        claimer('two', 6),
        claimer('three', 6),
      ])
      const ids = [first, second, third].flatMap(rows =>
        rows.map(row => row['id']),
      )
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids).toHaveLength(10)
      expect([first, second, third].map(rows => rows.length).sort()).toEqual([
        0, 4, 6,
      ])
    })

    test('claimStep refuses unsafe identifiers and bad limits', async () => {
      const { store } = await setup()
      const spec = {
        table: 'jobs',
        set: 'claimed_by = ?',
        setValues: ['x'],
        where: '1',
        whereValues: [],
        limit: 1,
      }
      await expect(
        claim(store, { ...spec, table: 'jobs; DROP' }),
      ).rejects.toThrow()
      await expect(claim(store, { ...spec, limit: 0 })).rejects.toThrow()
    })
  })
}
