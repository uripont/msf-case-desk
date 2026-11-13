import { clsx } from 'clsx'
import { Array, Match, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import {
  type CaseValueItem,
  type DateItem,
  type Item,
  type ItemStep,
  type ItemValue,
  type PeopleItem,
  type Person,
  type RichTextDoc,
  type SelectItem,
  type SignatureItem,
  type TextItem,
  canAdd,
  countText,
  isValidDate,
  itemLimits,
} from '@case-desk/domain'

import { fieldClassName, focusRing, labelClassName } from '../style'
import { richTextForItem } from './editor/richText'
import { editorElement } from './editor/spec'
import { EditorState } from './editor/state'
import {
  addButton,
  countLine,
  entryControls,
  notApplicableButton,
  notApplicableForm,
  notApplicableNotice,
} from './entryViews'
import { richTextView } from './richTextView'

// NOTE: One field for each kind of item the drafting screen edits without the
// rich-text editor (D23). A field is a function of the item, its value and the
// case file; it reports a change as `onChange(item ID, Some(value))`, or `None`
// when the author emptied it, so content stays sparse. The instruction of an
// item is guidance, shown beside the field and never put into a value.

export type CaseValues = Readonly<{
  reference: string
  unit: string
  title: string
}>

export type RichTextContext<M> = Readonly<{
  editor: EditorState
  versionOf: (steps: ReadonlyArray<ItemStep>, itemId: string) => number
  onChange: (
    steps: ReadonlyArray<ItemStep>,
    itemId: string,
    content: string,
    version: number,
  ) => M
  onSelection: (
    steps: ReadonlyArray<ItemStep>,
    itemId: string,
    range: Readonly<{ from: number; to: number; text: string }>,
  ) => M
  onRetryLoad: M
  // NOTE: Images (stage 4d): the report they belong to, the bytes of image
  // space left (-1 when unknown), the line that says what is used, and what an
  // uploaded image reports.
  reportId: string
  remaining: number
  usageText: string
  onImage: () => M
}>

// NOTE: Editing the entries of a repeated item (stage 4e). The handlers name
// the list by the steps above it and its item; removing asks first.
export type EntryHandlers<M> = Readonly<{
  onAdd: (steps: ReadonlyArray<ItemStep>, itemId: string) => M
  onMove: (
    steps: ReadonlyArray<ItemStep>,
    itemId: string,
    entryId: string,
    step: -1 | 1,
  ) => M
  onRemove: (
    steps: ReadonlyArray<ItemStep>,
    itemId: string,
    entryId: string,
    label: string,
  ) => M
}>

// NOTE: *Not applicable* on an item that is optional with a reason. A draft
// reason exists while the form is open.
export type NotApplicableHandlers<M> = Readonly<{
  draftOf: (
    steps: ReadonlyArray<ItemStep>,
    itemId: string,
  ) => Option.Option<Readonly<{ reason: string; isMissing: boolean }>>
  onOpen: (steps: ReadonlyArray<ItemStep>, itemId: string, reason: string) => M
  onType: (steps: ReadonlyArray<ItemStep>, itemId: string, text: string) => M
  onSubmit: (steps: ReadonlyArray<ItemStep>, itemId: string) => M
  onCancel: (steps: ReadonlyArray<ItemStep>, itemId: string) => M
  onRestore: (steps: ReadonlyArray<ItemStep>, itemId: string) => M
}>

export type FieldContext<M> = Readonly<{
  caseValues: CaseValues
  people: ReadonlyArray<Person>
  isDisabled: boolean
  // NOTE: Where this item sits inside repeated items: the steps from the
  // outermost, and the suffix that keeps control IDs apart.
  steps: ReadonlyArray<ItemStep>
  scope: string
  onChange: (
    steps: ReadonlyArray<ItemStep>,
    itemId: string,
    maybeValue: Option.Option<ItemValue>,
  ) => M
  richText: RichTextContext<M>
  entries: EntryHandlers<M>
  notApplicable: NotApplicableHandlers<M>
}>

export const fieldId = (itemId: string, scope = ''): string =>
  `field-${itemId}${scope}`

const guidanceId = (itemId: string, scope: string): string =>
  `${fieldId(itemId, scope)}-guidance`

const hintId = (itemId: string, scope: string): string =>
  `${fieldId(itemId, scope)}-hint`

export const requirementNote = (item: Item): string =>
  item.requirement === 'required' ? 'Required.' : 'Optional.'

export const optionText = (option: SelectItem['options'][number]): string =>
  option.code === undefined ? option.label : `${option.code}. ${option.label}`

const hints = <M>(
  h: HtmlBuilder<M>,
  item: Item,
  scope: string,
): ReadonlyArray<Html> => [
  h.p(
    [h.Id(hintId(item.id, scope)), h.Class('-mt-1 text-sm text-msf-grey')],
    [requirementNote(item)],
  ),
  item.instruction === undefined
    ? h.empty
    : h.p(
        [
          h.Id(guidanceId(item.id, scope)),
          h.Class('-mt-1 text-pretty text-sm italic text-msf-grey'),
        ],
        [item.instruction],
      ),
]

const describedBy = <M>(h: HtmlBuilder<M>, item: Item, scope: string) =>
  h.AriaDescribedBy(
    item.instruction === undefined
      ? hintId(item.id, scope)
      : `${hintId(item.id, scope)} ${guidanceId(item.id, scope)}`,
  )

const frame = <M>(
  h: HtmlBuilder<M>,
  item: Item,
  children: ReadonlyArray<Html>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-2'), h.DataAttribute('item', item.id)],
    children,
  )

const labelled = <M>(
  h: HtmlBuilder<M>,
  item: Item,
  scope: string,
  control: Html,
): Html =>
  frame(h, item, [
    h.label(
      [h.Class(labelClassName), h.For(fieldId(item.id, scope))],
      [item.label],
    ),
    ...hints(h, item, scope),
    control,
  ])

const grouped = <M>(
  h: HtmlBuilder<M>,
  item: Item,
  scope: string,
  controls: ReadonlyArray<Html>,
): Html =>
  h.fieldset(
    [
      h.Class('flex min-w-0 flex-col gap-2 border-0 p-0'),
      h.DataAttribute('item', item.id),
    ],
    [
      h.legend(
        [h.Class('mb-2 text-base font-medium text-msf-ink')],
        [item.label],
      ),
      ...hints(h, item, scope),
      ...controls,
    ],
  )

const choiceClassName = clsx(
  'flex min-h-11 cursor-pointer items-start gap-3 py-1 text-lg',
)

// ---- Text and date --------------------------------------------------------

const textField = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: TextItem,
  value: ItemValue | undefined,
): Html =>
  labelled(
    h,
    item,
    context.scope,
    h.input([
      h.Id(fieldId(item.id, context.scope)),
      h.Type('text'),
      h.Autocomplete('off'),
      h.Value(value?.type === 'text' ? value.text : ''),
      h.Class(fieldClassName),
      h.Disabled(context.isDisabled),
      describedBy(h, item, context.scope),
      h.OnInput(text =>
        context.onChange(
          context.steps,
          item.id,
          text === '' ? Option.none() : Option.some({ type: 'text', text }),
        ),
      ),
    ]),
  )

const dateFormat = (precision: DateItem['precision']): string =>
  precision === 'day' ? 'date' : 'month'

// NOTE: A date input reports a whole date or an empty one. A year with more
// than four digits is not a date this system keeps, so it counts as empty.
const dateValue = (date: string, isValid: boolean): Option.Option<ItemValue> =>
  date !== '' && isValid ? Option.some({ type: 'date', date }) : Option.none()

const dateField = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: DateItem,
  value: ItemValue | undefined,
): Html => {
  return labelled(
    h,
    item,
    context.scope,
    h.input([
      h.Id(fieldId(item.id, context.scope)),
      h.Type(dateFormat(item.precision)),
      h.Value(value?.type === 'date' ? value.date : ''),
      h.Class(fieldClassName),
      h.Disabled(context.isDisabled),
      describedBy(h, item, context.scope),
      h.OnInput(date =>
        context.onChange(
          context.steps,
          item.id,
          dateValue(date, isValidDate(date, item.precision)),
        ),
      ),
    ]),
  )
}

// ---- Select and people ----------------------------------------------------

const chosenOptionIds = (
  value: ItemValue | undefined,
): ReadonlyArray<string> => (value?.type === 'select' ? value.optionIds : [])

const chosenPersonIds = (
  value: ItemValue | undefined,
): ReadonlyArray<string> => (value?.type === 'people' ? value.personIds : [])

const toggled = (
  chosen: ReadonlyArray<string>,
  id: string,
): ReadonlyArray<string> =>
  Array.contains(chosen, id)
    ? Array.filter(chosen, existing => existing !== id)
    : Array.append(chosen, id)

const selectValue = (
  optionIds: ReadonlyArray<string>,
): Option.Option<ItemValue> =>
  Array.isReadonlyArrayEmpty(optionIds)
    ? Option.none()
    : Option.some({ type: 'select', optionIds: [...optionIds] })

const peopleValue = (
  personIds: ReadonlyArray<string>,
): Option.Option<ItemValue> =>
  Array.isReadonlyArrayEmpty(personIds)
    ? Option.none()
    : Option.some({ type: 'people', personIds: [...personIds] })

const clearButton = <M>(h: HtmlBuilder<M>, item: Item, message: M): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class(
        clsx(
          'inline-flex h-10 cursor-pointer items-center self-start border border-msf-line px-3 text-base text-msf-ink transition-colors hover:border-msf-red hover:text-msf-red',
          focusRing,
        ),
      ),
      h.AriaLabel(`Clear the answer to ${item.label}`),
      h.OnClick(message),
    ],
    ['Clear answer'],
  )

const selectField = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: SelectItem,
  value: ItemValue | undefined,
): Html => {
  const chosen = chosenOptionIds(value)
  return grouped(h, item, context.scope, [
    ...Array.map(item.options, option =>
      h.label(
        [
          h.Class(choiceClassName),
          h.For(`${fieldId(item.id, context.scope)}-${option.id}`),
        ],
        [
          h.input([
            h.Id(`${fieldId(item.id, context.scope)}-${option.id}`),
            h.Type(item.multiple ? 'checkbox' : 'radio'),
            h.Name(fieldId(item.id, context.scope)),
            h.Class('mt-1 size-5 shrink-0 accent-msf-red'),
            h.Checked(Array.contains(chosen, option.id)),
            h.Disabled(context.isDisabled),
            h.OnClick(
              context.onChange(
                context.steps,
                item.id,
                selectValue(
                  item.multiple ? toggled(chosen, option.id) : [option.id],
                ),
              ),
            ),
          ]),
          optionText(option),
        ],
      ),
    ),
    item.multiple || Array.isReadonlyArrayEmpty(chosen) || context.isDisabled
      ? h.empty
      : clearButton(
          h,
          item,
          context.onChange(context.steps, item.id, Option.none()),
        ),
  ])
}

export const personText = (person: Person): string => person.name

const noPeopleNote = <M>(h: HtmlBuilder<M>): Html =>
  h.p(
    [h.Class('text-base text-msf-grey')],
    [
      'No people are listed in this report yet. The names list is added in a later step.',
    ],
  )

const peopleField = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: PeopleItem,
  value: ItemValue | undefined,
): Html => {
  const chosen = chosenPersonIds(value)
  if (Array.isReadonlyArrayEmpty(context.people)) {
    return grouped(h, item, context.scope, [noPeopleNote(h)])
  }
  if (!item.multiple) {
    return labelled(
      h,
      item,
      context.scope,
      h.select(
        [
          h.Id(fieldId(item.id, context.scope)),
          h.Value(chosen[0] ?? ''),
          h.Class(fieldClassName),
          h.Disabled(context.isDisabled),
          describedBy(h, item, context.scope),
          h.OnChange(personId =>
            context.onChange(
              context.steps,
              item.id,
              personId === '' ? Option.none() : peopleValue([personId]),
            ),
          ),
        ],
        [
          h.option(
            [h.Value(''), h.Selected(chosen[0] === undefined)],
            ['None'],
          ),
          ...Array.map(context.people, person =>
            h.option(
              [
                h.Value(person.id),
                h.Selected(Array.contains(chosen, person.id)),
              ],
              [personText(person)],
            ),
          ),
        ],
      ),
    )
  }
  return grouped(
    h,
    item,
    context.scope,
    Array.map(context.people, person =>
      h.label(
        [
          h.Class(choiceClassName),
          h.For(`${fieldId(item.id, context.scope)}-${person.id}`),
        ],
        [
          h.input([
            h.Id(`${fieldId(item.id, context.scope)}-${person.id}`),
            h.Type('checkbox'),
            h.Class('mt-1 size-5 shrink-0 accent-msf-red'),
            h.Checked(Array.contains(chosen, person.id)),
            h.Disabled(context.isDisabled),
            h.OnClick(
              context.onChange(
                context.steps,
                item.id,
                peopleValue(toggled(chosen, person.id)),
              ),
            ),
          ]),
          personText(person),
        ],
      ),
    ),
  )
}

// ---- Signature, case-file value, placeholders ------------------------------

const signatureValue = (
  name: string,
  date: string,
): Option.Option<ItemValue> =>
  name === '' && date === ''
    ? Option.none()
    : Option.some({
        type: 'signature',
        name,
        ...(date === '' ? {} : { date }),
      })

const signatureField = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: SignatureItem,
  value: ItemValue | undefined,
): Html => {
  const name = value?.type === 'signature' ? value.name : ''
  const date = value?.type === 'signature' ? (value.date ?? '') : ''
  return grouped(h, item, context.scope, [
    h.div(
      [h.Class('flex flex-col gap-2')],
      [
        h.label(
          [
            h.Class(labelClassName),
            h.For(`${fieldId(item.id, context.scope)}-name`),
          ],
          ['Name'],
        ),
        h.input([
          h.Id(`${fieldId(item.id, context.scope)}-name`),
          h.Type('text'),
          h.Autocomplete('off'),
          h.Value(name),
          h.Class(fieldClassName),
          h.Disabled(context.isDisabled),
          h.Disabled(context.isDisabled),
          h.OnInput(typed =>
            context.onChange(
              context.steps,
              item.id,
              signatureValue(typed, date),
            ),
          ),
        ]),
      ],
    ),
    h.div(
      [h.Class('flex flex-col gap-2')],
      [
        h.label(
          [
            h.Class(labelClassName),
            h.For(`${fieldId(item.id, context.scope)}-date`),
          ],
          ['Date'],
        ),
        h.input([
          h.Id(`${fieldId(item.id, context.scope)}-date`),
          h.Type('date'),
          h.Value(date),
          h.Class(fieldClassName),
          h.Disabled(context.isDisabled),
          h.OnInput(typed =>
            context.onChange(
              context.steps,
              item.id,
              signatureValue(name, isValidDate(typed, 'day') ? typed : ''),
            ),
          ),
        ]),
      ],
    ),
    h.p(
      [h.Class('text-sm text-msf-grey')],
      [
        'Quoroom keeps a name and a date. The signature line is printed in the PDF.',
      ],
    ),
  ])
}

const caseValueText = (context: CaseValues, item: CaseValueItem): string =>
  item.field === 'reference'
    ? context.reference
    : item.field === 'unit'
      ? context.unit
      : context.title

const caseValueField = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: CaseValueItem,
): Html =>
  frame(h, item, [
    h.p([h.Class(labelClassName)], [item.label]),
    h.p(
      [
        h.Id(fieldId(item.id, context.scope)),
        h.AriaLabel(`${item.label}, from the case file`),
        h.Class(
          'min-h-12 border border-msf-line bg-msf-mist px-3 py-3 text-lg text-msf-black',
        ),
      ],
      [caseValueText(context.caseValues, item)],
    ),
    h.p(
      [h.Class('-mt-1 text-sm text-msf-grey')],
      [
        'From the case file. It is shown here and cannot be changed in the report.',
      ],
    ),
  ])

const richTextDocOf = (
  value: ItemValue | undefined,
): Option.Option<RichTextDoc> =>
  value?.type === 'rich_text' ? Option.some(value.doc) : Option.none()

const editorBox = 'quoroom-editor-box min-w-0'

const editorPending = <M>(
  h: HtmlBuilder<M>,
  item: Item,
  scope: string,
  text: string,
): Html =>
  h.div(
    [
      h.Id(fieldId(item.id, scope)),
      h.DataAttribute('slot', 'rich-text'),
      h.Role('status'),
      h.Class(
        'flex min-h-24 items-center border border-dashed border-msf-line px-3 py-3 text-base text-msf-grey',
      ),
    ],
    [text],
  )

const editorFailed = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: Item,
): Html =>
  h.div(
    [
      h.Id(fieldId(item.id, context.scope)),
      h.DataAttribute('slot', 'rich-text'),
      h.Class(
        'flex flex-col items-start gap-3 border border-msf-alert px-3 py-3',
      ),
    ],
    [
      h.p(
        [h.Role('alert'), h.Class('text-base font-medium text-msf-alert')],
        ['The text editor could not be loaded. Nothing written is lost.'],
      ),
      h.button(
        [
          h.Type('button'),
          h.Class(
            clsx(
              'min-h-11 cursor-pointer border border-msf-ink px-4 text-base font-medium',
              focusRing,
            ),
          ),
          h.OnClick(context.richText.onRetryLoad),
        ],
        ['Try again'],
      ),
    ],
  )

const editorReady = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: Item,
  value: ItemValue | undefined,
): Html => {
  const editor = editorElement.withMessage(h)
  const rich = context.richText
  return editor([
    h.Id(fieldId(item.id, context.scope)),
    h.DataAttribute('slot', 'rich-text'),
    h.Class(editorBox),
    editor.Content(richTextForItem(richTextDocOf(value))),
    editor.Version(rich.versionOf(context.steps, item.id)),
    editor.Disabled(false),
    editor.Label(item.label),
    editor.Report(rich.reportId),
    editor.Remaining(rich.remaining),
    editor.OnImage(() => rich.onImage()),
    editor.OnChange(detail =>
      rich.onChange(context.steps, item.id, detail.content, detail.version),
    ),
    editor.OnSelection(detail =>
      rich.onSelection(context.steps, item.id, detail),
    ),
  ])
}

const richTextControl = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: Item,
  value: ItemValue | undefined,
): Html =>
  context.isDisabled
    ? Option.match(richTextDocOf(value), {
        onNone: () =>
          h.p(
            [
              h.Id(fieldId(item.id, context.scope)),
              h.DataAttribute('slot', 'rich-text'),
              h.Class('text-base text-msf-grey'),
            ],
            ['Nothing written.'],
          ),
        onSome: doc =>
          richTextView(
            h,
            doc,
            [
              h.Id(fieldId(item.id, context.scope)),
              h.DataAttribute('slot', 'rich-text'),
            ],
            context.richText.reportId,
          ),
      })
    : EditorState.match(context.richText.editor, {
        NotLoaded: () =>
          editorPending(h, item, context.scope, 'The text editor opens here.'),
        Loading: () =>
          editorPending(h, item, context.scope, 'Loading the text editor.'),
        Failed: () => editorFailed(h, context, item),
        Ready: () => editorReady(h, context, item, value),
      })

const richTextSlot = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: Item,
  value: ItemValue | undefined,
): Html =>
  frame(h, item, [
    h.p([h.Class(labelClassName)], [item.label]),
    ...hints(h, item, context.scope),
    richTextControl(h, context, item, value),
    context.isDisabled
      ? h.empty
      : h.p(
          [
            h.DataAttribute('slot', 'image-usage'),
            h.Class('text-sm text-msf-grey'),
          ],
          [context.richText.usageText],
        ),
  ])

// ---- Repeated items --------------------------------------------------------------------

const entriesOf = (value: ItemValue | undefined) =>
  value?.type === 'repeated' ? value.entries : []

const repeatedField = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: Extract<Item, { type: 'repeated' }>,
  value: ItemValue | undefined,
): Html => {
  const entries = entriesOf(value)
  const limits = itemLimits(item)
  return frame(h, item, [
    h.p([h.Class(labelClassName)], [item.label]),
    ...hints(h, item, context.scope),
    countLine(
      h,
      countText(entries.length, limits, item.entryLabel.toLowerCase()),
    ),
    h.ol(
      [
        h.Id(fieldId(item.id, context.scope)),
        h.DataAttribute('slot', 'repeated'),
        h.AriaLabel(item.label),
        h.Class('flex flex-col gap-6'),
      ],
      Array.map(entries, (entry, index) => {
        const label = `${item.entryLabel} ${index + 1}`
        const child: FieldContext<M> = {
          ...context,
          steps: [...context.steps, { itemId: item.id, entryId: entry.id }],
          scope: `${context.scope}-${entry.id}`,
        }
        return h.keyed('li')(
          entry.id,
          [h.Class('min-w-0')],
          [
            h.section(
              [
                h.AriaLabel(label),
                h.DataAttribute('entry', entry.id),
                h.Class(
                  'flex min-w-0 flex-col gap-5 border-l-4 border-msf-line pl-4',
                ),
              ],
              [
                h.h4([h.Class('text-xl font-bold')], [label]),
                ...Array.map(item.items, inner =>
                  itemField(h, child, inner, entry.values[inner.id]),
                ),
                context.isDisabled
                  ? h.empty
                  : entryControls(h, {
                      label,
                      canMoveUp: index > 0,
                      canMoveDown: index < entries.length - 1,
                      onMoveUp: context.entries.onMove(
                        context.steps,
                        item.id,
                        entry.id,
                        -1,
                      ),
                      onMoveDown: context.entries.onMove(
                        context.steps,
                        item.id,
                        entry.id,
                        1,
                      ),
                      onRemove: context.entries.onRemove(
                        context.steps,
                        item.id,
                        entry.id,
                        label,
                      ),
                    }),
              ],
            ),
          ],
        )
      }),
    ),
    context.isDisabled
      ? h.empty
      : addButton(
          h,
          `Add ${item.entryLabel.toLowerCase()}`,
          context.entries.onAdd(context.steps, item.id),
          !canAdd(entries.length, limits),
        ),
  ])
}

// ---- One item -------------------------------------------------------------------------

const control = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: Item,
  value: ItemValue | undefined,
): Html =>
  Match.value(item).pipe(
    Match.discriminatorsExhaustive('type')({
      text: textItem => textField(h, context, textItem, value),
      date: dateItem => dateField(h, context, dateItem, value),
      select: selectItem => selectField(h, context, selectItem, value),
      people: peopleItem => peopleField(h, context, peopleItem, value),
      signature: signatureItem =>
        signatureField(h, context, signatureItem, value),
      case_value: caseValueItem => caseValueField(h, context, caseValueItem),
      rich_text: richTextItem => richTextSlot(h, context, richTextItem, value),
      repeated: repeatedItem => repeatedField(h, context, repeatedItem, value),
    }),
  )

const NA_KEEPS = 'Mark it as applicable again to write here.'

// NOTE: An item that is optional with a reason can be marked not applicable,
// with the reason. The mark replaces the value: the screen keeps what was
// there for as long as the report is open, so it can be put back.
export const itemField = <M>(
  h: HtmlBuilder<M>,
  context: FieldContext<M>,
  item: Item,
  value: ItemValue | undefined,
): Html => {
  const canMark =
    item.requirement === 'optional_with_reason' && item.type !== 'case_value'
  if (!canMark) {
    return control(h, context, item, value)
  }
  const draft = context.notApplicable.draftOf(context.steps, item.id)
  const scopeId = `${item.id}${context.scope}`
  if (Option.isSome(draft)) {
    return frame(h, item, [
      h.p([h.Class(labelClassName)], [item.label]),
      notApplicableForm(h, {
        id: scopeId,
        label: item.label,
        reason: draft.value.reason,
        isMissing: draft.value.isMissing,
        onType: text =>
          context.notApplicable.onType(context.steps, item.id, text),
        onSubmit: context.notApplicable.onSubmit(context.steps, item.id),
        onCancel: context.notApplicable.onCancel(context.steps, item.id),
      }),
    ])
  }
  if (value?.type === 'not_applicable') {
    return frame(h, item, [
      h.p([h.Class(labelClassName)], [item.label]),
      notApplicableNotice(h, {
        label: item.label,
        reason: value.reason,
        isDisabled: context.isDisabled,
        keeps: NA_KEEPS,
        onEdit: context.notApplicable.onOpen(
          context.steps,
          item.id,
          value.reason,
        ),
        onRestore: context.notApplicable.onRestore(context.steps, item.id),
      }),
    ])
  }
  return h.div(
    [h.Class('flex flex-col gap-3')],
    [
      control(h, context, item, value),
      context.isDisabled
        ? h.empty
        : notApplicableButton(
            h,
            item.label,
            context.notApplicable.onOpen(context.steps, item.id, ''),
          ),
    ],
  )
}
