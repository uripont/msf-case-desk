import type {
  CaseValueField,
  DatePrecision,
  Item,
  Requirement,
  Role,
  Section,
  SelectOption,
} from './template'

// NOTE: Small constructors that keep template data readable. They only build
// plain template data; the template is still checked by `validateTemplate`.

type Common = Readonly<{
  requirement?: Requirement
  instruction?: string
}>

const common = (id: string, label: string, options: Common) => ({
  id,
  label,
  requirement: options.requirement ?? 'required',
  ...(options.instruction === undefined
    ? {}
    : { instruction: options.instruction }),
})

export const textItem = (
  id: string,
  label: string,
  options: Common = {},
): Item => ({
  ...common(id, label, options),
  type: 'text',
})

export const richTextItem = (
  id: string,
  label: string,
  options: Common = {},
): Item => ({ ...common(id, label, options), type: 'rich_text' })

export const dateItem = (
  id: string,
  label: string,
  options: Common & Readonly<{ precision?: DatePrecision }> = {},
): Item => ({
  ...common(id, label, options),
  type: 'date',
  precision: options.precision ?? 'day',
})

export const peopleItem = (
  id: string,
  label: string,
  options: Common & Readonly<{ multiple?: boolean }> = {},
): Item => ({
  ...common(id, label, options),
  type: 'people',
  multiple: options.multiple ?? false,
})

export const caseValueItem = (
  id: string,
  label: string,
  field: CaseValueField,
  options: Common = {},
): Item => ({ ...common(id, label, options), type: 'case_value', field })

export const signatureItem = (
  id: string,
  label: string,
  options: Common = {},
): Item => ({ ...common(id, label, options), type: 'signature' })

export const selectItem = (
  id: string,
  label: string,
  options: ReadonlyArray<SelectOption>,
  extra: Common & Readonly<{ multiple?: boolean; endOptionId?: string }> = {},
): Item => ({
  ...common(id, label, extra),
  type: 'select',
  multiple: extra.multiple ?? false,
  options,
  ...(extra.endOptionId === undefined
    ? {}
    : { endOptionId: extra.endOptionId }),
})

export const repeatedItem = (
  id: string,
  label: string,
  entryLabel: string,
  items: ReadonlyArray<Item>,
  options: Common & Readonly<{ min?: number; max?: number }> = {},
): Item => ({
  ...common(id, label, options),
  type: 'repeated',
  entryLabel,
  min:
    options.min ??
    (options.requirement === 'required' || options.requirement === undefined
      ? 1
      : 0),
  ...(options.max === undefined ? {} : { max: options.max }),
  items,
})

export const option = (
  id: string,
  label: string,
  code?: string,
): SelectOption => (code === undefined ? { id, label } : { id, label, code })

type SectionOptions = Common &
  Readonly<{
    numbered?: boolean
    frontMatter?: boolean
    repeat?: Readonly<{ min: number; max?: number }>
    sections?: ReadonlyArray<Section>
  }>

export const section = (
  id: string,
  title: string,
  items: ReadonlyArray<Item>,
  options: SectionOptions = {},
): Section => ({
  id,
  title,
  ...(options.instruction === undefined
    ? {}
    : { instruction: options.instruction }),
  requirement: options.requirement ?? 'required',
  frontMatter: options.frontMatter ?? false,
  numbered: options.numbered ?? true,
  ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
  items,
  sections: options.sections ?? [],
})

export const draftingRole = (
  id: string,
  name: string,
  permissions: Role['permissions'],
): Role => ({ id, name, kind: 'drafting', view: 'full', permissions })

export const reviewingRole = (
  id: string,
  name: string,
  view: Role['view'],
  permissions: Role['permissions'],
  approval?: Role['approval'],
): Role => ({
  id,
  name,
  kind: 'reviewing',
  view,
  permissions,
  ...(approval === undefined ? {} : { approval }),
})
