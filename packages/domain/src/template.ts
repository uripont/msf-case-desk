import { Schema } from 'effect'

// NOTE: A template version is pure data (D23). Once stage 1 is done, changes
// to this file are additive only: new optional fields or new variants behind a
// new `schemaVersion`, never a rename or a new type for an existing field, so
// the template editor cannot break the stages built on top of it.

export const TEMPLATE_SCHEMA_VERSION = 1

export const MAX_SECTION_DEPTH = 5
export const MAX_ATLEAST_VOTERS = 50
export const MAX_CONTENTS_DEPTH = MAX_SECTION_DEPTH

const Text = (maxLength: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength))

export const TemplateId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
)
export type TemplateId = typeof TemplateId.Type

// NOTE: The short name goes into PDF file names (D10), so it is kept plain.
const ShortName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,23}$/),
)

const Title = Text(200)
const Instruction = Text(2000)
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const Requirement = Schema.Literals([
  'required',
  'optional',
  'optional_with_reason',
])
export type Requirement = typeof Requirement.Type

export const NumberStyle = Schema.Literals(['arabic', 'roman', 'letters'])
export type NumberStyle = typeof NumberStyle.Type

export const NumberSuffix = Schema.Literals(['.', ')', ''])
export type NumberSuffix = typeof NumberSuffix.Type

// NOTE: `letterCase` belongs to roman and letters only, and the validation
// says so precisely. Whether a section is numbered at all is the section's
// own flag, so "none" is not a style.
export const NumberingLevel = Schema.Struct({
  style: NumberStyle,
  letterCase: Schema.optionalKey(Schema.Literals(['upper', 'lower'])),
  suffix: NumberSuffix,
})
export type NumberingLevel = typeof NumberingLevel.Type

export const DatePrecision = Schema.Literals(['day', 'month'])
export type DatePrecision = typeof DatePrecision.Type

export const CaseValueField = Schema.Literals(['reference', 'unit', 'title'])
export type CaseValueField = typeof CaseValueField.Type

export const SelectOption = Schema.Struct({
  id: TemplateId,
  label: Title,
  code: Schema.optionalKey(Text(8)),
})
export type SelectOption = typeof SelectOption.Type

const itemBase = {
  id: TemplateId,
  label: Title,
  instruction: Schema.optionalKey(Instruction),
  requirement: Requirement,
}

export const TextItem = Schema.Struct({
  ...itemBase,
  type: Schema.Literal('text'),
})
export const DateItem = Schema.Struct({
  ...itemBase,
  type: Schema.Literal('date'),
  precision: DatePrecision,
})
export const SelectItem = Schema.Struct({
  ...itemBase,
  type: Schema.Literal('select'),
  multiple: Schema.Boolean,
  options: Schema.Array(SelectOption),
  endOptionId: Schema.optionalKey(TemplateId),
})
export const PeopleItem = Schema.Struct({
  ...itemBase,
  type: Schema.Literal('people'),
  multiple: Schema.Boolean,
})
export const RichTextItem = Schema.Struct({
  ...itemBase,
  type: Schema.Literal('rich_text'),
})
export const CaseValueItem = Schema.Struct({
  ...itemBase,
  type: Schema.Literal('case_value'),
  field: CaseValueField,
})
export const SignatureItem = Schema.Struct({
  ...itemBase,
  type: Schema.Literal('signature'),
})

export type TextItem = typeof TextItem.Type
export type DateItem = typeof DateItem.Type
export type SelectItem = typeof SelectItem.Type
export type PeopleItem = typeof PeopleItem.Type
export type RichTextItem = typeof RichTextItem.Type
export type CaseValueItem = typeof CaseValueItem.Type
export type SignatureItem = typeof SignatureItem.Type

export type RepeatedItem = {
  readonly id: string
  readonly label: string
  readonly instruction?: string
  readonly requirement: Requirement
  readonly type: 'repeated'
  readonly entryLabel: string
  readonly min: number
  readonly max?: number
  readonly items: ReadonlyArray<Item>
}

export type Item =
  | TextItem
  | DateItem
  | SelectItem
  | PeopleItem
  | RichTextItem
  | CaseValueItem
  | SignatureItem
  | RepeatedItem

export const RepeatedItem: Schema.Codec<RepeatedItem> = Schema.Struct({
  ...itemBase,
  type: Schema.Literal('repeated'),
  entryLabel: Title,
  min: Count,
  max: Schema.optionalKey(Count),
  items: Schema.Array(Schema.suspend((): Schema.Codec<Item> => Item)),
})

export const Item: Schema.Codec<Item> = Schema.Union([
  TextItem,
  DateItem,
  SelectItem,
  PeopleItem,
  RichTextItem,
  CaseValueItem,
  SignatureItem,
  RepeatedItem,
])

export const ITEM_TYPES = [
  'text',
  'date',
  'select',
  'people',
  'rich_text',
  'case_value',
  'signature',
  'repeated',
] as const satisfies ReadonlyArray<Item['type']>
export type ItemType = (typeof ITEM_TYPES)[number]

export const RepeatRange = Schema.Struct({
  min: Count,
  max: Schema.optionalKey(Count),
})
export type RepeatRange = typeof RepeatRange.Type

export type Section = {
  readonly id: string
  readonly title: string
  readonly instruction?: string
  readonly requirement: Requirement
  readonly frontMatter: boolean
  readonly numbered: boolean
  readonly repeat?: RepeatRange
  readonly items: ReadonlyArray<Item>
  readonly sections: ReadonlyArray<Section>
}

export const Section: Schema.Codec<Section> = Schema.Struct({
  id: TemplateId,
  title: Title,
  instruction: Schema.optionalKey(Instruction),
  requirement: Requirement,
  frontMatter: Schema.Boolean,
  numbered: Schema.Boolean,
  repeat: Schema.optionalKey(RepeatRange),
  items: Schema.Array(Item),
  sections: Schema.Array(Schema.suspend((): Schema.Codec<Section> => Section)),
})

export const Permission = Schema.Literals([
  'edit',
  'share',
  'publish',
  'manage_people',
  'comment_drafts',
  'reply',
  'write_conclusion',
  'comment',
  'vote',
])
export type Permission = typeof Permission.Type

export const DRAFTING_REQUIRED_PERMISSIONS: ReadonlyArray<Permission> = [
  'edit',
  'share',
  'publish',
  'manage_people',
]
export const DRAFTING_PERMISSIONS: ReadonlyArray<Permission> = [
  ...DRAFTING_REQUIRED_PERMISSIONS,
  'comment_drafts',
  'reply',
  'write_conclusion',
]
export const REVIEWING_PERMISSIONS: ReadonlyArray<Permission> = [
  'comment',
  'vote',
]

export const ApprovalRule = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('all') }),
  Schema.Struct({
    kind: Schema.Literal('at_least'),
    count: Schema.Int,
  }),
  Schema.Struct({ kind: Schema.Literal('majority') }),
])
export type ApprovalRule = typeof ApprovalRule.Type

export const RoleKind = Schema.Literals(['drafting', 'reviewing'])
export type RoleKind = typeof RoleKind.Type

export const Role = Schema.Struct({
  id: TemplateId,
  name: Title,
  kind: RoleKind,
  view: Schema.Literals(['full', 'redacted']),
  permissions: Schema.Array(Permission),
  approval: Schema.optionalKey(ApprovalRule),
})
export type Role = typeof Role.Type

export const CoverPart = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('text'), text: Title }),
  Schema.Struct({ kind: Schema.Literal('item'), itemId: TemplateId }),
  Schema.Struct({ kind: Schema.Literal('case_value'), field: CaseValueField }),
])
export type CoverPart = typeof CoverPart.Type

export const CoverLine = Schema.Struct({
  emphasis: Schema.Literals(['title', 'subtitle', 'normal']),
  parts: Schema.Array(CoverPart).check(Schema.isNonEmpty()),
})
export type CoverLine = typeof CoverLine.Type

export const Ending = Schema.Struct({
  outcomeText: Instruction,
  staysInForce: Schema.Array(TemplateId),
})
export type Ending = typeof Ending.Type

export const PAGE_TOKENS = ['{page}', '{pages}', '{case}', '{title}'] as const

export const Furniture = Schema.Struct({
  header: Schema.optionalKey(Text(300)),
  footer: Schema.optionalKey(Text(300)),
  coverHeader: Schema.optionalKey(Text(300)),
  coverFooter: Schema.optionalKey(Text(300)),
})
export type Furniture = typeof Furniture.Type

export const PageNumbering = Schema.Literals([
  'continuous',
  'restart_after_front_matter',
])
export type PageNumbering = typeof PageNumbering.Type

export const Template = Schema.Struct({
  schemaVersion: Schema.Literal(TEMPLATE_SCHEMA_VERSION),
  id: TemplateId,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  name: Title,
  shortName: ShortName,
  description: Schema.optionalKey(Instruction),
  caseReferenceLabel: Title,
  numbering: Schema.Array(NumberingLevel),
  roles: Schema.Array(Role),
  sections: Schema.Array(Section).check(Schema.isNonEmpty()),
  conclusion: Schema.optionalKey(Section),
  ending: Schema.optionalKey(Ending),
  cover: Schema.optionalKey(
    Schema.Struct({
      lines: Schema.Array(CoverLine).check(Schema.isNonEmpty()),
    }),
  ),
  contentsDepth: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_CONTENTS_DEPTH }),
    ),
  ),
  pageNumbering: PageNumbering,
  furniture: Furniture,
})
export type Template = typeof Template.Type

// NOTE: Walkers shared by validation, the form model and later stages.

export type TemplateNode = Readonly<{
  node: Section | Item
  kind: 'section' | 'item'
  path: ReadonlyArray<string | number>
  depth: number
  // NOTE: true inside a repeatable section or a repeated item, where an item
  // has no single value.
  repeated: boolean
  parentId: string | null
}>

const walkItems = (
  items: ReadonlyArray<Item>,
  path: ReadonlyArray<string | number>,
  depth: number,
  repeated: boolean,
  parentId: string,
  out: Array<TemplateNode>,
): void => {
  items.forEach((item, index) => {
    const itemPath = [...path, 'items', index]
    out.push({
      node: item,
      kind: 'item',
      path: itemPath,
      depth,
      repeated,
      parentId,
    })
    if (item.type === 'repeated') {
      walkItems(item.items, itemPath, depth, true, item.id, out)
    }
  })
}

const walkSection = (
  section: Section,
  path: ReadonlyArray<string | number>,
  depth: number,
  repeated: boolean,
  parentId: string | null,
  out: Array<TemplateNode>,
): void => {
  const inRepeat = repeated || section.repeat !== undefined
  out.push({ node: section, kind: 'section', path, depth, repeated, parentId })
  walkItems(section.items, path, depth, inRepeat, section.id, out)
  section.sections.forEach((child, index) =>
    walkSection(
      child,
      [...path, 'sections', index],
      depth + 1,
      inRepeat,
      section.id,
      out,
    ),
  )
}

// NOTE: Every section and item, in document order: the body first, then the
// conclusion section if there is one.
export const templateNodes = (
  template: Template,
): ReadonlyArray<TemplateNode> => {
  const out: Array<TemplateNode> = []
  template.sections.forEach((section, index) =>
    walkSection(section, ['sections', index], 1, false, null, out),
  )
  if (template.conclusion !== undefined) {
    walkSection(template.conclusion, ['conclusion'], 1, false, null, out)
  }
  return out
}

export const draftingRoleOf = (template: Template): Role | undefined =>
  template.roles.find(role => role.kind === 'drafting')

export const reviewingRolesOf = (template: Template): ReadonlyArray<Role> =>
  template.roles.filter(role => role.kind === 'reviewing')

export const votingRolesOf = (template: Template): ReadonlyArray<Role> =>
  template.roles.filter(role => role.permissions.includes('vote'))
