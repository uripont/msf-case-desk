// Entry for running Case Desk on plain workerd, without Cloudflare. The API
// and the assets are served as on Cloudflare; the database is a Durable
// Object with SQLite storage on local disk, behind the same SqlDatabase
// interface D1 satisfies. Built and started by `pnpm workerd`.
import { DurableObject } from 'cloudflare:workers'
// @ts-expect-error: provided by the bundler from the migrations and seed files.
import { IMPORTS, MIGRATIONS } from 'virtual:case-desk-sql'

import { makeApp } from './app'
import { layerSql } from './d1Repository'
import { type SqlDatabase, type SqlStatement, type SqlValue } from './sql'

type Row = Record<string, SqlValue>

type Env = {
  readonly ASSETS: Fetcher
  readonly DATABASE: DurableObjectNamespace<LocalDatabase>
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
}

const localDatabase = (env: Env): SqlDatabase => {
  const stub = env.DATABASE.get(env.DATABASE.idFromName('case-desk'))
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
  return { prepare: query => statement(query, []) }
}

const isPageRequest = (request: Request): boolean =>
  request.method === 'GET' &&
  !/\.[a-z0-9]+$/i.test(new URL(request.url).pathname)

// NOTE: the disk service lists a folder instead of serving its index.html,
// so the root and any page route are answered with the app's index.html.
const serveAssets = async (request: Request, env: Env): Promise<Response> => {
  if (new URL(request.url).pathname.endsWith('/')) {
    return env.ASSETS.fetch(new URL('/index.html', request.url))
  }
  const response = await env.ASSETS.fetch(request)
  if (response.status !== 404 || !isPageRequest(request)) {
    return response
  }
  return env.ASSETS.fetch(new URL('/index.html', request.url))
}

export default {
  fetch: async (request, env, context) => {
    if (!new URL(request.url).pathname.startsWith('/api/')) {
      return serveAssets(request, env)
    }
    const app = makeApp(layerSql(localDatabase(env)))
    try {
      return await app.handle(request)
    } finally {
      context.waitUntil(app.dispose())
    }
  },
} satisfies ExportedHandler<Env>
