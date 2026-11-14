import { blankTemplate } from '../blank-template'
import { type FormEdit } from '../template-form-edit'
import { type TemplateForm, templateToForm } from '../template-form'

// NOTE: Test support for the template editor: the edits a person
// would make to build the invented panel template (`PANEL_TEMPLATE`) from a
// blank draft, one by one. Every ID is given, so the result is the same each
// time and the template that comes out equals the one in `templates.ts`.

export const PANEL_START: TemplateForm = templateToForm(
  blankTemplate('test-panel', 'Panel review note'),
)

const text = (
  field: Extract<FormEdit, { _tag: 'SetText' }>['field'],
  value: string,
): FormEdit => ({ _tag: 'SetText', field, value })

const item = (
  parentId: string,
  id: string,
  type: Extract<FormEdit, { _tag: 'AddItem' }>['type'],
  label: string,
): ReadonlyArray<FormEdit> => [
  { _tag: 'AddItem', id, parentId, type },
  { _tag: 'SetItemText', id, field: 'label', value: label },
]

export const PANEL_EDITS: ReadonlyArray<FormEdit> = [
  text('shortName', 'panel'),
  text(
    'description',
    'An invented template for tests, with three reviewing roles.',
  ),
  text('caseReferenceLabel', 'Panel reference'),
  { _tag: 'SetNumberingLevel', level: 0, style: 'roman', letterCase: 'lower', suffix: ')' },
  { _tag: 'AddNumberingLevel' },
  { _tag: 'SetNumberingLevel', level: 1, style: 'letters', letterCase: 'lower', suffix: '.' },
  // Roles.
  { _tag: 'Rename', scope: 'role', id: 'authors', newId: 'drafters' },
  { _tag: 'SetRoleName', id: 'drafters', value: 'Drafters' },
  { _tag: 'TogglePermission', id: 'drafters', permission: 'comment_drafts' },
  { _tag: 'TogglePermission', id: 'drafters', permission: 'write_conclusion' },
  { _tag: 'Rename', scope: 'role', id: 'reviewers', newId: 'chair' },
  { _tag: 'SetRoleName', id: 'chair', value: 'Chair' },
  { _tag: 'SetRoleView', id: 'chair', value: 'full' },
  { _tag: 'SetApproval', id: 'chair', kind: 'majority', count: null },
  { _tag: 'AddRole', id: 'members', kind: 'reviewing' },
  { _tag: 'SetRoleName', id: 'members', value: 'Panel members' },
  { _tag: 'SetApproval', id: 'members', kind: 'at_least', count: 2 },
  { _tag: 'AddRole', id: 'observer', kind: 'reviewing' },
  { _tag: 'SetRoleName', id: 'observer', value: 'Observer' },
  { _tag: 'TogglePermission', id: 'observer', permission: 'vote' },
  // Overview: the blank draft's first section, renamed.
  { _tag: 'Rename', scope: 'section', id: 'summary', newId: 'overview' },
  { _tag: 'SetSectionText', id: 'overview', field: 'title', value: 'Overview' },
  { _tag: 'Rename', scope: 'item', id: 'summary-text', newId: 'overview-text' },
  { _tag: 'SetItemText', id: 'overview-text', field: 'label', value: 'Overview' },
  ...item('overview', 'panel-topic', 'text', 'Topic'),
  // Items reviewed, with repeated findings and a remarks subsection.
  { _tag: 'AddSection', id: 'items-reviewed', parentId: null, isConclusion: false },
  { _tag: 'SetSectionText', id: 'items-reviewed', field: 'title', value: 'Items reviewed' },
  ...item('items-reviewed', 'finding-list', 'repeated', 'Findings'),
  { _tag: 'SetItemText', id: 'finding-list', field: 'entryLabel', value: 'Finding' },
  ...item('finding-list', 'finding-title', 'text', 'Title'),
  ...item('finding-list', 'finding-body', 'rich_text', 'Details'),
  { _tag: 'SetItemRequirement', id: 'finding-body', value: 'optional' },
  { _tag: 'AddSection', id: 'remarks', parentId: 'items-reviewed', isConclusion: false },
  { _tag: 'SetSectionText', id: 'remarks', field: 'title', value: 'Remarks' },
  { _tag: 'SetSectionRequirement', id: 'remarks', value: 'optional' },
  ...item('remarks', 'remarks-text', 'rich_text', 'Remarks'),
  // Outcome: unnumbered, a choice and a month.
  { _tag: 'AddSection', id: 'outcome', parentId: null, isConclusion: false },
  { _tag: 'SetSectionText', id: 'outcome', field: 'title', value: 'Outcome' },
  { _tag: 'SetSectionFlag', id: 'outcome', flag: 'numbered', value: false },
  ...item('outcome', 'outcome-choice', 'select', 'Outcome'),
  { _tag: 'AddOption', id: 'accept', itemId: 'outcome-choice' },
  { _tag: 'SetOptionText', id: 'accept', field: 'label', value: 'Accept' },
  { _tag: 'AddOption', id: 'rework', itemId: 'outcome-choice' },
  { _tag: 'SetOptionText', id: 'rework', field: 'label', value: 'Rework' },
  { _tag: 'AddOption', id: 'decline', itemId: 'outcome-choice' },
  { _tag: 'SetOptionText', id: 'decline', field: 'label', value: 'Decline' },
  ...item('outcome', 'outcome-date', 'date', 'Date'),
  { _tag: 'SetItemPrecision', id: 'outcome-date', value: 'month' },
  // The pages.
  { _tag: 'SetContentsDepth', value: 2 },
  text('header', '{title}'),
  text('footer', '{case} - {page} of {pages}'),
]
