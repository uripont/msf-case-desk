// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./pdfmake-browser.d.ts" />
import pdfMake from 'pdfmake/build/pdfmake'

import type { DocumentDescription } from '@quoroom/domain'

import {
  type PdfBuild,
  type PdfImages,
  type Render,
  renderPdf,
} from './definition'

// NOTE: The browser adapter (D4): the same pure definition as Node's,
// rendered with pdfmake's browser build. The font files are not bundled here:
// the caller hands over `fontSource`, which returns the base64 text of a file
// by its name (the web app fetches the `.woff` files from its own assets when
// a PDF is made). Nothing is fetched by pdfmake itself.

export type FontSource = (file: string) => Promise<string>

const loaded = new Set<string>()

export const renderPdfInBrowser = (
  description: DocumentDescription,
  images: PdfImages,
  fontSource: FontSource,
): Promise<Uint8Array> => {
  const render: Render = async (build: PdfBuild) => {
    const missing = build.fontFiles.filter(file => !loaded.has(file))
    const files = await Promise.all(
      missing.map(async file => [file, await fontSource(file)] as const),
    )
    pdfMake.addVirtualFileSystem(Object.fromEntries(files))
    missing.forEach(file => loaded.add(file))
    pdfMake.addFonts(build.fonts)
    pdfMake.setUrlAccessPolicy(() => false)
    return new Uint8Array(await pdfMake.createPdf(build.definition).getBuffer())
  }
  return renderPdf(description, images, render)
}
