// Local CPU bench of the real Worker (stage 10). Serves `src/worker.ts` from
// Node on 127.0.0.1 with the pilot setting, on a local model of D1 (Node's
// SQLite), so `live-run.mjs` can drive it as it drives a test Worker. Every
// request's CPU time is measured (thread CPU from the request body read to the
// end of its `waitUntil` work) with the time spent inside SQLite taken out, so
// what is left is our own work. Run it with `node --cpu-prof` to see where
// that work goes. Started through `cpu-bench.mjs`, which bundles it.
//
//   node apps/api/scripts/cpu-bench.mjs --out <dir> [--port 8799] [--db <new file>]
//
// Writes <dir>/admin-link.txt and <dir>/tick-secret.txt for live-run, and on
// SIGINT/SIGTERM <dir>/cpu-<pid>.json: one record per request (sequence
// number, path, procedure, cpu and sqlite microseconds). Each answer carries
// `cf-ray: <sequence>` so live-run's calls file joins to it. Invented data only.
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { builtinTemplatesSql } from '../src/builtinTemplatesSql.ts'
import { grantAdminSql } from '../src/grantAdmin.ts'
import { sha256Hex } from '../src/links.ts'
import { migrationFiles } from '../src/testing/nodeSqlite.ts'
import worker from '../src/worker.ts'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    port: { type: 'string', default: '8799' },
    // NOTE: a file instead of memory, to keep the state for a later cold run.
    db: { type: 'string' },
  },
})
const out = values.out ?? ''
if (out === '') {
  console.error('Usage: cpu-bench.mjs --out <dir> [--port N] [--db <file>]')
  process.exit(2)
}

// ---- A D1 on Node's SQLite, with the time inside SQLite counted -------------------------------

const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(values.db ?? ':memory:')
db.exec('PRAGMA foreign_keys = ON')
for (const migration of migrationFiles(join(import.meta.dirname, '../migrations')))
  db.exec(migration)
db.exec(builtinTemplatesSql())

let sqliteUs = 0
let queries = 0
let statements: Array<string> = []
let trips = 0
const timed = <T>(work: () => T): T => {
  const start = process.hrtime.bigint()
  try {
    return work()
  } finally {
    sqliteUs += Number(process.hrtime.bigint() - start) / 1000
  }
}
const total = (): number =>
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
const execute = (query: string, args: ReadonlyArray<unknown>) =>
  timed(() => {
    queries += 1
    statements.push(query.replace(/\s+/g, ' ').slice(0, 90))
    const before = total()
    let results: Array<Record<string, unknown>>
    try {
      results = db.prepare(query).all(...(args as Array<string>)) as Array<
        Record<string, unknown>
      >
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error))
      throw new Error(`D1_ERROR: ${cause.message}: SQLITE_ERROR`, { cause })
    }
    return { success: true, results, meta: { changes: total() - before } }
  })
type Prepared = {
  query: string
  args: ReadonlyArray<unknown>
  bind: (...next: Array<unknown>) => Prepared
  all: () => Promise<unknown>
  first: () => Promise<unknown>
  run: () => Promise<unknown>
}
const prepared = (query: string, args: ReadonlyArray<unknown>): Prepared => ({
  query,
  args,
  bind: (...next) => prepared(query, next),
  all: () => {
    trips += 1
    return Promise.resolve(execute(query, args))
  },
  first: () => {
    trips += 1
    return Promise.resolve(execute(query, args).results[0] ?? null)
  },
  run: () => {
    trips += 1
    return Promise.resolve(execute(query, args))
  },
})
const DB = {
  prepare: (query: string) => prepared(query, []),
  batch: (statements: Array<Prepared>) => {
    trips += 1
    db.exec('BEGIN')
    try {
      const results = statements.map(s => execute(s.query, s.args))
      db.exec('COMMIT')
      return Promise.resolve(results)
    } catch (error) {
      db.exec('ROLLBACK')
      return Promise.reject(error)
    }
  },
} as unknown as D1Database

// ---- The first administrator and the tick secret ---------------------------------------------

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
const linkToken = hex(crypto.getRandomValues(new Uint8Array(32)))
const tickSecret = hex(crypto.getRandomValues(new Uint8Array(24)))
const now = Date.now()
db.exec(
  grantAdminSql({
    email: 'bench-admin@case-desk.test',
    name: 'Bench Administrator',
    now,
    accountId: `acc-${hex(crypto.getRandomValues(new Uint8Array(8)))}`,
    invitationId: `inv-${hex(crypto.getRandomValues(new Uint8Array(8)))}`,
    importId: `imp-${now}`,
    tokenHash: await sha256Hex(linkToken),
    mode: 'activate',
  }),
)
const port = Number(values.port)
writeFileSync(
  join(out, 'admin-link.txt'),
  `http://127.0.0.1:${port}/link#${linkToken}\n`,
  { mode: 0o600 },
)
writeFileSync(join(out, 'tick-secret.txt'), `${tickSecret}\n`, { mode: 0o600 })

const env = {
  DB,
  ASSETS: { fetch: async () => new Response('asset') } as unknown as Fetcher,
  TICK_SECRET: tickSecret,
  NOTIFY_REQUEST_DELAY_MINUTES: '0',
  NOTIFY_FIRST_REMINDER_MINUTES: '10',
  NOTIFY_FINAL_REMINDER_MINUTES: '3',
}

// ---- Serving, one request at a time --------------------------------------------------------------

type Record_ = {
  seq: number
  path: string
  op: string
  status: number
  cpuUs: number
  sqliteUs: number
  queries: number
  trips: number
  sql: ReadonlyArray<string>
}
const records: Array<Record_> = []
let seq = 0
let chain = Promise.resolve()

const opOf = (path: string, body: string): string => {
  const tag = /"tag":"([A-Za-z]+)"/.exec(body.slice(0, 200))?.[1]
  return tag ?? path
}

const server = createServer((incoming, outgoing) => {
  const chunks: Array<Buffer> = []
  incoming.on('data', chunk => chunks.push(chunk as Buffer))
  incoming.on('end', () => {
    chain = chain.then(async () => {
      seq += 1
      const body = Buffer.concat(chunks)
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(name, value)
      }
      const method = incoming.method ?? 'GET'
      const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
        method,
        headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
      })
      const pending: Array<Promise<unknown>> = []
      const context = {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        passThroughOnException: () => {},
      } as unknown as ExecutionContext
      sqliteUs = 0
      queries = 0
      statements = []
      trips = 0
      const cpu = process.cpuUsage()
      const response = await worker.fetch(
        request as never,
        env as never,
        context,
      )
      const text = new Uint8Array(await response.arrayBuffer())
      await Promise.all(pending)
      const used = process.cpuUsage(cpu)
      const path = new URL(request.url).pathname
      records.push({
        seq,
        path,
        op: opOf(path, body.toString('utf8')),
        status: response.status,
        cpuUs: used.user + used.system,
        sqliteUs: Math.round(sqliteUs),
        queries,
        trips,
        sql: statements,
      })
      const answer: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        answer[name] = value
      })
      answer['cf-ray'] = String(seq)
      const cookies = response.headers.getSetCookie()
      outgoing.writeHead(response.status, {
        ...answer,
        ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}),
      })
      outgoing.end(text)
    })
  })
})

const finish = () => {
  writeFileSync(
    join(out, `cpu-${process.pid}.json`),
    JSON.stringify(records, null, 1),
  )
  server.close()
  process.exit(0)
}
process.on('SIGINT', finish)
process.on('SIGTERM', finish)
server.listen(port, '127.0.0.1', () => {
  console.log(`cpu bench on http://127.0.0.1:${port} (pid ${process.pid})`)
})
