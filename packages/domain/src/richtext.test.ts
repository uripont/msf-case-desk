import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'

import {
  type RichTextDoc,
  canonicalRichText,
  decodeRichText,
  encodeRichText,
  isRichTextEmpty,
  richTextBlocks,
  richTextFigures,
} from './index'
import {
  noiseArbitrary,
  noisyRichText,
  richTextArbitrary,
} from './testing/content'

const doc = (...content: RichTextDoc['content']): RichTextDoc => ({
  type: 'doc',
  content,
})

const refused = (input: unknown): boolean =>
  Result.isFailure(decodeRichText(input))

const paragraph = (...content: Array<unknown>) => ({
  type: 'paragraph',
  content,
})

const text = (value: string, marks?: Array<unknown>) => ({
  type: 'text',
  text: value,
  ...(marks === undefined ? {} : { marks }),
})

describe('rich text schema', () => {
  test('accepts every node and mark of the subset', () => {
    const everything = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [text('Title')],
        },
        paragraph(
          text('a', [
            { type: 'bold' },
            { type: 'italic' },
            { type: 'underline' },
          ]),
          { type: 'hardBreak' },
          text('b', [{ type: 'link', attrs: { href: 'https://example.org' } }]),
        ),
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                paragraph(text('x')),
                {
                  type: 'orderedList',
                  attrs: { start: 3 },
                  content: [
                    { type: 'listItem', content: [paragraph(text('y'))] },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableHeader',
                  attrs: { colspan: 2, rowspan: 1, colwidth: [120, 80] },
                  content: [paragraph(text('h'))],
                },
                { type: 'tableCell', content: [paragraph()] },
              ],
            },
          ],
        },
        {
          type: 'figure',
          attrs: { imageId: 'img-1', alt: 'a chart', safeToShare: false },
          content: [text('Figure 1')],
        },
      ],
    }
    expect(Result.isSuccess(decodeRichText(everything))).toBe(true)
  })

  test('refuses what is outside the subset', () => {
    const cases: Array<[string, unknown]> = [
      ['an unknown node', doc({ type: 'codeBlock' } as never)],
      [
        'an unknown mark',
        doc(paragraph(text('a', [{ type: 'strike' }])) as never),
      ],
      [
        'an unknown attribute',
        doc({ type: 'paragraph', attrs: { align: 'left' } } as never),
      ],
      [
        'an unknown key on text',
        doc(paragraph({ type: 'text', text: 'a', extra: 1 }) as never),
      ],
      [
        'a heading level 5',
        doc({ type: 'heading', attrs: { level: 5 } } as never),
      ],
      ['a heading without a level', doc({ type: 'heading' } as never)],
      [
        'a script link',
        doc(
          paragraph(
            text('a', [
              { type: 'link', attrs: { href: 'javascript:alert(1)' } },
            ]),
          ) as never,
        ),
      ],
      [
        'a figure without the safe flag',
        doc({ type: 'figure', attrs: { imageId: 'img-1', alt: '' } } as never),
      ],
      [
        'an image node',
        doc({
          type: 'image',
          attrs: { src: 'data:image/png;base64,AAAA' },
        } as never),
      ],
      ['an empty document', { type: 'doc', content: [] }],
      ['an empty list', doc({ type: 'bulletList', content: [] } as never)],
      [
        'a table inside a cell',
        doc({
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [{ type: 'table', content: [] }],
                },
              ],
            },
          ],
        } as never),
      ],
      [
        'a colspan of 0',
        doc({
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 0 },
                  content: [paragraph()],
                },
              ],
            },
          ],
        } as never),
      ],
      ['not an object', 'text'],
      [
        'a document inside a document',
        doc({ type: 'doc', content: [] } as never),
      ],
    ]
    for (const [name, input] of cases) {
      expect(refused(input), name).toBe(true)
    }
  })

  test('decode and encode round-trip generated documents unchanged', () => {
    fc.assert(
      fc.property(richTextArbitrary, generated => {
        const decoded = decodeRichText(generated)
        expect(Result.isSuccess(decoded)).toBe(true)
        if (Result.isFailure(decoded)) {
          return
        }
        expect(decoded.success).toEqual(generated)
        const encoded = encodeRichText(decoded.success)
        expect(Result.isSuccess(encoded) && encoded.success).toEqual(generated)
        const viaJson = decodeRichText(JSON.parse(JSON.stringify(generated)))
        expect(Result.isSuccess(viaJson) && viaJson.success).toEqual(generated)
      }),
      { numRuns: 200 },
    )
  })
})

describe('canonical rich text', () => {
  test('drops empty text, merges equal neighbours, orders marks', () => {
    const messy = doc(
      paragraph(
        text('he', [{ type: 'italic' }, { type: 'bold' }]),
        text('', [{ type: 'bold' }]),
        text('llo', [{ type: 'bold' }, { type: 'italic' }, { type: 'bold' }]),
        { type: 'hardBreak' },
        text(' world', [
          {
            type: 'link',
            attrs: {
              href: 'https://example.org',
              target: '_blank',
              rel: null,
              class: null,
            },
          },
        ]),
      ) as never,
    )
    expect(canonicalRichText(messy)).toEqual(
      doc(
        paragraph(
          text('hello', [{ type: 'bold' }, { type: 'italic' }]),
          { type: 'hardBreak' },
          text(' world', [
            { type: 'link', attrs: { href: 'https://example.org' } },
          ]),
        ) as never,
      ),
    )
  })

  test('removes default attributes and empty content', () => {
    const messy = doc(
      { type: 'paragraph', content: [text('')] } as never,
      {
        type: 'orderedList',
        attrs: { start: 1, type: null },
        content: [{ type: 'listItem', content: [paragraph(text('a'))] }],
      } as never,
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                attrs: { colspan: 1, rowspan: 1, colwidth: null },
                content: [paragraph(text('a'))],
              },
              {
                type: 'tableCell',
                attrs: { colspan: 2, rowspan: 1, colwidth: [100, 100] },
                content: [paragraph(text('b'))],
              },
            ],
          },
        ],
      } as never,
    )
    expect(canonicalRichText(messy)).toEqual(
      doc(
        { type: 'paragraph' },
        {
          type: 'orderedList',
          content: [{ type: 'listItem', content: [paragraph(text('a'))] }],
        } as never,
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [paragraph(text('a'))] },
                {
                  type: 'tableCell',
                  attrs: { colspan: 2, colwidth: [100, 100] },
                  content: [paragraph(text('b'))],
                },
              ],
            },
          ],
        } as never,
      ),
    )
  })

  test('keeps what matters: text, order, image flag, link target', () => {
    const original = doc(
      {
        type: 'figure',
        attrs: { imageId: 'img-2', alt: 'x', safeToShare: true },
        content: [text('cap')],
      } as never,
      paragraph(
        text('a', [
          {
            type: 'link',
            attrs: { href: 'https://example.org/a', title: 't' },
          },
        ]),
      ) as never,
    )
    expect(canonicalRichText(original)).toEqual(original)
  })

  test('is idempotent, and its result is still a valid document', () => {
    fc.assert(
      fc.property(richTextArbitrary, noiseArbitrary, (generated, noise) => {
        const noisy = noisyRichText(generated, noise)
        const once = canonicalRichText(noisy)
        expect(canonicalRichText(once)).toEqual(once)
        expect(Result.isSuccess(decodeRichText(once))).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  test('is the same for a document and its editor variants', () => {
    fc.assert(
      fc.property(richTextArbitrary, noiseArbitrary, (generated, noise) => {
        const noisy = noisyRichText(generated, noise)
        expect(Result.isSuccess(decodeRichText(noisy))).toBe(true)
        expect(canonicalRichText(noisy)).toEqual(canonicalRichText(generated))
      }),
      { numRuns: 300 },
    )
  })

  test('never changes the text or the image flags', () => {
    fc.assert(
      fc.property(richTextArbitrary, generated => {
        const canonical = canonicalRichText(generated)
        expect(richTextBlocks(canonical)).toEqual(richTextBlocks(generated))
        expect(richTextFigures(canonical)).toEqual(richTextFigures(generated))
      }),
      { numRuns: 200 },
    )
  })

  test('a different text or flag is a different canonical form', () => {
    const a = doc(paragraph(text('one')) as never)
    const b = doc(paragraph(text('two')) as never)
    expect(canonicalRichText(a)).not.toEqual(canonicalRichText(b))
    const safe = (flag: boolean) =>
      doc({
        type: 'figure',
        attrs: { imageId: 'img-1', alt: '', safeToShare: flag },
      } as never)
    expect(canonicalRichText(safe(true))).not.toEqual(
      canonicalRichText(safe(false)),
    )
  })
})

describe('reading helpers', () => {
  test('a document is empty without visible text and without an image', () => {
    expect(isRichTextEmpty(doc({ type: 'paragraph' }))).toBe(true)
    expect(isRichTextEmpty(doc(paragraph(text('  ')) as never))).toBe(true)
    expect(isRichTextEmpty(doc(paragraph(text('a')) as never))).toBe(false)
    expect(
      isRichTextEmpty(
        doc({
          type: 'figure',
          attrs: { imageId: 'img-1', alt: '', safeToShare: false },
        } as never),
      ),
    ).toBe(false)
  })
})
