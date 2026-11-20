import { Result, Schema } from 'effect'

import {
  CaseValueField,
  DRAFTING_PERMISSIONS,
  DRAFTING_REQUIRED_PERMISSIONS,
  DatePrecision,
  ITEM_TYPES,
  NumberStyle,
  NumberSuffix,
  PageNumbering,
  Permission,
  REVIEWING_PERMISSIONS,
  Requirement,
  RoleKind,
  Template as TemplateSchema,
  type Template,
} from './template'
import {
  type FormItem,
  type FormRole,
  type FormSection,
  type TemplateForm,
  draftFromForm,
  templateFromForm,
  trimmedForm,
} from './template-form'
import { type TemplateProblem, validateTemplate } from './template-validation'

// NOTE: The edits of the template editor, as plain data, applied
// by one pure function. The editor never builds a row itself: a new ID comes
// with the edit (`freshId`, from a counter the caller keeps), so the same
// edits always give the same form. An edit that makes no sense (moving the
// first row up, removing a row that is not there) changes nothing.

const Int = Schema.Int
const MaybeInt = Schema.NullOr(Schema.Int)
const E = Schema.TaggedStruct

export const TEXT_FIELDS = [
  'name',
  'shortName',
  'description',
  'caseReferenceLabel',
  'endingOutcomeText',
  'header',
  'footer',
  'coverHeader',
  'coverFooter',
] as const
export const TextField = Schema.Literals(TEXT_FIELDS)
export type TextField = typeof TextField.Type

export const IdScope = Schema.Literals(['section', 'item', 'option', 'role'])
export type IdScope = typeof IdScope.Type

export const FormEdit = Schema.Union([
  E('SetText', { field: TextField, value: Schema.String }),
  E('SetPageNumbering', { value: PageNumbering }),
  E('SetContentsDepth', { value: MaybeInt }),
  E('Rename', { scope: IdScope, id: Schema.String, newId: Schema.String }),
  E('SetNumberingLevel', {
    level: Int,
    style: NumberStyle,
    letterCase: Schema.Literals(['', 'upper', 'lower']),
    suffix: NumberSuffix,
  }),
  E('AddNumberingLevel', {}),
  E('RemoveNumberingLevel', {}),
  E('AddRole', { id: Schema.String, kind: RoleKind }),
  E('RemoveRole', { id: Schema.String }),
  E('MoveRole', { id: Schema.String, by: Int }),
  E('SetRoleName', { id: Schema.String, value: Schema.String }),
  E('SetRoleKind', { id: Schema.String, value: RoleKind }),
  E('SetRoleView', { id: Schema.String, value: Schema.Literals(['full', 'redacted']) }),
  E('TogglePermission', { id: Schema.String, permission: Permission }),
  E('SetApproval', {
    id: Schema.String,
    kind: Schema.Literals(['all', 'at_least', 'majority']),
    count: MaybeInt,
  }),
  E('AddSection', {
    id: Schema.String,
    parentId: Schema.NullOr(Schema.String),
    isConclusion: Schema.Boolean,
  }),
  E('RemoveSection', { id: Schema.String }),
  E('MoveSection', {
    id: Schema.String,
    direction: Schema.Literals(['up', 'down', 'out', 'in']),
  }),
  E('SetSectionText', {
    id: Schema.String,
    field: Schema.Literals(['title', 'instruction']),
    value: Schema.String,
  }),
  E('SetSectionRequirement', { id: Schema.String, value: Requirement }),
  E('SetSectionFlag', {
    id: Schema.String,
    flag: Schema.Literals(['frontMatter', 'numbered', 'repeatable']),
    value: Schema.Boolean,
  }),
  E('SetSectionRepeat', { id: Schema.String, min: Int, max: MaybeInt }),
  E('AddItem', {
    id: Schema.String,
    parentId: Schema.String,
    type: Schema.Literals(ITEM_TYPES),
  }),
  E('RemoveItem', { id: Schema.String }),
  E('MoveItem', { id: Schema.String, by: Int }),
  E('SetItemType', { id: Schema.String, type: Schema.Literals(ITEM_TYPES) }),
  E('SetItemText', {
    id: Schema.String,
    field: Schema.Literals(['label', 'instruction', 'entryLabel']),
    value: Schema.String,
  }),
  E('SetItemRequirement', { id: Schema.String, value: Requirement }),
  E('SetItemPrecision', { id: Schema.String, value: DatePrecision }),
  E('SetItemMultiple', { id: Schema.String, value: Schema.Boolean }),
  E('SetItemField', { id: Schema.String, value: CaseValueField }),
  E('SetItemRepeat', { id: Schema.String, min: Int, max: MaybeInt }),
  E('SetEndOption', { id: Schema.String, optionId: Schema.String }),
  E('AddOption', { id: Schema.String, itemId: Schema.String }),
  E('RemoveOption', { id: Schema.String }),
  E('MoveOption', { id: Schema.String, by: Int }),
  E('SetOptionText', {
    id: Schema.String,
    field: Schema.Literals(['label', 'code']),
    value: Schema.String,
  }),
  E('ToggleStaysInForce', { sectionId: Schema.String }),
  E('AddCoverLine', {}),
  E('RemoveCoverLine', { index: Int }),
  E('SetCoverEmphasis', {
    index: Int,
    value: Schema.Literals(['title', 'subtitle', 'normal']),
  }),
  E('AddCoverPart', {
    lineIndex: Int,
    kind: Schema.Literals(['text', 'item', 'case_value']),
  }),
  E('RemoveCoverPart', { lineIndex: Int, partIndex: Int }),
  E('SetCoverPart', {
    lineIndex: Int,
    partIndex: Int,
    field: Schema.Literals(['text', 'itemId', 'field']),
    value: Schema.String,
  }),
])
export type FormEdit = typeof FormEdit.Type

// ---- IDs ------------------------------------------------------------------

const usedIds = (form: TemplateForm): ReadonlySet<string> =>
  new Set([
    ...form.sections.map(row => row.id),
    ...form.items.map(row => row.id),
    ...form.options.map(row => row.id),
    ...form.roles.map(row => row.id),
  ])

// NOTE: `prefix-N` for the first N from `from` that no row of the form uses.
export const freshId = (
  form: TemplateForm,
  prefix: string,
  from: number,
): string => {
  const used = usedIds(form)
  let n = Math.max(1, from)
  while (used.has(`${prefix}-${n}`)) n += 1
  return `${prefix}-${n}`
}

// ---- Helpers --------------------------------------------------------------

const replaceWhere = <A>(
  rows: ReadonlyArray<A>,
  test: (row: A) => boolean,
  change: (row: A) => A,
): ReadonlyArray<A> => rows.map(row => (test(row) ? change(row) : row))

// NOTE: moves the row at `index` by `by` places among the rows of `group`
// (indexes into `rows`, in order), swapping array positions.
const moveWithin = <A>(
  rows: ReadonlyArray<A>,
  group: ReadonlyArray<number>,
  index: number,
  by: number,
): ReadonlyArray<A> => {
  const at = group.indexOf(index)
  const to = at + by
  const other = group[to]
  if (at < 0 || other === undefined) return rows
  const next = [...rows]
  const a = next[index]
  const b = next[other]
  if (a === undefined || b === undefined) return rows
  next[index] = b
  next[other] = a
  return next
}

const indexesWhere = <A>(
  rows: ReadonlyArray<A>,
  test: (row: A) => boolean,
): ReadonlyArray<number> =>
  rows.flatMap((row, index) => (test(row) ? [index] : []))

const sectionDescendants = (
  form: TemplateForm,
  id: string,
): ReadonlySet<string> => {
  const found = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const row of form.sections) {
      if (row.parentId !== null && found.has(row.parentId) && !found.has(row.id)) {
        found.add(row.id)
        grew = true
      }
    }
  }
  return found
}

const itemDescendants = (
  form: TemplateForm,
  roots: ReadonlySet<string>,
): ReadonlySet<string> => {
  const found = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const row of form.items) {
      if (!found.has(row.id) && (roots.has(row.parentId) || found.has(row.parentId))) {
        found.add(row.id)
        grew = true
      }
    }
  }
  return found
}

// NOTE: removes items by ID with their options, and everything that pointed
// at them (cover lines that showed one).
const withoutItems = (
  form: TemplateForm,
  gone: ReadonlySet<string>,
): TemplateForm => ({
  ...form,
  items: form.items.filter(row => !gone.has(row.id)),
  options: form.options.filter(row => !gone.has(row.itemId)),
  coverParts: form.coverParts.filter(
    part => !(part.kind === 'item' && gone.has(part.itemId)),
  ),
})

const withoutSections = (
  form: TemplateForm,
  gone: ReadonlySet<string>,
): TemplateForm => {
  const items = itemDescendants(form, gone)
  const cleaned = withoutItems(form, items)
  return {
    ...cleaned,
    sections: cleaned.sections.filter(row => !gone.has(row.id)),
    endingStaysInForce: cleaned.endingStaysInForce.filter(id => !gone.has(id)),
  }
}

const requiredIn = (role: FormRole): boolean => role.kind === 'drafting'

const withApprovalFor = (role: FormRole): FormRole => {
  if (role.kind === 'drafting') {
    return { ...role, approvalKind: '', approvalCount: null }
  }
  const votes = role.permissions.includes('vote')
  if (!votes) return { ...role, approvalKind: '', approvalCount: null }
  return role.approvalKind === ''
    ? { ...role, approvalKind: 'all', approvalCount: null }
    : role
}

const defaultItem = (
  id: string,
  parentId: string,
  type: FormItem['type'],
): FormItem => ({
  id,
  parentId,
  type,
  label: 'New item',
  instruction: '',
  requirement: 'required',
  precision: type === 'date' ? 'day' : '',
  multiple: false,
  endOptionId: '',
  field: type === 'case_value' ? 'reference' : '',
  entryLabel: type === 'repeated' ? 'Entry' : '',
  repeatMin: type === 'repeated' ? 1 : 0,
  repeatMax: null,
})

const defaultSection = (
  id: string,
  parentId: string | null,
  isConclusion: boolean,
): FormSection => ({
  id,
  parentId,
  isConclusion,
  title: isConclusion ? 'Conclusion' : 'New section',
  instruction: '',
  requirement: 'required',
  frontMatter: false,
  numbered: true,
  repeatable: false,
  repeatMin: 0,
  repeatMax: null,
})

const setRole = (
  form: TemplateForm,
  id: string,
  change: (role: FormRole) => FormRole,
): TemplateForm => ({
  ...form,
  roles: replaceWhere(form.roles, row => row.id === id, change),
})

const setItem = (
  form: TemplateForm,
  id: string,
  change: (row: FormItem) => FormItem,
): TemplateForm => ({
  ...form,
  items: replaceWhere(form.items, row => row.id === id, change),
})

const setSection = (
  form: TemplateForm,
  id: string,
  change: (row: FormSection) => FormSection,
): TemplateForm => ({
  ...form,
  sections: replaceWhere(form.sections, row => row.id === id, change),
})

const rename = (
  form: TemplateForm,
  scope: IdScope,
  id: string,
  newId: string,
): TemplateForm => {
  const to = newId.trim()
  if (to === '' || to === id) return form
  const swap = (value: string): string => (value === id ? to : value)
  switch (scope) {
    case 'role':
      return setRole(form, id, role => ({ ...role, id: to }))
    case 'section':
      return {
        ...form,
        sections: form.sections.map(row => ({
          ...row,
          id: swap(row.id),
          parentId: row.parentId === null ? null : swap(row.parentId),
        })),
        items: form.items.map(row => ({ ...row, parentId: swap(row.parentId) })),
        endingStaysInForce: form.endingStaysInForce.map(swap),
      }
    case 'item':
      return {
        ...form,
        items: form.items.map(row => ({
          ...row,
          id: swap(row.id),
          parentId: swap(row.parentId),
        })),
        options: form.options.map(row => ({ ...row, itemId: swap(row.itemId) })),
        coverParts: form.coverParts.map(part => ({
          ...part,
          itemId: part.kind === 'item' ? swap(part.itemId) : part.itemId,
        })),
      }
    case 'option':
      return {
        ...form,
        options: form.options.map(row => ({ ...row, id: swap(row.id) })),
        items: form.items.map(row => ({
          ...row,
          endOptionId: swap(row.endOptionId),
        })),
      }
  }
}

const moveSection = (
  form: TemplateForm,
  id: string,
  direction: 'up' | 'down' | 'out' | 'in',
): TemplateForm => {
  const index = form.sections.findIndex(row => row.id === id)
  const row = form.sections[index]
  if (row === undefined) return form
  const siblings = (of: FormSection) =>
    indexesWhere(
      form.sections,
      other =>
        other.parentId === of.parentId &&
        (of.parentId !== null || other.isConclusion === of.isConclusion),
    )
  if (direction === 'up' || direction === 'down') {
    if (row.isConclusion) return form
    return {
      ...form,
      sections: moveWithin(
        form.sections,
        indexesWhere(
          form.sections,
          other => other.parentId === row.parentId && !other.isConclusion,
        ),
        index,
        direction === 'up' ? -1 : 1,
      ),
    }
  }
  if (direction === 'out') {
    if (row.parentId === null) return form
    const parent = form.sections.find(other => other.id === row.parentId)
    if (parent === undefined) return form
    const without = form.sections.filter(other => other.id !== id)
    const at = without.findIndex(other => other.id === parent.id)
    const moved: FormSection = {
      ...row,
      parentId: parent.parentId,
      isConclusion: false,
    }
    return {
      ...form,
      sections: [...without.slice(0, at + 1), moved, ...without.slice(at + 1)],
    }
  }
  // NOTE: in: the last child of the section before it, which cannot be the
  // conclusion.
  if (row.isConclusion) return form
  const group = siblings(row).filter(
    at => !(form.sections[at]?.isConclusion ?? false),
  )
  const before = group[group.indexOf(index) - 1]
  const target = before === undefined ? undefined : form.sections[before]
  if (target === undefined) return form
  const without = form.sections.filter(other => other.id !== id)
  return {
    ...form,
    sections: [...without, { ...row, parentId: target.id }],
  }
}

const coverPartIndex = (
  form: TemplateForm,
  lineIndex: number,
  partIndex: number,
): number =>
  indexesWhere(form.coverParts, part => part.lineIndex === lineIndex)[partIndex] ??
  -1

const permissionsAllowed = (kind: FormRole['kind']) =>
  kind === 'drafting' ? DRAFTING_PERMISSIONS : REVIEWING_PERMISSIONS

// NOTE: One edit. Pure.
export const applyEdit = (form: TemplateForm, edit: FormEdit): TemplateForm => {
  switch (edit._tag) {
    case 'SetText':
      return { ...form, [edit.field]: edit.value }
    case 'SetPageNumbering':
      return { ...form, pageNumbering: edit.value }
    case 'SetContentsDepth':
      return { ...form, contentsDepth: edit.value }
    case 'Rename':
      return rename(form, edit.scope, edit.id, edit.newId)
    case 'SetNumberingLevel':
      return {
        ...form,
        numbering: form.numbering.map((level, index) =>
          index === edit.level
            ? {
                style: edit.style,
                letterCase: edit.style === 'arabic' ? '' : edit.letterCase,
                suffix: edit.suffix,
              }
            : level,
        ),
      }
    case 'AddNumberingLevel':
      return {
        ...form,
        numbering: [
          ...form.numbering,
          form.numbering.at(-1) ?? { style: 'arabic', letterCase: '', suffix: '.' },
        ],
      }
    case 'RemoveNumberingLevel':
      return form.numbering.length === 0
        ? form
        : { ...form, numbering: form.numbering.slice(0, -1) }
    case 'AddRole':
      return form.roles.some(role => role.id === edit.id)
        ? form
        : {
            ...form,
            roles: [
              ...form.roles,
              edit.kind === 'drafting'
                ? {
                    id: edit.id,
                    name: 'New role',
                    kind: 'drafting',
                    view: 'full',
                    permissions: [...DRAFTING_REQUIRED_PERMISSIONS],
                    approvalKind: '',
                    approvalCount: null,
                  }
                : {
                    id: edit.id,
                    name: 'New role',
                    kind: 'reviewing',
                    view: 'redacted',
                    permissions: ['comment', 'vote'],
                    approvalKind: 'all',
                    approvalCount: null,
                  },
            ],
          }
    case 'RemoveRole':
      return { ...form, roles: form.roles.filter(role => role.id !== edit.id) }
    case 'MoveRole': {
      const index = form.roles.findIndex(role => role.id === edit.id)
      return {
        ...form,
        roles: moveWithin(
          form.roles,
          form.roles.map((_, at) => at),
          index,
          edit.by,
        ),
      }
    }
    case 'SetRoleName':
      return setRole(form, edit.id, role => ({ ...role, name: edit.value }))
    case 'SetRoleKind':
      return setRole(form, edit.id, role => {
        if (role.kind === edit.value) return role
        const allowed = permissionsAllowed(edit.value)
        const kept = role.permissions.filter(p => allowed.includes(p))
        const permissions =
          edit.value === 'drafting'
            ? [...new Set([...DRAFTING_REQUIRED_PERMISSIONS, ...kept])]
            : kept.length === 0
              ? [...REVIEWING_PERMISSIONS]
              : kept
        return withApprovalFor({
          ...role,
          kind: edit.value,
          view: edit.value === 'drafting' ? 'full' : role.view,
          permissions,
          approvalKind: '',
          approvalCount: null,
        })
      })
    case 'SetRoleView':
      return setRole(form, edit.id, role =>
        role.kind === 'drafting' ? role : { ...role, view: edit.value },
      )
    case 'TogglePermission':
      return setRole(form, edit.id, role => {
        if (!permissionsAllowed(role.kind).includes(edit.permission)) return role
        if (
          requiredIn(role) &&
          DRAFTING_REQUIRED_PERMISSIONS.includes(edit.permission)
        ) {
          return role
        }
        const has = role.permissions.includes(edit.permission)
        const permissions = has
          ? role.permissions.filter(p => p !== edit.permission)
          : [...role.permissions, edit.permission]
        return withApprovalFor({ ...role, permissions })
      })
    case 'SetApproval':
      return setRole(form, edit.id, role =>
        role.kind === 'drafting' || !role.permissions.includes('vote')
          ? role
          : {
              ...role,
              approvalKind: edit.kind,
              approvalCount: edit.kind === 'at_least' ? edit.count : null,
            },
      )
    case 'AddSection':
      return usedIds(form).has(edit.id) ||
        (edit.isConclusion && form.sections.some(row => row.isConclusion))
        ? form
        : {
            ...form,
            sections: [
              ...form.sections,
              defaultSection(
                edit.id,
                edit.isConclusion ? null : edit.parentId,
                edit.isConclusion,
              ),
            ],
          }
    case 'RemoveSection':
      return withoutSections(form, sectionDescendants(form, edit.id))
    case 'MoveSection':
      return moveSection(form, edit.id, edit.direction)
    case 'SetSectionText':
      return setSection(form, edit.id, row => ({
        ...row,
        [edit.field]: edit.value,
      }))
    case 'SetSectionRequirement':
      return setSection(form, edit.id, row => ({ ...row, requirement: edit.value }))
    case 'SetSectionFlag':
      return setSection(form, edit.id, row =>
        edit.flag === 'repeatable'
          ? {
              ...row,
              repeatable: edit.value,
              repeatMin: edit.value ? Math.max(row.repeatMin, 1) : 0,
              repeatMax: null,
            }
          : { ...row, [edit.flag]: edit.value },
      )
    case 'SetSectionRepeat':
      return setSection(form, edit.id, row => ({
        ...row,
        repeatMin: edit.min,
        repeatMax: edit.max,
      }))
    case 'AddItem':
      return form.items.some(row => row.id === edit.id) ||
        usedIds(form).has(edit.id)
        ? form
        : {
            ...form,
            items: [...form.items, defaultItem(edit.id, edit.parentId, edit.type)],
          }
    case 'RemoveItem':
      return withoutItems(
        form,
        new Set([edit.id, ...itemDescendants(form, new Set([edit.id]))]),
      )
    case 'MoveItem': {
      const index = form.items.findIndex(row => row.id === edit.id)
      const row = form.items[index]
      if (row === undefined) return form
      return {
        ...form,
        items: moveWithin(
          form.items,
          indexesWhere(form.items, other => other.parentId === row.parentId),
          index,
          edit.by,
        ),
      }
    }
    case 'SetItemType': {
      const row = form.items.find(other => other.id === edit.id)
      if (row === undefined || row.type === edit.type) return form
      const gone = itemDescendants(form, new Set([edit.id]))
      const cleaned = withoutItems(form, gone)
      return {
        ...cleaned,
        options: cleaned.options.filter(option => option.itemId !== edit.id),
        items: cleaned.items.map(other =>
          other.id === edit.id
            ? {
                ...defaultItem(edit.id, other.parentId, edit.type),
                label: other.label,
                instruction: other.instruction,
                requirement: other.requirement,
              }
            : other,
        ),
      }
    }
    case 'SetItemText':
      return setItem(form, edit.id, row => ({ ...row, [edit.field]: edit.value }))
    case 'SetItemRequirement':
      return setItem(form, edit.id, row => ({ ...row, requirement: edit.value }))
    case 'SetItemPrecision':
      return setItem(form, edit.id, row => ({ ...row, precision: edit.value }))
    case 'SetItemMultiple':
      return setItem(form, edit.id, row => ({ ...row, multiple: edit.value }))
    case 'SetItemField':
      return setItem(form, edit.id, row => ({ ...row, field: edit.value }))
    case 'SetItemRepeat':
      return setItem(form, edit.id, row => ({
        ...row,
        repeatMin: edit.min,
        repeatMax: edit.max,
      }))
    case 'SetEndOption':
      return setItem(form, edit.id, row => ({ ...row, endOptionId: edit.optionId }))
    case 'AddOption':
      return form.options.some(row => row.id === edit.id) ||
        usedIds(form).has(edit.id)
        ? form
        : {
            ...form,
            options: [
              ...form.options,
              { id: edit.id, itemId: edit.itemId, label: 'New option', code: '' },
            ],
          }
    case 'RemoveOption':
      return {
        ...form,
        options: form.options.filter(row => row.id !== edit.id),
        items: form.items.map(row =>
          row.endOptionId === edit.id ? { ...row, endOptionId: '' } : row,
        ),
      }
    case 'MoveOption': {
      const index = form.options.findIndex(row => row.id === edit.id)
      const row = form.options[index]
      if (row === undefined) return form
      return {
        ...form,
        options: moveWithin(
          form.options,
          indexesWhere(form.options, other => other.itemId === row.itemId),
          index,
          edit.by,
        ),
      }
    }
    case 'SetOptionText':
      return {
        ...form,
        options: replaceWhere(form.options, row => row.id === edit.id, row => ({
          ...row,
          [edit.field]: edit.value,
        })),
      }
    case 'ToggleStaysInForce':
      return {
        ...form,
        endingStaysInForce: form.endingStaysInForce.includes(edit.sectionId)
          ? form.endingStaysInForce.filter(id => id !== edit.sectionId)
          : [...form.endingStaysInForce, edit.sectionId],
      }
    case 'AddCoverLine':
      return {
        ...form,
        coverLines: [...form.coverLines, { emphasis: 'normal' }],
        coverParts: [
          ...form.coverParts,
          {
            lineIndex: form.coverLines.length,
            kind: 'text',
            text: 'Text',
            itemId: '',
            field: '',
          },
        ],
      }
    case 'RemoveCoverLine':
      return edit.index < 0 || edit.index >= form.coverLines.length
        ? form
        : {
            ...form,
            coverLines: form.coverLines.filter((_, at) => at !== edit.index),
            coverParts: form.coverParts
              .filter(part => part.lineIndex !== edit.index)
              .map(part =>
                part.lineIndex > edit.index
                  ? { ...part, lineIndex: part.lineIndex - 1 }
                  : part,
              ),
          }
    case 'SetCoverEmphasis':
      return {
        ...form,
        coverLines: form.coverLines.map((line, at) =>
          at === edit.index ? { emphasis: edit.value } : line,
        ),
      }
    case 'AddCoverPart': {
      if (edit.lineIndex < 0 || edit.lineIndex >= form.coverLines.length) {
        return form
      }
      const first = form.items.find(row => row.type !== 'repeated')
      return {
        ...form,
        coverParts: [
          ...form.coverParts,
          {
            lineIndex: edit.lineIndex,
            kind: edit.kind,
            text: edit.kind === 'text' ? 'Text' : '',
            itemId: edit.kind === 'item' ? (first?.id ?? '') : '',
            field: edit.kind === 'case_value' ? 'reference' : '',
          },
        ],
      }
    }
    case 'RemoveCoverPart': {
      const at = coverPartIndex(form, edit.lineIndex, edit.partIndex)
      return at < 0
        ? form
        : { ...form, coverParts: form.coverParts.filter((_, i) => i !== at) }
    }
    case 'SetCoverPart': {
      const at = coverPartIndex(form, edit.lineIndex, edit.partIndex)
      return at < 0
        ? form
        : {
            ...form,
            coverParts: form.coverParts.map((part, i) => {
              if (i !== at) return part
              if (edit.field === 'text') return { ...part, text: edit.value }
              if (edit.field === 'itemId') return { ...part, itemId: edit.value }
              return {
                ...part,
                field:
                  edit.value === 'reference' ||
                  edit.value === 'unit' ||
                  edit.value === 'title'
                    ? edit.value
                    : part.field,
              }
            }),
          }
    }
  }
}

// ---- Problems and where they belong ------------------------------------------

export type ProblemTarget = Readonly<{
  scope:
    | 'template'
    | 'section'
    | 'item'
    | 'option'
    | 'role'
    | 'numbering'
    | 'cover'
    | 'ending'
    | 'furniture'
  // NOTE: the row ID, or the index (numbering level, cover line) as text.
  id: string
  // NOTE: the part of the row the problem is about, as the schema names it.
  field: string
}>

export type FormProblem = Readonly<{
  problem: TemplateProblem
  target: ProblemTarget
}>

const ARRAYS = new Set(['sections', 'items', 'options', 'roles', 'numbering', 'lines'])

const recordAt = (node: unknown, key: string | number): unknown =>
  typeof node === 'object' && node !== null
    ? (node as Record<string | number, unknown>)[key]
    : undefined

const idOfNode = (node: unknown): string => {
  const id = recordAt(node, 'id')
  return typeof id === 'string' ? id : ''
}

// NOTE: Which row a problem is about. `raw` is what the form built (the
// problem paths index into it); a path of the form itself names a row by ID.
export const targetOfProblem = (
  raw: unknown,
  path: ReadonlyArray<string | number>,
): ProblemTarget => {
  let node: unknown = raw
  let target: ProblemTarget = { scope: 'template', id: '', field: '' }
  let previous: string | number | undefined
  const setField = (key: string) => {
    if (target.field === '') target = { ...target, field: key }
  }
  for (const key of path) {
    if (typeof key === 'number') {
      node = recordAt(node, key)
      if (previous === 'sections') {
        target = { scope: 'section', id: idOfNode(node), field: '' }
      } else if (previous === 'items') {
        target = { scope: 'item', id: idOfNode(node), field: '' }
      } else if (previous === 'options') {
        target = { scope: 'option', id: idOfNode(node), field: '' }
      } else if (previous === 'roles') {
        target = { scope: 'role', id: idOfNode(node), field: '' }
      } else if (previous === 'numbering') {
        target = { scope: 'numbering', id: String(key), field: '' }
      } else if (previous === 'lines') {
        target = { scope: 'cover', id: String(key), field: '' }
      }
    } else if (ARRAYS.has(key) && typeof path[path.indexOf(key) + 1] === 'string') {
      // NOTE: the form's own problems: `['sections', id]`.
      const id = path[path.indexOf(key) + 1] as string
      const scope =
        key === 'sections'
          ? 'section'
          : key === 'items'
            ? 'item'
            : key === 'options'
              ? 'option'
              : 'template'
      return scope === 'template'
        ? { scope, id: '', field: key }
        : { scope, id, field: '' }
    } else {
      node = recordAt(node, key)
      if (key === 'conclusion') {
        target = { scope: 'section', id: idOfNode(node), field: '' }
      } else if (key === 'ending' || key === 'endingStaysInForce') {
        target = { scope: 'ending', id: '', field: key === 'ending' ? '' : key }
      } else if (key === 'cover') {
        target = { scope: 'cover', id: '', field: '' }
      } else if (key === 'furniture') {
        target = { scope: 'furniture', id: '', field: '' }
      } else if (!ARRAYS.has(key)) {
        setField(key)
      } else if (target.scope === 'template') {
        target = { scope: 'template', id: '', field: key }
      }
    }
    previous = key
  }
  return target
}

// NOTE: Every problem of a form, each with its row: the problems of the form
// itself and of the template it would be.
export const formProblems = (form: TemplateForm): ReadonlyArray<FormProblem> => {
  const trimmed = trimmedForm(form)
  const { raw, problems } = draftFromForm(trimmed)
  const checked = validateTemplate(raw)
  const all = [
    ...problems,
    ...(Result.isFailure(checked) ? checked.failure : []),
  ]
  return all.map(problem => ({
    problem,
    target: targetOfProblem(raw, problem.path),
  }))
}

// NOTE: The template the editor would save or publish, from the trimmed form.
export const templateOfForm = (
  form: TemplateForm,
): Result.Result<Template, ReadonlyArray<TemplateProblem>> =>
  templateFromForm(trimmedForm(form))

// NOTE: The template a draft can be saved as: one that fits the schema, with
// or without problems that only stop it being published (a draft only has to
// fit the schema). Fails with the problems of the shape.
export const savableTemplate = (
  form: TemplateForm,
): Result.Result<Template, ReadonlyArray<TemplateProblem>> => {
  const { raw } = draftFromForm(trimmedForm(form))
  const decoded = Schema.decodeUnknownResult(TemplateSchema)(raw)
  if (Result.isSuccess(decoded)) return Result.succeed(decoded.success)
  const checked = validateTemplate(raw)
  return Result.fail(Result.isFailure(checked) ? checked.failure : [])
}
