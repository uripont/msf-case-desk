import { Result } from 'effect'

import {
  type CaseValueField,
  type CoverPart,
  type DatePrecision,
  type Item,
  type ItemType,
  type NumberStyle,
  type NumberSuffix,
  type PageNumbering,
  type Permission,
  type Requirement,
  type RoleKind,
  type Section,
  type Template,
  TEMPLATE_SCHEMA_VERSION,
} from './template'
import { type TemplateProblem, validateTemplate } from './template-validation'

// NOTE: The flat form model of the template editor (stage 9). Every record
// is a plain row with only strings, numbers and booleans, so an editor can
// change one field by ID. Trees become lists with a `parentId`, and the order
// of siblings is the order in the list. An absent text is '' and an absent
// number is null. `templateFromForm(templateToForm(t))` is `t`.

export type FormNumberingLevel = Readonly<{
  style: NumberStyle
  letterCase: '' | 'upper' | 'lower'
  suffix: NumberSuffix
}>

export type FormRole = Readonly<{
  id: string
  name: string
  kind: RoleKind
  view: 'full' | 'redacted'
  permissions: ReadonlyArray<Permission>
  approvalKind: '' | 'all' | 'at_least' | 'majority'
  approvalCount: number | null
}>

export type FormSection = Readonly<{
  id: string
  parentId: string | null
  isConclusion: boolean
  title: string
  instruction: string
  requirement: Requirement
  frontMatter: boolean
  numbered: boolean
  repeatable: boolean
  repeatMin: number
  repeatMax: number | null
}>

export type FormItem = Readonly<{
  id: string
  // NOTE: A section ID, or the ID of a repeated item.
  parentId: string
  type: ItemType
  label: string
  instruction: string
  requirement: Requirement
  precision: '' | DatePrecision
  multiple: boolean
  endOptionId: string
  field: '' | CaseValueField
  entryLabel: string
  repeatMin: number
  repeatMax: number | null
}>

export type FormOption = Readonly<{
  id: string
  itemId: string
  label: string
  code: string
}>

export type FormCoverLine = Readonly<{
  emphasis: 'title' | 'subtitle' | 'normal'
}>

export type FormCoverPart = Readonly<{
  lineIndex: number
  kind: CoverPart['kind']
  text: string
  itemId: string
  field: '' | CaseValueField
}>

export type TemplateForm = Readonly<{
  schemaVersion: typeof TEMPLATE_SCHEMA_VERSION
  id: string
  version: number
  name: string
  shortName: string
  description: string
  caseReferenceLabel: string
  numbering: ReadonlyArray<FormNumberingLevel>
  roles: ReadonlyArray<FormRole>
  sections: ReadonlyArray<FormSection>
  items: ReadonlyArray<FormItem>
  options: ReadonlyArray<FormOption>
  endingOutcomeText: string
  endingStaysInForce: ReadonlyArray<string>
  coverLines: ReadonlyArray<FormCoverLine>
  coverParts: ReadonlyArray<FormCoverPart>
  contentsDepth: number | null
  pageNumbering: PageNumbering
  header: string
  footer: string
  coverHeader: string
  coverFooter: string
}>

// NOTE: `{ [key]: value }` unless the text is absent, so optional fields stay
// absent instead of becoming undefined.
const present = <K extends string>(
  key: K,
  value: string,
): Partial<Record<K, string>> =>
  value === '' ? {} : ({ [key]: value } as Partial<Record<K, string>>)

const itemRows = (
  items: ReadonlyArray<Item>,
  parentId: string,
  out: { items: Array<FormItem>; options: Array<FormOption> },
): void =>
  items.forEach(item => {
    const base = {
      id: item.id,
      parentId,
      type: item.type,
      label: item.label,
      instruction: item.instruction ?? '',
      requirement: item.requirement,
    }
    const blank = {
      precision: '' as const,
      multiple: false,
      endOptionId: '',
      field: '' as const,
      entryLabel: '',
      repeatMin: 0,
      repeatMax: null,
    }
    switch (item.type) {
      case 'date':
        out.items.push({ ...base, ...blank, precision: item.precision })
        return
      case 'select':
        out.items.push({
          ...base,
          ...blank,
          multiple: item.multiple,
          endOptionId: item.endOptionId ?? '',
        })
        item.options.forEach(option =>
          out.options.push({
            id: option.id,
            itemId: item.id,
            label: option.label,
            code: option.code ?? '',
          }),
        )
        return
      case 'people':
        out.items.push({ ...base, ...blank, multiple: item.multiple })
        return
      case 'case_value':
        out.items.push({ ...base, ...blank, field: item.field })
        return
      case 'repeated':
        out.items.push({
          ...base,
          ...blank,
          entryLabel: item.entryLabel,
          repeatMin: item.min,
          repeatMax: item.max ?? null,
        })
        itemRows(item.items, item.id, out)
        return
      default:
        out.items.push({ ...base, ...blank })
    }
  })

const sectionRows = (
  section: Section,
  parentId: string | null,
  isConclusion: boolean,
  out: {
    sections: Array<FormSection>
    items: Array<FormItem>
    options: Array<FormOption>
  },
): void => {
  out.sections.push({
    id: section.id,
    parentId,
    isConclusion,
    title: section.title,
    instruction: section.instruction ?? '',
    requirement: section.requirement,
    frontMatter: section.frontMatter,
    numbered: section.numbered,
    repeatable: section.repeat !== undefined,
    repeatMin: section.repeat?.min ?? 0,
    repeatMax: section.repeat?.max ?? null,
  })
  itemRows(section.items, section.id, out)
  section.sections.forEach(child => sectionRows(child, section.id, false, out))
}

export const templateToForm = (template: Template): TemplateForm => {
  const rows = {
    sections: [] as Array<FormSection>,
    items: [] as Array<FormItem>,
    options: [] as Array<FormOption>,
  }
  template.sections.forEach(section => sectionRows(section, null, false, rows))
  if (template.conclusion !== undefined) {
    sectionRows(template.conclusion, null, true, rows)
  }
  const lines = template.cover?.lines ?? []
  return {
    schemaVersion: template.schemaVersion,
    id: template.id,
    version: template.version,
    name: template.name,
    shortName: template.shortName,
    description: template.description ?? '',
    caseReferenceLabel: template.caseReferenceLabel,
    numbering: template.numbering.map(level => ({
      style: level.style,
      letterCase: level.letterCase ?? '',
      suffix: level.suffix,
    })),
    roles: template.roles.map(role => ({
      id: role.id,
      name: role.name,
      kind: role.kind,
      view: role.view,
      permissions: [...role.permissions],
      approvalKind: role.approval?.kind ?? '',
      approvalCount:
        role.approval?.kind === 'at_least' ? role.approval.count : null,
    })),
    ...rows,
    endingOutcomeText: template.ending?.outcomeText ?? '',
    endingStaysInForce: [...(template.ending?.staysInForce ?? [])],
    coverLines: lines.map(line => ({ emphasis: line.emphasis })),
    coverParts: lines.flatMap((line, lineIndex) =>
      line.parts.map(part => ({
        lineIndex,
        kind: part.kind,
        text: part.kind === 'text' ? part.text : '',
        itemId: part.kind === 'item' ? part.itemId : '',
        field: part.kind === 'case_value' ? part.field : '',
      })),
    ),
    contentsDepth: template.contentsDepth ?? null,
    pageNumbering: template.pageNumbering,
    header: template.furniture.header ?? '',
    footer: template.furniture.footer ?? '',
    coverHeader: template.furniture.coverHeader ?? '',
    coverFooter: template.furniture.coverFooter ?? '',
  }
}

const formProblem = (
  path: ReadonlyArray<string | number>,
  message: string,
): TemplateProblem => ({ code: 'form-invalid', path, message })

const groupBy = <A>(
  rows: ReadonlyArray<A>,
  key: (row: A) => string | null,
): Map<string | null, Array<A>> => {
  const groups = new Map<string | null, Array<A>>()
  rows.forEach(row => {
    const k = key(row)
    groups.set(k, [...(groups.get(k) ?? []), row])
  })
  return groups
}

// NOTE: Builds the template a form describes, then validates it like any
// other template. Rows that point nowhere, or that no root reaches, are
// reported as problems of the form.
export const templateFromForm = (
  form: TemplateForm,
): Result.Result<Template, ReadonlyArray<TemplateProblem>> => {
  const problems: Array<TemplateProblem> = []
  const sectionsByParent = groupBy(form.sections, row => row.parentId)
  const itemsByParent = groupBy(form.items, row => row.parentId)
  const optionsByItem = groupBy(form.options, row => row.itemId)
  const reached = new Set<string>()

  const buildItem = (row: FormItem): Item => {
    reached.add(row.id)
    const base = {
      id: row.id,
      label: row.label,
      requirement: row.requirement,
      ...present('instruction', row.instruction),
    }
    switch (row.type) {
      case 'text':
        return { ...base, type: 'text' }
      case 'rich_text':
        return { ...base, type: 'rich_text' }
      case 'signature':
        return { ...base, type: 'signature' }
      case 'people':
        return { ...base, type: 'people', multiple: row.multiple }
      case 'date':
        if (row.precision === '') {
          problems.push(
            formProblem(
              ['items', row.id],
              `The date "${row.id}" has no precision`,
            ),
          )
        }
        return { ...base, type: 'date', precision: row.precision || 'day' }
      case 'case_value':
        if (row.field === '') {
          problems.push(
            formProblem(
              ['items', row.id],
              `The case value "${row.id}" has no field`,
            ),
          )
        }
        return { ...base, type: 'case_value', field: row.field || 'reference' }
      case 'select':
        return {
          ...base,
          type: 'select',
          multiple: row.multiple,
          options: (optionsByItem.get(row.id) ?? []).map(option => ({
            id: option.id,
            label: option.label,
            ...present('code', option.code),
          })),
          ...present('endOptionId', row.endOptionId),
        }
      case 'repeated':
        return {
          ...base,
          type: 'repeated',
          entryLabel: row.entryLabel,
          min: row.repeatMin,
          ...(row.repeatMax === null ? {} : { max: row.repeatMax }),
          items: (itemsByParent.get(row.id) ?? []).map(buildItem),
        }
    }
  }

  const buildSection = (row: FormSection): Section => {
    reached.add(row.id)
    return {
      id: row.id,
      title: row.title,
      ...present('instruction', row.instruction),
      requirement: row.requirement,
      frontMatter: row.frontMatter,
      numbered: row.numbered,
      ...(row.repeatable
        ? {
            repeat: {
              min: row.repeatMin,
              ...(row.repeatMax === null ? {} : { max: row.repeatMax }),
            },
          }
        : {}),
      items: (itemsByParent.get(row.id) ?? []).map(buildItem),
      sections: (sectionsByParent.get(row.id) ?? []).map(buildSection),
    }
  }

  const roots = sectionsByParent.get(null) ?? []
  const conclusions = roots.filter(row => row.isConclusion)
  if (conclusions.length > 1) {
    problems.push(
      formProblem(['sections'], 'There is more than one conclusion section'),
    )
  }
  const body = roots.filter(row => !row.isConclusion).map(buildSection)
  const conclusion =
    conclusions[0] === undefined ? undefined : buildSection(conclusions[0])

  form.sections
    .filter(row => !reached.has(row.id))
    .forEach(row =>
      problems.push(
        formProblem(
          ['sections', row.id],
          `The section "${row.id}" is not reachable from a top-level section`,
        ),
      ),
    )
  form.items
    .filter(row => !reached.has(row.id))
    .forEach(row =>
      problems.push(
        formProblem(
          ['items', row.id],
          `The item "${row.id}" is not inside any section`,
        ),
      ),
    )
  const itemIds = new Set(form.items.map(row => row.id))
  form.options
    .filter(row => !itemIds.has(row.itemId))
    .forEach(row =>
      problems.push(
        formProblem(
          ['options', row.id],
          `The option "${row.id}" belongs to no item`,
        ),
      ),
    )
  if (form.endingOutcomeText === '' && form.endingStaysInForce.length > 0) {
    problems.push(
      formProblem(
        ['endingStaysInForce'],
        'Sections stay in force after an ending, but the ending has no outcome text',
      ),
    )
  }
  if (problems.length > 0) {
    return Result.fail(problems)
  }

  const cover = form.coverLines.map((line, lineIndex) => ({
    emphasis: line.emphasis,
    parts: form.coverParts
      .filter(part => part.lineIndex === lineIndex)
      .map((part): CoverPart => {
        switch (part.kind) {
          case 'text':
            return { kind: 'text', text: part.text }
          case 'item':
            return { kind: 'item', itemId: part.itemId }
          case 'case_value':
            return { kind: 'case_value', field: part.field || 'reference' }
        }
      }),
  }))

  return validateTemplate({
    schemaVersion: form.schemaVersion,
    id: form.id,
    version: form.version,
    name: form.name,
    shortName: form.shortName,
    ...present('description', form.description),
    caseReferenceLabel: form.caseReferenceLabel,
    numbering: form.numbering.map(level => ({
      style: level.style,
      ...(level.letterCase === '' ? {} : { letterCase: level.letterCase }),
      suffix: level.suffix,
    })),
    roles: form.roles.map(role => ({
      id: role.id,
      name: role.name,
      kind: role.kind,
      view: role.view,
      permissions: [...role.permissions],
      ...(role.approvalKind === ''
        ? {}
        : {
            approval:
              role.approvalKind === 'at_least'
                ? { kind: 'at_least', count: role.approvalCount }
                : { kind: role.approvalKind },
          }),
    })),
    sections: body,
    ...(conclusion === undefined ? {} : { conclusion }),
    ...(form.endingOutcomeText === ''
      ? {}
      : {
          ending: {
            outcomeText: form.endingOutcomeText,
            staysInForce: [...form.endingStaysInForce],
          },
        }),
    ...(cover.length === 0 ? {} : { cover: { lines: cover } }),
    ...(form.contentsDepth === null
      ? {}
      : { contentsDepth: form.contentsDepth }),
    pageNumbering: form.pageNumbering,
    furniture: {
      ...present('header', form.header),
      ...present('footer', form.footer),
      ...present('coverHeader', form.coverHeader),
      ...present('coverFooter', form.coverFooter),
    },
  })
}
