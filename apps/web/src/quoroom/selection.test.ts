import { inertHtml } from 'foldkit/html'
import { afterEach, describe, expect, test } from 'vitest'

import type { RichTextDoc } from '@case-desk/domain'

import { COMMENT_ITEM, COMMENT_SECTION } from './contentView'
import { selectionAnchor } from './editor/richText'
import { richTextView } from './richTextView'
import { readCommentSelection } from './selection'

// NOTE: The same selected words must give the same anchor from the editor
// (ProseMirror positions converted by the domain scheme) and from the
// read-only view (a DOM selection over the rendered text, with a figure's
// label lines and image placeholder around the caption).

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const attributesOf = (
  node: Record<string, unknown>,
): Array<[string, string]> => {
  const { data } = node
  const attrs = isRecord(data) ? data['attrs'] : undefined
  return isRecord(attrs)
    ? Object.entries(attrs).flatMap(([name, value]): Array<[string, string]> =>
        typeof value === 'string' ? [[name, value]] : [],
      )
    : []
}

// NOTE: A minimal VNode to DOM conversion for the test: tag, attributes and
// children, which is all the selection reader looks at.
const toDom = (node: unknown): Node => {
  if (!isRecord(node)) {
    return document.createTextNode('')
  }
  const { sel, text, children } = node
  if (typeof sel !== 'string') {
    return document.createTextNode(typeof text === 'string' ? text : '')
  }
  const element = document.createElement(sel.split(/[.#]/)[0] ?? 'div')
  for (const [name, value] of attributesOf(node)) {
    element.setAttribute(name, value)
  }
  for (const child of Array.isArray(children) ? children : []) {
    element.appendChild(toDom(child))
  }
  return element
}

const mount = (): Element => {
  const view = richTextView(inertHtml, DOC, [
    inertHtml.DataAttribute(COMMENT_SECTION, 's'),
    inertHtml.DataAttribute(COMMENT_ITEM, 'i'),
  ])
  const root = document.createElement('div')
  root.appendChild(toDom(view))
  document.body.appendChild(root)
  return root
}

const textNodeWith = (root: Element, text: string): Text => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && node.data.includes(text)) {
      return node
    }
  }
  throw new Error(`no text ${text}`)
}

const selectWords = (root: Element, text: string): void => {
  const node = textNodeWith(root, text)
  const start = node.data.indexOf(text)
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, start + text.length)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

const readOnlyAnchor = () => {
  const read = readCommentSelection()
  if (read._tag !== 'Some' || read.value._tag !== 'Some') {
    throw new Error('nothing selected')
  }
  const { from, to, quoted } = read.value.value
  return { from, to, quoted }
}

// ProseMirror positions of the words in `DOC` (see the domain test).
const EDITOR_CASES: ReadonlyArray<
  Readonly<{ words: string; pmFrom: number; pmTo: number }>
> = [
  { words: 'Findings', pmFrom: 1, pmTo: 9 },
  { words: ' words', pmFrom: 28, pmTo: 34 },
  { words: 'B2', pmFrom: 51, pmTo: 53 },
  { words: 'cases', pmFrom: 67, pmTo: 72 },
]

describe('comment anchors from the editor and the read-only view', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  test.each(EDITOR_CASES)(
    'the words "$words" give the same anchor from both',
    ({ words, pmFrom, pmTo }) => {
      const root = mount()
      selectWords(root, words)
      const fromView = readOnlyAnchor()
      const fromEditor = selectionAnchor(DOC, pmFrom, pmTo)
      expect(fromEditor._tag).toBe('Some')
      const editor =
        fromEditor._tag === 'Some'
          ? {
              from: fromEditor.value.from,
              to: fromEditor.value.to,
              quoted: fromEditor.value.text,
            }
          : undefined
      expect(fromView.quoted).toBe(words)
      expect(editor).toEqual(fromView)
    },
  )

  test('words in the caption are counted without the figure labels', () => {
    const root = mount()
    selectWords(root, 'cases')
    expect(readOnlyAnchor()).toEqual({ from: 54, to: 59, quoted: 'cases' })
  })
})
