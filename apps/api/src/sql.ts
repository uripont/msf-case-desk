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
