import { clsx } from 'clsx'
import { Array, Option } from 'effect'
import { Attribute, Html, HtmlBuilder } from 'foldkit/html'

import {
  type Item,
  type ItemEntry,
  type ItemValue,
  type Person,
  type Section,
  type SectionContent,
  type SectionEntry,
  anchorText,
  entryDisplayTitle,
  formatDate,
} from '@quoroom/domain'

import { type HighlightRange, resolveRange } from './highlight'
import { highlightedChildren, markedChildren } from './marked'
import { richTextView } from './richTextView'

// NOTE: A section of a shared draft, or one unit of it, read-only:
// plain Foldkit views of the content, no editor and no Tiptap. Text that can
// be commented on carries the data attributes the selection reader looks for
// (`COMMENT_ATTRIBUTES`): the top-level section, the entries passed through
// and the item, so a selection becomes an anchor of the comment API.

export const COMMENT_SECTION = 'comment-section'
export const COMMENT_ITEM = 'comment-item'
export const COMMENT_ENTRIES = 'comment-entries'

export type ViewContext = Readonly<{
  reportId: string
  // NOTE: The version images are read through (`imageContextToken`): `draft:N`
  // in the read-only draft view, `revision:N` for a revision. Absent: the
  // author's working copy.
  imageContext?: string
  people: ReadonlyArray<Person>
  // NOTE: Set on screens where text may be commented on.
  topSectionId: string
  // NOTE: Strings the redacted preview highlights (labels in place of names,
  // the placeholder of a withheld image).
  marks?: ReadonlyArray<string>
  // NOTE: Comments on selected text, by the item they are on
  // (`itemKey`: the entry path and the item, joined with `/`).
  highlights?: ReadonlyArray<ItemHighlight>
  // NOTE: A reader without the people list (a reviewer) sees how many people
  // an item names, never an ID, and no note on whether a picture is marked
  // safe to share.
  peopleHidden?: boolean
}>

export type ItemHighlight = HighlightRange & Readonly<{ itemKey: string }>

const EMPTY = 'Nothing written.'

const personName = (people: ReadonlyArray<Person>, id: string): string =>
  Option.match(
    Array.findFirst(people, person => person.id === id),
    { onNone: () => 'A person no longer in the list', onSome: p => p.name },
  )

const selectable =
  <M>(
    h: HtmlBuilder<M>,
    context: ViewContext,
    entryPath: ReadonlyArray<string>,
    itemId: string,
  ) =>
  (extra: string): ReadonlyArray<Attribute<M>> => [
    h.DataAttribute(COMMENT_SECTION, context.topSectionId),
    h.DataAttribute(COMMENT_ITEM, itemId),
    h.DataAttribute(COMMENT_ENTRIES, entryPath.join('/')),
    h.Class(extra),
  ]

const plain = <M>(
  h: HtmlBuilder<M>,
  text: string,
  attributes: ReadonlyArray<Attribute<M>>,
  marks: ReadonlyArray<string>,
  ranges: ReadonlyArray<HighlightRange>,
): Html =>
  text === ''
    ? h.p([h.Class('text-base text-brand-grey')], [EMPTY])
    : h.p([...attributes], highlightedChildren(h, text, 0, ranges, marks))

const rangesFor = (
  context: ViewContext,
  entryPath: ReadonlyArray<string>,
  itemId: string,
  text: string,
): ReadonlyArray<HighlightRange> => {
  const key = [...entryPath, itemId].join('/')
  return Array.flatMap(context.highlights ?? [], highlight => {
    const resolved =
      highlight.itemKey === key ? resolveRange(text, highlight) : undefined
    return resolved === undefined ? [] : [resolved]
  })
}

export const valueText = (
  item: Item,
  value: ItemValue,
  people: ReadonlyArray<Person>,
): string => {
  switch (value.type) {
    case 'text':
      return value.text
    case 'date':
      return formatDate(value.date)
    case 'select':
      return Array.map(value.optionIds, id =>
        item.type === 'select'
          ? Array.findFirst(item.options, option => option.id === id).pipe(
              Option.map(option => option.label),
              Option.getOrElse(() => id),
            )
          : id,
      ).join(', ')
    case 'people':
      return Array.map(value.personIds, id => personName(people, id)).join(', ')
    case 'signature':
      return value.date === undefined
        ? value.name
        : `${value.name}, ${formatDate(value.date)}`
    case 'not_applicable':
      return `Not applicable: ${value.reason}`
    case 'rich_text':
      return ''
    case 'repeated':
      return ''
  }
}

const shownText = (
  item: Item,
  value: ItemValue,
  context: ViewContext,
): string =>
  value.type === 'people' && context.peopleHidden === true
    ? value.personIds.length === 1
      ? '1 person listed'
      : `${value.personIds.length} people listed`
    : valueText(item, value, context.people)

const itemRow = <M>(
  h: HtmlBuilder<M>,
  item: Item,
  value: ItemValue | undefined,
  context: ViewContext,
  entryPath: ReadonlyArray<string>,
): Html => {
  const attributes = selectable(h, context, entryPath, item.id)
  const body: Html =
    item.type === 'repeated'
      ? repeatedItemView(h, item, value, context, entryPath)
      : value === undefined
        ? h.p([h.Class('text-base text-brand-grey')], [EMPTY])
        : value.type === 'rich_text'
          ? richTextView(
              h,
              value.doc,
              [...attributes('min-w-0')],
              context.reportId,
              context.imageContext,
              context.marks ?? [],
              rangesFor(context, entryPath, item.id, anchorText(value.doc)),
              context.peopleHidden !== true,
            )
          : value.type === 'repeated'
            ? h.empty
            : plain(
                h,
                shownText(item, value, context),
                attributes('whitespace-pre-wrap text-lg text-brand-ink'),
                context.marks ?? [],
                rangesFor(
                  context,
                  entryPath,
                  item.id,
                  shownText(item, value, context),
                ),
              )
  return h.div(
    [h.Class('flex min-w-0 flex-col gap-1'), h.DataAttribute('item', item.id)],
    [
      item.type === 'case_value'
        ? h.empty
        : h.p([h.Class('text-base font-medium text-brand-grey')], [item.label]),
      item.type === 'case_value' ? h.empty : body,
    ],
  )
}

const repeatedItemView = <M>(
  h: HtmlBuilder<M>,
  item: Extract<Item, { type: 'repeated' }>,
  value: ItemValue | undefined,
  context: ViewContext,
  entryPath: ReadonlyArray<string>,
): Html => {
  const entries: ReadonlyArray<ItemEntry> =
    value?.type === 'repeated' ? value.entries : []
  return Array.match(entries, {
    onEmpty: () => h.p([h.Class('text-base text-brand-grey')], ['None.']),
    onNonEmpty: list =>
      h.div(
        [h.Class('flex flex-col gap-3')],
        Array.map(list, (entry, index) =>
          h.keyed('div')(
            entry.id,
            [
              h.Class('flex flex-col gap-3 border-l-2 border-brand-line pl-3'),
              h.DataAttribute('entry', entry.id),
            ],
            [
              h.p(
                [h.Class('text-lg font-bold text-brand-ink')],
                markedChildren(
                  h,
                  entryDisplayTitle(entry, item.entryLabel, index),
                  context.marks ?? [],
                ),
              ),
              ...Array.map(item.items, inner =>
                itemRow(h, inner, entry.values[inner.id], context, [
                  ...entryPath,
                  entry.id,
                ]),
              ),
            ],
          ),
        ),
      ),
  })
}

const heading = <M>(
  h: HtmlBuilder<M>,
  depth: number,
  text: string,
  marks: ReadonlyArray<string>,
): Html =>
  h.p(
    [
      h.Class(
        clsx(
          'font-black text-brand-ink',
          depth <= 1 ? 'text-2xl' : depth === 2 ? 'text-xl' : 'text-lg',
        ),
      ),
    ],
    markedChildren(h, text, marks),
  )

const entryView = <M>(
  h: HtmlBuilder<M>,
  section: Section,
  entry: SectionEntry,
  index: number,
  context: ViewContext,
  entryPath: ReadonlyArray<string>,
  depth: number,
): Html =>
  h.keyed('div')(
    entry.id,
    [
      h.Class('flex min-w-0 flex-col gap-4 border-l-2 border-brand-line pl-3'),
      h.DataAttribute('entry', entry.id),
    ],
    [
      heading(
        h,
        depth,
        entryDisplayTitle(entry, section.title, index),
        context.marks ?? [],
      ),
      ...Array.map(section.items, item =>
        itemRow(h, item, entry.values[item.id], context, [
          ...entryPath,
          entry.id,
        ]),
      ),
      ...Array.map(section.sections, child =>
        sectionBody(
          h,
          child,
          entry.sections[child.id],
          context,
          [...entryPath, entry.id],
          depth + 1,
        ),
      ),
    ],
  )

const sectionBody = <M>(
  h: HtmlBuilder<M>,
  section: Section,
  content: SectionContent | undefined,
  context: ViewContext,
  entryPath: ReadonlyArray<string>,
  depth: number,
): Html => {
  const notApplicable = content?.notApplicable
  return h.div(
    [
      h.Class('flex min-w-0 flex-col gap-4'),
      h.DataAttribute('section', section.id),
    ],
    [
      depth === 0 ? h.empty : heading(h, depth, section.title, []),
      notApplicable === undefined
        ? h.empty
        : h.p(
            [h.Class('text-base font-medium text-brand-ink')],
            markedChildren(
              h,
              `Not applicable: ${notApplicable.reason}`,
              context.marks ?? [],
            ),
          ),
      section.repeat === undefined
        ? h.div(
            [h.Class('flex min-w-0 flex-col gap-4')],
            [
              ...Array.map(section.items, item =>
                itemRow(h, item, content?.values[item.id], context, entryPath),
              ),
              ...Array.map(section.sections, child =>
                sectionBody(
                  h,
                  child,
                  content?.sections[child.id],
                  context,
                  entryPath,
                  depth + 1,
                ),
              ),
            ],
          )
        : Array.match(content?.entries ?? [], {
            onEmpty: () => h.p([h.Class('text-base text-brand-grey')], ['None.']),
            onNonEmpty: entries =>
              h.div(
                [h.Class('flex flex-col gap-6')],
                Array.map(entries, (entry, index) =>
                  entryView(
                    h,
                    section,
                    entry,
                    index,
                    context,
                    entryPath,
                    depth + 1,
                  ),
                ),
              ),
          }),
    ],
  )
}

// NOTE: One top-level section with its title as the heading level 0 the
// screen provides; nested sections get headings below it.
export const readOnlySection = <M>(
  h: HtmlBuilder<M>,
  section: Section,
  content: SectionContent | undefined,
  context: ViewContext,
): Html => sectionBody(h, section, content, context, [], 0)

// NOTE: One item value or one entry shown on the comparison screen, with the
// item for labels and options when the key found it.
export const valueView = <M>(
  h: HtmlBuilder<M>,
  maybeItem: Option.Option<Item>,
  value: ItemValue | undefined,
  context: ViewContext,
): Html => {
  if (value === undefined) {
    return h.p(
      [h.Class('text-base italic text-brand-grey')],
      ['Nothing (removed or empty).'],
    )
  }
  if (value.type === 'rich_text') {
    return richTextView(
      h,
      value.doc,
      [],
      context.reportId,
      context.imageContext,
    )
  }
  if (value.type === 'repeated') {
    return h.p(
      [h.Class('text-base text-brand-ink')],
      [`${value.entries.length} entries`],
    )
  }
  const text = Option.match(maybeItem, {
    onNone: () =>
      value.type === 'text'
        ? value.text
        : value.type === 'date'
          ? formatDate(value.date)
          : value.type === 'not_applicable'
            ? `Not applicable: ${value.reason}`
            : value.type === 'signature'
              ? value.name
              : value.type === 'people'
                ? Array.map(value.personIds, id =>
                    personName(context.people, id),
                  ).join(', ')
                : value.optionIds.join(', '),
    onSome: item => valueText(item, value, context.people),
  })
  return text === ''
    ? h.p([h.Class('text-base italic text-brand-grey')], ['Empty.'])
    : h.p([h.Class('whitespace-pre-wrap text-lg text-brand-ink')], [text])
}
