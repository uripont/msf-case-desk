import { build } from 'esbuild'
// Renders a version in Node: bundles `src/runner.ts` with esbuild into
// `.build/` (ignored by git) and runs it.
//
//   node packages/pdf/scripts/render.mjs job.json out.pdf
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join(here, '.build', 'runner.mjs')

await build({
  entryPoints: [join(here, 'src', 'runner.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile,
  external: ['pdfmake'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
})

const result = spawnSync('node', [outfile, ...process.argv.slice(2)], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
