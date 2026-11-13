import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  type RichTextDoc,
  anchorMatches,
  anchorText,
  offsetsOfProseMirrorRange,
  quotedText,
  resolveAnchor,
  textBlockStarts,
} from './index'

// ProseMirror positions of this document (a node opens and closes with one
// position each, text one per character, a hard break one):
//   heading 0, text 1..9, closes 10; paragraph 10, text from 11 ("The team
//   saw " 11..24, "bold words" 24..34, a break 34..35, "after" 35..40);
//   table 41, row 42, cell 43, paragraph 44, text 45..47; cell 49,
//   paragraph 50, text 51..53; figure 57, caption 58..72.
const DOC: RichTextDoc = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Findings' }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'The team saw ' },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' words' },
        { type: 'hardBreak' },
        { type: 'text', text: 'after' },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'A1' }] },
              ],
            },
            {
              type: 'tableCell',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'B2' }] },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'figure',
      attrs: { imageId: 'img-1', alt: 'A chart', safeToShare: true },
      content: [{ type: 'text', text: 'Chart of cases' }],
    },
  ],
}

describe('anchor text of a rich text document', () => {
  test('text blocks in order, a single newline between them, captions in, alt out', () => {
    expect(anchorText(DOC)).toBe(
      'Findings\nThe team saw bold words\nafter\nA1\nB2\nChart of cases',
    )
    expect(textBlockStarts(DOC)).toEqual([0, 9, 39, 42, 45])
  })

  test('quotedText maps offsets to text and clips to the document', () => {
    expect(quotedText(DOC, 22, 32)).toBe('bold words')
    expect(quotedText(DOC, 4, 12)).toBe('ings\nThe')
    expect(quotedText(DOC, -5, 3)).toBe('Fin')
    expect(quotedText(DOC, 50, 999)).toBe('Chart of cases'.slice(5))
    expect(quotedText(DOC, 8, 4)).toBe('ings')
  })
})

describe('offsetsOfProseMirrorRange', () => {
  test('words inside a paragraph with marks', () => {
    expect(offsetsOfProseMirrorRange(DOC, 24, 34)).toEqual({
      from: 22,
      to: 32,
      quoted: 'bold words',
    })
  })

  test('across a heading and a paragraph', () => {
    expect(offsetsOfProseMirrorRange(DOC, 5, 14)).toEqual({
      from: 4,
      to: 12,
      quoted: 'ings\nThe',
    })
  })

  test('a hard break is one position and one character', () => {
    expect(offsetsOfProseMirrorRange(DOC, 29, 38)).toEqual({
      from: 27,
      to: 36,
      quoted: 'words\naft',
    })
  })

  test('a table cell and a figure caption', () => {
    expect(offsetsOfProseMirrorRange(DOC, 51, 53)).toEqual({
      from: 42,
      to: 44,
      quoted: 'B2',
    })
    expect(offsetsOfProseMirrorRange(DOC, 67, 72)).toEqual({
      from: 54,
      to: 59,
      quoted: 'cases',
    })
  })

  test('block boundaries map to the start of the next text block', () => {
    expect(offsetsOfProseMirrorRange(DOC, 0, 10)).toEqual({
      from: 0,
      to: 8,
      quoted: 'Findings',
    })
    expect(offsetsOfProseMirrorRange(DOC, 41, 72).quoted).toBe(
      'A1\nB2\nChart of cases',
    )
  })
})

describe('anchors on redacted text', () => {
  const redacted: RichTextDoc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'The [Person 1] met [Person 1].' }],
      },
    ],
  }

  test('an anchor made on the redacted text matches at its positions', () => {
    const anchor = { from: 4, to: 14, quoted: '[Person 1]' }
    expect(anchorMatches(redacted, anchor)).toBe(true)
    expect(resolveAnchor(redacted, anchor)).toEqual(Option.some(anchor))
  })

  test('a mismatch resolves to the nearest whole occurrence or nothing', () => {
    const moved = { from: 20, to: 30, quoted: '[Person 1]' }
    expect(anchorMatches(redacted, moved)).toBe(false)
    expect(resolveAnchor(redacted, moved)).toEqual(
      Option.some({ from: 19, to: 29, quoted: '[Person 1]' }),
    )
    expect(
      Option.isNone(resolveAnchor(redacted, { from: 0, to: 3, quoted: 'Zed' })),
    ).toBe(true)
    expect(anchorMatches(redacted, { from: 0, to: 999, quoted: 'The' })).toBe(
      false,
    )
  })
})
