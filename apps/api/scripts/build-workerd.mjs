// Bundles src/workerd.ts for plain workerd. The migrations are embedded, then
// the imports of the mode (see src/workerdImports.ts), in order. Every import
// is idempotent.
//
//   node scripts/build-workerd.mjs [--mode demo|pilot]
//
// demo (default): accounts from `pnpm users:add` and the grants from
// `pnpm grant-admin --env workerd`.
// pilot: the built-in templates and the grants file only (D21).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { build } from 'esbuild'

import { isWorkerdMode, workerdImportFiles } from '../src/workerdImports.ts'

const api = join(import.meta.dirname, '..')
const root = join(api, '../..')
const migrationsDir = join(api, 'migrations')

const migrations = readdirSync(migrationsDir)
  .filter(file => file.endsWith('.sql'))
  .sort()
  .map(name => ({ name, sql: readFileSync(join(migrationsDir, name), 'utf8') }))

// NOTE: CASE_DESK_LOCAL_DIR points the build at another folder for the account
// and grant files, so the browser check (packages/e2e) never touches .local.
const local = process.env.CASE_DESK_LOCAL_DIR ?? join(root, '.local')

const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex === -1 ? 'demo' : (process.argv[modeIndex + 1] ?? '')
if (!isWorkerdMode(mode)) {
  console.error('Usage: build-workerd.mjs [--mode demo|pilot]')
  process.exit(2)
}

const imports = workerdImportFiles(mode, { api, local }, existsSync).map(file =>
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
      name: 'case-desk-sql',
      setup: builder => {
        builder.onResolve({ filter: /^virtual:case-desk-sql$/ }, args => ({
          path: args.path,
          namespace: 'case-desk-sql',
        }))
        builder.onLoad({ filter: /.*/, namespace: 'case-desk-sql' }, () => ({
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
