import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

// NOTE: Test support: what a reader of a PDF sees, read with
// `pdfjs-dist`, an implementation independent of the one that wrote it.

export const extractPages = async (
  bytes: Uint8Array,
): Promise<ReadonlyArray<string>> => {
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    verbosity: 0,
  })
  const doc = await task.promise
  const pages: Array<string> = []
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number)
    const content = await page.getTextContent()
    pages.push(
      content.items
        .map(item =>
          'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '',
        )
        .join(''),
    )
  }
  await task.destroy()
  return pages
}

export const extractText = async (bytes: Uint8Array): Promise<string> =>
  (await extractPages(bytes)).join('\n')

// NOTE: How many image objects the PDF holds. pdfkit writes each image as an
// object with `/Subtype /Image` (and a soft mask as a second one).
export const imageObjectCount = (bytes: Uint8Array): number =>
  (
    Buffer.from(bytes)
      .toString('latin1')
      .match(/\/Subtype\s*\/Image/g) ?? []
  ).length

// NOTE: True if the bytes of `needle` appear inside the PDF. A JPEG is
// embedded as it is, so a distinctive stretch of its bytes finds it.
export const containsBytes = (bytes: Uint8Array, needle: Uint8Array): boolean =>
  Buffer.from(bytes).includes(Buffer.from(needle))

export const pdfInfo = async (
  bytes: Uint8Array,
): Promise<Readonly<Record<string, unknown>>> => {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 })
  const doc = await task.promise
  const meta = await doc.getMetadata()
  await task.destroy()
  return meta.info as Record<string, unknown>
}
