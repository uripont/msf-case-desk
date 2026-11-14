import type { DocumentDescription } from '@case-desk/domain'
import { renderPdfInBrowser } from '@case-desk/pdf/browser'

// NOTE: The PDF chunk (stage 8). Only a Command imports this module, with
// `import()`, so pdfmake and its fonts are fetched the first time someone
// asks for a PDF and never before. The font files are static `.woff` assets
// of the `@fontsource` packages; each is fetched when a document needs it.

const FONT_URLS = import.meta.glob(
  '../../../node_modules/@fontsource/{inter,noto-sans,source-serif-4,hanken-grotesk}/files/*-{latin,latin-ext,greek,cyrillic}-{400,700}-{normal,italic}.woff',
  { query: '?url', import: 'default', eager: true },
)

const base64Of = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

const fontSource = async (file: string): Promise<string> => {
  const key = Object.keys(FONT_URLS).find(path => path.endsWith(`/${file}`))
  const url = key === undefined ? undefined : FONT_URLS[key]
  if (typeof url !== 'string') {
    throw new Error(`No font file ${file}`)
  }
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Font file ${file} not found`)
  }
  return base64Of(await response.blob())
}

export const renderDocument = (
  description: DocumentDescription,
  images: ReadonlyMap<string, string>,
): Promise<Uint8Array<ArrayBuffer>> =>
  renderPdfInBrowser(description, images, fontSource).then(bytes =>
    Uint8Array.from(bytes),
  )
