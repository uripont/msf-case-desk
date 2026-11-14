import { readFileSync, writeFileSync } from 'node:fs'

import { type DocumentInput, documentDescription } from '@case-desk/domain'

import { renderPdfInNode } from './node'

// NOTE: The Node runner (stage 8, D4): renders the version a job file
// describes, with the same pure definition and fonts as the browser. The job
// is `{ document, images }`: the input of `documentDescription` as JSON and
// the images it names as data URIs. Run through `scripts/render.mjs`, which
// bundles this file:
//
//   node packages/pdf/scripts/render.mjs job.json out.pdf

type Job = Readonly<{
  document: DocumentInput
  images?: Readonly<Record<string, string>>
}>

const [, , input, output] = process.argv
if (input === undefined || output === undefined) {
  throw new Error('Usage: render.mjs <job.json> <out.pdf>')
}
const job: Job = JSON.parse(readFileSync(input, 'utf8'))
const bytes = await renderPdfInNode(
  documentDescription(job.document),
  new Map(Object.entries(job.images ?? {})),
)
writeFileSync(output, bytes)
