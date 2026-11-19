import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { INTAKE_TEMPLATE, documentDescription } from '@quoroom/domain'

import { renderPdfInNode } from './node'
import { CASE, PEOPLE, THEME, bulkContent } from './testing/documents'
import { extractPages } from './testing/extract'

// NOTE: The script that renders a job file in Node gives the same text as the
// adapter called directly.
test('the render script makes the same PDF text as the adapter', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'pdf-runner-'))
  try {
    const document = {
      template: INTAKE_TEMPLATE,
      content: bulkContent(INTAKE_TEMPLATE, { paragraphs: 2 }),
      view: { kind: 'original' as const, people: PEOPLE },
      caseFile: CASE,
      theme: THEME,
      version: {
        reportName: INTAKE_TEMPLATE.name,
        versionLabel: 'Revision 1',
        date: '2026-11-12',
      },
    }
    writeFileSync(join(folder, 'job.json'), JSON.stringify({ document }))
    const run = spawnSync(
      'node',
      ['scripts/render.mjs', join(folder, 'job.json'), join(folder, 'out.pdf')],
      { encoding: 'utf8' },
    )
    expect(run.status, run.stderr).toBe(0)
    const fromScript = await extractPages(
      new Uint8Array(readFileSync(join(folder, 'out.pdf'))),
    )
    const direct = await extractPages(
      await renderPdfInNode(documentDescription(document)),
    )
    expect(fromScript).toEqual(direct)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
