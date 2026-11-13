import { Result } from 'effect'
import { describe, expect, test } from 'vitest'

import { decodeRichText } from '@case-desk/domain'
import { Editor } from '@tiptap/core'

import { quoroomExtensions } from './extensions'
import { normaliseEditorJson, serializeRichText } from './richText'

const EMPTY = { type: 'doc', content: [{ type: 'paragraph' }] }

const newEditor = (content: object = EMPTY) =>
  new Editor({
    element: document.createElement('div'),
    extensions: quoroomExtensions(),
    content,
  })

const docOf = (editor: Editor) =>
  Result.getOrThrow(normaliseEditorJson(editor.getJSON()))

describe('the editor produces the strict schema', () => {
  test('marks, headings, lists, links and a table all decode', () => {
    const editor = newEditor()
    editor.commands.insertContent('Hello world')
    editor
      .chain()
      .selectAll()
      .toggleBold()
      .toggleItalic()
      .toggleUnderline()
      .run()
    editor.chain().selectAll().setLink({ href: 'https://example.org' }).run()
    editor.commands.setHeading({ level: 2 })
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
    })
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: 'orderedList',
      content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
    })
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
    expect(
      Result.isSuccess(
        decodeRichText(JSON.parse(serializeRichText(docOf(editor)))),
      ),
    ).toBe(true)
  })

  test('canonical JSON has none of the editor defaults', () => {
    const editor = newEditor()
    editor.commands.insertContent('x')
    editor.chain().selectAll().setLink({ href: 'https://example.org' }).run()
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })
    const text = serializeRichText(docOf(editor))
    expect(text).not.toContain('target')
    expect(text).not.toContain('rel')
    expect(text).not.toContain('align')
    expect(text).not.toContain('colspan')
  })

  test('setting stored content and reading it back is string identical', () => {
    const editor = newEditor()
    editor.commands.insertContent('Round trip')
    editor.chain().selectAll().toggleBold().run()
    editor.commands.insertTable({ rows: 3, cols: 2, withHeaderRow: true })
    const stored = serializeRichText(docOf(editor))
    const other = newEditor()
    other.commands.setContent(JSON.parse(stored), { emitUpdate: false })
    expect(serializeRichText(docOf(other))).toBe(stored)
  })

  test('a link to anything but http, https, mailto or tel is refused', () => {
    const editor = newEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'bad',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
      ],
    })
    expect(Result.isFailure(normaliseEditorJson(editor.getJSON()))).toBe(true)
  })

  test('a table cell and a list item never hold a table or a figure', () => {
    const schema = newEditor().schema
    const cell = schema.nodes.tableCell
    const item = schema.nodes.listItem
    expect(cell?.contentMatch.matchType(schema.nodes.table!)).toBeNull()
    expect(cell?.contentMatch.matchType(schema.nodes.figure!)).toBeNull()
    expect(item?.contentMatch.matchType(schema.nodes.paragraph!)).not.toBeNull()
    expect(
      item?.contentMatch
        .matchType(schema.nodes.paragraph!)
        ?.matchType(schema.nodes.table!),
    ).toBeNull()
  })

  test('headings go to level four only', () => {
    const editor = newEditor()
    editor.commands.setHeading({ level: 4 })
    expect(editor.getJSON().content?.[0]?.attrs?.level).toBe(4)
  })

  test('an existing figure is kept and decodes', () => {
    const figure = {
      type: 'figure',
      attrs: {
        imageId: 'img-1',
        alt: 'A synthetic picture',
        safeToShare: false,
      },
      content: [{ type: 'text', text: 'A caption' }],
    }
    const editor = newEditor({
      type: 'doc',
      content: [figure, { type: 'paragraph' }],
    })
    const doc = docOf(editor)
    expect(doc.content[0]).toEqual(figure)
    expect(editor.getHTML()).toContain('Image: A synthetic picture')
  })
})
