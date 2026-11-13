import { build } from 'esbuild'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type SqlStatement, type SqlStore, type SqlValue } from '../sql'

export interface WorkerdHarness {
  readonly open: (name: string) => SqlStore
  readonly stop: () => Promise<void>
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('no port')),
      )
    })
  })

const CONFIG = (
  port: number,
  data: string,
) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .w),
    (name = "data", disk = (path = "${data}", writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")],
);
const w :Workerd.Worker = (
  modules = [(name = "worker", esModule = embed "worker.js")],
  compatibilityDate = "2026-10-01",
  bindings = [(name = "DATABASE", durableObjectNamespace = "LocalDatabase")],
  durableObjectNamespaces = [(className = "LocalDatabase", uniqueKey = "sql-contract", enableSql = true)],
  durableObjectStorage = (localDisk = "data"),
);
`

// NOTE: starts the real workerd binary with the real LocalDatabase Durable
// Object (SQLite storage on a temporary disk folder) and talks to it over HTTP.
export const startWorkerd = async (
  migrations: ReadonlyArray<string> = [],
): Promise<WorkerdHarness> => {
  const dir = mkdtempSync(join(tmpdir(), 'case-desk-sql-'))
  await build({
    entryPoints: [join(import.meta.dirname, 'workerdEntry.ts')],
    outfile: join(dir, 'worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:*', 'node:*'],
    logLevel: 'warning',
    plugins: [
      {
        name: 'empty-sql',
        setup: builder => {
          builder.onResolve({ filter: /^virtual:case-desk-sql$/ }, args => ({
            path: args.path,
            namespace: 'empty-sql',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'empty-sql' }, () => ({
            contents: `export const MIGRATIONS = ${JSON.stringify(
              migrations.map((sql, index) => ({
                name: `${String(index + 1).padStart(4, '0')}.sql`,
                sql,
              })),
            )}\nexport const IMPORTS = []\n`,
            loader: 'js',
          }))
        },
      },
    ],
  })
  mkdirSync(join(dir, 'data'))
  const port = await freePort()
  writeFileSync(join(dir, 'worker.capnp'), CONFIG(port, join(dir, 'data')))
  const binary = join(
    import.meta.dirname,
    '../../node_modules/workerd/bin/workerd',
  )
  const child: ChildProcess = spawn(
    binary,
    ['serve', join(dir, 'worker.capnp'), '--experimental'],
    { stdio: 'ignore' },
  )
  const call = async (name: string, body: unknown): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${port}/?db=${name}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    const payload = (await response.json()) as
      | { ok: true; body: unknown }
      | { ok: false; message: string }
    if (!payload.ok) {
      throw new Error(payload.message)
    }
    return payload.body
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await call('ready', { op: 'first', sql: 'SELECT 1 AS one', values: [] })
      break
    } catch (error) {
      if (attempt > 100) {
        child.kill()
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  const open = (name: string): SqlStore => {
    const statement = (
      sql: string,
      values: ReadonlyArray<SqlValue>,
    ): SqlStatement => ({
      bind: (...next) => statement(sql, next),
      all: async <T>() =>
        (await call(name, { op: 'all', sql, values })) as {
          results: Array<T>
        },
      first: async <T>() =>
        (await call(name, { op: 'first', sql, values })) as T | null,
      run: () => call(name, { op: 'run', sql, values }),
    })
    return {
      prepare: sql => statement(sql, []),
      batch: async steps =>
        (await call(name, {
          op: 'batch',
          steps,
        })) as Awaited<ReturnType<SqlStore['batch']>>,
    }
  }
  return {
    open,
    stop: async () => {
      child.kill()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
