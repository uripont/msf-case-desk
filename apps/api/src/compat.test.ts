import { Effect } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  CENTRES,
  CHANNELS,
  FAST_TRACK_SIGNALS,
  RISKS,
  SCOPES,
  URGENCIES,
  triage,
  DEFAULT_RULES,
} from '@case-desk/domain'

import { makeSqlRepository } from './d1Repository'
import { makeNodeSqlite } from './testing/nodeSqlite'

// NOTE: rows as a newer version might write them: known or new enum values,
// NULL in every optional column, and a column this version has never seen.
const enumValue = (known: ReadonlyArray<string>) =>
  fc.oneof(
    fc.constantFrom(...known),
    fc.stringMatching(/^[A-Z][a-zA-Z]{2,12}$/),
  )

const nullable = <A>(arbitrary: fc.Arbitrary<A>) =>
  fc.option(arbitrary, { nil: null })

const rowArbitrary = fc.record({
  centre: enumValue(CENTRES),
  receivedAt: fc.integer({ min: 0, max: 4_000_000_000_000 }),
  summary: fc.stringMatching(/^Synthetic [a-z ]{1,40}\.$/),
  scope: enumValue(SCOPES),
  risk: enumValue(RISKS),
  urgency: enumValue(URGENCIES),
  signals: fc.array(enumValue(FAST_TRACK_SIGNALS), { maxLength: 4 }),
  channel: nullable(enumValue(CHANNELS)),
  details: nullable(fc.string({ maxLength: 50 })),
  location: nullable(fc.string({ maxLength: 20 })),
  reference: nullable(fc.string({ maxLength: 20 })),
  enteredAt: nullable(fc.integer({ min: 0, max: 4_000_000_000_000 })),
  schemaVersion: nullable(fc.integer({ min: 1, max: 9 })),
  addedLater: nullable(fc.string({ maxLength: 20 })),
})

describe('rows written by newer versions', () => {
  test('every row is read, scored and explained', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(rowArbitrary, { minLength: 1, maxLength: 8 }),
        async rows => {
          const db = makeNodeSqlite()
          db.raw.exec('ALTER TABLE cases ADD COLUMN added_later TEXT')
          const insert = db.raw.prepare(
            `INSERT INTO cases (id, centre, received_at, summary, scope, risk,
              urgency, fast_track_signals, channel, details, location,
              reference, entered_at, schema_version, added_later)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          rows.forEach((row, index) => {
            insert.run(
              `CD-${index}`,
              row.centre,
              row.receivedAt,
              row.summary,
              row.scope,
              row.risk,
              row.urgency,
              JSON.stringify(row.signals),
              row.channel,
              row.details,
              row.location,
              row.reference,
              row.enteredAt,
              row.schemaVersion,
              row.addedLater,
            )
          })
          const cases = await Effect.runPromise(
            makeSqlRepository(db).listCases(),
          )
          expect(cases).toHaveLength(rows.length)
          cases.forEach(triageCase => {
            const result = triage(DEFAULT_RULES, triageCase)
            expect(result.reasons.length).toBeGreaterThanOrEqual(4)
            expect(Number.isFinite(result.dueAt)).toBe(true)
          })
        },
      ),
      { numRuns: 60 },
    )
  })
})
