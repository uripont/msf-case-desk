import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import type { DocumentDescription } from '@quoroom/domain'

import {
  type PdfBuild,
  type PdfImages,
  type Render,
  renderPdf,
} from './definition'
import { FONT_PACKAGES, familyOfFile } from './fonts'

// NOTE: The Node adapter (D4): the same pure definition as the browser's,
// rendered with pdfmake's server build and the font files of the
// `@fontsource` packages read from disk. Used by the tests and by the Node
// runner (`runner.ts`); no network or file access is allowed to pdfmake itself.

const require = createRequire(import.meta.url)

type Pdfmake = {
  sharedVirtualfs: { writeFileSync: (name: string, data: Buffer) => void }
  addFonts: (fonts: object) => void
  setUrlAccessPolicy: (policy: () => boolean) => void
  setLocalAccessPolicy: (policy: () => boolean) => void
  createPdf: (definition: object) => { getBuffer: () => Promise<Uint8Array> }
}

let cached: Pdfmake | undefined
const pdfmake = (): Pdfmake => {
  if (cached === undefined) {
    cached = require('pdfmake') as Pdfmake
    cached.setUrlAccessPolicy(() => false)
    cached.setLocalAccessPolicy(() => false)
  }
  return cached
}

const loaded = new Set<string>()

const readFont = (file: string): Buffer => {
  const family = familyOfFile(file)
  if (family === undefined) throw new Error(`Unknown font file ${file}`)
  const folder = dirname(require.resolve(FONT_PACKAGES[family]))
  return readFileSync(join(folder, 'files', file))
}

const render: Render = async (build: PdfBuild) => {
  const lib = pdfmake()
  for (const file of build.fontFiles) {
    if (!loaded.has(file)) {
      lib.sharedVirtualfs.writeFileSync(file, readFont(file))
      loaded.add(file)
    }
  }
  lib.addFonts(build.fonts)
  return new Uint8Array(await lib.createPdf(build.definition).getBuffer())
}

export const renderPdfInNode = (
  description: DocumentDescription,
  images: PdfImages = new Map(),
): Promise<Uint8Array> => renderPdf(description, images, render)
