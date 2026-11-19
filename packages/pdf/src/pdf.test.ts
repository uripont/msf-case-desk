import { Result } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  BUILT_IN_TEMPLATES,
  DEFAULT_THEME,
  HOUR,
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
  type DocumentDescription,
  type Template,
  applyEvent,
  approvalRecordDescription,
  documentStrings,
  headingsOf,
  initialFlow,
  toRoman,
} from '@quoroom/domain'
import { PANEL_TEMPLATE } from '@quoroom/domain/testing/templates'

import { renderPdfInNode } from './node'
import { UNSUPPORTED_PLACEHOLDER } from './scripts'
import {
  CASE,
  PEOPLE,
  THEME,
  descriptionOf,
  jpegBytes,
  jpegDataUri,
} from './testing/documents'
import {
  containsBytes,
  extractPages,
  extractText,
  imageObjectCount,
  pdfInfo,
} from './testing/extract'

const TEMPLATES: ReadonlyArray<Template> = [
  ...BUILT_IN_TEMPLATES,
  PANEL_TEMPLATE,
]

const collapse = (text: string): string => text.replace(/\s+/g, ' ')
const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const IMAGES = new Map([
  ['img-secret', jpegDataUri('b')],
  ['img-safe', jpegDataUri('a')],
])

// NOTE: An independent tokenizer for the alias check: it knows nothing of the
// redactor. Letters without accents, lower case, words split on everything
// that is not a letter or a digit, plus the same text squeezed together so a
// name broken over two lines or two runs is still found.
const fold = (text: string): string =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
const wordsOf = (text: string): ReadonlyArray<string> =>
  fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word !== '')
const squeezed = (text: string): string =>
  fold(text).replace(/[^\p{L}\p{N}]+/gu, '')

const nameWords = PEOPLE.flatMap(person =>
  [person.name, ...person.aliases]
    .flatMap(wordsOf)
    .filter(word => word.length > 1),
)
const nameSqueezed = PEOPLE.flatMap(person =>
  [person.name, ...person.aliases]
    .map(squeezed)
    .filter(word => word.length >= 5),
)

const expectNoAlias = (text: string): void => {
  const words = new Set(wordsOf(text))
  for (const word of nameWords) {
    expect(words.has(word), `the word "${word}" is in the PDF text`).toBe(false)
  }
  const joined = squeezed(text)
  for (const name of nameSqueezed) {
    expect(joined.includes(name), `"${name}" is in the PDF text`).toBe(false)
  }
}

const orderedFrom = (
  text: string,
  needles: ReadonlyArray<string>,
  from: number,
): number => {
  let at = from
  for (const needle of needles) {
    const found = text.indexOf(needle, at)
    expect(
      found,
      `"${needle}" not found after position ${at}`,
    ).toBeGreaterThanOrEqual(0)
    at = found + needle.length
  }
  return at
}

type Geometry = Readonly<{ bodyStart: number; restart: boolean }>

// NOTE: What a page's number must read, worked out from the description and
// the pages alone: the cover and the front matter in roman numerals and the
// body from 1 if the numbering restarts, otherwise every page in arabic.
const labelOfPage = (page: number, geometry: Geometry): string =>
  geometry.restart
    ? page < geometry.bodyStart
      ? toRoman(page).toLowerCase()
      : String(page - geometry.bodyStart + 1)
    : String(page)

const firstPageWith = (
  pages: ReadonlyArray<string>,
  text: string,
  from: number,
): number => {
  const found = pages.findIndex(
    (page, index) => index >= from && collapse(page).includes(text),
  )
  expect(
    found,
    `"${text}" is on no page from ${from + 1}`,
  ).toBeGreaterThanOrEqual(0)
  return found
}

const contentsOf = (description: DocumentDescription) =>
  description.parts
    .flatMap(part => part.blocks)
    .flatMap(block => (block.type === 'contents' ? [block] : []))[0]

describe.each(
  TEMPLATES.flatMap(template =>
    [false, true].map(
      redacted => [template.shortName, template, redacted] as const,
    ),
  ),
)('%s, redacted: %s', (_name, template, redacted) => {
  const description = descriptionOf(template, {
    redacted,
    bulk: { imageId: 'img-secret', safeToShare: false },
  })
  const rendered = (async () => {
    const bytes = await renderPdfInNode(description, IMAGES)
    return { bytes, pages: await extractPages(bytes) }
  })()

  test('is a multi-page PDF under 3 MB', async () => {
    const { bytes, pages } = await rendered
    expect(pages.length).toBeGreaterThanOrEqual(5)
    expect(bytes.length).toBeLessThan(3 * 1024 * 1024)
  })

  test('has every section heading, numbered, in order', async () => {
    const { pages } = await rendered
    const text = collapse(pages.join('\n'))
    const headings = headingsOf(description)
    expect(headings.length).toBeGreaterThan(3)
    const contents = contentsOf(description)
    let from = 0
    if (contents !== undefined) {
      // NOTE: the contents lists them once and the pages show them again.
      from = orderedFrom(
        text,
        headings.filter(h => h.inContents).map(h => h.text),
        0,
      )
    }
    orderedFrom(
      text,
      headings.map(h => h.text),
      from,
    )
    for (const heading of headings) {
      if (heading.number !== undefined) {
        expect(text).toContain(heading.number.full)
      }
    }
  })

  test('names the report, the revision, the date and the view', async () => {
    const { pages } = await rendered
    const text = collapse(pages.join('\n'))
    expect(text).toContain(template.name)
    expect(text).toContain('Revision 2')
    expect(text).toContain('12 Nov 2026')
    expect(text.includes('Redacted')).toBe(redacted)
    expect(text).toContain(CASE.reference)
  })

  test('prints the contents with the page each heading is on', async () => {
    const { pages } = await rendered
    const contents = contentsOf(description)
    if (contents === undefined) return
    const text = collapse(pages.join('\n'))
    expect(text).toContain(contents.title)
    const headings = headingsOf(description)
    const bodyHeading = description.parts
      .find(part => part.kind === 'body')
      ?.blocks.find(block => block.type === 'heading')
    const lastEntry = contents.entries[contents.entries.length - 1]
    const lastTocPage = pages.findIndex(page =>
      collapse(page).includes(lastEntry?.title ?? '#'),
    )
    const bodyStartIndex = firstPageWith(
      pages,
      bodyHeading?.type === 'heading' ? bodyHeading.text : '#',
      lastTocPage + 1,
    )
    const geometry: Geometry = {
      bodyStart: bodyStartIndex + 1,
      restart: template.pageNumbering === 'restart_after_front_matter',
    }
    let from = lastTocPage + 1
    const expected = new Map<string, string>()
    for (const heading of headings) {
      const index = firstPageWith(pages, heading.text, from)
      from = index
      expected.set(heading.id, labelOfPage(index + 1, geometry))
    }
    const tocText = collapse(pages.slice(0, lastTocPage + 1).join('\n'))
    for (const entry of contents.entries) {
      const heading = headings.find(h => h.id === entry.headingId)
      const label = expected.get(entry.headingId) ?? '?'
      const title = heading?.text ?? entry.title
      expect(
        new RegExp(
          `${escapeRegExp(title)}\\s*${escapeRegExp(label)}(?:\\s|$)`,
        ).test(tocText),
        `the contents should read "${title} ${label}"`,
      ).toBe(true)
    }
  })

  test('shows the original image to the original view and never to the redacted one', async () => {
    const { bytes } = await rendered
    expect(containsBytes(bytes, jpegBytes('b'))).toBe(!redacted)
    expect(imageObjectCount(bytes) > 0).toBe(!redacted)
    expect(description.imageIds.includes('img-secret')).toBe(!redacted)
  })

  test('a redacted PDF holds no alias anywhere, an original one does', async () => {
    const { bytes, pages } = await rendered
    const info = await pdfInfo(bytes)
    const text = [...pages, ...Object.values(info).map(String)].join('\n')
    if (redacted) {
      expectNoAlias(text)
      expectNoAlias(documentStrings(description).join('\n'))
      expect(collapse(text)).toContain('Person 1')
    } else {
      expect(collapse(text)).toContain('Mara Velt')
    }
  })

  test('rendering the same version twice gives the same text', async () => {
    const { pages } = await rendered
    const again = await extractPages(await renderPdfInNode(description, IMAGES))
    expect(again).toEqual(pages)
  })
})

describe('the furniture and the page numbers', () => {
  const withFooter = (template: Template): Template => ({
    ...template,
    furniture: { ...template.furniture, footer: 'Page {page} of {pages}' },
  })

  test('a restart after the front matter counts the front matter in roman numerals and the body from 1', async () => {
    const description = descriptionOf(withFooter(INVESTIGATION_TEMPLATE), {
      redacted: false,
    })
    const pages = (
      await extractPages(await renderPdfInNode(description, IMAGES))
    ).map(collapse)
    const body = description.parts.find(part => part.kind === 'body')
    const first = body?.blocks.find(block => block.type === 'heading')
    const bodyStart = firstPageWith(
      pages,
      first?.type === 'heading' ? first.text : '#',
      2,
    )
    const bodyPages = pages.length - bodyStart
    const frontPages = bodyStart
    expect(pages[0]).not.toContain('Page i')
    expect(pages[1]).toContain(
      `Page ii of ${toRoman(frontPages).toLowerCase()}`,
    )
    expect(pages[bodyStart - 1]).toContain(
      `Page ${toRoman(frontPages).toLowerCase()} of ${toRoman(frontPages).toLowerCase()}`,
    )
    expect(pages[bodyStart]).toContain(`Page 1 of ${bodyPages}`)
    expect(pages[pages.length - 1]).toContain(
      `Page ${bodyPages} of ${bodyPages}`,
    )
  })

  test('continuous numbering counts every page', async () => {
    const description = descriptionOf(withFooter(INTAKE_TEMPLATE), {
      redacted: false,
    })
    const pages = (
      await extractPages(await renderPdfInNode(description, IMAGES))
    ).map(collapse)
    pages.forEach((page, index) => {
      expect(page).toContain(`Page ${index + 1} of ${pages.length}`)
    })
  })

  test('the cover has its own header, the others the template text', async () => {
    const description = descriptionOf(INVESTIGATION_TEMPLATE, {
      redacted: false,
    })
    const pages = (
      await extractPages(await renderPdfInNode(description, IMAGES))
    ).map(collapse)
    expect(pages[0]).toContain('STRICTLY CONFIDENTIAL')
    expect(pages[0]).not.toContain('STRICTLY CONFIDENTIAL -')
    expect(pages[2]).toContain('STRICTLY CONFIDENTIAL - iii -')
  })
})

describe('the theme', () => {
  test('applies the fonts, the logo and the organisation name; a safe image is shown', async () => {
    const description = descriptionOf(INTAKE_TEMPLATE, {
      redacted: true,
      bulk: { imageId: 'img-safe', safeToShare: true, paragraphs: 2 },
      theme: {
        ...THEME,
        logo: 'logo',
        organisationName: 'Another Organisation',
        colors: {
          primary: '#14532d',
          accent: '#7c2d12',
          text: '#111111',
          background: '#fffbeb',
        },
        fonts: { heading: 'Source Serif 4', body: 'Noto Sans' },
      },
    })
    const images = new Map([...IMAGES, ['logo', jpegDataUri('a')]])
    expect(description.imageIds).toContain('logo')
    expect(description.imageIds).toContain('img-safe')
    const bytes = await renderPdfInNode(description, images)
    expect(imageObjectCount(bytes)).toBeGreaterThanOrEqual(2)
    expect(await extractText(bytes)).toContain('Another Organisation')
    const info = await pdfInfo(bytes)
    expect(info.Author).toBe('Another Organisation')
    expect(info.Title).toBe(`${INTAKE_TEMPLATE.name} - Revision 2`)
  })

  test('an image that cannot be fetched is replaced by a note, not an error', async () => {
    const description = descriptionOf(INTAKE_TEMPLATE, {
      redacted: false,
      bulk: { imageId: 'img-missing', paragraphs: 1 },
    })
    const text = await extractText(
      await renderPdfInNode(description, new Map()),
    )
    expect(text).toContain('[Image not available]')
  })
})

describe('scripts (D16)', () => {
  const miniDescription = (text: string): DocumentDescription => ({
    info: { title: 'Scripts', subject: 'S', author: 'A' },
    version: {
      reportName: 'Scripts',
      versionLabel: 'Draft 1',
      date: '2026-11-12',
      redacted: false,
    },
    redactionLabel: undefined,
    style: {
      headingFont: 'Hanken Grotesk',
      bodyFont: 'Inter',
      primary: '#1f4e79',
      accent: '#9a3412',
      text: '#1a1a1a',
      background: '#ffffff',
    },
    furniture: {
      normal: { header: undefined, footer: undefined },
      cover: undefined,
    },
    parts: [
      {
        kind: 'body',
        numbering: { group: 'all', style: 'arabic', restartAt: 1 },
        blocks: [
          {
            type: 'heading',
            id: 'a',
            level: 1,
            number: undefined,
            title: text,
            text,
            inContents: false,
          },
          {
            type: 'paragraph',
            runs: [{ text }, { text: ' bold', bold: true }],
          },
        ],
      },
    ],
    imageIds: [],
  })

  test('Latin, extended Latin, Greek and Cyrillic print as themselves, other scripts as a placeholder', async () => {
    const text =
      'Ștefan Doğan, Καλημέρα κόσμε, Привет мир, مرحبا بالعالم, ሰላም ዓለም'
    const pages = await extractPages(
      await renderPdfInNode(miniDescription(text)),
    )
    const out = collapse(pages.join('\n'))
    expect(out).toContain('Ștefan Doğan')
    expect(out).toContain('Καλημέρα κόσμε')
    expect(out).toContain('Привет мир')
    expect(out).toContain(UNSUPPORTED_PLACEHOLDER)
    expect(out).not.toContain('مرحبا')
    expect(out).not.toContain('ሰላም')
  })
})

describe('the approval record', () => {
  const T0 = 1_762_900_000_000
  const COMMITTEE = [
    { accountId: 'r1', roleId: 'committee' },
    { accountId: 'r2', roleId: 'committee' },
  ]
  const step = (
    flow: typeof initialFlow,
    now: number,
    event: Parameters<typeof applyEvent>[2],
  ) => {
    const result = applyEvent(
      { template: INTAKE_TEMPLATE, authors: ['a1'], now },
      flow,
      event,
    )
    if (Result.isFailure(result)) throw new Error(result.failure.message)
    return result.success
  }
  let flow = step(initialFlow, T0, { type: 'share_draft' })
  flow = step(flow, T0, {
    type: 'publish_revision',
    draft: 1,
    deadline: T0 + 72 * HOUR,
    participants: COMMITTEE,
  })

  test('renders as a PDF with the revisions and who decided what', async () => {
    const description = approvalRecordDescription({
      template: INTAKE_TEMPLATE,
      flow,
      events: [],
      authors: ['a1'],
      accountNames: { r1: 'Rosa Reviewer', r2: 'Rui Reviewer' },
      caseFile: CASE,
      theme: DEFAULT_THEME,
      reportName: 'Synthetic report',
      date: '2026-11-12',
    })
    const text = collapse(await extractText(await renderPdfInNode(description)))
    expect(text).toContain('Approval record')
    expect(text).toContain('Revision 1')
    expect(text).toContain('Rosa Reviewer')
    expect(text).toContain('No decision')
  })
})
