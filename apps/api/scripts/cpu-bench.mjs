// Bundles cpu-bench.ts (the domain package is TypeScript with extensionless
// imports, which Node cannot load) into a temporary file and runs it with the
// same arguments. See cpu-bench.ts.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'cpu-bench-'))
const outfile = join(directory, 'cpu-bench.mjs')
await build({
  entryPoints: [join(import.meta.dirname, 'cpu-bench.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
  define: { 'import.meta.dirname': JSON.stringify(import.meta.dirname) },
})
try {
  await import(pathToFileURL(outfile).href)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
