// NOTE: the subset of D1's API the repository uses. D1Database satisfies it,
// and so do the SQLite adapters for tests and for running on plain workerd.
export type SqlValue = string | number | null

export interface SqlStatement {
  bind(...values: ReadonlyArray<SqlValue>): SqlStatement
  all<T = Record<string, unknown>>(): Promise<{ results: Array<T> }>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<unknown>
}

export interface SqlDatabase {
  prepare(query: string): SqlStatement
}

// NOTE: atomic batches. Every adapter implements the raw `SqlBatcher`: run
// the steps in order, all or nothing, and report per step the rows it
// changed and the rows it returned (`RETURNING` or a SELECT). `runBatch`
// adds the guard pattern and the query cap on top, once, for all adapters.
export type SqlRow = Record<string, SqlValue>

export interface SqlStep {
  readonly sql: string
  readonly values: ReadonlyArray<SqlValue>
}

export interface SqlBatchResult {
  readonly changes: number
  readonly rows: ReadonlyArray<SqlRow>
}

export interface SqlBatcher {
  batch(steps: ReadonlyArray<SqlStep>): Promise<ReadonlyArray<SqlBatchResult>>
}

export type SqlStore = SqlDatabase & SqlBatcher

// NOTE: a step with `expectChanges` is a guard: it must change exactly that
// many rows, or the whole batch has no effect.
export interface GuardedStep extends SqlStep {
  readonly expectChanges?: number
}

// NOTE: Workers Free allows 50 D1 queries per request. A guard costs one
// more query (its check), and the cap counts it.
export const MAX_BATCH_QUERIES = 50

// NOTE: no triggers and no guard table. The check statement runs right
// after the guard, reads `changes()` (SELECTs do not reset it) and, when the
// count is not the expected one, evaluates `abs(-9223372036854775808)`,
// which SQLite refuses with "integer overflow". An error in a statement makes
// D1 roll the whole batch back, and the Durable Object transaction and the
// Node adapter do the same, so the guard is atomic on all three.
const GUARD_FAILURE = /integer overflow/i
const GUARD_CHECK_SQL =
  'SELECT CASE WHEN changes() = ? THEN 0 ELSE abs(-9223372036854775808) END AS guard'

export class SqlBatchTooLarge extends Error {
  readonly _tag = 'SqlBatchTooLarge'
  constructor(
    readonly queries: number,
    readonly max: number,
  ) {
    super(`A batch of ${queries} queries is over the cap of ${max}.`)
  }
}

export type BatchOutcome =
  | {
      readonly _tag: 'Committed'
      readonly results: ReadonlyArray<SqlBatchResult>
    }
  | { readonly _tag: 'Conflict' }

export const batchQueryCount = (steps: ReadonlyArray<GuardedStep>): number =>
  steps.reduce(
    (count, step) => count + (step.expectChanges === undefined ? 1 : 2),
    0,
  )

const errorText = (error: unknown): string =>
  error instanceof Error
    ? `${error.message} ${errorText(error.cause)}`
    : String(error)

export const runBatch = async (
  store: SqlBatcher,
  steps: ReadonlyArray<GuardedStep>,
  options: { readonly maxQueries?: number } = {},
): Promise<BatchOutcome> => {
  const max = options.maxQueries ?? MAX_BATCH_QUERIES
  const queries = batchQueryCount(steps)
  if (queries > max) {
    throw new SqlBatchTooLarge(queries, max)
  }
  const expanded: Array<SqlStep> = []
  const callerIndex: Array<number> = []
  steps.forEach((step, index) => {
    expanded.push({ sql: step.sql, values: step.values })
    callerIndex.push(index)
    if (step.expectChanges !== undefined) {
      expanded.push({ sql: GUARD_CHECK_SQL, values: [step.expectChanges] })
      callerIndex.push(-1)
    }
  })
  try {
    const raw = await store.batch(expanded)
    return {
      _tag: 'Committed',
      results: raw.filter((_, index) => callerIndex[index] !== -1),
    }
  } catch (error) {
    if (GUARD_FAILURE.test(errorText(error))) {
      return { _tag: 'Conflict' }
    }
    throw error
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface ClaimSpec {
  readonly table: string
  readonly key?: string
  // NOTE: SQL text written in code, never from a request: `set` is the
  // assignments ("claimed_at = ?"), `where` selects what is claimable
  // ("claimed_at IS NULL AND due_at <= ?"), `orderBy` picks which first.
  readonly set: string
  readonly setValues: ReadonlyArray<SqlValue>
  readonly where: string
  readonly whereValues: ReadonlyArray<SqlValue>
  readonly orderBy?: string
  readonly limit: number
}

// NOTE: SQLite rejects `UPDATE ... LIMIT`, so the limit goes in a subquery.
// The claim is one statement, so two claimers never get the same row: the
// loser's subquery runs after the winner's update and no longer matches.
export const claimStep = (spec: ClaimSpec): SqlStep => {
  const key = spec.key ?? 'id'
  if (!IDENTIFIER.test(spec.table) || !IDENTIFIER.test(key)) {
    throw new Error('claimStep: table and key must be plain identifiers.')
  }
  if (!Number.isInteger(spec.limit) || spec.limit < 1) {
    throw new Error('claimStep: limit must be a positive integer.')
  }
  const order = spec.orderBy === undefined ? '' : ` ORDER BY ${spec.orderBy}`
  return {
    sql: `UPDATE ${spec.table} SET ${spec.set} WHERE ${key} IN (SELECT ${key} FROM ${spec.table} WHERE ${spec.where}${order} LIMIT ?) RETURNING *`,
    values: [...spec.setValues, ...spec.whereValues, spec.limit],
  }
}

export const claim = async (
  store: SqlBatcher,
  spec: ClaimSpec,
): Promise<ReadonlyArray<SqlRow>> => {
  const [result] = await store.batch([claimStep(spec)])
  return result?.rows ?? []
}

// NOTE: D1's own batch is one transaction that stops at the first error and
// rolls everything back. `meta.changes` is the changed-row count and
// `results` holds the `RETURNING` rows.
export const fromD1 = (db: D1Database): SqlStore => ({
  prepare: query => db.prepare(query),
  batch: async steps => {
    const results = await db.batch<SqlRow>(
      steps.map(step => db.prepare(step.sql).bind(...step.values)),
    )
    return results.map(result => ({
      changes: result.meta.changes ?? 0,
      rows: result.results ?? [],
    }))
  },
})
