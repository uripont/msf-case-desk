import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

// NOTE: On Cloudflare the static assets and index.html are served by the
// platform, not by the Worker (`runWorkerFirst` is only `/api/*`), so the
// Worker's `Referrer-Policy` never reaches them. The `_headers` file in the
// built app does, for every Cloudflare deployment (Alchemy reads it from the
// assets directory; on OpenOrange and workerd the Worker sets the header). A
// link token sits in the `/link#token` fragment, and this is what keeps the
// page from telling another site where it came from.
describe('built app', () => {
  test('dist carries Referrer-Policy: no-referrer for every path', () => {
    const out = mkdtempSync(join(tmpdir(), 'quoroom-dist-'))
    try {
      const build = spawnSync(
        'npx',
        ['vite', 'build', '--outDir', out, '--emptyOutDir'],
        { cwd: join(import.meta.dirname, '../../web'), encoding: 'utf8' },
      )
      expect(build.status, build.stderr).toBe(0)
      expect(existsSync(join(out, 'index.html'))).toBe(true)
      const lines = readFileSync(join(out, '_headers'), 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '' && !line.startsWith('#'))
      // NOTE: one rule for every path, with the header under it.
      expect(lines[0]).toBe('/*')
      expect(lines).toContain('Referrer-Policy: no-referrer')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 120_000)
})
