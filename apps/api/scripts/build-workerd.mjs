// Bundles src/workerd.ts for plain workerd (infra/workerd.sh). The migrations
// are embedded, then the imports of the environment `workerd`, in order, from
// infra/quoroom.ts as on every other host. Every import is idempotent: the
// local database runs them on each start.
//
//   node scripts/build-workerd.mjs [--mode demo|pilot]
//
// demo (default): also the demo accounts from `pnpm users:add`.
// pilot: the built-in templates and the first administrator only (D21).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { build } from 'esbuild'

import { LOCAL, MIGRATIONS, importFiles } from '../../../infra/quoroom.ts'

const api = join(import.meta.dirname, '..')

const migrations = readdirSync(MIGRATIONS)
  .filter(file => file.endsWith('.sql'))
  .sort()
  .map(name => ({ name, sql: readFileSync(join(MIGRATIONS, name), 'utf8') }))

// NOTE: QUOROOM_LOCAL_DIR points the build at another folder for the account
// and grant files, so the browser check (packages/e2e) never touches .local.
const local = process.env.QUOROOM_LOCAL_DIR ?? LOCAL

const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex === -1 ? 'demo' : (process.argv[modeIndex + 1] ?? '')
if (mode !== 'demo' && mode !== 'pilot') {
  console.error('Usage: build-workerd.mjs [--mode demo|pilot]')
  process.exit(2)
}

const imports = importFiles('workerd', { demoAccounts: mode === 'demo', local }).map(file =>
  readFileSync(file, 'utf8'),
)

await build({
  entryPoints: [join(api, 'src/workerd.ts')],
  outfile: join(api, 'workerd/dist/worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'],
  external: ['cloudflare:*', 'node:*'],
  logLevel: 'warning',
  plugins: [
    {
      name: 'quoroom-sql',
      setup: builder => {
        builder.onResolve({ filter: /^virtual:quoroom-sql$/ }, args => ({
          path: args.path,
          namespace: 'quoroom-sql',
        }))
        builder.onLoad({ filter: /.*/, namespace: 'quoroom-sql' }, () => ({
          contents: `export const MIGRATIONS = ${JSON.stringify(migrations)}\nexport const IMPORTS = ${JSON.stringify(imports)}\n`,
          loader: 'js',
        }))
      },
    },
  ],
})

console.log(
  `Bundled for workerd (${mode}) with ${migrations.length} migrations and ${imports.length} imports.`,
)
