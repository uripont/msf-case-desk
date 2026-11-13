import { clsx } from 'clsx'
import { Array, Match, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import {
  type CaseValueItem,
  type DateItem,
  type Item,
  type ItemValue,
  type PeopleItem,
  type Person,
  type SelectItem,
  type SignatureItem,
  type TextItem,
  isValidDate,
} from '@case-desk/domain'

import { fieldClassName, focusRing, labelClassName } from '../style'

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

export type FieldContext<M> = Readonly<{
  caseValues: CaseValues
  people: ReadonlyArray<Person>
  isDisabled: boolean
  onChange: (itemId: string, maybeValue: Option.Option<ItemValue>) => M
}>

export const fieldId = (itemId: string): string => `field-${itemId}`

const guidanceId = (itemId: string): string => `${fieldId(itemId)}-guidance`

const hintId = (itemId: string): string => `${fieldId(itemId)}-hint`

export const requirementNote = (item: Item): string =>
  item.requirement === 'required' ? 'Required.' : 'Optional.'

export const optionText = (option: SelectItem['options'][number]): string =>
  option.code === undefined ? option.label : `${option.code}. ${option.label}`

const hints = <M>(h: HtmlBuilder<M>, item: Item): ReadonlyArray<Html> => [
  h.p(
    [h.Id(hintId(item.id)), h.Class('-mt-1 text-sm text-msf-grey')],
    [requirementNote(item)],
  ),
  item.instruction === undefined
    ? h.empty
    : h.p(
        [
          h.Id(guidanceId(item.id)),
          h.Class('-mt-1 text-pretty text-sm italic text-msf-grey'),
        ],
        [item.instruction],
      ),
]

const describedBy = <M>(h: HtmlBuilder<M>, item: Item) =>
  h.AriaDescribedBy(
    item.instruction === undefined
      ? hintId(item.id)
      : `${hintId(item.id)} ${guidanceId(item.id)}`,
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

const labelled = <M>(h: HtmlBuilder<M>, item: Item, control: Html): Html =>
  frame(h, item, [
    h.label([h.Class(labelClassName), h.For(fieldId(item.id))], [item.label]),
    ...hints(h, item),
    control,
  ])

const grouped = <M>(
  h: HtmlBuilder<M>,
  item: Item,
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
      ...hints(h, item),
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
    h.input([
      h.Id(fieldId(item.id)),
      h.Type('text'),
      h.Autocomplete('off'),
      h.Value(value?.type === 'text' ? value.text : ''),
      h.Class(fieldClassName),
      h.Disabled(context.isDisabled),
      describedBy(h, item),
      h.OnInput(text =>
        context.onChange(
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
    h.input([
      h.Id(fieldId(item.id)),
      h.Type(dateFormat(item.precision)),
      h.Value(value?.type === 'date' ? value.date : ''),
      h.Class(fieldClassName),
      h.Disabled(context.isDisabled),
      describedBy(h, item),
      h.OnInput(date =>
        context.onChange(
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
  return grouped(h, item, [
    ...Array.map(item.options, option =>
      h.label(
        [h.Class(choiceClassName), h.For(`${fieldId(item.id)}-${option.id}`)],
        [
          h.input([
            h.Id(`${fieldId(item.id)}-${option.id}`),
            h.Type(item.multiple ? 'checkbox' : 'radio'),
            h.Name(fieldId(item.id)),
            h.Class('mt-1 size-5 shrink-0 accent-msf-red'),
            h.Checked(Array.contains(chosen, option.id)),
            h.Disabled(context.isDisabled),
            h.OnClick(
              context.onChange(
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
      : clearButton(h, item, context.onChange(item.id, Option.none())),
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
    return grouped(h, item, [noPeopleNote(h)])
  }
  if (!item.multiple) {
    return labelled(
      h,
      item,
      h.select(
        [
          h.Id(fieldId(item.id)),
          h.Value(chosen[0] ?? ''),
          h.Class(fieldClassName),
          h.Disabled(context.isDisabled),
          describedBy(h, item),
          h.OnChange(personId =>
            context.onChange(
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
    Array.map(context.people, person =>
      h.label(
        [h.Class(choiceClassName), h.For(`${fieldId(item.id)}-${person.id}`)],
        [
          h.input([
            h.Id(`${fieldId(item.id)}-${person.id}`),
            h.Type('checkbox'),
            h.Class('mt-1 size-5 shrink-0 accent-msf-red'),
            h.Checked(Array.contains(chosen, person.id)),
            h.Disabled(context.isDisabled),
            h.OnClick(
              context.onChange(
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
  return grouped(h, item, [
    h.div(
      [h.Class('flex flex-col gap-2')],
      [
        h.label(
          [h.Class(labelClassName), h.For(`${fieldId(item.id)}-name`)],
          ['Name'],
        ),
        h.input([
          h.Id(`${fieldId(item.id)}-name`),
          h.Type('text'),
          h.Autocomplete('off'),
          h.Value(name),
          h.Class(fieldClassName),
          h.Disabled(context.isDisabled),
          h.Disabled(context.isDisabled),
          h.OnInput(typed =>
            context.onChange(item.id, signatureValue(typed, date)),
          ),
        ]),
      ],
    ),
    h.div(
      [h.Class('flex flex-col gap-2')],
      [
        h.label(
          [h.Class(labelClassName), h.For(`${fieldId(item.id)}-date`)],
          ['Date'],
        ),
        h.input([
          h.Id(`${fieldId(item.id)}-date`),
          h.Type('date'),
          h.Value(date),
          h.Class(fieldClassName),
          h.Disabled(context.isDisabled),
          h.OnInput(typed =>
            context.onChange(
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
        h.Id(fieldId(item.id)),
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

const richTextSlot = <M>(h: HtmlBuilder<M>, item: Item): Html =>
  frame(h, item, [
    h.p([h.Class(labelClassName)], [item.label]),
    ...hints(h, item),
    h.div(
      [
        h.Id(fieldId(item.id)),
        h.DataAttribute('slot', 'rich-text'),
        h.Class(
          'flex min-h-24 items-center border border-dashed border-msf-line px-3 py-3 text-base text-msf-grey',
        ),
      ],
      ['The text editor opens here in the next step. Nothing written is lost.'],
    ),
  ])

const repeatedSlot = <M>(h: HtmlBuilder<M>, item: Item): Html =>
  frame(h, item, [
    h.p([h.Class(labelClassName)], [item.label]),
    ...hints(h, item),
    h.div(
      [
        h.Id(fieldId(item.id)),
        h.DataAttribute('slot', 'repeated'),
        h.Class(
          'flex min-h-16 items-center border border-dashed border-msf-line px-3 py-3 text-base text-msf-grey',
        ),
      ],
      ['Entries of this list are added in a later step.'],
    ),
  ])

// ---- One item -------------------------------------------------------------

export const itemField = <M>(
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
      rich_text: richTextItem => richTextSlot(h, richTextItem),
      repeated: repeatedItem => repeatedSlot(h, repeatedItem),
    }),
  )
