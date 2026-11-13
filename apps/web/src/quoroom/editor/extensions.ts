import { type Extensions, Node, mergeAttributes } from '@tiptap/core'
import { Bold } from '@tiptap/extension-bold'
import { Document } from '@tiptap/extension-document'
import { Heading } from '@tiptap/extension-heading'
import { Italic } from '@tiptap/extension-italic'
import { Link } from '@tiptap/extension-link'
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list'
import { Paragraph } from '@tiptap/extension-paragraph'
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
  TableView,
} from '@tiptap/extension-table'
import { Text } from '@tiptap/extension-text'
import { Underline } from '@tiptap/extension-underline'
import { Gapcursor, UndoRedo } from '@tiptap/extensions'
import type { Node as ProseNode } from '@tiptap/pm/model'

import { QuoroomImage } from '../images/figureImage'
import { isAllowedLinkUrl } from './toolbar'

// NOTE: The Tiptap configuration for Quoroom rich text (D3). It is exactly the
// strict schema of `packages/domain/src/richtext.ts`: the same nodes and marks,
// headings 1 to 4, links to http, https, mailto and tel only, no hard break,
// and the content limits of the schema (a list item or a table cell holds
// paragraphs, headings and lists, never a table or an image). The element
// maps what the editor produces through `decodeRichText` anyway.
const HEADING_LEVELS: Array<1 | 2 | 3 | 4> = [1, 2, 3, 4]

const LIMITED_BLOCKS = '(paragraph | heading | bulletList | orderedList)+'

const LimitedListItem = ListItem.extend({
  content: LIMITED_BLOCKS,
})

// NOTE: Tiptap 3.33 gives a cell an `align` attribute. The schema has none, so
// it is removed from the node and never reaches the JSON.
const withoutAlign = <A extends Record<string, unknown>>(
  attributes: A,
): Omit<A, 'align'> => {
  const { align: _align, ...rest } = attributes
  return rest
}

const LimitedTableCell = TableCell.extend({
  content: LIMITED_BLOCKS,
  addAttributes() {
    return withoutAlign(this.parent?.() ?? {})
  },
})

const LimitedTableHeader = TableHeader.extend({
  content: LIMITED_BLOCKS,
  addAttributes() {
    return withoutAlign(this.parent?.() ?? {})
  },
})

const columnWidths = (table: ProseNode): ReadonlyArray<number | null> => {
  const row = table.firstChild
  if (row === null) {
    return []
  }
  const widths: Array<number | null> = []
  row.forEach(cell => {
    const { colspan, colwidth } = cell.attrs
    Array.from({ length: colspan }, (_, index) => index).forEach(index => {
      widths.push(colwidth?.[index] ?? null)
    })
  })
  return widths
}

// NOTE: Tiptap 3.33 leaves the old pixel width on a column element when a
// width is removed (undo of a column resize), so the screen disagreed with the
// document. This view clears it.
class ClearingTableView extends TableView {
  update(node: ProseNode): boolean {
    const accepted = super.update(node)
    if (accepted) {
      const widths = columnWidths(node)
      Array.from(this.colgroup.children).forEach((column, index) => {
        if (column instanceof HTMLElement && !widths[index]) {
          column.style.removeProperty('width')
        }
      })
    }
    return accepted
  }
}

export const FIGURE_IMAGE_CLASS = 'quoroom-figure-image'

export type FigureOptions = Readonly<{
  // NOTE: The report whose images the figures show, read when a figure is
  // drawn (the element sets it from its `report` property).
  getReport: () => string
}>

const SAFE_TEXT = 'Marked safe to share.'
const NOT_SAFE_TEXT = 'Not marked safe to share. Withheld from redacted views.'

const control = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag)
  element.className = className
  return element
}

// NOTE: An image with its caption. The image itself is never in the document,
// only its ID, its alt text and the "safe to share" flag. In the editor the
// figure is drawn by a plain DOM node view: the picture (the image element,
// which fetches it through the image route), a button that marks it safe to
// share and says so, a field for the alt text, a button that removes it, and
// the caption, which is the editable part of the node. The controls change the
// node's attributes with one transaction each, so undo and redo cover them and
// the change is saved like any other.
export const Figure = Node.create<FigureOptions>({
  name: 'figure',
  group: 'block',
  content: 'inline*',
  marks: '',
  isolating: true,
  defining: true,
  addOptions: () => ({ getReport: () => '' }),
  addAttributes: () => ({
    imageId: {
      default: '',
      parseHTML: element => element.getAttribute('data-image-id') ?? '',
      renderHTML: attributes => ({ 'data-image-id': attributes.imageId }),
    },
    alt: {
      default: '',
      parseHTML: element => element.getAttribute('data-alt') ?? '',
      renderHTML: attributes => ({ 'data-alt': attributes.alt }),
    },
    safeToShare: {
      default: false,
      parseHTML: element => element.getAttribute('data-safe') === 'true',
      renderHTML: attributes => ({
        'data-safe': attributes.safeToShare ? 'true' : 'false',
      }),
    },
  }),
  parseHTML: () => [{ tag: 'figure[data-image-id]' }],
  renderHTML: ({ node, HTMLAttributes }) => [
    'figure',
    mergeAttributes(HTMLAttributes, { class: 'quoroom-figure' }),
    [
      'div',
      { class: FIGURE_IMAGE_CLASS, contenteditable: 'false' },
      node.attrs.alt === '' ? 'Image' : `Image: ${node.attrs.alt}`,
    ],
    ['figcaption', 0],
  ],
  addNodeView() {
    const { getReport } = this.options
    return ({ node, getPos, editor }) => {
      let current = node
      const dom = control('figure', 'quoroom-figure')
      const body = control('div', 'quoroom-figure-body')
      body.setAttribute('contenteditable', 'false')
      const picture = new QuoroomImage()
      picture.className = FIGURE_IMAGE_CLASS
      const controls = control('div', 'quoroom-figure-controls')
      const safe = control('button', 'quoroom-tool quoroom-figure-safe')
      safe.type = 'button'
      safe.setAttribute('aria-label', 'Safe to share')
      const badge = control('p', 'quoroom-figure-badge')
      const altLabel = control('label', 'quoroom-figure-alt')
      altLabel.textContent = 'Description of the image (alt text)'
      const alt = control('input', 'quoroom-link-input')
      alt.type = 'text'
      alt.maxLength = 500
      alt.autocomplete = 'off'
      altLabel.append(alt)
      const remove = control('button', 'quoroom-tool')
      remove.type = 'button'
      remove.textContent = 'Remove image'
      controls.append(safe, badge, altLabel, remove)
      body.append(picture, controls)
      const contentDOM = control('figcaption', 'quoroom-figure-caption')
      contentDOM.setAttribute('data-placeholder', 'Caption')
      dom.append(body, contentDOM)

      const show = (shown: ProseNode): void => {
        const isSafe = shown.attrs.safeToShare === true
        dom.setAttribute('data-image-id', String(shown.attrs.imageId))
        dom.setAttribute('data-safe', isSafe ? 'true' : 'false')
        picture.report = getReport()
        picture.imageId = String(shown.attrs.imageId)
        picture.alt = String(shown.attrs.alt)
        safe.textContent = isSafe ? 'Safe to share: yes' : 'Safe to share: no'
        safe.setAttribute('aria-pressed', String(isSafe))
        badge.textContent = isSafe ? SAFE_TEXT : NOT_SAFE_TEXT
        if (alt.value !== shown.attrs.alt) {
          alt.value = String(shown.attrs.alt)
        }
        const canEdit = editor.isEditable
        safe.disabled = !canEdit
        alt.disabled = !canEdit
        remove.disabled = !canEdit
      }
      const change = (patch: Readonly<Record<string, unknown>>): void => {
        const at = getPos()
        if (at === undefined || !editor.isEditable) {
          return
        }
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(at, undefined, {
            ...current.attrs,
            ...patch,
          }),
        )
      }
      safe.addEventListener('click', () =>
        change({ safeToShare: !(current.attrs.safeToShare === true) }),
      )
      alt.addEventListener('change', () => change({ alt: alt.value }))
      remove.addEventListener('click', () => {
        const at = getPos()
        if (at !== undefined && editor.isEditable) {
          editor.view.dispatch(
            editor.state.tr.delete(at, at + current.nodeSize),
          )
        }
      })
      show(node)

      return {
        dom,
        contentDOM,
        update: updated => {
          if (
            updated.type !== current.type ||
            updated.attrs.imageId !== current.attrs.imageId
          ) {
            return false
          }
          current = updated
          show(updated)
          return true
        },
        stopEvent: event =>
          event.target instanceof globalThis.Node &&
          body.contains(event.target),
        ignoreMutation: mutation =>
          mutation.type === 'selection'
            ? false
            : !contentDOM.contains(mutation.target),
      }
    }
  },
})

// NOTE: Authors do not edit a link title, and Tiptap would write `title: null`
// for it, which the schema refuses. The attribute is removed from the mark.
const TitlelessLink = Link.extend({
  addAttributes() {
    const { title: _title, ...rest } = this.parent?.() ?? {}
    return rest
  },
})

export const quoroomExtensions = (
  getReport: () => string = () => '',
): Extensions => [
  Document,
  Paragraph,
  Text,
  Heading.configure({ levels: HEADING_LEVELS }),
  Bold,
  Italic,
  Underline,
  TitlelessLink.configure({
    openOnClick: false,
    autolink: false,
    linkOnPaste: false,
    protocols: ['mailto', 'tel'],
    isAllowedUri: url => isAllowedLinkUrl(url),
    HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
  }),
  BulletList,
  OrderedList,
  LimitedListItem,
  Table.configure({
    resizable: true,
    cellMinWidth: 80,
    View: ClearingTableView,
  }),
  TableRow,
  LimitedTableHeader,
  LimitedTableCell,
  Figure.configure({ getReport }),
  UndoRedo,
  Gapcursor,
]
