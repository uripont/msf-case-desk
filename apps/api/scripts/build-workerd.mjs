// Bundles src/workerd.ts for plain workerd. The migrations, the account file
// from `pnpm users:add` and the demo cases are embedded, in that order.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { build } from 'esbuild'

const api = join(import.meta.dirname, '..')
const root = join(api, '../..')
const migrationsDir = join(api, 'migrations')

const migrations = readdirSync(migrationsDir)
  .filter(file => file.endsWith('.sql'))
  .sort()
  .map(name => ({ name, sql: readFileSync(join(migrationsDir, name), 'utf8') }))

const imports = [join(root, '.local/users.sql'), join(api, 'seed/demo-cases.sql')]
  .filter(existsSync)
  .map(file => readFileSync(file, 'utf8'))

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
  `Bundled for workerd with ${migrations.length} migrations and ${imports.length} imports.`,
)
