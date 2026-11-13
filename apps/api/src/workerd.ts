// Entry for running Case Desk on plain workerd, without Cloudflare. The API
// and the assets are served as on Cloudflare; the database is a Durable
// Object with SQLite storage on local disk, behind the same SqlDatabase
// interface D1 satisfies. Built and started by `pnpm workerd`.
import { DurableObject } from 'cloudflare:workers'
import { Layer } from 'effect'

// @ts-expect-error: provided by the bundler from the migrations and seed files.
import { IMPORTS, MIGRATIONS } from 'virtual:case-desk-sql'

import { makeApp } from './app'
import { withReferrerPolicy } from './headers'
import { modeOf } from './runtimeMode'
import { layerSql } from './d1Repository'
import { type NetworkPolicy, QuoroomServicesFor } from './quoroom/core'
import { layerSqlReport } from './reportRepository'
import {
  type SqlBatchResult,
  type SqlRow,
  type SqlStep,
  type SqlStore,
  type SqlStatement,
  type SqlValue,
} from './sql'

type Row = Record<string, SqlValue>

export type Env = {
  readonly ASSETS: Fetcher
  readonly DATABASE: DurableObjectNamespace<LocalDatabase>
  // NOTE: the header a proxy in front of this server sets to the caller's
  // address, if the operator controls one. Without it the per-address sign-in
  // limit is one shared bucket (see `clientAddress`).
  readonly TRUSTED_PROXY_HEADER?: string
  // NOTE: `demo` or `pilot` (D20), set in the workerd config. Unset means `pilot`;
  // any other value is a configuration error (see `modeOf`).
  readonly RUNTIME_MODE?: string
}

const runScript = (sql: SqlStorage, script: string): void => {
  // NOTE: exec runs one statement at a time when it is given bindings, and a
  // whole script otherwise, which is what migrations and imports need.
  sql.exec(script)
}

export class LocalDatabase extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql
      sql.exec(
        'CREATE TABLE IF NOT EXISTS _case_desk_migrations (name TEXT PRIMARY KEY)',
      )
      const applied = new Set(
        sql
          .exec<{ name: string }>('SELECT name FROM _case_desk_migrations')
          .toArray()
          .map(row => row.name),
      )
      const migrations: ReadonlyArray<{ name: string; sql: string }> =
        MIGRATIONS
      migrations
        .filter(migration => !applied.has(migration.name))
        .forEach(migration => {
          runScript(sql, migration.sql)
          sql.exec(
            'INSERT INTO _case_desk_migrations (name) VALUES (?)',
            migration.name,
          )
        })
      const imports: ReadonlyArray<string> = IMPORTS
      imports.forEach(script => runScript(sql, script))
    })
  }

  all(query: string, values: ReadonlyArray<SqlValue>): ReadonlyArray<Row> {
    return this.ctx.storage.sql.exec<Row>(query, ...values).toArray()
  }

  run(query: string, values: ReadonlyArray<SqlValue>): void {
    this.ctx.storage.sql.exec(query, ...values)
  }

  // NOTE: one synchronous transaction: an error in any step rolls back every
  // step and is rethrown to the caller. A step's changed-row count is the
  // change in `total_changes()`, which also counts a RETURNING statement.
  batch(steps: ReadonlyArray<SqlStep>): ReadonlyArray<SqlBatchResult> {
    const sql = this.ctx.storage.sql
    const total = (): number =>
      sql.exec<{ n: number }>('SELECT total_changes() AS n').one().n
    return this.ctx.storage.transactionSync(() =>
      steps.map(step => {
        const before = total()
        const rows = sql.exec<SqlRow>(step.sql, ...step.values).toArray()
        return { changes: total() - before, rows }
      }),
    )
  }
}

export const localDatabase = (env: Env, name = 'case-desk'): SqlStore => {
  const stub = env.DATABASE.get(env.DATABASE.idFromName(name))
  const statement = (
    query: string,
    values: ReadonlyArray<SqlValue>,
  ): SqlStatement => ({
    bind: (...next) => statement(query, next),
    all: async <T>() => ({
      results: [...(await stub.all(query, values))] as Array<T>,
    }),
    first: async <T>() =>
      ([...(await stub.all(query, values))][0] ?? null) as T | null,
    run: () => stub.run(query, values),
  })
  return {
    prepare: query => statement(query, []),
    batch: async steps => [...(await stub.batch(steps))],
  }
}

const isPageRequest = (request: Request): boolean =>
  request.method === 'GET' &&
  !/\.[a-z0-9]+$/i.test(new URL(request.url).pathname)

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  json: 'application/json',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
}

// NOTE: the disk service sends every file as `application/octet-stream`,
// which a browser downloads instead of showing, so the type comes from the
// file's extension.
const typed = (response: Response, path: string): Response => {
  if (response.status !== 200) {
    return response
  }
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
  const type = CONTENT_TYPES[extension]
  if (type === undefined) {
    return response
  }
  const headers = new Headers(response.headers)
  headers.set('content-type', type)
  return new Response(response.body, { status: response.status, headers })
}

// NOTE: the disk service lists a folder instead of serving its index.html,
// so the root and any page route are answered with the app's index.html.
const serveAssets = async (request: Request, env: Env): Promise<Response> => {
  const index = () =>
    env.ASSETS.fetch(new URL('/index.html', request.url)).then(response =>
      typed(response, '/index.html'),
    )
  const path = new URL(request.url).pathname
  if (path.endsWith('/')) {
    return index()
  }
  const response = await env.ASSETS.fetch(request)
  if (response.status !== 404 || !isPageRequest(request)) {
    return typed(response, path)
  }
  return index()
}

export default {
  fetch: async (request, env, context) => {
    if (!new URL(request.url).pathname.startsWith('/api/')) {
      return withReferrerPolicy(await serveAssets(request, env))
    }
    const database = localDatabase(env)
    const proxyHeader = (env.TRUSTED_PROXY_HEADER ?? '').trim()
    const network: NetworkPolicy =
      proxyHeader === ''
        ? { kind: 'self_hosted' }
        : { kind: 'header', name: proxyHeader }
    const mode = modeOf(env.RUNTIME_MODE)
    if (mode.refusal !== undefined) {
      return withReferrerPolicy(mode.refusal)
    }
    const app = makeApp(
      layerSql(database),
      Layer.mergeAll(layerSqlReport(database), QuoroomServicesFor(network)),
      mode.mode,
    )
    try {
      return await app.handle(request)
    } finally {
      context.waitUntil(app.dispose())
    }
  },
} satisfies ExportedHandler<Env>
