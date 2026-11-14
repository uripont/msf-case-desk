import { Result, Schema } from 'effect'

import { RichTextDoc, issuesToProblems } from './richtext'
import {
  type Item,
  type Section,
  type Template,
  type SelectItem,
  TemplateId,
} from './template'

// NOTE: The content of a report for one template version (D23, section 5).
//
// - It is sparse: a section, item or entry with no content is simply absent.
// - Values are keyed by the template's item IDs. Item IDs are unique in a
//   template, so a key is unambiguous. Sections nest as the template does: the
//   `sections` of a section hold its direct subsections.
// - A repeatable subsection holds its repeats in `entries`, each with a stable
//   ID, an optional title written by the author, and its own `values` and
//   `sections`. A repeated item holds its entries in a `repeated` value.
// - Whether a section is empty, in progress or complete is derived from the
//   content (content-status.ts), not stored. What is stored is the author's
//   *not applicable* mark with its reason, which keeps whatever the section
//   held, as the ended branches of D23 do. Renderers must skip the content of a
//   section that is not applicable or ended.
// - The conclusion section, if the template has one, is in `sections` like any
//   other top-level section. Who may write it, and when, is a permission rule.

export const CONTENT_SCHEMA_VERSION = 1

export const EntryId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
)

const Title = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200))
const Reason = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(500),
)
const LongText = Schema.String.check(Schema.isMaxLength(50_000))
const DateText = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}(-\d{2})?$/))
const IdList = Schema.Array(TemplateId).check(Schema.isMaxLength(200))

export const TextValue = Schema.Struct({
  type: Schema.Literal('text'),
  text: LongText,
})
export const DateValue = Schema.Struct({
  type: Schema.Literal('date'),
  date: DateText,
})
export const SelectValue = Schema.Struct({
  type: Schema.Literal('select'),
  optionIds: IdList,
})
export const PeopleValue = Schema.Struct({
  type: Schema.Literal('people'),
  personIds: Schema.Array(EntryId).check(Schema.isMaxLength(200)),
})
export const RichTextValue = Schema.Struct({
  type: Schema.Literal('rich_text'),
  doc: RichTextDoc,
})
export const SignatureValue = Schema.Struct({
  type: Schema.Literal('signature'),
  name: Schema.String.check(Schema.isMaxLength(200)),
  date: Schema.optionalKey(DateText),
})
export const NotApplicableValue = Schema.Struct({
  type: Schema.Literal('not_applicable'),
  reason: Reason,
})

export type TextValue = typeof TextValue.Type
export type DateValue = typeof DateValue.Type
export type SelectValue = typeof SelectValue.Type
export type PeopleValue = typeof PeopleValue.Type
export type RichTextValue = typeof RichTextValue.Type
export type SignatureValue = typeof SignatureValue.Type
export type NotApplicableValue = typeof NotApplicableValue.Type

export type ItemValues = { readonly [itemId: string]: ItemValue }

export type ItemEntry = {
  readonly id: string
  readonly title?: string
  readonly values: ItemValues
}

export type RepeatedValue = {
  readonly type: 'repeated'
  readonly entries: ReadonlyArray<ItemEntry>
}

export type ItemValue =
  | TextValue
  | DateValue
  | SelectValue
  | PeopleValue
  | RichTextValue
  | SignatureValue
  | NotApplicableValue
  | RepeatedValue

export const ItemEntry: Schema.Codec<ItemEntry> = Schema.Struct({
  id: EntryId,
  title: Schema.optionalKey(Title),
  values: Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<ItemValue> => ItemValue),
  ),
})

export const RepeatedValue: Schema.Codec<RepeatedValue> = Schema.Struct({
  type: Schema.Literal('repeated'),
  entries: Schema.Array(ItemEntry).check(Schema.isMaxLength(500)),
})

export const ItemValue: Schema.Codec<ItemValue> = Schema.Union([
  TextValue,
  DateValue,
  SelectValue,
  PeopleValue,
  RichTextValue,
  SignatureValue,
  NotApplicableValue,
  RepeatedValue,
])

export type SectionContents = { readonly [sectionId: string]: SectionContent }

export type SectionEntry = {
  readonly id: string
  readonly title?: string
  readonly values: ItemValues
  readonly sections: SectionContents
}

export type SectionContent = {
  readonly notApplicable?: { readonly reason: string }
  readonly values: ItemValues
  readonly sections: SectionContents
  readonly entries?: ReadonlyArray<SectionEntry>
}

export const SectionEntry: Schema.Codec<SectionEntry> = Schema.Struct({
  id: EntryId,
  title: Schema.optionalKey(Title),
  values: Schema.Record(Schema.String, ItemValue),
  sections: Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<SectionContent> => SectionContent),
  ),
})

export const SectionContent: Schema.Codec<SectionContent> = Schema.Struct({
  notApplicable: Schema.optionalKey(Schema.Struct({ reason: Reason })),
  values: Schema.Record(Schema.String, ItemValue),
  sections: Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<SectionContent> => SectionContent),
  ),
  entries: Schema.optionalKey(
    Schema.Array(SectionEntry).check(Schema.isMaxLength(500)),
  ),
})

export const ReportContent = Schema.Struct({
  schemaVersion: Schema.Literal(CONTENT_SCHEMA_VERSION),
  templateId: TemplateId,
  templateVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sections: Schema.Record(Schema.String, SectionContent),
})
export type ReportContent = typeof ReportContent.Type

// NOTE: The content of a new report: nothing filled in yet.
export const emptyContent = (template: Template): ReportContent => ({
  schemaVersion: CONTENT_SCHEMA_VERSION,
  templateId: template.id,
  templateVersion: template.version,
  sections: {},
})

// ---- Validation against a template --------------------------------------------

export type ContentProblemCode =
  | 'schema'
  | 'template-mismatch'
  | 'unknown-section'
  | 'unknown-item'
  | 'wrong-value-type'
  | 'value-not-allowed'
  | 'unknown-option'
  | 'duplicate-answer'
  | 'too-many-answers'
  | 'invalid-date'
  | 'too-many-entries'
  | 'entries-misplaced'
  | 'repeat-content-misplaced'
  | 'not-applicable-not-allowed'
  | 'duplicate-entry-id'

export type ContentProblem = Readonly<{
  code: ContentProblemCode
  path: ReadonlyArray<string | number>
  message: string
}>

type Path = ReadonlyArray<string | number>

const problem = (
  code: ContentProblemCode,
  path: Path,
  message: string,
): ContentProblem => ({ code, path, message })

const isLeap = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

const daysIn = (year: number, month: number): number =>
  month === 2
    ? isLeap(year)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31

// NOTE: `YYYY-MM-DD`, or `YYYY-MM` when `precision` is `month`.
export const isValidDate = (
  text: string,
  precision: 'day' | 'month',
): boolean => {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text)
  if (match === null) {
    return false
  }
  const year = Number(match[1])
  const month = Number(match[2])
  if (month < 1 || month > 12) {
    return false
  }
  if (precision === 'month') {
    return match[3] === undefined
  }
  const day = match[3] === undefined ? 0 : Number(match[3])
  return day >= 1 && day <= daysIn(year, month)
}

const duplicatesIn = (list: ReadonlyArray<string>): boolean =>
  new Set(list).size !== list.length

const selectProblems = (
  item: SelectItem,
  value: SelectValue,
  path: Path,
): ReadonlyArray<ContentProblem> => {
  const out: Array<ContentProblem> = []
  const known = new Set(item.options.map(option => option.id))
  value.optionIds.forEach((id, index) => {
    if (!known.has(id)) {
      out.push(
        problem(
          'unknown-option',
          [...path, 'optionIds', index],
          `"${id}" is not an option of "${item.id}"`,
        ),
      )
    }
  })
  if (duplicatesIn(value.optionIds)) {
    out.push(
      problem(
        'duplicate-answer',
        [...path, 'optionIds'],
        'An option is chosen twice',
      ),
    )
  }
  if (!item.multiple && value.optionIds.length > 1) {
    out.push(
      problem(
        'too-many-answers',
        [...path, 'optionIds'],
        `"${item.id}" takes one answer`,
      ),
    )
  }
  return out
}

type Checker = Readonly<{
  problems: Array<ContentProblem>
  entryIds: Set<string>
}>

const checkEntryId = (checker: Checker, id: string, path: Path): void => {
  if (checker.entryIds.has(id)) {
    checker.problems.push(
      problem(
        'duplicate-entry-id',
        [...path, 'id'],
        `The entry ID "${id}" is used twice`,
      ),
    )
  }
  checker.entryIds.add(id)
}

const checkValues = (
  checker: Checker,
  items: ReadonlyArray<Item>,
  values: ItemValues,
  path: Path,
): void => {
  const byId = new Map(items.map(item => [item.id, item]))
  for (const [id, value] of Object.entries(values)) {
    const valuePath = [...path, 'values', id]
    const item = byId.get(id)
    if (item === undefined) {
      checker.problems.push(
        problem('unknown-item', valuePath, `There is no item "${id}" here`),
      )
      continue
    }
    checkValue(checker, item, value, valuePath)
  }
}

const checkValue = (
  checker: Checker,
  item: Item,
  value: ItemValue,
  path: Path,
): void => {
  const { problems } = checker
  if (item.type === 'case_value') {
    problems.push(
      problem(
        'value-not-allowed',
        path,
        `"${item.id}" shows a case-file value and holds none`,
      ),
    )
    return
  }
  if (value.type === 'not_applicable') {
    if (item.requirement !== 'optional_with_reason') {
      problems.push(
        problem(
          'not-applicable-not-allowed',
          path,
          `"${item.id}" cannot be marked not applicable`,
        ),
      )
    }
    return
  }
  if (value.type !== item.type) {
    problems.push(
      problem(
        'wrong-value-type',
        path,
        `"${item.id}" is a ${item.type} item, not ${value.type}`,
      ),
    )
    return
  }
  switch (item.type) {
    case 'select':
      problems.push(...selectProblems(item, value as SelectValue, path))
      return
    case 'date':
      if (!isValidDate((value as DateValue).date, item.precision)) {
        problems.push(
          problem(
            'invalid-date',
            [...path, 'date'],
            item.precision === 'day'
              ? 'The date must be a real day, as YYYY-MM-DD'
              : 'The date must be a real month, as YYYY-MM',
          ),
        )
      }
      return
    case 'people': {
      const { personIds } = value as PeopleValue
      if (duplicatesIn(personIds)) {
        problems.push(
          problem(
            'duplicate-answer',
            [...path, 'personIds'],
            'A person is chosen twice',
          ),
        )
      }
      if (!item.multiple && personIds.length > 1) {
        problems.push(
          problem(
            'too-many-answers',
            [...path, 'personIds'],
            `"${item.id}" takes one person`,
          ),
        )
      }
      return
    }
    case 'signature': {
      const { date } = value as SignatureValue
      if (date !== undefined && !isValidDate(date, 'day')) {
        problems.push(
          problem(
            'invalid-date',
            [...path, 'date'],
            'The date must be a real day, as YYYY-MM-DD',
          ),
        )
      }
      return
    }
    case 'repeated': {
      const { entries } = value as RepeatedValue
      if (item.max !== undefined && entries.length > item.max) {
        problems.push(
          problem(
            'too-many-entries',
            [...path, 'entries'],
            `"${item.id}" allows at most ${item.max} entries`,
          ),
        )
      }
      entries.forEach((entry, index) => {
        const entryPath = [...path, 'entries', index]
        checkEntryId(checker, entry.id, entryPath)
        checkValues(checker, item.items, entry.values, entryPath)
      })
      return
    }
    default:
      return
  }
}

const checkSections = (
  checker: Checker,
  sections: ReadonlyArray<Section>,
  contents: SectionContents,
  path: Path,
): void => {
  const byId = new Map(sections.map(section => [section.id, section]))
  for (const [id, content] of Object.entries(contents)) {
    const sectionPath = [...path, 'sections', id]
    const section = byId.get(id)
    if (section === undefined) {
      checker.problems.push(
        problem(
          'unknown-section',
          sectionPath,
          `There is no section "${id}" here`,
        ),
      )
      continue
    }
    checkSection(checker, section, content, sectionPath)
  }
}

const checkSection = (
  checker: Checker,
  section: Section,
  content: SectionContent,
  path: Path,
): void => {
  const { problems } = checker
  if (
    content.notApplicable !== undefined &&
    section.requirement !== 'optional_with_reason'
  ) {
    problems.push(
      problem(
        'not-applicable-not-allowed',
        [...path, 'notApplicable'],
        `"${section.id}" cannot be marked not applicable`,
      ),
    )
  }
  if (section.repeat === undefined) {
    if (content.entries !== undefined) {
      problems.push(
        problem(
          'entries-misplaced',
          [...path, 'entries'],
          `"${section.id}" is not repeatable`,
        ),
      )
    }
    checkValues(checker, section.items, content.values, path)
    checkSections(checker, section.sections, content.sections, path)
    return
  }
  if (
    Object.keys(content.values).length > 0 ||
    Object.keys(content.sections).length > 0
  ) {
    problems.push(
      problem(
        'repeat-content-misplaced',
        path,
        `"${section.id}" is repeatable: its content belongs in its entries`,
      ),
    )
  }
  const entries = content.entries ?? []
  if (section.repeat.max !== undefined && entries.length > section.repeat.max) {
    problems.push(
      problem(
        'too-many-entries',
        [...path, 'entries'],
        `"${section.id}" allows at most ${section.repeat.max} entries`,
      ),
    )
  }
  entries.forEach((entry, index) => {
    const entryPath = [...path, 'entries', index]
    checkEntryId(checker, entry.id, entryPath)
    checkValues(checker, section.items, entry.values, entryPath)
    checkSections(checker, section.sections, entry.sections, entryPath)
  })
}

export const contentProblems = (
  template: Template,
  content: ReportContent,
): ReadonlyArray<ContentProblem> => {
  const checker: Checker = { problems: [], entryIds: new Set() }
  if (
    content.templateId !== template.id ||
    content.templateVersion !== template.version
  ) {
    checker.problems.push(
      problem(
        'template-mismatch',
        ['templateId'],
        `The content is for ${content.templateId} version ${content.templateVersion}, not ${template.id} version ${template.version}`,
      ),
    )
  }
  const top =
    template.conclusion === undefined
      ? template.sections
      : [...template.sections, template.conclusion]
  checkSections(checker, top, content.sections, [])
  return checker.problems
}

const decodeShape = Schema.decodeUnknownResult(ReportContent)

// NOTE: Decodes unknown data as report content, refusing unknown keys, and
// checks that it fits the template: only sections and items the template has,
// values of the right type, real options and dates, repeat limits, *not
// applicable* only where the template allows it. It returns every problem. It
// does not check completeness: a draft may be empty.
export const validateContent = (
  template: Template,
  input: unknown,
): Result.Result<ReportContent, ReadonlyArray<ContentProblem>> => {
  const decoded = decodeShape(input, {
    errors: 'all',
    onExcessProperty: 'error',
  })
  if (Result.isFailure(decoded)) {
    return Result.fail(
      issuesToProblems(decoded.failure.issue).map(entry =>
        problem('schema', entry.path, entry.message),
      ),
    )
  }
  const problems = contentProblems(template, decoded.success)
  return problems.length === 0
    ? Result.succeed(decoded.success)
    : Result.fail(problems)
}

// NOTE: The key of one section as it appears in a report, used by numbering
// and states. A repeatable section appears once per entry (`parent/id#entry`);
// `groupKey` is the repeatable section as a whole (`parent/id`).
export const groupKey = (parentKey: string, sectionId: string): string =>
  parentKey === '' ? sectionId : `${parentKey}/${sectionId}`

export const instanceKey = (
  parentKey: string,
  sectionId: string,
  entryId?: string,
): string =>
  entryId === undefined
    ? groupKey(parentKey, sectionId)
    : `${groupKey(parentKey, sectionId)}#${entryId}`
